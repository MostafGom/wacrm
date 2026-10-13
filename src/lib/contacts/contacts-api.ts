// Browser client for the contacts / tags / custom-field routes.
// Every function resolves to `{ data, error }` (see lib/http/client).

import { apiRequest } from "@/lib/http/client";
import type { Contact, ContactCustomValue, ContactNote, CustomField, Deal, PipelineStage, Tag } from "@/types";
import type { ExistingContact } from "./dedupe";

export type ContactWithTagIds = Contact & { tag_ids: string[] };

export interface ContactDetail {
  contact: Contact;
  tag_ids: string[];
  notes: ContactNote[];
  custom_values: ContactCustomValue[];
  deals: (Deal & { stage: PipelineStage | null })[];
}

export interface ContactInput {
  name?: string | null;
  phone: string;
  email?: string | null;
  company?: string | null;
}

export interface ImportRowInput {
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
  tagNames: string[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  invalidPhone: number;
  failed: number;
  failedDetails: { phone: string; name?: string; reason: string }[];
  tagsAssigned: number;
  tagsFailed: boolean;
  skippedTagNames: string[];
}

// ---- contacts ------------------------------------------------------

export function listContacts(q: { page: number; pageSize: number; search?: string; tagIds?: string[] }) {
  return apiRequest<{ contacts: ContactWithTagIds[]; total: number }>("/api/contacts", {
    query: { page: q.page, pageSize: q.pageSize, search: q.search || undefined, tag: q.tagIds },
  });
}

export function getContactDetail(id: string) {
  return apiRequest<ContactDetail>(`/api/contacts/${id}`);
}

/** 409 → `error.code === 'duplicate_phone'`, `error.body.existing`. */
export function createContact(input: ContactInput) {
  return apiRequest<{ contact: Contact }>("/api/contacts", { method: "POST", body: input });
}

export function updateContact(id: string, input: Partial<ContactInput>) {
  return apiRequest<{ contact: Contact }>(`/api/contacts/${id}`, { method: "PATCH", body: input });
}

export function deleteContact(id: string) {
  return apiRequest<{ ok: true }>(`/api/contacts/${id}`, { method: "DELETE" });
}

export function deleteContacts(ids: string[]) {
  return apiRequest<{ deleted: number }>("/api/contacts", { method: "DELETE", body: { ids } });
}

export function findDuplicate(phone: string) {
  return apiRequest<{ existing: ExistingContact | null; exact: boolean }>("/api/contacts/duplicate", {
    query: { phone },
  });
}

export function importContacts(rows: ImportRowInput[]) {
  return apiRequest<ImportResult>("/api/contacts/import", { method: "POST", body: { rows } });
}

// ---- notes / custom values -------------------------------------------

export function addNote(contactId: string, noteText: string) {
  return apiRequest<{ note: ContactNote }>(`/api/contacts/${contactId}/notes`, {
    method: "POST",
    body: { note_text: noteText },
  });
}

export function deleteNote(contactId: string, noteId: string) {
  return apiRequest<{ ok: true }>(`/api/contacts/${contactId}/notes/${noteId}`, { method: "DELETE" });
}

export function saveCustomValues(contactId: string, values: { custom_field_id: string; value: string }[]) {
  return apiRequest<{ custom_values: ContactCustomValue[] }>(`/api/contacts/${contactId}/custom-values`, {
    method: "PUT",
    body: { values },
  });
}

// ---- tags / custom fields --------------------------------------------

export function listTags() {
  return apiRequest<{ tags: Tag[] }>("/api/tags");
}

export function createTag(name: string, color: string) {
  return apiRequest<{ tag: Tag }>("/api/tags", { method: "POST", body: { name, color } });
}

export function deleteTag(id: string) {
  return apiRequest<{ ok: true }>(`/api/tags/${id}`, { method: "DELETE" });
}

export function listCustomFields() {
  return apiRequest<{ fields: CustomField[] }>("/api/custom-fields");
}

export function createCustomField(fieldName: string) {
  return apiRequest<{ field: CustomField }>("/api/custom-fields", { method: "POST", body: { field_name: fieldName } });
}

export function renameCustomField(id: string, fieldName: string) {
  return apiRequest<{ field: CustomField }>(`/api/custom-fields/${id}`, {
    method: "PATCH",
    body: { field_name: fieldName },
  });
}

export function deleteCustomField(id: string) {
  return apiRequest<{ ok: true }>(`/api/custom-fields/${id}`, { method: "DELETE" });
}
