export type AllowedFetch = (url: string, init?: RequestInit) => Promise<Response>;

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
