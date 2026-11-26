import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PROCESSING_STALE_MS } from "./config.js";
import { makeHandler } from "./server.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PASSWORD = "correct-horse";
const WORKER_TOKEN = "worker-test-token";

function createApp(directory: string) {
  return makeHandler({
    port: 0,
    databaseUrl: `file:${join(directory, "intake.db")}`,
    uploadDir: join(directory, "uploads"),
    webOrigin: "http://localhost:5173",
    adminPassword: PASSWORD,
    sessionSecret: "test-session-secret",
    workerToken: WORKER_TOKEN,
    processingStaleMs: PROCESSING_STALE_MS,
  });
}

const directory = mkdtempSync(join(tmpdir(), "intake-entry-requests-"));
const app = createApp(directory);

function cookieOf(response: Response): string {
  const pair = response.headers.get("set-cookie")?.split(";")[0];
  if (pair === undefined) {
    throw new Error("missing set-cookie");
  }
  return pair;
}

function workerHeaders(token = WORKER_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
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

async function createRequest(
  submissionId: string,
  externalId = "A0001",
): Promise<{ id: string; status: string; submissionId: string }> {
  const response = await app.handler(
    new Request("http://localhost/api/worker/entry-requests", {
      method: "POST",
      headers: workerHeaders(),
      body: JSON.stringify({
        sourceSubmissionId: submissionId,
        artistId: externalId,
        artistName: "Ada Lovelace",
        firstName: "Ada",
        lastName: "Lovelace",
        address: "London",
        notes: "Spacing checked.",
      }),
    }),
  );
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return (await response.json()) as { id: string; status: string; submissionId: string };
}

async function completeVerify(
  id: string,
  outcome: "done" | "failed",
  extra: {
    readonly entryId?: string;
    readonly recordsArtistId?: string;
    readonly message?: string;
    readonly screenshot?: boolean;
  } = {},
): Promise<Response> {
  const body = new FormData();
  body.set("outcome", outcome);
  if (extra.entryId !== undefined) {
    body.set("entryId", extra.entryId);
  }
  if (extra.recordsArtistId !== undefined) {
    body.set("recordsArtistId", extra.recordsArtistId);
  }
  if (extra.message !== undefined) {
    body.set("message", extra.message);
  }
  if (extra.screenshot !== false) {
    body.set("screenshot", new File([PNG], "shot.png", { type: "image/png" }));
  }
  return app.handler(
    new Request(`http://localhost/api/worker/entry-requests/${id}/result`, {
      method: "POST",
      headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      body,
    }),
  );
}

afterAll(async () => {
  await app.dispose();
  rmSync(directory, { recursive: true, force: true });
});

describe("LLM entry request status transitions", () => {
  it("saves a pending request and ignores the admin cookie on worker routes", async () => {
    const cookie = await adminCookie();
    const submissionId = await submit("rec_entry_create");
    const asAdmin = await app.handler(
      new Request("http://localhost/api/worker/entry-requests", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          sourceSubmissionId: submissionId,
          artistId: "A0001",
          artistName: "Ada Lovelace",
          firstName: "Ada",
          lastName: "Lovelace",
          address: "London",
        }),
      }),
    );
    expect(asAdmin.status).toBe(401);

    const created = await createRequest(submissionId);
    expect(created.status).toBe("pending");
    expect(created.submissionId).toBe(submissionId);

    const again = await createRequest(submissionId);
    expect(again.id).toBe(created.id);
  });

  it("moves pending to verifying to done with an entry id and screenshot", async () => {
    const cookie = await adminCookie();
    const submissionId = await submit("rec_entry_done");
    const created = await createRequest(submissionId, "A0002");

    const earlyClaim = await app.handler(
      new Request("http://localhost/api/worker/entry-requests/claim", {
        method: "POST",
        headers: workerHeaders(),
      }),
    );
    expect(earlyClaim.status).toBe(204);

    const asWorker = await app.handler(
      new Request(`http://localhost/api/admin/entry-requests/${created.id}/verify`, {
        method: "POST",
        headers: workerHeaders(),
      }),
    );
    expect(asWorker.status).toBe(401);

    const verified = await app.handler(
      new Request(`http://localhost/api/admin/entry-requests/${created.id}/verify`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(verified.status).toBe(200);
    const verifiedBody = (await verified.json()) as { status: string; verifyRequestedAt: string | null };
    expect(verifiedBody.status).toBe("pending");
    expect(verifiedBody.verifyRequestedAt).toEqual(expect.any(String));

    const claim = await app.handler(
      new Request("http://localhost/api/worker/entry-requests/claim", {
        method: "POST",
        headers: workerHeaders(),
      }),
    );
    expect(claim.status).toBe(200);
    const job = (await claim.json()) as { id: string; artistId: string; imageUrl: string };
    expect(job.id).toBe(created.id);
    expect(job.artistId).toBe("A0002");
    expect(job.imageUrl).toBe(`/api/worker/entry-requests/${created.id}/image`);

    const listed = await app.handler(new Request("http://localhost/api/admin/entry-requests", { headers: { cookie } }));
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { requests: Array<{ id: string; status: string }> };
    expect(listBody.requests.find((row) => row.id === created.id)?.status).toBe("verifying");

    const missingArtist = await completeVerify(job.id, "done", {
      entryId: "81c06fd9-4c3a-4bd1-9958-ed4ebd3aad0b",
    });
    expect(missingArtist.status).toBe(400);

    const done = await completeVerify(job.id, "done", {
      entryId: "81c06fd9-4c3a-4bd1-9958-ed4ebd3aad0b",
      recordsArtistId: "A0002",
    });
    expect(done.status).toBe(200);
    const doneBody = (await done.json()) as {
      status: string;
      entryId: string | null;
      recordsArtistId: string | null;
      screenshotAvailable: boolean;
    };
    expect(doneBody.status).toBe("done");
    expect(doneBody.entryId).toBe("81c06fd9-4c3a-4bd1-9958-ed4ebd3aad0b");
    expect(doneBody.recordsArtistId).toBe("A0002");
    expect(doneBody.screenshotAvailable).toBe(true);

    const screenshot = await app.handler(
      new Request(`http://localhost/api/admin/entry-requests/${created.id}/screenshot`, { headers: { cookie } }),
    );
    expect(screenshot.status).toBe(200);
    expect(screenshot.headers.get("content-type")).toBe("image/png");

    const screenshotAsWorker = await app.handler(
      new Request(`http://localhost/api/admin/entry-requests/${created.id}/screenshot`, {
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      }),
    );
    expect(screenshotAsWorker.status).toBe(401);

    const late = await completeVerify(job.id, "failed", { message: "too late" });
    expect(late.status).toBe(409);
  });

  it("moves pending to verifying to failed with a reason and screenshot", async () => {
    const cookie = await adminCookie();
    const submissionId = await submit("rec_entry_failed");
    const created = await createRequest(submissionId, "A0003");
    expect(
      (
        await app.handler(
          new Request(`http://localhost/api/admin/entry-requests/${created.id}/verify`, {
            method: "POST",
            headers: { cookie },
          }),
        )
      ).status,
    ).toBe(200);

    const claim = await app.handler(
      new Request("http://localhost/api/worker/entry-requests/claim", {
        method: "POST",
        headers: workerHeaders(),
      }),
    );
    const job = (await claim.json()) as { id: string };
    const failed = await completeVerify(job.id, "failed", { message: "Could not read the entry ID from the page." });
    expect(failed.status).toBe(200);
    const body = (await failed.json()) as { status: string; failureReason: string | null; screenshotAvailable: boolean };
    expect(body.status).toBe("failed");
    expect(body.failureReason).toBe("Could not read the entry ID from the page.");
    expect(body.screenshotAvailable).toBe(true);

    const screenshot = await app.handler(
      new Request(`http://localhost/api/admin/entry-requests/${created.id}/screenshot`, { headers: { cookie } }),
    );
    expect(screenshot.status).toBe(200);
  });

  it("rejects a pending request and never lets the worker claim it", async () => {
    const cookie = await adminCookie();
    const submissionId = await submit("rec_entry_reject");
    const created = await createRequest(submissionId, "A0004");

    const rejected = await app.handler(
      new Request(`http://localhost/api/admin/entry-requests/${created.id}/reject`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as { status: string }).status).toBe("rejected");

    const claim = await app.handler(
      new Request("http://localhost/api/worker/entry-requests/claim", {
        method: "POST",
        headers: workerHeaders(),
      }),
    );
    expect(claim.status).toBe(204);

    const again = await app.handler(
      new Request(`http://localhost/api/admin/entry-requests/${created.id}/reject`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(again.status).toBe(409);

    const verify = await app.handler(
      new Request(`http://localhost/api/admin/entry-requests/${created.id}/verify`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(verify.status).toBe(409);
  });

  it("refuses a second claim so a verifying request is not retried", async () => {
    const cookie = await adminCookie();
    const submissionId = await submit("rec_entry_claim");
    const created = await createRequest(submissionId, "A0005");
    expect(
      (
        await app.handler(
          new Request(`http://localhost/api/admin/entry-requests/${created.id}/verify`, {
            method: "POST",
            headers: { cookie },
          }),
        )
      ).status,
    ).toBe(200);

    const first = await app.handler(
      new Request("http://localhost/api/worker/entry-requests/claim", {
        method: "POST",
        headers: workerHeaders(),
      }),
    );
    expect(first.status).toBe(200);
    expect(((await first.json()) as { id: string }).id).toBe(created.id);

    const second = await app.handler(
      new Request("http://localhost/api/worker/entry-requests/claim", {
        method: "POST",
        headers: workerHeaders(),
      }),
    );
    expect(second.status).toBe(204);

    const listed = await app.handler(new Request("http://localhost/api/admin/entry-requests", { headers: { cookie } }));
    const listBody = (await listed.json()) as { requests: Array<{ id: string; status: string }> };
    expect(listBody.requests.find((row) => row.id === created.id)?.status).toBe("verifying");
  });

  it("does not auto-retry a request left in verifying", async () => {
    const cookie = await adminCookie();
    const submissionId = await submit("rec_entry_stuck");
    const created = await createRequest(submissionId, "A0006");
    expect(
      (
        await app.handler(
          new Request(`http://localhost/api/admin/entry-requests/${created.id}/verify`, {
            method: "POST",
            headers: { cookie },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.handler(
          new Request("http://localhost/api/worker/entry-requests/claim", {
            method: "POST",
            headers: workerHeaders(),
          }),
        )
      ).status,
    ).toBe(200);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claim = await app.handler(
        new Request("http://localhost/api/worker/entry-requests/claim", {
          method: "POST",
          headers: workerHeaders(),
        }),
      );
      expect(claim.status).toBe(204);
    }

    const listed = await app.handler(new Request("http://localhost/api/admin/entry-requests", { headers: { cookie } }));
    const listBody = (await listed.json()) as { requests: Array<{ id: string; status: string }> };
    expect(listBody.requests.find((row) => row.id === created.id)?.status).toBe("verifying");
  });

  it("lets an admin retry a failed request without creating a second row or double-claiming", async () => {
    const cookie = await adminCookie();
    const submissionId = await submit("rec_entry_retry");
    const created = await createRequest(submissionId, "A0007");
    expect(
      (
        await app.handler(
          new Request(`http://localhost/api/admin/entry-requests/${created.id}/verify`, {
            method: "POST",
            headers: { cookie },
          }),
        )
      ).status,
    ).toBe(200);
    const firstClaim = await app.handler(
      new Request("http://localhost/api/worker/entry-requests/claim", {
        method: "POST",
        headers: workerHeaders(),
      }),
    );
    const firstJob = (await firstClaim.json()) as { id: string };
    expect(
      (await completeVerify(firstJob.id, "failed", { message: "records-admin login failed" })).status,
    ).toBe(200);

    const retry = await app.handler(
      new Request(`http://localhost/api/admin/entry-requests/${created.id}/verify`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as {
      id: string;
      status: string;
      verifyRequestedAt: string | null;
      failureReason: string | null;
    };
    expect(retryBody.id).toBe(created.id);
    expect(retryBody.status).toBe("pending");
    expect(retryBody.verifyRequestedAt).toEqual(expect.any(String));
    expect(retryBody.failureReason).toBeNull();

    const again = await app.handler(
      new Request(`http://localhost/api/admin/entry-requests/${created.id}/verify`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(again.status).toBe(409);

    const secondClaim = await app.handler(
      new Request("http://localhost/api/worker/entry-requests/claim", {
        method: "POST",
        headers: workerHeaders(),
      }),
    );
    expect(secondClaim.status).toBe(200);
    expect(((await secondClaim.json()) as { id: string }).id).toBe(created.id);

    const thirdClaim = await app.handler(
      new Request("http://localhost/api/worker/entry-requests/claim", {
        method: "POST",
        headers: workerHeaders(),
      }),
    );
    expect(thirdClaim.status).toBe(204);

    const done = await completeVerify(created.id, "done", {
      entryId: "entry-retry-1",
      recordsArtistId: "A0001",
    });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { status: string; recordsArtistId: string }).recordsArtistId).toBe("A0001");

    const listed = await app.handler(new Request("http://localhost/api/admin/entry-requests", { headers: { cookie } }));
    const listBody = (await listed.json()) as { requests: Array<{ id: string; submissionId: string }> };
    expect(listBody.requests.filter((row) => row.submissionId === submissionId)).toHaveLength(1);
  });
});
