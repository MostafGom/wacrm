// Read emails the app sent, from Mailpit.

import { expect } from "@playwright/test";

import { MAILPIT_URL } from "./env";

interface MailSummary {
  ID: string;
  Subject: string;
  Created: string;
  To: { Address: string }[];
}

async function search(to: string): Promise<MailSummary[]> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`);
  const body = (await res.json()) as { messages: MailSummary[] };
  return body.messages ?? [];
}

/**
 * Wait for an email to `to` whose subject matches, and return the first
 * /auth/callback link in it. `after` ignores older emails (e.g. a
 * previous reset link).
 */
export async function waitForAuthLink(
  to: string,
  subject: RegExp,
  after = 0,
  timeout = 20_000,
): Promise<{ link: string; subject: string; text: string }> {
  let found: MailSummary | undefined;
  await expect
    .poll(
      async () => {
        found = (await search(to)).find((m) => subject.test(m.Subject) && Date.parse(m.Created) >= after - 1000);
        return Boolean(found);
      },
      { timeout, message: `waiting for an email to ${to} matching ${subject}` },
    )
    .toBe(true);
  const res = await fetch(`${MAILPIT_URL}/api/v1/message/${found!.ID}`);
  const msg = (await res.json()) as { Text: string; Subject: string };
  const link = /https?:\/\/\S+\/auth\/callback\?\S+/.exec(msg.Text)?.[0];
  if (!link) throw new Error(`no auth link in email "${msg.Subject}":\n${msg.Text}`);
  return { link, subject: msg.Subject, text: msg.Text };
}

export async function countEmails(to: string): Promise<number> {
  return (await search(to)).length;
}
