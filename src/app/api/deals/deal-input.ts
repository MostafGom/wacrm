// Body validation shared by the deal routes. Mutations validate by
// hand (no zod); any malformed field is a 400.

import { HttpError } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { isUuid, optionalString, requiredString } from '@/server/http'
import type { DealFields, DealStatus } from '@/server/repos/deals'

const t = getT('Api.common')

const STATUSES: readonly DealStatus[] = ['open', 'won', 'lost']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function bad(): never {
  throw new HttpError(400, t('invalidRequestBody'))
}

function optionalUuid(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (!isUuid(value)) bad()
  return value
}

/** The writable deal fields present in `body` (absent keys stay absent). */
export function parseDealFields(body: Record<string, unknown>): DealFields {
  const out: DealFields = {}
  if (body.title !== undefined) out.title = requiredString(body.title, undefined, 500)
  if (body.value !== undefined) {
    if (typeof body.value !== 'number' || !Number.isFinite(body.value)) bad()
    out.value = body.value
  }
  const currency = optionalString(body.currency, 10)
  if (currency !== undefined) out.currency = currency
  const contactId = optionalUuid(body.contact_id)
  if (contactId !== undefined) out.contact_id = contactId
  const assignedTo = optionalUuid(body.assigned_to)
  if (assignedTo !== undefined) out.assigned_to = assignedTo
  if (body.pipeline_id !== undefined) {
    if (!isUuid(body.pipeline_id)) bad()
    out.pipeline_id = body.pipeline_id
  }
  if (body.stage_id !== undefined) {
    if (!isUuid(body.stage_id)) bad()
    out.stage_id = body.stage_id
  }
  const notes = optionalString(body.notes, 20_000)
  if (notes !== undefined) out.notes = notes
  if (body.expected_close_date !== undefined) {
    const d = body.expected_close_date
    if (d === null || d === '') out.expected_close_date = null
    else if (typeof d === 'string' && DATE_RE.test(d)) out.expected_close_date = d
    else bad()
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as DealStatus)) bad()
    out.status = body.status as DealStatus
  }
  return out
}
