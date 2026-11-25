import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { PROCESSING_STALE_MS } from "./config.js";
import { makeHandler } from "./server.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PASSWORD = "correct-horse";
const WORKER_TOKEN = "worker-test-token";

function createApp(
  directory: string,
  options: { readonly processingStaleMs?: number; readonly workerToken?: string | null } = {},
) {
  return makeHandler({
    port: 0,
    databaseUrl: `file:${join(directory, "intake.db")}`,
    uploadDir: join(directory, "uploads"),
    webOrigin: "http://localhost:5173",
    adminPassword: PASSWORD,
    sessionSecret: "test-session-secret",
    workerToken: options.workerToken === null ? undefined : options.workerToken ?? WORKER_TOKEN,
    processingStaleMs: options.processingStaleMs ?? PROCESSING_STALE_MS,
  });
}

const directory = mkdtempSync(join(tmpdir(), "intake-worker-"));
const app = createApp(directory);

function cookieOf(response: Response): string {
  const pair = response.headers.get("set-cookie")?.split(";")[0];
  if (pair === undefined) {
    throw new Error("missing set-cookie");
  }
  return pair;
}

async function adminCookie(): Promise<string> {
  const response = await app.handler(
    new Request("http://localhost/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  expect(response.status).toBe(200);
  return cookieOf(response);
}

async function submit(externalId: string): Promise<string> {
  const body = new FormData();
  body.set("firstName", "Ada");
  body.set("lastName", "Lovelace");
  body.set("address", "London");
  body.set("externalId", externalId);
  body.set("image", new File([PNG], "portrait.png", { type: "image/png" }));
  const response = await app.handler(new Request("http://localhost/api/submissions", { method: "POST", body }));
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { id: string };
  return payload.id;
}

async function verify(id: string, cookie: string): Promise<void> {
  const response = await app.handler(
    new Request(`http://localhost/api/submissions/${id}/verify`, { method: "POST", headers: { cookie } }),
  );
  expect(response.status).toBe(200);
}

function workerHeaders(token = WORKER_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function drainQueue(): Promise<void> {
  for (;;) {
    const response = await app.handler(
      new Request("http://localhost/api/worker/jobs/claim", { method: "POST", headers: workerHeaders() }),
    );
    if (response.status === 204) {
      return;
    }
    expect(response.status).toBe(200);
    const job = (await response.json()) as { id: string };
    const result = await app.handler(
      new Request(`http://localhost/api/worker/jobs/${job.id}/result`, {
        method: "POST",
        headers: workerHeaders(),
        body: JSON.stringify({ outcome: "failed", message: "drained" }),
      }),
    );
    expect(result.status).toBe(200);
  }
}

afterAll(async () => {
  await app.dispose();
  rmSync(directory, { recursive: true, force: true });
});

describe("submit to records", () => {
  it("queues a verified submission for an admin and refuses the worker token", async () => {
    const cookie = await adminCookie();
    const id = await submit("rec_queue");
    await verify(id, cookie);

    const asWorker = await app.handler(
      new Request(`http://localhost/api/admin/submissions/${id}/submit-to-records`, {
        method: "POST",
        headers: workerHeaders(),
      }),
    );
    expect(asWorker.status).toBe(401);

    const queued = await app.handler(
      new Request(`http://localhost/api/admin/submissions/${id}/submit-to-records`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(queued.status).toBe(200);
    const body = (await queued.json()) as { status: string };
    expect(body.status).toBe("queued");

    const again = await app.handler(
      new Request(`http://localhost/api/admin/submissions/${id}/submit-to-records`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(again.status).toBe(409);
  });

  it("refuses to queue a submission that is still pending", async () => {
    const cookie = await adminCookie();
    const id = await submit("rec_pending_queue");
    const response = await app.handler(
      new Request(`http://localhost/api/admin/submissions/${id}/submit-to-records`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(409);
  });
});

describe("worker jobs", () => {
  it("requires the worker bearer token and ignores the admin cookie", async () => {
    const cookie = await adminCookie();
    const claim = await app.handler(
      new Request("http://localhost/api/worker/jobs/claim", { method: "POST", headers: { cookie } }),
    );
    expect(claim.status).toBe(401);

    const wrong = await app.handler(
      new Request("http://localhost/api/worker/jobs/claim", { method: "POST", headers: workerHeaders("nope") }),
    );
    expect(wrong.status).toBe(401);

    const list = await app.handler(
      new Request("http://localhost/api/submissions", { headers: { authorization: `Bearer ${WORKER_TOKEN}` } }),
    );
    expect(list.status).toBe(401);
  });

  it("claims one queued job, serves its image, and records the worker result", async () => {
    await drainQueue();
    const cookie = await adminCookie();
    const id = await submit("rec_claim");
    await verify(id, cookie);
    const queued = await app.handler(
      new Request(`http://localhost/api/admin/submissions/${id}/submit-to-records`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(queued.status).toBe(200);

    const claim = await app.handler(
      new Request("http://127.0.0.1:3001/api/worker/jobs/claim", { method: "POST", headers: workerHeaders() }),
    );
    expect(claim.status).toBe(200);
    const job = (await claim.json()) as {
      id: string;
      firstName: string;
      recordId: string;
      imageUrl: string;
    };
    expect(job.id).toBe(id);
    expect(job.firstName).toBe("Ada");
    expect(job.recordId).toBe("rec_claim");
    const imageUrl = job.imageUrl.startsWith("http") ? job.imageUrl : `http://127.0.0.1:3001${job.imageUrl}`;
    expect(new URL(imageUrl).pathname).toBe(`/api/worker/jobs/${id}/image`);

    const image = await app.handler(new Request(imageUrl, { headers: { authorization: `Bearer ${WORKER_TOKEN}` } }));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true);

    const imageAsAdmin = await app.handler(new Request(imageUrl, { headers: { cookie } }));
    expect(imageAsAdmin.status).toBe(401);

    const adminImage = await app.handler(
      new Request(`http://localhost/api/submissions/${id}/image`, {
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      }),
    );
    expect(adminImage.status).toBe(401);

    const empty = await app.handler(
      new Request("http://localhost/api/worker/jobs/claim", { method: "POST", headers: workerHeaders() }),
    );
    expect(empty.status).toBe(204);

    const result = await app.handler(
      new Request(`http://localhost/api/worker/jobs/${id}/result`, {
        method: "POST",
        headers: workerHeaders(),
        body: JSON.stringify({ outcome: "sent", message: "Checked.", recordsRequestId: "req_1" }),
      }),
    );
    expect(result.status).toBe(200);
    const saved = (await result.json()) as { status: string; workerMessage: string | null; recordsRequestId: string | null };
    expect(saved.status).toBe("sent_to_records");
    expect(saved.workerMessage).toBe("Checked.");
    expect(saved.recordsRequestId).toBe("req_1");

    const late = await app.handler(
      new Request(`http://localhost/api/worker/jobs/${id}/result`, {
        method: "POST",
        headers: workerHeaders(),
        body: JSON.stringify({ outcome: "failed", message: "too late" }),
      }),
    );
    expect(late.status).toBe(409);
  });

  it("stores id_not_found and failed, then lets an admin queue either one again", async () => {
    await drainQueue();
    const cookie = await adminCookie();

    const missingId = await submit("rec_missing");
    await verify(missingId, cookie);
    expect(
      (
        await app.handler(
          new Request(`http://localhost/api/admin/submissions/${missingId}/submit-to-records`, {
            method: "POST",
            headers: { cookie },
          }),
        )
      ).status,
    ).toBe(200);
    const missingClaim = await app.handler(
      new Request("http://localhost/api/worker/jobs/claim", { method: "POST", headers: workerHeaders() }),
    );
    const missingJob = (await missingClaim.json()) as { id: string };
    const missingResult = await app.handler(
      new Request(`http://localhost/api/worker/jobs/${missingJob.id}/result`, {
        method: "POST",
        headers: workerHeaders(),
        body: JSON.stringify({ outcome: "id_not_found", message: "No record exists with that id." }),
      }),
    );
    expect(missingResult.status).toBe(200);
    expect(((await missingResult.json()) as { status: string }).status).toBe("id_not_found");

    const failedId = await submit("rec_failed");
    await verify(failedId, cookie);
    expect(
      (
        await app.handler(
          new Request(`http://localhost/api/admin/submissions/${failedId}/submit-to-records`, {
            method: "POST",
            headers: { cookie },
          }),
        )
      ).status,
    ).toBe(200);
    const failedClaim = await app.handler(
      new Request("http://localhost/api/worker/jobs/claim", { method: "POST", headers: workerHeaders() }),
    );
    const failedJob = (await failedClaim.json()) as { id: string };
    expect(failedJob.id).toBe(failedId);
    const failedResult = await app.handler(
      new Request(`http://localhost/api/worker/jobs/${failedJob.id}/result`, {
        method: "POST",
        headers: workerHeaders(),
        body: JSON.stringify({ outcome: "failed", message: "Could not reach records-admin." }),
      }),
    );
    expect(((await failedResult.json()) as { status: string; workerMessage: string }).workerMessage).toBe(
      "Could not reach records-admin.",
    );

    const requeued = await app.handler(
      new Request(`http://localhost/api/admin/submissions/${failedId}/submit-to-records`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    const requeuedBody = (await requeued.json()) as { status: string; workerMessage: string | null };
    expect(requeuedBody.status).toBe("queued");
    expect(requeuedBody.workerMessage).toBeNull();

    const requeuedMissing = await app.handler(
      new Request(`http://localhost/api/admin/submissions/${missingId}/submit-to-records`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(((await requeuedMissing.json()) as { status: string }).status).toBe("queued");
  });

  it("reclaims a processing job that has been held too long", async () => {
    const staleDirectory = mkdtempSync(join(tmpdir(), "intake-worker-stale-"));
    const stale = createApp(staleDirectory, { processingStaleMs: 0 });
    const login = await stale.handler(
      new Request("http://localhost/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    );
    const cookie = cookieOf(login);
    const body = new FormData();
    body.set("firstName", "Grace");
    body.set("lastName", "Hopper");
    body.set("address", "Arlington");
    body.set("externalId", "rec_stale");
    body.set("image", new File([PNG], "portrait.png", { type: "image/png" }));
    const created = await stale.handler(new Request("http://localhost/api/submissions", { method: "POST", body }));
    const id = ((await created.json()) as { id: string }).id;
    expect(
      (
        await stale.handler(
          new Request(`http://localhost/api/submissions/${id}/verify`, { method: "POST", headers: { cookie } }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await stale.handler(
          new Request(`http://localhost/api/admin/submissions/${id}/submit-to-records`, {
            method: "POST",
            headers: { cookie },
          }),
        )
      ).status,
    ).toBe(200);

    const first = await stale.handler(
      new Request("http://localhost/api/worker/jobs/claim", { method: "POST", headers: workerHeaders() }),
    );
    expect(((await first.json()) as { id: string }).id).toBe(id);
    const second = await stale.handler(
      new Request("http://localhost/api/worker/jobs/claim", { method: "POST", headers: workerHeaders() }),
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { id: string }).id).toBe(id);

    await stale.dispose();
    rmSync(staleDirectory, { recursive: true, force: true });
  });
});

describe("worker API configuration", () => {
  it("keeps the processing reclaim window at 10 minutes", () => {
    expect(PROCESSING_STALE_MS).toBe(10 * 60 * 1000);
  });

  it("returns 503 when WORKER_TOKEN is unset", async () => {
    const closedDirectory = mkdtempSync(join(tmpdir(), "intake-worker-closed-"));
    const closed = createApp(closedDirectory, { workerToken: null });
    const response = await closed.handler(
      new Request("http://localhost/api/worker/jobs/claim", {
        method: "POST",
        headers: workerHeaders(),
      }),
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe("unavailable");
    await closed.dispose();
    rmSync(closedDirectory, { recursive: true, force: true });
  });

  it("opens a database created before the records statuses existed", async () => {
    const legacyDirectory = mkdtempSync(join(tmpdir(), "intake-worker-legacy-"));
    const databaseUrl = `file:${join(legacyDirectory, "intake.db")}`;
    const client = createClient({ url: databaseUrl });
    await client.execute(`
      CREATE TABLE submissions (
        id TEXT PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        address TEXT NOT NULL,
        external_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'approved', 'rejected')),
        image_filename TEXT NOT NULL,
        image_mime_type TEXT NOT NULL,
        image_size_bytes INTEGER NOT NULL,
        image_storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        verified_at TEXT,
        rejected_at TEXT,
        approved_at TEXT
      )
    `);
    const id = "4f3b1c0a-6d2e-4a1b-8c3d-9e0f1a2b3c4d";
    await client.execute({
      sql: `
        INSERT INTO submissions (
          id, first_name, last_name, address, external_id, status,
          image_filename, image_mime_type, image_size_bytes, image_storage_path,
          created_at, updated_at, verified_at
        ) VALUES (?, 'Ada', 'Lovelace', 'London', 'rec_legacy', 'verified', 'portrait.png', 'image/png', 68, '/tmp/portrait.png', ?, ?, ?)
      `,
      args: [id, "2026-11-25T00:00:00.000Z", "2026-11-25T00:00:00.000Z", "2026-11-25T00:00:00.000Z"],
    });
    client.close();

    const legacy = createApp(legacyDirectory);
    const login = await legacy.handler(
      new Request("http://localhost/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    );
    const queued = await legacy.handler(
      new Request(`http://localhost/api/admin/submissions/${id}/submit-to-records`, {
        method: "POST",
        headers: { cookie: cookieOf(login) },
      }),
    );
    expect(queued.status).toBe(200);
    expect(((await queued.json()) as { status: string }).status).toBe("queued");
    await legacy.dispose();
    rmSync(legacyDirectory, { recursive: true, force: true });
  });
});
