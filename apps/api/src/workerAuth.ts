import { createHash, timingSafeEqual } from "node:crypto";

export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const token = match?.[1];
  return token === undefined || token.length === 0 ? undefined : token;
}

/** Bearer token from Authorization, or X-Worker-Authorization when Caddy basic_auth occupies Authorization. */
export function workerBearerToken(
  authorization: string | undefined,
  forwardedAuthorization?: string,
): string | undefined {
  return bearerToken(authorization) ?? bearerToken(forwardedAuthorization);
}

/** Compare tokens without leaking the expected value through an early length check. */
export function tokenMatches(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}
