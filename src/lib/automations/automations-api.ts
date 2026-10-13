// Browser client for the automation read routes the dashboard uses.
// Every function resolves to `{ data, error }` (see lib/http/client).

import { apiRequest } from "@/lib/http/client";
import type { Automation, AutomationLog, CustomField, MessageTemplate, Tag } from "@/types";

export function listAutomations() {
  return apiRequest<{ automations: Automation[] }>("/api/automations");
}

/** The automation plus its 100 most recent logs (404 when not in the account). */
export function getAutomationLogs(id: string) {
  return apiRequest<{ automation: Automation; logs: AutomationLog[] }>(`/api/automations/${id}/logs`);
}

export interface BuilderResources {
  tags: Tag[];
  custom_fields: CustomField[];
  /** APPROVED templates only. */
  templates: MessageTemplate[];
  pipelines: { id: string; name: string }[];
  stages: { id: string; name: string; pipeline_id: string; position: number }[];
}

/** Pickers for the automation builder (tags, templates, fields, pipelines). */
export function getBuilderResources() {
  return apiRequest<BuilderResources>("/api/automations/resources");
}
