// ============================================================
// GET /api/v1/conversations/{id} — read one conversation
// (scope: conversations:read). Account-scoped: a foreign id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { normalizeConversation } from '@/lib/inbox/conversations';
import { serializeConversation } from '@/lib/api/v1/conversations';
import { asService } from '@/server/db';
import { getConversationWithContact } from '@/server/repos/conversations';
import type { Conversation } from '@/types';
import { isUuid } from '@/server/http';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { id } = await params;
    if (!isUuid(id)) return fail('not_found', 'Conversation not found', 404);

    let data;
    try {
      data = await asService((db) =>
        getConversationWithContact(db, ctx.accountId, id)
      );
    } catch (error) {
      console.error('[api/v1/conversations] read error:', error);
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!data) return fail('not_found', 'Conversation not found', 404);

    return ok(
      serializeConversation(normalizeConversation(data as unknown as Conversation))
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
