// Browser client for the inbox routes (/api/conversations/**, /api/inbox/*).
// Every function resolves to `{ data, error }` (see lib/http/client).

import { apiRequest } from "@/lib/http/client";
import type { Conversation, ConversationStatus, Message, MessageReaction, MessageTemplate, Profile } from "@/types";

/** Assignee picker row (no email). */
export type InboxAgent = Pick<Profile, "id" | "user_id" | "full_name" | "avatar_url"> & {
  account_role: string;
};

export function listConversations() {
  return apiRequest<{ conversations: Conversation[] }>("/api/conversations");
}

/** One conversation with its contact + tags (realtime payloads carry no joins). */
export function getConversation(id: string) {
  return apiRequest<{ conversation: Conversation }>(`/api/conversations/${id}`);
}

export function updateConversation(
  id: string,
  patch: { status?: ConversationStatus; assigned_agent_id?: string | null },
) {
  return apiRequest<{ conversation: Conversation }>(`/api/conversations/${id}`, { method: "PATCH", body: patch });
}

export function markConversationRead(id: string) {
  return apiRequest<{ ok: true }>(`/api/conversations/${id}/read`, { method: "POST", body: {} });
}

export function listMessages(conversationId: string) {
  return apiRequest<{ messages: Message[] }>(`/api/conversations/${conversationId}/messages`);
}

export function listReactions(conversationId: string) {
  return apiRequest<{ reactions: MessageReaction[] }>(`/api/conversations/${conversationId}/reactions`);
}

export function listUnreadCounts() {
  return apiRequest<{ counts: { id: string; unread_count: number | null }[] }>("/api/conversations/unread");
}

export function getInboxStatus() {
  return apiRequest<{ whatsapp_connected: boolean }>("/api/inbox/status");
}

export function listInboxAgents() {
  return apiRequest<{ profiles: InboxAgent[] }>("/api/inbox/agents");
}

export function listApprovedTemplates() {
  return apiRequest<{ templates: MessageTemplate[] }>("/api/inbox/templates");
}
