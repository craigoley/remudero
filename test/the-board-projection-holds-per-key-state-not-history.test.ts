/**
 * W1-T9436: the heavy view lane kept one board entry per fact row it ever ingested (board:core 663,486 entries,
 * 370 MB kept bytes, serve.memory 2026-10-14T12:26:41Z). A re-derived task now reads its own rows from the fact
 * store, and the rows the now view walks are only the rows a declared retention rule holds. These tests compare
 * that board with one keeping every row (today's behaviour), and fail when a reader reads a step no rule keeps.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BOARD_ROW_PROBE_FIELDS,
  BOARD_ROW_RETENTION,
  canonicalProjection,
  createBoardProjection,
  type BoardProjection,
  type BoardProjectionOptions,
  type BoardRetentionRule,
  type Row,
} from "#src/lib/board-projection.js";
import type { Clock } from "#src/lib/clock.js";
import type { FeedbackEntry } from "#src/lib/feedback.js";
import { PLAN_ONLY_REVIEW_MARKER_STEP } from "#src/lib/ledger-carry.js";
import { createLedgerProjector, openProjectorReadModel, type LedgerProjector } from "#src/lib/ledger-projector.js";
import { createNowView, type NowViewContext, type NowViewData, type NowViewOptions } from "#src/lib/now-view.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease, type ReadModelDb, type ReadModelLease } from "#src/lib/read-model-db.js";
import { computeBoardSnapshot } from "#src/lib/board.js";
import { projectPlan, type GitHub, type PrRef } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";

type TestCtx = { after: (fn: () => void) => void };

/** Sunday 23:50 UTC: ten minutes before both a UTC day and an ISO week end. */
const NOW0 = Date.parse("2026-10-11T23:50:00.000Z");
const DAY = 24 * 60 * 60_000;
const IDS = ["W1-T1", "W1-T2", "W1-T3", "W1-T4", "W1-T5", "W1-T6", "W1-T7"];
const task = (id: string): Task => ({ id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 });
const PLAN: Plan = { tasks: IDS.map(task), byId: new Map(IDS.map((id) => [id, task(id)])) };
const url = (pr: number): string => `https://github.com/o/r/pull/${pr}`;
const at = (ms: number): string => new Date(ms).toISOString();
const HUMAN = { authority: "interactive-cli" };

/** Open pull requests: #14's GitHub head is the OLDER one its sweep rows named, #15's is one no sweep row names yet, and
 *  #99 is a hand PR the sweep files under SWEEP. */
const OPEN: PrRef[] = [
  { number: 11, url: url(11), state: "OPEN", headRefName: "run-W1-T1-1", headRefOid: "h1b", title: "one" },
  { number: 13, url: url(13), state: "OPEN", headRefName: "run-W1-T3-1", headRefOid: "h3b", title: "three" },
  { number: 14, url: url(14), state: "OPEN", headRefName: "run-W1-T4-1", headRefOid: "h4a", title: "four" },
  { number: 15, url: url(15), state: "OPEN", headRefName: "run-W1-T5-1", headRefOid: "h5c", title: "five" },
  { number: 99, url: url(99), state: "OPEN", headRefName: "hand-fix", headRefOid: "h99", title: "hand" },
];
const GATEWAY = {
  readFailed: () => false,
  prByRef: (ref: number | string) => OPEN.find((pr) => pr.number === ref || pr.url === ref) ?? null,
  findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
  listOpenHeadBranches: () => OPEN, headRefName: () => undefined, prBody: () => undefined,
  issueByUrl: (issue: string) => ({ state: issue.endsWith("/2") ? "CLOSED" : "OPEN", title: `issue ${issue}` }),
} as unknown as GitHub;

/** Every reader's steps: repeats and changes of dispositions over two heads, holds of each scope, escalations of a plan
 *  task, a task-less one and a dependency review, merges with and without a url, costs across days and weeks, an
 *  in-flight run with worker rows, a DAEMON-lane row naming a task only in `task`, and steps no now-view reader reads. */
function history(): Row[] {
  const out: Row[] = [];
  const row = (ms: number, r: Row): void => void out.push({ ts: at(ms), host: "h1", ...r });
  const old = NOW0 - 9 * DAY;
  for (let k = 1; k <= 6; k++) {
    const id = `W1-T${k}`;
    const pr = 10 + k;
    const t = old + k * 60_000;
    row(t, { step: "run.start", task_id: id, run_id: `r${k}a`, type: "implement" });
    row(t + 1_000, { step: "worker.assignment", task_id: id, run_id: `r${k}a`, model: "sonnet" });
    row(t + 2_000, { step: "implement.done", task_id: id, run_id: `r${k}a`, cost_usd: 0.2 + k / 100, num_turns: 4, provider: "anthropic", subtype: "success" });
    row(t + 3_000, { step: "pr.opened", task_id: id, run_id: `r${k}a`, pr_url: url(pr), pr_number: pr, ...(k === 5 ? { plan_only: true } : {}) });
    row(t + 4_000, { step: "review.posted", task_id: id, run_id: `r${k}a`, pr_url: url(pr), head_sha: `h${k}a`, state: "COMMENTED", ...(k === 5 ? { plan_only: true } : {}) });
    for (let n = 0; n < 3; n++) row(t + 5_000 + n, { step: "sweep.disposed", task_id: id, pr_number: pr, pr_url: url(pr), head_sha: `h${k}a`, disposition: "waiting", reason: "checks pending" });
    row(t + 6_000, { step: "verdict", task_id: id, run_id: `r${k}a`, verdict: "blocked_ci", cost_usd: 0.25 });
    // Six days later: a disposition change on the same head, its repeat, then a new head waiting again.
    const later = NOW0 - 3 * DAY + k * 60_000;
    row(later, { step: "sweep.disposed", task_id: id, pr_number: pr, pr_url: url(pr), head_sha: `h${k}a`, disposition: "blocked-fixable", reason: "strike 1/2" });
    row(later + 1, { step: "sweep.disposed", task_id: id, pr_number: pr, pr_url: url(pr), head_sha: `h${k}a`, disposition: "blocked-fixable", reason: "strike 1/2" });
    row(later + 2, { step: "sweep.disposed", task_id: id, pr_number: pr, pr_url: url(pr), head_sha: `h${k}b`, disposition: k === 3 ? "blocked-fixable" : "waiting", reason: k === 3 ? "fix strikes exhausted (3/2)" : "checks pending" });
  }
  const today = NOW0 - 14 * 60 * 60_000; // 09:50 on the build's day
  // W1-T1: in flight since yesterday, costs on both days, a worker still writing.
  row(NOW0 - DAY, { step: "run.start", task_id: "W1-T1", run_id: "r1b", type: "implement" });
  row(NOW0 - DAY + 60_000, { step: "implement.done", task_id: "W1-T1", run_id: "r1b", cost_usd: 0.31, num_turns: 7 });
  row(today, { step: "fix.done", task_id: "W1-T1", run_id: "r1b", cost_usd: 0.07, num_turns: 2, strike: 1 });
  row(NOW0 - 10 * 60_000, { step: "worker.activity", task_id: "W1-T1", run_id: "r1b", event_kind: "message", requested_model: "opus" });
  // W1-T2: merged today, once by its run's verdict (no url: the run's pr.opened names it) and once by the sweep's credit.
  row(today - 60 * 60_000, { step: "run.start", task_id: "W1-T2", run_id: "r2b", type: "fix" });
  row(today - 30 * 60_000, { step: "pr.opened", task_id: "W1-T2", run_id: "r2b", pr_url: url(12), pr_number: 12 });
  row(today, { step: "verdict", task_id: "W1-T2", run_id: "r2b", verdict: "merged", cost_usd: 0.4 });
  row(today + 60 * 60_000, { step: "verdict.merged", task_id: "W1-T2", pr_url: url(12), pr_number: 12 });
  row(today + 70 * 60_000, { step: "verdict.merged", task_id: "W1-T6", pr_url: url(16), pr_number: 16 });
  row(today + 2 * 60 * 60_000, { step: "worker.assignment", task_id: "W1-T2", run_id: "r2c", model: "sonnet" });
  // W1-T3: a run this week with a verdict on Friday and another today, a human hold on its PR, then two engages no human
  // made: one naming another task, the newest naming none.
  row(NOW0 - 2 * DAY, { step: "run.start", task_id: "W1-T3", run_id: "r3b", type: "implement" });
  row(NOW0 - 2 * DAY + 30_000, { step: "implement.done", task_id: "W1-T3", run_id: "r3b", cost_usd: 0.11, num_turns: 5 });
  row(NOW0 - 2 * DAY + 60_000, { step: "verdict", task_id: "W1-T3", run_id: "r3b", verdict: "failed", cost_usd: 0.5 });
  row(today + 60 * 60_000, { step: "implement.done", task_id: "W1-T3", run_id: "r3b", cost_usd: 0.02, num_turns: 1 });
  row(today + 2 * 60 * 60_000, { step: "verdict", task_id: "W1-T3", run_id: "r3b", verdict: "no_pr", cost_usd: 0.06 });
  row(NOW0 - 2 * DAY + 120_000, { step: "automerge.hold_engaged", task_id: "W1-T3", pr_number: 13, by: "craig", reason: "wait for the deploy", ...HUMAN });
  row(NOW0 - DAY - 60_000, { step: "automerge.hold_engaged", task_id: "W1-T9", pr_number: 13, by: "bot", reason: "auto", authority: "daemon" });
  row(NOW0 - DAY - 30_000, { step: "automerge.hold_engaged", pr_number: 13, by: "bot", reason: "auto", authority: "daemon" });
  row(NOW0 - DAY - 10_000, { step: "automerge.hold_released", pr_number: 13, authority: "daemon" });
  row(NOW0 - 12 * 60 * 60_000, { step: "worker.assignment", task_id: "W1-T9", run_id: "r9a", model: "sonnet" });
  row(today + 3 * 60 * 60_000, { step: "run.start", task_id: "W1-T3", run_id: "r3c", type: "fix" });
  // Holds of every scope: #14 engaged then released, a fleet hold engaged then released, #15 engaged by no human.
  row(NOW0 - 3 * DAY, { step: "automerge.hold_engaged", task_id: "W1-T4", pr_number: 14, by: "craig", reason: "hold", ...HUMAN });
  row(NOW0 - 2 * DAY, { step: "automerge.hold_released", task_id: "W1-T4", pr_number: 14, ...HUMAN });
  row(NOW0 - 5 * DAY, { step: "automerge.hold_engaged", by: "craig", reason: "fleet freeze", authority: "console-confirmed" });
  row(NOW0 - 4 * DAY, { step: "automerge.hold_released", authority: "console-confirmed" });
  row(NOW0 - 3 * DAY, { step: "automerge.hold_engaged", by: "craig", reason: "fleet freeze again", authority: "console-confirmed" });
  // #17's only hold row is a release no human made: the standing fleet hold still names it.
  row(NOW0 - 6 * DAY, { step: "automerge.hold_released", pr_number: 17, authority: "daemon" });
  row(NOW0 - DAY, { step: "automerge.hold_engaged", task_id: "W1-T5", pr_number: 15, by: "bot", reason: "auto", authority: "daemon" });
  // Escalations: W1-T4's is superseded by a later run, W1-T6's stands, a task-less probe escalated twice, a closed one, a dependency review.
  row(NOW0 - 4 * DAY, { step: "escalation.issue_opened", task_id: "W1-T4", issue_url: "https://github.com/o/r/issues/1", class: "MANUAL" });
  row(NOW0 - 3 * DAY, { step: "run.start", task_id: "W1-T4", run_id: "r4b", type: "implement" });
  row(NOW0 - 3 * DAY + 60_000, { step: "verdict", task_id: "W1-T4", run_id: "r4b", verdict: "no_pr", cost_usd: 0.1 });
  // An old run's costs this week and today, each after its first row of the window, outside W1-T4's current run (started
  // after both). Today's runs are summed in the order of their first rows, and these costs make that order show.
  row(NOW0 - 2 * DAY - 10 * 60_000, { step: "worker.assignment", task_id: "W1-T4", run_id: "r4a", model: "sonnet" });
  row(NOW0 - 2 * DAY + 10 * 60_000, { step: "fix.done", task_id: "W1-T4", run_id: "r4a", cost_usd: 0.06, num_turns: 2, strike: 1 });
  row(today - 30 * 60_000, { step: "worker.assignment", task_id: "W1-T4", run_id: "r4a", model: "sonnet" });
  row(today + 70 * 60_000, { step: "fix.done", task_id: "W1-T4", run_id: "r4a", cost_usd: 0.11, num_turns: 1, strike: 2 });
  row(today + 100 * 60_000, { step: "run.start", task_id: "W1-T4", run_id: "r4c", type: "fix" });
  // W1-T5's run since yesterday: today its first row is the worker's (a stand-in), its cost comes later.
  row(NOW0 - DAY - 60 * 60_000, { step: "run.start", task_id: "W1-T5", run_id: "r5b", type: "implement" });
  row(today - 45 * 60_000, { step: "worker.activity", task_id: "W1-T5", run_id: "r5b", event_kind: "working", requested_model: "sonnet" });
  row(today + 80 * 60_000, { step: "implement.done", task_id: "W1-T5", run_id: "r5b", cost_usd: 0.1, num_turns: 2 });
  row(NOW0 - 2 * DAY, { step: "escalation.issue_opened", task_id: "W1-T6", issue_url: "https://github.com/o/r/issues/3", class: "HARD_STOP" });
  row(NOW0 - 7 * DAY, { step: "escalation.issue_opened", task_id: "T-PROBE", issue_url: "https://github.com/o/r/issues/4", class: "PROBE" });
  row(NOW0 - 2 * DAY, { step: "escalation.issue_opened", task_id: "T-PROBE", issue_url: "https://github.com/o/r/issues/5", class: "PROBE" });
  row(NOW0 - 6 * DAY, { step: "escalation.issue_opened", task_id: "T-CLOSED", issue_url: "https://github.com/o/r/issues/2", class: "PROBE" });
  row(NOW0 - 6 * DAY, { step: "escalation.issue_opened", task_id: "dep-review-PR40", issue_url: "https://github.com/o/r/issues/6", class: "MANUAL" });
  row(NOW0 - 5 * DAY, { step: "dep-review.decided", task_id: "dep-review-PR40", pr_url: url(40), decision: "hold", review_decision: "hold" });
  row(NOW0 - 4 * DAY, { step: "ratify.approved", task_id: "W1-T5", released: "verify-human" });
  row(NOW0 - 4 * DAY, { step: "verify_human.judged", task_id: "W1-T5", judge_decision: "needs_operator", judge_reason: "a person must look" });
  row(today, { step: "triage.start", feedback_id: "fb-1" });
  // W1-T6: DAEMON-lane rows name it only in `task` — a breaker row, a capacity refusal, and the independent block that
  // stops it (read by its derive's latch, so a bucket read by task_id alone derives it unblocked).
  row(NOW0 - 2 * DAY + 60_000, { step: "dispatch.circuit_broken", task_id: "DAEMON", task: "W1-T6", freshCount: 3 });
  row(NOW0 - 2 * DAY + 120_000, { step: "daemon.spawn_infra_blocked", task_id: "DAEMON", task: "W1-T6" });
  row(NOW0 - 2 * DAY + 180_000, { step: "dispatch.blocked_independent", task_id: "DAEMON", task: "W1-T6", run_id: "r6x", verdict: "blocked_budget" });
  row(NOW0 - 8 * DAY, { step: "daemon.boot", head_sha: "c1" });
  row(NOW0 - DAY, { step: "daemon.boot", head_sha: "c2" });
  // W1-T6's newest change is a row no other rule keeps; its newest rows are sweep repeats.
  row(today + 3 * 60 * 60_000, { step: "worker.assignment", task_id: "W1-T6", run_id: "r6b", model: "sonnet" });
  row(NOW0 - 30 * 60_000, { step: "sweep.disposed", task_id: "W1-T6", pr_number: 16, pr_url: url(16), head_sha: "h6b", disposition: "waiting", reason: "checks pending" });
  row(NOW0 - 29 * 60_000, { step: "sweep.disposed", task_id: "W1-T6", pr_number: 16, pr_url: url(16), head_sha: "h6b", disposition: "waiting", reason: "checks pending" });
  // W1-T7's newest row is a repeat on a PR whose newest row the sweep filed under SWEEP.
  row(NOW0 - 9 * DAY, { step: "run.start", task_id: "W1-T7", run_id: "r7a", type: "implement" });
  row(NOW0 - DAY, { step: "sweep.disposed", task_id: "W1-T7", pr_number: 97, pr_url: url(97), head_sha: "h97", disposition: "waiting", reason: "checks pending" });
  row(NOW0 - DAY + 1, { step: "sweep.disposed", task_id: "W1-T7", pr_number: 97, pr_url: url(97), head_sha: "h97", disposition: "waiting", reason: "checks pending" });
  row(NOW0 - DAY + 2, { step: "sweep.disposed", task_id: "SWEEP", pr_number: 97, pr_url: url(97), head_sha: "h97", disposition: "waiting", reason: "checks pending" });
  // A PR whose sweep rows carry no head: only its newest disposition says it is blocked.
  row(NOW0 - 6 * DAY, { step: "sweep.disposed", task_id: "SWEEP", pr_number: 98, pr_url: url(98), disposition: "blocked-ambiguous", reason: "two owners" });
  row(NOW0 - 6 * DAY + 1, { step: "sweep.disposed", task_id: "SWEEP", pr_number: 98, pr_url: url(98), disposition: "blocked-ambiguous", reason: "two owners, still" });
  // A hand PR the sweep files under SWEEP, and steps nothing on the projection path reads.
  row(NOW0 - DAY, { step: "sweep.disposed", task_id: "SWEEP", pr_number: 99, pr_url: url(99), head_sha: "h99", disposition: "conflicted", reason: "merge conflict" });
  row(NOW0 - DAY + 1, { step: "sweep.disposed", task_id: "SWEEP", pr_number: 99, pr_url: url(99), head_sha: "h99", disposition: "conflicted", reason: "merge conflict" });
  row(NOW0 - 5 * 60_000, { step: "sweep.pass", task_id: "DAEMON" });
  return out.sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts)));
}

/** Rows a live minute appends: ten repeats and one change on #11's head, a cost, worker activity, a second triage claim. */
function appended(ms: number): Row[] {
  const out: Row[] = [];
  for (let n = 0; n < 10; n++) out.push({ ts: at(ms + n), host: "h1", step: "sweep.disposed", task_id: "W1-T1", pr_number: 11, pr_url: url(11), head_sha: "h1b", disposition: "waiting", reason: "checks pending" });
  out.push({ ts: at(ms + 20), host: "h1", step: "sweep.disposed", task_id: "W1-T1", pr_number: 11, pr_url: url(11), head_sha: "h1b", disposition: "blocked-fixable", reason: "strike 1/2" });
  out.push({ ts: at(ms + 30), host: "h1", step: "implement.done", task_id: "W1-T1", run_id: "r1b", cost_usd: 0.05, num_turns: 1 });
  out.push({ ts: at(ms + 40), host: "h1", step: "worker.activity", task_id: "W1-T1", run_id: "r1b", event_kind: "working" });
  out.push({ ts: at(ms + 50), host: "h1", step: "triage.start", feedback_id: "fb-1" });
  return out;
}

/** Monday's first minutes: a run, its cost and merge on the new day and week, and a sweep credit with no run. */
function nextDay(ms: number): Row[] {
  return [
    { ts: at(ms), host: "h1", step: "run.start", task_id: "W1-T5", run_id: "r5c", type: "implement" },
    { ts: at(ms + 1_000), host: "h1", step: "implement.done", task_id: "W1-T5", run_id: "r5c", cost_usd: 0.12, num_turns: 3 },
    { ts: at(ms + 2_000), host: "h1", step: "pr.opened", task_id: "W1-T5", run_id: "r5c", pr_url: url(16), pr_number: 16 },
    { ts: at(ms + 3_000), host: "h1", step: "verdict", task_id: "W1-T5", run_id: "r5c", verdict: "merged", cost_usd: 0.13 },
    { ts: at(ms + 4_000), host: "h1", step: "verdict.merged", task_id: "W1-T4", pr_url: url(14), pr_number: 14 },
    // A merge stamped with an offset: Sunday by its text, Monday by its instant. The two merge readers disagree on its day.
    { ts: "2026-10-11T23:02:00.000-01:00", host: "h1", step: "verdict", verdict: "merged", task_id: "W1-T8" },
    { ts: at(ms + 4_500), host: "h1", step: "worker.assignment", task_id: "W1-T8" },
  ];
}

const FEEDBACK: FeedbackEntry[] = [
  { id: "fb-1", ts: at(NOW0 - DAY), raw: "the board is slow", attachments: [], origin: "console", status: "new" } as unknown as FeedbackEntry,
];

interface World {
  root: string;
  db: ReadModelDb;
  lease: ReadModelLease;
  projector: LedgerProjector;
  ledgerDir: string;
  clock: Clock;
  set(ms: number): void;
  append(rows: Row[]): void;
  view(extra?: Partial<NowViewOptions>): ReturnType<typeof createNowView>;
  board(over?: Partial<BoardProjectionOptions>): BoardProjection;
  ctx(): NowViewContext;
}

function world(t: TestCtx, rows: Row[] = history()): World {
  const root = makeTempDir("board-keeps-per-key");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let ms = NOW0;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const feedbackRoot = join(root, "checkout");
  mkdirSync(join(feedbackRoot, "plan", "feedback"), { recursive: true });
  const db = openProjectorReadModel(join(root, "home"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: got.lease, clock });
  const append = (more: Row[]): void => {
    appendFileSync(join(ledgerDir, "ledger.ndjson"), more.map((r) => `${JSON.stringify(r)}\n`).join(""));
    projector.tick();
  };
  append(rows);
  const instance = { name: "core", ledgerDir, repo: "o/r", feedbackRoot };
  return {
    root, db, lease: got.lease, projector, ledgerDir, clock, append, set: (to) => void (ms = to),
    view: (extra = {}) => createNowView({
      instances: [instance], clock, readPlan: () => PLAN, github: () => ({ github: GATEWAY, generation: "g", source: { asOf: null, state: "fresh" } }),
      hostProbe: { rateLimit: () => 5_000, diskFree: () => 1_000_000, readLive: () => [] }, listGrilling: () => FEEDBACK, planBehind: () => ({ commits: 0 }),
      ...extra,
    }),
    board: (over = {}) => createBoardProjection({
      db, ledgerPath: join(ledgerDir, "ledger.ndjson"), clock, readPlan: () => PLAN, github: GATEWAY, githubGeneration: () => "g1",
      readCreditStore: () => ({}), readCreditOverrideFile: () => "", ...over,
    }),
    ctx: () => ({
      now: ms, switches: { views: { now: "shadow" } },
      instances: [{ state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: ms, newestTs: null }, db, lease: got.lease }],
    }),
  };
}

function built(w: World, view: ReturnType<typeof createNowView>): NowViewData {
  const c = w.ctx();
  while (!view.prepare(c, () => true)) { /* to ready */ }
  const bodies = view.materialize(c);
  assert.equal(bodies.length, 1, "control: one body");
  return bodies[0]!.data;
}

const persisted = (db: ReadModelDb): Record<string, string> => Object.fromEntries(db.prepare("SELECT task_id, json FROM task_projection ORDER BY task_id").all()
  .map((r) => [String(r.task_id), canonicalProjection(JSON.parse(String(r.json)))]));

function drain(board: BoardProjection, opts: { force?: boolean } = { force: true }): void {
  let n = 0;
  while (!board.update(opts).caughtUp && n++ < 1_000) { /* to caught up */ }
}

/** The reference arm: every row kept, every task derived from them (today's board). */
const EVERY_ROW: Partial<BoardProjectionOptions> = { keepEveryRow: true, deriveFromRows: true };

test("W1-T9436: the now view built from kept rows equals the one built from every row", (t) => {
  const kept = world(t);
  const every = world(t);
  const both = (f: (w: World) => void): void => { f(kept); f(every); };
  let keptView = kept.view();
  let everyView = every.view({ boardOptions: EVERY_ROW });
  // Beside the views, one board per arm whose whole snapshot is compared: its spend, live spend and raw activity times
  // are read by no published field of the now body, but each is a reader a rule serves.
  const keptBoard = kept.board();
  const everyBoard = every.board(EVERY_ROW);
  const snapshot = (w: World, board: BoardProjection): unknown => {
    let n = 0;
    while (!board.update({ force: true, readerNowMs: w.clock.now() }).caughtUp && n++ < 1_000) { /* to caught up */ }
    const rows = board.rows();
    const projections = board.projections();
    const deps = { plan: PLAN, ledgerPath: join(w.ledgerDir, "ledger.ndjson"), github: GATEWAY, readLedger: () => rows as Array<Record<string, unknown>>,
      ledgerIndex: board.index(rows), now: () => w.clock.now(), readCreditStore: () => ({}), readCreditOverrideFile: () => "" };
    return computeBoardSnapshot(deps, { reuseProjection: (task) => projections.get(task.id) });
  };
  /** A body with its world's temp root named the same way: a reason quoting a path under it is otherwise equal. */
  const portable = (w: World, data: NowViewData): unknown => JSON.parse(JSON.stringify(data).split(w.root).join("<root>"));
  const compare = (phase: string): NowViewData => {
    const a = built(kept, keptView);
    const b = built(every, everyView);
    assert.deepEqual(portable(kept, a), portable(every, b), `${phase}: the bodies are equal`);
    assert.deepEqual(persisted(kept.db), persisted(every.db), `${phase}: every task projection is equal`);
    assert.deepEqual(snapshot(kept, keptBoard), snapshot(every, everyBoard), `${phase}: the board snapshots are equal`);
    return a;
  };

  const cold = compare("cold");
  // Controls: the fixture reaches every reader the retention rules serve, and the kept board is the smaller one.
  assert.equal(Object.keys(persisted(kept.db)).length, IDS.length + 2, "every plan task and the two task-less escalations still open are projected");
  assert.ok(cold.actions.some((a) => a.kind === "blocked_pr") && cold.actions.some((a) => a.kind === "merge_held"), "blocked and held PR actions");
  assert.ok(cold.prQueue.rows.length === OPEN.length && cold.prQueue.rows.some((r) => r.disposition === "not-yet-observed"), "the queue joins exact heads");
  assert.ok(cold.recent.mergedToday.count > 0 && cold.recent.entries.length > 0, "today's merges and the recent feed");
  assert.ok(cold.board.spendTodayUsd > 0, "today's spend");
  assert.ok(cold.board.tasks.some((task) => task.phase), "an in-flight task");
  const sizes = (): [number, number] => [keptView.heldSizes().core!.rows, everyView.heldSizes().core!.rows];
  const [keptRows, everyRows] = sizes();
  assert.ok(keptRows < everyRows, `the kept board holds fewer rows: ${keptRows} of ${everyRows}`);

  // Warm: a row of an unread step moves only the ledger's clock.
  both((w) => { w.set(NOW0 + 5_000); w.append([{ ts: at(NOW0 + 5_000), host: "h1", step: "sweep.pass", task_id: "DAEMON" }]); });
  compare("warm");

  both((w) => { w.set(NOW0 + 60_000); w.append(appended(NOW0 + 60_000)); });
  compare("appended");

  // Monday 00:05: a new UTC day and a new ISO week.
  both((w) => { w.set(NOW0 + 15 * 60_000); w.append(nextDay(NOW0 + 15 * 60_000)); });
  const monday = compare("day-crossing");
  assert.ok(monday.recent.mergedToday.count === 2 && monday.recent.mergedToday.day === "2026-10-12", "Monday's merges alone");

  // Past the oracle interval: the board's no-reuse derive runs inside this build.
  both((w) => w.set(NOW0 + 27 * 60_000));
  compare("oracle-pass");

  // A restarted view: a cold ingest over the store, reusing the persisted projections.
  keptView = kept.view();
  everyView = every.view({ boardOptions: EVERY_ROW });
  both((w) => w.set(NOW0 + 28 * 60_000));
  compare("restart");
});

test("W1-T9436: superseding rows leave the board projection holding one entry per key", (t) => {
  const w = world(t);
  const kept = w.board();
  const every = w.board({ keepEveryRow: true });
  drain(kept);
  drain(every);
  const sweep = (ms: number, disposition: string): Row => ({ ts: at(ms), host: "h1", step: "sweep.disposed", task_id: "W1-T1", pr_number: 11, pr_url: url(11), head_sha: "h1b", disposition, reason: "r" });
  w.set(NOW0 + 1_000);
  w.append([sweep(NOW0 + 1_000, "waiting")]);
  drain(kept);
  drain(every);
  const before = [kept.size().rows, every.size().rows];
  w.set(NOW0 + 2_000);
  w.append(Array.from({ length: 10 }, (_, n) => sweep(NOW0 + 2_000 + n, n === 5 ? "blocked-fixable" : n > 5 ? "blocked-fixable" : "waiting")));
  drain(kept);
  drain(every);
  assert.equal(every.size().rows, before[1]! + 10, "control: the reference arm grows by the ten appended rows");
  assert.equal(kept.size().rows, before[0], "entries track keys, not history");
  assert.equal(kept.rows().length - 1, kept.size().rows, "rows() returns the rows the projection holds, less its sentinel");
  const held = kept.rows().filter((r) => r.step === "sweep.disposed" && r.pr_number === 11);
  assert.ok(held.length <= 3, `PR #11 holds its newest row and its newest change: ${held.length}`);
  assert.deepEqual(canonicalProjections(kept), canonicalProjections(every), "and the board it derives is unchanged");
});

const canonicalProjections = (board: BoardProjection): Record<string, string> => Object.fromEntries([...board.projections()].map(([id, p]) => [id, canonicalProjection(p)]).sort());

/** The (step, field) reads the now view made of rows holding that field, outside the derive. */
function recordingProxy(reads: Set<string>): (rows: ReadonlyArray<Row>) => ReadonlyArray<Row> {
  return (rows) => rows.map((row) => new Proxy(row, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop !== "step" && Object.hasOwn(target, prop) && typeof target.step === "string") reads.add(`${target.step}\u0000${prop}`);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }));
}

/** The reads no rule covers: a rule covers a step it names (or every step) and a field it declares. */
function uncovered(reads: Set<string>, rules: readonly BoardRetentionRule[]): string[] {
  return [...reads].filter((read) => {
    const [step, field] = read.split("\u0000") as [string, string];
    if (BOARD_ROW_PROBE_FIELDS.has(field)) return false;
    return !rules.some((rule) => (rule.steps === "*" || rule.steps.includes(step)) && rule.fields.includes(field));
  }).map((read) => read.replace("\u0000", ".")).sort();
}

test("W1-T9436: every step a now-view reader reads has a retention rule", (t) => {
  const w = world(t);
  const reads = new Set<string>();
  const view = w.view({ boardOptions: { keepEveryRow: true }, wrapBoardRows: recordingProxy(reads) });
  built(w, view);
  w.set(NOW0 + 60_000);
  w.append(appended(NOW0 + 60_000));
  built(w, view);
  assert.ok(reads.size > 10, `control: the census recorded the readers' reads (${reads.size})`);
  assert.ok(reads.has("sweep.disposed\u0000disposition") && reads.has("automerge.hold_engaged\u0000by"), "control: it saw the PR readers");
  assert.deepEqual(uncovered(reads, BOARD_ROW_RETENTION), [], "every read step and field is kept by a rule");
  // Positive control: drop the rules keeping the newest disposition per PR and the census names that step.
  const without = BOARD_ROW_RETENTION.filter((rule) => !(rule.steps !== "*" && rule.steps.includes("sweep.disposed")));
  assert.ok(uncovered(reads, without).some((read) => read.startsWith("sweep.disposed.")), "a missing rule is named");
});

test("W1-T9436: a re-derived task reads its rows from the store, never from the kept rows", (t) => {
  const w = world(t);
  const board = w.board();
  drain(board);
  const touched: string[] = [];
  const trap = new Proxy([] as Row[], {
    get(target, prop, receiver) {
      if (prop !== "constructor") touched.push(String(prop));
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  const deps = {
    ledgerPath: join(w.ledgerDir, "ledger.ndjson"), github: GATEWAY, readLedger: () => trap, now: () => w.clock.now(),
    readCreditStore: () => ({}), writeCreditStore: () => {}, readCreditOverrideFile: () => "", skipUncreditedBuildWarning: true as const,
  };
  const fromStore = projectPlan(PLAN, { ...deps, ledgerIndex: board.index(trap) });
  assert.deepEqual(touched, [], "no derive helper walked the rows array");
  const reference = w.board(EVERY_ROW);
  drain(reference);
  const canon = (m: Map<string, unknown>) => Object.fromEntries([...m].map(([id, p]) => [id, canonicalProjection(p as never)]).sort());
  assert.deepEqual(canon(fromStore), canonicalProjections(reference), "the store-read derive equals the every-row one");
  assert.equal(fromStore.get("W1-T6")?.independentFailureBlocked, true, "control: W1-T6 is blocked by the row naming it only in `task`");
});

test("W1-T9436: the store index reads plan-only filing urls and reviewed heads", (t) => {
  const rows: Row[] = [
    { step: "pr.opened", plan_only: true, pr_url: url(11) },
    { step: "pr.opened", plan_only: true, pr_url: 12 },
    { step: "review.posted", plan_only: true, pr_url: url(13), head_sha: "h13a" },
    { step: "review.posted", plan_only: true, pr_url: url(13), head_sha: "h13b" },
    { step: "review.posted", plan_only: true, pr_url: url(13), head_sha: "h13a" },
    { step: PLAN_ONLY_REVIEW_MARKER_STEP, plan_only: true, pr_url: url(14), head_sha: "h14" },
    { step: "review.posted", plan_only: true, pr_url: url(15), head_sha: 15 },
    { step: "review.posted", plan_only: true, head_sha: "missing-url" },
    { step: "pr.opened", pr_url: url(16) },
    { step: "review.posted", pr_url: url(16), head_sha: "ordinary-review" },
  ].map((row, n) => ({ ts: at(NOW0 - 1_000 + n), ...row }));
  const w = world(t, rows);
  const board = w.board();
  drain(board);
  const index = board.index(board.rows());
  w.append([{ ts: at(NOW0), step: "pr.opened", plan_only: true, pr_url: url(17) }]);
  assert.deepEqual(index.planOnlyFilingPrUrls, new Set([url(11)]));
  assert.deepEqual(index.planOnlyReviewedHeads, new Map([
    [url(13), new Set(["h13a", "h13b"])],
    [url(14), new Set(["h14"])],
  ]));
  drain(board);
  const updated = board.index(board.rows());
  assert.deepEqual(updated.planOnlyReviewedHeads, index.planOnlyReviewedHeads);
  assert.deepEqual(updated.planOnlyFilingPrUrls, new Set([url(11), url(17)]));
});

test("W1-T9436: the projector keeps a task alias table, backfilled once from fact bodies", (t) => {
  const w = world(t);
  const aliases = () => w.db.prepare("SELECT task, seq FROM fact_alias ORDER BY seq").all().map((r) => `${String(r.task)}@${Number(r.seq)}`);
  const written = aliases();
  assert.equal(written.length, 3, "the three DAEMON-lane rows naming W1-T6 in `task`");
  assert.ok(written.every((a) => a.startsWith("W1-T6@")));
  w.db.exec("DELETE FROM fact_alias; DELETE FROM meta WHERE k = 'fact_alias'");
  createLedgerProjector({ ledgerDir: w.ledgerDir, db: w.db, lease: w.lease, clock: w.clock }).tick();
  assert.deepEqual(aliases(), written, "a store without the table's backfill gets it from its own fact bodies");
});

test("W1-T9436: the intern table holds only the kept rows' values", (t) => {
  const w = world(t);
  const board = w.board();
  drain(board);
  const values = new Set<string>();
  for (const row of board.rows()) for (const v of Object.values(row)) if (typeof v === "string" && v.length <= 96) values.add(v);
  assert.ok(board.internedStrings() > 0, "control: the table holds values");
  assert.ok(board.internedStrings() <= values.size, `no value of a dropped row stays interned: ${board.internedStrings()} of ${values.size}`);
});
