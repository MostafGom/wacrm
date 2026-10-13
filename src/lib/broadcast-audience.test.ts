import { describe, it, expect } from 'vitest';

import { localAudienceCount, parseAudienceConfig } from './broadcast-audience';

// Resolution / counting against real rows (row caps, large tag and
// exclude lists, custom-field operators, CSV upserts) is covered by
// src/server/repos/broadcast-audience.int.test.ts.

const TAG_A = '11111111-1111-4111-8111-111111111111';
const TAG_B = '22222222-2222-4222-8222-222222222222';
const FIELD = '33333333-3333-4333-8333-333333333333';

describe('parseAudienceConfig', () => {
  it('accepts every audience type the wizard builds', () => {
    expect(parseAudienceConfig({ type: 'all' })).toEqual({ type: 'all' });
    expect(parseAudienceConfig({ type: 'tags', tagIds: [TAG_A, TAG_A, TAG_B] })).toEqual({
      type: 'tags',
      tagIds: [TAG_A, TAG_B],
    });
    expect(
      parseAudienceConfig({
        type: 'custom_field',
        customField: { fieldId: FIELD, operator: 'contains', value: 'vip' },
        excludeTagIds: [TAG_B],
      }),
    ).toEqual({
      type: 'custom_field',
      customField: { fieldId: FIELD, operator: 'contains', value: 'vip' },
      excludeTagIds: [TAG_B],
    });
    expect(
      parseAudienceConfig({ type: 'csv', csvContacts: [{ phone: '+15550100', name: 'Ann' }, { phone: '+15550101' }] }),
    ).toEqual({ type: 'csv', csvContacts: [{ phone: '+15550100', name: 'Ann' }, { phone: '+15550101' }] });
  });

  it('keeps a not-yet-chosen custom field so the count can answer null', () => {
    expect(
      parseAudienceConfig({ type: 'custom_field', customField: { fieldId: '', operator: 'is', value: '' } }),
    ).toEqual({ type: 'custom_field', customField: { fieldId: '', operator: 'is', value: '' } });
  });

  it('rejects malformed input', () => {
    expect(parseAudienceConfig(null)).toBeNull();
    expect(parseAudienceConfig({ type: 'everyone' })).toBeNull();
    expect(parseAudienceConfig({ type: 'tags', tagIds: ['not-a-uuid'] })).toBeNull();
    expect(parseAudienceConfig({ type: 'tags', excludeTagIds: 'x' })).toBeNull();
    expect(
      parseAudienceConfig({ type: 'custom_field', customField: { fieldId: FIELD, operator: 'like', value: 'x' } }),
    ).toBeNull();
    expect(parseAudienceConfig({ type: 'csv', csvContacts: [{ name: 'no phone' }] })).toBeNull();
  });

  it('drops unknown keys', () => {
    expect(parseAudienceConfig({ type: 'all', sql: 'DROP TABLE contacts' })).toEqual({ type: 'all' });
  });
});

describe('localAudienceCount', () => {
  it('counts CSV rows without a query', () => {
    expect(localAudienceCount({ type: 'csv', csvContacts: [{ phone: '1' }, { phone: '2' }] })).toBe(2);
  });

  it('is null for a CSV audience with no file loaded', () => {
    expect(localAudienceCount({ type: 'csv' })).toBeNull();
    expect(localAudienceCount({ type: 'csv', csvContacts: [] })).toBeNull();
  });

  it('defers every other type to the server', () => {
    expect(localAudienceCount({ type: 'all' })).toBeUndefined();
    expect(localAudienceCount({ type: 'tags', tagIds: [TAG_A] })).toBeUndefined();
  });
});
