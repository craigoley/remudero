/**
 * W1-T15009 — each instance's sweep publishes a flow snapshot of its open pull requests by stage, counting every owner,
 * beside the review demand it already shares with the other instances on the host.
 *
 * These tests drive the real light pass (`runSweepLightPass`) over a board holding fleet and operator heads in every
 * stage, then read the snapshot FILE the pass leaves in the shared host directory by its path alone. On origin/main the
 * pass writes no such file, so criterion 1 reads nothing there and fails on its assertion.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { readReviewDemand } from "#src/lib/host-memory-priority.js";
import { readLedgerLines } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { DEFAULT_SWEEP_POLICY, runSweepLightPass, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

const NOW = Date.parse("2026-11-28T12:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Stage = "checks_running" | "awaiting_review" | "failing" | "ready";
const STAGE_STATES: Record<Stage, Pick<OpenPrView, "checksState" | "reviewState">> = {
  checks_running: { checksState: "pending", reviewState: "none" },
  awaiting_review: { checksState: "green", reviewState: "none" },
  failing: { checksState: "red", reviewState: "none" },
  ready: { checksState: "green", reviewState: "success" },
};

function pr(n: number, stage: Stage, head: string): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`, ...STAGE_STATES[stage],
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: iso(NOW - HOUR), createdAt: iso(NOW - 2 * HOUR),
    headSha: `sha${n}`, headRefName: head, autoMergeArmed: false,
  };
}

/** One fleet run branch and one operator head in every stage, and a second operator head awaiting review. */
function board(): OpenPrView[] {
  const stages: Stage[] = ["checks_running", "awaiting_review", "failing", "ready"];
  return [
    ...stages.map((stage, i) => pr(100 + i, stage, `run-W1-T${100 + i}-1795000000000`)),
    ...stages.map((stage, i) => pr(200 + i, stage, `run-unfiled-179500000000${i}`)),
    pr(210, "awaiting_review", "cao825/hand-build"),
  ];
}

const row = (step: string, ms: number, extra: Record<string, unknown> = {}) =>
  ({ ts: iso(ms), run_id: `R-${step}-${ms}`, task_id: "W1-T1", step, ...extra });

/** The live rows the pass reads: completions per lane kind, two merges (one with a known open time) and a runnable count. */
function liveRows(): Array<Record<string, unknown>> {
  return [
    row("pr.opened", NOW - 3 * HOUR, { lane: "run-task", pr_url: "https://github.com/o/r/pull/90" }),
    row("pr.opened", NOW - 2 * HOUR, { lane: "run-task", pr_url: "https://github.com/o/r/pull/91" }),
    row("pr.opened", NOW - 2 * HOUR, { lane: "approve", pr_url: "https://github.com/o/ops/pull/5" }),
    row("pr.opened", NOW - 30 * HOUR, { lane: "run-task", pr_url: "https://github.com/o/r/pull/80" }),
    row("review.posted", NOW - HOUR, { state: "success", pr_url: "https://github.com/o/r/pull/91" }),
    row("review.posted", NOW - HOUR + 1, { state: "failure", pr_url: "https://github.com/o/r/pull/92" }),
    row("review.posted", NOW - HOUR + 2, { state: "pending", pr_url: "https://github.com/o/r/pull/93" }),
    row("fix.done", NOW - HOUR, { pr_number: 92 }),
    row("pr.terminal", NOW - HOUR, { state: "merged", pr_url: "https://github.com/o/r/pull/90", merged_at: iso(NOW - HOUR) }),
    row("pr.terminal", NOW - HOUR, { state: "merged", pr_url: "https://github.com/o/r/pull/70", merged_at: iso(NOW - HOUR) }),
    row("lane.idle_changed", NOW - 10 * 60_000, { dispatchable: 4 }),
    row("lane.idle_changed", NOW - 5 * 60_000, { dispatchable: 6 }),
  ];
}

interface Fixture {
  root: string;
  host: string;
  ledgerPath: string;
  historyPath: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-t15009-"));
  const host = join(root, "host-memory");
  const state = join(root, "core", "state");
  const ledgerPath = writeLedger(liveRows(), { dir: state }).path;
  // The fold's history began two days ago, so both windows are fully covered.
  const historyPath = join(state, "flow-snapshot-history.json");
  writeFileSync(historyPath, JSON.stringify({ schema: 1, sinceMs: NOW - 48 * HOUR, events: { build: [], review: [], fix: [] }, merges: [], opened: {} }));
  return { root, host, ledgerPath, historyPath };
}

interface Decisions {
  reviewed: number[];
  fixed: number[];
  armed: number[];
  closed: number[];
  escalated: number[];
}

function deps(f: Fixture, decisions: Decisions, snapshot: Record<string, unknown>): SweepDeps {
  const location = () => ({ dir: f.host, scope: "host" as const });
  const instance = () => ({ name: "core", hostUnique: true });
  return {
    arm: (p) => { decisions.armed.push(p.prNumber); },
    close: (p) => { decisions.closed.push(p.prNumber); },
    dispatchFix: (p) => { decisions.fixed.push(p.prNumber); },
    escalate: (p) => { decisions.escalated.push(p.prNumber); },
    postReview: (p) => { decisions.reviewed.push(p.prNumber); },
    ledgerPath: f.ledgerPath,
    runId: "SWEEP-T15009",
    now: () => NOW,
    reviewDemand: { location, instance, clock: fixedClock(NOW) },
    flowSnapshot: { location, instance, clock: fixedClock(NOW), historyPath: f.historyPath, ...snapshot },
  } as SweepDeps;
}

const emptyDecisions = (): Decisions => ({ reviewed: [], fixed: [], armed: [], closed: [], escalated: [] });

function snapshotFiles(host: string): string[] {
  try {
    return readdirSync(join(host, "flow-snapshot"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("W1-T15009 criterion 1: the snapshot in the shared host directory counts every stage for both owners, runnable tasks and measured throughput", async () => {
  const f = fixture();
  try {
    await runSweepLightPass(board(), deps(f, emptyDecisions(), {}), DEFAULT_SWEEP_POLICY);
    assert.deepEqual(snapshotFiles(f.host), ["core.json"], "one file per instance beside review-demand/");
    assert.deepEqual(readReviewDemand({ location: () => ({ dir: f.host, scope: "host" }), clock: fixedClock(NOW) }).rows.map((r) => r.instance),
      ["core"], "in the same shared host directory as this instance's review demand row");
    const snap = JSON.parse(readFileSync(join(f.host, "flow-snapshot", "core.json"), "utf8"));
    assert.equal(snap.instance, "core");
    assert.equal(snap.publishedAt, iso(NOW), "stamped with its time");
    assert.deepEqual(snap.stages, {
      fleet: { checks_running: 1, awaiting_review: 1, failing: 1, ready: 1 },
      operator: { checks_running: 1, awaiting_review: 2, failing: 1, ready: 1 },
    }, "operator heads are counted in every stage, not left out as the build gate leaves them");
    assert.deepEqual(snap.open, { fleet: 4, operator: 5, total: 9 });
    assert.equal(snap.runnableTasks, 6, "the daemon's newest dispatchable count");
    assert.equal(snap.runnableObservedAt, iso(NOW - 5 * 60_000));
    // Trailing day: two build PRs (the approve lane's and the 30 h old one are not), two terminal reviews, one fix round.
    assert.deepEqual(snap.completions, { windowHours: 24, build: 2, review: 2, fix: 1 });
    // Trailing week, 48 h covered: two merges; only #90's open time is known, opened 3 h and merged 1 h ago.
    assert.deepEqual(snap.merges, { windowHours: 48, count: 2, perHour: 2 / 48, p50LeadTimeMs: 2 * HOUR, leadTimeSamples: 1 });

    const rows = readLedgerLines(f.ledgerPath).filter((r) => r.step === "flow.snapshot");
    assert.equal(rows.length, 1, "one flow.snapshot row per pass");
    assert.deepEqual([rows[0]!.stages, rows[0]!.completions, rows[0]!.merges, rows[0]!.runnableTasks],
      [snap.stages, snap.completions, snap.merges, snap.runnableTasks], "the row carries the same numbers");

    // The fold outlives the live file's rotation: a later pass over a rotated (empty) ledger keeps the merges it saw.
    writeFileSync(f.ledgerPath, "");
    const later = NOW + HOUR;
    await runSweepLightPass(board(), { ...deps(f, emptyDecisions(), { clock: fixedClock(later) }), now: () => later }, DEFAULT_SWEEP_POLICY);
    const after = JSON.parse(readFileSync(join(f.host, "flow-snapshot", "core.json"), "utf8"));
    assert.deepEqual([after.merges.count, after.completions.review, after.runnableTasks], [2, 2, null],
      "history survives rotation; a runnable count no row shows is null, never guessed");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T15009 criterion 1: an instance with no open pull requests still publishes its runnable work", async () => {
  const f = fixture();
  try {
    await runSweepLightPass([], deps(f, emptyDecisions(), {}), DEFAULT_SWEEP_POLICY);
    const snap = JSON.parse(readFileSync(join(f.host, "flow-snapshot", "core.json"), "utf8"));
    assert.deepEqual([snap.open.total, snap.runnableTasks, snap.merges.count], [0, 6, 2]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

function decisionRows(path: string): unknown[] {
  return readLedgerLines(path)
    .filter((r) => r.step === "sweep.disposed" || r.step === "sweep.fix_capacity" || r.step === "sweep.review_admitted")
    .map((r) => [r.step, r.pr_number, r.disposition, r.acted, r.stand_down_reason, r.fixes_admitted, r.fixes_refused,
      r.review_reservations, r.host_worker_budget])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test("W1-T15009 criterion 3: invariant:snapshot-is-observation-only — every dispatch, review width and fix admission is origin/main's", async () => {
  const published = fixture();
  const unpublished = fixture();
  try {
    const withSnapshot = emptyDecisions();
    await runSweepLightPass(board(), deps(published, withSnapshot, {}), DEFAULT_SWEEP_POLICY);
    // The same inputs with no snapshot at all (as on origin/main): the publication fails at its first write.
    const withoutSnapshot = emptyDecisions();
    await runSweepLightPass(board(), deps(unpublished, withoutSnapshot, { write: () => { throw new Error("no snapshot"); } }),
      DEFAULT_SWEEP_POLICY);
    assert.deepEqual(snapshotFiles(unpublished.host), [], "the control pass wrote no snapshot");
    assert.deepEqual(withSnapshot, withoutSnapshot, "the same reviews, fixes, arms, closes and escalations");
    assert.deepEqual(withSnapshot, {
      reviewed: [101, 201, 210], fixed: [102, 202], armed: [], closed: [], escalated: [100, 200],
    }, "exactly origin/main's decisions for this board (a light pass arms nothing unless its scope admits arming)");
    assert.deepEqual(decisionRows(published.ledgerPath), decisionRows(unpublished.ledgerPath),
      "every disposition, review admission and fix admission row is the same");
  } finally {
    rmSync(published.root, { recursive: true, force: true });
    rmSync(unpublished.root, { recursive: true, force: true });
  }
});

test("W1-T15009: a first pass starts its fold, defaults to the host-memory slot directory, and a failure is never thrown", async () => {
  // Loaded inside the test: the criteria above must reach their own assertions on origin/main, where this module is absent.
  const { publishFlowSnapshot } = await import("#src/lib/flow-snapshot.js");
  const written = new Map<string, string>();
  const missing = () => { throw Object.assign(new Error("no history yet"), { code: "ENOENT" }); };
  const snap = publishFlowSnapshot([], [], "/r/core/state/ledger.ndjson", {
    instance: () => ({ name: "core", hostUnique: true }), clock: fixedClock(NOW), read: missing,
    write: (path, content) => { written.set(path, content); },
  });
  assert.equal(snap?.historySince, iso(NOW), "no history: the fold begins at this pass");
  assert.deepEqual([snap?.merges.windowHours, snap?.merges.perHour], [0, null], "no covered hours: no rate, never a guess");
  assert.ok([...written.keys()].some((path) => /host-memory\/flow-snapshot\/core\.json$/.test(path)), "the default directory");
  assert.ok(written.has("/r/core/state/flow-snapshot-history.json"), "the history sits beside the instance's ledger");

  const failing = { instance: () => ({ name: "core", hostUnique: true }), clock: fixedClock(NOW), read: missing,
    write: () => { throw new Error("disk full"); } };
  const logged: Array<Record<string, unknown>> = [];
  assert.equal(publishFlowSnapshot([], [], "/r/l", { ...failing, log: (event) => { logged.push(event); } }), undefined);
  assert.deepEqual(logged.map((event) => [event.event, event.reason]), [["flow.snapshot_error", "disk full"]]);
  assert.equal(publishFlowSnapshot([], [], "/r/l", { ...failing, log: () => { throw new Error("log down"); } }), undefined,
    "a diagnostic that cannot be written is swallowed too");
});
