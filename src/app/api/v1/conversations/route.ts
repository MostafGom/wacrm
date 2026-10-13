// ============================================================
// GET /api/v1/conversations — list conversations (scope: conversations:read)
//
// Keyset-paginated (newest first). Filters: `?status=` (open/pending/
// closed) and `?contact_id=`. Each conversation embeds its contact +
// tags (listConversationsKeyset in src/server/repos/conversations.ts).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import { normalizeConversation } from '@/lib/inbox/conversations';
import { serializeConversation } from '@/lib/api/v1/conversations';
import { asService } from '@/server/db';
import { listConversationsKeyset } from '@/server/repos/conversations';
import type { Conversation } from '@/types';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const contactId = url.searchParams.get('contact_id');

    let rows;
    try {
      rows = await asService((db) =>
        listConversationsKeyset(db, ctx.accountId, {
          limit: limit + 1,
          cursor,
          status,
          contactId,
        })
      );
    } catch (error) {
      console.error('[api/v1/conversations] list error:', error);
      return fail('internal', 'Failed to list conversations', 500);
    }

    const { items, nextCursor } = buildPage(
      rows as Array<(typeof rows)[number] & { created_at: string }>,
      limit
    );
    return okList(
      items.map((r) =>
        serializeConversation(
          normalizeConversation(r as unknown as Conversation)
        )
      ),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
