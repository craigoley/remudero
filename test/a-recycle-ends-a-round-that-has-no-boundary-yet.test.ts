// 2026-10-11, core: a baked-path recycle wrote its PAUSE at 16:16:08Z. Two lanes yielded at their next worker boundary
// within minutes, but W1-T8038 was inside its FIRST implement worker, which has no boundary to yield at. Every freed lane
// sat idle behind the PAUSE for the recycle's whole 3000 s wait; the recycle then refused at 17:08:02Z, and W1-T8038's
// worker finished 80 s later. These tests pin the fix: a pending recycle ends a round mid-stream on the W1-T7807
// end_round checkpoint path, and the handoff is a resumable freshness yield.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import { pendingWorkerBoundaryHandoffs } from "../src/lib/daemon.js";
import type { DispatchClaimReserver } from "../src/lib/dispatch-claim.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  QUIET_JUDGED_LEDGER_STEP,
  QuietRoundEndedError,
  RECYCLE_YIELD_LEDGER_STEP,
  runQuietWorkerWatchdog,
  type EndRoundResult,
  type QuietWatchdogHandle,
  type QuietWatchdogOptions,
} from "../src/lib/quiet-worker-watchdog.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { spawnWorker, WorkerResult } from "../src/lib/worker.js";
import { roundEndedHandoffRows, runTask, watchDispatchSpawn } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const RECYCLE = "PAUSE requested: container recycle (deploy/recycle-container.sh)";
const SHA = "d".repeat(40);

/** The watchdog over a worker that is ACTIVE (never quiet), with the recycle reader and checkpoint seams injected. */
function busyRig(seams: { recycle: () => string | undefined; endRound: (reason: string, trigger?: "recycle") => Promise<EndRoundResult> }) {
  const clock = { ms: 0 };
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let judged = 0;
  const dog = runQuietWorkerWatchdog({
    taskId: "W1-T8038", runId: "W1-T8038-1791735170004", rootPid: () => 100, provider: () => "claude",
    history: () => [], fallbackBoundMs: 60_000, quietFloorMs: 30_000,
    clock: clockFromMillisFn(() => clock.ms),
    ledger: (step, extra) => rows.push({ step, extra }),
    listProcesses: () => [],
    judge: async () => { judged += 1; return undefined; },
    endRound: seams.endRound,
    recyclePending: seams.recycle,
  });
  return { clock, rows, dog, judged: () => judged };
}

test("recycle-yield: a pending recycle ends a busy round on the checkpoint path", async () => {
  let pending: string | undefined;
  const calls: Array<[string, string | undefined]> = [];
  const r = busyRig({
    recycle: () => pending,
    endRound: async (reason, trigger) => { calls.push([reason, trigger]); return { ended: true, checkpointSha: SHA }; },
  });
  r.dog.observer({ kind: "working", tsMs: 0 });

  // No recycle pending: an active worker is left entirely alone.
  r.clock.ms = 1_000;
  await r.dog.tick();
  assert.deepEqual(calls, []);
  assert.deepEqual(r.rows, []);

  // The recycle's PAUSE appears while the worker is still talking: the round ends at the next tick, not at a boundary.
  pending = RECYCLE;
  r.dog.observer({ kind: "working", tsMs: 2_000 });
  r.clock.ms = 2_500;
  await r.dog.tick();
  assert.deepEqual(calls, [[`recycle pending: ${RECYCLE}`, "recycle"]]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].step, RECYCLE_YIELD_LEDGER_STEP);
  assert.deepEqual(r.rows[0].extra, { decision: "acted", action: "end_round", recycle: RECYCLE, checkpoint_sha: SHA });

  // An ended round is never ended or judged again.
  r.clock.ms = 900_000;
  await r.dog.tick();
  assert.equal(calls.length, 1);
  assert.equal(r.judged(), 0);
});

test("recycle-yield: a refused recycle checkpoint is ledgered once and the quiet duty continues", async () => {
  for (const endRound of [
    async (): Promise<EndRoundResult> => ({ ended: false, reason: "checkpoint refused: x.ts" }),
    async (): Promise<EndRoundResult> => { throw new Error("push refused"); },
  ]) {
    let attempts = 0;
    const r = busyRig({ recycle: () => RECYCLE, endRound: async () => { attempts += 1; return endRound(); } });
    r.dog.observer({ kind: "working", tsMs: 0 });
    r.clock.ms = 1_000;
    await r.dog.tick();
    assert.equal(r.rows[0].step, RECYCLE_YIELD_LEDGER_STEP);
    assert.equal(r.rows[0].extra.decision, "action_failed");
    assert.equal(r.rows[0].extra.checkpoint_sha, null);
    assert.match(String(r.rows[0].extra.detail), /checkpoint refused: x\.ts|push refused/);
    // One attempt per spawn: the boundary yields catch the run instead of a retry every tick.
    r.clock.ms = 2_000;
    await r.dog.tick();
    assert.equal(attempts, 1);
    // The watchdog is still armed for a quiet episode (bound 60 s past the 30 s floor; no listing, so left alone).
    r.clock.ms = 200_000;
    await r.dog.tick();
    assert.ok(r.rows.some((row) => row.step === QUIET_JUDGED_LEDGER_STEP));
  }
});

test("recycle-yield: the dispatch spawn wires the recycle reader and checkpoints as a recycle", async () => {
  const captured: QuietWatchdogOptions[] = [];
  const handle: QuietWatchdogHandle = { observer: () => {}, tick: async () => {}, start: () => () => {} };
  const commits: string[] = [];
  let signal: AbortSignal | undefined;
  const reader = (): string | undefined => RECYCLE;
  const watch = (recyclePending?: () => string | undefined) => ({
    enabled: true, taskId: "W1-T8038", runId: "W1-T8038-1", ledgerPath: "/state/ledger.ndjson", fallbackBoundMs: 60_000,
    spawnArgs: { cwd: "/wt", settingsFile: "/wt/settings.json" } as never,
    task: { files: ["src/a.ts"], acceptance: [] } as never,
    provider: () => "claude",
    log: () => {},
    ...(recyclePending ? { recyclePending } : {}),
  });
  const seams = {
    runWatchdog: ((options: QuietWatchdogOptions) => { captured.push(options); return handle; }) as never,
    hasUncommittedChanges: (() => true) as never,
    commit: ((_cwd: string, _files: readonly string[], message: string) => { commits.push(message); return { committed: true, undeclared: [] }; }) as never,
    push: (async () => {}) as never,
    headSha: () => SHA,
  };

  // No reader (a manual run): the watchdog gets none, exactly as before.
  watchDispatchSpawn((async () => "raw") as never, watch(), seams);
  assert.equal(captured[0].recyclePending, undefined);

  const raw = (async (args: { signal?: AbortSignal }) => {
    signal = args.signal;
    const ended = await captured[1].endRound?.(`recycle pending: ${RECYCLE}`, "recycle");
    assert.deepEqual(ended, { ended: true, checkpointSha: SHA });
    throw new Error("The operation was aborted");
  }) as never;
  const watched = watchDispatchSpawn(raw, watch(reader), seams);
  assert.equal(captured[1].recyclePending, reader);
  await assert.rejects(watched({} as never), (error) => {
    assert.ok(error instanceof QuietRoundEndedError);
    assert.equal(error.detail.trigger, "recycle");
    assert.equal(error.detail.checkpointSha, SHA);
    assert.match(error.message, /for a pending container recycle/);
    return true;
  });
  assert.equal(signal?.aborted, true, "ending the round aborts the worker's stream");
  assert.match(commits[0], /^wip: yield at container recycle\n/);
  assert.match(commits[0], /Remudero-Task: W1-T8038/);
});

test("recycle-yield: a round a recycle ended is a resumable freshness handoff", () => {
  const branch = "run-W1-T8038-1791735170004";
  const rows = roundEndedHandoffRows({ checkpointSha: SHA, reason: `recycle pending: ${RECYCLE}`, trigger: "recycle" }, branch);
  assert.deepEqual(rows.map((r) => r.step), ["run.freshness_handoff", "verdict"]);
  assert.equal(rows[0].fields.waiting_on, "worker_round");
  assert.equal(rows[0].fields.trigger, "recycle");
  assert.equal(rows[1].fields.verdict, "handed_off");
  assert.equal(rows[1].fields.reason, "freshness_yield");
  const lines = rows.map((r) => JSON.stringify({ ts: "2026-10-11T16:16:13.000Z", task_id: "W1-T8038", step: r.step, ...r.fields }));
  assert.deepEqual(pendingWorkerBoundaryHandoffs(lines).get("W1-T8038"), { branch, headSha: SHA });

  // The quiet watchdog's own end_round keeps its verdict exactly as before.
  const quiet = roundEndedHandoffRows({ checkpointSha: SHA, reason: "stalled" }, branch);
  assert.deepEqual(quiet, [{ step: "verdict", fields: { verdict: "handed_off", reason: "quiet_worker_round_ended", branch, head_sha: SHA, detail: "stalled" } }]);
});

const PLAN_YAML = [
  "- id: T-RECYCLE-ROUND",
  "  title: recycle round fixture",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/run-task.ts]",
  "  origin: test",
  "  status: queued",
  "",
].join("\n");

function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "test-session", costUsd: 0, numTurns: 0, text: "", blocks: [], stderr: "", subtype: "success", isError: false,
    apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    ...over,
  };
}

test("recycle-yield: a run whose round a recycle ended hands off a resumable checkpoint", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recycle-round-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, PLAN_YAML);
  const origin = gitRepo({ bare: true, kind: "recycle-round-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "recycle-round-seed" });
  seed.addRemote("origin", origin.dir);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "-u", "origin", "main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "test"]);
  const fixedTime = 1791735170004;
  const branch = `run-T-RECYCLE-ROUND-${fixedTime}`;
  const gh = ghShim([{ when: "pr view", stdout: JSON.stringify({ headRefName: branch, body: "" }) }], { kind: "recycle-round" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${previousPath}`;
  const now = t.mock.method(Date, "now", () => fixedTime);
  let spawns = 0;
  // Recon answers; the implement worker is ended mid-round by a pending recycle, as the dispatch watchdog ends it.
  const spawn: typeof spawnWorker = async () => {
    spawns += 1;
    if (spawns === 1) return workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" });
    throw new QuietRoundEndedError({ checkpointSha: SHA, reason: `recycle pending: ${RECYCLE}`, trigger: "recycle" });
  };
  const claimReserver: DispatchClaimReserver = { mintAnchor: () => "recycle-round-anchor", attempt: () => "created", holder: () => undefined, drop: () => true };
  try {
    const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
    const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
    const result = await withLiveWritesAllowed(() => runTask("T-RECYCLE-ROUND", {
      skipGitSync: true, planPath, config, github, spawn, claimReserver,
      containmentExec: (token: string): Promise<ProbeExecResult> =>
        Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
      isolationExec: (): Promise<IsolationProbeExecResult> =>
        Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    }));
    assert.equal(result.verdict, "handed_off");
    const raw = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean);
    const rows = raw.map((line) => JSON.parse(line) as Record<string, unknown>);
    const receipt = rows.find((row) => row.step === "run.freshness_handoff");
    assert.equal(receipt?.waiting_on, "worker_round");
    assert.equal(receipt?.trigger, "recycle");
    const verdict = rows.find((row) => row.step === "verdict");
    assert.equal(verdict?.reason, "freshness_yield");
    assert.equal(verdict?.head_sha, SHA);
    assert.deepEqual(pendingWorkerBoundaryHandoffs(raw).get("T-RECYCLE-ROUND"), { branch, headSha: SHA }, "the next run restores this checkpoint");
  } finally {
    now.mock.restore();
    process.env.PATH = previousPath;
    rmSync(gh.dir, { recursive: true, force: true });
    origin.cleanup();
    seed.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
