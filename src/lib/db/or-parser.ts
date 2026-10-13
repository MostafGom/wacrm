// ============================================================
// PostgREST logic-tree parser for `.or()` / `.and()` strings.
//
//   name.ilike.*foo*,phone.ilike.*foo*
//   created_at.lt.2024-01-01T00:00:00Z,and(created_at.eq.2024-01-01T00:00:00Z,id.lt.abc)
//   delivery_locked_at.is.null,delivery_locked_at.lt.2024-...
//   status.not.in.(a,b,"c,d")
//
// Values are never interpreted as SQL — they become bind parameters.
// ============================================================

import { DbRequestError, FILTER_OPS, type Filter, type FilterOp } from "./ast";

function bad(input: string, why: string): DbRequestError {
  return new DbRequestError(
    `failed to parse logic tree (${input})`,
    "PGRST100",
    400,
    why,
  );
}

/** Split at top-level commas, respecting parentheses and double quotes. */
function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) throw bad(input, "unbalanced parentheses");
  }
  if (depth !== 0 || quoted) throw bad(input, "unbalanced parentheses or quotes");
  out.push(input.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return v;
}

function parseValue(op: FilterOp, raw: string, input: string): unknown {
  if (op === "in") {
    if (!raw.startsWith("(") || !raw.endsWith(")")) throw bad(input, "in. expects (a,b)");
    const inner = raw.slice(1, -1);
    return inner.trim() === "" ? [] : splitTopLevel(inner).map(unquote);
  }
  if (op === "is") {
    const v = raw.toLowerCase();
    if (v === "null") return null;
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "unknown") return null;
    throw bad(input, `is. expects null/true/false, got "${raw}"`);
  }
  if (op === "contains" || op === "containedBy" || op === "overlaps") {
    // PostgREST array literal `{a,b}` or JSON.
    if (raw.startsWith("{") && raw.endsWith("}")) {
      const inner = raw.slice(1, -1);
      return inner === "" ? [] : splitTopLevel(inner).map(unquote);
    }
    try {
      return JSON.parse(raw);
    } catch {
      return unquote(raw);
    }
  }
  return unquote(raw);
}

const SHORT_OPS: Record<string, FilterOp> = { cs: "contains", cd: "containedBy", ov: "overlaps" };

function parseCondition(part: string, input: string): Filter {
  // `and(...)`, `or(...)`, `not.and(...)`, `not.or(...)`
  const group = /^(not\.)?(and|or)\(([\s\S]*)\)$/.exec(part);
  if (group) {
    return {
      kind: group[2] as "and" | "or",
      negate: Boolean(group[1]),
      items: splitTopLevel(group[3]).map((p) => parseCondition(p, input)),
    };
  }

  const firstDot = part.indexOf(".");
  if (firstDot <= 0) throw bad(input, `expected column.op.value in "${part}"`);
  const column = part.slice(0, firstDot);
  let rest = part.slice(firstDot + 1);

  let negate = false;
  if (rest.startsWith("not.")) {
    negate = true;
    rest = rest.slice(4);
  }
  const opDot = rest.indexOf(".");
  if (opDot <= 0) throw bad(input, `expected op.value in "${part}"`);
  const rawOp = rest.slice(0, opDot);
  const op = (SHORT_OPS[rawOp] ?? rawOp) as FilterOp;
  if (!FILTER_OPS.has(op)) throw bad(input, `unknown operator "${rawOp}"`);
  const value = parseValue(op, rest.slice(opDot + 1), input);
  return { kind: "cond", column, op, value, negate };
}

/** Parse the body of `.or("...")` into an OR group. */
export function parseLogicTree(input: string, kind: "or" | "and" = "or"): Filter {
  const trimmed = input.trim();
  if (!trimmed) throw bad(input, "empty expression");
  return {
    kind,
    items: splitTopLevel(trimmed).map((p) => parseCondition(p, input)),
  };
}
