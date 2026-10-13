// Browser client for the broadcast + message-template routes.
// Every function resolves to `{ data, error }` (see lib/http/client).

import { apiRequest } from "@/lib/http/client";
import { localAudienceCount, type AudienceConfig } from "@/lib/broadcast-audience";
import type { VariableMapping } from "@/lib/broadcast-variables";
import type { Broadcast, BroadcastRecipient, MessageTemplate } from "@/types";

/** `contact` is embedded (null at runtime once the contact was deleted, migration 004). */
export type BroadcastRecipientWithContact = BroadcastRecipient;

/** A pending recipient of a just-created wizard send. */
export interface PlannedRecipient {
  id: string;
  phone: string | null;
  template_params: string[];
}

export interface CreateBroadcastInput {
  name: string;
  template_name: string;
  template_language: string;
  template_variables: Record<string, VariableMapping>;
  audience: AudienceConfig;
}

export type RecipientResultInput =
  | { id: string; status: "sent"; whatsapp_message_id: string | null }
  | { id: string; status: "failed"; error_message: string };

// ---- broadcasts ------------------------------------------------------

export function listBroadcasts() {
  return apiRequest<{ broadcasts: Broadcast[] }>("/api/broadcasts");
}

export function getBroadcastDetail(id: string) {
  return apiRequest<{ broadcast: Broadcast; recipients: BroadcastRecipientWithContact[] }>(`/api/broadcasts/${id}`);
}

/** 400 `error.code === 'no_contacts'` when the audience resolves to nobody. */
export function createBroadcast(input: CreateBroadcastInput) {
  return apiRequest<{ broadcast: Broadcast; recipients: PlannedRecipient[] }>("/api/broadcasts", {
    method: "POST",
    body: input,
  });
}

export function saveBroadcastDraft(input: CreateBroadcastInput) {
  return apiRequest<{ broadcast: Broadcast }>("/api/broadcasts", {
    method: "POST",
    body: { ...input, draft: true },
  });
}

export function recordRecipientResults(broadcastId: string, results: RecipientResultInput[]) {
  return apiRequest<{ updated: number }>(`/api/broadcasts/${broadcastId}/results`, {
    method: "POST",
    body: { results },
  });
}

export function setBroadcastStatus(broadcastId: string, status: "sent" | "failed") {
  return apiRequest<{ ok: true }>(`/api/broadcasts/${broadcastId}`, { method: "PATCH", body: { status } });
}

export function deleteBroadcast(broadcastId: string) {
  return apiRequest<{ ok: true }>(`/api/broadcasts/${broadcastId}`, { method: "DELETE" });
}

/**
 * Audience size for the wizard's estimate (null = not configured yet).
 * CSV audiences are counted locally. Throws on a failed request so
 * callers keep their catch-and-reset behaviour.
 */
export async function countAudience(audience: AudienceConfig): Promise<number | null> {
  const local = localAudienceCount(audience);
  if (local !== undefined) return local;
  const { data, error } = await apiRequest<{ count: number | null }>("/api/broadcasts/audience-count", {
    method: "POST",
    body: { audience },
  });
  if (error) throw new Error(error.message);
  return data.count;
}

// ---- templates ---------------------------------------------------------

export function listTemplates(q: { status?: string; mine?: boolean } = {}) {
  return apiRequest<{ templates: MessageTemplate[] }>("/api/whatsapp/templates", {
    query: { status: q.status, mine: q.mine ? 1 : undefined },
  });
}
