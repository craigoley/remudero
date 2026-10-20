// test/the-restart-yield-machinery-retires-once-runs-are-children.test.ts — W1-T9089 (ADR 0007 A.10).
//
// Once every build run is a child a booting daemon adopts, a freshness restart has nothing of its own to drain but reviews
// and detached actions. The restart latch, its holdouts and yields, the self-path prefix list and #11861's declaration
// weighing existed only because a restart had to drain runs inside its own process; six defects in one week came from
// them. What stays is the image-recycle path, and `auto`'s demotion becomes an escalation.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";

import { clockFromIsoFn, clockFromMillisFn } from "#src/lib/clock.js";
import { runDaemon } from "#src/lib/daemon.js";
import * as deployJudge from "#src/lib/deploy-judge.js";
import { requestPause } from "#src/lib/fleet-control.js";
import { loadPlan } from "#src/lib/plan.js";
import {
  QuietRoundEndedError, RECYCLE_YIELD_LEDGER_STEP, runQuietWorkerWatchdog, type QuietWatchdogOptions,
} from "#src/lib/quiet-worker-watchdog.js";
import { recyclePauseDetail } from "#src/lib/recycle-yield.js";
import { runChildModeIsOn } from "#src/lib/run-child.js";
import {
  RUN_CHILD_ADOPTION_PASS_STEP, RUN_CHILD_CONTRACT_FAILING_STEP, RUN_CHILD_MODE_DECISION_STEP, createRunChildModeTracker,
  runChildModeFor, type RunChildContractEscalation,
} from "#src/lib/run-child-mode.js";
import type { RunResult } from "#src/lib/run-result.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { daemonRunChildContract, roundEndedHandoffRows, watchDispatchSpawn } from "#src/run-task.js";

const scratch: string[] = [];
const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9089-${label}-`));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const result = (id: string): RunResult => ({ taskId: id, runId: id, merged: false, verdict: "no_pr", costUsd: 0 });
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const RETIRED_ROWS = ["daemon.restart_holdout", "daemon.restart_yield_asked", "daemon.freshness_restart_waiting", "daemon.restart_latch_cost"];

test("W1-T9089: a restart with live children writes no latch, yield or holdout row", async () => {
  const root = tmp("children");
  const path = join(root, "tasks.yaml");
  writeFileSync(path, ["A", "B"].map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const rows: Array<Record<string, unknown>> = [];
  const settles = new Map(["A", "B"].map((id) => [id, deferred<RunResult>()]));
  const offered: Array<Record<string, unknown>> = [];
  let now = Date.now();
  let stale = false;
  let stop = false;
  const run = runDaemon(loadPlan(path), {
    refreshMerged: () => () => false,
    checkStop: () => stop ? "cleanup" : undefined,
    checkFreshness: () => stale ? { stale: true, oldSha: OLD, newSha: NEW, installNeeded: false,
      changes: [{ sha: NEW, subject: "fix(daemon): reload the dispatch loop", files: ["src/lib/daemon.ts"] }] } : { stale: false },
    now: () => new Date(now),
    sleep: async () => { now += 3_600_000; await delay(1); },
    runOne: (id, options) => {
      offered.push({ ...options });
      const settled = settles.get(id)!.promise;
      options!.onChild!({ started: true, runId: id, dir: root, pid: process.pid, settled,
        abort: async () => { throw new Error("a freshness restart never aborts a child"); } });
      return settled;
    },
    log: (step, extra) => { rows.push({ step, ...extra }); },
  }, { laneCount: 2, pollIntervalMs: 5 });
  try {
    for (let i = 0; i < 1000 && offered.length < 2; i++) await delay(2);
    assert.equal(offered.length, 2, "both runs started as children");
    stale = true;
    const summary = await run;
    assert.equal(summary.stopReason, "stale");
    assert.equal(rows.some((r) => r.step === "daemon.freshness_decision" && r.action === "restart"), true);
    assert.deepEqual(rows.find((r) => r.step === "daemon.freshness_exit")?.children_left_running, ["A", "B"],
      "the children run on for the next boot to adopt");
    for (const step of RETIRED_ROWS) assert.equal(rows.some((r) => r.step === step), false, `${step} is retired`);
    for (const options of offered) {
      assert.equal("restartAtWorkerBoundary" in options, false, "a restart never reaches into a run at its boundary");
    }
    assert.equal("holdouts" in (rows.find((r) => r.step === "daemon.freshness_exit")?.phases_ms as object), false);
  } finally {
    stop = true;
    for (const [id, settle] of settles) settle.resolve(result(id));
    await run;
  }
});

test("W1-T9089: an image recycle still checkpoints a child run", async () => {
  // The child run's quiet-worker watchdog reads the recycle PAUSE file deploy/recycle-container.sh writes; a pending
  // recycle ends the implement round on the checkpoint path and leaves a worker_round receipt the next boot restores.
  const root = tmp("recycle");
  const reads = { recycle: 0 };
  const recyclePending = (): string | undefined => { reads.recycle++; return recyclePauseDetail(root); };
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const commits: string[] = [];
  let pushes = 0;
  const clock = { ms: 0 };
  let tick: (() => Promise<void>) | undefined;
  const raw = (async (args: { signal?: AbortSignal; streamObserver?: (e: unknown) => void }) => {
    args.streamObserver?.({ kind: "working", tsMs: 0 });
    clock.ms = 1_000;
    await tick?.();
    if (args.signal?.aborted) throw new Error("The operation was aborted");
    return "raw-finished";
  }) as never;
  const spawn = () => watchDispatchSpawn(raw, {
    enabled: true, taskId: "W1-T9089", runId: "W1-T9089-1", ledgerPath: join(root, "ledger.ndjson"), fallbackBoundMs: 60_000,
    spawnArgs: { cwd: join(root, "wt"), settingsFile: join(root, "settings.json") } as never,
    task: { files: ["src/a.ts"], acceptance: [] } as never,
    provider: () => "claude",
    log: (step, fields) => rows.push({ step, fields }),
    recyclePending,
  }, {
    runWatchdog: ((options: QuietWatchdogOptions) => {
      const handle = runQuietWorkerWatchdog({ ...options, clock: clockFromMillisFn(() => clock.ms), listProcesses: () => [], quietFloorMs: 30_000 });
      tick = handle.tick;
      return { ...handle, start: () => () => {} };
    }) as never,
    hasUncommittedChanges: (() => true) as never,
    commit: ((_cwd: string, _files: readonly string[], message: string) => { commits.push(message); return { committed: true, undeclared: [] }; }) as never,
    push: (async () => { pushes += 1; }) as never,
    headSha: () => "e".repeat(40),
  });

  // No PAUSE: the round runs on, and with the latch retired nothing else can end it.
  assert.equal(await spawn()({} as never), "raw-finished");
  assert.equal(commits.length, 0);
  assert.ok(reads.recycle > 0, "the watchdog read the recycle pause file");

  requestPause(root, "container recycle (deploy/recycle-container.sh)");
  let ended: QuietRoundEndedError | undefined;
  await assert.rejects(spawn()({} as never), (error) => {
    assert.ok(error instanceof QuietRoundEndedError);
    ended = error;
    return true;
  });
  assert.equal(ended!.detail.trigger, "recycle");
  assert.match(ended!.detail.reason, /^recycle pending: PAUSE requested: container recycle \(deploy\/recycle-container\.sh\)/);
  assert.equal(pushes, 1, "the checkpoint is pushed before the lane is released");
  assert.match(commits[0], /^chore\(checkpoint\): yield at container recycle\n/);
  const yielded = rows.find((row) => row.step === RECYCLE_YIELD_LEDGER_STEP);
  assert.equal(yielded?.fields.decision, "acted");
  assert.match(String(yielded?.fields.recycle), /container recycle/);
  assert.equal("restart" in (yielded?.fields ?? {}), false, "no restart-latch detail rides the recycle row");
  const receipt = roundEndedHandoffRows(ended!.detail, "run-W1-T9089-1");
  assert.deepEqual(receipt.map((r) => r.step), ["run.freshness_handoff", "verdict"]);
  assert.equal(receipt[0].fields.trigger, "recycle");
});

type Row = { step: string } & Record<string, unknown>;
let second = 0;
const at = (): string => new Date(Date.UTC(2026, 9, 20, 0, 0, second++)).toISOString();

test("W1-T9089: a contract failure escalates once no in-process path exists", () => {
  const promoted: Row[] = [
    { step: "daemon.start", ts: at() },
    { step: RUN_CHILD_ADOPTION_PASS_STEP, ts: at(), live: 0, adopted: 0, unreadable: 0, misidentified: 0 },
    { step: "run_child.shadow", ts: at(), contract: "ok", tree_peak_bytes: 300 * 2 ** 20, class_estimate_bytes: 512 * 2 ** 20 },
    { step: "daemon.start", ts: at() },
    { step: RUN_CHILD_ADOPTION_PASS_STEP, ts: at(), live: 0, adopted: 0, unreadable: 0, misidentified: 0 },
    { step: RUN_CHILD_MODE_DECISION_STEP, ts: at(), to: "on" },
  ];
  const tracker = createRunChildModeTracker(promoted, clockFromIsoFn(at));
  const healthy = runChildModeFor("auto", tracker.evidence()).decision!;
  tracker.observe("run_child.lost", { detail: "pid 4242 is gone", stderr_tail: "" });
  const failing = runChildModeFor("auto", tracker.evidence()).decision!;
  // There is no in-process path to fall back to: the mode stays on and the decision flags the contract instead.
  assert.equal(failing.from, "on");
  assert.equal(failing.to, "on");
  assert.equal(failing.contract_failing, true);
  assert.match(failing.reason, /stays on, escalated: 1 lost child/);
  assert.deepEqual(runChildModeIsOn(() => "auto", tracker.evidence), { on: true });

  const delivered: RunChildContractEscalation[] = [];
  const ledgered: Row[] = [];
  const contract = daemonRunChildContract((escalation) => { delivered.push(escalation); return "https://github.com/acme/remudero/issues/9"; },
    (step, extra) => { ledgered.push({ step, ...extra }); });
  assert.equal(contract(healthy), false, "a healthy decision escalates nothing");
  assert.equal(contract(undefined), false);
  assert.equal(contract(failing), true);
  assert.equal(contract(failing), false, "one escalation per evidence window, however many dispatches re-decide");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].class, "MANUAL");
  assert.match(delivered[0].detail, /1 lost child/);
  assert.ok(delivered[0].options.some((option) => option.label === delivered[0].recommendation));
  assert.deepEqual(ledgered.map((row) => row.step), [RUN_CHILD_CONTRACT_FAILING_STEP]);
  assert.equal(ledgered[0].issue_url, "https://github.com/acme/remudero/issues/9");
  assert.equal(ledgered[0].window_start, failing.window_start);
});

test("W1-T9089: the declaration-weighed stop-gap is deleted with the self-path list", async () => {
  const retired = new URL(["..", "src", "lib", "advance-declarations.js"].join("/"), import.meta.url).href;
  await assert.rejects(import(retired as string), (error: NodeJS.ErrnoException) =>
    error.code === "ERR_MODULE_NOT_FOUND");
  for (const name of ["DAEMON_SELF_PATH_PREFIXES", "DAEMON_SELF_COMMIT_SCOPE", "DAEMON_DECLARATION"]) {
    assert.equal(name in deployJudge, false, `${name} is retired`);
  }
  // The daemon's own code, a daemon-scoped subject and the entry module's daemon declarations weigh as any other source.
  for (const change of [
    { sha: NEW, subject: "fix(daemon): reload the dispatch loop", files: ["src/lib/daemon.ts"] },
    { sha: NEW, subject: "perf(sweep): one read", files: ["src/lib/sweep.ts"] },
    { sha: NEW, subject: "fix: entry", files: ["src/run-task.ts"], declarations: ["daemonCommand"] },
  ]) {
    const worth = deployJudge.freshnessAdvanceWorth(change);
    assert.equal(worth.score, 1, `${change.files[0]} is the deterministic source floor, never the self-path 18`);
    assert.match(worth.reason, /deterministic floor 1/);
  }
  assert.equal(deployJudge.freshnessAdvanceWorth({ sha: NEW, files: ["plan/tasks.d/x.yaml"] }).score, 0);
});
