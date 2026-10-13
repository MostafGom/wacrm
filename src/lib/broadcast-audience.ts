// Broadcast audience — the shape the wizard builds, plus pure helpers.
// Resolution against the database lives server-side in
// src/server/repos/broadcast-audience.ts (behind /api/broadcasts).

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export type AudienceType = 'all' | 'tags' | 'custom_field' | 'csv';

export interface CsvAudienceRow {
  phone: string;
  name?: string;
}

export interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: CsvAudienceRow[];
  excludeTagIds?: string[];
}

const AUDIENCE_TYPES: readonly AudienceType[] = ['all', 'tags', 'custom_field', 'csv'];
const OPERATORS: readonly CustomFieldOperator[] = ['is', 'is_not', 'contains'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Max CSV rows one broadcast accepts (a sanity ceiling on the request body). */
export const MAX_CSV_AUDIENCE_ROWS = 100_000;

function uuidList(value: unknown): string[] | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 1000) return null;
  if (!value.every((v) => typeof v === 'string' && UUID_RE.test(v))) return null;
  return [...new Set(value as string[])];
}

/**
 * Validate an audience posted by the browser. Returns null when the
 * shape is invalid (the route answers 400). Unknown keys are dropped.
 */
export function parseAudienceConfig(raw: unknown): AudienceConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (!AUDIENCE_TYPES.includes(a.type as AudienceType)) return null;

  const tagIds = uuidList(a.tagIds);
  const excludeTagIds = uuidList(a.excludeTagIds);
  if (tagIds === null || excludeTagIds === null) return null;

  const out: AudienceConfig = { type: a.type as AudienceType };
  if (tagIds) out.tagIds = tagIds;
  if (excludeTagIds) out.excludeTagIds = excludeTagIds;

  if (a.customField !== undefined && a.customField !== null) {
    const cf = a.customField as Record<string, unknown>;
    if (typeof cf !== 'object' || typeof cf.fieldId !== 'string' || typeof cf.value !== 'string') return null;
    if (!OPERATORS.includes(cf.operator as CustomFieldOperator)) return null;
    // An unset field id means "not configured yet" (the wizard's initial
    // state) — keep it so the count answers null rather than 400.
    if (cf.fieldId !== '' && !UUID_RE.test(cf.fieldId)) return null;
    out.customField = {
      fieldId: cf.fieldId,
      operator: cf.operator as CustomFieldOperator,
      value: cf.value,
    };
  }

  if (a.csvContacts !== undefined && a.csvContacts !== null) {
    if (!Array.isArray(a.csvContacts) || a.csvContacts.length > MAX_CSV_AUDIENCE_ROWS) return null;
    const rows: CsvAudienceRow[] = [];
    for (const r of a.csvContacts as unknown[]) {
      const row = r as Record<string, unknown>;
      if (!row || typeof row.phone !== 'string') return null;
      rows.push({
        phone: row.phone.slice(0, 64),
        ...(typeof row.name === 'string' ? { name: row.name.slice(0, 200) } : {}),
      });
    }
    out.csvContacts = rows;
  }

  return out;
}

/**
 * CSV audiences are sized from the uploaded rows without a query;
 * null when no file is loaded. Undefined for every other type.
 */
export function localAudienceCount(audience: AudienceConfig): number | null | undefined {
  if (audience.type !== 'csv') return undefined;
  return audience.csvContacts && audience.csvContacts.length > 0
    ? audience.csvContacts.length
    : null;
}
