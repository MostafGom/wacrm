import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts } from '@/lib/ai/embeddings'
import { AiError, type AiProvider } from '@/lib/ai/types'
import { normalizeOpenAiCompatibleBaseUrl } from '@/lib/ai/providers/openai-compatible'
import { getT } from '@/lib/i18n/translate'
import { asUser } from '@/server/db'
import { isUuid } from '@/server/http'
import {
  deleteAiConfig,
  getAiConfigCredentials,
  getAiConfigSummary,
  insertAiConfig,
  isAccountMember,
  updateAiConfig,
  type AiConfigWrite,
} from '@/server/repos/ai-config'

const t = getT('Api')

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/ai/config
 *
 * Any member may read the config so the inbox/settings can reflect
 * whether AI is set up. The encrypted key is NEVER returned — only a
 * `has_key` flag; the settings form shows a masked placeholder.
 */
export async function GET() {
  try {
    const { userId, accountId } = await getCurrentAccount()

    // The summary carries has_* flags derived in SQL — the encrypted
    // keys themselves are never selected for this response.
    let data: Awaited<ReturnType<typeof getAiConfigSummary>>
    try {
      data = await asUser(userId, (db) => getAiConfigSummary(db, accountId))
    } catch (error) {
      console.error('[ai/config GET] fetch error:', error)
      return NextResponse.json(
        { error: t('ai.loadConfigFailed') },
        { status: 500 },
      )
    }

    if (!data) return NextResponse.json({ configured: false })
    const { has_key, has_embeddings_key, ...safe } = data
    return NextResponse.json({
      configured: true,
      has_key,
      has_embeddings_key,
      ...safe,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/config  (admin+)
 *
 * Upsert the account's AI config. Validates the key with the provider
 * before persisting (mirrors the WhatsApp config verifying with Meta
 * first), then stores the key AES-256-GCM-encrypted. When `api_key` is
 * omitted the existing stored key is reused (the form sends it only
 * when the user re-enters it).
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad(t('common.invalidRequestBody'))

    const provider = body.provider as AiProvider
    if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'openai_compatible') {
      return bad(t('ai.providerInvalid'))
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return bad(t('ai.modelRequired'))

    const baseUrlProvided = 'base_url' in body
    const requestedBaseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : ''

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null
    const isActive = body.is_active === true
    const autoReplyEnabled = body.auto_reply_enabled === true

    let maxPer = Number(body.auto_reply_max_per_conversation)
    if (!Number.isFinite(maxPer)) maxPer = 3
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)))

    // Handoff routing target for auto-reply. A non-empty string must be a
    // member of this account (else the conversation would be assigned to a
    // stranger); an empty string / null means "leave unassigned" (the
    // shared queue). Absent → left unchanged on update below.
    const rawHandoff =
      typeof body.handoff_agent_id === 'string' ? body.handoff_agent_id.trim() : ''
    const handoffProvided = 'handoff_agent_id' in body
    let handoffAgentId: string | null = null
    if (rawHandoff) {
      const member =
        isUuid(rawHandoff) &&
        (await asUser(userId, (db) =>
          isAccountMember(db, accountId, rawHandoff),
        ))
      if (!member) return bad(t('ai.handoffNotMember'))
      handoffAgentId = rawHandoff
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

    // Embeddings key (optional, for semantic KB search): a non-empty
    // string sets/replaces it; an explicit null clears it; absent leaves
    // it unchanged. The form only sends it when the admin edits it.
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string'
        ? body.embeddings_api_key.trim()
        : ''
    const clearEmbeddingsKey = body.embeddings_api_key === null

    // Reuse the stored key when the form didn't send a fresh one.
    const existing = await asUser(userId, (db) =>
      getAiConfigCredentials(db, accountId),
    )

    let apiKeyPlain: string
    let baseUrl: string | null = null
    if (provider === 'openai_compatible') {
      const candidate = baseUrlProvided
        ? requestedBaseUrl
        : existing?.provider === 'openai_compatible'
          ? (existing.base_url ?? '').trim()
          : ''
      if (!candidate) return bad(t('ai.baseUrlRequired'))
      try {
        normalizeOpenAiCompatibleBaseUrl(candidate)
      } catch (err) {
        return bad(err instanceof AiError ? err.message : t('ai.baseUrlInvalid'))
      }
      baseUrl = candidate
    }
    if (rawKey) {
      apiKeyPlain = rawKey
    } else if (existing?.api_key) {
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return bad(t('ai.storedKeyReenter'))
      }
    } else {
      return bad(t('ai.apiKeyRequired'))
    }

    // Only spend a provider round-trip when the credentials that affect
    // reachability actually changed. A save that just flips a toggle or
    // edits the system prompt on an existing, already-validated config
    // skips the call — no wasted token/latency on the account's key.
    const credentialsChanged =
      !existing ||
      rawKey !== '' ||
      provider !== existing.provider ||
      model !== existing.model ||
      baseUrl !== (existing.base_url ?? null)

    if (credentialsChanged) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          baseUrl,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          handoffAgentId: null,
          embeddingsApiKey: null,
        })
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] validation error:', err)
        return bad(t('ai.validateWithProviderFailed'))
      }
    }

    // Validate a new embeddings key before storing (a cheap 1-input
    // embed), same "verify before save" discipline as the chat key.
    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping'])
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: t('ai.embeddingsKeyError', { message: err.message }), code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] embeddings validation error:', err)
        return bad(t('ai.validateEmbeddingsFailed'))
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null
    const shared: AiConfigWrite = {
      provider,
      model,
      base_url: baseUrl,
      system_prompt: systemPrompt,
      is_active: isActive,
      auto_reply_enabled: autoReplyEnabled,
      auto_reply_max_per_conversation: maxPer,
    }
    // Only touch the handoff target when the form actually sent the field,
    // so a partial save (e.g. flipping a toggle) doesn't wipe it.
    if (handoffProvided) shared.handoff_agent_id = handoffAgentId
    if (rawEmbeddingsKey) {
      shared.embeddings_api_key = encrypt(rawEmbeddingsKey)
    } else if (clearEmbeddingsKey) {
      shared.embeddings_api_key = null
    }

    if (existing) {
      try {
        await asUser(userId, (db) =>
          updateAiConfig(
            db,
            accountId,
            encryptedKey ? { ...shared, api_key: encryptedKey } : shared,
          ),
        )
      } catch (upErr) {
        console.error('[ai/config POST] update error:', upErr)
        return NextResponse.json(
          { error: t('ai.saveConfigFailed') },
          { status: 500 },
        )
      }
    } else {
      try {
        await asUser(userId, (db) =>
          insertAiConfig(db, {
            account_id: accountId,
            created_by: userId,
            ...shared,
            api_key: encryptedKey!, // guaranteed non-null: rawKey required when no existing row
          }),
        )
      } catch (insErr) {
        console.error('[ai/config POST] insert error:', insErr)
        return NextResponse.json(
          { error: t('ai.saveConfigFailed') },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/config  (admin+)
 *
 * Removes the account's AI config (turns everything off and forgets the
 * key). Also used to recover from a corrupted encrypted key.
 */
export async function DELETE() {
  try {
    const { userId, accountId } = await requireRole('admin')
    try {
      await asUser(userId, (db) => deleteAiConfig(db, accountId))
    } catch (error) {
      console.error('[ai/config DELETE] error:', error)
      return NextResponse.json(
        { error: t('ai.deleteConfigFailed') },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
