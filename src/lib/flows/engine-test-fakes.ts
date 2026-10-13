// In-memory stand-ins for the repositories the flow runner uses, shared
// by engine.test.ts and dispatch.test.ts. Test-only — wire them up with
//
//   vi.mock("@/server/db", async () => (await import("@/test/auth-mocks")).dbModule());
//   vi.mock("@/server/repos/flows", async () => (await import("./engine-test-fakes")).flowFakes.flows);
//   vi.mock("@/server/repos/flow-runs", async () => (await import("./engine-test-fakes")).flowFakes.runs);
//   vi.mock("@/server/repos/engine-data", async () => (await import("./engine-test-fakes")).flowFakes.data);
//
// and reset with `resetFlowFakes()` in beforeEach. Writes are recorded
// in the same `{ table, row }` shape the assertions have always used.

type Row = Record<string, unknown>;

const state = {
  /** What getActiveRunForContact sees. Empty = no run in progress. */
  activeRuns: [] as Row[],
  flows: [] as Row[],
  nodes: [] as Row[],
  /** flow_run_events written (logEvent). */
  events: [] as Row[],
  /** Every UPDATE, by table. */
  updates: [] as { table: string; row: Row }[],
  /** Every INSERT, by table (flow_runs starts). */
  inserted: [] as { table: string; row: Row }[],
  /** What the next insertActiveRun returns; null = the partial unique index won. */
  insertedRun: undefined as Row | null | undefined,
  rpcCalls: [] as string[],
};

const flows = {
  getFlow: async (_db: unknown, accountId: string, id: string) =>
    state.flows.find((f) => f.id === id && f.account_id === accountId),
  listActiveFlows: async (_db: unknown, accountId: string) =>
    state.flows.filter((f) => f.account_id === accountId && f.status === "active"),
  listFlowNodes: async (_db: unknown, _accountId: string, flowId: string) =>
    state.nodes.filter((n) => n.flow_id === flowId),
  incrementFlowExecutionCount: async () => {
    state.rpcCalls.push("increment_flow_execution_count");
  },
};

const runs = {
  getActiveRunForContact: async () => state.activeRuns[0],
  hasReplyForMetaMessage: async () => false,
  insertActiveRun: async (_db: unknown, values: Row) => {
    state.inserted.push({ table: "flow_runs", row: values });
    if (state.insertedRun === null) return undefined;
    const run = state.insertedRun ?? { id: "run-1", vars: {}, reprompt_count: 0, status: "active", ...values };
    return run;
  },
  insertRunEvent: async (_db: unknown, event: Row) => {
    state.events.push({ payload: {}, ...event });
  },
  updateRun: async (_db: unknown, _accountId: string, _runId: string, patch: Row) => {
    state.updates.push({ table: "flow_runs", row: patch });
  },
  advanceRunNodeKey: async (
    _db: unknown,
    _accountId: string,
    _runId: string,
    _expected: string | null,
    newKey: string,
  ) => {
    state.updates.push({ table: "flow_runs", row: { current_node_key: newKey } });
    return true;
  },
  endRun: async (_db: unknown, _accountId: string, _runId: string, status: string, reason: string) => {
    state.updates.push({ table: "flow_runs", row: { status, end_reason: reason } });
  },
};

const data = {
  contactHasTag: async () => false,
  getContactFieldValue: async () => undefined,
  findMessageIdByWaId: async () => null,
  handoffConversation: async (_db: unknown, _accountId: string, conversationId: string, assignTo?: string) => {
    state.updates.push({
      table: "conversations",
      row: { id: conversationId, status: "pending", ...(assignTo ? { assigned_agent_id: assignTo } : {}) },
    });
  },
};

export const flowFakes = { state, flows, runs, data };

export function resetFlowFakes(): void {
  state.activeRuns = [];
  state.flows = [];
  state.nodes = [];
  state.events = [];
  state.updates = [];
  state.inserted = [];
  state.insertedRun = undefined;
  state.rpcCalls = [];
}
