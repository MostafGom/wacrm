// Body validation shared by the pipeline / stage routes.

import { HttpError } from '@/lib/auth/account'
import { getT } from '@/lib/i18n/translate'
import { isUuid, optionalString, requiredString } from '@/server/http'
import type { StageInput, StageUpsert } from '@/server/repos/pipelines'

const t = getT('Api.common')

export const MAX_STAGES = 50

function bad(): never {
  throw new HttpError(400, t('invalidRequestBody'))
}

export function parseStage(value: unknown): StageInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad()
  const v = value as Record<string, unknown>
  const position = v.position
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position > 10_000) bad()
  return {
    name: requiredString(v.name, undefined, 100),
    color: optionalString(v.color, 32) ?? '#3b82f6',
    position,
  }
}

export function parseStageList(value: unknown): StageInput[] {
  if (!Array.isArray(value) || value.length > MAX_STAGES) bad()
  return value.map(parseStage)
}

export function parseStageUpserts(value: unknown): StageUpsert[] {
  if (!Array.isArray(value) || value.length > MAX_STAGES) bad()
  const rows = value.map((v) => {
    const id = (v as Record<string, unknown> | null)?.id
    if (!isUuid(id)) bad()
    return { id, ...parseStage(v) }
  })
  if (new Set(rows.map((r) => r.id)).size !== rows.length) bad()
  return rows
}
