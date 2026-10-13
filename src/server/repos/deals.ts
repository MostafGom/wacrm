// Deals (operational data: members read, agents write — deals RLS in
// 017) plus the lookups the deal form needs and the account-wide
// default deal currency.

import type { ExpressionBuilder } from "kysely";
import { jsonObjectFrom } from "kysely/helpers/postgres";

import type { DB, Db } from "@/server/db";

export type DealStatus = "open" | "won" | "lost";

export interface DealFields {
  title?: string;
  value?: number;
  currency?: string | null;
  contact_id?: string | null;
  pipeline_id?: string;
  stage_id?: string;
  assigned_to?: string | null;
  notes?: string | null;
  expected_close_date?: string | null;
  status?: DealStatus;
}

// ------------------------------------------------------------
// Embeds — `contact` / `assignee` as the board has always received
// them (`*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)`).
// ------------------------------------------------------------

function dealEmbeds(eb: ExpressionBuilder<DB, "deals">) {
  return [
    jsonObjectFrom(eb.selectFrom("contacts").selectAll("contacts").whereRef("contacts.id", "=", "deals.contact_id")).as(
      "contact",
    ),
    jsonObjectFrom(
      eb.selectFrom("profiles").selectAll("profiles").whereRef("profiles.id", "=", "deals.assigned_to"),
    ).as("assignee"),
  ];
}

// ------------------------------------------------------------
// Reads
// ------------------------------------------------------------

/** A pipeline's deals, newest first, with contact + assignee. */
export function listDeals(db: Db, accountId: string, pipelineId: string) {
  return db
    .selectFrom("deals")
    .selectAll("deals")
    .select(dealEmbeds)
    .where("deals.pipeline_id", "=", pipelineId)
    .where("deals.account_id", "=", accountId)
    .orderBy("deals.created_at", "desc")
    .execute();
}

export function getDeal(db: Db, accountId: string, dealId: string) {
  return db
    .selectFrom("deals")
    .selectAll("deals")
    .select(dealEmbeds)
    .where("deals.id", "=", dealId)
    .where("deals.account_id", "=", accountId)
    .executeTakeFirst();
}

/**
 * True when every reference a deal write carries belongs to the
 * account: the stage sits in the pipeline, and the contact / assignee
 * (when set) are the account's. FKs alone don't check tenancy.
 */
export async function dealRefsValid(
  db: Db,
  accountId: string,
  refs: { pipelineId: string; stageId: string; contactId?: string | null; assignedTo?: string | null },
): Promise<boolean> {
  const stage = await db
    .selectFrom("pipeline_stages")
    .innerJoin("pipelines", "pipelines.id", "pipeline_stages.pipeline_id")
    .select("pipeline_stages.id")
    .where("pipeline_stages.id", "=", refs.stageId)
    .where("pipeline_stages.pipeline_id", "=", refs.pipelineId)
    .where("pipelines.account_id", "=", accountId)
    .executeTakeFirst();
  if (!stage) return false;
  if (refs.contactId) {
    const c = await db
      .selectFrom("contacts")
      .select("id")
      .where("id", "=", refs.contactId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    if (!c) return false;
  }
  if (refs.assignedTo) {
    const p = await db
      .selectFrom("profiles")
      .select("id")
      .where("id", "=", refs.assignedTo)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    if (!p) return false;
  }
  return true;
}

// ------------------------------------------------------------
// Writes
// ------------------------------------------------------------

export function insertDeal(
  db: Db,
  values: DealFields & { account_id: string; user_id: string; title: string; pipeline_id: string; stage_id: string },
) {
  return db.insertInto("deals").values(values).returningAll().executeTakeFirstOrThrow();
}

export function updateDeal(db: Db, accountId: string, dealId: string, patch: DealFields) {
  return db
    .updateTable("deals")
    .set(patch)
    .where("id", "=", dealId)
    .where("account_id", "=", accountId)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteDeal(db: Db, accountId: string, dealId: string): Promise<boolean> {
  const r = await db.deleteFrom("deals").where("id", "=", dealId).where("account_id", "=", accountId).executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

// ------------------------------------------------------------
// Deal form lookups
// ------------------------------------------------------------

/** Contact picker: every contact of the account, by name. */
export function listContactOptions(db: Db, accountId: string) {
  return db
    .selectFrom("contacts")
    .select(["id", "name", "phone"])
    .where("account_id", "=", accountId)
    .orderBy("name")
    .execute();
}

/** Assignee picker: the account's member profiles, by name. */
export function listAssigneeOptions(db: Db, accountId: string) {
  return db
    .selectFrom("profiles")
    .select(["id", "full_name", "email"])
    .where("account_id", "=", accountId)
    .orderBy("full_name")
    .execute();
}

/** The contact's most recent conversation (by last message), if any. */
export function latestConversationForContact(db: Db, accountId: string, contactId: string) {
  return db
    .selectFrom("conversations")
    .select(["id", "status", "last_message_at"])
    .where("contact_id", "=", contactId)
    .where("account_id", "=", accountId)
    .orderBy("last_message_at", "desc")
    .limit(1)
    .executeTakeFirst();
}

// ------------------------------------------------------------
// Account default currency (accounts_update RLS: admins+)
// ------------------------------------------------------------

export async function setAccountDefaultCurrency(db: Db, accountId: string, currency: string): Promise<boolean> {
  const r = await db
    .updateTable("accounts")
    .set({ default_currency: currency })
    .where("id", "=", accountId)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}
