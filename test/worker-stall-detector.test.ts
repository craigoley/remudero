// W1-T943: W1-T942 produces `worker.state`; nothing judged it until now. This proves the
// JUDGE half — a run whose newest `worker.state` row has aged past the policy `workerStall`
// threshold gets `worker.stalled` appended ONCE and reaches NEEDS ME through the existing §4
// escalation machinery, with the run's tail attached and never a kill/signal against it.
//
// Four acceptance claims, all proven here:
//   1. quiet beyond the policy threshold on a LIVE in-flight run appends worker.stalled, judged
//      from the AGE of the newest worker.state row — never an event the run itself must emit.
//   2. one worker.stalled per quiet episode: repeated ticks over the same silence append
//      nothing further; a run that speaks again re-arms the detector.
//   3. the escalation reaches NEEDS ME through the existing machinery, carrying the run id, the
//      quiet duration, a CAPPED tail excerpt, and at least two actionable options.
//   4. the detector NEVER kills, signals, defers or strikes the run.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { IssueGateway } from "../src/lib/escalate.js";
import {
  capWorkerTailLines,
  findStalledWorkers,
  ledgerPathFor,
  runWorkerStallDetectorRung,
  WORKER_STALL_TAIL_ATTACH_MAX_BYTES,
  WORKER_STALL_TAIL_ATTACH_MAX_LINES,
  WORKER_STALLED_LEDGER_STEP,
  WORKER_STATE_LEDGER_STEP,
  type WorkerStallCandidate,
} from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-${prefix}-`));
}

function fakeConfig(root: string): Config {
  return { root } as Config;
}

/** Write `<root>/state/inflight/<taskId>.lock` for a LIVE holder — `process.pid` is always
 *  alive to `liveInflightRuns`'s default OS liveness probe, so this is the deterministic,
 *  no-mocking way to make a run "live" in these tests. */
function markLive(root: string, taskId: string, runId: string): void {
  const inflightDir = join(root, "state", "inflight");
  mkdirSync(inflightDir, { recursive: true });
  writeFileSync(
    join(inflightDir, `${taskId}.lock`),
    JSON.stringify({ pid: process.pid, run_id: runId, host: "test-host", startedAt: new Date().toISOString() }),
  );
}

function readLedger(ledgerPath: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function fakeIssues(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title: string, body: string, labels: string[]): string {
      calls.push({ title, body, labels });
      return `https://github.com/craigoley/remudero/issues/${calls.length}`;
    },
  };
}

const NOOP_LOG = (): void => {};

// ── acceptance 1: derived from the AGE of the newest worker.state row, never an event ──────

test("findStalledWorkers: a live run whose newest worker.state row is older than thresholdMs is flagged, age-derived", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const lines = [
    { run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "quiet", ts: "2026-08-17T11:00:00.000Z" },
  ];
  const out = findStalledWorkers([{ runId: "RUN-1", taskId: "W1-T1" }], lines, 30 * 60_000, now);
  assert.equal(out.length, 1);
  assert.equal(out[0].runId, "RUN-1");
  assert.equal(out[0].taskId, "W1-T1");
  assert.equal(out[0].quietMs, 60 * 60_000);
  assert.equal(out[0].lastState, "quiet");
});

test("findStalledWorkers: a live run whose newest worker.state row is WITHIN thresholdMs is not flagged", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const lines = [
    { run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "working", ts: "2026-08-17T11:50:00.000Z" },
  ];
  const out = findStalledWorkers([{ runId: "RUN-1", taskId: "W1-T1" }], lines, 30 * 60_000, now);
  assert.deepEqual(out, []);
});

test("findStalledWorkers: a live run with NO worker.state row at all is skipped — nothing to measure the age of (W1-T942 dependency)", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const out = findStalledWorkers([{ runId: "RUN-1", taskId: "W1-T1" }], [], 30 * 60_000, now);
  assert.deepEqual(out, [], "no worker.state row ⇒ nothing whose age can be judged ⇒ never flagged");
});

test("findStalledWorkers: judges the NEWEST worker.state row, not the first or an arbitrary one — an EARLIER stale row must not mask a later fresh one, and vice versa", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const lines = [
    { run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "working", ts: "2026-08-17T09:00:00.000Z" },
    { run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "quiet", ts: "2026-08-17T11:55:00.000Z" },
  ];
  const out = findStalledWorkers([{ runId: "RUN-1", taskId: "W1-T1" }], lines, 30 * 60_000, now);
  assert.deepEqual(out, [], "the NEWEST row (11:55) is only 5 min old — must not be shadowed by the 09:00 row");
});

test("findStalledWorkers: never fires off another run's lines — run_id isolation", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const lines = [
    { run_id: "RUN-OTHER", task_id: "W1-TOTHER", step: WORKER_STATE_LEDGER_STEP, state: "quiet", ts: "2026-08-17T09:00:00.000Z" },
  ];
  const out = findStalledWorkers([{ runId: "RUN-1", taskId: "W1-T1" }], lines, 30 * 60_000, now);
  assert.deepEqual(out, []);
});

// ── acceptance 2: ONE row per quiet episode — dedup and re-arm ─────────────────────────────

test("findStalledWorkers: a run already carrying a worker.stalled row NEWER than its newest worker.state row is excluded — mid-episode, already reported", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const lines = [
    { run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "quiet", ts: "2026-08-17T11:00:00.000Z" },
    { run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STALLED_LEDGER_STEP, ts: "2026-08-17T11:31:00.000Z" },
  ];
  const out = findStalledWorkers([{ runId: "RUN-1", taskId: "W1-T1" }], lines, 30 * 60_000, now);
  assert.deepEqual(out, [], "already reported this episode — a repeated tick over the same silence must append nothing further");
});

test("findStalledWorkers: a run that speaks again (a fresh worker.state row postdating the last worker.stalled row) re-arms — a LATER quiet stretch is flagged again", () => {
  const now = Date.parse("2026-08-17T13:00:00.000Z");
  const lines = [
    { run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "quiet", ts: "2026-08-17T11:00:00.000Z" },
    { run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STALLED_LEDGER_STEP, ts: "2026-08-17T11:31:00.000Z" },
    // the run spoke again AFTER the stall row — the episode ended.
    { run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "working", ts: "2026-08-17T11:45:00.000Z" },
    // ... and has since gone quiet again, long enough to re-trip the SAME 30-min threshold.
  ];
  const out = findStalledWorkers([{ runId: "RUN-1", taskId: "W1-T1" }], lines, 30 * 60_000, now);
  assert.equal(out.length, 1, "the run spoke again, so a fresh quiet stretch must re-arm the detector");
  assert.equal(out[0].lastState, "working");
});

// ── acceptance 3: reaches NEEDS ME through §4, with run id, quiet duration, capped tail, ≥2 options ──

function withDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = tmpRoot(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runWorkerStallDetectorRung: a quiet live run appends worker.stalled ONCE and opens exactly one NEEDS ME issue naming the run id, task id, quiet duration, and >=2 options", () => {
  withDir("worker-stall-fire", (root) => {
    const config = fakeConfig(root);
    const ledgerPath = ledgerPathFor(config);
    markLive(root, "W1-T1", "RUN-1");
    // a worker.state row 90 minutes old, well past a 60-minute threshold.
    const oldTs = new Date(Date.now() - 90 * 60_000).toISOString();
    writeFileSync(
      ledgerPath,
      JSON.stringify({ ts: oldTs, run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "quiet" }) + "\n",
    );
    // a tail file — used to prove the escerpt is attached AND capped.
    mkdirSync(join(root, "state", "runs"), { recursive: true });
    const manyLines = Array.from({ length: 500 }, (_, i) => `tail line ${i}`).join("\n") + "\n";
    writeFileSync(join(root, "state", "runs", "RUN-1.tail"), manyLines);

    const issues = fakeIssues();
    runWorkerStallDetectorRung("craigoley", "remudero", config, ledgerPath, "DAEMON-RUN", 60 * 60_000, NOOP_LOG, issues);

    const lines = readLedger(ledgerPath);
    const stalledRows = lines.filter((l) => l.step === WORKER_STALLED_LEDGER_STEP);
    assert.equal(stalledRows.length, 1, "worker.stalled must be appended exactly once");
    assert.equal(stalledRows[0].run_id, "RUN-1");
    assert.equal(stalledRows[0].task_id, "W1-T1");

    assert.equal(issues.calls.length, 1, "exactly one NEEDS ME issue must be opened for this episode");
    const call = issues.calls[0];
    assert.ok(call.labels.includes("needs-human"), "the issue must carry the needs-human label — this IS reaching NEEDS ME");
    assert.ok(call.body.includes("RUN-1"), "the run id must be named as evidence");
    assert.ok(call.body.includes("W1-T1"), "the task id must be named as evidence");
    assert.ok(/90 min/.test(call.body), "the quiet DURATION must be named, not just a bare alert");
    assert.ok(call.body.includes("tail line 499"), "the tail excerpt must include the run's actual output");
    const optionCount = (call.body.match(/^- \*\*/gm) ?? []).length;
    assert.ok(optionCount >= 2, `escalation must carry at least two actionable options, got ${optionCount}`);

    // The tail excerpt attached must be CAPPED at the attach site (design note iii), not the
    // raw 500-line file verbatim.
    const cappedExpected = capWorkerTailLines(
      manyLines.split("\n").filter((l) => l.length > 0),
      WORKER_STALL_TAIL_ATTACH_MAX_LINES,
      WORKER_STALL_TAIL_ATTACH_MAX_BYTES,
    ).join("\n");
    assert.ok(call.body.includes(cappedExpected), "the attached excerpt must be exactly the capped tail");
    assert.ok(!call.body.includes("tail line 0"), "the OLDEST lines must be shed first — line 0 must not survive the cap");
  });
});

test("runWorkerStallDetectorRung: a run whose newest worker.state row is recent (within threshold) fires nothing at all", () => {
  withDir("worker-stall-quiet-ok", (root) => {
    const config = fakeConfig(root);
    const ledgerPath = ledgerPathFor(config);
    markLive(root, "W1-T1", "RUN-1");
    const recentTs = new Date(Date.now() - 5 * 60_000).toISOString();
    writeFileSync(
      ledgerPath,
      JSON.stringify({ ts: recentTs, run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "working" }) + "\n",
    );
    const issues = fakeIssues();
    runWorkerStallDetectorRung("craigoley", "remudero", config, ledgerPath, "DAEMON-RUN", 60 * 60_000, NOOP_LOG, issues);
    assert.equal(issues.calls.length, 0);
    assert.deepEqual(readLedger(ledgerPath).filter((l) => l.step === WORKER_STALLED_LEDGER_STEP), []);
  });
});

test("runWorkerStallDetectorRung: a repeated poll over the SAME silence appends nothing further and opens no second issue (design ii)", () => {
  withDir("worker-stall-dedup", (root) => {
    const config = fakeConfig(root);
    const ledgerPath = ledgerPathFor(config);
    markLive(root, "W1-T1", "RUN-1");
    const oldTs = new Date(Date.now() - 90 * 60_000).toISOString();
    writeFileSync(
      ledgerPath,
      JSON.stringify({ ts: oldTs, run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "quiet" }) + "\n",
    );
    const issues = fakeIssues();
    runWorkerStallDetectorRung("craigoley", "remudero", config, ledgerPath, "DAEMON-RUN", 60 * 60_000, NOOP_LOG, issues);
    // a second poll, moments later, over the exact same ledger — the SAME quiet episode.
    runWorkerStallDetectorRung("craigoley", "remudero", config, ledgerPath, "DAEMON-RUN", 60 * 60_000, NOOP_LOG, issues);
    runWorkerStallDetectorRung("craigoley", "remudero", config, ledgerPath, "DAEMON-RUN", 60 * 60_000, NOOP_LOG, issues);

    const stalledRows = readLedger(ledgerPath).filter((l) => l.step === WORKER_STALLED_LEDGER_STEP);
    assert.equal(stalledRows.length, 1, "three ticks over the same silence must append worker.stalled exactly once");
    assert.equal(issues.calls.length, 1, "and open exactly one issue, never a sibling per tick (the W1-T345 storm shape)");
  });
});

test("runWorkerStallDetectorRung: a run that speaks again re-arms — a LATER quiet episode fires a SECOND time", () => {
  withDir("worker-stall-rearm", (root) => {
    const config = fakeConfig(root);
    const ledgerPath = ledgerPathFor(config);
    markLive(root, "W1-T1", "RUN-1");
    const firstOldTs = new Date(Date.now() - 90 * 60_000).toISOString();
    writeFileSync(
      ledgerPath,
      JSON.stringify({ ts: firstOldTs, run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "quiet" }) + "\n",
    );
    const issues = fakeIssues();
    runWorkerStallDetectorRung("craigoley", "remudero", config, ledgerPath, "DAEMON-RUN", 60 * 60_000, NOOP_LOG, issues);
    assert.equal(issues.calls.length, 1);

    // the run speaks again (a fresh worker.state transition) — its ts is pinned strictly AFTER
    // the just-appended worker.stalled row's own real-clock ts (appendLedger stamps that itself,
    // so it is read back rather than guessed), which is exactly the ordering `findStalledWorkers`
    // requires to treat the episode as over.
    const firstStalledTs = readLedger(ledgerPath).find((l) => l.step === WORKER_STALLED_LEDGER_STEP)?.ts as string;
    assert.ok(firstStalledTs, "the first worker.stalled row must exist before this step");
    const spokeAgainTs = new Date(Date.parse(firstStalledTs) + 1_000).toISOString();
    writeFileSync(
      ledgerPath,
      JSON.stringify({ ts: spokeAgainTs, run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "working" }) + "\n",
      { flag: "a" },
    );
    // then goes quiet again long enough to re-trip the SAME threshold — an injected clock
    // (Rule 18) proves this without a real 60-minute wait.
    const laterNow = () => Date.parse(spokeAgainTs) + 61 * 60_000;
    runWorkerStallDetectorRung("craigoley", "remudero", config, ledgerPath, "DAEMON-RUN", 60 * 60_000, NOOP_LOG, issues, laterNow);

    const stalledRows = readLedger(ledgerPath).filter((l) => l.step === WORKER_STALLED_LEDGER_STEP);
    assert.equal(stalledRows.length, 2, "a later quiet episode, after the run spoke again, must fire a SECOND worker.stalled row");
    assert.equal(issues.calls.length, 2, "and a second NEEDS ME issue — the episode boundary re-arms delivery too");
  });
});

test("runWorkerStallDetectorRung: no LIVE in-flight runs at all ⇒ no ledger touch, no escalation call", () => {
  withDir("worker-stall-idle", (root) => {
    const config = fakeConfig(root);
    const ledgerPath = ledgerPathFor(config);
    const issues = fakeIssues();
    runWorkerStallDetectorRung("craigoley", "remudero", config, ledgerPath, "DAEMON-RUN", 60 * 60_000, NOOP_LOG, issues);
    assert.equal(issues.calls.length, 0);
    assert.deepEqual(readLedger(ledgerPath), []);
  });
});

// ── acceptance 4: NEVER kills, signals, defers or strikes the run ──────────────────────────

test("runWorkerStallDetectorRung: never calls process.kill — a stalled verdict never sends a signal to the run", () => {
  withDir("worker-stall-never-kill", (root) => {
    const config = fakeConfig(root);
    const ledgerPath = ledgerPathFor(config);
    markLive(root, "W1-T1", "RUN-1");
    const oldTs = new Date(Date.now() - 90 * 60_000).toISOString();
    writeFileSync(
      ledgerPath,
      JSON.stringify({ ts: oldTs, run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "quiet" }) + "\n",
    );
    const issues = fakeIssues();
    const originalKill = process.kill;
    let killCalled = false;
    // A falsifier, not a mock of intent. Signal 0 is the ORDINARY liveness probe
    // `liveInflightRuns`'s own `defaultIsPidAlive` legitimately issues on every call (it never
    // actually kills anything) — that one is let through. Any OTHER signal is a real act against
    // the run's process and must never happen here, so it is caught and thrown loudly instead of
    // silently no-op'd.
    (process as unknown as { kill: (pid: number, signal?: unknown) => boolean }).kill = (pid: number, signal?: unknown) => {
      if (signal === 0 || signal === "0") {
        return originalKill.call(process, pid, 0); // the ordinary liveness probe — never a real kill
      }
      killCalled = true;
      throw new Error(`process.kill called with signal ${JSON.stringify(signal)} — the detector must NEVER act on the run`);
    };
    try {
      assert.doesNotThrow(() =>
        runWorkerStallDetectorRung("craigoley", "remudero", config, ledgerPath, "DAEMON-RUN", 60 * 60_000, NOOP_LOG, issues),
      );
    } finally {
      process.kill = originalKill;
    }
    assert.equal(killCalled, false, "the detector must never call process.kill against the stalled run");
  });
});

test("runWorkerStallDetectorRung: the run's OWN in-flight lock is untouched — still live, same pid/run_id, after a stalled verdict", () => {
  withDir("worker-stall-lock-untouched", (root) => {
    const config = fakeConfig(root);
    const ledgerPath = ledgerPathFor(config);
    markLive(root, "W1-T1", "RUN-1");
    const lockPath = join(root, "state", "inflight", "W1-T1.lock");
    const before = readFileSync(lockPath, "utf8");
    const oldTs = new Date(Date.now() - 90 * 60_000).toISOString();
    writeFileSync(
      ledgerPath,
      JSON.stringify({ ts: oldTs, run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "quiet" }) + "\n",
    );
    const issues = fakeIssues();
    runWorkerStallDetectorRung("craigoley", "remudero", config, ledgerPath, "DAEMON-RUN", 60 * 60_000, NOOP_LOG, issues);
    const after = readFileSync(lockPath, "utf8");
    assert.equal(after, before, "the detector must never touch the run's own lock — it only appends a ledger row and files an issue");
  });
});

test("runWorkerStallDetectorRung: the escalation carries the RECOMMENDATION 'leave it running' — the fixed threshold alone must never be read as a verdict to stop the run", () => {
  withDir("worker-stall-recommendation", (root) => {
    const config = fakeConfig(root);
    const ledgerPath = ledgerPathFor(config);
    markLive(root, "W1-T1", "RUN-1");
    const oldTs = new Date(Date.now() - 90 * 60_000).toISOString();
    writeFileSync(
      ledgerPath,
      JSON.stringify({ ts: oldTs, run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "quiet" }) + "\n",
    );
    const issues = fakeIssues();
    runWorkerStallDetectorRung("craigoley", "remudero", config, ledgerPath, "DAEMON-RUN", 60 * 60_000, NOOP_LOG, issues);
    assert.ok(/leave it running/.test(issues.calls[0].body));
    assert.ok(/never auto-killed|never kill/i.test(issues.calls[0].body), "the body must be explicit that the detector itself never acts on the run");
  });
});

// ── a tiny type-level sanity check that WorkerStallCandidate's shape matches what the rung reads ──

test("WorkerStallCandidate: quietMs and lastState round-trip through findStalledWorkers", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const lines = [{ run_id: "RUN-1", task_id: "W1-T1", step: WORKER_STATE_LEDGER_STEP, state: "tool-executing", ts: "2026-08-17T10:00:00.000Z" }];
  const out: WorkerStallCandidate[] = findStalledWorkers([{ runId: "RUN-1", taskId: "W1-T1" }], lines, 60 * 60_000, now);
  assert.equal(out[0].quietMs, 2 * 60 * 60_000);
  assert.equal(out[0].lastState, "tool-executing");
});
