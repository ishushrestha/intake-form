export interface BasicAuth {
  readonly user: string;
  readonly password: string;
}

export interface WorkerConfig {
  readonly intakeApiUrl: string;
  readonly intakeWorkerToken: string;
  readonly intakeBasicAuth?: BasicAuth;
  readonly recordsAdminUrl: string;
  readonly recordsAdminUser: string;
  readonly recordsAdminPassword: string;
  readonly recordsAdminBasicAuth?: BasicAuth;
  readonly ollamaUrl: string;
  readonly ollamaModel: string;
  readonly pollSeconds: number;
  readonly headed: boolean;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") {
    return true;
  }
  if (!host.startsWith("127.")) {
    return false;
  }
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Loopback, or a Docker Compose service name such as `ollama`. */
export function isAllowedOllamaHostname(hostname: string): boolean {
  if (isLoopbackHostname(hostname)) {
    return true;
  }
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host);
}

function requiredUrl(env: NodeJS.ProcessEnv, key: string, fallback?: string): string {
  const raw = env[key]?.trim() || fallback;
  if (raw === undefined || raw.length === 0) {
    throw new Error(`${key} is required.`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${key} must be an absolute http(s) URL.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.pathname !== "/" ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error(`${key} must be an absolute http(s) URL without a path or credentials.`);
  }
  return url.origin;
}

function requiredSecret(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function optionalBasicAuth(env: NodeJS.ProcessEnv, userKey: string, passwordKey: string): BasicAuth | undefined {
  const user = env[userKey]?.trim();
  const password = env[passwordKey]?.trim();
  const hasUser = user !== undefined && user.length > 0;
  const hasPassword = password !== undefined && password.length > 0;
  if (!hasUser && !hasPassword) {
    return undefined;
  }
  if (!hasUser || !hasPassword || user === undefined || password === undefined) {
    throw new Error(`${userKey} and ${passwordKey} must both be set.`);
  }
  return { user, password };
}

function pollSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) {
    return 5;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("POLL_SECONDS must be a positive number.");
  }
  return value;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const ollama = requiredUrl(env, "OLLAMA_URL");
  const ollamaHost = new URL(ollama).hostname;
  if (!isAllowedOllamaHostname(ollamaHost)) {
    throw new Error(
      `OLLAMA_URL must be a loopback address (or a Docker Compose service name such as ollama) so the model stays on this machine. Refusing ${ollamaHost}.`,
    );
  }
  const model = env.OLLAMA_MODEL?.trim();
  return {
    intakeApiUrl: requiredUrl(env, "INTAKE_API_URL"),
    intakeWorkerToken: requiredSecret(env, "INTAKE_WORKER_TOKEN"),
    intakeBasicAuth: optionalBasicAuth(env, "INTAKE_BASIC_AUTH_USER", "INTAKE_BASIC_AUTH_PASS"),
    recordsAdminUrl: requiredUrl(env, "RECORDS_ADMIN_URL", "http://localhost:5174"),
    recordsAdminUser: requiredSecret(env, "RECORDS_ADMIN_USER"),
    recordsAdminPassword: requiredSecret(env, "RECORDS_ADMIN_PASSWORD"),
    recordsAdminBasicAuth: optionalBasicAuth(
      env,
      "RECORDS_ADMIN_BASIC_AUTH_USER",
      "RECORDS_ADMIN_BASIC_AUTH_PASS",
    ),
    ollamaUrl: ollama,
    ollamaModel: model === undefined || model.length === 0 ? "qwen2.5:3b" : model,
    pollSeconds: pollSeconds(env.POLL_SECONDS),
    headed: env.HEADED?.trim().toLowerCase() === "true",
  };
}

export function workerAllowedBaseUrls(config: WorkerConfig): readonly string[] {
  return [config.intakeApiUrl, config.recordsAdminUrl, config.ollamaUrl];
}
