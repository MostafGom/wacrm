import type { Db } from '@/server/db'
import {
  deleteAutomationSteps,
  insertAutomationSteps,
  listAutomationSteps,
  type StepRow,
} from '@/server/repos/automations'

// ------------------------------------------------------------
// Builder payload → flat rows for automation_steps.
// Root steps arrive in order. A Condition step carries its children
// under `branches: { yes: [...], no: [...] }`. We walk the tree and
// assign stable UUIDs so parent_step_id references resolve in a
// single INSERT.
// ------------------------------------------------------------

export interface BuilderStepInput {
  id?: string
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: BuilderStepInput[]; no?: BuilderStepInput[] }
  // Legacy flat form (from template seeds):
  branch?: 'yes' | 'no' | null
  parent_index?: number | null
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

/**
 * Replace an automation's whole step tree. Run inside one transaction
 * (the caller's `db`) so a failed insert leaves the old steps intact.
 */
export async function replaceSteps(
  db: Db,
  accountId: string,
  automationId: string,
  input: BuilderStepInput[],
): Promise<void> {
  await deleteAutomationSteps(db, accountId, automationId)
  await insertSteps(db, accountId, automationId, input)
}

export async function insertSteps(
  db: Db,
  accountId: string,
  automationId: string,
  input: BuilderStepInput[],
): Promise<void> {
  const rows = buildStepRows(automationId, input)
  if (rows.length === 0) return
  await insertAutomationSteps(db, accountId, rows)
}

/** Flatten builder input (nested tree, or legacy flat seeds) into rows. Pure. */
export function buildStepRows(automationId: string, input: BuilderStepInput[]): StepRow[] {
  if (!input || input.length === 0) return []

  const looksFlat = input.some(
    (s) => s.branch !== undefined || s.parent_index !== undefined,
  )
  const tree = looksFlat ? seedsToTree(input) : input

  const rows: StepRow[] = []
  function walk(
    steps: BuilderStepInput[],
    parentId: string | null,
    branch: 'yes' | 'no' | null,
  ) {
    steps.forEach((s, idx) => {
      const id = s.id ?? uid()
      rows.push({
        id,
        automation_id: automationId,
        parent_step_id: parentId,
        branch,
        step_type: s.step_type,
        step_config: s.step_config ?? {},
        position: idx,
      })
      if (s.step_type === 'condition' && s.branches) {
        if (s.branches.yes) walk(s.branches.yes, id, 'yes')
        if (s.branches.no) walk(s.branches.no, id, 'no')
      }
    })
  }
  walk(tree, null, null)
  return rows
}

function seedsToTree(seeds: BuilderStepInput[]): BuilderStepInput[] {
  const nodes: BuilderStepInput[] = seeds.map((s) => ({
    ...s,
    branches: { yes: [], no: [] },
  }))
  const roots: BuilderStepInput[] = []
  nodes.forEach((n, i) => {
    const seed = seeds[i]
    if (seed.parent_index == null) {
      roots.push(n)
    } else {
      const parent = nodes[seed.parent_index]
      parent.branches = parent.branches ?? { yes: [], no: [] }
      const bucket = (seed.branch ?? 'yes') as 'yes' | 'no'
      ;(parent.branches[bucket] ??= []).push(n)
    }
  })
  return roots
}

/** The nested tree shape the builder UI expects. */
export interface BuilderStepNode extends BuilderStepInput {
  id: string
  branches: { yes: BuilderStepNode[]; no: BuilderStepNode[] }
}

/**
 * Load the steps for an account's automation and rebuild the nested
 * tree. One query, O(n) assembly.
 */
export async function loadStepsTree(
  db: Db,
  accountId: string,
  automationId: string,
): Promise<BuilderStepNode[]> {
  return buildStepsTree(await listAutomationSteps(db, accountId, automationId))
}

/** Rows (ordered by position) → nested builder tree. Pure. */
export function buildStepsTree(
  rows: Pick<StepRow, 'id' | 'parent_step_id' | 'branch' | 'step_type' | 'step_config'>[],
): BuilderStepNode[] {
  const byId = new Map<string, BuilderStepNode>()
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      step_type: row.step_type,
      step_config: row.step_config ?? {},
      branches: { yes: [], no: [] },
    })
  }

  const roots: BuilderStepNode[] = []
  for (const row of rows) {
    const node = byId.get(row.id)!
    if (row.parent_step_id) {
      const parent = byId.get(row.parent_step_id)
      if (parent) {
        const bucket = (row.branch ?? 'yes') as 'yes' | 'no'
        parent.branches[bucket].push(node)
      }
    } else {
      roots.push(node)
    }
  }
  return roots
}
