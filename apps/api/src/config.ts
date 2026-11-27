import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface AppConfig {
  readonly port: number;
  readonly host?: string;
  readonly databaseUrl: string;
  readonly uploadDir: string;
  readonly webOrigin: string;
  readonly allowedOrigins?: readonly string[];
  /** Shared admin password. Undefined when admin login is not configured. */
  readonly adminPassword: string | undefined;
  /** HMAC key for the admin session cookie. */
  readonly sessionSecret: string;
  /** Bearer token for the local worker. Undefined closes the worker API. */
  readonly workerToken: string | undefined;
  /** Reclaim a processing job that has been held longer than this. */
  readonly processingStaleMs: number;
  readonly secureCookies?: boolean;
  readonly trustProxy?: boolean;
  readonly webDistDir?: string;
}

export const PROCESSING_STALE_MS = 10 * 60 * 1000;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_WEB_ORIGIN = "http://localhost:5173";
export const MIN_PRODUCTION_ADMIN_PASSWORD_LENGTH = 12;
export const FORBIDDEN_PRODUCTION_ADMIN_PASSWORD = "change-me";

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

export function readHost(raw: string | undefined): string {
  const host = raw?.trim();
  return host === undefined || host.length === 0 ? DEFAULT_HOST : host;
}

export function splitOrigins(raw: string | undefined, fallback = DEFAULT_WEB_ORIGIN): readonly string[] {
  const source = raw?.trim();
  const origins = (source === undefined || source.length === 0 ? fallback : source)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return origins.length > 0 ? origins : [fallback];
}

export function isProduction(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === "production";
}

export function assertProductionAdminPassword(
  nodeEnv: string | undefined,
  password: string | undefined,
): void {
  if (!isProduction(nodeEnv)) {
    return;
  }
  const value = password?.trim() ?? "";
  if (
    value.length === 0 ||
    value === FORBIDDEN_PRODUCTION_ADMIN_PASSWORD ||
    value.length < MIN_PRODUCTION_ADMIN_PASSWORD_LENGTH
  ) {
    throw new Error(
      'ADMIN_PASSWORD must be set to a password of at least 12 characters (not "change-me") when NODE_ENV=production.',
    );
  }
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

function resolveWebDistDir(raw: string | undefined, production: boolean, baseDir: string): string | undefined {
  const specified = raw?.trim();
  if (specified !== undefined && specified.length > 0) {
    return isAbsolute(specified) ? specified : resolve(baseDir, specified);
  }
  if (!production) {
    return undefined;
  }
  return resolve(baseDir, "../web/dist");
}

export function loadConfig(): AppConfig {
  loadEnvFile();
  const production = isProduction(process.env.NODE_ENV);
  assertProductionAdminPassword(process.env.NODE_ENV, process.env.ADMIN_PASSWORD);
  const baseDir = process.cwd();
  const databaseUrl = resolveDatabaseUrl(process.env.DATABASE_URL ?? "file:./data/intake.db", baseDir);
  const uploadDir = resolveUploadDir(process.env.UPLOAD_DIR ?? "./data/uploads", baseDir);
  const webDistDir = resolveWebDistDir(process.env.WEB_DIST, production, baseDir);
  const databasePath = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : null;
  if (databasePath !== null && !databasePath.startsWith("//")) {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  mkdirSync(uploadDir, { recursive: true });
  if (webDistDir !== undefined && !existsSync(join(webDistDir, "index.html"))) {
    throw new Error(`Web build not found at ${webDistDir}. Run pnpm build before pnpm start.`);
  }

  const webOrigin = process.env.WEB_ORIGIN?.trim() || DEFAULT_WEB_ORIGIN;
  const adminPassword = process.env.ADMIN_PASSWORD?.trim();
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  const workerToken = process.env.WORKER_TOKEN?.trim();

  return {
    port: readPort(process.env.PORT),
    host: readHost(process.env.HOST),
    databaseUrl,
    uploadDir,
    webOrigin,
    allowedOrigins: splitOrigins(process.env.ALLOWED_ORIGINS ?? process.env.WEB_ORIGIN, DEFAULT_WEB_ORIGIN),
    adminPassword: adminPassword === undefined || adminPassword.length === 0 ? undefined : adminPassword,
    sessionSecret: sessionSecret === undefined || sessionSecret.length === 0 ? randomBytes(32).toString("base64url") : sessionSecret,
    workerToken: workerToken === undefined || workerToken.length === 0 ? undefined : workerToken,
    processingStaleMs: PROCESSING_STALE_MS,
    secureCookies: production,
    trustProxy: production,
    webDistDir,
  };
}
