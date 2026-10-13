import { describe, it, expect, vi, beforeEach } from 'vitest'

// Shared, hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  resumeAwaitingReply: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  state: {
    // What insertInboundMessage resolves to. A genuine insert returns the
    // new id; a replayed delivery conflicts and returns null.
    messageInsertedId: 'msg-1' as string | null,
    priorCustomerMsgCount: 0,
    /** Row `lookupInternalIdByMetaId` resolves for a `context.id`. */
    replyContextParent: null as { id: string } | null,
    conversation: { id: 'conv-1', unread_count: 0, account_id: 'acc-1', status: 'open' },
    /** Rows handed to insertInboundMessage. */
    messageInserts: [] as Record<string, unknown>[],
    /** bump_conversation_on_inbound calls (#369). */
    bumpCalls: [] as { conversationId: string; lastMessageText: string }[],
    /** phone_number_ids the config lookup was asked for. */
    configLookups: [] as string[],
    /** When true, no whatsapp_config owns the phone number. */
    configMissing: false,
    /** Configs the GET handshake checks verify tokens against. */
    verifyTokenConfigs: [] as { id: string; verify_token: string | null }[],
    afterCallbacks: [] as (() => Promise<void> | void)[],
    automationStarted: 0,
    automationCompleted: 0,
    /** whatsapp_config.mirror_inbound_media for the matched row (#466). */
    mirrorInboundMedia: true as boolean | undefined,
    /** Objects the inbound-media mirror pushed into chat-media. */
    storageUploads: [] as {
      bucket: string
      path: string
      options: { contentType?: string }
    }[],
    /** Error the next storage upload resolves with, if any. */
    storageUploadError: null as { message: string } | null,
    /** Row `findContactByWaUserId` resolves for a BSUID lookup (#519). */
    contactByWaUserId: null as Record<string, unknown> | null,
    /** Rows inserted into `contacts`. */
    contactInserts: [] as Record<string, unknown>[],
    /** Patches applied to an existing `contacts` row. */
    contactUpdates: [] as Record<string, unknown>[],
    /** Patches applied to `messages` by a status webhook (#535). */
    messageUpdates: [] as Record<string, unknown>[],
    /** Account each status-webhook message update was scoped to. */
    messageStatusScopes: [] as string[],
    /** Conversation the status update matched (drives the fan-out). */
    statusConversationId: null as string | null,
    /** Row the status webhook's broadcast_recipients lookup resolves. */
    broadcastRecipient: null as { id: string; status: string } | null,
    /** Patches applied to that broadcast_recipients row. */
    recipientUpdates: [] as Record<string, unknown>[],
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

// ------------------------------------------------------------
// Repositories. asService just runs the callback (dbModule), and each
// repo function reads / records `h.state`, so the tests assert on what
// the webhook asked the database to do. The SQL behind each function
// (ON CONFLICT targets, account scoping, the RPCs) is covered against
// real Postgres in src/server/repos/inbound-*.int.test.ts.
// ------------------------------------------------------------
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())

vi.mock('@/server/repos/inbound-config', () => ({
  listVerifyTokenConfigs: vi.fn(async () => h.state.verifyTokenConfigs),
  setConfigVerifyToken: vi.fn(async () => undefined),
  listConfigsByPhoneNumberId: vi.fn(async (_db: unknown, phoneNumberId: string) => {
    h.state.configLookups.push(phoneNumberId)
    return h.state.configMissing
      ? []
      : [
          {
            account_id: 'acc-1',
            user_id: 'user-1',
            access_token: 'enc',
            mirror_inbound_media: h.state.mirrorInboundMedia,
          },
        ]
  }),
}))

vi.mock('@/server/repos/inbound-messages', () => ({
  // findOrCreateContact
  findContactByWaUserId: vi.fn(async () => h.state.contactByWaUserId),
  updateContactIdentity: vi.fn(
    async (_db: unknown, _accountId: string, _id: string, patch: Record<string, unknown>) => {
      h.state.contactUpdates.push(patch)
      return null
    },
  ),
  insertInboundContact: vi.fn(async (_db: unknown, row: Record<string, unknown>) => {
    h.state.contactInserts.push(row)
    return { id: 'contact-new', ...row }
  }),
  // findOrCreateConversation
  findOldestConversation: vi.fn(async () => h.state.conversation),
  insertInboundConversation: vi.fn(async () => null),
  // the inbound message itself
  findMessageIdByMetaId: vi.fn(async () => h.state.replyContextParent?.id ?? null),
  countCustomerMessages: vi.fn(async () => h.state.priorCustomerMsgCount),
  insertInboundMessage: vi.fn(async (_db: unknown, row: Record<string, unknown>) => {
    h.state.messageInserts.push(row)
    // A genuine insert returns the new id; a replayed delivery hits the
    // (conversation_id, message_id) unique index and returns null.
    return h.state.messageInsertedId
  }),
  bumpConversationOnInbound: vi.fn(
    async (_db: unknown, conversationId: string, lastMessageText: string) => {
      h.state.bumpCalls.push({ conversationId, lastMessageText })
    },
  ),
  reopenConversationIfClosed: vi.fn(async () => true),
  markLatestBroadcastReplied: vi.fn(async () => null),
  deleteCustomerReaction: vi.fn(async () => undefined),
  upsertCustomerReaction: vi.fn(async () => undefined),
}))

vi.mock('@/server/repos/inbound-statuses', () => ({
  updateMessageStatusByWamid: vi.fn(
    async (_db: unknown, accountId: string, _wamid: string, patch: Record<string, unknown>) => {
      h.state.messageStatusScopes.push(accountId)
      h.state.messageUpdates.push(patch)
      return h.state.statusConversationId
    },
  ),
  findBroadcastRecipientByWamid: vi.fn(async () => h.state.broadcastRecipient),
  updateBroadcastRecipient: vi.fn(
    async (_db: unknown, _id: string, patch: Record<string, unknown>) => {
      h.state.recipientUpdates.push(patch)
    },
  ),
}))

// Service-role Storage, used by the inbound-media mirror (#466).
vi.mock('@/lib/storage/server', () => ({
  adminStorage: () => ({
    from(bucket: string) {
      return {
        upload: (
          path: string,
          _body: unknown,
          options: { contentType?: string },
        ) => {
          h.state.storageUploads.push({ bucket, path, options })
          return Promise.resolve({ error: h.state.storageUploadError })
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
        }),
      }
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })),
}))

vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: (field: string) =>
    field.startsWith('message_template_'),
  handleTemplateWebhookChange: vi.fn(),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
  resumeAwaitingReply: h.resumeAwaitingReply,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))

import { GET, POST } from './route'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { handleTemplateWebhookChange } from '@/lib/whatsapp/template-webhook'
import {
  bumpConversationOnInbound,
  findOldestConversation,
  insertInboundConversation,
  insertInboundMessage,
  markLatestBroadcastReplied,
  reopenConversationIfClosed,
} from '@/server/repos/inbound-messages'
import { setConfigVerifyToken } from '@/server/repos/inbound-config'

const mockGetMediaUrl = vi.mocked(getMediaUrl)
const mockDownloadMedia = vi.mocked(downloadMedia)
const mockFindExistingContact = vi.mocked(findExistingContact)

const TEXT_MESSAGE = {
  id: 'wamid.TEST1',
  from: '15551230000',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hello' },
}

const LEGACY_CONTACTS = [{ wa_id: '15551230000', profile: { name: 'Ada' } }]

function inboundRequest(
  message: Record<string, unknown> = TEXT_MESSAGE,
  contacts: Record<string, unknown>[] = LEGACY_CONTACTS,
) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts,
              messages: [message],
            },
          },
        ],
      },
    ],
  }
  return {
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request
}

async function runWebhook(
  message?: Record<string, unknown>,
  contacts?: Record<string, unknown>[],
) {
  const res = await POST(inboundRequest(message, contacts))
  // Drain the after() callback exactly as the runtime would.
  for (const cb of h.state.afterCallbacks) await cb()
  return res
}

/** A message-status webhook (sent / delivered / read / failed). */
async function runStatusWebhook(status: Record<string, unknown>) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              statuses: [status],
            },
          },
        ],
      },
    ],
  }
  const res = await POST({
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request)
  for (const cb of h.state.afterCallbacks) await cb()
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.messageInsertedId = 'msg-1'
  h.state.priorCustomerMsgCount = 0
  h.state.replyContextParent = null
  h.state.conversation = { id: 'conv-1', unread_count: 0, account_id: 'acc-1', status: 'open' }
  h.state.messageInserts = []
  h.state.bumpCalls = []
  h.state.configLookups = []
  h.state.configMissing = false
  h.state.verifyTokenConfigs = []
  h.state.afterCallbacks = []
  h.state.automationStarted = 0
  h.state.automationCompleted = 0
  h.state.mirrorInboundMedia = true
  h.state.storageUploads = []
  h.state.storageUploadError = null
  h.state.contactByWaUserId = null
  h.state.contactInserts = []
  h.state.contactUpdates = []
  h.state.messageUpdates = []
  h.state.messageStatusScopes = []
  h.state.statusConversationId = null
  h.state.broadcastRecipient = null
  h.state.recipientUpdates = []
  mockFindExistingContact.mockResolvedValue({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })
  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  })
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(2048),
    contentType: 'image/jpeg',
  })
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.resumeAwaitingReply.mockResolvedValue(false)
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockImplementation(() => {
    h.state.automationStarted++
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        h.state.automationCompleted++
        resolve()
      }, 0)
    })
  })
})

describe('inbound webhook: idempotent insert (#367)', () => {
  it('a genuine first delivery persists once and fans out downstream', async () => {
    await runWebhook()

    // Inserted through the idempotent repo insert (ON CONFLICT
    // (conversation_id, message_id) DO NOTHING — see
    // inbound-messages.int.test.ts), keyed on Meta's wamid.
    expect(h.state.messageInserts).toHaveLength(1)
    expect(h.state.messageInserts[0]).toMatchObject({
      conversation_id: 'conv-1',
      message_id: 'wamid.TEST1',
      sender_type: 'customer',
    })
    // Downstream side effects ran exactly once.
    expect(h.state.bumpCalls).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('a replayed delivery is a no-op: no unread bump, no fan-out', async () => {
    // The insert hits the unique index and returns no row.
    h.state.messageInsertedId = null

    await runWebhook()

    expect(h.state.messageInserts).toHaveLength(1)
    // None of the downstream side effects fire on a replay.
    expect(h.state.bumpCalls).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('a failed insert drops the message without any fan-out', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(insertInboundMessage).mockRejectedValueOnce(new Error('check constraint'))
    try {
      await runWebhook()
    } finally {
      err.mockRestore()
    }

    expect(h.state.bumpCalls).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })
})

describe('inbound webhook: atomic unread bump (#369)', () => {
  it('increments unread through the DB-side RPC, not a read-modify-write', async () => {
    await runWebhook()

    expect(h.state.bumpCalls).toEqual([
      { conversationId: 'conv-1', lastMessageText: 'hello' },
    ])
  })

  it('a failed bump does not stop downstream processing (message already committed)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(bumpConversationOnInbound).mockRejectedValueOnce(new Error('boom'))
    try {
      await runWebhook()
    } finally {
      err.mockRestore()
    }

    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
  })
})

describe('inbound webhook: account scoping', () => {
  it('resolves the account from the delivery phone_number_id', async () => {
    await runWebhook()

    expect(h.state.configLookups).toEqual(['pn-1'])
    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc-1', userId: 'user-1' }),
    )
  })

  it('drops a delivery for a phone number no config owns', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.state.configMissing = true
    try {
      const res = await runWebhook()
      expect(
        (res as unknown as { init?: { status?: number } }).init?.status,
      ).toBe(200)
    } finally {
      err.mockRestore()
    }

    expect(h.state.messageInserts).toHaveLength(0)
    expect(h.state.contactInserts).toHaveLength(0)
  })
})

describe('inbound webhook: closed conversations re-open (#409)', () => {
  it('re-opens a closed thread when the customer writes again', async () => {
    h.state.conversation = { ...h.state.conversation, status: 'closed' }

    await runWebhook()

    expect(reopenConversationIfClosed).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      'conv-1',
    )
  })

  it('leaves an open thread alone', async () => {
    await runWebhook()
    expect(reopenConversationIfClosed).not.toHaveBeenCalled()
  })
})

describe('inbound webhook: downstream dispatch order', () => {
  it('opens the conversation, then flows, waiting automations, triggers, AI, message.received', async () => {
    const order: string[] = []
    vi.mocked(insertInboundConversation).mockImplementationOnce(async () => ({
      ...h.state.conversation,
    }) as never)
    vi.mocked(findOldestConversation).mockResolvedValueOnce(null)
    h.dispatchWebhookEvent.mockImplementation(async (_acc: string, event: string) => {
      order.push(event)
    })
    h.dispatchInboundToFlows.mockImplementation(async () => {
      order.push('flows')
      return { consumed: false }
    })
    h.resumeAwaitingReply.mockImplementation(async () => {
      order.push('resume')
      return false
    })
    h.runAutomationsForTrigger.mockImplementation(async (a: { triggerType: string }) => {
      order.push(`trigger:${a.triggerType}`)
    })
    h.dispatchInboundToAiReply.mockImplementation(async () => {
      order.push('ai')
    })

    await runWebhook()

    expect(order).toEqual([
      'conversation.created',
      'flows',
      'resume',
      'trigger:first_inbound_message',
      'trigger:new_message_received',
      'trigger:keyword_match',
      'ai',
      'message.received',
    ])
    // flagBroadcastReplyIfAny ran for the account's contact.
    expect(markLatestBroadcastReplied).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      'contact-1',
    )
  })
})

describe('inbound webhook: template quick-reply buttons (#478)', () => {
  // A customer tapping a QUICK_REPLY button on a broadcast template.
  // `context.id` points at the template message we sent — which the
  // broadcast path never wrote to `messages`, so the parent lookup
  // legitimately misses and the reply is stored unquoted.
  const templateButtonTap = {
    id: 'wamid.BTN1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'button',
    button: { text: 'Yes, interested', payload: 'YES_INTERESTED' },
    context: { id: 'wamid.BROADCAST1' },
  }

  it('stores the tap as an interactive reply, not an unsupported message', async () => {
    await runWebhook(templateButtonTap)

    expect(h.state.messageInserts).toHaveLength(1)
    expect(h.state.messageInserts[0]).toMatchObject({
      content_type: 'interactive',
      content_text: 'Yes, interested',
      interactive_reply_id: 'YES_INTERESTED',
      reply_to_message_id: null,
    })
  })

  it('routes the tap to flows and fires the interactive_reply trigger', async () => {
    await runWebhook(templateButtonTap)

    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          kind: 'interactive_reply',
          reply_id: 'YES_INTERESTED',
          reply_title: 'Yes, interested',
          meta_message_id: 'wamid.BTN1',
        },
      }),
    )
    const triggers = h.runAutomationsForTrigger.mock.calls.map(
      (call) => (call[0] as { triggerType: string }).triggerType,
    )
    expect(triggers).toContain('interactive_reply')
    // The AI auto-reply must stay out of it — a button tap is not a
    // free-text question.
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('falls back to the label when the template button carries no payload', async () => {
    await runWebhook({
      ...templateButtonTap,
      button: { text: 'Track my order' },
    })

    expect(h.state.messageInserts[0]).toMatchObject({
      content_type: 'interactive',
      content_text: 'Track my order',
      interactive_reply_id: 'Track my order',
    })
  })
})

describe('inbound webhook: inbound media is mirrored (#466)', () => {
  const IMAGE_MESSAGE = {
    id: 'wamid.IMG1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'image',
    image: { id: '1234567890123456', mime_type: 'image/jpeg', caption: 'hi' },
  }

  it('stores a durable bucket URL instead of the expiring proxy path', async () => {
    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
    expect(h.state.storageUploads[0].bucket).toBe('chat-media')
    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
    )
    expect(h.state.messageInserts[0]).toMatchObject({
      media_url:
        'https://cdn.test/chat-media/account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
      // Meta's MIME type used to be discarded outright (`void mediaType`).
      media_type: 'image/jpeg',
    })
  })

  it('falls back to the proxy URL when the upload is refused', async () => {
    h.state.storageUploadError = { message: 'mime type not supported' }

    await runWebhook(IMAGE_MESSAGE)

    // The message still lands, and it still lands with a usable URL —
    // the mirror failing must never cost us the message.
    expect(h.state.messageInserts).toHaveLength(1)
    expect(h.state.messageInserts[0]).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      media_type: 'image/jpeg',
    })
  })

  it('falls back to the proxy URL when the download from Meta throws', async () => {
    mockDownloadMedia.mockRejectedValueOnce(new Error('Media download failed: 404'))

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.messageInserts[0]).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
    })
  })

  it('skips media larger than the bucket accepts, without downloading it', async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/big',
      mimeType: 'application/pdf',
      fileSize: 40 * 1024 * 1024,
    })

    await runWebhook({
      id: 'wamid.DOC1',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '999',
        mime_type: 'application/pdf',
        filename: 'huge.pdf',
      },
    })

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.messageInserts[0]).toMatchObject({
      media_url: '/api/whatsapp/media/999',
      media_type: 'application/pdf',
    })
  })

  it("names the object after a document's own filename", async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/doc',
      mimeType: 'application/pdf',
      fileSize: 4096,
    })
    mockDownloadMedia.mockResolvedValue({
      buffer: Buffer.alloc(4096),
      contentType: 'application/pdf',
    })

    await runWebhook({
      id: 'wamid.DOC2',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '1234567890123456',
        mime_type: 'application/pdf',
        filename: 'invoice.pdf',
        caption: 'have a look',
      },
    })

    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-invoice.pdf',
    )
  })

  it('does not mirror when the account has opted out', async () => {
    h.state.mirrorInboundMedia = false

    await runWebhook(IMAGE_MESSAGE)

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.messageInserts[0]).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      // Still recorded — the MIME type costs nothing and makes the
      // download name right even for proxied media.
      media_type: 'image/jpeg',
    })
  })

  it('mirrors when the column is absent, e.g. a row read before migration 039', async () => {
    h.state.mirrorInboundMedia = undefined

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
  })

  it('leaves text messages alone', async () => {
    await runWebhook()

    expect(mockGetMediaUrl).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.messageInserts[0]).toMatchObject({ media_type: null })
  })
})

describe('inbound webhook: after() awaits automations (#368)', () => {
  it('every triggered automation settles before the after() callback resolves', async () => {
    await runWebhook()

    // first_inbound_message + new_message_received + keyword_match.
    expect(h.state.automationStarted).toBe(3)
    // If the dispatches were fire-and-forget, completed would still be 0
    // here — the callback would have resolved before the timers fired.
    expect(h.state.automationCompleted).toBe(3)
  })
})

// ============================================================
// Business-scoped user IDs (issue #519)
//
// Meta stopped sending the phone number for a customer who has adopted
// a WhatsApp username: `messages[].from` and `contacts[].wa_id` are
// both absent, and only `from_user_id` / `user_id` identify them.
//
// Before the fix, `normalizePhone(undefined)` gave '', which
// `findExistingContact` refuses to look up, so every such delivery
// inserted a NEW contact — and migration 022's unique index is partial
// (`WHERE phone_normalized <> ''`) so nothing stopped it. One contact
// and one conversation per inbound message.
// ============================================================

const USERNAME_ONLY_MESSAGE = {
  id: 'wamid.BSUID1',
  from_user_id: 'US.13491208655302741918',
  from_parent_user_id: 'US.ENT.11815799212886844830',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'does it come in another color?' },
}

const USERNAME_ONLY_CONTACTS = [
  {
    profile: { name: 'Sheena Nelson', username: 'realsheenanelson' },
    user_id: 'US.13491208655302741918',
    parent_user_id: 'US.ENT.11815799212886844830',
  },
]

describe('inbound webhook: business-scoped user IDs (#519)', () => {
  it('creates ONE contact keyed on the BSUID when Meta sends no phone', async () => {
    // Nothing on file under either key yet.
    h.state.contactByWaUserId = null
    mockFindExistingContact.mockResolvedValue(null)

    await runWebhook(USERNAME_ONLY_MESSAGE, USERNAME_ONLY_CONTACTS)

    expect(h.state.contactInserts).toHaveLength(1)
    expect(h.state.contactInserts[0]).toMatchObject({
      account_id: 'acc-1',
      phone: '',
      wa_user_id: 'US.13491208655302741918',
      wa_parent_user_id: 'US.ENT.11815799212886844830',
      wa_username: 'realsheenanelson',
      name: 'Sheena Nelson',
    })
    // The message still lands in the thread.
    expect(h.state.messageInserts).toHaveLength(1)
  })

  it('never looks the sender up by phone when there is no phone', async () => {
    h.state.contactByWaUserId = null
    mockFindExistingContact.mockResolvedValue(null)

    await runWebhook(USERNAME_ONLY_MESSAGE, USERNAME_ONLY_CONTACTS)

    // The old code called this with '' and got null every time, which
    // is exactly how the duplicate contacts got created.
    expect(mockFindExistingContact).not.toHaveBeenCalled()
  })

  it('reuses the existing contact on the SECOND message from the same BSUID', async () => {
    // The row the first message created.
    h.state.contactByWaUserId = {
      id: 'contact-bsuid',
      name: 'Sheena Nelson',
      phone: '',
      wa_user_id: 'US.13491208655302741918',
      wa_parent_user_id: 'US.ENT.11815799212886844830',
      wa_username: 'realsheenanelson',
    }
    mockFindExistingContact.mockResolvedValue(null)

    await runWebhook(
      { ...USERNAME_ONLY_MESSAGE, id: 'wamid.BSUID2' },
      USERNAME_ONLY_CONTACTS,
    )

    expect(h.state.contactInserts).toHaveLength(0)
    // Nothing about the identity changed, so no pointless UPDATE either.
    expect(h.state.contactUpdates).toHaveLength(0)
  })

  it('backfills the BSUID onto a contact we already knew by phone', async () => {
    // Transition payload: Meta sends both keys. We match on the phone
    // and stamp the BSUID so the next phone-less message still finds
    // this row instead of forking a new one.
    mockFindExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: 'Pablo',
      phone: '16505551234',
    })

    await runWebhook(
      {
        id: 'wamid.BOTH',
        from: '16505551234',
        from_user_id: 'US.13491208655302741918',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'hi' },
      },
      [
        {
          profile: { name: 'Pablo', username: 'pablomorales' },
          wa_id: '16505551234',
          user_id: 'US.13491208655302741918',
        },
      ],
    )

    expect(h.state.contactInserts).toHaveLength(0)
    expect(h.state.contactUpdates).toHaveLength(1)
    expect(h.state.contactUpdates[0]).toMatchObject({
      wa_user_id: 'US.13491208655302741918',
      wa_username: 'pablomorales',
    })
    // The number we already had is left alone.
    expect(h.state.contactUpdates[0]).not.toHaveProperty('phone')
  })

  it('fills in the phone once Meta finally discloses it', async () => {
    h.state.contactByWaUserId = {
      id: 'contact-bsuid',
      name: 'Sheena Nelson',
      phone: '',
      wa_user_id: 'US.13491208655302741918',
      wa_username: 'realsheenanelson',
    }

    await runWebhook(
      {
        ...USERNAME_ONLY_MESSAGE,
        id: 'wamid.BSUID3',
        from: '16505551234',
      },
      USERNAME_ONLY_CONTACTS,
    )

    expect(h.state.contactUpdates).toHaveLength(1)
    expect(h.state.contactUpdates[0]).toMatchObject({ phone: '16505551234' })
  })

  it('drops a delivery that carries neither key rather than inventing a contact', async () => {
    mockFindExistingContact.mockResolvedValue(null)

    const res = await runWebhook(
      {
        id: 'wamid.ANON',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'who am i' },
      },
      [{ profile: { name: 'Nobody' } }],
    )

    expect(h.state.contactInserts).toHaveLength(0)
    expect(h.state.messageInserts).toHaveLength(0)
    // Still a 200 — Meta must not be told to retry a payload we can
    // never process.
    expect(
      (res as unknown as { init?: { status?: number } }).init?.status,
    ).toBe(200)
  })

  it('leaves the legacy phone-only payload behaving exactly as before', async () => {
    await runWebhook()

    expect(mockFindExistingContact).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      '15551230000',
    )
    expect(h.state.contactInserts).toHaveLength(0)
    expect(h.state.contactUpdates).toHaveLength(0)
    expect(h.state.messageInserts).toHaveLength(1)
  })
})

describe('inbound webhook: contact name backfill (#519 regression guard)', () => {
  it('never overwrites an edited name with the phone number', async () => {
    // Meta sends no profile name. The display fallback would resolve to
    // the phone number, and writing that back would replace whatever an
    // agent typed on the contact — on every single inbound message.
    mockFindExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: 'Ada (VIP, calls Mondays)',
      phone: '15551230000',
    })

    await runWebhook(TEXT_MESSAGE, [{ wa_id: '15551230000', profile: {} }])

    expect(h.state.contactUpdates).toHaveLength(0)
  })

  it('does adopt a username when that is all Meta gives us', async () => {
    mockFindExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: '15551230000',
      phone: '15551230000',
    })

    await runWebhook(TEXT_MESSAGE, [
      { wa_id: '15551230000', profile: { username: 'ada' } },
    ])

    expect(h.state.contactUpdates[0]).toMatchObject({ name: 'ada' })
  })
})

describe('template-lifecycle webhooks: WABA id is threaded to the handler (#534)', () => {
  it('passes entry.id as wabaId so an unknown template can be stubbed for the right account', async () => {
    const value = {
      event: 'APPROVED',
      message_template_id: '4242',
      message_template_name: 'created_in_meta',
      message_template_language: 'en_US',
    }
    const body = {
      entry: [
        {
          id: 'WABA-1',
          changes: [{ field: 'message_template_status_update', value }],
        },
      ],
    }
    const req = {
      text: async () => JSON.stringify(body),
      headers: { get: () => 'sha256=stub' },
    } as unknown as Request

    await POST(req)
    for (const cb of h.state.afterCallbacks) await cb()

    const mockHandle = vi.mocked(handleTemplateWebhookChange)
    expect(mockHandle).toHaveBeenCalledTimes(1)
    expect(mockHandle.mock.calls[0][0]).toEqual({
      field: 'message_template_status_update',
      value,
      wabaId: 'WABA-1',
    })
    // A template event must not fall through to the messaging branch.
    expect(h.state.messageInserts).toHaveLength(0)
  })
})

describe('status webhook: failed statuses keep Meta\'s reason (#535)', () => {
  const FAILED_STATUS = {
    id: 'wamid.OUT1',
    status: 'failed',
    timestamp: '1700000100',
    recipient_id: '15551230000',
    errors: [
      {
        code: 131049,
        title: 'This message was not delivered to maintain healthy ecosystem engagement.',
        message: 'This message was not delivered to maintain healthy ecosystem engagement.',
        error_data: {
          details:
            'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
        },
        href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
      },
    ],
  }

  it('persists code, title and details on the messages row in the same update as status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runStatusWebhook(FAILED_STATUS)
    } finally {
      warn.mockRestore()
    }

    expect(h.state.messageUpdates).toHaveLength(1)
    expect(h.state.messageUpdates[0]).toEqual({
      status: 'failed',
      error_code: 131049,
      error_title: FAILED_STATUS.errors[0].title,
      error_details: FAILED_STATUS.errors[0].error_data.details,
    })
  })

  it('logs one warning line carrying the wamid, code and title', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runStatusWebhook(FAILED_STATUS)
      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0][0])
      expect(line).toContain('wamid.OUT1')
      expect(line).toContain('131049')
      expect(line).toContain(FAILED_STATUS.errors[0].title)
      expect(line).toContain(FAILED_STATUS.errors[0].error_data.details)
    } finally {
      warn.mockRestore()
    }
  })

  it('folds the reason into broadcast_recipients.error_message', async () => {
    h.state.broadcastRecipient = { id: 'rec-1', status: 'sent' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runStatusWebhook(FAILED_STATUS)
    } finally {
      warn.mockRestore()
    }

    expect(h.state.recipientUpdates).toHaveLength(1)
    expect(h.state.recipientUpdates[0].status).toBe('failed')
    const reason = String(h.state.recipientUpdates[0].error_message)
    expect(reason).toContain('131049')
    expect(reason).toContain(FAILED_STATUS.errors[0].title)
    expect(reason).toContain(FAILED_STATUS.errors[0].error_data.details)
  })

  it('a failed status with no errors array still flips status and stores no reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runStatusWebhook({ ...FAILED_STATUS, errors: undefined })
    } finally {
      warn.mockRestore()
    }
    expect(warn).not.toHaveBeenCalled()
    expect(h.state.messageUpdates).toEqual([{ status: 'failed' }])
  })

  it('a plain delivered status updates only status — error columns untouched', async () => {
    h.state.broadcastRecipient = { id: 'rec-1', status: 'sent' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runStatusWebhook({
        id: 'wamid.OUT1',
        status: 'delivered',
        timestamp: '1700000100',
        recipient_id: '15551230000',
      })
    } finally {
      warn.mockRestore()
    }

    expect(warn).not.toHaveBeenCalled()
    expect(h.state.messageUpdates).toEqual([{ status: 'delivered' }])
    expect(h.state.recipientUpdates).toHaveLength(1)
    expect(h.state.recipientUpdates[0]).not.toHaveProperty('error_message')
    expect(h.state.recipientUpdates[0]).not.toHaveProperty('error_code')
  })
})

describe('inbound webhook: automation waiting for a reply', () => {
  const triggersFired = () =>
    h.runAutomationsForTrigger.mock.calls.map(
      (call) => (call[0] as { triggerType: string }).triggerType,
    )

  it('offers the message to a waiting automation before any trigger fires', async () => {
    await runWebhook()

    expect(h.resumeAwaitingReply).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ message_text: 'hello' }),
      }),
    )
    // Nothing was waiting, so the content triggers fire as normal.
    expect(triggersFired()).toEqual(
      expect.arrayContaining(['new_message_received', 'keyword_match']),
    )
  })

  it('suppresses content triggers and AI reply when a waiting automation took it', async () => {
    h.resumeAwaitingReply.mockResolvedValue(true)

    await runWebhook()

    expect(triggersFired()).not.toContain('new_message_received')
    expect(triggersFired()).not.toContain('keyword_match')
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('leaves the message to a flow that consumed it', async () => {
    h.dispatchInboundToFlows.mockResolvedValue({ consumed: true })

    await runWebhook()

    expect(h.resumeAwaitingReply).not.toHaveBeenCalled()
  })
})

describe('status webhook: ladder + account scoping', () => {
  const status = (s: string) => ({
    id: 'wamid.OUT2',
    status: s,
    timestamp: '1700000200',
    recipient_id: '15551230000',
  })

  it('scopes the messages mirror to the phone number owner', async () => {
    await runStatusWebhook(status('read'))

    expect(h.state.configLookups).toEqual(['pn-1'])
    expect(h.state.messageStatusScopes).toEqual(['acc-1'])
  })

  it('moves a recipient forward and stamps the matching timestamp', async () => {
    h.state.broadcastRecipient = { id: 'rec-1', status: 'delivered' }

    await runStatusWebhook(status('read'))

    expect(h.state.recipientUpdates).toEqual([
      { status: 'read', read_at: new Date(1700000200 * 1000).toISOString() },
    ])
  })

  it('never regresses a recipient down the ladder on a replayed status', async () => {
    h.state.broadcastRecipient = { id: 'rec-1', status: 'read' }

    await runStatusWebhook(status('delivered'))

    expect(h.state.recipientUpdates).toHaveLength(0)
  })

  it('refuses `failed` once the recipient was delivered', async () => {
    h.state.broadcastRecipient = { id: 'rec-1', status: 'delivered' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runStatusWebhook(status('failed'))
    } finally {
      warn.mockRestore()
    }

    expect(h.state.recipientUpdates).toHaveLength(0)
  })

  it('fans out message.status_updated only when one of our messages matched', async () => {
    await runStatusWebhook(status('delivered'))
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()

    h.state.afterCallbacks = []
    h.state.statusConversationId = 'conv-9'
    await runStatusWebhook(status('delivered'))
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      'acc-1',
      'message.status_updated',
      {
        whatsapp_message_id: 'wamid.OUT2',
        conversation_id: 'conv-9',
        status: 'delivered',
      },
    )
  })

  it('ignores statuses for a phone number no config owns', async () => {
    h.state.configMissing = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await runStatusWebhook(status('delivered'))
    } finally {
      err.mockRestore()
    }

    expect(h.state.messageUpdates).toHaveLength(0)
  })
})

describe('GET: verify-token handshake', () => {
  const verifyRequest = (token: string) =>
    new Request(
      `https://crm.test/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=CH-42&hub.verify_token=${token}`,
    )

  it('echoes the challenge when a config token decrypts to the given value', async () => {
    // The encryption mock decrypts everything to 'plain-token'.
    h.state.verifyTokenConfigs = [{ id: 'cfg-1', verify_token: 'enc' }]

    const res = (await GET(verifyRequest('plain-token'))) as Response

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('CH-42')
    // Not a legacy-format token, so no re-encrypt write.
    expect(setConfigVerifyToken).not.toHaveBeenCalled()
  })

  it('rejects a token no config holds', async () => {
    h.state.verifyTokenConfigs = [{ id: 'cfg-1', verify_token: 'enc' }]

    const res = (await GET(verifyRequest('wrong'))) as unknown as {
      init?: { status?: number }
    }

    expect(res.init?.status).toBe(403)
  })
})
