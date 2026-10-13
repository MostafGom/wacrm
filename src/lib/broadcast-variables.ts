// Broadcast template-variable mapping (pure — shared by the wizard and
// the /api/broadcasts route that freezes per-recipient params).

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

type ContactFields = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
};

/**
 * Per-contact resolution of the placeholders. Static and built-in-field
 * mappings resolve directly; custom fields read from a pre-built index
 * (contactId → fieldId → value) to avoid N+1 queries.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: ContactFields,
  customValues?: Map<string, string>,
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | null | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    // custom_field
    return customValues?.get(v.value) ?? '';
  });
}

const MAPPING_TYPES = new Set(['static', 'field', 'custom_field']);

/** Validate a posted variables map; null when malformed. */
export function parseVariableMappings(raw: unknown): Record<string, VariableMapping> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 100) return null;
  const out: Record<string, VariableMapping> = {};
  for (const [key, value] of entries) {
    const v = value as { type?: unknown; value?: unknown } | null;
    if (!v || typeof v !== 'object' || !MAPPING_TYPES.has(v.type as string)) return null;
    if (typeof v.value !== 'string' || v.value.length > 2000) return null;
    out[key] = { type: v.type, value: v.value } as VariableMapping;
  }
  return out;
}
