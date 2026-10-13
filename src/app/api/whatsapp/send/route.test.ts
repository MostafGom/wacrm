import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for the `contact_id` send path (issue #296): sending an approved
// template to a single contact from the Contact detail view. The route must
// find-or-create the contact's conversation server-side, then run the normal
// send + persistence path — no inbound message required to bootstrap a thread.
// ---------------------------------------------------------------------------

const CONTACT_ID = '22222222-2222-4222-8222-222222222222'
const CONV_NEW = '33333333-3333-4333-8333-333333333333'
const CONV_EXISTING = '44444444-4444-4444-8444-444444444444'

// Records of what the route wrote, so we can assert the right rows landed.
const h = vi.hoisted(() => ({
  conversationInserts: [] as Array<Record<string, unknown>>,
  messageInserts: [] as Array<Record<string, unknown>>,
  // Toggles for the per-test scenario.
  existingConversation: null as Record<string, unknown> | null,
  contactRow: null as Record<string, unknown> | null,
  // The caller's role, as `requireRole` reads it off the profile. Sending
  // requires 'agent'; 'viewer' must be refused before anything reaches Meta.
  callerRole: 'admin',
}))

const CONTACT = {
  id: CONTACT_ID,
  account_id: 'acct-1',
  phone: '+15551234567',
}

// requireRole runs for real: session + profile come from these mocks,
// with the role read from `callerRole` at call time.
vi.mock('@/lib/auth/server-session', async () =>
  (await import('@/test/auth-mocks')).sessionModule({ userId: 'user-1', accountId: 'acct-1', role: null }),
)
vi.mock('@/server/repos/profiles', async () =>
  (await import('@/test/auth-mocks')).profilesModule({
    userId: 'user-1',
    accountId: 'acct-1',
    get role() {
      return h.callerRole
    },
  }),
)
vi.mock('@/server/db', async () => (await import('@/test/auth-mocks')).dbModule())

vi.mock('@/server/repos/contacts', () => ({
  getContact: vi.fn(async () => h.contactRow ?? undefined),
  updateContact: vi.fn(async () => undefined),
}))

vi.mock('@/server/repos/conversations', () => ({
  conversationIdInAccount: vi.fn(async (_db: unknown, _a: string, id: string) =>
    h.existingConversation?.id === id ? id : undefined,
  ),
  // Find-or-create: reuse the existing row, otherwise "insert" one.
  findOrCreateConversationId: vi.fn(
    async (_db: unknown, accountId: string, contactId: string, userId: string) => {
      if (h.existingConversation) return h.existingConversation.id as string
      h.conversationInserts.push({ account_id: accountId, contact_id: contactId, user_id: userId })
      h.existingConversation = { id: CONV_NEW, contact_id: contactId }
      return CONV_NEW
    },
  ),
  // The shared send core re-loads the conversation (with its contact)
  // from just the id.
  getConversationForSend: vi.fn(async () =>
    h.existingConversation ? { ...h.existingConversation, contact: CONTACT } : undefined,
  ),
  touchConversationLastMessage: vi.fn(async () => undefined),
}))

vi.mock('@/server/repos/messages', () => ({
  getWhatsAppSendConfig: vi.fn(async () => ({
    id: 'cfg-1',
    phone_number_id: 'PNID-1',
    access_token: 'enc-token',
    user_id: 'user-1',
  })),
  getReplyParent: vi.fn(async () => undefined),
  updateWhatsAppAccessToken: vi.fn(async () => undefined),
  insertOutboundMessage: vi.fn(async (_db: unknown, values: Record<string, unknown>) => {
    h.messageInserts.push({ ...values, sender_type: 'agent' })
    return { id: 'msg-1' }
  }),
  pauseActiveFlowRunsForContact: vi.fn(async () => undefined),
}))

vi.mock('@/server/repos/templates', () => ({
  listTemplatesByName: vi.fn(async () => []),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
  isLegacyFormat: vi.fn(() => false),
}))

const { sendTemplateMessage } = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage,
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
}))

import { POST } from './route'

function postContactTemplate(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: CONTACT_ID,
        message_type: 'template',
        template_name: 'order_update',
        template_language: 'en_US',
        template_message_params: { body: ['Acme', '#1234'] },
        template_params: ['Acme', '#1234'],
        ...overrides,
      }),
    }),
  )
}

describe('POST /api/whatsapp/send — contact_id template path', () => {
  beforeEach(() => {
    h.conversationInserts.length = 0
    h.messageInserts.length = 0
    h.existingConversation = null
    h.contactRow = CONTACT
    h.callerRole = 'admin'
    sendTemplateMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a conversation for a contact with none, then sends the template', async () => {
    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.whatsapp_message_id).toBe('wamid-1')

    // A conversation was created for this contact.
    expect(h.conversationInserts).toHaveLength(1)
    expect(h.conversationInserts[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: CONTACT_ID,
    })

    // The template was sent to the contact's number.
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    const args = (sendTemplateMessage.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >
    // Meta wants the bare E.164 digits — sanitizePhoneForMeta strips the '+'.
    expect(args.to).toBe('15551234567')
    expect(args.templateName).toBe('order_update')

    // The outbound message was persisted under the new conversation.
    expect(h.messageInserts).toHaveLength(1)
    expect(h.messageInserts[0]).toMatchObject({
      conversation_id: CONV_NEW,
      content_type: 'template',
      template_name: 'order_update',
      sender_type: 'agent',
    })
  })

  it('reuses an existing conversation instead of creating a duplicate', async () => {
    h.existingConversation = {
      id: CONV_EXISTING,
      account_id: 'acct-1',
      contact_id: CONTACT_ID,
      contact: CONTACT,
    }

    const res = await postContactTemplate()
    expect(res.status).toBe(200)

    expect(h.conversationInserts).toHaveLength(0)
    expect(h.messageInserts[0]).toMatchObject({ conversation_id: CONV_EXISTING })
  })

  it('404s when the contact is not in the caller account', async () => {
    h.contactRow = null

    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contact not found/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('400s when neither conversation_id nor contact_id is provided', async () => {
    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_type: 'template', template_name: 'x' }),
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/whatsapp/send — role enforcement', () => {
  beforeEach(() => {
    h.conversationInserts.length = 0
    h.messageInserts.length = 0
    h.existingConversation = {
      id: CONV_EXISTING,
      account_id: 'acct-1',
      contact_id: CONTACT_ID,
      contact: CONTACT,
    }
    h.contactRow = CONTACT
    h.callerRole = 'admin'
    sendTemplateMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('refuses a viewer with 403 and never reaches Meta', async () => {
    // A viewer is read-only (`canSendMessages`). The route used to resolve
    // account_id straight off the profile with no role check: RLS blocked
    // the message INSERT, but the send core calls Meta first, so the
    // customer still received a real WhatsApp message that RLS could not
    // un-send. The gate has to come before any outbound call.
    h.callerRole = 'viewer'

    const res = await postContactTemplate()

    expect(res.status).toBe(403)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(h.messageInserts).toHaveLength(0)
  })

  it('allows an agent through', async () => {
    h.callerRole = 'agent'

    const res = await postContactTemplate()

    expect(res.status).toBe(200)
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })
})
