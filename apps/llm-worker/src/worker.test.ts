import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AllowedFetch } from "./allowlist.js";
import { createAllowedFetch } from "./allowlist.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { artistIdFromPageUrl, artistNotFoundMessage, entryIdFromPageUrl } from "./playbooks/records-admin.js";
import { runOnce } from "./run.js";

const jobId = "4f3b1c0a-6d2e-4a1b-8c3d-9e0f1a2b3c4d";
const requestId = "6f3b1c0a-6d2e-4a1b-8c3d-9e0f1a2b3c4f";

const config: WorkerConfig = {
  intakeApiUrl: "http://127.0.0.1:3001",
  intakeWorkerToken: "intake-token",
  recordsAdminUrl: "http://localhost:5174",
  recordsAdminUser: "admin",
  recordsAdminPassword: "change-me",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "qwen2.5:3b",
  pollSeconds: 5,
  headed: false,
};

const matchingModel = {
  firstName: "Ada",
  lastName: "Lovelace",
  address: "12 Analytical Engine\nLondon",
  recordId: "rec_1001",
  notes: "Spacing checked.",
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly json: unknown;
  readonly form: FormData | undefined;
  readonly redirect: string | undefined;
}

function fakeWorld(options: {
  readonly model?: Record<string, string>;
  readonly imageUrl?: string;
  readonly verifyJob?: boolean;
  readonly createStatus?: number;
}) {
  const calls: Call[] = [];
  const fetchImpl: AllowedFetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    const form = init?.body instanceof FormData ? init.body : undefined;
    const json = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      json,
      form,
      redirect: init?.redirect,
    });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/entry-requests/claim")) {
      if (!options.verifyJob) {
        return new Response(null, { status: 204 });
      }
      return Response.json({
        id: requestId,
        submissionId: jobId,
        artistId: "A0001",
        artistName: "Ada Lovelace",
        firstName: "Ada",
        lastName: "Lovelace",
        address: "12 Analytical Engine\nLondon",
        notes: "Spacing checked.",
        imageUrl: options.imageUrl ?? `/api/worker/entry-requests/${requestId}/image`,
      });
    }
    if (parsed.pathname.endsWith("/jobs/claim")) {
      return Response.json({
        id: jobId,
        firstName: "Ada",
        lastName: "Lovelace",
        address: "12 Analytical Engine\nLondon",
        recordId: "rec_1001",
        imageUrl: options.imageUrl ?? `/api/worker/jobs/${jobId}/image`,
      });
    }
    if (parsed.pathname.endsWith("/api/chat")) {
      return Response.json({ message: { content: JSON.stringify(options.model ?? matchingModel) } });
    }
    if (parsed.pathname.endsWith("/image")) {
      return new Response(Uint8Array.from([1, 2, 3]), { headers: { "content-type": "image/png" } });
    }
    if (parsed.pathname.endsWith("/entry-requests") && (init?.method ?? "GET") === "POST") {
      if (options.createStatus !== undefined && options.createStatus >= 400) {
        return new Response("no", { status: options.createStatus });
      }
      return Response.json({ id: requestId, status: "pending" }, { status: 201 });
    }
    if (parsed.pathname.endsWith("/result")) {
      return Response.json({ ok: true });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { calls, fetchImpl };
}

async function reported(options: Parameters<typeof fakeWorld>[0] = {}) {
  const world = fakeWorld(options);
  const cycle = await runOnce({ config, fetchImpl: world.fetchImpl });
  expect(cycle.kind).toBe("reported");
  if (cycle.kind !== "reported") {
    throw new Error("expected a reported job");
  }
  return { ...world, result: cycle.result };
}

const baseEnv: NodeJS.ProcessEnv = {
  INTAKE_API_URL: "http://127.0.0.1:3001",
  INTAKE_WORKER_TOKEN: "intake-token",
  RECORDS_ADMIN_URL: "http://localhost:5174",
  RECORDS_ADMIN_USER: "admin",
  RECORDS_ADMIN_PASSWORD: "change-me",
  OLLAMA_URL: "http://127.0.0.1:11434",
  OLLAMA_MODEL: "qwen2.5:3b",
  POLL_SECONDS: "5",
};

describe("local worker", () => {
  it("saves a pending LLM entry request and never calls a records-admin API", async () => {
    const { calls, result } = await reported({});
    expect(result).toEqual({ outcome: "sent", recordsRequestId: requestId, message: "Spacing checked." });

    const ollama = calls.find((call) => call.url.endsWith("/api/chat"));
    expect(ollama?.json).toMatchObject({
      model: "qwen2.5:3b",
      stream: false,
      format: "json",
      options: { temperature: 0 },
    });
    const saved = calls.find((call) => call.url.endsWith("/api/worker/entry-requests"));
    expect(saved?.json).toMatchObject({
      sourceSubmissionId: jobId,
      artistId: "rec_1001",
      artistName: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(saved?.authorization).toBe("Bearer intake-token");
    expect(calls.some((call) => call.url.includes(":3002"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/api/worker/artists/"))).toBe(false);
    expect(calls.every((call) => call.redirect === "error")).toBe(true);
  });

  it("uses the original record id when the model invents a different one", async () => {
    const { calls, result } = await reported({
      model: { ...matchingModel, recordId: "rec_FAKE" },
    });
    expect(result.outcome).toBe("sent");
    const saved = calls.find((call) => call.url.endsWith("/api/worker/entry-requests"));
    expect((saved?.json as { artistId: string }).artistId).toBe("rec_1001");
    expect(result.message).toMatch(/did not match/);
  });

  it("sends the original name when the model invents one", async () => {
    const { calls } = await reported({
      model: { ...matchingModel, lastName: "Smith" },
    });
    const saved = calls.find((call) => call.url.endsWith("/api/worker/entry-requests"));
    expect((saved?.json as { lastName: string }).lastName).toBe("Lovelace");
  });

  it("reports a save error as failed", async () => {
    const { result, calls } = await reported({ createStatus: 500 });
    expect(result.outcome).toBe("failed");
    expect(result.message).toMatch(/Could not save the LLM entry request/);
    expect(calls.some((call) => call.url.includes(":5174"))).toBe(false);
  });

  it("drives records-admin through the playbook after a verify claim", async () => {
    const screenshotDir = mkdtempSync(join(tmpdir(), "intake-worker-shots-"));
    writeFileSync(join(screenshotDir, `${requestId}.png`), Buffer.from("png"));
    const world = fakeWorld({ verifyJob: true });
    const playbook = {
      submitEntry: vi.fn(async (_target, proposed, _screenshotPath) => {
        expect(existsSync(proposed.imagePath)).toBe(true);
        return {
          entryId: "entry-99",
          artistId: "A0001",
        };
      }),
    };
    const cycle = await runOnce({
      config,
      fetchImpl: world.fetchImpl,
      playbook,
      screenshotDir,
    });
    expect(cycle.kind).toBe("verified");
    if (cycle.kind === "verified") {
      expect(cycle.outcome).toBe("done");
      expect(cycle.entryId).toBe("entry-99");
    }
    expect(playbook.submitEntry).toHaveBeenCalledTimes(1);
    const proposed = playbook.submitEntry.mock.calls[0]?.[1];
    expect(proposed).toMatchObject({
      artistId: "A0001",
      firstName: "Ada",
      lastName: "Lovelace",
    });
    const resultCall = world.calls.find((call) => call.url.endsWith(`/${requestId}/result`));
    expect(resultCall?.form?.get("outcome")).toBe("done");
    expect(resultCall?.form?.get("entryId")).toBe("entry-99");
    expect(resultCall?.form?.get("recordsArtistId")).toBe("A0001");
    expect(resultCall?.form?.get("screenshot")).toBeTruthy();
    expect(world.calls.some((call) => call.url.includes(":3002"))).toBe(false);
    expect(existsSync(join(tmpdir(), "intake-worker-images", `${requestId}.png`))).toBe(false);
  });

  it("does not retry a playbook failure as a second claim in the same cycle", async () => {
    const screenshotDir = mkdtempSync(join(tmpdir(), "intake-worker-fail-"));
    const world = fakeWorld({ verifyJob: true });
    const cycle = await runOnce({
      config,
      fetchImpl: world.fetchImpl,
      screenshotDir,
      playbook: {
        submitEntry: async () => {
          throw new Error("The artist row was missing.");
        },
      },
    });
    expect(cycle.kind).toBe("verified");
    if (cycle.kind === "verified") {
      expect(cycle.outcome).toBe("failed");
      expect(cycle.message).toMatch(/artist row was missing/);
    }
    expect(world.calls.filter((call) => call.url.endsWith("/entry-requests/claim")).length).toBe(1);
    expect(world.calls.some((call) => call.url.endsWith("/jobs/claim"))).toBe(false);
    expect(existsSync(join(tmpdir(), "intake-worker-images", `${requestId}.png`))).toBe(false);
  });

  it("blocks a host that is not on the allowlist", async () => {
    const inner = vi.fn<AllowedFetch>(async () => new Response("no"));
    const allowed = createAllowedFetch({
      allowedBaseUrls: [config.intakeApiUrl, config.recordsAdminUrl, config.ollamaUrl],
      fetchImpl: inner,
    });
    await expect(allowed("http://example.com/telemetry")).rejects.toThrow(/Blocked request to example.com/);
    await expect(allowed("http://127.0.0.1:3001@example.com/path")).rejects.toThrow(/Blocked request to example.com/);
    expect(inner).not.toHaveBeenCalled();

    const world = fakeWorld({ imageUrl: "http://example.com/secret.png", verifyJob: true });
    const cycle = await runOnce({
      config,
      fetchImpl: world.fetchImpl,
      playbook: {
        submitEntry: async () => ({ entryId: "nope", artistId: "A0001" }),
      },
    });
    expect(cycle.kind).toBe("verified");
    if (cycle.kind === "verified") {
      expect(cycle.outcome).toBe("failed");
      expect(cycle.message).toMatch(/Blocked request to example.com/);
    }
    expect(world.calls.some((call) => call.url.includes("example.com"))).toBe(false);
  });

  it("refuses to start when Ollama is not on loopback", () => {
    expect(() => loadWorkerConfig({ ...baseEnv, OLLAMA_URL: "http://10.1.2.3:11434" })).toThrow(/loopback/);
    expect(() => loadWorkerConfig({ ...baseEnv, OLLAMA_URL: "http://0.0.0.0:11434" })).toThrow(/loopback/);
    expect(loadWorkerConfig(baseEnv).recordsAdminUrl).toBe("http://localhost:5174");
    expect(loadWorkerConfig(baseEnv).headed).toBe(false);
    expect(loadWorkerConfig({ ...baseEnv, HEADED: "true" }).headed).toBe(true);
    expect(() => loadWorkerConfig({ ...baseEnv, RECORDS_WORKER_TOKEN: "leftover" })).not.toThrow();
  });

  it("reads the entry id and artist id from the records-admin entry URL", () => {
    const url = "http://localhost:5174/artists/A0001/entries/81c06fd9-4c3a-4bd1-9958-ed4ebd3aad0b";
    expect(entryIdFromPageUrl(url)).toBe("81c06fd9-4c3a-4bd1-9958-ed4ebd3aad0b");
    expect(artistIdFromPageUrl(url)).toBe("A0001");
    expect(entryIdFromPageUrl("http://localhost:5174/artists/A0001/entries/new")).toBeUndefined();
    expect(artistNotFoundMessage("A0099")).toBe("Artist A0099 not found in records-admin");
  });
});
