import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyJobSchema,
  workerJobSchema,
  workerResultSchema,
  type VerifyJob,
  type WorkerJob,
  type WorkerResultBody,
} from "@intake/contracts";
import { allowedHostsFrom, createAllowedFetch, withBasicAuthorization, type AllowedFetch } from "./allowlist.js";
import { checkAgainstSubmission, parseModelOutput } from "./check.js";
import { workerAllowedBaseUrls, type WorkerConfig } from "./config.js";
import { createRecordsAdminPlaybook, type RecordsAdminPlaybook } from "./playbooks/records-admin.js";

export interface JobResult {
  readonly outcome: WorkerResultBody["outcome"];
  readonly message?: string;
  readonly recordsRequestId?: string;
}

export type CycleResult =
  | { readonly kind: "idle" }
  | { readonly kind: "reported"; readonly id: string; readonly result: JobResult }
  | {
      readonly kind: "verified";
      readonly id: string;
      readonly outcome: "done" | "failed";
      readonly entryId?: string;
      readonly recordsArtistId?: string;
      readonly message?: string;
    };

export interface WorkerDependencies {
  readonly config: WorkerConfig;
  readonly fetchImpl?: AllowedFetch;
  readonly log?: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly playbook?: RecordsAdminPlaybook;
  readonly screenshotDir?: string;
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

async function claimVerify(fetchImpl: AllowedFetch, config: WorkerConfig): Promise<VerifyJob | undefined> {
  const response = await fetchImpl(`${config.intakeApiUrl}/api/worker/entry-requests/claim`, {
    method: "POST",
    headers: bearer(config.intakeWorkerToken),
  });
  if (response.status === 204) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Intake verify claim failed (${response.status}).`);
  }
  const parsed = verifyJobSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Intake returned a verify job the worker could not read.");
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

async function savePendingRequest(
  fetchImpl: AllowedFetch,
  config: WorkerConfig,
  job: WorkerJob,
  fields: { firstName: string; lastName: string; address: string; recordId: string; notes: string },
): Promise<JobResult> {
  const response = await fetchImpl(`${config.intakeApiUrl}/api/worker/entry-requests`, {
    method: "POST",
    headers: { ...bearer(config.intakeWorkerToken), "content-type": "application/json" },
    body: JSON.stringify({
      sourceSubmissionId: job.id,
      artistId: fields.recordId,
      artistName: `${fields.firstName} ${fields.lastName}`.trim(),
      firstName: fields.firstName,
      lastName: fields.lastName,
      address: fields.address,
      notes: fields.notes.length > 0 ? fields.notes : undefined,
    }),
  });
  if (!response.ok) {
    return { outcome: "failed", message: `Could not save the LLM entry request (${response.status}).` };
  }
  const payload = (await response.json().catch(() => null)) as { id?: unknown } | null;
  const recordsRequestId = typeof payload?.id === "string" && payload.id.trim().length > 0 ? payload.id.trim() : undefined;
  if (recordsRequestId === undefined) {
    return { outcome: "failed", message: "Intake did not return an entry request id." };
  }
  return {
    outcome: "sent",
    recordsRequestId,
    message: fields.notes.length > 0 ? fields.notes : undefined,
  };
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
  try {
    return await savePendingRequest(fetchImpl, config, job, checked);
  } catch (error) {
    return { outcome: "failed", message: errorMessage(error) };
  }
}

async function reportVerifyResult(
  fetchImpl: AllowedFetch,
  config: WorkerConfig,
  id: string,
  outcome: "done" | "failed",
  options: {
    readonly entryId?: string;
    readonly recordsArtistId?: string;
    readonly message?: string;
    readonly screenshotPath?: string;
  },
): Promise<void> {
  const form = new FormData();
  form.set("outcome", outcome);
  if (options.entryId !== undefined) {
    form.set("entryId", options.entryId);
  }
  if (options.recordsArtistId !== undefined) {
    form.set("recordsArtistId", options.recordsArtistId);
  }
  if (options.message !== undefined) {
    form.set("message", options.message);
  }
  if (options.screenshotPath !== undefined && existsSync(options.screenshotPath)) {
    const bytes = readFileSync(options.screenshotPath);
    form.set("screenshot", new File([bytes], "screenshot.png", { type: "image/png" }));
  }
  const response = await fetchImpl(`${config.intakeApiUrl}/api/worker/entry-requests/${id}/result`, {
    method: "POST",
    headers: bearer(config.intakeWorkerToken),
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Intake did not accept the verify result (${response.status}).`);
  }
}

async function handleVerify(
  fetchImpl: AllowedFetch,
  deps: WorkerDependencies,
  job: VerifyJob,
  playbook: RecordsAdminPlaybook,
  screenshotDir: string,
): Promise<{
  readonly outcome: "done" | "failed";
  readonly entryId?: string;
  readonly recordsArtistId?: string;
  readonly message?: string;
}> {
  mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = join(screenshotDir, `${job.id}.png`);
  const imageDir = join(tmpdir(), "intake-worker-images");
  mkdirSync(imageDir, { recursive: true });
  let imagePath: string | undefined;
  try {
    const image = await readImage(fetchImpl, deps.config, job.imageUrl);
    imagePath = join(imageDir, `${job.id}.${extensionFor(image.type)}`);
    writeFileSync(imagePath, image.bytes);
    const result = await playbook.submitEntry(
      {
        baseUrl: deps.config.recordsAdminUrl,
        username: deps.config.recordsAdminUser,
        password: deps.config.recordsAdminPassword,
      },
      {
        artistId: job.artistId,
        artistName: job.artistName,
        firstName: job.firstName,
        lastName: job.lastName,
        address: job.address,
        imagePath,
      },
      screenshotPath,
    );
    return { outcome: "done", entryId: result.entryId, recordsArtistId: result.artistId };
  } catch (error) {
    return { outcome: "failed", message: errorMessage(error) };
  } finally {
    if (imagePath !== undefined) {
      rmSync(imagePath, { force: true });
    }
  }
}

export async function runOnce(deps: WorkerDependencies): Promise<CycleResult> {
  const config = deps.config;
  const log = deps.log ?? (() => undefined);
  const allowedBaseUrls = workerAllowedBaseUrls(config);
  let fetchImpl = createAllowedFetch({
    allowedBaseUrls,
    fetchImpl: deps.fetchImpl ?? fetch,
  });
  if (config.intakeBasicAuth !== undefined) {
    fetchImpl = withBasicAuthorization(
      fetchImpl,
      new URL(config.intakeApiUrl).host,
      config.intakeBasicAuth.user,
      config.intakeBasicAuth.password,
    );
  }
  const screenshotDir = deps.screenshotDir ?? join(process.cwd(), "data/screenshots");
  const playbook =
    deps.playbook ??
    createRecordsAdminPlaybook({
      headed: config.headed,
      allowedHosts: allowedHostsFrom(allowedBaseUrls),
      httpCredentials:
        config.recordsAdminBasicAuth === undefined
          ? undefined
          : {
              username: config.recordsAdminBasicAuth.user,
              password: config.recordsAdminBasicAuth.password,
            },
    });

  const verifyJob = await claimVerify(fetchImpl, config);
  if (verifyJob !== undefined) {
    log(`[worker] verifying ${verifyJob.id} artist ${verifyJob.artistId}`);
    const result = await handleVerify(fetchImpl, deps, verifyJob, playbook, screenshotDir);
    await reportVerifyResult(fetchImpl, config, verifyJob.id, result.outcome, {
      entryId: result.entryId,
      recordsArtistId: result.recordsArtistId,
      message: clip(result.message),
      screenshotPath: join(screenshotDir, `${verifyJob.id}.png`),
    });
    if (result.outcome === "done") {
      log(`[worker] ${verifyJob.id} wrote entry ${result.entryId ?? ""}`.trim());
    } else {
      log(`[worker] ${verifyJob.id} verify failed: ${result.message ?? "failed"}`);
    }
    return { kind: "verified", id: verifyJob.id, ...result };
  }

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
    log(`[worker] ${job.id} saved pending request ${result.recordsRequestId ?? ""}`.trim());
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
