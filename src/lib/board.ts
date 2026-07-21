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
import { TASK_STATUSES } from "./plan.js";
import { deriveStatus, projectPlan, readLedgerLines, type DeriveDeps, type StatusProjection } from "./status.js";
import type { Route, SseRoute, SseSend } from "./service.js";

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
}

/** GET /v1/status's body — one {@link BoardRow} per plan task, as of `generated_at`. */
export interface BoardSnapshot {
  generated_at: string;
  tasks: BoardRow[];
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
    // Every projection's taskId is one of the plan's own tasks (projectPlan derives from
    // deps.plan.tasks), so this lookup is always present — the join is total, never partial.
    const task = deps.plan.byId.get(p.taskId)!;
    const row: BoardRow = { ...p, title: task.title, risk: task.risk };
    const ts = lastActivity.get(p.taskId)?.ts;
    if (ts) row.lastActivityAt = ts;
    if (p.phase) {
      const spend = liveRunSpend(lines, p.taskId);
      if (spend) {
        row.liveSpendUsd = spend.spendUsd;
        row.liveTurns = spend.turns;
      }
    }
    return row;
  });
  return { generated_at: new Date().toISOString(), tasks };
}

/**
 * LIVE ACCUMULATED SPEND/TURNS (W1-T184): find `taskId`'s CURRENT run (the `run_id` of its
 * latest `run.start` line — mirrors {@link deriveRunState}'s own "a fresh run.start always
 * resets the scan" rule, so an earlier run's spend never leaks into a later one's total), then
 * sum `cost_usd`/`num_turns` over every `implement.done`/`fix.done` line carrying that SAME
 * `run_id`. Deliberately narrow to those two step names (never a blanket sum of every `cost_usd`
 * field) — `budget.warning`/`verdict` lines log the RUNNING TOTAL, not an incremental amount, so
 * summing those too would double-count exactly the spend `implement.done`/`fix.done` already
 * report (verified against run-task.ts's own `log(...)` call sites, not assumed). Returns
 * undefined only when the task has no `run.start` at all — the phase/inFlight taxonomy above
 * already guarantees one exists whenever this is called.
 */
function liveRunSpend(lines: Array<Record<string, unknown>>, taskId: string): { spendUsd: number; turns: number } | undefined {
  let runId: string | undefined;
  for (const line of lines) {
    if (line.task_id === taskId && line.step === "run.start" && typeof line.run_id === "string") {
      runId = line.run_id;
    }
  }
  if (!runId) return undefined;
  let spendUsd = 0;
  let turns = 0;
  for (const line of lines) {
    if (line.run_id !== runId) continue;
    if (line.step !== "implement.done" && line.step !== "fix.done") continue;
    if (typeof line.cost_usd === "number") spendUsd += line.cost_usd;
    if (typeof line.num_turns === "number") turns += line.num_turns;
  }
  return { spendUsd, turns };
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

export function createBoardSnapshotCache(): BoardSnapshotCache {
  let cached: { ledgerLen: number; ghFailed: boolean; snapshot: BoardSnapshot } | undefined;
  return {
    get(deps: BoardDeps): BoardSnapshot {
      const readLedger = deps.readLedger ?? readLedgerLines;
      const ledgerLen = readLedger(deps.ledgerPath).length;
      // readFailed() is itself cheap/idempotent here: ghGateway's is a sticky flag read (no `gh`
      // call), and buildBatchedGithub's own index() is already TTL-cached internally — neither
      // gateway shells out again just because THIS check asked.
      const ghFailed = deps.github.readFailed?.() ?? false;
      if (cached && cached.ledgerLen === ledgerLen && cached.ghFailed === ghFailed) return cached.snapshot;
      const snapshot = computeBoardSnapshot(deps);
      cached = { ledgerLen, ghFailed, snapshot };
      return snapshot;
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** GET /v1/status — the board snapshot, read-scoped, memoized per {@link createBoardSnapshotCache}. */
export function buildStatusRoute(deps: BoardDeps): Route {
  const cache = createBoardSnapshotCache();
  return {
    method: "GET",
    path: "/v1/status",
    scope: "read",
    handler: (_req, res) => {
      sendJson(res, 200, cache.get(deps));
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

export type RecentActivityVerb = "merged" | "verdict" | "fix" | "escalated" | "spend";

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
}

/** Opaque handle a caller holds across requests (one per `buildRecentRoute` instance, mirroring
 *  {@link BoardSnapshotCache}) — never reconstructed per render, or the tail-cursor is pointless. */
export interface RecentActivityCache {
  /** @internal — read/written only by {@link computeRecentActivity}. */
  state: RecentActivityState;
}

export function createRecentActivityCache(): RecentActivityCache {
  return { state: { scannedLines: 0, entries: [], prByRun: new Map() } };
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
  // of an empty array.
  try {
    const pr = deps.github.prByRef(entry.prUrl);
    if (pr?.title) return { ...entry, prTitle: pr.title };
  } catch {
    return { ...entry, githubUnavailable: true };
  }
  if (deps.github.readFailed?.()) return { ...entry, githubUnavailable: true };
  return entry;
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
  const readLedger = deps.readLedger ?? readLedgerLines;
  const lines = readLedger(deps.ledgerPath);
  const state = cache.state;
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
    const taskId = typeof line.task_id === "string" ? line.task_id : undefined;
    if (!taskId) continue;
    const task = deps.plan.byId.get(taskId);
    if (!task) continue; // a pseudo-id (DAEMON/SWEEP/DRAIN/RETRO/inbox/…), never a real plan task.
    const ts = typeof line.ts === "string" ? line.ts : new Date().toISOString();
    const prUrl = typeof line.pr_url === "string" ? line.pr_url : runId ? state.prByRun.get(runId) : undefined;
    const entry = classifyLine(line, taskId, task.title, ts, prUrl);
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
      const readLedger = deps.readLedger ?? readLedgerLines;

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
        const projection = deriveStatus(task, deps);
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
