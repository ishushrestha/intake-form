export type AllowedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The only HTTP client the worker may use. Redirects are refused so a response
 * cannot send the next request to a host outside the allowlist.
 */
export function createAllowedFetch(options: {
  readonly allowedBaseUrls: readonly string[];
  readonly fetchImpl: AllowedFetch;
}): AllowedFetch {
  const allowedHosts = new Set(options.allowedBaseUrls.map((value) => new URL(value).host));
  return async (url, init) => {
    const parsed = new URL(url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !allowedHosts.has(parsed.host)) {
      throw new Error(`Blocked request to ${parsed.host.length > 0 ? parsed.host : parsed.href}`);
    }
    return options.fetchImpl(parsed.toString(), { ...init, redirect: "error" });
  };
}
