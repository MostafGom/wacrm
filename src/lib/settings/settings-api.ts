// Browser calls for the Settings screens (profile, overview, WhatsApp
// config form). Each returns `{ data, error }` from apiRequest.

import { apiRequest } from '@/lib/http/client'

/** PATCH /api/profile — own display name + avatar URL (null removes it). */
export function updateProfile(values: { full_name: string; avatar_url: string | null }) {
  return apiRequest<{ ok: true }>('/api/profile', { method: 'PATCH', body: values })
}

export interface SettingsOverviewCounts {
  templates: number
  templates_pending: number
  tags: number
  custom_fields: number
  whatsapp_configured: boolean
}

export function fetchSettingsOverview() {
  return apiRequest<SettingsOverviewCounts>('/api/settings/overview')
}

/**
 * The saved WhatsApp config as the settings form sees it: the row
 * without its encrypted tokens, plus whether a verify token is stored.
 */
export interface WhatsAppConfigView {
  id: string
  account_id: string
  user_id: string
  phone_number_id: string
  waba_id: string | null
  status: string
  connected_at: string | null
  registered_at: string | null
  subscribed_apps_at: string | null
  last_registration_error: string | null
  mirror_inbound_media: boolean
  created_at: string | null
  updated_at: string | null
  has_verify_token: boolean
}

export function fetchWhatsAppConfigView() {
  return apiRequest<{ config: WhatsAppConfigView | null }>('/api/whatsapp/config/settings')
}

export function saveMirrorInboundMedia(value: boolean) {
  return apiRequest<{ ok: true }>('/api/whatsapp/config/settings', {
    method: 'PATCH',
    body: { mirror_inbound_media: value },
  })
}
