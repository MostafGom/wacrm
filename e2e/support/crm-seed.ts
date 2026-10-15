// Setup helpers for the broadcasts / settings / dashboard specs: create
// CRM data through the app's own API (as a signed-in user), so the
// specs can focus on driving the feature under test through the UI.

import { expect } from "@playwright/test";

import { api, type TestUser } from "./accounts";

export interface SeedContact {
  id: string;
  name: string;
  phone: string;
}

export async function createTag(user: TestUser, name: string, color = "#10b981"): Promise<string> {
  const r = await api(user, "POST", "/api/tags", { name, color });
  expect(r.status, `create tag ${name}: ${JSON.stringify(r.body)}`).toBe(201);
  return r.body.tag.id as string;
}

export async function createCustomField(user: TestUser, fieldName: string): Promise<string> {
  const r = await api(user, "POST", "/api/custom-fields", { field_name: fieldName });
  expect(r.status, `create custom field ${fieldName}: ${JSON.stringify(r.body)}`).toBe(201);
  return r.body.field.id as string;
}

export async function createContact(
  user: TestUser,
  input: { name: string; phone: string; email?: string; company?: string },
  extras: { tagIds?: string[]; custom?: Record<string, string> } = {},
): Promise<SeedContact> {
  const r = await api(user, "POST", "/api/contacts", input);
  expect(r.status, `create contact ${input.phone}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  const id = r.body.contact.id as string;
  for (const tagId of extras.tagIds ?? []) {
    const t = await api(user, "POST", `/api/contacts/${id}/tags`, { tag_id: tagId });
    expect(t.status, `tag contact: ${JSON.stringify(t.body)}`).toBe(200);
  }
  if (extras.custom) {
    const values = Object.entries(extras.custom).map(([custom_field_id, value]) => ({ custom_field_id, value }));
    const c = await api(user, "PUT", `/api/contacts/${id}/custom-values`, { values });
    expect(c.status, `custom values: ${JSON.stringify(c.body)}`).toBe(200);
  }
  return { id, name: input.name, phone: input.phone };
}

/** A pipeline with the given stages (admin+). Returns the pipeline + stage ids in order. */
export async function createPipeline(
  user: TestUser,
  name: string,
  stages: { name: string; color: string }[],
): Promise<{ id: string; stageIds: string[] }> {
  const r = await api(user, "POST", "/api/pipelines", {
    name,
    stages: stages.map((s, position) => ({ ...s, position })),
  });
  expect(r.status, `create pipeline: ${JSON.stringify(r.body)}`).toBe(201);
  const id = r.body.pipeline.id as string;
  const st = await api(user, "GET", `/api/pipelines/${id}/stages`);
  expect(st.status).toBe(200);
  const byName = new Map<string, string>(st.body.stages.map((s: { id: string; name: string }) => [s.name, s.id]));
  return { id, stageIds: stages.map((s) => byName.get(s.name)!) };
}

export async function createDeal(
  user: TestUser,
  input: { title: string; pipeline_id: string; stage_id: string; value?: number; currency?: string; contact_id?: string },
): Promise<string> {
  const r = await api(user, "POST", "/api/deals", input);
  expect(r.status, `create deal: ${JSON.stringify(r.body)}`).toBe(201);
  return r.body.deal.id as string;
}

export interface BroadcastRow {
  id: string;
  name: string;
  status: string;
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  replied_count: number;
  failed_count: number;
}

export interface RecipientRow {
  id: string;
  status: string;
  error_message: string | null;
  whatsapp_message_id: string | null;
  template_params: string[] | null;
  contact: { name: string | null; phone: string } | null;
}

export async function getBroadcast(user: TestUser, id: string): Promise<{ broadcast: BroadcastRow; recipients: RecipientRow[] }> {
  const r = await api(user, "GET", `/api/broadcasts/${id}`);
  expect(r.status, `get broadcast: ${JSON.stringify(r.body)}`).toBe(200);
  return r.body;
}
