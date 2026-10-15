// Broadcasts and their recipient rows.
//
// The per-status count columns on `broadcasts` (sent/delivered/read/
// replied/failed) are owned by the recipient aggregate trigger
// (migrations 003/005): nothing here writes them except the initial
// zeroes of a dashboard insert. Recipient writes advance them.

import { jsonObjectFrom } from "kysely/helpers/postgres";

import { sql, type Db } from "@/server/db";
import { jsonb } from "@/server/repos/templates";

/** Recipients whose broadcast belongs to the account (service-role scoping). */
function inAccountBroadcasts(db: Db, accountId: string) {
  return db.selectFrom("broadcasts").select("id").where("account_id", "=", accountId);
}

// ------------------------------------------------------------
// Broadcast rows
// ------------------------------------------------------------

export function listBroadcasts(db: Db, accountId: string) {
  return db
    .selectFrom("broadcasts")
    .selectAll()
    .where("account_id", "=", accountId)
    .orderBy("created_at", "desc")
    .execute();
}

export function getBroadcast(db: Db, accountId: string, id: string) {
  return db
    .selectFrom("broadcasts")
    .selectAll()
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

/** The public API's status view (GET /api/v1/broadcasts/{id}). */
export function getBroadcastSummary(db: Db, accountId: string, id: string) {
  return db
    .selectFrom("broadcasts")
    .select([
      "id",
      "name",
      "template_name",
      "template_language",
      "status",
      "total_recipients",
      "sent_count",
      "delivered_count",
      "read_count",
      "replied_count",
      "failed_count",
      "created_at",
      "updated_at",
    ])
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

export interface BroadcastInsert {
  account_id: string;
  user_id: string;
  name: string;
  template_name: string;
  template_language: string;
  template_variables: unknown;
  audience_filter: unknown;
  status: "draft" | "sending";
  total_recipients: number;
  /** Media for an image/video/document header, reused by server-side resumes. */
  header_media_url?: string | null;
}

/** Dashboard insert (draft, or the parent of a wizard send). */
export function insertBroadcast(db: Db, values: BroadcastInsert) {
  return db
    .insertInto("broadcasts")
    .values({
      ...values,
      template_variables: jsonb(values.template_variables),
      audience_filter: jsonb(values.audience_filter),
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Set the terminal status the wizard computed. False when not in the account. */
export async function setBroadcastStatus(
  db: Db,
  accountId: string,
  id: string,
  status: "sent" | "failed",
): Promise<boolean> {
  const r = await db
    .updateTable("broadcasts")
    .set({ status })
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/** Recipients cascade on broadcasts.id (migration 001). */
export async function deleteBroadcast(db: Db, accountId: string, id: string): Promise<boolean> {
  const r = await db
    .deleteFrom("broadcasts")
    .where("id", "=", id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

/**
 * Parent + recipients in one statement through the SECURITY DEFINER
 * create_broadcast_with_recipients (migrations 037/038/041) — service
 * role only. A recipient failure rolls the parent back (issue #370).
 */
export async function createBroadcastWithRecipients(
  db: Db,
  args: {
    accountId: string;
    userId: string;
    name: string;
    templateName: string;
    templateLanguage: string;
    contactIds: string[];
    templateParams: string[][];
  },
): Promise<{ broadcast_id: string; recipient_id: string; contact_id: string }[]> {
  const r = await sql<{ broadcast_id: string; recipient_id: string; contact_id: string }>`
    SELECT broadcast_id, recipient_id, contact_id
      FROM public.create_broadcast_with_recipients(
        ${args.accountId}::uuid, ${args.userId}::uuid, ${args.name}, ${args.templateName},
        ${args.templateLanguage}, ${args.contactIds.length}::int, ${args.contactIds}::uuid[],
        ${args.templateParams.map((p) => JSON.stringify(p))}::jsonb[])`.execute(db);
  return r.rows;
}

// ------------------------------------------------------------
// Recipient rows
// ------------------------------------------------------------

/** Every recipient with its contact embedded (`contact: Contact | null`), newest first. */
export function listRecipientsWithContact(db: Db, accountId: string, broadcastId: string) {
  return db
    .selectFrom("broadcast_recipients as br")
    .selectAll("br")
    .select((eb) => [
      jsonObjectFrom(eb.selectFrom("contacts").selectAll("contacts").whereRef("contacts.id", "=", "br.contact_id")).as(
        "contact",
      ),
    ])
    .where("br.broadcast_id", "=", broadcastId)
    .where("br.broadcast_id", "in", inAccountBroadcasts(db, accountId))
    .orderBy("br.created_at", "desc")
    .execute();
}

/**
 * Insert the pending recipient rows of a wizard send, each carrying its
 * frozen template params (migration 038 — what makes a resume possible).
 * Returns the rows ordered by id.
 */
export async function insertPendingRecipients(
  db: Db,
  broadcastId: string,
  rows: { contactId: string; params: string[] }[],
): Promise<{ id: string; contact_id: string | null; template_params: unknown }[]> {
  const out: { id: string; contact_id: string | null; template_params: unknown }[] = [];
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const inserted = await db
      .insertInto("broadcast_recipients")
      .values(
        rows.slice(i, i + CHUNK).map((r) => ({
          broadcast_id: broadcastId,
          contact_id: r.contactId,
          status: "pending",
          template_params: jsonb(r.params),
        })),
      )
      .returning(["id", "contact_id", "template_params"])
      .execute();
    out.push(...inserted);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type RecipientResult =
  | { id: string; status: "sent"; whatsapp_message_id: string | null }
  | { id: string; status: "failed"; error_message: string };

/**
 * Stamp one delivery outcome on a recipient of `broadcastId` (which
 * must belong to the account). Returns false when no row matched.
 */
export async function stampRecipient(
  db: Db,
  accountId: string,
  broadcastId: string,
  result: RecipientResult,
): Promise<boolean> {
  const patch =
    result.status === "sent"
      ? {
          status: "sent",
          sent_at: new Date().toISOString(),
          whatsapp_message_id: result.whatsapp_message_id,
          error_message: null,
        }
      : { status: "failed", error_message: result.error_message };
  const r = await db
    .updateTable("broadcast_recipients")
    .set(patch)
    .where("id", "=", result.id)
    .where("broadcast_id", "=", broadcastId)
    .where("broadcast_id", "in", inAccountBroadcasts(db, accountId))
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/** Mark recipients failed in bulk (e.g. contacts without a usable phone). */
export async function failRecipients(
  db: Db,
  accountId: string,
  broadcastId: string,
  ids: string[],
  errorMessage: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .updateTable("broadcast_recipients")
    .set({ status: "failed", error_message: errorMessage })
    .where(sql<boolean>`id = ANY(${ids}::uuid[])`)
    .where("broadcast_id", "=", broadcastId)
    .where("broadcast_id", "in", inAccountBroadcasts(db, accountId))
    .execute();
}

/** Pending / failed / total recipient counts of a broadcast. */
export async function recipientStatusCounts(
  db: Db,
  accountId: string,
  broadcastId: string,
): Promise<{ pending: number; failed: number; total: number }> {
  const r = await db
    .selectFrom("broadcast_recipients")
    .select((eb) => [
      eb.fn.countAll<number>().filterWhere("status", "=", "pending").as("pending"),
      eb.fn.countAll<number>().filterWhere("status", "=", "failed").as("failed"),
      eb.fn.countAll<number>().as("total"),
    ])
    .where("broadcast_id", "=", broadcastId)
    .where("broadcast_id", "in", inAccountBroadcasts(db, accountId))
    .executeTakeFirstOrThrow();
  return { pending: Number(r.pending), failed: Number(r.failed), total: Number(r.total) };
}

/** Write only the terminal `status` (+ updated_at) — counts stay trigger-owned. */
export async function setBroadcastTerminalStatus(
  db: Db,
  accountId: string,
  broadcastId: string,
  status: "sent" | "failed" | "sending",
): Promise<void> {
  await db
    .updateTable("broadcasts")
    .set({ status, updated_at: new Date().toISOString() })
    .where("id", "=", broadcastId)
    .where("account_id", "=", accountId)
    .execute();
}

// ------------------------------------------------------------
// Resume (issue #472)
// ------------------------------------------------------------

/**
 * Take the delivery lock: one conditional UPDATE, so a concurrent
 * caller's WHERE no longer matches. False when another pass holds a
 * fresh lock or the broadcast isn't in the account.
 */
export async function claimDeliveryLock(
  db: Db,
  accountId: string,
  broadcastId: string,
  now: Date,
  staleCutoff: Date,
): Promise<boolean> {
  const rows = await db
    .updateTable("broadcasts")
    .set({ delivery_locked_at: now.toISOString() })
    .where("id", "=", broadcastId)
    .where("account_id", "=", accountId)
    .where((eb) =>
      eb.or([eb("delivery_locked_at", "is", null), eb("delivery_locked_at", "<", staleCutoff.toISOString())]),
    )
    .returning("id")
    .execute();
  return rows.length > 0;
}

export async function releaseDeliveryLock(db: Db, accountId: string, broadcastId: string): Promise<void> {
  await db
    .updateTable("broadcasts")
    .set({ delivery_locked_at: null })
    .where("id", "=", broadcastId)
    .where("account_id", "=", accountId)
    .execute();
}

/**
 * Up to `limit` recipients in `statuses`, oldest first (so repeated
 * capped passes chew through the backlog in a stable order), with the
 * contact's phone, plus the total in scope.
 */
export async function loadRecipientsForResume(
  db: Db,
  accountId: string,
  broadcastId: string,
  statuses: string[],
  limit: number,
): Promise<{ rows: { id: string; template_params: unknown; phone: string | null }[]; inScope: number }> {
  const base = db
    .selectFrom("broadcast_recipients as br")
    .where("br.broadcast_id", "=", broadcastId)
    .where("br.broadcast_id", "in", inAccountBroadcasts(db, accountId))
    .where("br.status", "in", statuses);
  const [rows, count] = await Promise.all([
    base
      .leftJoin("contacts as c", "c.id", "br.contact_id")
      .select(["br.id", "br.template_params", "c.phone"])
      .orderBy("br.created_at", "asc")
      .orderBy("br.id", "asc")
      .limit(limit)
      .execute(),
    base.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow(),
  ]);
  return { rows, inScope: Number(count.n) };
}
