export interface WorkerConfig {
  readonly intakeApiUrl: string;
  readonly intakeWorkerToken: string;
  readonly recordsAdminUrl: string;
  readonly recordsAdminUser: string;
  readonly recordsAdminPassword: string;
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
  if (!isLoopbackHostname(ollamaHost)) {
    throw new Error(
      `OLLAMA_URL must be a loopback address so the model stays on this PC. Refusing ${ollamaHost}. Set OLLAMA_HOST=127.0.0.1 before starting Ollama.`,
    );
  }
  const model = env.OLLAMA_MODEL?.trim();
  return {
    intakeApiUrl: requiredUrl(env, "INTAKE_API_URL"),
    intakeWorkerToken: requiredSecret(env, "INTAKE_WORKER_TOKEN"),
    recordsAdminUrl: requiredUrl(env, "RECORDS_ADMIN_URL", "http://localhost:5174"),
    recordsAdminUser: requiredSecret(env, "RECORDS_ADMIN_USER"),
    recordsAdminPassword: requiredSecret(env, "RECORDS_ADMIN_PASSWORD"),
    ollamaUrl: ollama,
    ollamaModel: model === undefined || model.length === 0 ? "qwen2.5:3b" : model,
    pollSeconds: pollSeconds(env.POLL_SECONDS),
    headed: env.HEADED?.trim().toLowerCase() === "true",
  };
}

export function workerAllowedBaseUrls(config: WorkerConfig): readonly string[] {
  return [config.intakeApiUrl, config.recordsAdminUrl, config.ollamaUrl];
}
