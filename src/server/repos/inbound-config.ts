// whatsapp_config lookups for the inbound Meta webhook (service role).
//
// The webhook has no session: the account is resolved from the
// `phone_number_id` Meta puts on every delivery. The GET verification
// handshake carries no account at all — Meta only echoes the verify
// token — so it is the one deliberately cross-account read here, and it
// returns nothing but the row id and the (encrypted) token.

import type { Db } from "@/server/db";

/** Every config that has a verify token (encrypted) — GET handshake only. */
export function listVerifyTokenConfigs(db: Db) {
  return db
    .selectFrom("whatsapp_config")
    .select(["id", "verify_token"])
    .where("verify_token", "is not", null)
    .execute();
}

/** Rewrite one config's (re-encrypted) verify token. */
export async function setConfigVerifyToken(db: Db, configId: string, encryptedToken: string): Promise<void> {
  await db.updateTable("whatsapp_config").set({ verify_token: encryptedToken }).where("id", "=", configId).execute();
}

/** What inbound processing needs from the config that owns a phone number. */
export interface InboundConfig {
  account_id: string;
  user_id: string;
  access_token: string;
  mirror_inbound_media: boolean;
}

/**
 * Configs registered for `phoneNumberId`. Returns every match (not just
 * the first) so the caller can tell "no config" from "duplicate configs"
 * — migration 013's UNIQUE constraint makes the latter unlikely, but a
 * row created before it would still surface here.
 */
export function listConfigsByPhoneNumberId(db: Db, phoneNumberId: string): Promise<InboundConfig[]> {
  return db
    .selectFrom("whatsapp_config")
    .select(["account_id", "user_id", "access_token", "mirror_inbound_media"])
    .where("phone_number_id", "=", phoneNumberId)
    .execute();
}
