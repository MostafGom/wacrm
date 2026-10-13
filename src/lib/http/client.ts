// ============================================================
// Browser → route-handler fetch helper.
//
// Mirrors the `{ data, error }` result shape the client components
// already handle, so a call site reads:
//
//   const { data, error } = await apiRequest<Tag[]>('/api/tags')
//   if (error) { toast.error(error.message); return }
//
// Route handlers answer errors as `{ error: string }` with a non-2xx
// status (see toErrorResponse in lib/auth/account); that string
// becomes `error.message`. Never throws.
// ============================================================

export interface ApiError {
  message: string;
  status: number;
  /** Optional machine-readable code from the body (`{ code }`). */
  code?: string;
  /** Full parsed body, for routes that return extra error detail. */
  body?: unknown;
}

export type ApiResult<T> = { data: T; error: null } | { data: null; error: ApiError };

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Query string values; undefined/null entries are skipped, arrays repeat the key. */
  query?: Record<string, string | number | boolean | null | undefined | Array<string | number>>;
  /** JSON body (sent with content-type: application/json). */
  body?: unknown;
  signal?: AbortSignal;
}

export function buildUrl(path: string, query?: ApiRequestOptions["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

export async function apiRequest<T>(path: string, opts: ApiRequestOptions = {}): Promise<ApiResult<T>> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  try {
    const res = await fetch(buildUrl(path, opts.query), {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const b = (body ?? {}) as { error?: unknown; message?: unknown; code?: unknown };
      const message =
        typeof b.error === "string"
          ? b.error
          : typeof b.message === "string"
            ? b.message
            : res.statusText || `Request failed (${res.status})`;
      return {
        data: null,
        error: { message, status: res.status, code: typeof b.code === "string" ? b.code : undefined, body },
      };
    }
    return { data: body as T, error: null };
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      return { data: null, error: { message: "Request aborted", status: 0, code: "aborted" } };
    }
    return {
      data: null,
      error: { message: err instanceof Error ? err.message : "Network error", status: 0, code: "network_error" },
    };
  }
}
