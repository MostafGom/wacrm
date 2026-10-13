// ============================================================
// CSV contact import (server side of the import modal).
//
//   1. de-dupe rows within the file by normalized phone (and count
//      rows without a usable international number separately)
//   2. skip numbers already in the account
//   3. resolve tag names → ids (admin+ may create missing tags)
//   4. insert in chunks of 50; the per-account unique phone index is
//      the backstop (ON CONFLICT DO NOTHING → counted as skipped); a
//      chunk that fails for another reason is retried row by row so
//      one bad row can't sink the rest
//   5. attach tags to the new contacts
//
// Each step is its own short transaction (Runner), so a failure late
// in the import never rolls back contacts already reported imported.
// ============================================================

import { dedupeByPhone, normalizeKey } from "@/lib/contacts/dedupe";
import { assignImportedContactTags, resolveImportTagIds, type ContactTagAssignment } from "@/lib/contacts/resolve-import-tags";
import type { Db, Runner } from "@/server/db";
import { pgMessage } from "@/server/db/errors";
import { existingPhoneKeys } from "@/server/repos/contacts";

export interface ImportRow {
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
  tagNames: string[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  invalidPhone: number;
  failed: number;
  failedDetails: { phone: string; name?: string; reason: string }[];
  tagsAssigned: number;
  tagsFailed: boolean;
  skippedTagNames: string[];
}

const CHUNK = 50;

export async function importContacts(
  run: Runner,
  params: { accountId: string; userId: string; canCreateTags: boolean; rows: ImportRow[] },
): Promise<ImportResult> {
  const { accountId, userId } = params;
  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    invalidPhone: 0,
    failed: 0,
    failedDetails: [],
    tagsAssigned: 0,
    tagsFailed: false,
    skippedTagNames: [],
  };

  // 1) in-file de-dupe
  const { unique, duplicates, invalid } = dedupeByPhone(params.rows);
  result.skipped += duplicates;
  result.invalidPhone = invalid;

  // 2) skip numbers already in the account
  const existing = await run((db) => existingPhoneKeys(db, accountId));
  const toInsert = unique.filter((row) => {
    if (existing.has(normalizeKey(row.phone))) {
      result.skipped++;
      return false;
    }
    return true;
  });

  // 3) tag names → ids
  const allTagNames = toInsert.flatMap((row) => row.tagNames);
  let tagIdByKey = new Map<string, string>();
  if (allTagNames.length > 0) {
    const resolved = await run((db) =>
      resolveImportTagIds(db, { accountId, userId, tagNames: allTagNames, canCreateTags: params.canCreateTags }),
    );
    tagIdByKey = resolved.tagIdByKey;
    result.skippedTagNames = resolved.skippedNames;
  }

  // 4) insert
  const assignments: ContactTagAssignment[] = [];
  const toValues = (row: ImportRow) => ({
    user_id: userId,
    account_id: accountId,
    phone: row.phone,
    name: row.name || null,
    email: row.email || null,
    company: row.company || null,
  });
  const insertRows = (db: Db, rows: ImportRow[]) =>
    db
      .insertInto("contacts")
      .values(rows.map(toValues))
      .onConflict((oc) => oc.doNothing())
      .returning(["id", "phone_normalized"])
      .execute();
  const recordInserted = (rows: ImportRow[], inserted: { id: string; phone_normalized: string | null }[]) => {
    result.imported += inserted.length;
    result.skipped += rows.length - inserted.length;
    // RETURNING omits conflicting rows, so match back by normalized phone.
    const idByKey = new Map(inserted.map((r) => [r.phone_normalized ?? "", r.id]));
    for (const row of rows) {
      const id = idByKey.get(normalizeKey(row.phone));
      if (id && row.tagNames.length > 0) assignments.push({ contactId: id, tagNames: row.tagNames });
    }
  };

  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    try {
      recordInserted(chunk, await run((db) => insertRows(db, chunk)));
    } catch {
      for (const row of chunk) {
        try {
          recordInserted([row], await run((db) => insertRows(db, [row])));
        } catch (err) {
          console.error("[contacts import] insert failed for", row.phone, err);
          result.failed++;
          result.failedDetails.push({ phone: row.phone, name: row.name ?? undefined, reason: pgMessage(err) });
        }
      }
    }
  }

  // 5) tags — a failure here must not mask the imported contacts
  try {
    result.tagsAssigned = await run((db) => assignImportedContactTags(db, assignments, tagIdByKey));
  } catch (err) {
    console.error("[contacts import] tag assignment failed:", err);
    result.tagsFailed = true;
  }

  return result;
}
