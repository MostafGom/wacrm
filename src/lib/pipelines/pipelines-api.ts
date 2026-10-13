// Browser client for the pipeline / stage / deal routes.
// Every function resolves to `{ data, error }` (see lib/http/client).

import { apiRequest } from "@/lib/http/client";
import type { Deal, DealStatus, Pipeline, PipelineStage } from "@/types";

export interface StageInput {
  name: string;
  color: string;
  position: number;
}

export interface DealInput {
  title?: string;
  value?: number;
  currency?: string | null;
  contact_id?: string | null;
  pipeline_id?: string;
  stage_id?: string;
  assigned_to?: string | null;
  notes?: string | null;
  expected_close_date?: string | null;
  status?: DealStatus;
}

export interface ContactOption {
  id: string;
  name: string | null;
  phone: string;
}

export interface AssigneeOption {
  id: string;
  full_name: string;
  email: string;
}

export interface LinkedConversation {
  id: string;
  status: string;
  last_message_at: string | null;
}

// ---- pipelines -----------------------------------------------------

export function listPipelines() {
  return apiRequest<{ pipelines: Pipeline[] }>("/api/pipelines");
}

/** Create a pipeline together with its initial stages (one transaction). */
export function createPipeline(name: string, stages: StageInput[]) {
  return apiRequest<{ pipeline: Pipeline }>("/api/pipelines", { method: "POST", body: { name, stages } });
}

export function renamePipeline(id: string, name: string) {
  return apiRequest<{ pipeline: Pipeline }>(`/api/pipelines/${id}`, { method: "PATCH", body: { name } });
}

export function deletePipeline(id: string) {
  return apiRequest<{ ok: true }>(`/api/pipelines/${id}`, { method: "DELETE" });
}

// ---- stages --------------------------------------------------------

export function listStages(pipelineId: string) {
  return apiRequest<{ stages: PipelineStage[] }>(`/api/pipelines/${pipelineId}/stages`);
}

export function addStage(pipelineId: string, stage: StageInput) {
  return apiRequest<{ stage: PipelineStage }>(`/api/pipelines/${pipelineId}/stages`, { method: "POST", body: stage });
}

/** Write every stage (name, colour, position) in one request. */
export function saveStages(pipelineId: string, stages: (StageInput & { id: string })[]) {
  return apiRequest<{ stages: PipelineStage[] }>(`/api/pipelines/${pipelineId}/stages`, {
    method: "PUT",
    body: { stages },
  });
}

/** 409 → `error.code === 'stage_has_deals'`. */
export function deleteStage(pipelineId: string, stageId: string) {
  return apiRequest<{ ok: true }>(`/api/pipelines/${pipelineId}/stages/${stageId}`, { method: "DELETE" });
}

// ---- deals ---------------------------------------------------------

export function listDeals(pipelineId: string) {
  return apiRequest<{ deals: Deal[] }>("/api/deals", { query: { pipelineId } });
}

export function createDeal(input: DealInput) {
  return apiRequest<{ deal: Deal }>("/api/deals", { method: "POST", body: input });
}

export function updateDeal(id: string, patch: DealInput) {
  return apiRequest<{ deal: Deal }>(`/api/deals/${id}`, { method: "PATCH", body: patch });
}

export function deleteDeal(id: string) {
  return apiRequest<{ ok: true }>(`/api/deals/${id}`, { method: "DELETE" });
}

export function getDealFormOptions() {
  return apiRequest<{ contacts: ContactOption[]; profiles: AssigneeOption[] }>("/api/deals/form-options");
}

export function getContactConversation(contactId: string) {
  return apiRequest<{ conversation: LinkedConversation | null }>("/api/deals/form-options", {
    query: { contactId },
  });
}

export function setDefaultCurrency(currency: string) {
  return apiRequest<{ ok: true }>("/api/deals/default-currency", { method: "PATCH", body: { currency } });
}
