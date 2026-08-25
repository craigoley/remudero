/**
 * lib/board.ts — the read-only live board's daemon-side wiring (W3-T2, MASTER-PLAN §7 WS-5a).
 *
 * Narrow v0 vertical slice (the W3-T2 "Option A" decision): ONE daemon route pair — GET
 * /v1/status (REST snapshot) and GET /v1/status/stream (SSE, one `status` event per task
 * whose derived StatusProjection changes) — built entirely on top of the EXISTING mechanism
 * (lib/service.ts's Route/SseRoute) and the EXISTING projection logic (lib/status.ts's
 * projectPlan/deriveStatus). Zero new business logic: this module only wires those two
 * together and tails state/ledger.ndjson to know WHEN to recompute.
 *
 * "A ledger state flip appears in the UI within 2s of the write" (the task's acceptance
 * bar) drives the streaming design: the stream POLLS the ledger file every
 * {@link DEFAULT_POLL_MS} (250ms, comfortably under the 2s budget) rather than relying on
 * `fs.watch`, whose native change-event semantics are not portable across platforms/CI
 * runners (a missed/coalesced event there would silently blow the 2s bar). A poll only does
 * real work (re-deriving a task's status) when the ledger has grown since the last tick, and
 * only SENDS an event when that task's projection actually differs from the last one sent —
 * a state FLIP, not merely "the ledger was touched".
 *
 * Real `rmd serve` CLI wiring (registering these routes on a live createService(...)
 * instance, with a real ghGateway) is a later task's concern — the same split W3-T1a made
 * for the generic mechanism itself (see service.ts's header: "concrete routes... are
 * registered by a later task's real `rmd serve` wiring"). This module is proven directly
 * against a real HTTP server (test/board.test.ts), exactly like test/service.test.ts proves
 * the generic mechanism, with no CLI entry point required to exercise it.
 */

import type { ServerResponse } from "node:http";
import type { Plan, Task, TaskRisk } from "./plan.js";
import { DEFAULT_RISK, TASK_STATUSES } from "./plan.js";
import {
  createLedgerTailCache,
  deriveStatus,
  projectPlan,
  readLedgerLines,
  readLedgerTail,
  type DeriveDeps,
  type LedgerTailCache,
  type StatusProjection,
} from "./status.js";
import type { Route, SseRoute, SseSend } from "./service.js";
import { bearerTokenId } from "./panel-actions.js";
import type { LastSeenStore } from "./last-seen.js";
import { buildRecapEvents, type RecapEvent } from "./recap.js";
import { computeGlanceSpend, type GlanceSpend } from "./glance.js";
import { buildStatusBoard, type BlockedPrBlocker } from "./status-board.js";

/** Ledger poll pace for the SSE stream — comfortably under the 2s acceptance budget. */
export const DEFAULT_POLL_MS = 250;

/**
 * One board row: a {@link StatusProjection} enriched with the two plan-`Task` fields the FIND
 * layer (W1-T157) needs but {@link StatusProjection} deliberately does not carry — `title`
 * (the search bar is over id + title) and `risk` (the risk facet) — plus `lastActivityAt`, the
 * ISO timestamp of the LAST ledger line naming this task (the `recency` sort key).
 *
 * WHY enrich HERE and not on {@link StatusProjection} itself: that interface is MIRRORED by
 * openapi/daemon.yaml's `StatusProjection` schema and consumed by src/lib/daemon.ts +
 * packages/api-client — widening it is a far larger blast radius than this one wire payload
 * needs. `title`/`risk` are a pure in-memory join off `deps.plan.byId` (already held), never a
 * new GitHub/ledger derivation. The SSE `status` stream keeps emitting the bare
 * {@link StatusProjection} (see {@link buildStatusStream}); ONLY this REST snapshot carries the
 * enrichment, and the shell backfills title/risk across subsequent SSE deltas (src/lib/serve.ts).
 */
export interface BoardRow extends StatusProjection {
  title: string;
  risk: TaskRisk;
  /** ISO-8601 `ts` of the last ledger line naming this task; absent when the task has no ledger line at all. */
  lastActivityAt?: string;
  /**
   * LIVE ACCUMULATED SPEND (W1-T184), summed from `cost_usd` on every `implement.done`/
   * `fix.done` ledger line belonging to this task's CURRENT run (since its latest
   * `run.start`). Present only alongside {@link StatusProjection.phase} (an in-flight run) —
   * a terminal task's total cost lives on its `verdict` line instead (surfaced via the task
   * card's run history, W1-T158), not here. VOLATILE: ticks upward as further lines are
   * appended, exactly like `elapsedMs` — the shell's flip-detector excludes it from
   * "did this task's status change" the same way it already excludes `elapsedMs`.
   */
  liveSpendUsd?: number;
  /** LIVE ACCUMULATED TURN COUNT (W1-T184) — the `num_turns` counterpart to {@link liveSpendUsd}. */
  liveTurns?: number;
  /**
   * NO DATA YET (fb-1784902052582-c124f9): the run is in flight (`phase` present) but has logged
   * no `implement.done`/`fix.done` yet, so its spend/turns are genuinely UNKNOWN — not `0`.
   * Mutually exclusive with {@link liveSpendUsd}/{@link liveTurns}: exactly one of "pending" or
   * "has a value" is ever set for an in-flight run. The console renders this as "no data yet",
   * never `$0.000 / 0 turns` as fact.
   */
  liveSpendPending?: boolean;
  /**
   * W1-T944: worker liveness, carried straight through from {@link StatusProjection.workerState}
   * (deriveRunState's ledger scan — the SAME scan that produces `phase`/`startedAt`/`elapsedMs`
   * above, never a second scan and never a client-side re-derivation). Re-declared here, beside
   * the live spend fields, so the shape a NOW row actually renders is visible on ONE interface
   * rather than only on the base projection it happens to inherit. Present only alongside `phase`
   * (design note v — {@link isRunningRow}'s own `phase != null` definition governs, so a finished
   * run's last known state can never linger as if current); absent while `phase` IS present means
   * the run has emitted no `worker.state` row yet, and the console renders "state unknown" for
   * that case rather than a blank or a healthy-looking default (design note iii).
   */
  workerState?: StatusProjection["workerState"];
  /**
   * ISO-8601 `ts` the run transitioned INTO its current `workerState` — carried straight through
   * from {@link StatusProjection.workerStateSince}. Present only while `workerState === "quiet"`;
   * the console ages a "quiet Nm" duration off it on the same 1s tick `elapsedMs` already uses
   * (design note ii).
   */
  workerStateSince?: string;
  /**
   * W1-T1240: process-unevidenced, carried straight through from
   * {@link StatusProjection.processUnevidenced} (deriveStatus's own `recentActivity ||
   * hasLiveLock` check, held separately from the running disjunction — see that field's own
   * doc). Re-declared here for the same reason `workerState` immediately above is: the shape a
   * NOW row actually renders should be visible on ONE interface, not only on the base
   * projection it happens to inherit. Present only alongside `phase`, same sparse convention.
   */
  processUnevidenced?: StatusProjection["processUnevidenced"];
  /**
   * W1-T914 (feedback fb-1784901239119-1be356 clause c / fb-1784919225707-0fab8b): the row's
   * OWN `remudero-review` three-state, so a PR whose review has not run stops rendering
   * identically to one that passed. Present only alongside {@link StatusProjection.prUrl} — a
   * row with no PR has no review to render.
   *
   *   "success"    — reviewed-green: the last posted `remudero-review` was a pass.
   *   "failure"    — reviewed-red: the last posted `remudero-review` was a fail.
   *   "pending"    — review-in-progress (W1-T913's detection-time post) — NEVER rendered as
   *                  "success"; that is the exact collapse this task exists to stop.
   *   "none"       — ABSENT, not merely unreviewed: no `remudero-review` status has ever posted
   *                  for this head (pre-W1-T913, or a genuinely unattended head). Per W1-T225's
   *                  ruling, absent is the WORST of the states — it renders as absent, never as
   *                  "pending" and never as green.
   *   "unreadable" — the GitHub read behind this value FAILED (rate limit, network, an
   *                  unresolvable head) — a CANNOT-READ, not a state GitHub actually reported.
   *                  Renders as unreadable (with the snapshot's own `generated_at` as its
   *                  last-known age), never silently folded into "none" or a stale green/red.
   *   "not-applicable" — (W1-T2235) the row's PR is MERGED or CLOSED: `remudero-review` watches
   *                  a check go pending -> success on a PR that is STILL OPEN, so a terminal PR's
   *                  combined status is history, not a value this feature has an opinion about.
   *                  Never a network call behind it, unlike every other value above — and never
   *                  folded into "none", which means "asked GitHub, nothing was posted": "none"
   *                  is a fact about a live PR, "not-applicable" is that the question doesn't
   *                  apply to this one.
   *
   * Bound to {@link GitHub.reviewState} (status.ts) — the SAME combined-status read
   * open-prs-rest.ts's `combinedStatusRestArgs` already documents and run-task.ts's sweep-side
   * `reviewStateFromRollup` already consumes — never a second, console-only derivation.
   */
  reviewState?: "success" | "failure" | "pending" | "none" | "unreadable" | "not-applicable";
}

/** GET /v1/status's body — one {@link BoardRow} per plan task, as of `generated_at`. */
export interface CountSummary {
  total: number;
  running: number;
  merged: number;
  queued: number;
  /** W1-T159 (GLANCE strip): tasks that are STOPPED — `status === "blocked"` OR carrying an open,
   *  unsuperseded escalation (`needsHuman`). See {@link isBlockedRow} for why the second disjunct
   *  is required and why `needs me` remains a strict SUBSET of this count rather than a rival to it. */
  blocked: number;
  /** False when the GitHub read backing merge-state was unreachable ⇒ the `merged` tally is
   * UNKNOWN, not a fact — the console renders "merged: unknown" rather than "0 merged". */
  merged_known: boolean;
}

export interface BoardSnapshot {
  /** The ONE server clock this snapshot is "as of" — every header freshness chip keys on THIS. */
  generated_at: string;
  /** True iff the GitHub read backing merge-state was unreachable this snapshot (fb-…c124f9). */
  github_unreachable: boolean;
  /** Header counts, derived from the SAME `tasks` below (tally and rows can never disagree). */
  counts: CountSummary;
  /** W1-T159 (GLANCE strip): merged-today/spend-today/spend-this-week, computed from the SAME
   *  ledger lines this snapshot already read (lib/glance.ts's `computeGlanceSpend`) — never a
   *  second ledger read/reduction. */
  spend: GlanceSpend;
  tasks: BoardRow[];
  /**
   * W1-T1006: THE SIXTH NEEDS-ME ROW SOURCE — a PR the sweep reconciler already disposed into a
   * non-progressing class (`blocked-fixable`/`blocked-ambiguous`/`conflicted`/`stale`), reaching
   * the console through this SAME snapshot (design (i): "one snapshot, one `generated_at`, and
   * the counts and rows can never disagree") rather than a second fetch the way NEEDS ME's
   * feedback/inbox rows arrive. Sourced VERBATIM from status-board.ts's `buildStatusBoard`
   * (its own `blockers.rows`, filtered to `kind === "blocked_pr"`) — see
   * {@link deriveBoardBlockedPrs} — NEVER a second derivation over the ledger; status-board.ts
   * itself is unread by this task. Always an array (`[]`, never `undefined`), so a render never
   * has to special-case "not fetched yet" — exactly like {@link tasks} above.
   */
  blockedPrs: BlockedPrBlocker[];
  /**
   * W1-T1006 design (iii): set ONLY when live GitHub state could not be checked THIS render (no
   * reachable gateway, or the gateway's own read failed) — carried straight through from
   * status-board.ts's `BlockersSection.blockedPrsUnverifiedReason`. When set, {@link blockedPrs}
   * is EMPTY (every raw candidate withheld rather than replayed as current) — the console must
   * show this distinction, an unverified withholding, rather than let it read as "nothing
   * blocked" (an unknown that looks healthy is the exact failure this field exists to name).
   */
  blockedPrsUnverifiedReason?: string;
}

export interface BoardDeps extends DeriveDeps {
  plan: Plan;
}

/**
 * The `ts` of the last ledger line naming each task id (the board's `lastActivityAt`, W1-T157) —
 * factored out so {@link computeBoardSnapshot} doesn't duplicate this scan inline. (W1-T184: the
 * RECENT feed used to share this same helper for its own recency ordering via `computeRecentOutcomes`;
 * that function is gone — {@link computeRecentActivity} orders the feed by ledger-append order
 * directly, via its own {@link RecentActivityState.scannedLines} tail cursor, not this map.)
 */
interface LedgerActivity {
  ts?: string;
}
function lastActivityByTask(lines: Array<Record<string, unknown>>): Map<string, LedgerActivity> {
  const out = new Map<string, LedgerActivity>();
  lines.forEach((line) => {
    if (typeof line.task_id === "string") {
      out.set(line.task_id, { ts: typeof line.ts === "string" ? line.ts : undefined });
    }
  });
  return out;
}

/**
 * W1-T1006: the sixth NEEDS-ME row source, reusing status-board.ts's `buildStatusBoard` VERBATIM
 * for the blocked-PR derivation — design (i)'s own text: "the data comes from `buildStatusBoard`'s
 * existing `blockers.rows` and NOT from a second derivation over the ledger", because
 * `status-board.ts` is READ, NOT CHANGED, by this task and none of its blockers-deriving
 * functions (`rawBlockedPrCandidates`/`deriveBlockedPrBlockers`/`deriveBlockers`) are exported —
 * `buildStatusBoard` is the only door in.
 *
 * `plan` IS DELIBERATELY OMITTED (never `deps.plan`) — this is the load-bearing choice, not an
 * oversight. `buildStatusBoard` unconditionally re-derives QUEUE HEAD/INBOX via its own INTERNAL
 * `projectPlanOnce`/`projectPlan` pass, which is a SECOND, genuinely duplicate batch of `github`
 * calls on top of the one {@link computeBoardSnapshot} already ran a few lines above — MEASURED:
 * test/board.test.ts's own cache-recompute suite counts `github.prByRef` calls as its "did a
 * real recompute happen" proxy, and passing `deps.plan` through doubled that count (2 vs the
 * expected 1) the first time this was wired, because a plan task's `pr:` field forces a
 * `prByRef` call on EVERY `projectPlan` pass. `deriveBlockers`'s `blocked_pr` class (the ONLY
 * class this board keeps, filtered below) needs no `projections` at all — only `indeterminate`
 * does — so `plan: undefined` makes `projectPlanOnce` short-circuit before touching `github` a
 * second time (see its own `if (!plan) return { unknownReason: … }` rung), while QUEUE
 * HEAD/INBOX degrade to a stated `unknownReason` this board never reads. `blockedPrs`' OWN
 * `github` calls (`deriveBlockedPrBlockers`'s per-PR-number `prByRef`, keyed off the ledger's
 * `sweep.disposed` lines, never off a task's `pr:` field) still run in full and are a genuinely
 * NEW read no earlier pass in this file makes — that cost is real and unavoidable, not a
 * duplicate of anything.
 *
 * EVERY OTHER SECTION `buildStatusBoard` computes (liveness/latches/queue head/inbox/headroom/
 * cache-hit/learnings-injection/needs-me-cost-anomaly) is irrelevant to this board and
 * deliberately starved of real IO here, so this call costs CPU only, never new file/process
 * reads beyond `blockedPrs`' own: `queryService` is an inert stub (LIVENESS is discarded),
 * `resolveOriginMainSha` is forced to `undefined` (skips a `git rev-parse` neither LATCHES' nor
 * BLOCKERS needs), `grepAnchorTrue`/`readProposalRegistry`/`readDraftCache` are inert (INBOX is
 * discarded regardless), and `readLedger` is overridden to hand back the SAME already-parsed
 * `lines` {@link computeBoardSnapshot} read above — never a second ledger file read.
 *
 * The `root`/`repoDir` strings below are never dereferenced by anything this board keeps: every
 * consumer that would use them (LATCHES' file reads, `tryLoadDefaultPlan`'s fallback for an
 * omitted `plan` — never reached since `github`/`readLedger` already resolve everything BLOCKERS
 * needs, the default `grepAnchorTrue`/`resolveOriginMainSha`) is stubbed out above or fails soft
 * to `undefined`/`[]`/`{}` on a path that cannot exist. A clearly-bogus sentinel, not `""`, so a
 * test run from a directory that happens to hold a real `state/`/`plan/` tree can never
 * accidentally pick up real files for a section this board discards anyway.
 */
const BLOCKED_PR_ROOT_SENTINEL = "/nonexistent-rmd-board-root";

function deriveBoardBlockedPrs(
  deps: BoardDeps,
  lines: Array<Record<string, unknown>>,
): { blockedPrs: BlockedPrBlocker[]; blockedPrsUnverifiedReason?: string } {
  const model = buildStatusBoard(BLOCKED_PR_ROOT_SENTINEL, deps.ledgerPath, {
    queryService: () => ({ running: false, pid: null }),
    repoDir: BLOCKED_PR_ROOT_SENTINEL,
    readLedger: () => lines,
    resolveOriginMainSha: () => undefined,
    github: deps.github,
    now: deps.now,
    grepAnchorTrue: () => false,
    readProposalRegistry: () => [],
    readDraftCache: () => ({}),
  });
  const blockedPrs = model.blockers.rows.filter((r): r is BlockedPrBlocker => r.kind === "blocked_pr");
  return { blockedPrs, blockedPrsUnverifiedReason: model.blockers.blockedPrsUnverifiedReason };
}

/**
 * The board snapshot, reusing {@link projectPlan} verbatim for the merge-state — no new
 * derivation logic. W1-T155's full status taxonomy (in-flight `phase`, `startedAt`/`elapsedMs`,
 * `needsHuman`, `armedAwaitingMerge`) is carried on {@link StatusProjection} itself, so every
 * task gets it for free through that SAME pass-through. W1-T157 additionally joins each
 * projection with its plan `Task`'s `title`/`risk` and the ledger's `lastActivityAt` to produce
 * a {@link BoardRow} (see that interface's note for why the join lives here, not on the shared type).
 */
export function computeBoardSnapshot(deps: BoardDeps): BoardSnapshot {
  // READ THE LEDGER ONCE (W1-T184, extending W1-T187's same discipline): this function used
  // to read+parse the ledger TWICE — once inside `projectPlan` (itself already amortized to a
  // single read across every task, per that task's own header) and once more here for
  // `lastActivityByTask`. `liveRunSpend` below needs the same lines a third time. Read once and
  // hand `projectPlan` an overriding `readLedger` so its own internal amortization sees the SAME
  // already-parsed array, rather than re-reading a file that cannot have changed mid-call.
  const readLedger = deps.readLedger ?? readLedgerLines;
  const lines = readLedger(deps.ledgerPath);
  const effectiveDeps: BoardDeps = { ...deps, readLedger: () => lines };
  const byId = projectPlan(deps.plan, effectiveDeps);
  const lastActivity = lastActivityByTask(lines);
  const tasks: BoardRow[] = [...byId.values()].map((p) => {
    // Most projections' taskId is one of the plan's own tasks (projectPlan derives the bulk of
    // its rows from deps.plan.tasks) — but W1-T283 added a SECOND source: a task-less
    // escalation's own row, keyed by whatever id its ledger line named, which owns no plan
    // Task to join title/risk from. Fall back to the escalation's own title (or the bare id)
    // and the plan's default risk band rather than a non-null assertion that would crash the
    // whole snapshot the first time such a row appeared.
    const task = deps.plan.byId.get(p.taskId);
    const row: BoardRow = {
      ...p,
      title: task ? task.title : (p.escalationTitle ?? p.taskId),
      risk: task ? task.risk : DEFAULT_RISK,
    };
    const ts = lastActivity.get(p.taskId)?.ts;
    if (ts) row.lastActivityAt = ts;
    if (p.phase) {
      const spend = liveRunSpend(lines, p.taskId);
      if (spend?.hasData) {
        row.liveSpendUsd = spend.spendUsd;
        row.liveTurns = spend.turns;
      } else if (spend) {
        // In flight but nothing logged yet ⇒ "no data yet", NOT $0.000 / 0 turns.
        row.liveSpendPending = true;
      }
    }
    const reviewState = deriveReviewState(p.prUrl, deps.github);
    if (reviewState) row.reviewState = reviewState;
    return row;
  });
  // ONE freshness/honesty payload for the header (fb-1784902052582-c124f9): the counts derive
  // from the SAME `tasks` the rows render (never a second predicate that can disagree), and the
  // merge tally is flagged UNKNOWN when the GitHub read that backs merge-state was unreachable —
  // so "0 merged" is never rendered as fact during an outage.
  const github_unreachable = safeReadFailed(deps.github);
  const now = deps.now ?? Date.now;
  const { blockedPrs, blockedPrsUnverifiedReason } = deriveBoardBlockedPrs(deps, lines);
  return {
    generated_at: new Date().toISOString(),
    github_unreachable,
    counts: summarizeCounts(tasks, github_unreachable),
    spend: computeGlanceSpend(lines, now()),
    tasks,
    blockedPrs,
    blockedPrsUnverifiedReason,
  };
}

/** One in-flight predicate, shared by the header tally AND the NOW rows so they can never
 * disagree (fb-1784902052582-c124f9): a task is "running" iff it carries a live run `phase` —
 * exactly what {@link renderNow} filters on. */
export function isRunningRow(row: Pick<BoardRow, "phase">): boolean {
  return row.phase != null;
}

/**
 * One STOPPED predicate, shared by the header tally and (textually mirrored) by the GLANCE strip's
 * own client-side recompute in serve.ts's `renderGlanceStrip`.
 *
 * WHY `status === "blocked"` ALONE WAS WRONG, measured. On 2026-08-03 at 02:22:47Z the live board
 * carried 318 rows, of which ZERO had `status === "blocked"` while TWO — W1-T288 and W1-T290 —
 * carried `needsHuman: true` with open escalation issues (#1161, #1158). Both were genuinely
 * stopped; neither was counted. `blocked` read 0 at the exact moment two things needed a human.
 * `status` never becomes `"blocked"` on that path: W1-T288 sat at `queued` (its dispatch circuit
 * breaker tripped) and W1-T290 at `running` (its PR was open with a failed review), because
 * `deriveStatus` sets `needsHuman` as a SEPARATE field beside `status`, never by overwriting it
 * (status.ts's two writers, at the `resolveEscalation` guard and the task-less-escalation loop).
 *
 * WHY THIS DOES NOT DOUBLE-COUNT AGAINST `needs me`. `needsHuman` is set ONLY by those two writers
 * and ONLY when `resolveEscalation` reports an OPEN escalation that no later `run.start` has
 * superseded — never for a merely slow or queued task. So the sets nest: every `needs me` row is a
 * `blocked` row, and `blocked` additionally holds plan-declared `status: "blocked"` tasks that have
 * no issue to click. `needs me` answers "what can I act on", `blocked` answers "what is stopped".
 *
 * NOT the five-state row BADGE. `statusColorKey` (serve.ts) deliberately renders a needs-human row
 * as "needs human" rather than "blocked" — one badge per row, needs-human winning. That is a
 * rendering choice about a single row and is left exactly as it is; this is a COUNT over rows, and
 * a count of stopped work legitimately spans both badges.
 */
export function isBlockedRow(row: Pick<BoardRow, "status" | "needsHuman">): boolean {
  return row.status === "blocked" || row.needsHuman === true;
}

/** The header count summary, computed from the SAME task set the rows render. `merged_known` is
 * false when the GitHub read backing merge-state was unreachable — the console then renders the
 * merged tally as "unknown", never `0` as fact (fb-1784902052582-c124f9). */
export function summarizeCounts(
  tasks: Array<Pick<BoardRow, "phase" | "status" | "needsHuman">>,
  githubUnreachable: boolean,
): CountSummary {
  return {
    total: tasks.length,
    running: tasks.filter(isRunningRow).length,
    merged: tasks.filter((t) => t.status === "merged" || t.status === "done").length,
    queued: tasks.filter((t) => t.status === "queued").length,
    blocked: tasks.filter(isBlockedRow).length,
    merged_known: !githubUnreachable,
  };
}

/**
 * LIVE ACCUMULATED SPEND/TURNS (W1-T184): sum `cost_usd`/`num_turns` over every
 * `implement.done`/`fix.done` line for `taskId` SINCE its latest `run.start` — mirroring {@link
 * deriveRunState}'s OWN reset rule (task_id + `run.start`/`verdict`, never `run_id`), not a
 * separate narrower one. A prior version of this scan required every summed line to carry the
 * SAME `run_id` as the `run.start` line — which silently dropped every cold fix-rung dispatch
 * (rmd sweep's `dispatchFix`/rmd fix's bootstrap, run-task.ts's `buildSweepEffects`): those stamp
 * their `fix.dispatch`/`fix.done` lines with the OUTER sweep/fix invocation's OWN pseudo `run_id`
 * ("SWEEP-<ts>"/"FIX-<ts>"), never the original run's — while still carrying the task's REAL
 * `task_id`, which is exactly what {@link deriveRunState} keys its own inFlight/phase scan on.
 * The result: a task correctly rendered `phase: "fix-rung"` (in flight) while its live spend
 * silently stayed frozen at the ORIGINAL run's total, invisible for the whole fix-rung duration —
 * the exact "tonight's post-merge burn was invisible on an open console" falsifier (two fix
 * rungs, ~1.24 USD/38 turns then ~1.30 USD/38 turns, ~2.54 USD/76 turns total, every line
 * present in the ledger as it happened). Deliberately narrow to those two step names (never a
 * blanket sum of every `cost_usd` field) — `budget.warning`/`verdict` lines log the RUNNING
 * TOTAL, not an incremental amount, so summing those too would double-count exactly the spend
 * `implement.done`/`fix.done` already report (verified against run-task.ts's own `log(...)` call
 * sites, not assumed). Returns undefined only when the task has no run currently in flight — the
 * phase/inFlight taxonomy above already guarantees one exists whenever this is called.
 */
function liveRunSpend(lines: Array<Record<string, unknown>>, taskId: string): { spendUsd: number; turns: number; hasData: boolean } | undefined {
  let inFlight = false;
  let spendUsd = 0;
  let turns = 0;
  // NO DATA YET vs a real zero (fb-1784902052582-c124f9): a run that has logged `run.start`
  // but no `implement.done`/`fix.done` yet has ACCUMULATED nothing — its spend/turns are
  // UNKNOWN, not `0`. `hasData` records whether any spend/turns line landed since the latest
  // `run.start`, so the console can render "no data yet" instead of `$0.000 / 0 turns` as fact.
  let hasData = false;
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    if (line.step === "run.start") {
      inFlight = true;
      spendUsd = 0;
      turns = 0;
      hasData = false;
      continue;
    }
    if (line.step === "verdict") {
      inFlight = false;
      continue;
    }
    if (!inFlight) continue;
    if (line.step !== "implement.done" && line.step !== "fix.done") continue;
    if (typeof line.cost_usd === "number") spendUsd += line.cost_usd;
    if (typeof line.num_turns === "number") turns += line.num_turns;
    hasData = true;
  }
  return inFlight ? { spendUsd, turns, hasData } : undefined;
}

/**
 * Memoized {@link computeBoardSnapshot} (W1-T184, the GET /v1/status recompute-cadence
 * criteria): a recompute (re-deriving every task's status — `projectPlan`'s O(tasks) `gh`/ledger
 * work) only happens when something the projection actually depends on has changed; an unchanged
 * input returns the SAME cached snapshot instantly, however many times `.get()` is called. This
 * is the fix for the 2026-07-20 latency outage (GET /v1/status at 58.7s/54.0s/34.5s, measured
 * with a ledger polled every {@link DEFAULT_POLL_MS} but never cached across requests). Because
 * every consumer here is synchronous (the real {@link GitHub} gateways shell `gh` via
 * `execFileSync`, which blocks Node's single event-loop thread for its whole duration), no two
 * recomputes can ever be truly concurrent — so this same memo also satisfies "N requests
 * arriving during a recompute window trigger ONE computation": by construction, every request
 * whose handler runs while the cache is still valid is a cache hit, and only ONE recompute ever
 * runs to produce the next one.
 *
 * NOT ledger-length-only, and DELIBERATELY NOT time/TTL-based either: a clock-based expiry
 * either recomputes needlessly often (a TTL short enough to catch a GitHub-only change quickly
 * defeats the whole point across a burst of poll ticks spaced at or above that TTL) or too
 * rarely (a TTL long enough to survive a poll burst misses a GitHub-only change for that whole
 * window) — and either way makes the cache's behavior a function of WALL-CLOCK TIMING, which a
 * test has no reliable way to pin down. The actual second input `derivePrPrecedence`'s rungs
 * (b)/(c) depend on is the live {@link GitHub} gateway's OBSERVABLE HEALTH — `readFailed()` —
 * which can flip with NO new ledger line at all (the gateway itself recovers/fails). So the
 * cache key is `(ledger line count, readFailed())`: unchanged on BOTH -> cache hit, no matter how
 * much time passes or how many ticks land; either one changes -> exactly one fresh recompute. A
 * test proves exactly the GitHub-only case (a GitHub-outage banner that must clear on the
 * gateway's next successful read, ledger untouched throughout) deterministically, with no sleep.
 */
export interface BoardSnapshotCache {
  get(deps: BoardDeps): BoardSnapshot;
}

/**
 * `github.readFailed?.()` guarded (W1-T184 hardening): every OTHER {@link GitHub} method this
 * module calls into GitHub through is already wrapped where it matters (see
 * {@link decoratePrTitle}'s own note on why a defensive try/catch is load-bearing here, not
 * merely tidy) — this ONE call sat outside any guard, so a gateway that throws from
 * `readFailed()` itself (not merely a fail-soft null/false, the exact malformed-gateway shape
 * the RECENT feed's own throwing-gateway test already covers for `prByRef`) would blow up the
 * cache-key computation and 500 the WHOLE /v1/status request rather than degrade one field. Fails
 * CLOSED (treats an unreadable health signal as "GitHub is having a bad day") rather than open,
 * since the whole point of `readFailed()` is never to under-report an outage.
 */
function safeReadFailed(github: BoardDeps["github"]): boolean {
  try {
    return github.readFailed?.() ?? false;
  } catch {
    return true;
  }
}

/**
 * W1-T914: the row's `reviewState` — bound to {@link GitHub.reviewState} (status.ts's
 * combined-status read), never a second derivation. Returns `undefined` for a row with no PR at
 * all (nothing to render), so the caller only ever sets {@link BoardRow.reviewState} when there
 * is something to say.
 *
 * THE THREE FAIL-SOFT CASES, KEPT DISTINCT ON PURPOSE (this task's whole point):
 *   - the gateway doesn't implement {@link GitHub.reviewState} at all (an older fixture/gateway)
 *     -> `"none"`: honestly unresolved, never a guessed pending or green.
 *   - the method itself returned a real value (INCLUDING its own `"none"` and, W1-T2235, its
 *     own `"not-applicable"` for a terminal row) -> that value, verbatim — this is the ONLY arm
 *     that can produce `"pending"`/`"success"`/`"failure"`/`"not-applicable"`.
 *   - the method returned `undefined` (its own read failed) OR THREW -> `"unreadable"` when
 *     `readFailed()` confirms GitHub is having a bad day, `"none"` otherwise (a `prUrl` this
 *     gateway simply cannot resolve a head for, e.g. it fell out of the batched index) — the
 *     SAME failure/absence split {@link safeReadFailed} already draws for the header tally, so
 *     a genuine outage never renders as "no review posted" and a merely-unresolvable PR never
 *     renders as "GitHub is down".
 */
export function deriveReviewState(
  prUrl: string | undefined,
  github: BoardDeps["github"],
): BoardRow["reviewState"] {
  if (!prUrl) return undefined;
  if (!github.reviewState) return "none";
  try {
    const state = github.reviewState(prUrl);
    if (state !== undefined) return state;
    return safeReadFailed(github) ? "unreadable" : "none";
  } catch {
    return safeReadFailed(github) ? "unreadable" : "none";
  }
}

export function createBoardSnapshotCache(): BoardSnapshotCache {
  let cached: { ledgerLen: number; ghFailed: boolean; snapshot: BoardSnapshot } | undefined;
  // ONE persistent tail cursor for this route's whole lifetime (never reconstructed per request,
  // mirroring RecentActivityCache/the SSE stream's own `lastLineCount`) — see readLedgerTail's
  // own doc for why this is the fix for a cache HIT still paying a full ledger re-read+re-parse
  // just to compute `ledgerLen`, which degraded exactly like the 2026-07-20 GET /v1/status outage
  // (58.7s/54.0s/34.5s, never improving) as the ledger grew without bound.
  const tail = createLedgerTailCache();
  return {
    get(deps: BoardDeps): BoardSnapshot {
      const readLedger = deps.readLedger ?? ((path: string) => readLedgerTail(path, tail));
      const ledgerLen = readLedger(deps.ledgerPath).length;
      // readFailed() is itself cheap/idempotent here: ghGateway's is a sticky flag read (no `gh`
      // call), and buildBatchedGithub's own index() is already TTL-cached internally — neither
      // gateway shells out again just because THIS check asked.
      const ghFailed = safeReadFailed(deps.github);
      if (cached && cached.ledgerLen === ledgerLen && cached.ghFailed === ghFailed) return cached.snapshot;
      // Hand computeBoardSnapshot the SAME already-resolved reader (and, on the default path, the
      // SAME already-read `lines` array `readLedger` above just produced) rather than letting it
      // re-resolve `deps.readLedger ?? readLedgerLines` on its own — one read, not two.
      const snapshot = computeBoardSnapshot({ ...deps, readLedger });
      cached = { ledgerLen, ghFailed, snapshot };
      return snapshot;
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * `GET /v1/status`'s body — the memoized {@link BoardSnapshot} plus, when `lastSeen` is wired
 * (W1-T163), the caller token's own "since you last checked" recap. `recap`/`sinceCheckpoint` are
 * BOTH absent when `buildStatusRoute` is built with no `lastSeen` store at all, so a caller that
 * predates W1-T163 sees an UNCHANGED response shape — never a new required field to ignore.
 */
export interface StatusResponse extends BoardSnapshot {
  /** Every recap-worthy event (lib/recap.ts) after this token's PRIOR marker — `[]` on this
   *  token's first-ever view (there is no prior marker to recap FROM, so nothing renders rather
   *  than the token's entire ledger history dumped as though it all happened "since" nothing). */
  recap?: RecapEvent[];
  /** This token's marker value BEFORE this request advanced it — the timestamp {@link recap} was
   *  computed as-of. `undefined` on a first-ever view (no prior marker existed). */
  sinceCheckpoint?: string;
}

/**
 * The request HEADER a caller sets to say "a HUMAN is looking at this response, mark it seen".
 * Absent ⇒ the request is an automatic poll and MUST NOT advance the marker.
 *
 * WHY A HEADER AND NOT `?ack=1`. A query param was this fix's first shape and it BROKE two shipped
 * first-paint tests: `test/serve.first-paint.test.ts` intercepts the poll with
 * `page.route("**' + '/v1/status")`, a Playwright glob that matches the bare path and NOT
 * `/v1/status?ack=1`, so the shell's very first fetch slipped past the interception those tests
 * exist to impose. Fourteen `/v1/status` sites across the suite are written against that same bare
 * path. A header carries the one bit without touching the URL, so the request line stays
 * byte-identical to what every existing caller, interception and hand-run `curl` already matches.
 */
export const RECAP_ACK_HEADER = "x-rmd-recap-ack";

/** Is this `GET /v1/status` an acknowledged view, or an automatic poll? Presence is the signal. */
export function requestAcknowledgesRecap(headerValue: string | string[] | undefined): boolean {
  return headerValue !== undefined;
}

/**
 * GET /v1/status — the board snapshot, read-scoped, memoized per {@link createBoardSnapshotCache}.
 * W1-T163: when `lastSeen` (lib/last-seen.ts) is supplied, a view also reads the calling token's
 * own recap off its CURRENT marker and folds it into the response.
 *
 * THE MARKER ADVANCES ONLY ON AN ACKNOWLEDGED VIEW, NOT ON EVERY REQUEST. W1-T163's
 * intent — "viewing the board advances the marker", so an immediate reload recaps nothing — is
 * correct and is PRESERVED: the shell sets {@link RECAP_ACK_HEADER} on exactly the one fetch per page load whose
 * recap it actually renders (its own `recapRendered` gate), so a reload still recaps nothing.
 *
 * WHAT WAS BROKEN. The advance was unconditional while the shell re-fetches this route every
 * `POLL_INTERVAL_MS` (3000ms, serve.ts). An automatic poll is indistinguishable from a human at
 * the wire, so a tab left open advanced its own marker every three seconds and its recap window
 * was permanently ~3s wide. Measured live 2026-08-03T02:22:47Z: `sinceCheckpoint`
 * 02:22:28.933Z against `generated_at` 02:22:47.152Z — an 18-second window — and `recap: []`.
 * The operator's actual use is a tab left open all evening, which is exactly the case that lost
 * every event it was built to show him.
 *
 * WHY AN OPT-IN REQUEST SIGNAL AND NOT THE ALTERNATIVES. A POST acknowledge would need WRITE scope, and the
 * operator's bookmark carries only the READ token — the one client that must be able to ack could
 * not. A second route duplicates the whole board handler and forces every existing caller to
 * choose. A client-side `document.hidden` check does not separate the two cases at all: a tab left
 * open while he is away is still visible. Advancing on `focus`/`visibilitychange` adds listeners
 * for an event a never-blurred tab never fires.
 *
 * THE DEFAULT IS DELIBERATELY "DO NOT ADVANCE". A caller that never acks accumulates recap rather
 * than losing it — too much history is a nuisance, none is the defect being fixed here.
 *
 * `lastSeen` is OPTIONAL and defaults to undefined (no recap at all) so a caller that hasn't wired
 * a store yet keeps today's exact response shape.
 */
export function buildStatusRoute(deps: BoardDeps, lastSeen?: LastSeenStore): Route {
  const cache = createBoardSnapshotCache();
  return {
    method: "GET",
    path: "/v1/status",
    scope: "read",
    handler: (req, res) => {
      const snapshot = cache.get(deps);
      if (!lastSeen) {
        sendJson(res, 200, snapshot);
        return;
      }
      const tokenId = bearerTokenId(req);
      const sinceCheckpoint = lastSeen.get(tokenId);
      const recap =
        sinceCheckpoint === undefined
          ? []
          : buildRecapEvents(deps.readLedger?.(deps.ledgerPath) ?? readLedgerLines(deps.ledgerPath), sinceCheckpoint, deps.plan);
      // Advance AFTER computing the recap, off the SAME timestamp the snapshot itself claims to
      // be current as of -- never `Date.now()` a second time, which could race a hair ahead of
      // what this response actually reflects. Gated on the ack flag: see this function's doc.
      if (requestAcknowledgesRecap(req.headers[RECAP_ACK_HEADER])) lastSeen.advance(tokenId, snapshot.generated_at);
      const body: StatusResponse = { ...snapshot, recap, sinceCheckpoint };
      sendJson(res, 200, body);
    },
  };
}

// ── GET /v1/recent — the LEDGER-FIRST activity feed (W1-T184, W1-T153's RECENT section) ───────
//
// FIXTURE 1 (2026-07-20): RECENT used to be sourced from `computeBoardSnapshot`'s GitHub-derived
// terminal status, so a batched-gateway outage (the W1-T181 ENOBUFS incident) rendered "no
// recent outcomes yet" over a week containing ~100 merges — the ledger held every one of those
// merges the entire time. FIXTURE 2 (2026-07-20): a post-merge burn (two fix rungs, ~2.54 USD /
// 76 turns) was INVISIBLE on an open console even though every event was in the ledger as it
// happened, because RECENT only ever showed a task's FINAL state, never its per-event spend.
//
// THE FIX: RECENT is now an activity FEED over the ledger's own event classes — merges/verdicts
// (`verdict` lines), fix-rung outcomes (`fix.dispatch`/`fix.done`/`fix.exhausted`), escalations
// (`escalation.issue_opened`), and spend checkpoints (`implement.done`) — never routed through
// `deriveStatus`/`projectPlan`'s GitHub-gated precedence rungs at all. GitHub is consulted ONLY
// to DECORATE a row that already carries a PR link (the PR's title, via the SAME `prByRef` every
// other caller uses) — a failed/absent decoration marks the row `githubUnavailable`, it never
// removes it (see {@link decoratePrTitle}).

export type RecentActivityVerb = "merged" | "verdict" | "fix" | "escalated" | "spend" | "run-refused" | "run-started";

/**
 * The steps that record the daemon's RESOLUTION of an operator-initiated console action (W1-T266).
 *
 * WHY THIS SET EXISTS AT ALL. On 2026-07-31 the operator clicked Run on W1-T152, a task he had
 * credited as merged an hour earlier. The whole pipeline worked: the marker was written, the daemon
 * consumed it inside a minute, and refused it correctly — `console.kick_refused` at 11:18:10.571Z,
 * `reason: "already merged — stale kick"`. He saw NOTHING, and reported the console as broken. The
 * refusal was written to the ledger and then dropped by the `!task` guard in
 * {@link computeRecentActivity}, because the daemon stamps its OWN pseudo-id (`task_id: "DAEMON"`)
 * on every line it emits. `/v1/drain/kick` returns 200 for "marker dropped", so the POST genuinely
 * succeeded — the activity feed is the ONLY surface that can carry this.
 *
 * WHY AN ALLOWLIST RATHER THAN REMOVING THE `!task` GUARD. That guard is load-bearing. Measured
 * over the ledger unioned across all 661 rotations (4,156,857 lines spanning 411 hours):
 * `SWEEP` 600,281 lines (1,461/hour), `DAEMON` 169,860 (413/hour), `SERVE` 93,907 (228/hour).
 * DAEMON's own traffic is 71% `dispatch.indeterminate` (120,984 lines) plus board-gateway fetch
 * telemetry every 15 seconds. Dropping the guard would bury the feed.
 *
 * WHY THESE TWO STEPS AND NOTHING ELSE. Both are the daemon's answer to a click a human made, and
 * both are rare enough to cost nothing: over the same 411 hours the union holds FOUR
 * `console.kick_refused` lines in total — about 0.01/hour. `console.kick_requested` is deliberately
 * excluded: the button already shows the operator their own click through its arm-then-confirm
 * state, so echoing the request adds a row without adding information. The missing information was
 * always the RESOLUTION.
 *
 * These lines carry the real task id in `line.task` (the daemon's `log` closure owns `task_id`), so
 * {@link computeRecentActivity} reads the id from there for exactly these steps.
 */
const OPERATOR_ACTION_STEPS = new Set(["console.kick_refused", "console.kick_dispatched"]);

/** One RECENT row: a single ledger EVENT (not a task's final state) — see this section's header. */
export interface RecentActivityEntry {
  taskId: string;
  /** The plan task's own title — RECENT names WHAT a row is, not just its id (2026-07-20 operator report). */
  title: string;
  verb: RecentActivityVerb;
  /** ISO-8601 `ts` of the originating ledger line — the feed's relative-timestamp source. */
  ts: string;
  /** The originating step's own outcome label (e.g. a `verdict` string, an escalation `class`). */
  detail?: string;
  /** Present wherever the originating ledger line carries `cost_usd` (design note: "spend where the ledger has it"). */
  costUsd?: number;
  numTurns?: number;
  prNumber?: number;
  prUrl?: string;
  /** GitHub DECORATION (never a gate) — the PR's title, present only when a read actually resolved it. */
  prTitle?: string;
  /** GitHub DECORATION attempted and FAILED for this row's own `prUrl` — the row still renders, ledger-only. */
  githubUnavailable?: true;
}

/** Bounded rolling history a {@link RecentActivityCache} holds — large enough that `max` (the
 *  feed's visible window) is always a small tail slice of it, never the whole thing. */
const RECENT_ACTIVITY_HISTORY_CAP = 200;

interface RecentActivityState {
  /** How many ledger lines have already been scanned/classified — the SAME tail-cursor idiom
   *  {@link buildStatusStream}'s `lastLineCount` already uses, reused here (not reinvented) so a
   *  render never re-classifies (and never re-fetches GitHub for) a line it has already minted
   *  an entry from — the "no full re-read/re-derive per render" performance criterion. */
  scannedLines: number;
  /** Minted entries, oldest first, capped to {@link RECENT_ACTIVITY_HISTORY_CAP}. */
  entries: RecentActivityEntry[];
  /** `run_id` -> its `pr.opened` PR url — carries a run's OWN PR forward onto later lines (e.g.
   *  `verdict`/`fix.done`) that name no `pr_url` of their own. */
  prByRun: Map<string, string>;
  /** The FILE-LEVEL tail cursor {@link readLedgerTail} reads/writes — one layer below
   *  `scannedLines`' line-level cursor. `scannedLines` alone stops this module from
   *  re-decorating/re-classifying an already-seen LINE, but every call still paid a full
   *  `readFileSync`+re-parse of the WHOLE ledger to produce that line array in the first place;
   *  this is what makes even THAT read O(new bytes), not O(history) — see readLedgerTail's doc. */
  ledgerTail: LedgerTailCache;
}

/** Opaque handle a caller holds across requests (one per `buildRecentRoute` instance, mirroring
 *  {@link BoardSnapshotCache}) — never reconstructed per render, or the tail-cursor is pointless. */
export interface RecentActivityCache {
  /** @internal — read/written only by {@link computeRecentActivity}. */
  state: RecentActivityState;
}

export function createRecentActivityCache(): RecentActivityCache {
  return { state: { scannedLines: 0, entries: [], prByRun: new Map(), ledgerTail: createLedgerTailCache() } };
}

function prNumberFromUrl(url: string): number | undefined {
  const n = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** GitHub DECORATION (never a gate, W1-T184's central rule): resolve `prUrl`'s title via the
 *  SAME `prByRef` every other precedence rung already calls — no new GitHub surface. A missing
 *  title (PR not found, or the gateway simply doesn't carry one) is silent (the row already
 *  renders fine ledger-only); a gateway that reports `readFailed()` marks the row explicitly,
 *  per W1-T181's marked-failure signal, so the operator sees "GitHub unreachable" rather than a
 *  row that merely looks a little sparser than usual. */
function decoratePrTitle(entry: RecentActivityEntry, deps: BoardDeps): RecentActivityEntry {
  if (!entry.prUrl) return entry;
  // FAIL-SOFT BY CONSTRUCTION, not merely by convention: every real gateway's methods are
  // documented fail-soft (null on error, never a throw), but this decoration is the ONE place
  // in the codebase where a GitHub read result feeds straight into an HTTP response with no
  // caller-side derivation layer to absorb a surprise throw. A defensive try/catch here is the
  // difference between "one row degrades" and "the whole /v1/recent request 500s" — which would
  // itself reproduce the empty-RECENT fixture this task exists to fix, just via a crash instead
  // of an empty array. BOTH github calls below (`prByRef` AND `readFailed`) live inside this SAME
  // try — an earlier version only guarded `prByRef`, so a gateway that throws from `readFailed()`
  // itself (rather than merely reporting it, fail-soft) still 500'd the whole request and emptied
  // the feed, uncaught past this function's own return.
  try {
    const pr = deps.github.prByRef(entry.prUrl);
    if (pr?.title) return { ...entry, prTitle: pr.title };
    if (deps.github.readFailed?.()) return { ...entry, githubUnavailable: true };
    return entry;
  } catch {
    return { ...entry, githubUnavailable: true };
  }
}

/** Longest refusal reason a RECENT row will carry. See {@link boundedReason}. */
const MAX_REFUSAL_REASON_CHARS = 120;

/**
 * A refusal `reason`, bounded so ONE row cannot swallow the feed (W1-T266).
 *
 * NOT a hypothetical bound. `assertRunnable` refuses a blocked task by echoing the task's whole
 * blocked note, and the live ledger holds a real example: the `console.kick_refused` for W1-T201
 * at 2026-07-31T11:31:40.551Z carries a reason of roughly four thousand characters — the entire
 * FILED diagnosis, prior proof text and falsifiers. Rendered inline that is not an activity row,
 * it is a wall, and the trap this feature has to avoid is a feed the operator stops reading.
 *
 * Truncation is VISIBLE (a trailing ellipsis), never silent: a reason that has been cut must not
 * read as a reason that was short.
 */
function boundedReason(reason: unknown): string {
  if (typeof reason !== "string" || reason === "") return "no reason recorded";
  return reason.length <= MAX_REFUSAL_REASON_CHARS ? reason : `${reason.slice(0, MAX_REFUSAL_REASON_CHARS)}…`;
}

/**
 * The activity feed's own event classification — ONE ledger line in, at most ONE
 * {@link RecentActivityEntry} out (or `undefined` for every step name this feed does not
 * surface). Pure and separate from the stateful scan below so the mapping itself is easy to
 * audit against the design note's event-class list.
 */
function classifyLine(
  line: Record<string, unknown>,
  taskId: string,
  title: string,
  ts: string,
  prUrl: string | undefined,
): RecentActivityEntry | undefined {
  const prNumber = prUrl ? prNumberFromUrl(prUrl) : undefined;
  const costUsd = typeof line.cost_usd === "number" ? line.cost_usd : undefined;
  const numTurns = typeof line.num_turns === "number" ? line.num_turns : undefined;
  switch (line.step) {
    case "verdict": {
      const verdict = typeof line.verdict === "string" ? line.verdict : "unknown";
      return { taskId, title, ts, verb: verdict === "merged" ? "merged" : "verdict", detail: verdict, costUsd, prUrl, prNumber };
    }
    case "fix.dispatch":
      return { taskId, title, ts, verb: "fix", detail: `dispatched (strike ${String(line.strike ?? "?")})`, prUrl, prNumber };
    case "fix.done":
      return { taskId, title, ts, verb: "fix", detail: `done (strike ${String(line.strike ?? "?")})`, costUsd, numTurns, prUrl, prNumber };
    case "fix.exhausted":
      return { taskId, title, ts, verb: "fix", detail: `exhausted (${String(line.strikes ?? "?")} strikes)`, prUrl, prNumber };
    case "escalation.issue_opened":
      return { taskId, title, ts, verb: "escalated", detail: typeof line.class === "string" ? line.class : undefined, prUrl, prNumber };
    case "implement.done":
      return { taskId, title, ts, verb: "spend", costUsd, numTurns, prUrl, prNumber };
    // W1-T266 — the daemon's resolution of an operator's Run click. See OPERATOR_ACTION_STEPS.
    // The `reason` is carried VERBATIM (bar the length bound below) rather than mapped to
    // friendlier prose: a translation table here would be a second place for the truth to live,
    // and this codebase has had three false comments cause live operator-visible defects in one
    // week. The verb label supplies the plain-English framing ("Run refused"); the reason
    // supplies the fact.
    case "console.kick_refused":
      return { taskId, title, ts, verb: "run-refused", detail: boundedReason(line.reason) };
    case "console.kick_dispatched":
      return { taskId, title, ts, verb: "run-started", detail: "dispatched from the console" };
    default:
      return undefined;
  }
}

/**
 * The RECENT activity feed (W1-T184): tails `cache`'s already-scanned position, classifies only
 * the NEW ledger lines since then (see {@link RecentActivityState.scannedLines}), decorates each
 * fresh entry with GitHub ONCE at mint time (never re-decorated on a later render — the "avoid
 * re-fetching GitHub for old, already-seen lines" half of the performance criterion), and returns
 * the most recent `max`, newest first. GITHUB OUTAGE PARITY: every entry's verb/task/title/PR-
 * number/spend comes from the ledger alone; a `deps.github` that fails every call still returns
 * the IDENTICAL entries, just without `prTitle` (and with `githubUnavailable: true` wherever a
 * PR link exists) — GitHub decorates, it never gates (see {@link decoratePrTitle}).
 */
export function computeRecentActivity(deps: BoardDeps, cache: RecentActivityCache, max = 20): RecentActivityEntry[] {
  const state = cache.state;
  // Default reader is INCREMENTAL (readLedgerTail, keyed off this SAME cache's own persistent
  // ledgerTail cursor) — an unchanged ledger costs one statSync, and a grown one reads only the
  // NEW bytes, never the whole file again. `state.scannedLines` below then further limits which
  // of those (already cheaply-obtained) lines get re-classified/re-decorated — two independent
  // tail cursors, one at the file-I/O layer, one at the classification layer.
  const readLedger = deps.readLedger ?? ((path: string) => readLedgerTail(path, state.ledgerTail));
  const lines = readLedger(deps.ledgerPath);
  // A shorter ledger than last scanned should never happen (append-only) -- degrade safely by
  // rescanning from scratch rather than slicing with a negative/nonsensical offset.
  if (lines.length < state.scannedLines) {
    state.scannedLines = 0;
    state.entries = [];
    state.prByRun = new Map();
  }
  const newLines = lines.slice(state.scannedLines);
  state.scannedLines = lines.length;

  for (const line of newLines) {
    const runId = typeof line.run_id === "string" ? line.run_id : undefined;
    if (line.step === "pr.opened" && runId && typeof line.pr_url === "string") {
      state.prByRun.set(runId, line.pr_url);
    }
    // W1-T266: for the two OPERATOR_ACTION_STEPS the daemon owns `task_id` (it stamps its own
    // "DAEMON") and the task the human actually clicked is in `line.task`. Read the id from there
    // for exactly those steps, so the refusal can name the task rather than the emitting lane.
    const isOperatorAction = typeof line.step === "string" && OPERATOR_ACTION_STEPS.has(line.step);
    const taskId = isOperatorAction && typeof line.task === "string"
      ? line.task
      : typeof line.task_id === "string"
        ? line.task_id
        : undefined;
    if (!taskId) continue;
    const task = deps.plan.byId.get(taskId);
    // A pseudo-id (DAEMON/SWEEP/DRAIN/RETRO/inbox/…) is never a real plan task, and its lanes emit
    // ~2,100 lines/hour of housekeeping — so it is dropped, EXCEPT for the operator-action steps
    // above, which are ~0.01/hour and are the only reason a human ever looks at this feed after
    // pressing a button. A refusal naming an id that is not in the plan ("unknown task id") must
    // still render, so absence of a task is not itself disqualifying for those.
    if (!task && !isOperatorAction) continue;
    const ts = typeof line.ts === "string" ? line.ts : new Date().toISOString();
    const prUrl = typeof line.pr_url === "string" ? line.pr_url : runId ? state.prByRun.get(runId) : undefined;
    const entry = classifyLine(line, taskId, task?.title ?? taskId, ts, prUrl);
    if (!entry) continue;
    state.entries.push(decoratePrTitle(entry, deps));
    if (state.entries.length > RECENT_ACTIVITY_HISTORY_CAP) state.entries.shift();
  }

  return state.entries.slice(-max).reverse();
}

/** GET /v1/recent — the RECENT section's data, read-scoped. One {@link RecentActivityCache} per
 *  route instance (built once, reused by every request), mirroring {@link buildStatusRoute}. */
export function buildRecentRoute(deps: BoardDeps): Route {
  const cache = createRecentActivityCache();
  return {
    method: "GET",
    path: "/v1/recent",
    scope: "read",
    handler: (_req, res) => {
      sendJson(res, 200, { entries: computeRecentActivity(deps, cache) });
    },
  };
}

/** Every distinct `task_id` named on a ledger line, in first-seen order. */
function taskIdsOf(lines: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    if (typeof line.task_id === "string") seen.add(line.task_id);
  }
  return [...seen];
}

/**
 * GET /v1/status/stream — one `status` SSE event per task whose derived StatusProjection
 * changes, read-scoped. Subscribing primes the "last known" line count to the CURRENT
 * ledger length, so only lines appended AFTER subscribe count as flips — a client that just
 * connected is never replayed the whole ledger history.
 */
export function buildStatusStream(deps: BoardDeps, pollMs = DEFAULT_POLL_MS): SseRoute {
  return {
    path: "/v1/status/stream",
    scope: "read",
    subscribe: (send: SseSend) => {
      // ONE persistent tail cursor for this connection's whole lifetime (never reconstructed per
      // tick) — see readLedgerTail's own doc: an unchanged ledger between ticks (the common case
      // at a 250ms cadence) costs one statSync, not a full re-read+re-parse of the whole file.
      const tail = createLedgerTailCache();
      const readLedger = deps.readLedger ?? ((path: string) => readLedgerTail(path, tail));
      // Hand deriveStatus (via deriveForStream below) the SAME resolved reader, so its own
      // internal ledger read reuses this tick's already-read `lines` instead of re-resolving
      // `deps.readLedger ?? readLedgerLines` (a fresh full read) once per task, every tick.
      const effectiveDeps: BoardDeps = { ...deps, readLedger };

      // LIVE SPEND/TURNS OVER SSE (W1-T184 fix): the SSE payload used to be a bare
      // `deriveStatus(task, deps)` — never carrying `liveSpendUsd`/`liveTurns` at all, even
      // though this is the client's PRIMARY low-latency transport (the REST poll is a 3s
      // fallback/resync). Worse, the client's `ingestProjection` spreads each incoming SSE
      // payload over the previously-known row, so an SSE flip with no spend fields silently
      // WIPED whatever spend the last REST poll had shown — the "tonight's burn was invisible"
      // fixture reproduced by the fix rung's OWN status-changing ledger lines. Enrich the SAME
      // way `computeBoardSnapshot` does, off the SAME already-read `lines` this tick already has.
      const deriveForStream = (
        task: Task,
        lines: Array<Record<string, unknown>>,
      ): StatusProjection & { liveSpendUsd?: number; liveTurns?: number } => {
        const projection = deriveStatus(task, effectiveDeps);
        if (!projection.phase) return projection;
        const spend = liveRunSpend(lines, task.id);
        return spend ? { ...projection, liveSpendUsd: spend.spendUsd, liveTurns: spend.turns } : projection;
      };

      // Prime `lastSent` with EVERY task's current (enriched) projection (the same baseline
      // GET /v1/status would return right now), not an empty map — otherwise the first ledger
      // line touching a task would always look like a "flip" even when deriveStatus lands
      // on the exact state the client already has.
      const primingLines = readLedger(deps.ledgerPath);
      let lastLineCount = primingLines.length;
      const lastSent = new Map<string, string>(deps.plan.tasks.map((t) => [t.id, JSON.stringify(deriveForStream(t, primingLines))]));

      const tick = () => {
        const lines = readLedger(deps.ledgerPath);
        if (lines.length <= lastLineCount) return;
        const newLines = lines.slice(lastLineCount);
        lastLineCount = lines.length;

        for (const taskId of taskIdsOf(newLines)) {
          const task = deps.plan.byId.get(taskId);
          if (!task) continue; // a ledger line for a task not (or no longer) in the plan.
          // Re-derive off the FULL `lines` (not just `newLines`) — liveRunSpend needs the
          // task's whole current run, and deriveStatus itself always re-reads the ledger too.
          const projection = deriveForStream(task, lines);
          const serialized = JSON.stringify(projection);
          if (lastSent.get(taskId) === serialized) continue; // no actual flip (incl. spend) — don't spam.
          lastSent.set(taskId, serialized);
          send("status", projection);
        }
      };

      const timer = setInterval(tick, pollMs);
      return () => clearInterval(timer);
    },
  };
}

// ── FIND-layer sort comparators (W1-T157) ──────────────────────────────────────────────────
//
// Pure comparators over {@link BoardRow}, one per sortable column (id, status, recency, age).
// The operator console's inline script (src/lib/serve.ts) MIRRORS these for its own client-side
// sort — that script is a bundler-less template literal and cannot import this module — so these
// exported functions are the canonical, unit-tested SPEC of the ordering (test/board.test.ts),
// kept structurally identical to the inline copies. Each takes an explicit direction so the
// "a missing value always sorts LAST, in BOTH directions" rule (recency/age) is expressed HERE,
// once, rather than by a caller that merely reverses the sorted array (which would flip it).

export type BoardSortKey = "id" | "status" | "recency" | "age";
export type SortDir = "asc" | "desc";

/** `av`/`bv` compared numerically; `undefined` (no value) always sorts AFTER any value, whatever `dir`. */
function compareMissingLast(av: number | undefined, bv: number | undefined, dir: SortDir): number {
  if (av === undefined && bv === undefined) return 0;
  if (av === undefined) return 1; // a has no value -> a after b, regardless of direction
  if (bv === undefined) return -1;
  return dir === "desc" ? bv - av : av - bv;
}

/** Lexicographic by taskId. */
export function compareById(a: BoardRow, b: BoardRow, dir: SortDir): number {
  const base = a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  return dir === "desc" ? -base : base;
}

/** By index within {@link TASK_STATUSES} (queued … done). An unknown status sorts as -1 (before queued). */
export function compareByStatus(a: BoardRow, b: BoardRow, dir: SortDir): number {
  const base = TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status);
  return dir === "desc" ? -base : base;
}

/** By `lastActivityAt` (parsed to epoch ms); tasks with no ledger activity sort last, in both directions. */
export function compareByRecency(a: BoardRow, b: BoardRow, dir: SortDir): number {
  const av = a.lastActivityAt ? Date.parse(a.lastActivityAt) : undefined;
  const bv = b.lastActivityAt ? Date.parse(b.lastActivityAt) : undefined;
  return compareMissingLast(av, bv, dir);
}

/**
 * By `elapsedMs` (in-flight runs only). SIMPLIFICATION (house style — an explicit judgment call):
 * a task with no `elapsedMs` (not in flight) has no meaningful "age", so it sorts AFTER every task
 * that does — in BOTH directions — exactly like `recency`'s missing-value rule, never masquerading
 * as "very old" one way and "very new" the other.
 */
export function compareByAge(a: BoardRow, b: BoardRow, dir: SortDir): number {
  return compareMissingLast(a.elapsedMs, b.elapsedMs, dir);
}

const COMPARATORS: Record<BoardSortKey, (a: BoardRow, b: BoardRow, dir: SortDir) => number> = {
  id: compareById,
  status: compareByStatus,
  recency: compareByRecency,
  age: compareByAge,
};

/** Sort a COPY of `rows` by the given column/direction, with a stable id-ascending tiebreak. */
export function sortBoardRows(rows: readonly BoardRow[], sort: BoardSortKey, dir: SortDir): BoardRow[] {
  const cmp = COMPARATORS[sort];
  return [...rows].sort((a, b) => cmp(a, b, dir) || compareById(a, b, "asc"));
}
