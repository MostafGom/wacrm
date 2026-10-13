// Small helpers for route handlers: body parsing and field validation
// that end in a 400 via HttpError (see toErrorResponse).

import { HttpError } from "@/lib/auth/account";
import { getT } from "@/lib/i18n/translate";

const t = getT("Api.common");

/** Parse a JSON object body or throw 400. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, t("invalidJson"));
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, t("invalidRequestBody"));
  }
  return body as Record<string, unknown>;
}

/** Optional string field: undefined when absent, null when null/blank (trimmed). */
export function optionalString(value: unknown, max = 1000): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max) throw new HttpError(400, t("invalidRequestBody"));
  const v = value.trim();
  return v === "" ? null : v;
}

/** Required non-blank string field (trimmed) or throw 400 with `message`. */
export function requiredString(value: unknown, message = t("invalidRequestBody"), max = 1000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, message);
  return value.trim();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Array of uuids (deduplicated) or throw 400. */
export function uuidArray(value: unknown, max = 1000): string[] {
  if (!Array.isArray(value) || value.length > max || !value.every(isUuid)) {
    throw new HttpError(400, t("invalidRequestBody"));
  }
  return [...new Set(value as string[])];
}
