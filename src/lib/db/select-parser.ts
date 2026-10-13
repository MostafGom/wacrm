// ============================================================
// PostgREST select-string parser.
//
// Supported grammar (everything the codebase uses, plus the obvious
// neighbours):
//
//   item     := embed | column | '*'
//   column   := [alias ':'] name [jsonpath] ['::' cast]
//   jsonpath := ('->' | '->>') key ...
//   embed    := [alias ':'] name ['!' hint] ['!inner' | '!left'] '(' items ')'
//
// Examples:
//   '*, contact:contacts(*, contact_tags(tags(*)))'
//   'id, broadcasts!inner(account_id)'
//   '*, assignee:profiles!deals_assigned_to_fkey(*)'
// ============================================================

import { DbRequestError } from "./ast";

export type SelectItem =
  | { type: "star" }
  | {
      type: "column";
      name: string;
      alias?: string;
      /** JSON path segments: [['->>', 'key'], ...]. */
      path?: Array<["->" | "->>", string]>;
      cast?: string;
    }
  | {
      type: "embed";
      name: string;
      alias?: string;
      hint?: string;
      inner: boolean;
      children: SelectItem[];
    };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CAST = /^[a-z_][a-z0-9_ ]*(\[\])?$/;
const JSON_KEY = /^[A-Za-z0-9_-]+$/;

/** Split at top-level commas (ignoring commas inside parentheses). */
function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) throw bad(input);
    } else if (ch === "," && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) throw bad(input);
  out.push(input.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function bad(input: string, why = "unexpected syntax"): DbRequestError {
  return new DbRequestError(
    `failed to parse select parameter (${input})`,
    "PGRST100",
    400,
    why,
  );
}

function ident(name: string, input: string): string {
  if (!IDENT.test(name)) throw bad(input, `invalid identifier "${name}"`);
  return name;
}

export function parseSelect(input: string | undefined | null, depth = 0): SelectItem[] {
  const src = (input ?? "*").replace(/\s+/g, " ").trim() || "*";
  if (depth > 4) throw bad(src, "embedding is limited to 4 levels");
  return splitTopLevel(src).map((part) => parseItem(part, depth, src));
}

function parseItem(part: string, depth: number, input: string): SelectItem {
  if (part === "*") return { type: "star" };

  // Alias prefix — `alias:rest`, but not the `::` of a cast.
  let alias: string | undefined;
  const aliasMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(?!:)\s*([\s\S]*)$/.exec(part);
  let rest = part;
  if (aliasMatch) {
    alias = aliasMatch[1];
    rest = aliasMatch[2];
  }

  const paren = rest.indexOf("(");
  if (paren >= 0) {
    if (!rest.endsWith(")")) throw bad(input);
    const head = rest.slice(0, paren).trim();
    const inside = rest.slice(paren + 1, -1);
    const [name, ...mods] = head.split("!").map((s) => s.trim());
    let hint: string | undefined;
    let inner = false;
    for (const m of mods) {
      if (m === "inner") inner = true;
      else if (m === "left") inner = false;
      else if (hint === undefined) hint = ident(m, input);
      else throw bad(input, `unexpected modifier "${m}"`);
    }
    return {
      type: "embed",
      name: ident(name, input),
      alias,
      hint,
      inner,
      children: parseSelect(inside || "*", depth + 1),
    };
  }

  // Column, optionally with a JSON path and/or a cast.
  let cast: string | undefined;
  const castIdx = rest.indexOf("::");
  if (castIdx >= 0) {
    cast = rest.slice(castIdx + 2).trim().toLowerCase();
    rest = rest.slice(0, castIdx).trim();
    if (!CAST.test(cast)) throw bad(input, `invalid cast "${cast}"`);
  }

  const segs = rest.split(/(->>|->)/).map((s) => s.trim());
  const name = ident(segs[0], input);
  let path: Array<["->" | "->>", string]> | undefined;
  if (segs.length > 1) {
    path = [];
    for (let i = 1; i < segs.length; i += 2) {
      const op = segs[i] as "->" | "->>";
      const key = segs[i + 1];
      if (!key || !JSON_KEY.test(key)) throw bad(input, `invalid json key "${key}"`);
      path.push([op, key]);
    }
  }
  return { type: "column", name, alias, path, cast };
}

/** Parse `col`, `col->>key` or `col->a->>b` used in filters/order. */
export function parseColumnRef(ref: string): {
  name: string;
  path?: Array<["->" | "->>", string]>;
} {
  const item = parseItem(ref.trim(), 0, ref);
  if (item.type !== "column" || item.alias || item.cast) {
    throw new DbRequestError(`invalid column reference "${ref}"`, "PGRST100");
  }
  return { name: item.name, path: item.path };
}
