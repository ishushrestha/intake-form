import { NodeServices } from "@effect/platform-node";
import {
  IMAGE_MAX_BYTES,
  createSubmissionFieldsSchema,
  fieldErrorsFromZod,
  imageMimeTypeSchema,
  submissionStatusSchema,
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
import { Submissions, SubmissionsLive } from "./submissions.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown, headers?: Record<string, string>) {
  return HttpServerResponse.jsonUnsafe(body, { status, headers });
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

function notFound() {
  return json(404, errorBody("not_found", "No submission exists with that id."));
}

function internalError() {
  return json(500, errorBody("internal_error", "Something went wrong while saving the submission."));
}

function unauthorized() {
  return json(401, errorBody("unauthorized", "Sign in to review submissions."));
}

function conflict() {
  return json(409, errorBody("conflict", "That status change is not allowed."));
}

const ensureAdmin = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* AdminAuth;
  return auth.isAuthenticated(request.cookies[ADMIN_COOKIE]);
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
            status: "Status must be pending, verified, approved, or rejected.",
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
      const filename = image.filename.replaceAll('"', "");
      return HttpServerResponse.uint8Array(image.bytes, {
        headers: {
          "content-type": image.mimeType,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
          "content-disposition": `inline; filename="${filename}"`,
        },
      });
    }),
  ),
);

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
    HttpRouter.cors({
      allowedOrigins: [config.webOrigin],
      allowedMethods: ["GET", "POST"],
      allowedHeaders: ["content-type"],
      maxAge: 600,
    }),
  ).pipe(
    HttpRouter.provideRequest(submissions),
    HttpRouter.provideRequest(auth),
    HttpRouter.provideRequest(NodeServices.layer),
  );
};
