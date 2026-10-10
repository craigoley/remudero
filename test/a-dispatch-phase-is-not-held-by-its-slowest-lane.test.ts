import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import * as daemon from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { runTask, type RunResult } from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

const minute = 60_000;
const stale = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: [{ sha: "b".repeat(40), subject: "fix: refresh", files: ["src/lib/daemon.ts"] }] };
const result = (id: string): RunResult => ({ taskId: id, runId: id, merged: true, verdict: "merged", costUsd: 0 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function worker(text: string): WorkerResult {
  return { sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

async function boundaryRun(t: TestContext, boundary: "preopen_gate" | "checkpoint" | "decision" | "worker" | "passed_gate", recycle = false,
  resumeAfter: boolean | "moved" = false, failure?: "scope" | "push", delayedCheckpointRead = false) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t7697-boundary-"));
  const origin = gitRepo({ bare: true });
  const seed = gitRepo();
  seed.addRemote("origin", origin.dir);
  seed.git("push", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const repo = gitRepo({ cloneFrom: origin.dir });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@remudero.invalid");
  renameSync(repo.dir, join(root, "repos", "remudero"));
  const planPath = join(root, "tasks.yaml");
  const id = "T-BOUNDARY";
  writeFileSync(planPath, `- id: ${id}\n  title: boundary fixture\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  origin: test\n  status: queued\n  files: [src/change.ts]\n`);
  const epoch = Date.now();
  let clock = epoch;
  t.mock.method(Date, "now", () => clock);
  const branch = `run-${id}-${epoch}`;
  const gh = ghShim([
    { when: "pr create", stdout: "https://github.com/acme/remudero/pull/1" },
    { when: "pr view", stdout: JSON.stringify({ headRefName: branch, body: "" }) },
    { when: "/pulls/", stdout: JSON.stringify({ number: 1, state: "open", merged: false, head: { sha: stale.oldSha } }) },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "queued" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
  ]);
  const priorPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${priorPath}`;
  t.after(() => { process.env.PATH = priorPath; });
  let pending = false;
  let calls = 0;
  let gates = 0;
  let freshnessReads = 0;
  const options: NonNullable<Parameters<typeof runTask>[1]> = {
    config: { claudeBin: "/bin/true", root, installRoot: process.cwd(), workerProviders: { harnessCommitsImplement: true } },
    skipGitSync: true, planPath,
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "boundary-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    externalWaitFreshness: async () => {
      freshnessReads++;
      return pending && !recycle && (!delayedCheckpointRead || freshnessReads > 1) ? stale : undefined;
    },
    externalWaitRecycle: () => pending && recycle ? "container recycle" : undefined,
    spawn: async (args) => {
      if (++calls === 1) return worker("RECON REPORT\nOBSERVED: fixture\n");
      mkdirSync(join(args.cwd, "src"), { recursive: true });
      writeFileSync(join(args.cwd, "src/change.ts"), `export const value = ${calls};\n`);
      if (boundary === "checkpoint" && calls === 2) {
        seed.git("-C", args.cwd, "add", "src/change.ts");
        seed.git("-C", args.cwd, "commit", "-m", "wip: retained work\n\n[remudero-context]\nremaining: verification");
        writeFileSync(join(args.cwd, "src/change.ts"), "export const value = 42;\n");
        pending = true;
      }
      if (failure === "scope") writeFileSync(join(args.cwd, "src/outside.ts"), "out of scope\n");
      if (failure === "push") seed.git("-C", args.cwd, "remote", "set-url", "origin", join(root, "missing-origin"));
      if (boundary === "worker" || boundary === "decision") pending = true;
      if (boundary === "decision") return worker("DECISION_REQUEST\n- retain work (RECOMMENDED)\n- discard work\n");
      return worker("REPORT\nCOMMIT_MESSAGE: fix(test): retain boundary work\n");
    },
    preopenGate: async () => {
      gates++;
      pending = true;
      if (boundary === "passed_gate") return { kind: "pass", durationMs: 1 };
      return { kind: "fail", failedSteps: ["typecheck"], durationMs: 1 };
    },
  };
  const outcome = await withLiveWritesAllowed(() => runTask(id, options));
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  if (failure) {
    assert.equal(outcome.verdict, "no_pr");
    assert.equal(calls, 2, "a checkpoint failure cannot start a repair worker");
    assert.equal(rows.find((row) => row.step === "verdict")?.reason, "restart_checkpoint_failed");
    assert.equal(rows.some((row) => row.step === "run.freshness_handoff"), false);
    assert.equal(existsSync(join(root, "worktrees", branch, "src/change.ts")), true, "a failed push preserves the local worktree");
    return;
  }
  assert.equal(calls, 2, "only recon and the first implement worker run");
  assert.equal(outcome.verdict, "handed_off");
  assert.equal(outcome.prUrl, undefined);
  assert.equal(gates, boundary === "preopen_gate" || boundary === "passed_gate" ? 1 : 0);
  const handoff = rows.find((row) => row.step === "run.freshness_handoff");
  assert.equal(handoff?.waiting_on, boundary === "passed_gate" ? "worker" : boundary);
  const verdict = rows.find((row) => row.step === "verdict");
  assert.equal(verdict?.reason, "freshness_yield");
  assert.equal(verdict?.branch, branch);
  assert.equal(handoff?.head_sha, origin.git("rev-parse", `refs/heads/${branch}`));
  assert.equal(origin.git("show", `${branch}:src/change.ts`), `export const value = ${boundary === "checkpoint" ? 42 : 2};`);
  assert.equal(rows.some((row) => row.step === "dispatch.claim_released" && row.dropped === true), true);
  assert.equal(gh.calls().some((call) => call.includes("pr create")), false);
  if (resumeAfter) {
    clock++;
    if (resumeAfter === "moved") origin.git("update-ref", `refs/heads/${branch}`, seed.git("rev-parse", "HEAD"));
    gh.addRoute({ when: "pr view", stdout: JSON.stringify({ headRefName: `run-${id}-${clock}`, body: "" }) });
    pending = false;
    let resumedCalls = 0;
    const resumed = await withLiveWritesAllowed(() => runTask(id, {
      ...options,
      spawn: async (args) => {
        if (++resumedCalls === 1) return worker("RECON REPORT\nOBSERVED: restored checkpoint\n");
        assert.equal(readFileSync(join(args.cwd, "src/change.ts"), "utf8"), "export const value = 42;\n");
        pending = true;
        return worker("REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n");
      },
    }));
    if (resumeAfter === "moved") {
      assert.equal(resumed.verdict, "no_pr");
      assert.equal(resumedCalls, 0, "a changed checkpoint head is refused before spending a worker turn");
      const terminal = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n")
        .filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        .findLast((row) => row.step === "verdict");
      assert.equal(terminal?.reason, "restart_checkpoint_restore_failed");
      return;
    }
    assert.equal(resumed.verdict, "handed_off");
    assert.equal(resumed.prUrl, "https://github.com/acme/remudero/pull/1");
    const restored = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n")
      .filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row.step === "implement.checkpoint_restored");
    assert.equal(restored?.source_branch, branch);
    assert.equal(restored?.source_head_sha, handoff?.head_sha);
  }
}

test("W1-T7697: a run with a restart pending yields at its pre-open gate", async (t) => {
  await boundaryRun(t, "preopen_gate");
});

test("W1-T7697: a run with a restart pending yields at a checkpoint resume", async (t) => {
  await boundaryRun(t, "checkpoint");
});

test("a recycle request also preserves a checkpoint before yielding", async (t) => {
  await boundaryRun(t, "checkpoint", true);
});

test("a fresh run restores the pushed boundary checkpoint before its implement worker", async (t) => {
  await boundaryRun(t, "checkpoint", false, true);
});

test("a checkpoint outside the declared scope records failure and retains its work", async (t) => {
  await boundaryRun(t, "checkpoint", false, false, "scope");
});

test("a checkpoint push failure records failure and retains its work", async (t) => {
  await boundaryRun(t, "checkpoint", false, false, "push");
});

test("checkpoint recovery refuses a remote head that changed after the handoff", async (t) => {
  await boundaryRun(t, "checkpoint", false, "moved");
});

test("a restart arriving during checkpoint judgment still prevents a resumed worker", async (t) => {
  await boundaryRun(t, "checkpoint", false, false, undefined, true);
});

test("a pending restart yields before the decision worker resumes", async (t) => {
  await boundaryRun(t, "decision");
});

test("a pending restart yields directly after a terminal worker turn", async (t) => {
  await boundaryRun(t, "worker");
});

test("a restart decided while a passing preopen gate runs yields before opening a pr", async (t) => {
  await boundaryRun(t, "passed_gate");
});

function history(durationMs: number): string[] {
  const end = Date.now();
  return [
    JSON.stringify({ step: "run.start", run_id: "observed", ts: new Date(end - durationMs).toISOString() }),
    JSON.stringify({ step: "verdict", run_id: "observed", ts: new Date(end).toISOString(), verdict: "merged" }),
  ];
}

function phase(durationMs: number, extraDeps: Partial<DaemonDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t7697-phase-"));
  const path = join(dir, "tasks.yaml");
  const ids = "ABCDEFGHIJKLM".split("");
  writeFileSync(path, ids.map((id) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  const releases = new Map(ids.map((id) => [id, deferred<RunResult>()]));
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  const started: Array<{ id: string; age: number }> = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const start = Date.now();
  let nowMs = start;
  let isStale = false;
  let cleaning = false;
  const merged = new Set<string>();
  const run = runDaemon(loadPlan(path), {
    now: () => new Date(nowMs),
    readLedgerLines: () => history(durationMs),
    refreshMerged: () => (id) => merged.has(id),
    checkFreshness: () => isStale ? stale : { stale: false },
    checkStop: () => cleaning ? "cleanup" : undefined,
    log: (step, extra) => rows.push({ step, extra }),
    runOne: (id) => { started.push({ id, age: nowMs - start }); return releases.get(id)!.promise; },
    sleep: () => { const sleep = deferred<void>(); sleeps.push(sleep); return sleep.promise; },
    ...extraDeps,
  } as DaemonDeps, { laneCount: 3, max: 10 });
  return {
    run, started, rows,
    settle: async (id: string, ageMinutes: number) => {
      nowMs = start + ageMinutes * minute;
      merged.add(id);
      releases.get(id)!.resolve(result(id));
      await flush();
    },
    tick: async (ageMinutes: number, staleNow = false) => {
      nowMs = start + ageMinutes * minute;
      isStale ||= staleNow;
      await flush();
      sleeps.shift()?.resolve();
      await flush();
      await flush();
    },
    cleanup: async () => {
      cleaning = true;
      for (const [id, release] of releases) release.resolve(result(id));
      for (const sleep of sleeps) sleep.resolve();
      await run;
    },
  };
}

test("W1-T7697: freed lanes keep refilling while one slow lane holds the phase", async () => {
  const h = phase(5 * minute);
  try {
    await flush();
    await h.tick(1, true);
    await h.settle("B", 1);
    await h.settle("C", 5);
    await h.tick(11);
    assert.equal(h.rows.some(({ step, extra }) => step === "daemon.freshness_decision" && extra?.action === "restart"), true);
    for (const [id, age] of [["D", 21], ["E", 26], ["F", 31], ["G", 36]] as const) await h.settle(id, age);
    assert.deepEqual(h.rows.find(({ step, extra }) => step === "dispatch.lane_refilled" && extra?.finished_task === "E")?.extra?.waiting_on, ["A"]);
    assert.ok(h.started.filter(({ age }) => age > 20 * minute).length >= 4);
    assert.equal(h.rows.some(({ step, extra }) => step === "dispatch.lane_refill_held" && extra?.reason === "phase bound"), false);
    await h.settle("A", 66);
    const before = h.started.length;
    await h.settle("H", 67);
    await h.settle("I", 68);
    assert.equal(h.started.length, before, "when the original slow lane yields, the restart drains rather than refills");
    assert.equal((await h.run).stopReason, "stale");
  } finally { await h.cleanup(); }
});

test("W1-T7697: the refill bound follows observed run lengths", async () => {
  const bounds: unknown[] = [];
  for (const duration of [5 * minute, 30 * minute]) {
    const h = phase(duration);
    try {
      await flush();
      const row = h.rows.find(({ step }) => step === "dispatch.refill_bound");
      assert.equal(row?.extra?.source, "observed_runs");
      bounds.push(row?.extra?.bound_ms);
    } finally { await h.cleanup(); }
  }
  assert.deepEqual(bounds, [5 * minute, 30 * minute]);
});

test("the refill estimator excludes missing, reversed, duplicate and malformed receipts", () => {
  const measured = history(7 * minute);
  const row = JSON.parse(measured[0]);
  assert.deepEqual(daemon.dispatchRunHistory([
    "{torn", "null", JSON.stringify({ step: "run.start", run_id: "invalid", ts: "unknown" }),
    measured[1], ...measured, measured[1],
    JSON.stringify({ ...row, run_id: "reversed" }),
    JSON.stringify({ ...row, run_id: "reversed", step: "verdict" }),
  ]), { totalMs: 7 * minute, samples: 1 });
});

test("a cold daemon replaces its fallback with lengths measured in the first phase", async () => {
  const h = phase(0);
  try {
    await flush();
    const first = h.rows.find(({ step }) => step === "dispatch.refill_bound");
    assert.equal(first?.extra?.source, "no_history_fallback");
    await h.settle("B", 5);
    await h.settle("C", 10);
    await h.settle("D", 21);
    await h.settle("E", 22);
    await h.settle("A", 23);
    const second = h.rows.filter(({ step }) => step === "dispatch.refill_bound")[1];
    assert.equal(second?.extra?.source, "observed_runs");
    assert.equal(second?.extra?.samples, 5);
    assert.equal(second?.extra?.bound_ms, 66 * minute / 5);
  } finally { await h.cleanup(); }
});

test("a pre-pr handoff releases only its exact branch and sha for a fresh daemon", async () => {
  const receipt = JSON.stringify({ step: "verdict", task_id: "A", verdict: "handed_off", reason: "freshness_yield",
    branch: "run-A-123", head_sha: stale.oldSha });
  assert.deepEqual(daemon.pendingWorkerBoundaryHandoffs(["{torn", "null", receipt]).get("A"),
    { branch: "run-A-123", headSha: stale.oldSha });
  assert.equal(daemon.pendingWorkerBoundaryHandoffs([receipt, JSON.stringify({ step: "verdict", task_id: "A", verdict: "merged" })]).size, 0);
  const h = phase(5 * minute, {
    readLedgerLines: () => [receipt],
    readPushedRunBranches: () => `${stale.oldSha}\trefs/heads/run-A-123\n${stale.newSha}\trefs/heads/run-B-456\n`,
  });
  try {
    await flush();
    assert.deepEqual(h.started.map(({ id }) => id), ["A", "C", "D"], "only the exact yielded head releases admission");
  } finally { await h.cleanup(); }
});
