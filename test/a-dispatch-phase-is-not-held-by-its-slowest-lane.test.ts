import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { pathToFileURL } from "node:url";
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
  resumeAfter: boolean | "moved" = false, failure?: "scope" | "push", delayedCheckpointRead = false,
  { mainMoves, refusingGate = false }: { mainMoves?: "clean" | "conflict"; refusingGate?: boolean } = {}) {
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
    // Not under test: the harness's own diff-coverage run over the fixture's changed src file.
    coveragePrecheckPorts: { changedFiles: () => [] },
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
  if (refusingGate) {
    // The harness's PR push gate refuses every push, as its census precheck refused W1-T7742's checkpoint.
    const hooks = join(root, "harness-hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho 'census-precheck: this branch grows 1 census count' >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-push"), 0o755);
    const priorHooks = process.env.RMD_HARNESS_HOOKS_DIR;
    process.env.RMD_HARNESS_HOOKS_DIR = hooks;
    t.after(() => { if (priorHooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR; else process.env.RMD_HARNESS_HOOKS_DIR = priorHooks; });
  }
  const outcome = await withLiveWritesAllowed(() => runTask(id, options));
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  if (failure === "scope") {
    // W1-T8008: an undeclared path no longer refuses the restart checkpoint — the work is kept, pushed and
    // named on the handoff, and scope is judged where the PR opens (scope_guard), never by losing the work.
    assert.equal(outcome.verdict, "handed_off");
    const scopeHandoff = rows.find((row) => row.step === "run.freshness_handoff");
    assert.deepEqual(scopeHandoff?.undeclared_paths, ["src/outside.ts"]);
    assert.equal(rows.find((row) => row.step === "verdict")?.reason, "freshness_yield");
    assert.equal(origin.git("show", `${branch}:src/outside.ts`), "out of scope");
    return;
  }
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
    if (mainMoves) {
      // main moves on while the checkpoint waits: a sibling file merges cleanly, the checkpoint's own file conflicts.
      mkdirSync(join(seed.dir, "src"), { recursive: true });
      writeFileSync(join(seed.dir, mainMoves === "clean" ? "src/sibling.ts" : "src/change.ts"), "export const value = 7;\n");
      seed.git("add", "src");
      seed.git("commit", "-m", "feat: main moves on");
      seed.git("push", "origin", "main");
    }
    gh.addRoute({ when: "pr view", stdout: JSON.stringify({ headRefName: `run-${id}-${clock}`, body: "" }) });
    pending = false;
    let resumedCalls = 0;
    const resumed = await withLiveWritesAllowed(() => runTask(id, {
      ...options,
      spawn: async (args) => {
        if (++resumedCalls === 1) return worker("RECON REPORT\nOBSERVED: restored checkpoint\n");
        if (mainMoves === "conflict") {
          assert.match(seed.git("-C", args.cwd, "grep", "-E", "^<{7} ", "--", "src/change.ts"), /<{7} /, "the resumed worker meets main's merge conflict");
          assert.match(args.prompt, /src\/change\.ts/, "the prompt names the conflicted path");
          writeFileSync(join(args.cwd, "src/change.ts"), "export const value = 42;\n");
          seed.git("-C", args.cwd, "add", "src/change.ts");
          seed.git("-C", args.cwd, "commit", "--no-edit");
        }
        const restored = await import(pathToFileURL(join(args.cwd, "src/change.ts")).href);
        assert.equal(restored.value, 42, "the resumed worker sees the checkpoint's exported value");
        if (mainMoves === "clean") assert.equal(existsSync(join(args.cwd, "src/sibling.ts")), true, "the resumed worker builds on current main");
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
    if (mainMoves === "conflict") {
      assert.equal(restored?.base, "main", "W1-T10752: a conflicting main is merged, never left behind");
      assert.equal(restored?.reconciled, "merge");
      assert.deepEqual(restored?.main_conflicts, ["src/change.ts"]);
      assert.equal(restored?.restored_head_sha, handoff?.head_sha);
      const resolved = origin.git("rev-list", "--parents", "-1", `run-${id}-${clock}`).trim().split(" ").slice(1);
      assert.deepEqual(resolved, [String(handoff?.head_sha), seed.git("rev-parse", "HEAD").trim()], "the worker's commit completes the merge with both parents");
    }
    if (mainMoves === "clean") {
      assert.equal(restored?.base, "main");
      const parents = origin.git("rev-list", "--parents", "-1", String(restored?.restored_head_sha)).trim().split(" ").slice(1);
      assert.deepEqual(parents, [String(handoff?.head_sha), seed.git("rev-parse", "HEAD").trim()],
        "main is merged into the checkpoint, never its commits replayed onto main");
    }
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

test("a checkpoint outside the declared scope keeps its undeclared work and names it on the handoff", async (t) => {
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

test("a restored checkpoint main conflicts with is merged with main and its worker resolves it instead of ending the run", async (t) => {
  await boundaryRun(t, "checkpoint", false, true, undefined, false, { mainMoves: "conflict" });
});

test("a restored checkpoint merges current main rather than replaying its commits", async (t) => {
  await boundaryRun(t, "checkpoint", false, true, undefined, false, { mainMoves: "clean" });
});

test("a restart checkpoint push is not refused by the PR push gate", async (t) => {
  await boundaryRun(t, "worker", false, false, undefined, false, { refusingGate: true });
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

function phase(durationMs: number, extraDeps: Partial<DaemonDeps> = {}, opts: NonNullable<Parameters<typeof runDaemon>[2]> = {}) {
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
    runOne: (id, options) => {
      started.push({ id, age: nowMs - start });
      return releases.get(id)!.promise;
    },
    sleep: () => { const sleep = deferred<void>(); sleeps.push(sleep); return sleep.promise; },
    ...extraDeps,
  } as DaemonDeps, { freshnessMinLifetimeMs: 0, laneCount: 3, max: 10, ...opts });
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

test("lane refill uses the adaptive queue admission and resumes only an exact handoff head", async () => {
  const receipts = ["D", "E"].map((id) => JSON.stringify({ step: "verdict", task_id: id,
    verdict: "handed_off", reason: "freshness_yield", branch: `run-${id}-123`, head_sha: stale.oldSha }));
  const h = phase(5 * minute, {
    readLedgerLines: () => [...history(5 * minute), ...receipts],
    openPrCount: () => 10,
    checkQueueGovernor: () => undefined,
    readQueueAdmission: () => ({ wipLimit: 14, baseWipLimit: 10, observedOpenCount: 10,
      stuckOwnedCount: 1, tier: "under_limit" }),
    readPushedRunBranches: () => `${stale.oldSha}\trefs/heads/run-D-123\n${stale.newSha}\trefs/heads/run-E-123\n`,
  }, { wipLimit: 10 });
  try {
    await flush();
    // D's exact handoff head resumes ahead of fresh work; E's receipt names a head its remote branch no longer has.
    assert.deepEqual(h.started.map(({ id }) => id), ["D", "A", "B"], "a handoff with a different remote sha still blocks its task");
    await h.settle("B", 1);
    assert.deepEqual(h.started.map(({ id }) => id), ["D", "A", "B", "C"]);
    await h.settle("C", 2);
    assert.deepEqual(h.started.map(({ id }) => id), ["D", "A", "B", "C", "F"],
      "a handoff with a different remote sha still blocks its task");
  } finally { await h.cleanup(); }
});

test("W1-T7697: freed lanes keep refilling while one slow lane holds the phase", async () => {
  // W1-T9089: freed lanes refill past the slow lane until a restart is decided. Then an in-process refill is held, and
  // the lanes in flight are awaited to the exit: none is asked to yield and none holds out.
  const material = { ...stale, changes: [{ sha: stale.newSha, subject: "fix: update worker", files: ["src/lib/worker.ts"] }],
    staleSinceMs: Date.now() - 120 * minute };
  let visible = false;
  const h = phase(5 * minute, { checkFreshness: () => visible ? material : { stale: false } });
  try {
    await flush();
    await h.settle("B", 1);
    await h.settle("C", 5);
    await h.settle("D", 9);
    assert.deepEqual(h.started.map(({ id }) => id), ["A", "B", "C", "D", "E", "F"], "freed lanes refill while A runs on");
    assert.equal(h.rows.some(({ step, extra }) => step === "dispatch.lane_refill_held" && extra?.reason === "phase bound"), false);
    visible = true;
    await h.tick(11);
    assert.equal(h.rows.some(({ step, extra }) => step === "daemon.freshness_decision" && extra?.action === "restart"), true);
    await h.settle("E", 21);
    assert.equal(h.started.length, 6, "an in-process refill is held once the restart is decided");
    assert.equal(h.rows.find(({ step, extra }) => step === "dispatch.lane_refill_held" && extra?.finished_task === "E")?.extra?.reason,
      "stale code: no candidate runs as a child");
    await h.settle("F", 31);
    await h.settle("A", 66);
    assert.equal((await h.run).stopReason, "stale");
    for (const step of ["daemon.restart_yield_asked", "daemon.restart_holdout", "daemon.freshness_restart_waiting"]) {
      assert.equal(h.rows.some((row) => row.step === step), false, step);
    }
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

// 2026-10-10 19:38: phase 21 min against a 16 min measured mean, both freed lanes held for good while the run that
// went on to hold the phase (a refill, 5 min old then) crossed the mean 11 min later. Only a re-decision can see that.
test("a lane the phase bound holds refills once a refilled sibling outlives the measured run length", async () => {
  const h = phase(16 * minute);
  try {
    await flush();
    await h.settle("A", 2);
    await h.settle("B", 4);
    await h.settle("C", 10);
    assert.deepEqual(h.started.map(({ id }) => id), ["A", "B", "C", "D", "E", "F"]);
    await h.settle("D", 17);
    await h.settle("E", 18);
    assert.equal(h.started.length, 6, "no sibling has outlived the measured run length yet");
    await h.tick(26);
    assert.equal(h.started.length, 6, "F, 16 min old, is not yet past the mean");
    await h.tick(27);
    assert.deepEqual(h.started.slice(6), [{ id: "G", age: 27 * minute }, { id: "H", age: 27 * minute }],
      "both parked lanes refill once F outlives the measured run length");
    assert.equal(h.rows.some(({ step, extra }) => step === "dispatch.lane_refill_held" && extra?.reason === "phase bound"), false);
  } finally { await h.cleanup(); }
});

test("a parked lane ends with the phase when its last sibling settles inside the measured run length", async () => {
  const h = phase(16 * minute);
  try {
    await flush();
    await h.settle("A", 2);
    await h.settle("B", 4);
    await h.settle("C", 10);
    await h.settle("D", 17);
    await h.settle("E", 18);
    assert.deepEqual(h.rows.filter(({ step }) => step === "dispatch.lane_parked").map(({ extra }) => extra?.waiting_on),
      [["E", "F"], ["F"]]);
    await h.settle("F", 20);
    await flush();
    const held = h.rows.filter(({ step, extra }) => step === "dispatch.lane_refill_held" && extra?.reason === "phase bound");
    assert.deepEqual(held.map(({ extra }) => extra?.finished_task).sort(), ["D", "E", "F"]);
    const settled = h.rows.find(({ step }) => step === "dispatch.settled_set");
    assert.equal(settled?.extra?.dispatched, 6, "the phase settles with no refill; no parked lane strands it");
  } finally { await h.cleanup(); }
});

test("a restart decided while lanes are parked drains them", async () => {
  // W1-T9089: the decision wakes the parked lanes, and each is held for the restart rather than refilled on old code.
  let latched = false;
  const material = { ...stale, changes: [{ sha: stale.newSha, subject: "fix: update worker", files: ["src/lib/worker.ts"] }],
    staleSinceMs: Date.now() - 120 * minute };
  const h = phase(16 * minute, { checkFreshness: () => latched ? material : { stale: false } });
  try {
    await flush();
    await h.settle("A", 2);
    await h.settle("B", 4);
    await h.tick(8);
    await h.settle("C", 10);
    await h.settle("D", 17);
    await h.settle("E", 18);
    assert.equal(h.rows.filter(({ step }) => step === "dispatch.lane_parked").length, 2);
    const startedAtLatch = h.started.length;
    latched = true;
    await h.tick(20);
    assert.equal(h.rows.some(({ step, extra }) => step === "daemon.freshness_decision" && extra?.action === "restart"), true);
    await flush();
    const held = h.rows.filter(({ step }) => step === "dispatch.lane_refill_held");
    assert.deepEqual(held.map(({ extra }) => [extra?.finished_task, extra?.reason]).sort(),
      [["D", "stale code: no candidate runs as a child"], ["E", "stale code: no candidate runs as a child"]]);
    await h.tick(30);
    assert.equal(h.started.length, startedAtLatch, "the lane in flight cannot renew refill");
    await h.settle("F", 31);
    assert.equal((await h.run).stopReason, "stale");
  } finally { await h.cleanup(); }
});

// W1-T7837 2026-10-11: its 08:35 run restored checkpoint run-W1-T7837-1791700996261 and yielded again at 09:02 as
// run-...-1791707730822. The restored branch stayed on origin, so the task read run-branch-already-pushed for good.
test("a checkpoint branch an older run left never holds a task whose newer checkpoint is resumable", async () => {
  const receipt = JSON.stringify({ step: "verdict", task_id: "A", verdict: "handed_off", reason: "freshness_yield",
    branch: "run-A-200", head_sha: stale.oldSha });
  const h = phase(5 * minute, {
    readLedgerLines: () => [receipt],
    readPushedRunBranches: () => `${stale.newSha}\trefs/heads/run-A-100\n${stale.oldSha}\trefs/heads/run-A-200\n` +
      `${stale.newSha}\trefs/heads/run-A-300\n${stale.newSha}\trefs/heads/run-B-100\n`,
  });
  try {
    await flush();
    assert.deepEqual(h.started.map(({ id }) => id), ["C", "D", "E"], "a branch pushed after the checkpoint still blocks");
  } finally { await h.cleanup(); }
  const superseded = phase(5 * minute, {
    readLedgerLines: () => [receipt],
    readPushedRunBranches: () => `${stale.newSha}\trefs/heads/run-A-100\n${stale.oldSha}\trefs/heads/run-A-200\n${stale.newSha}\trefs/heads/run-B-100\n`,
  });
  try {
    await flush();
    assert.deepEqual(superseded.started.map(({ id }) => id), ["A", "C", "D"], "the older branch was restored or released by a later run");
  } finally { await superseded.cleanup(); }
});

// W1-T7806 2026-10-11: a restore that conflicted wrote no_pr restart_checkpoint_restore_failed, which consumed
// the receipt and left the checkpoint branch blocking its own task.
test("a failed checkpoint restore leaves the checkpoint resumable", () => {
  const receipt = JSON.stringify({ step: "verdict", task_id: "A", verdict: "handed_off", reason: "freshness_yield",
    branch: "run-A-123", head_sha: stale.oldSha });
  const failedRestore = JSON.stringify({ step: "verdict", task_id: "A", verdict: "no_pr", reason: "restart_checkpoint_restore_failed" });
  assert.deepEqual(daemon.pendingWorkerBoundaryHandoffs([receipt, failedRestore]).get("A"), { branch: "run-A-123", headSha: stale.oldSha });
});

// W1-T7747 2026-10-11: its 23:58 handoff waits on W1-T7744; the live ledger keeps the newest 200 verdicts (back to
// 10-09) and its run.freshness_handoff row was already archived, so its receipt was about to age out.
test("a parked checkpoint's receipt outlives its verdict row's rotation", async () => {
  const handoff = { task_id: "A", branch: "run-A-123", head_sha: stale.oldSha };
  const row = JSON.stringify({ step: "run.freshness_handoff", waiting_on: "worker", ...handoff });
  assert.deepEqual(daemon.pendingWorkerBoundaryHandoffs([row]).get("A"), { branch: "run-A-123", headSha: stale.oldSha });
  const postPr = JSON.stringify({ step: "run.freshness_handoff", waiting_on: "ci", ...handoff });
  assert.equal(daemon.pendingWorkerBoundaryHandoffs([postPr]).size, 0, "a post-PR handoff is no checkpoint receipt");
  const verdict = JSON.stringify({ step: "verdict", verdict: "handed_off", reason: "freshness_yield", ...handoff });
  const h = phase(5 * minute, { readLedgerLines: () => ['{"step":"run.freshness_handoff", torn', verdict] });
  try {
    await flush();
    const carried = h.rows.filter(({ step }) => step === "run.freshness_handoff");
    assert.deepEqual(carried.map(({ extra }) => extra), [{ ...handoff, carried: true }], "boot re-writes the verdict-only receipt");
  } finally { await h.cleanup(); }
  const again = phase(5 * minute, { readLedgerLines: () => [verdict, row] });
  try {
    await flush();
    assert.equal(again.rows.filter(({ step }) => step === "run.freshness_handoff").length, 0, "a recorded receipt is not re-written");
  } finally { await again.cleanup(); }
});

// 2026-10-12 09:00:45: W1-T8000 freed lane 2 and one container-short WIP reading (measured_bound 0) held it with
// `governor: queue`. The reading was never re-taken, so the lane sat empty while W1-T7812 and W1-T7735 ran on.
test("a lane a governor holds parks and refills once a later dispatch tick's reading admits", async () => {
  let governed = false;
  const h = phase(60 * minute, { checkQueueGovernor: () => governed ? ({ observedOpenCount: 3, wipLimit: 13 } as never) : undefined });
  try {
    await flush();
    assert.deepEqual(h.started.map(({ id }) => id), ["A", "B", "C"]);
    governed = true;
    await h.settle("B", 2);
    await h.tick(3);
    await h.tick(4);
    assert.equal(h.started.length, 3, "the governor still defers");
    assert.deepEqual(h.rows.filter(({ step, extra }) => step === "dispatch.lane_parked" && extra?.reason === "governor: queue")
      .map(({ extra }) => [extra?.finished_task, extra?.waiting_on]), [["B", ["A", "C"]]], "one row per park, not per tick");
    governed = false;
    await h.tick(5);
    assert.deepEqual(h.started.slice(3), [{ id: "D", age: 5 * minute }]);
    assert.equal(h.rows.some(({ step, extra }) => step === "dispatch.lane_refill_held" && String(extra?.reason).startsWith("governor")), false);
  } finally { await h.cleanup(); }
});
