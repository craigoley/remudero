/**
 * lib/task-card.ts — the DETAIL layer's row-click task CARD (W1-T158, MASTER-PLAN §7/§7B).
 *
 * "Row click expands a task CARD — title, rationale, acceptance criteria, dependency chain
 * (each dep LINKED), run history with per-run cost + verdict, PR/issue links. The card renders
 * from the plan + ledger with ZERO extra GitHub calls (the batched gateway serves it)."
 *
 * ZERO EXTRA GITHUB CALLS, verified from source (not assumed): {@link computeTaskCard} reuses
 * board.ts's own {@link BoardDeps} shape and calls the SAME `projectPlan` (status.ts) board.ts's
 * `GET /v1/status` already calls — no second derivation path, no new `github` method invented.
 * A card open is therefore, at the GATEWAY level, indistinguishable from one more `GET
 * /v1/status` poll: in production `rmd serve` wires `deps.board.github` to `buildBatchedGithub`
 * (status.ts), whose own `ttlMs` in-memory cache (already proven O(1)-fetch-for-N-tasks in
 * test/status.test.ts / test/serve.test.ts) answers a second `projectPlan` pass with ZERO
 * additional `gh` subprocess calls, provided it is still warm — exactly the invariant
 * lib/serve.ts's `prewarmBoardGithub` (W1-T154) already establishes for the board itself.
 *
 * Per-run PR links stay BARE HREFS (the raw `pr_url` a `pr.opened` ledger line recorded) rather
 * than lib/trace.ts's `runsForTask`, which calls `github.prView(prUrl)` PER RUN to resolve each
 * PR's live state/merge-sha for the JOURNEY view (W1-T43) — a deliberate, itself-costed choice
 * that view's own header documents. The card is a cheaper, narrower artifact: it answers "what
 * happened to this task", not "walk me through the provenance chain" (that is the journey's
 * job, reached via this same task's own per-row Journey affordance, over the EXISTING GET
 * /v1/trace route unchanged). Mirrors lib/trace.ts's `runsForTask` OWNERSHIP discipline exactly
 * (only a `run_id` actually MINTED for this task — `taskId` itself, or run-task.ts's own
 * `${taskId}-${Date.now()}` convention — credits as one of its own runs; a daemon/sweep tick
 * that merely NAMES this task via `task_id` on an unrelated `run_id` never counts), so the two
 * modules can never quietly disagree about which runs belong to a task.
 */

import type { ServerResponse } from "node:http";
import type { BoardDeps } from "./board.js";
import { projectPlan, readLedgerLines } from "./status.js";
import type { StatusProjection } from "./status.js";
import type { AcceptanceCriterion, Task, TaskStatus } from "./plan.js";
import type { Route } from "./service.js";

/** One run in the card's run-history list — cost + verdict + a bare PR href, no GitHub read. */
export interface TaskCardRun {
  runId: string;
  /** The last `verdict` ledger line's `verdict` field for this run, if any (matches lib/trace.ts's `TraceRun.verdict`). */
  verdict?: string;
  /** `cost_usd` off the run's own ledger lines (retro.ts's `gatherRuns` precedent: the `verdict` line's own `cost_usd` if present, else the first line naming one). */
  costUsd?: number;
  /** The last `pr.opened` ledger line's `pr_url` field for this run, if any — a bare href, never GitHub-resolved. */
  prUrl?: string;
}

export interface TaskCard {
  id: string;
  title: string;
  rationale?: string;
  acceptance: AcceptanceCriterion[];
  /** Each id here is a LINK the client navigates to that task's own card (never a bare label). */
  dependsOn: string[];
  status: TaskStatus;
  merged: boolean;
  prNumber?: number;
  prUrl?: string;
  runs: TaskCardRun[];
}

/**
 * Every run owned by `taskId`, oldest first (ledger append order) — the SAME credit discipline
 * lib/trace.ts's `runsForTask` uses (see this module's header), reproduced here rather than
 * imported so this module never needs `trace.ts`'s `TraceGithub` — the one thing that would
 * pull a GitHub dependency back into a "zero extra calls" card.
 */
export function taskCardRuns(lines: Array<Record<string, unknown>>, taskId: string): TaskCardRun[] {
  const order: string[] = [];
  const byRun = new Map<string, Array<Record<string, unknown>>>();
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    const runId = line.run_id;
    if (typeof runId !== "string") continue;
    if (runId !== taskId && !runId.startsWith(`${taskId}-`)) continue;
    let bucket = byRun.get(runId);
    if (!bucket) {
      bucket = [];
      byRun.set(runId, bucket);
      order.push(runId);
    }
    bucket.push(line);
  }
  return order.map((runId) => {
    const runLines = byRun.get(runId) as Array<Record<string, unknown>>;
    let verdict: string | undefined;
    let costUsd: number | undefined;
    let prUrl: string | undefined;
    for (const line of runLines) {
      if (line.step === "verdict" && typeof line.verdict === "string") verdict = line.verdict;
      // First cost_usd seen wins as a fallback; a later verdict line's own cost_usd (if any) overrides it — same
      // "verdict line is authoritative, else the first line naming one" precedent as retro.ts's gatherRuns.
      if (typeof line.cost_usd === "number" && (costUsd === undefined || line.step === "verdict")) costUsd = line.cost_usd;
      if (line.step === "pr.opened" && typeof line.pr_url === "string") prUrl = line.pr_url;
    }
    return { runId, verdict, costUsd, prUrl };
  });
}

/** Assemble a {@link TaskCard} from a {@link Task}, its (already-derived) {@link StatusProjection}, and the ledger. Pure — no I/O. */
export function buildTaskCard(task: Task, projection: StatusProjection | undefined, ledgerLines: Array<Record<string, unknown>>): TaskCard {
  return {
    id: task.id,
    title: task.title,
    rationale: task.rationale,
    acceptance: task.acceptance ?? [],
    dependsOn: task.depends_on,
    status: projection?.status ?? task.status,
    merged: projection?.merged ?? false,
    prNumber: projection?.prNumber,
    prUrl: projection?.prUrl,
    runs: taskCardRuns(ledgerLines, task.id),
  };
}

/** `undefined` when `taskId` names no task in the plan (the route's own 404 case). */
export function computeTaskCard(deps: BoardDeps, taskId: string): TaskCard | undefined {
  const task = deps.plan.byId.get(taskId);
  if (!task) return undefined;
  // SAME projectPlan pass board.ts's computeBoardSnapshot already runs — see module header for
  // why this adds zero GitHub calls against the production (batched, cached) gateway.
  const projection = projectPlan(deps.plan, deps).get(taskId);
  const readLedger = deps.readLedger ?? readLedgerLines;
  const lines = readLedger(deps.ledgerPath);
  return buildTaskCard(task, projection, lines);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** GET /v1/task?id=<task-id> — the row-click card, read-scoped. 400 with no `?id=`, 404 for an unknown task id. */
export function buildTaskCardRoute(deps: BoardDeps): Route {
  return {
    method: "GET",
    path: "/v1/task",
    scope: "read",
    handler: (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const id = url.searchParams.get("id");
      if (!id || !id.trim()) {
        sendJson(res, 400, { error: "invalid_request", detail: "?id=<task-id> is required" });
        return;
      }
      const card = computeTaskCard(deps, id);
      if (!card) {
        sendJson(res, 404, { error: "not_found", detail: `no task with id '${id}' in plan` });
        return;
      }
      sendJson(res, 200, { card });
    },
  };
}
