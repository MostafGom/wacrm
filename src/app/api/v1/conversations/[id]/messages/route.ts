// ============================================================
// GET /api/v1/conversations/{id}/messages — list a conversation's
// messages (scope: messages:read), newest first, keyset-paginated.
//
// The conversation is verified to belong to the key's account before
// any message is returned — a foreign or unknown id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import { serializeMessage } from '@/lib/api/v1/conversations';
import { asService } from '@/server/db';
import { isUuid } from '@/server/http';
import { conversationIdInAccount } from '@/server/repos/conversations';
import { listMessagesKeyset } from '@/server/repos/messages';
import type { Message } from '@/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    const { id } = await params;
    const { limit, cursor } = parseListParams(request);

    // Gate on account ownership of the conversation first.
    const conv = isUuid(id)
      ? await asService((db) => conversationIdInAccount(db, ctx.accountId, id))
      : undefined;
    if (!conv) return fail('not_found', 'Conversation not found', 404);

    let data;
    try {
      data = await asService((db) =>
        listMessagesKeyset(db, ctx.accountId, id, { limit: limit + 1, cursor })
      );
    } catch (error) {
      console.error('[api/v1/messages] list error:', error);
      return fail('internal', 'Failed to list messages', 500);
    }

    const { items, nextCursor } = buildPage(
      data as Array<(typeof data)[number] & { created_at: string }>,
      limit
    );
    return okList(
      items.map((m) => serializeMessage(m as unknown as Message)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
