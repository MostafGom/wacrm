import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'

import messages from '@app-messages'
import type { MessageTemplate } from '@/types'

import { ResourcesContext, StepEditor, type BuilderStep } from './automation-builder'

const orderUpdate = {
  id: 'tpl-1',
  name: 'order_update',
  language: 'en_US',
  status: 'APPROVED',
  body_text: 'Hi {{1}}, your order {{2}} has shipped',
} as unknown as MessageTemplate

function render(step: Pick<BuilderStep, 'step_type' | 'step_config'>, templates: MessageTemplate[] = []) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <ResourcesContext.Provider
        value={{ tags: [], members: [], templates, customFields: [], pipelines: [], stages: [] }}
      >
        <StepEditor step={{ cid: 'c1', ...step }} onChange={() => {}} />
      </ResourcesContext.Provider>
    </NextIntlClientProvider>,
  )
}

const labels = (html: string) => [...html.matchAll(/<label[^>]*>([^<]*)<\/label>/g)].map((m) => m[1])

describe('Send Template step', () => {
  it('shows one input per body placeholder of the chosen template, filled from variables', () => {
    const html = render(
      {
        step_type: 'send_template',
        step_config: { template_name: 'order_update', language: 'en_US', variables: { '1': 'Ann' } },
      },
      [orderUpdate],
    )
    expect(labels(html)).toEqual(['Template', 'Variable {{1}}', 'Variable {{2}}'])
    expect(html).toContain('value="Ann"')
  })

  it('shows no variable inputs before a template is picked', () => {
    const html = render({ step_type: 'send_template', step_config: { template_name: '', language: 'en_US' } }, [
      orderUpdate,
    ])
    expect(labels(html)).toEqual(['Template'])
  })
})

describe('Condition step', () => {
  it('hides the operand for message_content, which only reads Value', () => {
    const html = render({
      step_type: 'condition',
      step_config: { subject: 'message_content', operand: '', value: 'urgent' },
    })
    expect(labels(html)).toEqual(['Subject', 'Value'])
  })

  it('keeps the operand for the subjects that read it', () => {
    expect(labels(render({ step_type: 'condition', step_config: { subject: 'tag_presence', operand: '' } }))).toEqual([
      'Subject',
      'Operand',
    ])
    expect(
      labels(render({ step_type: 'condition', step_config: { subject: 'contact_field', operand: 'company' } })),
    ).toEqual(['Subject', 'Operand', 'Value'])
    expect(labels(render({ step_type: 'condition', step_config: { subject: 'time_of_day', operand: '' } }))).toEqual([
      'Subject',
      'Operand',
    ])
  })
})
