import { describe, expect, it, vi } from "vitest";
import type { AllowedFetch } from "./allowlist.js";
import { createAllowedFetch } from "./allowlist.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { runOnce } from "./run.js";

const jobId = "4f3b1c0a-6d2e-4a1b-8c3d-9e0f1a2b3c4d";

const config: WorkerConfig = {
  intakeApiUrl: "http://127.0.0.1:3001",
  intakeWorkerToken: "intake-token",
  recordsApiUrl: "http://127.0.0.1:3002",
  recordsWorkerToken: "records-token",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "qwen2.5:3b",
  pollSeconds: 5,
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
  readonly artistStatus?: number;
  readonly artistThrows?: boolean;
  readonly imageUrl?: string;
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
    if (parsed.pathname.includes("/artists/")) {
      if (options.artistThrows) {
        throw new Error("connect ECONNREFUSED");
      }
      if (options.artistStatus === 404) {
        return new Response("missing", { status: 404 });
      }
      return Response.json({ id: "rec_1001", name: "Ada Lovelace" });
    }
    if (parsed.pathname.endsWith("/image")) {
      return new Response(Uint8Array.from([1, 2, 3]), { headers: { "content-type": "image/png" } });
    }
    if (parsed.pathname.endsWith("/entry-requests")) {
      return Response.json({ id: "req_9", status: "pending" }, { status: 201 });
    }
    if (parsed.pathname.endsWith("/result")) {
      return Response.json({ ok: true });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { calls, fetchImpl };
}

async function reported(options: Parameters<typeof fakeWorld>[0]) {
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
  RECORDS_API_URL: "http://127.0.0.1:3002",
  RECORDS_WORKER_TOKEN: "records-token",
  OLLAMA_URL: "http://127.0.0.1:11434",
  OLLAMA_MODEL: "qwen2.5:3b",
  POLL_SECONDS: "5",
};

describe("local worker", () => {
  it("sends a checked submission to records-admin", async () => {
    const { calls, result } = await reported({});
    expect(result).toEqual({ outcome: "sent", recordsRequestId: "req_9", message: "Spacing checked." });

    const ollama = calls.find((call) => call.url.endsWith("/api/chat"));
    expect(ollama?.json).toMatchObject({
      model: "qwen2.5:3b",
      stream: false,
      format: "json",
      options: { temperature: 0 },
    });
    const entry = calls.find((call) => call.url.endsWith("/entry-requests"));
    expect(entry?.form?.get("artistId")).toBe("rec_1001");
    expect(entry?.form?.get("firstName")).toBe("Ada");
    expect(entry?.form?.get("lastName")).toBe("Lovelace");
    expect(entry?.form?.get("sourceSubmissionId")).toBe(jobId);
    expect(entry?.form?.get("image")).toBeTruthy();
    expect(entry?.authorization).toBe("Bearer records-token");
    expect(calls.find((call) => call.url.endsWith("/jobs/claim"))?.authorization).toBe("Bearer intake-token");
    expect(calls.some((call) => call.url === `http://127.0.0.1:3001/api/worker/jobs/${jobId}/image`)).toBe(true);
    expect(calls.every((call) => call.redirect === "error")).toBe(true);
  });

  it("reports id_not_found without posting an entry", async () => {
    const { calls, result } = await reported({ artistStatus: 404 });
    expect(result.outcome).toBe("id_not_found");
    expect(result.message).toMatch(/No record exists with that id/);
    expect(calls.some((call) => call.url.endsWith("/entry-requests"))).toBe(false);
  });

  it("catches a model that invents a different record id", async () => {
    const { calls, result } = await reported({
      model: { ...matchingModel, recordId: "rec_FAKE" },
    });
    expect(result.outcome).toBe("sent");
    expect(calls.some((call) => call.url.includes("rec_FAKE"))).toBe(false);
    const entry = calls.find((call) => call.url.endsWith("/entry-requests"));
    expect(entry?.form?.get("artistId")).toBe("rec_1001");
    expect(String(entry?.form?.get("llmNotes"))).toMatch(/did not match/);
    expect(result.message).toMatch(/did not match/);
  });

  it("sends the original name when the model invents one", async () => {
    const { calls } = await reported({
      model: { ...matchingModel, lastName: "Smith" },
    });
    const entry = calls.find((call) => call.url.endsWith("/entry-requests"));
    expect(entry?.form?.get("lastName")).toBe("Lovelace");
    expect(String(entry?.form?.get("llmNotes"))).toMatch(/last name/i);
  });

  it("reports a records network error as failed", async () => {
    const { result } = await reported({ artistThrows: true });
    expect(result.outcome).toBe("failed");
    expect(result.message).toMatch(/Could not reach records-admin/);
  });

  it("blocks a host that is not on the allowlist", async () => {
    const inner = vi.fn<AllowedFetch>(async () => new Response("no"));
    const allowed = createAllowedFetch({
      allowedBaseUrls: [config.intakeApiUrl, config.recordsApiUrl, config.ollamaUrl],
      fetchImpl: inner,
    });
    await expect(allowed("http://example.com/telemetry")).rejects.toThrow(/Blocked request to example.com/);
    await expect(allowed("http://127.0.0.1:3001@example.com/path")).rejects.toThrow(/Blocked request to example.com/);
    expect(inner).not.toHaveBeenCalled();

    const world = fakeWorld({ imageUrl: "http://example.com/secret.png" });
    const cycle = await runOnce({ config, fetchImpl: world.fetchImpl });
    expect(cycle.kind).toBe("reported");
    if (cycle.kind === "reported") {
      expect(cycle.result.outcome).toBe("failed");
      expect(cycle.result.message).toMatch(/Blocked request to example.com/);
    }
    expect(world.calls.some((call) => call.url.includes("example.com"))).toBe(false);
  });

  it("refuses to start when Ollama is not on loopback", () => {
    expect(() => loadWorkerConfig({ ...baseEnv, OLLAMA_URL: "http://10.1.2.3:11434" })).toThrow(/loopback/);
    expect(() => loadWorkerConfig({ ...baseEnv, OLLAMA_URL: "http://0.0.0.0:11434" })).toThrow(/loopback/);
    expect(loadWorkerConfig(baseEnv).ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(loadWorkerConfig({ ...baseEnv, OLLAMA_URL: "http://localhost:11434" }).ollamaUrl).toBe("http://localhost:11434");
  });
});
