import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'

import messages from '@app-messages'
import type { Deal, PipelineStage } from '@/types'

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ defaultCurrency: 'USD' }),
}))

import { PipelineBoard } from './pipeline-board'

const stage = {
  id: 'stage-1',
  pipeline_id: 'p-1',
  name: 'Only',
  color: '#3b82f6',
  position: 0,
} as PipelineStage

const deal = {
  id: 'deal-1',
  title: 'Big deal',
  value: 100,
  currency: 'USD',
  stage_id: 'stage-1',
  pipeline_id: 'p-1',
  contact_id: null,
  status: 'open',
} as unknown as Deal

function render(canEditDeals?: boolean) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <PipelineBoard
        stages={[stage]}
        deals={[deal]}
        onDealMoved={() => {}}
        onAddDeal={() => {}}
        onEditDeal={() => {}}
        canEditDeals={canEditDeals}
      />
    </NextIntlClientProvider>,
  )
}

function addDealButton(html: string): string {
  const m = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Add Deal<\/button>/)
  expect(m).not.toBeNull()
  return m![0]
}

describe('PipelineBoard role gating', () => {
  it('enables the column "Add Deal" and dragging by default', () => {
    const html = render()
    expect(addDealButton(html)).not.toMatch(/\sdisabled=""/)
    expect(html).not.toContain('Read-only')
    expect(html).toMatch(/aria-roledescription="draggable"[^>]*aria-disabled="false"|aria-disabled="false"[^>]*aria-roledescription="draggable"/)
  })

  it('disables the column "Add Deal" (with a read-only tooltip) and dragging for viewers', () => {
    const html = render(false)
    expect(addDealButton(html)).toMatch(/\sdisabled=""/)
    expect(html).toContain('title="Read-only — your role can&#x27;t create deals"')
    expect(html).toMatch(/aria-roledescription="draggable"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*aria-roledescription="draggable"/)
  })
})
