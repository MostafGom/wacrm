// whatsapp_config — one row per account (UNIQUE(account_id), migration 017).
// RLS: any member reads, admin writes. `access_token` / `verify_token`
// are stored encrypted and only ever read server-side.

import type { Db } from "@/server/db";

/** Columns needed to talk to Meta (encrypted token included — server only). */
export function getWhatsAppCredentials(db: Db, accountId: string) {
  return db
    .selectFrom("whatsapp_config")
    .select(["phone_number_id", "waba_id", "access_token", "status"])
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

/** Full row (server only — contains the encrypted tokens). */
export function getWhatsAppConfigRow(db: Db, accountId: string) {
  return db.selectFrom("whatsapp_config").selectAll().where("account_id", "=", accountId).executeTakeFirst();
}

/**
 * The browser-safe view of the row: everything except the encrypted
 * tokens, plus whether a verify token is stored.
 */
export function getWhatsAppConfigForClient(db: Db, accountId: string) {
  return db
    .selectFrom("whatsapp_config")
    .select((eb) => [
      "id",
      "account_id",
      "user_id",
      "phone_number_id",
      "waba_id",
      "status",
      "connected_at",
      "registered_at",
      "subscribed_apps_at",
      "last_registration_error",
      "mirror_inbound_media",
      "created_at",
      "updated_at",
      eb("verify_token", "is not", null).as("has_verify_token"),
    ])
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

/**
 * Whether another account already has this phone_number_id (issue #136).
 * Cross-account by nature, so call it under asService.
 */
export async function isPhoneNumberClaimedElsewhere(db: Db, phoneNumberId: string, accountId: string): Promise<boolean> {
  const row = await db
    .selectFrom("whatsapp_config")
    .select("account_id")
    .where("phone_number_id", "=", phoneNumberId)
    .where("account_id", "!=", accountId)
    .executeTakeFirst();
  return !!row;
}

/** What POST /api/whatsapp/config needs to know about an existing row. */
export function getExistingConfigForSave(db: Db, accountId: string) {
  return db
    .selectFrom("whatsapp_config")
    .select(["id", "registered_at", "phone_number_id", "verify_token"])
    .where("account_id", "=", accountId)
    .executeTakeFirst();
}

export interface WhatsAppConfigWrite {
  phone_number_id: string;
  waba_id: string | null;
  access_token: string;
  verify_token: string | null;
  status: string;
  connected_at: string | null;
  registered_at: string | null;
  subscribed_apps_at: string | null;
  last_registration_error: string | null;
  updated_at: string;
}

export async function updateWhatsAppConfig(db: Db, accountId: string, values: WhatsAppConfigWrite): Promise<void> {
  await db.updateTable("whatsapp_config").set(values).where("account_id", "=", accountId).execute();
}

export async function insertWhatsAppConfig(
  db: Db,
  values: WhatsAppConfigWrite & { account_id: string; user_id: string },
): Promise<void> {
  await db.insertInto("whatsapp_config").values(values).execute();
}

export async function deleteWhatsAppConfig(db: Db, accountId: string): Promise<void> {
  await db.deleteFrom("whatsapp_config").where("account_id", "=", accountId).execute();
}

/** Toggle the inbound-media mirror. False when no row matched (none saved, or not admin under RLS). */
export async function setMirrorInboundMedia(db: Db, accountId: string, value: boolean): Promise<boolean> {
  const r = await db
    .updateTable("whatsapp_config")
    .set({ mirror_inbound_media: value })
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}
