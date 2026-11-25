import { workerJobSchema, workerResultSchema, type WorkerJob, type WorkerResultBody } from "@intake/contracts";
import { createAllowedFetch, type AllowedFetch } from "./allowlist.js";
import { checkAgainstSubmission, parseModelOutput } from "./check.js";
import type { WorkerConfig } from "./config.js";

export interface JobResult {
  readonly outcome: WorkerResultBody["outcome"];
  readonly message?: string;
  readonly recordsRequestId?: string;
}

export type CycleResult =
  | { readonly kind: "idle" }
  | { readonly kind: "reported"; readonly id: string; readonly result: JobResult };

export interface WorkerDependencies {
  readonly config: WorkerConfig;
  readonly fetchImpl?: AllowedFetch;
  readonly log?: (message: string) => void;
  readonly signal?: AbortSignal;
}

const SYSTEM_PROMPT = [
  "You normalize an intake submission.",
  "Reply with JSON only, using exactly these keys: firstName, lastName, address, recordId, notes.",
  "Do not invent a person, address, or record ID. Copy recordId exactly.",
  "notes is a short remark about formatting, or an empty string.",
].join(" ");

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "The request failed.";
}

function clip(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(0, 2000);
}

function bearer(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function extensionFor(type: string): string {
  switch (type) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

async function claimJob(fetchImpl: AllowedFetch, config: WorkerConfig): Promise<WorkerJob | undefined> {
  const response = await fetchImpl(`${config.intakeApiUrl}/api/worker/jobs/claim`, {
    method: "POST",
    headers: bearer(config.intakeWorkerToken),
  });
  if (response.status === 204) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Intake claim failed (${response.status}).`);
  }
  const parsed = workerJobSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Intake returned a job the worker could not read.");
  }
  return parsed.data;
}

async function askModel(fetchImpl: AllowedFetch, config: WorkerConfig, job: WorkerJob): Promise<ReturnType<typeof parseModelOutput>> {
  const response = await fetchImpl(`${config.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.ollamaModel,
      stream: false,
      format: "json",
      options: { temperature: 0 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            firstName: job.firstName,
            lastName: job.lastName,
            address: job.address,
            recordId: job.recordId,
          }),
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}.`);
  }
  return parseModelOutput(await response.json());
}

async function reportResult(fetchImpl: AllowedFetch, config: WorkerConfig, id: string, result: JobResult): Promise<void> {
  const body = workerResultSchema.parse({
    outcome: result.outcome,
    message: clip(result.message),
    recordsRequestId: result.recordsRequestId,
  });
  const response = await fetchImpl(`${config.intakeApiUrl}/api/worker/jobs/${id}/result`, {
    method: "POST",
    headers: { ...bearer(config.intakeWorkerToken), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Intake did not accept the result (${response.status}).`);
  }
}

async function readImage(fetchImpl: AllowedFetch, config: WorkerConfig, imageUrl: string): Promise<{ bytes: Uint8Array; type: string }> {
  const resolved = new URL(imageUrl, `${config.intakeApiUrl}/`).toString();
  const response = await fetchImpl(resolved, { headers: bearer(config.intakeWorkerToken) });
  if (!response.ok) {
    throw new Error(`Could not download the submission image (${response.status}).`);
  }
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  return { bytes: new Uint8Array(await response.arrayBuffer()), type };
}

async function lookupArtist(fetchImpl: AllowedFetch, config: WorkerConfig, recordId: string): Promise<Response | JobResult> {
  try {
    return await fetchImpl(`${config.recordsApiUrl}/api/worker/artists/${encodeURIComponent(recordId)}`, {
      headers: bearer(config.recordsWorkerToken),
    });
  } catch (error) {
    return { outcome: "failed", message: `Could not reach records-admin: ${errorMessage(error)}` };
  }
}

async function postEntry(
  fetchImpl: AllowedFetch,
  config: WorkerConfig,
  job: WorkerJob,
  fields: { firstName: string; lastName: string; address: string; recordId: string; notes: string },
  image: { bytes: Uint8Array; type: string },
): Promise<Response | JobResult> {
  const form = new FormData();
  form.set("artistId", fields.recordId);
  form.set("firstName", fields.firstName);
  form.set("lastName", fields.lastName);
  form.set("address", fields.address);
  form.set("sourceSubmissionId", job.id);
  form.set("llmNotes", fields.notes);
  form.set("image", new File([image.bytes], `upload.${extensionFor(image.type)}`, { type: image.type }));
  try {
    return await fetchImpl(`${config.recordsApiUrl}/api/worker/entry-requests`, {
      method: "POST",
      headers: bearer(config.recordsWorkerToken),
      body: form,
    });
  } catch (error) {
    return { outcome: "failed", message: `Could not reach records-admin: ${errorMessage(error)}` };
  }
}

function isJobResult(value: Response | JobResult): value is JobResult {
  return !(value instanceof Response);
}

async function handleJob(fetchImpl: AllowedFetch, config: WorkerConfig, job: WorkerJob, log: (message: string) => void): Promise<JobResult> {
  let model: ReturnType<typeof parseModelOutput>;
  try {
    model = await askModel(fetchImpl, config, job);
  } catch (error) {
    return { outcome: "failed", message: `Could not reach Ollama: ${errorMessage(error)}` };
  }
  const checked = checkAgainstSubmission(
    {
      firstName: job.firstName,
      lastName: job.lastName,
      address: job.address,
      recordId: job.recordId,
    },
    model,
  );
  if (checked.notes.includes("did not match") || checked.notes.includes("used the original fields")) {
    log(`[worker] ${job.id} model output did not match; using the original fields`);
  }

  const artist = await lookupArtist(fetchImpl, config, checked.recordId);
  if (isJobResult(artist)) {
    return artist;
  }
  if (artist.status === 404) {
    const message = ["No record exists with that id.", checked.notes].filter((part) => part.length > 0).join(" ");
    return { outcome: "id_not_found", message };
  }
  if (!artist.ok) {
    return { outcome: "failed", message: `Records lookup failed (${artist.status}).` };
  }

  let image: { bytes: Uint8Array; type: string };
  try {
    image = await readImage(fetchImpl, config, job.imageUrl);
  } catch (error) {
    return { outcome: "failed", message: errorMessage(error) };
  }

  const created = await postEntry(fetchImpl, config, job, checked, image);
  if (isJobResult(created)) {
    return created;
  }
  if (created.status !== 201) {
    return { outcome: "failed", message: `Records did not accept the entry (${created.status}).` };
  }
  const payload = (await created.json().catch(() => null)) as { id?: unknown } | null;
  const recordsRequestId = typeof payload?.id === "string" && payload.id.trim().length > 0 ? payload.id.trim() : undefined;
  if (recordsRequestId === undefined) {
    return { outcome: "failed", message: "Records response did not include an id." };
  }
  return {
    outcome: "sent",
    recordsRequestId,
    message: checked.notes.length > 0 ? checked.notes : undefined,
  };
}

export async function runOnce(deps: WorkerDependencies): Promise<CycleResult> {
  const config = deps.config;
  const log = deps.log ?? (() => undefined);
  const fetchImpl = createAllowedFetch({
    allowedBaseUrls: [config.intakeApiUrl, config.recordsApiUrl, config.ollamaUrl],
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  const job = await claimJob(fetchImpl, config);
  if (job === undefined) {
    return { kind: "idle" };
  }
  log(`[worker] claimed ${job.id} record ${job.recordId}`);
  let result: JobResult;
  try {
    result = await handleJob(fetchImpl, config, job, log);
  } catch (error) {
    result = { outcome: "failed", message: errorMessage(error) };
  }
  await reportResult(fetchImpl, config, job.id, result);
  if (result.outcome === "sent") {
    log(`[worker] ${job.id} sent request ${result.recordsRequestId ?? ""}`.trim());
  } else if (result.outcome === "id_not_found") {
    log(`[worker] ${job.id} id not found`);
  } else {
    log(`[worker] ${job.id} failed: ${result.message ?? "failed"}`);
  }
  return { kind: "reported", id: job.id, result };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", finish);
      resolve();
    }, ms);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function runWorker(deps: WorkerDependencies & { readonly signal: AbortSignal }): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(message));
  while (!deps.signal.aborted) {
    let idle = true;
    try {
      const cycle = await runOnce({ ...deps, log });
      idle = cycle.kind === "idle";
    } catch (error) {
      log(`[worker] ${errorMessage(error)}`);
    }
    if (deps.signal.aborted || !idle) {
      continue;
    }
    await sleep(deps.config.pollSeconds * 1000, deps.signal);
  }
}
