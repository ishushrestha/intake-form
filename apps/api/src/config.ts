import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly uploadDir: string;
  readonly webOrigin: string;
  /** Shared admin password. Undefined when admin login is not configured. */
  readonly adminPassword: string | undefined;
  /** HMAC key for the admin session cookie. */
  readonly sessionSecret: string;
  /** Bearer token for the local worker. Undefined closes the worker API. */
  readonly workerToken: string | undefined;
  /** Reclaim a processing job that has been held longer than this. */
  readonly processingStaleMs: number;
}

export const PROCESSING_STALE_MS = 10 * 60 * 1000;

function loadEnvFile(): void {
  const candidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")];
  for (const file of candidates) {
    if (!existsSync(file)) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      const value = rawValue.replace(/^['"]|['"]$/g, "");
      if (key.length > 0 && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    return;
  }
}

function readPort(raw: string | undefined): number {
  const value = raw ?? "3001";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function resolveDatabaseUrl(raw: string, baseDir: string): string {
  if (!raw.startsWith("file:")) {
    return raw;
  }
  const pathPart = raw.slice("file:".length);
  if (pathPart.startsWith("/") || pathPart.startsWith("//")) {
    return raw;
  }
  return `file:${resolve(baseDir, pathPart)}`;
}

function resolveUploadDir(raw: string, baseDir: string): string {
  return isAbsolute(raw) ? raw : resolve(baseDir, raw);
}

export function loadConfig(): AppConfig {
  loadEnvFile();
  const baseDir = process.cwd();
  const databaseUrl = resolveDatabaseUrl(process.env.DATABASE_URL ?? "file:./data/intake.db", baseDir);
  const uploadDir = resolveUploadDir(process.env.UPLOAD_DIR ?? "./data/uploads", baseDir);
  const databasePath = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : null;
  if (databasePath !== null && !databasePath.startsWith("//")) {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  mkdirSync(uploadDir, { recursive: true });

  const adminPassword = process.env.ADMIN_PASSWORD?.trim();
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  const workerToken = process.env.WORKER_TOKEN?.trim();

  return {
    port: readPort(process.env.PORT),
    databaseUrl,
    uploadDir,
    webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    adminPassword: adminPassword === undefined || adminPassword.length === 0 ? undefined : adminPassword,
    sessionSecret: sessionSecret === undefined || sessionSecret.length === 0 ? randomBytes(32).toString("base64url") : sessionSecret,
    workerToken: workerToken === undefined || workerToken.length === 0 ? undefined : workerToken,
    processingStaleMs: PROCESSING_STALE_MS,
  };
}
