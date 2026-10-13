import type { Db } from '@/server/db';
import { getT } from '@/lib/i18n/translate';

const t = getT('LibErrors');

export class ContactTagWriteError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ContactTagWriteError';
    this.status = status;
  }
}

interface ContactTagWriteInput {
  accountId: string;
  contactId: string;
  tagId: string;
}

async function assertContactAndTagOwnership(
  db: Db,
  input: ContactTagWriteInput
): Promise<void> {
  const [contact, tag] = await Promise.all([
    db
      .selectFrom('contacts')
      .select('id')
      .where('id', '=', input.contactId)
      .where('account_id', '=', input.accountId)
      .executeTakeFirst(),
    db
      .selectFrom('tags')
      .select('id')
      .where('id', '=', input.tagId)
      .where('account_id', '=', input.accountId)
      .executeTakeFirst(),
  ]);

  if (!contact) {
    throw new ContactTagWriteError(t('tags.contactNotFound'), 404);
  }
  if (!tag) {
    throw new ContactTagWriteError(t('tags.tagNotFound'), 404);
  }
}

/**
 * Add a tag exactly once. The unique constraint on
 * (contact_id, tag_id) is the concurrency-safe source of truth: a
 * duplicate insert is a no-op (ON CONFLICT DO NOTHING — a raised 23505
 * would abort the surrounding transaction) and must not emit a
 * tag_added event.
 */
export async function addContactTagIfAbsent(
  db: Db,
  input: ContactTagWriteInput
): Promise<boolean> {
  await assertContactAndTagOwnership(db, input);

  const inserted = await db
    .insertInto('contact_tags')
    .values({ contact_id: input.contactId, tag_id: input.tagId })
    .onConflict((oc) => oc.columns(['contact_id', 'tag_id']).doNothing())
    .returning('id')
    .executeTakeFirst();

  return Boolean(inserted);
}

export async function removeContactTag(
  db: Db,
  input: ContactTagWriteInput
): Promise<void> {
  await assertContactAndTagOwnership(db, input);

  await db
    .deleteFrom('contact_tags')
    .where('contact_id', '=', input.contactId)
    .where('tag_id', '=', input.tagId)
    .execute();
}
