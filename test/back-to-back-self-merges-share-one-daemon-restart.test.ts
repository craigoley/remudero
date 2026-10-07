import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, type DaemonFreshness } from "../src/lib/daemon.js";
import * as judge from "../src/lib/deploy-judge.js";
import { loadPlan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const PROOF = "test/back-to-back-self-merges-share-one-daemon-restart.test.ts";
const MINUTE = 60_000;
const START = Date.parse("2026-10-07T00:00:00Z");
const window = { value: 10 * MINUTE, reason: "measured follow-on boots were 1–10 minutes apart" };
const changes = (sha: string) => [{ sha, files: ["src/lib/daemon.ts"] }];

function decide(nowMs = 0, options: Partial<Parameters<typeof judge.decideFreshnessRestart>[0]> = {}) {
  return judge.decideFreshnessRestart({
    changes: changes("one"), busy: true, staleSinceMs: 0, nowMs,
    state: { total: 0, scoredShas: [] }, ...options,
  });
}

test(`${PROOF}: recorded window holds and releases at the quiet boundary`, () => {
  assert.equal(typeof judge.coalesceFreshnessRestart, "function");
  assert.equal(judge.FRESHNESS_COALESCE_WINDOW_MS.value, window.value);
  assert.match(judge.FRESHNESS_COALESCE_WINDOW_MS.reason, /2026-10-06/);
  const decision = decide();
  const input = { decision, newSha: "one", lastAdvanceAtMs: 0, staleSinceMs: 0, window };
  assert.deepEqual(judge.coalesceFreshnessRestart({ ...input, nowMs: 0 }), {
    action: "hold", reason: "coalescing one: waiting for a quiet advance window",
    heldMs: 0, windowEndsAtMs: 10 * MINUTE,
  });
  assert.equal(judge.coalesceFreshnessRestart({ ...input, nowMs: 10 * MINUTE - 1 }).action, "hold");
  assert.deepEqual(judge.coalesceFreshnessRestart({ ...input, nowMs: 10 * MINUTE }), {
    action: "restart", reason: "window_quiet", heldMs: 10 * MINUTE, windowEndsAtMs: 10 * MINUTE,
  });
});

test(`${PROOF}: defer passes unchanged and harmful lag bypasses the hold`, () => {
  const input = { newSha: "one", lastAdvanceAtMs: 0, staleSinceMs: 0, nowMs: 0, window };
  const deferred = decide(0, { changes: [{ sha: "low", files: ["src/lib/inbox.ts"] }] });
  assert.equal(judge.coalesceFreshnessRestart({ ...input, decision: deferred }), deferred);
  for (const decision of [decide(0, { withheldReviews: 1 }), decide(0, { changes: undefined })]) {
    const result = judge.coalesceFreshnessRestart({ ...input, decision });
    assert.equal(result.action, "restart");
    assert.equal(result.reason, decision.restartTrigger === "unreadable" ? "unreadable_advance" : "withheld_reviews");
    assert.equal(result.heldMs, 0);
  }
  const idle = decide(0, { busy: false, changes: [{ sha: "low", files: ["src/lib/inbox.ts"] }] });
  assert.equal(judge.coalesceFreshnessRestart({ ...input, decision: idle }).action, "restart");
  const aged = decide(60 * MINUTE, { changes: [] });
  assert.equal(judge.coalesceFreshnessRestart({ ...input, decision: aged, nowMs: 60 * MINUTE }).action, "restart");
});

test(`${PROOF}: upper age releases a freshly rearmed window at half the recorded threshold`, () => {
  const input = { newSha: "latest", lastAdvanceAtMs: 30 * MINUTE, staleSinceMs: 0, window };
  assert.equal(judge.coalesceFreshnessRestart({ ...input, decision: decide(), lastAdvanceAtMs: 29 * MINUTE, nowMs: 30 * MINUTE - 1 }).action, "hold");
  assert.deepEqual(judge.coalesceFreshnessRestart({ ...input, decision: decide(), nowMs: 30 * MINUTE }), {
    action: "restart", reason: "upper_age", heldMs: 30 * MINUTE, windowEndsAtMs: 40 * MINUTE,
  });
  const threshold = { value: 24, reason: "re-measured score" };
  assert.equal(judge.coalesceFreshnessRestart({
    ...input, decision: decide(0, { threshold, changes: [...changes("one"), ...changes("two")] }),
    nowMs: 15 * MINUTE, lastAdvanceAtMs: 15 * MINUTE, threshold, ageHorizonMs: 30 * MINUTE,
  }).reason, "upper_age");
});

type Row = { step: string; atMs: number; extra: Record<string, unknown> };

async function daemonRun(options: {
  advance: (minute: number) => string;
  busy?: boolean;
  harmfulAtMinute?: number;
  unreadable?: boolean;
  initiallyFresh?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}coalescing-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let nowMs = START;
  let releaseSweep: (() => void) | undefined;
  let passes = 0;
  const rows: Row[] = [];
  const summary = await runDaemon(loadPlan(path), {
    refreshMerged: () => () => true,
    runOne: async (taskId) => ({ taskId, runId: "unused", merged: true, costUsd: 0, verdict: "merged" }),
    now: () => new Date(nowMs),
    sleep: async () => {
      nowMs += MINUTE;
      assert.ok(nowMs <= START + 61 * MINUTE, "fake-clock fixture must terminate");
    },
    sweep: async () => {
      if (passes++ === 0 && options.busy) await new Promise<void>((resolve) => { releaseSweep = resolve; });
      return {};
    },
    checkFreshness: (): DaemonFreshness => {
      const minute = (nowMs - START) / MINUTE;
      if (options.initiallyFresh && minute === 0) return { stale: false };
      const sha = options.advance(minute);
      const unreadable = options.unreadable && minute >= (options.harmfulAtMinute ?? 0);
      return { stale: true, oldSha: "boot", newSha: sha, ...(unreadable ? {} : { changes: changes(sha) }) };
    },
    readLedgerLines: () => options.harmfulAtMinute !== undefined && !options.unreadable && nowMs >= START + options.harmfulAtMinute * MINUTE
      ? [JSON.stringify({ ts: new Date(nowMs).toISOString(), step: "review.post_refused", reviewer_code_freshness: "stale" })]
      : [],
    log: (step, extra = {}) => {
      rows.push({ step, atMs: nowMs, extra });
      if (step === "daemon.freshness_decision" && extra.action === "restart") releaseSweep?.();
    },
  }, { sweepWallClockBoundMs: 24 * 60 * MINUTE }).finally(() => releaseSweep?.());
  assert.equal(summary.stopReason, "stale");
  return rows;
}

const coalesced = (rows: Row[]) => rows.filter((row) => row.step === "daemon.freshness_coalesced");

test(`${PROOF}: back-to-back advances yield one restart after the rearmed window and ledger every hold`, async () => {
  for (const busy of [true, false]) {
    const rows = await daemonRun({ busy, advance: (minute) => minute < 3 ? "one" : "two" });
    const decisions = rows.filter((row) => row.step === "daemon.freshness_decision");
    const restarts = decisions.filter((row) => row.extra.action === "restart");
    assert.equal(restarts.length, 1);
    assert.equal(restarts[0]!.atMs, START + 13 * MINUTE);
    assert.equal(restarts[0]!.extra.new_sha, "two");
    assert.equal(restarts[0]!.extra.busy, busy);
    const held = coalesced(rows);
    assert.equal(held.length, decisions.length, "every held decision and final release is ledgered");
    assert.equal(held[0]!.extra.advances_coalesced, 1);
    assert.equal(held[0]!.extra.held_ms, MINUTE, "the first observation was the pre-cycle boundary");
    for (let index = 0; index < held.length; index++) {
      const row = held[index]!;
      assert.equal(row.extra.window_ms, 10 * MINUTE);
      assert.equal(row.extra.held_ms, row.atMs - START);
      assert.equal(row.extra.action, index === held.length - 1 ? "restart" : "hold");
      assert.equal(row.extra.new_sha, row.atMs < START + 3 * MINUTE ? "one" : "two");
      assert.equal(row.extra.advances_coalesced, row.atMs < START + 3 * MINUTE ? 1 : 2);
    }
    assert.equal(held.at(-1)!.extra.reason, "window_quiet");
  }
});

test(`${PROOF}: continuing advances release at thirty minutes while still busy`, async () => {
  const rows = await daemonRun({ busy: true, advance: (minute) => `sha-${Math.floor(minute / 5)}` });
  const release = coalesced(rows).at(-1)!;
  assert.equal(release.atMs, START + 30 * MINUTE);
  assert.equal(release.extra.reason, "upper_age");
  assert.equal(release.extra.advances_coalesced, 7);
  assert.equal(release.extra.held_ms, 30 * MINUTE);
  assert.equal(rows.filter((row) => row.step === "daemon.freshness_decision" && row.extra.action === "restart").length, 1);
});

test(`${PROOF}: withheld reviews and unreadable advances immediately release an active hold`, async () => {
  for (const unreadable of [false, true]) {
    const rows = await daemonRun({ busy: true, advance: () => "one", harmfulAtMinute: 3, unreadable });
    const release = coalesced(rows).at(-1)!;
    assert.equal(release.atMs, START + 3 * MINUTE);
    assert.equal(release.extra.action, "restart");
    assert.match(String(release.extra.reason), unreadable ? /unreadable/ : /withheld/);
    assert.equal(release.extra.held_ms, 3 * MINUTE);
  }
});

test(`${PROOF}: a new advance after a fresh first cycle opens the window on observation`, async () => {
  const rows = await daemonRun({ advance: () => "one", initiallyFresh: true });
  assert.equal(coalesced(rows)[0]!.extra.held_ms, 0);
  assert.equal(coalesced(rows).at(-1)!.atMs, START + 11 * MINUTE);
});

test(`${PROOF}: harmful lag on the first decision never opens a hold`, async () => {
  for (const unreadable of [false, true]) {
    const rows = await daemonRun({ busy: true, advance: () => "one", harmfulAtMinute: 0, unreadable });
    assert.equal(coalesced(rows).length, 0);
    const decision = rows.find((row) => row.step === "daemon.freshness_decision")!;
    assert.equal(decision.extra.action, "restart");
    assert.equal(decision.atMs, START + MINUTE);
  }
});
