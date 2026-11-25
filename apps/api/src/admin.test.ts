import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeHandler } from "./server.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PASSWORD = "correct-horse";

function createApp(directory: string) {
  return makeHandler({
    port: 0,
    databaseUrl: `file:${join(directory, "intake.db")}`,
    uploadDir: join(directory, "uploads"),
    webOrigin: "http://localhost:5173",
    adminPassword: PASSWORD,
    sessionSecret: "test-session-secret",
    workerToken: "worker-test-token",
    processingStaleMs: 10 * 60 * 1000,
  });
}

const directory = mkdtempSync(join(tmpdir(), "intake-admin-"));
const app = createApp(directory);

async function login(password: string): Promise<Response> {
  return app.handler(
    new Request("http://localhost/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
  );
}

function cookieOf(response: Response): string {
  const pair = response.headers.get("set-cookie")?.split(";")[0];
  if (pair === undefined) {
    throw new Error("missing set-cookie");
  }
  return pair;
}

async function submit(externalId: string): Promise<string> {
  const body = new FormData();
  body.set("firstName", "Ada");
  body.set("lastName", "Lovelace");
  body.set("address", "London");
  body.set("externalId", externalId);
  body.set("image", new File([PNG], "portrait.png", { type: "image/png" }));
  const response = await app.handler(
    new Request("http://localhost/api/submissions", { method: "POST", body }),
  );
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { id: string };
  return payload.id;
}

beforeAll(() => {
  void app.handler;
});

afterAll(async () => {
  await app.dispose();
  rmSync(directory, { recursive: true, force: true });
});

describe("admin login", () => {
  it("rejects a wrong password without setting a cookie", async () => {
    const response = await login("nope");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("accepts the shared password and sets an httpOnly session cookie", async () => {
    const response = await login(PASSWORD);
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toContain(PASSWORD);
    const session = await app.handler(
      new Request("http://localhost/api/admin/session", { headers: { cookie: cookieOf(response) } }),
    );
    expect(session.status).toBe(200);
  });
});

describe("protected submission endpoints", () => {
  it("rejects list, detail, and image requests without a session", async () => {
    const id = await submit("rec_locked");
    const list = await app.handler(new Request("http://localhost/api/submissions"));
    const detail = await app.handler(new Request(`http://localhost/api/submissions/${id}`));
    const image = await app.handler(new Request(`http://localhost/api/submissions/${id}/image`));
    expect(list.status).toBe(401);
    expect(detail.status).toBe(401);
    expect(image.status).toBe(401);

    const cookie = cookieOf(await login(PASSWORD));
    const allowed = await app.handler(new Request(`http://localhost/api/submissions/${id}/image`, { headers: { cookie } }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toBe("image/png");
  });
});

describe("status transitions", () => {
  it("allows pending to verified to approved and records approvedAt", async () => {
    const id = await submit("rec_approve");
    const cookie = cookieOf(await login(PASSWORD));
    const headers = { cookie, "content-type": "application/json" };

    const skipped = await app.handler(
      new Request(`http://localhost/api/submissions/${id}/approve`, { method: "POST", headers }),
    );
    expect(skipped.status).toBe(409);

    const verified = await app.handler(
      new Request(`http://localhost/api/submissions/${id}/verify`, { method: "POST", headers }),
    );
    expect(verified.status).toBe(200);
    const verifiedBody = (await verified.json()) as { status: string; verifiedAt: string | null };
    expect(verifiedBody.status).toBe("verified");
    expect(verifiedBody.verifiedAt).toEqual(expect.any(String));

    const again = await app.handler(
      new Request(`http://localhost/api/submissions/${id}/verify`, { method: "POST", headers }),
    );
    expect(again.status).toBe(409);

    const approved = await app.handler(
      new Request(`http://localhost/api/submissions/${id}/approve`, { method: "POST", headers }),
    );
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as { status: string; approvedAt: string | null };
    expect(approvedBody.status).toBe("approved");
    expect(approvedBody.approvedAt).toEqual(expect.any(String));
  });

  it("allows pending to rejected and refuses approval afterwards", async () => {
    const id = await submit("rec_reject");
    const cookie = cookieOf(await login(PASSWORD));
    const headers = { cookie };

    const rejected = await app.handler(
      new Request(`http://localhost/api/submissions/${id}/reject`, { method: "POST", headers }),
    );
    expect(rejected.status).toBe(200);
    const rejectedBody = (await rejected.json()) as { status: string; rejectedAt: string | null };
    expect(rejectedBody.status).toBe("rejected");
    expect(rejectedBody.rejectedAt).toEqual(expect.any(String));

    const approved = await app.handler(
      new Request(`http://localhost/api/submissions/${id}/approve`, { method: "POST", headers }),
    );
    expect(approved.status).toBe(409);
  });
});

describe("login rate limit", () => {
  const limitedDirectory = mkdtempSync(join(tmpdir(), "intake-admin-limit-"));
  const limited = createApp(limitedDirectory);

  afterAll(async () => {
    await limited.dispose();
    rmSync(limitedDirectory, { recursive: true, force: true });
  });

  it("blocks further attempts after repeated failures", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await limited.handler(
        new Request("http://localhost/api/admin/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "wrong" }),
        }),
      );
      expect(response.status).toBe(401);
    }
    const blocked = await limited.handler(
      new Request("http://localhost/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    );
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
  });
});
