import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Db, Runner } from '@/server/db'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

const h = vi.hoisted(() => ({
  getAiConfigSecrets: vi.fn(),
  getEmbeddingsKeyCipher: vi.fn(),
}))
vi.mock('@/server/repos/ai-config', () => h)

import { loadAiConfig, loadEmbeddingsKey } from './config'

const run: Runner = (fn) => fn({} as Db)

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  base_url: null,
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  handoff_agent_id: null,
  embeddings_api_key: null,
}

beforeEach(() => {
  h.getAiConfigSecrets.mockResolvedValue(ROW)
})

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(run, 'acct')).toBeNull()
    expect(h.getAiConfigSecrets).toHaveBeenCalledWith({}, 'acct')
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(run, 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.baseUrl).toBeNull()
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    h.getAiConfigSecrets.mockResolvedValue(undefined)
    expect(
      await loadAiConfig(run, 'acct', { requireActive: false }),
    ).toBeNull()
  })
})

describe('loadEmbeddingsKey', () => {
  it('decrypts the stored key', async () => {
    h.getEmbeddingsKeyCipher.mockResolvedValue('enc-emb')
    expect(await loadEmbeddingsKey(run, 'acct')).toEqual({
      key: 'plain:enc-emb',
      corrupt: false,
    })
  })

  it('returns no key (not corrupt) when unset or the read fails', async () => {
    h.getEmbeddingsKeyCipher.mockResolvedValue(null)
    expect(await loadEmbeddingsKey(run, 'acct')).toEqual({ key: null, corrupt: false })
    h.getEmbeddingsKeyCipher.mockRejectedValue(new Error('db down'))
    expect(await loadEmbeddingsKey(run, 'acct')).toEqual({ key: null, corrupt: false })
  })
})
