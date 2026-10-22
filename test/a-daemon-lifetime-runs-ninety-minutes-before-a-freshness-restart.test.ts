// OPERATOR RULING 2026-10-17: FRESHNESS_MIN_LIFETIME_MS = 90 minutes, with two scoring fixes (B1, B2). On 2026-10-17 the
// daemon read stale ~20 min after each boot and upper_age released it 30 min later, so it restarted about every 75 min:
// 18.2 freshness restarts/day replayed over the 1406 commits of 10-12..10-17, and 10.9/day with a 90-minute floor.
// B1: an image input scored 18 for a daemon PROCESS restart, which cannot deliver an image (only a recycle does).
// B2: a daemon-scoped subject scored 18 even when the commit touched no file the daemon process runs.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon, type DaemonFreshness } from "#src/lib/daemon.js";
// A NAMESPACE import: the ruling's exports do not exist at the merge base, and a named import would fail the whole file
// at load, which reads as "never ran" rather than as a red.
import * as judge from "#src/lib/deploy-judge.js";
import { loadPlan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const MINUTE = 60_000;
const START = Date.parse("2026-10-17T00:00:00Z");
const window = { value: 10 * MINUTE, reason: "measured follow-on boots were 1–10 minutes apart" };
// W1-T9089: the daemon's own code weighs the source floor of 1, so a weight-18 advance is the threshold's worth of commits.
const DAEMON_CHANGE = [
  ...Array.from({ length: judge.DEPLOY_RESTART_SCORE_THRESHOLD.value - 1 }, (_, index) => ({ sha: `self-pad-${index}`, files: ["src/lib/daemon.ts"] })),
  { sha: "self", files: ["src/lib/daemon.ts"] },
];
const LOCKFILE = [{ sha: "lock", files: ["package-lock.json"] }];

function decide(nowMs: number, options: Partial<Parameters<typeof judge.decideFreshnessRestart>[0]> = {}) {
  return judge.decideFreshnessRestart({
    changes: DAEMON_CHANGE, busy: true, staleSinceMs: 0, nowMs, state: { total: 0, scoredShas: [] }, ...options,
  });
}

test("the minimum lifetime is the operator's 90 minutes", () => {
  assert.equal(judge.FRESHNESS_MIN_LIFETIME_MS, 90 * MINUTE);
  assert.equal(judge.MIN_LIFETIME_HOLD, "min_lifetime");
});

test("coalesceFreshnessRestart holds a weight-18 advance at boot + 31 min with min_lifetime, and install inputs pass", () => {
  const decision = decide(31 * MINUTE);
  assert.equal(decision.restartTrigger, "change", "the control: a full-weight daemon change");
  const input = { decision, newSha: "self", lastAdvanceAtMs: 0, staleSinceMs: 0, nowMs: 31 * MINUTE, window, lifetimeStartedAtMs: 0 };
  // Before the ruling this was { action: "restart", reason: "upper_age" }: staleness 31 min passed half the horizon.
  assert.deepEqual(judge.coalesceFreshnessRestart(input), {
    action: "hold", reason: "min_lifetime", heldMs: 31 * MINUTE, windowEndsAtMs: 10 * MINUTE,
  });
  assert.deepEqual(judge.coalesceFreshnessRestart({ ...input, installInputsChanged: true }), {
    action: "restart", reason: judge.INSTALL_INPUTS_RELEASE, heldMs: 31 * MINUTE, windowEndsAtMs: 10 * MINUTE,
  });
  assert.equal(judge.coalesceFreshnessRestart({ ...input, nowMs: 90 * MINUTE - 1 }).action, "hold");
  assert.deepEqual(judge.coalesceFreshnessRestart({ ...input, decision: decide(90 * MINUTE), nowMs: 90 * MINUTE }), {
    action: "restart", reason: "upper_age", heldMs: 90 * MINUTE, windowEndsAtMs: 10 * MINUTE,
  });
  assert.equal(judge.coalesceFreshnessRestart({ ...input, minLifetimeMs: 0 }).reason, "upper_age", "an explicit floor overrides");
});

test("the minimum lifetime holds the age and idle releases too, and never a fast path", () => {
  const base = { newSha: "low", lastAdvanceAtMs: 0, staleSinceMs: 0, window, lifetimeStartedAtMs: 0 };
  const low = [{ sha: "low", files: ["src/lib/inbox.ts"] }];
  const aged = decide(60 * MINUTE, { changes: low });
  assert.equal(aged.restartTrigger, "age");
  assert.equal(judge.coalesceFreshnessRestart({ ...base, decision: aged, nowMs: 60 * MINUTE }).reason, "min_lifetime");
  const idle = decide(MINUTE, { changes: low, busy: false });
  assert.equal(idle.restartTrigger, "idle");
  assert.equal(judge.coalesceFreshnessRestart({ ...base, decision: idle, nowMs: MINUTE }).reason, "min_lifetime");
  assert.equal(judge.coalesceFreshnessRestart({ ...base, decision: idle, nowMs: MINUTE, installInputsChanged: true }).reason,
    judge.INSTALL_INPUTS_RELEASE);
  assert.equal(judge.coalesceFreshnessRestart({ ...base, decision: idle, nowMs: 90 * MINUTE }).reason, idle.reason,
    "a grown lifetime releases the idle restart with its own reason");
  for (const decision of [decide(MINUTE, { withheldReviews: 1 }), decide(MINUTE, { changes: undefined })]) {
    const result = judge.coalesceFreshnessRestart({ ...base, decision, nowMs: MINUTE });
    assert.equal(result.action, "restart");
    assert.equal(result.reason, decision.restartTrigger === "unreadable" ? "unreadable_advance" : "withheld_reviews");
  }
  const deferred = decide(MINUTE, { changes: low });
  assert.equal(judge.coalesceFreshnessRestart({ ...base, decision: deferred, nowMs: MINUTE }), deferred, "a deferral stays one");
});

test("B1/B2: an image-only or a scope-only test commit scores by its files for a daemon restart", () => {
  assert.equal(judge.freshnessAdvanceWorth({ sha: "1", subject: "test(sweep): x", files: ["test/a.test.ts"] }).score, 0);
  assert.equal(judge.freshnessAdvanceWorth({ sha: "2", files: ["deploy/Dockerfile"] }).score, 0);
  assert.equal(judge.freshnessAdvanceWorth({ sha: "3", files: ["deploy/entrypoint.sh", "scripts/x.mjs"] }).score, 1);
  assert.equal(judge.freshnessAdvanceWorth({ sha: "4", files: ["src/lib/serve-supervisor.ts"] }).score, 1,
    "baked supervisor source is src, weighed as src");
  assert.equal(judge.deterministicDeployWorth({ sha: "5", files: ["deploy/Dockerfile"] }).score, 18,
    "the control: the recycle's own scoring still weighs the image in full");
  assert.equal(judge.deterministicDeployWorth({ sha: "6", files: ["plan/tasks.d/x.yaml"] }).score, 0);
  // W1-T9089: no path is full weight any more — src/ and scripts/ weigh the floor, everything else the source rules weigh 0.
  for (const [files, score] of [[["src/lib/inbox.ts"], 1], [["bin/rmd"], 0], [["package.json"], 0], [["package-lock.json"], 0], [["tsconfig.json"], 0], [[], 0]] as const) {
    assert.equal(judge.freshnessAdvanceWorth({ sha: "7", subject: "fix(sweep): x", files: [...files] }).score, score, files.join(",") || "unread");
  }
  assert.equal(judge.freshnessAdvanceWorth({ sha: "8", subject: "fix(drain): x", files: ["docs/tsconfig.json"] }).score, 0,
    "only a src/ or scripts/ path reaches the runtime");
  assert.equal(judge.freshnessAdvanceWorth({ sha: "9", files: ["src/lib/daemon.ts", "deploy/Dockerfile"] }).score, 1);
});

type Row = { step: string; atMs: number; extra: Record<string, unknown> };

/**
 * Six hours of the daemon's own life: a weight-18 advance every 20 minutes, each restart a new lifetime that boots onto
 * the newest advance, exactly as stopForFreshness hands the process back to the entrypoint.
 */
async function sixHourStream(changesFor: (sha: string) => { sha: string; files: string[] }[]) {
  const END = START + 6 * 60 * MINUTE;
  const advanceAt = (atMs: number) => Math.floor((atMs - START) / (20 * MINUTE));
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}min-lifetime-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let nowMs = START;
  const rows: Row[] = [];
  const restarts: number[] = [];
  while (nowMs < END) {
    const bootAdvance = advanceAt(nowMs);
    const summary = await runDaemon(loadPlan(path), {
      refreshMerged: () => () => true,
      runOne: async (taskId) => ({ taskId, runId: "unused", merged: true, costUsd: 0, verdict: "merged" }),
      now: () => new Date(nowMs),
      sleep: async () => { nowMs += MINUTE; },
      sweep: async () => ({}),
      checkStop: () => (nowMs >= END ? "six hours replayed" : undefined),
      checkFreshness: (): DaemonFreshness => {
        const head = advanceAt(nowMs);
        if (head === bootAdvance) return { stale: false };
        const changes = Array.from({ length: head - bootAdvance }, (_, k) => changesFor(`a${bootAdvance + k + 1}`)).flat();
        return { stale: true, oldSha: `a${bootAdvance}`, newSha: `a${head}`, changes };
      },
      readLedgerLines: () => [],
      log: (step, extra = {}) => rows.push({ step, atMs: nowMs, extra }),
    }, { sweepWallClockBoundMs: 24 * 60 * MINUTE });
    if (summary.stopReason !== "stale") break;
    restarts.push(nowMs);
    nowMs += MINUTE; // the boot
  }
  return { rows, restarts };
}

test("a 6-h stream with a weight-18 advance every 20 min restarts the daemon at most 4 times, each hold ledgered", async () => {
  const { rows, restarts } = await sixHourStream((sha) => [{ sha, files: ["src/lib/daemon.ts"] }]);
  assert.ok(restarts.length >= 1, "the control: the stream does restart the daemon");
  assert.ok(restarts.length <= 4, `restarts at minutes ${restarts.map((at) => (at - START) / MINUTE).join(", ")}`);
  const held = rows.filter((row) => row.step === "daemon.freshness_coalesced" && row.extra.held_by === "min_lifetime");
  const decisions = rows.filter((row) => row.step === "daemon.freshness_decision" && row.extra.held_by === "min_lifetime");
  assert.ok(held.length > 0 && decisions.length === held.length, "every min_lifetime hold is on both rows");
  for (const row of [...held, ...decisions]) {
    assert.equal(row.extra.min_lifetime_ms, 90 * MINUTE);
    assert.equal(row.extra.reason, "min_lifetime");
    assert.ok(Number(row.extra.lifetime_ms) < 90 * MINUTE);
  }
  const released = rows.filter((row) => row.step === "daemon.freshness_decision" && row.extra.action === "restart");
  for (const row of released) assert.ok(Number(row.extra.lifetime_ms) >= 90 * MINUTE, `released at ${row.extra.lifetime_ms}`);
});

test("an install-input advance restarts a young daemon on its first decision", async () => {
  const { rows, restarts } = await sixHourStream((sha) => [{ sha, files: ["src/lib/daemon.ts", ...LOCKFILE[0]!.files] }]);
  const first = rows.find((row) => row.step === "daemon.freshness_decision" && row.extra.action === "restart")!;
  assert.equal(first.extra.reason, judge.INSTALL_INPUTS_RELEASE);
  assert.ok(Number(first.extra.lifetime_ms) < 90 * MINUTE);
  assert.ok(restarts.length > 4, "the control: install inputs are never held for the lifetime");
});
