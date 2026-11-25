import { createServer } from "node:http";
import { connect as connectSocket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRoutes } from "./http.js";

const directory = mkdtempSync(join(tmpdir(), "intake-node-server-"));
const server = createServer();
const app = HttpRouter.serve(
  makeRoutes({
    port: 0,
    databaseUrl: `file:${join(directory, "intake.db")}`,
    uploadDir: join(directory, "uploads"),
    webOrigin: "http://localhost:5173",
    adminPassword: "correct-horse",
    sessionSecret: "test-session-secret",
    workerToken: "worker-test-token",
    processingStaleMs: 10 * 60 * 1000,
  }),
  { disableLogger: true },
).pipe(Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port: 0 })));

let port = 0;
let closeScope: Scope.Closeable | undefined;

interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function decodeChunked(buffer: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) {
      break;
    }
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString("utf8"), 16);
    if (!Number.isFinite(size) || size === 0) {
      break;
    }
    const start = lineEnd + 2;
    parts.push(buffer.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(parts).toString("utf8");
}

function request(
  method: string,
  path: string,
  headers: Readonly<Record<string, string>> = {},
  body?: string,
): Promise<HttpResult> {
  const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  if (body !== undefined) {
    headerLines.push(`content-length: ${Buffer.byteLength(body)}`);
  }
  const payload = `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${headerLines.join("\r\n")}\r\n\r\n${body ?? ""}`;
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: "127.0.0.1", port }, () => {
      socket.write(payload);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const headerEnd = raw.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        reject(new Error(`Incomplete HTTP response: ${raw.toString("utf8")}`));
        return;
      }
      const head = raw.subarray(0, headerEnd).toString("utf8");
      const lines = head.split("\r\n");
      const statusLine = lines[0] ?? "";
      const status = Number(statusLine.split(" ")[1]);
      const responseHeaders: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(":");
        if (separator > 0) {
          responseHeaders[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
        }
      }
      const rest = raw.subarray(headerEnd + 4);
      const responseBody =
        responseHeaders["transfer-encoding"] === "chunked" ? decodeChunked(rest) : rest.toString("utf8");
      resolve({ status, headers: responseHeaders, body: responseBody });
    });
  });
}

beforeAll(async () => {
  const scope = await Effect.runPromise(Scope.make());
  closeScope = scope;
  await Effect.runPromise(Layer.launch(app).pipe(Effect.forkIn(scope, { startImmediately: true })));
  if (!server.listening) {
    await new Promise<void>((resolve) => {
      server.once("listening", () => {
        resolve();
      });
    });
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test server did not bind a TCP port.");
  }
  port = address.port;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const health = await request("GET", "/api/health");
    if (health.status === 200) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error("The test server did not become ready.");
});

afterAll(async () => {
  if (closeScope !== undefined) {
    await Effect.runPromise(Scope.close(closeScope, Exit.void));
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("real Node HTTP server", () => {
  it("writes a parseable 401 body for an unauthenticated session check", async () => {
    const response = await request("GET", "/api/admin/session");
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: "unauthorized",
      message: "Sign in to review submissions.",
    });
  });

  it("writes parseable 400, 404, 429, and success JSON bodies", async () => {
    const health = await request("GET", "/api/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });

    const invalid = await request(
      "POST",
      "/api/admin/login",
      { "content-type": "application/json" },
      "{",
    );
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body).error).toBe("validation_error");

    const signedIn = await request(
      "POST",
      "/api/admin/login",
      { "content-type": "application/json" },
      JSON.stringify({ password: "correct-horse" }),
    );
    expect(signedIn.status).toBe(200);
    expect(JSON.parse(signedIn.body)).toEqual({ authenticated: true });
    const cookie = signedIn.headers["set-cookie"]?.split(";")[0];
    expect(cookie).toBeTruthy();

    const missing = await request("GET", "/api/submissions/not-a-uuid", { cookie: cookie ?? "" });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).error).toBe("not_found");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rejected = await request(
        "POST",
        "/api/admin/login",
        { "content-type": "application/json" },
        JSON.stringify({ password: "wrong" }),
      );
      expect(rejected.status).toBe(401);
      expect(JSON.parse(rejected.body).error).toBe("unauthorized");
    }
    const limited = await request(
      "POST",
      "/api/admin/login",
      { "content-type": "application/json" },
      JSON.stringify({ password: "correct-horse" }),
    );
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.body).error).toBe("rate_limited");
  });
});
