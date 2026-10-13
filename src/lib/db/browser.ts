// Browser executor: ships the recorded query AST to /api/db, where it
// is validated, compiled and run under the signed-in user's RLS.

import type { DbAst, DbResult } from "./ast";

export async function httpExecutor(ast: DbAst): Promise<DbResult> {
  try {
    const res = await fetch("/api/db", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ast),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as DbResult | null;
    if (body && "data" in body && "error" in body) return body;
    return {
      data: null,
      error: { message: res.statusText || "Request failed", code: String(res.status), details: null, hint: null },
      count: null,
      status: res.status,
      statusText: res.statusText,
    };
  } catch (e) {
    return {
      data: null,
      error: { message: e instanceof Error ? e.message : "Network error", code: "network_error", details: null, hint: null },
      count: null,
      status: 0,
      statusText: "Network error",
    };
  }
}
