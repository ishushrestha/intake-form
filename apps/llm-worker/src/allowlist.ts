export type AllowedFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function encodeBasicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

/**
 * Sends Caddy basic_auth as Authorization and moves an existing Bearer token to
 * X-Worker-Authorization so the intake API can still read it.
 */
export function withBasicAuthorization(
  fetchImpl: AllowedFetch,
  host: string,
  user: string,
  password: string,
): AllowedFetch {
  const authorization = encodeBasicAuth(user, password);
  return async (url, init) => {
    if (new URL(url).host !== host) {
      return fetchImpl(url, init);
    }
    const headers = new Headers(init?.headers);
    const existing = headers.get("authorization");
    headers.set("authorization", authorization);
    if (existing !== null && existing.length > 0) {
      headers.set("x-worker-authorization", existing);
    }
    return fetchImpl(url, { ...init, headers });
  };
}

export type AllowedHostSet = ReadonlySet<string>;

export function allowedHostsFrom(baseUrls: readonly string[]): AllowedHostSet {
  return new Set(baseUrls.map((value) => new URL(value).host));
}

export function assertAllowedUrl(url: string, allowedHosts: AllowedHostSet): URL {
  const parsed = new URL(url);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !allowedHosts.has(parsed.host)) {
    throw new Error(`Blocked request to ${parsed.host.length > 0 ? parsed.host : parsed.href}`);
  }
  return parsed;
}

/**
 * The only HTTP client the worker may use. Redirects are refused so a response
 * cannot send the next request to a host outside the allowlist.
 */
export function createAllowedFetch(options: {
  readonly allowedBaseUrls: readonly string[];
  readonly fetchImpl: AllowedFetch;
}): AllowedFetch {
  const allowedHosts = allowedHostsFrom(options.allowedBaseUrls);
  return async (url, init) => {
    const parsed = assertAllowedUrl(url, allowedHosts);
    return options.fetchImpl(parsed.toString(), { ...init, redirect: "error" });
  };
}
