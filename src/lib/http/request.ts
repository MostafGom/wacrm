// Small request helpers shared by auth / db / storage routes.

/**
 * Best-effort client IP. `x-forwarded-for` is only trustworthy behind a
 * proxy that sets it (the docker-compose deployment sits behind one);
 * it's used for rate-limit keys and session metadata, never for authz.
 */
export function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

/**
 * CSRF guard for cookie-authenticated JSON endpoints. Session cookies are
 * SameSite=Lax, which already blocks cross-site POSTs from most browsers;
 * this adds an explicit Origin check (and rejects requests that carry
 * neither Origin nor Sec-Fetch-Site: same-origin).
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = request.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}
