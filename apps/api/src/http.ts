import { NodeServices } from "@effect/platform-node";
import {
  IMAGE_MAX_BYTES,
  createEntryRequestSchema,
  createSubmissionFieldsSchema,
  fieldErrorsFromZod,
  imageMimeTypeSchema,
  submissionStatusSchema,
  submissionStatuses,
  verifyJobSchema,
  verifyResultSchema,
  workerJobSchema,
  workerResultSchema,
  type ApiErrorBody,
  type ImageMimeType,
  type ReviewAction,
} from "@intake/contracts";
import { ByteSize, Effect, FileSystem, Layer } from "effect";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  Multipart,
} from "effect/http";
import { ADMIN_COOKIE, AdminAuth, AdminAuthLive } from "./auth.js";
import { approveSubmission } from "./approve.js";
import type { AppConfig } from "./config.js";
import { DatabaseLive } from "./db.js";
import { StorageError, TransitionError } from "./errors.js";
import { AppConfigService } from "./services.js";
import { EntryRequests, EntryRequestsLive, type StoredScreenshot } from "./entryRequests.js";
import { Submissions, SubmissionsLive, type StoredImage } from "./submissions.js";
import { bearerToken, tokenMatches } from "./workerAuth.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown, headers?: Record<string, string>) {
  // Leave Content-Length unset. Effect would store it as a string, and Node's
  // strictContentLength check compares that string to the numeric byte count
  // with !==, so matching lengths still throw on some Node 22 releases.
  return HttpServerResponse.raw(JSON.stringify(body), {
    status,
    contentType: "application/json",
    headers,
  });
}

function errorBody(
  error: ApiErrorBody["error"],
  message: string,
  fields?: Record<string, string>,
): ApiErrorBody {
  return fields === undefined ? { error, message } : { error, message, fields };
}

function validation(fields: Record<string, string>, message = "Check the highlighted fields.") {
  return json(400, errorBody("validation_error", message, fields));
}

function notFound(message = "No submission exists with that id.") {
  return json(404, errorBody("not_found", message));
}

function internalError() {
  return json(500, errorBody("internal_error", "Something went wrong while saving the submission."));
}

function unauthorized() {
  return json(401, errorBody("unauthorized", "Sign in to review submissions."));
}

function workerUnauthorized() {
  return json(401, errorBody("unauthorized", "Provide the worker token."));
}

function workerUnavailable() {
  return json(503, errorBody("unavailable", "The worker API is not configured."));
}

function conflict() {
  return json(409, errorBody("conflict", "That status change is not allowed."));
}

const ensureAdmin = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* AdminAuth;
  return auth.isAuthenticated(request.cookies[ADMIN_COOKIE]);
});

type WorkerAccess = { readonly ok: true } | { readonly ok: false; readonly response: ReturnType<typeof workerUnauthorized> };

const authorizeWorker = Effect.gen(function* () {
  const config = yield* AppConfigService;
  if (config.workerToken === undefined) {
    const unavailable: WorkerAccess = { ok: false, response: workerUnavailable() };
    return unavailable;
  }
  const request = yield* HttpServerRequest.HttpServerRequest;
  const provided = bearerToken(request.headers.authorization);
  if (provided === undefined || !tokenMatches(provided, config.workerToken)) {
    const denied: WorkerAccess = { ok: false, response: workerUnauthorized() };
    return denied;
  }
  const allowed: WorkerAccess = { ok: true };
  return allowed;
});

function textField(form: Multipart.Persisted, key: string): string {
  const value = form[key];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string") {
      return first;
    }
  }
  return "";
}

type UploadSelection =
  | { readonly kind: "missing" }
  | { readonly kind: "multiple" }
  | { readonly kind: "file"; readonly file: Multipart.PersistedFile };

function selectUpload(form: Multipart.Persisted): UploadSelection {
  const value = form.image;
  if (value === undefined || typeof value === "string" || !Array.isArray(value) || value.length === 0) {
    return { kind: "missing" };
  }
  if (value.length !== 1) {
    return { kind: "multiple" };
  }
  const first = value[0];
  if (first === undefined || !Multipart.isPersistedFile(first)) {
    return { kind: "missing" };
  }
  return { kind: "file", file: first };
}

function sniffMime(bytes: Uint8Array): ImageMimeType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function safeOriginalName(name: string): string {
  const base = name.split(/[/\\]/u).pop() ?? "";
  const cleaned = base.replace(/[^\w.\- ()]+/gu, "").trim().slice(0, 200);
  return cleaned.length > 0 ? cleaned : "upload";
}

function requestUrl(request: HttpServerRequest.HttpServerRequest): URL {
  if (request.url.startsWith("http://") || request.url.startsWith("https://")) {
    return new URL(request.url);
  }
  return new URL(request.url, "http://localhost");
}

function workerImageUrl(id: string): string {
  return `/api/worker/jobs/${id}/image`;
}

function workerRequestImageUrl(id: string): string {
  return `/api/worker/entry-requests/${id}/image`;
}

function selectNamedFile(form: Multipart.Persisted, key: string): UploadSelection {
  const value = form[key];
  if (value === undefined || typeof value === "string" || !Array.isArray(value) || value.length === 0) {
    return { kind: "missing" };
  }
  if (value.length !== 1) {
    return { kind: "multiple" };
  }
  const first = value[0];
  if (first === undefined || !Multipart.isPersistedFile(first)) {
    return { kind: "missing" };
  }
  return { kind: "file", file: first };
}

function routeId(params: Readonly<Record<string, string | undefined>>): string | undefined {
  const id = params.id;
  if (id === undefined || !UUID_PATTERN.test(id)) {
    return undefined;
  }
  return id;
}

const readMultipart = (request: HttpServerRequest.HttpServerRequest) =>
  request.multipart.pipe(
    Effect.provideService(Multipart.MaxFileSize)(ByteSize.bytes(IMAGE_MAX_BYTES)),
    Effect.provideService(Multipart.MaxFieldSize)(ByteSize.bytes(16 * 1024)),
    Effect.provideService(HttpIncomingMessage.MaxBodySize)(ByteSize.bytes(6 * 1024 * 1024)),
  );

type InspectedImage =
  | { readonly ok: true; readonly mimeType: ImageMimeType; readonly sizeBytes: number }
  | { readonly ok: false; readonly message: string };

const rejectedImage = (message: string): InspectedImage => ({ ok: false, message });

const inspectUpload = (file: Multipart.PersistedFile): Effect.Effect<InspectedImage, StorageError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs.readFile(file.path).pipe(Effect.mapError((cause) => new StorageError({ cause })));
    if (bytes.byteLength === 0) {
      return rejectedImage("Choose a JPEG, PNG, or WebP image.");
    }
    if (bytes.byteLength > IMAGE_MAX_BYTES) {
      return rejectedImage("Image must be 5 MB or smaller.");
    }
    const parsed = imageMimeTypeSchema.safeParse(sniffMime(bytes));
    if (!parsed.success) {
      return rejectedImage("Use a JPEG, PNG, or WebP image.");
    }
    const accepted: InspectedImage = { ok: true, mimeType: parsed.data, sizeBytes: bytes.byteLength };
    return accepted;
  });

const recover = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (Multipart.isMultipartError(error)) {
          const reason = error.reason._tag;
          if (reason === "FileTooLarge" || reason === "BodyTooLarge") {
            return validation({ image: "Image must be 5 MB or smaller." });
          }
          if (reason === "FieldTooLarge") {
            return validation({ address: "That value is too long." });
          }
          return validation({}, "Submit the form as multipart data with the required fields.");
        }
        yield* Effect.logError(error);
        return internalError();
      }),
    ),
  );

const healthRoute = HttpRouter.add("GET", "/api/health", json(200, { ok: true }));

const createRoute = HttpRouter.add(
  "POST",
  "/api/submissions",
  recover(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const form = yield* readMultipart(request);
      const parsed = createSubmissionFieldsSchema.safeParse({
        firstName: textField(form, "firstName"),
        lastName: textField(form, "lastName"),
        address: textField(form, "address"),
        externalId: textField(form, "externalId"),
      });
      const fieldErrors: Record<string, string> = parsed.success ? {} : fieldErrorsFromZod(parsed.error);
      const upload = selectUpload(form);
      const inspected = upload.kind === "file" ? yield* inspectUpload(upload.file) : undefined;
      if (upload.kind === "missing") {
        fieldErrors.image = "Choose a JPEG, PNG, or WebP image.";
      } else if (upload.kind === "multiple") {
        fieldErrors.image = "Choose a single image.";
      } else if (inspected !== undefined && !inspected.ok) {
        fieldErrors.image = inspected.message;
      }

      if (!parsed.success || upload.kind !== "file" || inspected === undefined || !inspected.ok) {
        return validation(fieldErrors);
      }

      const submissions = yield* Submissions;
      const created = yield* submissions.create({
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        address: parsed.data.address,
        externalId: parsed.data.externalId,
        image: {
          originalFilename: safeOriginalName(upload.file.name),
          mimeType: inspected.mimeType,
          sizeBytes: inspected.sizeBytes,
          tempPath: upload.file.path,
        },
      });
      return json(201, created);
    }),
  ),
);

const listRoute = HttpRouter.add(
  "GET",
  "/api/submissions",
  recover(
    Effect.gen(function* () {
      if (!(yield* ensureAdmin)) {
        return unauthorized();
      }
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = requestUrl(request);
      const statusRaw = url.searchParams.get("status");
      let status: ReturnType<typeof submissionStatusSchema.parse> | undefined;
      if (statusRaw !== null && statusRaw.length > 0) {
        const parsed = submissionStatusSchema.safeParse(statusRaw);
        if (!parsed.success) {
          return validation({
            status: `Status must be one of: ${submissionStatuses.join(", ")}.`,
          });
        }
        status = parsed.data;
      }
      const query = url.searchParams.get("q") ?? undefined;
      const submissions = yield* Submissions;
      const rows = yield* submissions.list({ status, query });
      return json(200, { submissions: rows });
    }),
  ),
);

const getRoute = HttpRouter.add(
  "GET",
  "/api/submissions/:id",
  recover(
    Effect.gen(function* () {
      if (!(yield* ensureAdmin)) {
        return unauthorized();
      }
      const params = yield* HttpRouter.params;
      const id = routeId(params);
      if (id === undefined) {
        return notFound();
      }
      const submissions = yield* Submissions;
      const submission = yield* submissions.get(id);
      if (submission === undefined) {
        return notFound();
      }
      return json(200, submission);
    }),
  ),
);

const imageRoute = HttpRouter.add(
  "GET",
  "/api/submissions/:id/image",
  recover(
    Effect.gen(function* () {
      if (!(yield* ensureAdmin)) {
        return unauthorized();
      }
      const params = yield* HttpRouter.params;
      const id = routeId(params);
      if (id === undefined) {
        return notFound();
      }
      const submissions = yield* Submissions;
      const image = yield* submissions.readImage(id);
      if (image === undefined) {
        return notFound();
      }
      return imageResponse(image);
    }),
  ),
);

function imageResponse(image: StoredImage) {
  const filename = image.filename.replaceAll('"', "");
  return HttpServerResponse.raw(image.bytes, {
    contentType: image.mimeType,
    headers: {
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${filename}"`,
    },
  });
}

function screenshotResponse(image: StoredScreenshot) {
  return HttpServerResponse.raw(image.bytes, {
    contentType: image.mimeType,
    headers: {
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-disposition": 'inline; filename="screenshot.png"',
    },
  });
}

const applyReview = (id: string, action: ReviewAction) =>
  Effect.gen(function* () {
    const submissions = yield* Submissions;
    const result =
      action === "approve"
        ? yield* approveSubmission(submissions, id).pipe(catchTransition)
        : yield* submissions.transition(id, action).pipe(catchTransition);
    if (result === "conflict") {
      return conflict();
    }
    if (result === undefined) {
      return notFound();
    }
    return json(200, result);
  });

const catchTransition = <A, R>(effect: Effect.Effect<A, StorageError | TransitionError, R>) =>
  effect.pipe(
    Effect.catch((error) => {
      if (error instanceof TransitionError) {
        return Effect.succeed("conflict" as const);
      }
      return Effect.fail(error);
    }),
  );

const verifyRoute = HttpRouter.add(
  "POST",
  "/api/submissions/:id/verify",
  recover(
    Effect.gen(function* () {
      if (!(yield* ensureAdmin)) {
        return unauthorized();
      }
      const id = routeId(yield* HttpRouter.params);
      if (id === undefined) {
        return notFound();
      }
      return yield* applyReview(id, "verify");
    }),
  ),
);

const rejectRoute = HttpRouter.add(
  "POST",
  "/api/submissions/:id/reject",
  recover(
    Effect.gen(function* () {
      if (!(yield* ensureAdmin)) {
        return unauthorized();
      }
      const id = routeId(yield* HttpRouter.params);
      if (id === undefined) {
        return notFound();
      }
      return yield* applyReview(id, "reject");
    }),
  ),
);

const approveRoute = HttpRouter.add(
  "POST",
  "/api/submissions/:id/approve",
  recover(
    Effect.gen(function* () {
      if (!(yield* ensureAdmin)) {
        return unauthorized();
      }
      const id = routeId(yield* HttpRouter.params);
      if (id === undefined) {
        return notFound();
      }
      return yield* applyReview(id, "approve");
    }),
  ),
);

const loginRoute = HttpRouter.add(
  "POST",
  "/api/admin/login",
  recover(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const raw = yield* request.text.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize)(ByteSize.bytes(4 * 1024)),
      );
      let password = "";
      try {
        const parsed = JSON.parse(raw) as { password?: unknown };
        password = typeof parsed.password === "string" ? parsed.password : "";
      } catch {
        return validation({ password: "Enter the admin password." });
      }
      const auth = yield* AdminAuth;
      const result = yield* auth.login(password);
      if (!result.ok && result.reason === "rate_limited") {
        return json(429, errorBody("rate_limited", "Too many attempts. Wait a few minutes and try again."), {
          "retry-after": "900",
        });
      }
      if (!result.ok && result.reason === "unconfigured") {
        return json(503, errorBody("unavailable", "Admin login is not configured."));
      }
      if (!result.ok) {
        return json(401, errorBody("unauthorized", "That password is not correct."));
      }
      return json(200, { authenticated: true }, { "set-cookie": result.setCookie });
    }),
  ),
);

const logoutRoute = HttpRouter.add(
  "POST",
  "/api/admin/logout",
  recover(
    Effect.gen(function* () {
      const auth = yield* AdminAuth;
      return json(200, { authenticated: false }, { "set-cookie": auth.logoutCookie() });
    }),
  ),
);

const submitToRecordsRoute = HttpRouter.add(
  "POST",
  "/api/admin/submissions/:id/submit-to-records",
  recover(
    Effect.gen(function* () {
      if (!(yield* ensureAdmin)) {
        return unauthorized();
      }
      const id = routeId(yield* HttpRouter.params);
      if (id === undefined) {
        return notFound();
      }
      const submissions = yield* Submissions;
      const result = yield* submissions.queueForRecords(id);
      if (result === "conflict") {
        return conflict();
      }
      if (result === undefined) {
        return notFound();
      }
      return json(200, result);
    }),
  ),
);

const claimJobRoute = HttpRouter.add(
  "POST",
  "/api/worker/jobs/claim",
  recover(
    Effect.gen(function* () {
      const access = yield* authorizeWorker;
      if (!access.ok) {
        return access.response;
      }
      const config = yield* AppConfigService;
      const submissions = yield* Submissions;
      const claimed = yield* submissions.claimJob(new Date(), config.processingStaleMs);
      if (claimed === undefined) {
        return HttpServerResponse.empty();
      }
      const job = workerJobSchema.parse({
        ...claimed,
        imageUrl: workerImageUrl(claimed.id),
      });
      return json(200, job);
    }),
  ),
);

const workerImageRoute = HttpRouter.add(
  "GET",
  "/api/worker/jobs/:id/image",
  recover(
    Effect.gen(function* () {
      const access = yield* authorizeWorker;
      if (!access.ok) {
        return access.response;
      }
      const id = routeId(yield* HttpRouter.params);
      if (id === undefined) {
        return notFound();
      }
      const submissions = yield* Submissions;
      const image = yield* submissions.readImage(id);
      if (image === undefined) {
        return notFound();
      }
      return imageResponse(image);
    }),
  ),
);

const workerResultRoute = HttpRouter.add(
  "POST",
  "/api/worker/jobs/:id/result",
  recover(
    Effect.gen(function* () {
      const access = yield* authorizeWorker;
      if (!access.ok) {
        return access.response;
      }
      const id = routeId(yield* HttpRouter.params);
      if (id === undefined) {
        return notFound();
      }
      const request = yield* HttpServerRequest.HttpServerRequest;
      const raw = yield* request.text.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize)(ByteSize.bytes(8 * 1024)),
      );
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return validation({ outcome: "Send outcome as sent, id_not_found, or failed." });
      }
      const parsed = workerResultSchema.safeParse(payload);
      if (!parsed.success) {
        return validation(fieldErrorsFromZod(parsed.error), "Check the job result.");
      }
      const submissions = yield* Submissions;
      const result = yield* submissions.completeJob(
        id,
        parsed.data.outcome,
        parsed.data.message,
        parsed.data.recordsRequestId,
      );
      if (result === "conflict") {
        return conflict();
      }
      if (result === undefined) {
        return notFound();
      }
      return json(200, result);
    }),
  ),
);

const createEntryRequestRoute = HttpRouter.add(
  "POST",
  "/api/worker/entry-requests",
  recover(
    Effect.gen(function* () {
      const access = yield* authorizeWorker;
      if (!access.ok) {
        return access.response;
      }
      const request = yield* HttpServerRequest.HttpServerRequest;
      const raw = yield* request.text.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize)(ByteSize.bytes(16 * 1024)),
      );
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return validation({ sourceSubmissionId: "Send the mapped entry as JSON." });
      }
      const parsed = createEntryRequestSchema.safeParse(payload);
      if (!parsed.success) {
        return validation(fieldErrorsFromZod(parsed.error), "Check the entry request.");
      }
      const entryRequests = yield* EntryRequests;
      const created = yield* entryRequests.create(parsed.data);
      if (created === undefined) {
        return notFound();
      }
      return json(created.createdAt === created.updatedAt ? 201 : 200, created);
    }),
  ),
);

const listEntryRequestsRoute = HttpRouter.add(
  "GET",
  "/api/admin/entry-requests",
  recover(
    Effect.gen(function* () {
      if (!(yield* ensureAdmin)) {
        return unauthorized();
      }
      const entryRequests = yield* EntryRequests;
      const rows = yield* entryRequests.list();
      return json(200, { requests: rows });
    }),
  ),
);

const verifyEntryRequestRoute = HttpRouter.add(
  "POST",
  "/api/admin/entry-requests/:id/verify",
  recover(
    Effect.gen(function* () {
      if (!(yield* ensureAdmin)) {
        return unauthorized();
      }
      const id = routeId(yield* HttpRouter.params);
      if (id === undefined) {
        return notFound("No entry request exists with that id.");
      }
      const entryRequests = yield* EntryRequests;
      const result = yield* entryRequests.requestVerify(id);
      if (result === "conflict") {
        return conflict();
      }
      if (result === undefined) {
        return notFound("No entry request exists with that id.");
      }
      return json(200, result);
    }),
  ),
);

const rejectEntryRequestRoute = HttpRouter.add(
  "POST",
  "/api/admin/entry-requests/:id/reject",
  recover(
    Effect.gen(function* () {
      if (!(yield* ensureAdmin)) {
        return unauthorized();
      }
      const id = routeId(yield* HttpRouter.params);
      if (id === undefined) {
        return notFound("No entry request exists with that id.");
      }
      const entryRequests = yield* EntryRequests;
      const result = yield* entryRequests.reject(id);
      if (result === "conflict") {
        return conflict();
      }
      if (result === undefined) {
        return notFound("No entry request exists with that id.");
      }
      return json(200, result);
    }),
  ),
);

const entryRequestScreenshotRoute = HttpRouter.add(
  "GET",
  "/api/admin/entry-requests/:id/screenshot",
  recover(
    Effect.gen(function* () {
      if (!(yield* ensureAdmin)) {
        return unauthorized();
      }
      const id = routeId(yield* HttpRouter.params);
      if (id === undefined) {
        return notFound("No entry request exists with that id.");
      }
      const entryRequests = yield* EntryRequests;
      const screenshot = yield* entryRequests.readScreenshot(id);
      if (screenshot === undefined) {
        return notFound("No screenshot exists for that entry request.");
      }
      return screenshotResponse(screenshot);
    }),
  ),
);

const claimVerifyRoute = HttpRouter.add(
  "POST",
  "/api/worker/entry-requests/claim",
  recover(
    Effect.gen(function* () {
      const access = yield* authorizeWorker;
      if (!access.ok) {
        return access.response;
      }
      const entryRequests = yield* EntryRequests;
      const claimed = yield* entryRequests.claimVerify(new Date());
      if (claimed === undefined) {
        return HttpServerResponse.empty();
      }
      const job = verifyJobSchema.parse({
        ...claimed,
        imageUrl: workerRequestImageUrl(claimed.id),
      });
      return json(200, job);
    }),
  ),
);

const workerRequestImageRoute = HttpRouter.add(
  "GET",
  "/api/worker/entry-requests/:id/image",
  recover(
    Effect.gen(function* () {
      const access = yield* authorizeWorker;
      if (!access.ok) {
        return access.response;
      }
      const id = routeId(yield* HttpRouter.params);
      if (id === undefined) {
        return notFound("No entry request exists with that id.");
      }
      const entryRequests = yield* EntryRequests;
      const request = yield* entryRequests.get(id);
      if (request === undefined) {
        return notFound("No entry request exists with that id.");
      }
      const submissions = yield* Submissions;
      const image = yield* submissions.readImage(request.submissionId);
      if (image === undefined) {
        return notFound();
      }
      return imageResponse(image);
    }),
  ),
);

const workerVerifyResultRoute = HttpRouter.add(
  "POST",
  "/api/worker/entry-requests/:id/result",
  recover(
    Effect.gen(function* () {
      const access = yield* authorizeWorker;
      if (!access.ok) {
        return access.response;
      }
      const id = routeId(yield* HttpRouter.params);
      if (id === undefined) {
        return notFound("No entry request exists with that id.");
      }
      const request = yield* HttpServerRequest.HttpServerRequest;
      const form = yield* readMultipart(request);
      const parsed = verifyResultSchema.safeParse({
        outcome: textField(form, "outcome"),
        entryId: textField(form, "entryId") || undefined,
        recordsArtistId: textField(form, "recordsArtistId") || undefined,
        message: textField(form, "message") || undefined,
      });
      if (!parsed.success) {
        return validation(fieldErrorsFromZod(parsed.error), "Check the verification result.");
      }
      if (parsed.data.outcome === "done" && parsed.data.entryId === undefined) {
        return validation({ entryId: "Send the entry ID from the records page." });
      }
      if (parsed.data.outcome === "done" && parsed.data.recordsArtistId === undefined) {
        return validation({ recordsArtistId: "Send the artist ID from the records page." });
      }
      const upload = selectNamedFile(form, "screenshot");
      const inspected = upload.kind === "file" ? yield* inspectUpload(upload.file) : undefined;
      if (parsed.data.outcome === "done" && (upload.kind !== "file" || inspected === undefined || !inspected.ok)) {
        return validation({ screenshot: "Attach a PNG, JPEG, or WebP screenshot." });
      }
      if (upload.kind === "multiple") {
        return validation({ screenshot: "Attach a single screenshot." });
      }
      if (upload.kind === "file" && inspected !== undefined && !inspected.ok) {
        return validation({ screenshot: inspected.message });
      }
      let screenshot: { readonly bytes: Uint8Array; readonly mimeType: StoredScreenshot["mimeType"] } | undefined;
      if (upload.kind === "file" && inspected !== undefined && inspected.ok) {
        const fs = yield* FileSystem.FileSystem;
        const bytes = yield* fs
          .readFile(upload.file.path)
          .pipe(Effect.mapError((cause) => new StorageError({ cause })));
        screenshot = { bytes, mimeType: inspected.mimeType };
      }
      const entryRequests = yield* EntryRequests;
      const result = yield* entryRequests.completeVerify(
        id,
        parsed.data.outcome,
        parsed.data.entryId,
        parsed.data.recordsArtistId,
        parsed.data.message,
        screenshot,
      );
      if (result === "conflict") {
        return conflict();
      }
      if (result === undefined) {
        return notFound("No entry request exists with that id.");
      }
      return json(200, result);
    }),
  ),
);

const sessionRoute = HttpRouter.add(
  "GET",
  "/api/admin/session",
  recover(
    Effect.gen(function* () {
      if (!(yield* ensureAdmin)) {
        return unauthorized();
      }
      return json(200, { authenticated: true });
    }),
  ),
);

export const makeRoutes = (config: AppConfig) => {
  const configLayer = Layer.succeed(AppConfigService, config);
  const submissions = SubmissionsLive.pipe(
    Layer.provide(DatabaseLive),
    Layer.provide(configLayer),
    Layer.provide(NodeServices.layer),
  );
  const entryRequests = EntryRequestsLive.pipe(
    Layer.provide(DatabaseLive),
    Layer.provide(configLayer),
    Layer.provide(NodeServices.layer),
  );
  const auth = AdminAuthLive.pipe(Layer.provide(configLayer));

  return Layer.mergeAll(
    healthRoute,
    createRoute,
    listRoute,
    getRoute,
    imageRoute,
    verifyRoute,
    rejectRoute,
    approveRoute,
    loginRoute,
    logoutRoute,
    sessionRoute,
    submitToRecordsRoute,
    claimJobRoute,
    workerImageRoute,
    workerResultRoute,
    createEntryRequestRoute,
    listEntryRequestsRoute,
    verifyEntryRequestRoute,
    rejectEntryRequestRoute,
    entryRequestScreenshotRoute,
    claimVerifyRoute,
    workerRequestImageRoute,
    workerVerifyResultRoute,
    HttpRouter.cors({
      allowedOrigins: [config.webOrigin],
      allowedMethods: ["GET", "POST"],
      allowedHeaders: ["content-type"],
      maxAge: 600,
    }),
  ).pipe(
    HttpRouter.provideRequest(submissions),
    HttpRouter.provideRequest(entryRequests),
    HttpRouter.provideRequest(auth),
    HttpRouter.provideRequest(configLayer),
    HttpRouter.provideRequest(NodeServices.layer),
  );
};
