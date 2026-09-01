// test/worker-clock-bound.test.ts — W1-T1045: "A dispatch worker is bounded by turns and
// dollars and by nothing on the clock." Each test below proves exactly one of the task's 8
// acceptance criteria; the test titles are the proof strings the task record itself cites.
//
// Group 1 (criteria 1, 2, 6) drives `spawnWorker` (src/lib/worker.ts) directly, mirroring
// test/worker.test.ts's own `fakeQueryFn` pattern — a fake SDK stream, no real `claude` binary,
// no real containment spawn (the fake queryFns below never call
// `options.spawnClaudeCodeProcess`, so `withWorkerGroupTeardown`'s own teardown is a no-op and
// no real child process exists to clean up; that teardown guarantee is already proven end to
// end by test/worker.test.ts's own e2e pair and is not re-proven here).
//
// Group 2 (criteria 3, 4, 5, 7) drives the REAL `runTask` (src/run-task.ts) end to end against a
// real local git repo standing in for `origin` — mirroring test/run-task.test.ts's own
// `followupGitFixture`/`followupHoldingContainmentExec`/`followupCleanIsolationExec` technique
// (a local helper duplicated here rather than imported, matching every other wiring test file's
// own un-shared copy of the identical fixture) so a stalled IMPLEMENT spawn's abandonment is
// observed through the exact same lock/worktree/ledger machinery a live dispatch uses.
//
// Group 3 (criterion 8) is a pure, no-fixture source/registry check.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTask } from "../src/run-task.js";
import {
  CLAUDE_BIN_ENV_OVERRIDE,
  WorkerAbandonedError,
  createClaudeExecutableCache,
  spawnWorker,
  type SpawnWorkerArgs,
  type WorkerAbandonmentEvidence,
  type WorkerResult,
} from "../src/lib/worker.js";
import { loadDefaultPolicy } from "../src/lib/policy.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

// ── Group 1 fixtures: a real spawnWorker() call over a fake SDK stream ─────────────────────

function clockBoundSpawnArgs(dir: string, extra: Record<string, unknown> = {}) {
  const settingsFile = join(dir, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));
  return {
    cwd: dir,
    permissionMode: "bypassPermissions" as const,
    settingsFile,
    prompt: "W1-T1045 clock-bound fixture",
    config: { claudeBin: "/unused", root: dir },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: dir, exists: () => true, canExecute: () => true, locations: [] },
    },
    // Force past the darwin-only keychain gate without touching the real `security(1)` binary —
    // the same escape hatch test/worker.test.ts's own e2e fixture uses.
    keychain: {
      platform: "linux" as NodeJS.Platform,
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }),
    },
    ...extra,
  };
}

/** A stream that NEVER yields anything — the genuinely silent worker this task exists for —
 *  and settles ONLY when `options.abortController` fires, exactly the shape a real aborted SDK
 *  query takes (an error, no result envelope). */
function hangingQueryFn(): SpawnWorkerArgs["queryFn"] {
  return ((params: { options: { abortController?: AbortController } }) =>
    (async function* () {
      await new Promise((_, reject) => {
        params.options.abortController?.signal.addEventListener("abort", () => {
          reject(new Error("simulated: aborted by the W1-T1045 clock-bound watchdog"));
        });
      });
    })()) as unknown as SpawnWorkerArgs["queryFn"];
}

/** A clean, immediate success — no activity ever goes silent long enough to matter. */
function immediateSuccessQueryFn(): SpawnWorkerArgs["queryFn"] {
  return (() =>
    (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-inside-bound",
        total_cost_usd: 0.01,
        num_turns: 1,
      };
    })()) as unknown as SpawnWorkerArgs["queryFn"];
}

/** A worker that keeps producing activity for a virtual span far longer than `boundMs`, but
 *  whose individual gaps between messages never themselves exceed it — criterion 6's own shape.
 *  `clockRef` is shared with the caller's `clockBound.now`, so the watchdog's poll and this
 *  stream's own event timestamps read the SAME clock (see spawnWorker's own `now:
 *  args.clockBound?.now` forwarding). */
function progressingQueryFn(clockRef: { value: number }, boundMs: number, pollMs: number, steps: number): SpawnWorkerArgs["queryFn"] {
  return (() =>
    (async function* () {
      for (let i = 0; i < steps; i++) {
        // Advance the clock BEFORE yielding, synchronously (no `await` in between) — the
        // observer that records this activity always sees the SAME value the next poll tick
        // would, so no real-timer race can catch the clock mid-advance.
        clockRef.value += boundMs - 20;
        yield { type: "assistant", message: { content: [{ type: "text", text: `working ${i}` }] } };
        // A short REAL pause between messages so the watchdog's real setInterval gets a few
        // chances to poll at this (frozen) virtual clock reading — proving it does NOT trip on
        // a gap that individually stays under the bound.
        await new Promise((r) => setTimeout(r, pollMs * 3));
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-progressing",
        total_cost_usd: 0.03,
        num_turns: steps,
      };
    })()) as unknown as SpawnWorkerArgs["queryFn"];
}

test("W1-T1045: a worker past the clock bound is abandoned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-clockbound-trip-"));
  let clock = 0;
  const now = () => (clock += 2000);

  await assert.rejects(
    () =>
      spawnWorker({
        ...clockBoundSpawnArgs(dir),
        queryFn: hangingQueryFn(),
        clockBound: { boundMs: 1000, now, pollMs: 5 },
      } as Parameters<typeof spawnWorker>[0]),
    (err: unknown) => {
      assert.ok(err instanceof WorkerAbandonedError, `expected WorkerAbandonedError, got ${err}`);
      assert.equal(err.evidence.boundMs, 1000);
      assert.ok(err.evidence.elapsedMs > 1000, `elapsedMs (${err.evidence.elapsedMs}) must exceed the bound`);
      return true;
    },
  );
});

test("W1-T1045: a worker inside the bound completes untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-clockbound-inside-"));
  const res = await spawnWorker({
    ...clockBoundSpawnArgs(dir),
    queryFn: immediateSuccessQueryFn(),
    clockBound: { boundMs: 5_000_000 },
  } as Parameters<typeof spawnWorker>[0]);

  assert.equal(res.isError, false, "a clean, fast worker must never be treated as abandoned");
  assert.equal(res.text, "done");
});

test("W1-T1045: a progressing worker is never abandoned on elapsed alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-clockbound-progress-"));
  const clockRef = { value: 0 };
  const boundMs = 200;
  const pollMs = 5;

  const res = await spawnWorker({
    ...clockBoundSpawnArgs(dir),
    queryFn: progressingQueryFn(clockRef, boundMs, pollMs, 5),
    clockBound: { boundMs, now: () => clockRef.value, pollMs },
  } as Parameters<typeof spawnWorker>[0]);

  assert.equal(res.isError, false, "a worker still producing state transitions must complete, never abandoned");
  assert.ok(
    clockRef.value > boundMs * 3,
    `the virtual span across the whole run (${clockRef.value}ms) must genuinely exceed the bound (${boundMs}ms) several times over`,
  );
});

// ── Group 2 fixtures: a real runTask() over a real local git origin ────────────────────────

const FIXTURE_PLAN = [
  "- id: TST-CLOCKBOUND",
  "  title: clock-bound abandonment wiring probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

/** An offline GitHub gateway: this run touches zero network. */
const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** A containmentExec reporting the outside-cwd write OS-DENIED — containment PASSES (mirrors
 *  test/run-task.test.ts's own `followupHoldingContainmentExec`). */
const clockBoundHoldingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

/** An isolationExec reporting zero inherited operator aliases/functions — isolation PASSES. */
const clockBoundCleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

/** A minimal WorkerResult for the recon call, which always succeeds in these fixtures — the
 *  abandonment under test always happens on the IMPLEMENT spawn. */
function reconResult(): WorkerResult {
  return {
    sessionId: "s-recon",
    costUsd: 0.01,
    numTurns: 1,
    text: "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

/** A real, throwaway BARE "origin" + a real clone at `repoDir` — the same shape
 *  test/run-task.test.ts's `followupGitFixture` builds, duplicated per this file's own header
 *  note (every wiring test file in this repo keeps its own copy rather than sharing one). */
function clockBoundGitFixture(root: string): { repoDir: string } {
  const originGit = mkdtempSync(join(tmpdir(), "runtask-clockbound-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "runtask-clockbound-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "clockbound-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "clockbound-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  // W1-T2510: the recon-reuse key's `plan_sha` is now `taskRecordSha`, resolved against the
  // WORKTREE's own `plan/tasks.yaml` (see its call site's doc: "never the orchestrator's own
  // possibly staler planPath"). A worktree with no plan record resolves to PLAN_RECORD_ABSENT,
  // which is deliberately excluded from ever validating a reuse -- so without this the reuse
  // below can never happen and the "one spawn" assertion fails for a fixture reason, not a
  // behavioural one. Every real checkout carries this file; the fixture now does too.
  mkdirSync(join(seed, "plan"), { recursive: true });
  writeFileSync(join(seed, "plan", "tasks.yaml"), FIXTURE_PLAN);
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "clockbound-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "clockbound-test"]);
  return { repoDir };
}

/** Recon succeeds; the IMPLEMENT spawn rejects with a {@link WorkerAbandonedError} carrying
 *  `evidence` — the exact shape spawnWorker throws once its own clock-bound watchdog trips. */
function abandoningSpawn(evidence: WorkerAbandonmentEvidence): { spawn: typeof spawnWorker; calls: SpawnWorkerArgs[] } {
  const calls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    calls.push(args);
    if (calls.length === 1) return reconResult();
    throw new WorkerAbandonedError(evidence, new Error("simulated: SDK transport error on abort"));
  };
  return { spawn, calls };
}

function buildFixtureRoot(): { root: string; planPath: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), "runtask-clockbound-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  clockBoundGitFixture(root);
  return { root, planPath, config };
}

function readLedger(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("W1-T1045: abandonment records elapsed and last state first", async () => {
  const { root, planPath, config } = buildFixtureRoot();
  try {
    const { spawn } = abandoningSpawn({ elapsedMs: 111222, boundMs: 7_200_000, lastState: "tool-executing", lastStateMs: 555 });

    const res = await runTask("TST-CLOCKBOUND", {
      skipGitSync: true,
      planPath,
      config,
      github: OFFLINE_GITHUB,
      spawn,
      containmentExec: clockBoundHoldingContainmentExec,
      isolationExec: clockBoundCleanIsolationExec,
    });
    assert.equal(res.verdict, "failed");

    const ledger = readLedger(root);
    const verdictIdx = ledger.findIndex((l) => l.step === "verdict" && l.stage === "worker.abandoned");
    assert.ok(verdictIdx >= 0, "a verdict line naming the abandonment stage was ledgered");
    const verdictLine = ledger[verdictIdx];
    assert.equal(verdictLine.elapsed_ms, 111222);
    assert.equal(verdictLine.bound_ms, 7_200_000);
    assert.equal(verdictLine.last_state, "tool-executing");
    assert.equal(verdictLine.last_state_ms, 555);
    // Turns are ABSENT, never fabricated: a stalled stream never produced the SDK's completion
    // envelope, so this run's abandonment line has nothing to report for it.
    assert.equal(verdictLine.num_turns, undefined);

    const worktreeRemoveIdx = ledger.findIndex((l) => l.step === "worktree.remove" && l.on === "worker.abandoned");
    assert.ok(worktreeRemoveIdx >= 0, "the worktree was removed after abandonment");
    assert.ok(verdictIdx < worktreeRemoveIdx, "the evidence is recorded BEFORE the worktree is released");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1045: abandonment releases the lock and the lane", async () => {
  const { root, planPath, config } = buildFixtureRoot();
  try {
    const evidence: WorkerAbandonmentEvidence = { elapsedMs: 999_999, boundMs: 7_200_000 };
    const first = abandoningSpawn(evidence);

    const res1 = await runTask("TST-CLOCKBOUND", {
      skipGitSync: true,
      planPath,
      config,
      github: OFFLINE_GITHUB,
      spawn: first.spawn,
      containmentExec: clockBoundHoldingContainmentExec,
      isolationExec: clockBoundCleanIsolationExec,
    });
    assert.equal(res1.verdict, "failed");

    // THE LOCK: a fresh check of the on-disk file, not an inference from the verdict alone.
    assert.ok(
      !existsSync(join(root, "state", "inflight", "TST-CLOCKBOUND.lock")),
      "the inflight lock is released after abandonment",
    );

    // THE LANE, PROVEN BEHAVIORALLY: a SECOND dispatch for the SAME task, issued immediately
    // after the first RESOLVED, is not refused as blocked_inflight — the only way a still-held
    // lock/lane would be visible from the outside.
    const second = abandoningSpawn(evidence);
    const res2 = await runTask("TST-CLOCKBOUND", {
      skipGitSync: true,
      planPath,
      config,
      github: OFFLINE_GITHUB,
      spawn: second.spawn,
      containmentExec: clockBoundHoldingContainmentExec,
      isolationExec: clockBoundCleanIsolationExec,
    });
    assert.notEqual(res2.verdict, "blocked_inflight", "the task is dispatchable again — no lock contention");
    // W1-T2241 SUPERSEDED THE PROXY, NOT THE PROPERTY. This asserted `calls.length === 2` — recon
    // plus implement — as the way to say "the second dispatch actually spawned, never refused
    // early". Recon output is now keyed on `(task_id, plan_sha, files_digest)` and reused across
    // dispatches, so a redispatch whose key still matches legitimately skips the recon spawn: that
    // is exactly the cost W1-T2241 exists to stop paying, and a dispatch that died before opening a
    // PR — abandonment included — is the case its own rationale names.
    //
    // THE ASSERTION IS STILL EXACT IN BOTH DIRECTIONS, not relaxed. Zero spawns means the dispatch
    // was refused early and fails; two spawns means the artifact was NOT reused and also fails.
    assert.equal(second.calls.length, 1, "the second dispatch spawned the implement worker, never refused early");
    // AND IT IS THE IMPLEMENT SPAWN CARRYING THE REUSED ARTIFACT, never merely "some spawn": the
    // VERIFY-AND-EXTEND framing is injected only by `reconArtifactToContext`, so a recon-only spawn,
    // or a reuse that silently did not happen, fails here rather than passing on the count alone.
    assert.match(
      String(second.calls[0]?.prompt ?? ""),
      /VERIFY-AND-EXTEND/,
      "the one spawn is the implement worker, carrying the reused recon artifact",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1045: an abandoned run ends with a terminal verdict", async () => {
  const { root, planPath, config } = buildFixtureRoot();
  try {
    const { spawn } = abandoningSpawn({ elapsedMs: 500_000, boundMs: 7_200_000, lastState: "working", lastStateMs: 42 });

    // The promise must RESOLVE — not reject — carrying a real, typed verdict. Before this task,
    // an unrecognized thrown error at run-task.ts's own catch-all fell to the generic
    // `run.error` branch's bare `throw err`, which would leave this exact call REJECTED
    // instead: the "vanishes rather than ends" gap this criterion closes.
    const res = await runTask("TST-CLOCKBOUND", {
      skipGitSync: true,
      planPath,
      config,
      github: OFFLINE_GITHUB,
      spawn,
      containmentExec: clockBoundHoldingContainmentExec,
      isolationExec: clockBoundCleanIsolationExec,
    });

    assert.equal(res.merged, false);
    assert.equal(res.verdict, "failed");
    assert.equal(res.taskId, "TST-CLOCKBOUND");
    assert.equal(typeof res.runId, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1045: the worker clock bound is read from policy", async () => {
  const { root, planPath, config } = buildFixtureRoot();
  try {
    // DEFAULT: no override ⇒ the SHIPPED plan/policy.yaml's `workerAbandon` row reaches the
    // real dispatch spawn — never a literal hardcoded at run-task.ts's own call site.
    const defaultFixture = abandoningSpawn({ elapsedMs: 1, boundMs: 1 });
    await runTask("TST-CLOCKBOUND", {
      skipGitSync: true,
      planPath,
      config,
      github: OFFLINE_GITHUB,
      spawn: defaultFixture.spawn,
      containmentExec: clockBoundHoldingContainmentExec,
      isolationExec: clockBoundCleanIsolationExec,
    });
    assert.equal(
      defaultFixture.calls[0]?.clockBound?.boundMs,
      loadDefaultPolicy().values.workerAbandon,
      "recon's own spawn carries the SHIPPED policy bound",
    );

    // OVERRIDE: a distinctive value the shipped policy could never coincidentally equal proves
    // the read site is a real, live seam, not a constant that merely happens to match today.
    const overrideFixture = abandoningSpawn({ elapsedMs: 1, boundMs: 1 });
    await runTask("TST-CLOCKBOUND", {
      skipGitSync: true,
      planPath,
      config,
      github: OFFLINE_GITHUB,
      spawn: overrideFixture.spawn,
      containmentExec: clockBoundHoldingContainmentExec,
      isolationExec: clockBoundCleanIsolationExec,
      workerAbandonMs: 4_242_424,
    });
    assert.equal(overrideFixture.calls[0]?.clockBound?.boundMs, 4_242_424, "the injected override wins over the policy default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Group 3 (criterion 8): a pure rotation-membership check, no fixture needed ─────────────

test("W1-T1045: the abandonment step's rotation membership matches its readers", () => {
  // The abandonment evidence rides the ALREADY-REGISTERED "verdict" ledger step — never a new,
  // separately-registered one. `stage: "worker.abandoned"` is a plain DATA field on that line,
  // not a ledger `step` of its own, so it inherits "verdict"'s existing, tested rotation
  // membership rather than needing a membership decision of its own.
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("verdict"), "the abandonment record rides the registered 'verdict' step");

  const abandonIdx = runTaskSrc.indexOf("if (err instanceof WorkerAbandonedError)");
  assert.ok(abandonIdx >= 0, "run-task.ts must catch WorkerAbandonedError");
  const block = runTaskSrc.slice(abandonIdx, abandonIdx + 900);
  assert.match(block, /log\("verdict",/, "the abandonment branch writes through the registered 'verdict' step");
  assert.match(block, /stage:\s*"worker\.abandoned"/, "the abandonment record is named on the verdict line");

  // "worker.abandoned" is NEVER a ledger `step` value anywhere in the file — mirroring
  // `worker.state`/`worker.stalled`'s own precedent (src/lib/ledger.ts's own doc): nothing reads
  // it back via `.step === "worker.abandoned"` to decide anything, so it correctly carries NO
  // DECISION_RELEVANT_LEDGER_STEPS membership of its own — registering it would be exactly the
  // defensive-registration mistake that doc warns against.
  assert.doesNotMatch(runTaskSrc, /step:\s*"worker\.abandoned"/, 'the string never appears as a ledger step, only as a "stage" field');
  assert.ok(!DECISION_RELEVANT_LEDGER_STEPS.has("worker.abandoned"), "unregistered — nothing reads it back for a decision");
});

test("W1-T1045: a worktree that cannot be reclaimed is ledgered and the run still ends with its verdict", async () => {
  // The abandon branch reclaims the worktree best-effort. Its catch is the arm that keeps a
  // failed reclaim from turning a recorded abandonment into an unhandled throw — and no test
  // reached it, because the reclaim succeeds on every healthy fixture.
  //
  // LOCKING is the mechanism, measured rather than assumed: `git worktree remove --force` on a
  // LOCKED worktree exits 128 ("cannot remove a locked working tree"), while the same command
  // after merely deleting the directory exits 0. So deleting would not have failed the reclaim.
  const { root, planPath, config } = buildFixtureRoot();
  try {
    const calls: SpawnWorkerArgs[] = [];
    const spawn: typeof spawnWorker = async (args) => {
      calls.push(args);
      if (calls.length === 1) return reconResult();
      execFileSync("git", ["-C", args.cwd, "worktree", "lock", args.cwd], { stdio: "ignore" });
      throw new WorkerAbandonedError(
        { elapsedMs: 500_000, boundMs: 7_200_000, lastState: "working", lastStateMs: 42 },
        new Error("simulated: SDK transport error on abort"),
      );
    };

    const res = await runTask("TST-CLOCKBOUND", {
      skipGitSync: true,
      planPath,
      config,
      github: OFFLINE_GITHUB,
      spawn,
      containmentExec: clockBoundHoldingContainmentExec,
      isolationExec: clockBoundCleanIsolationExec,
    });

    assert.equal(res.verdict, "failed", "a failed reclaim never changes the run's own verdict");
    assert.equal(res.merged, false);

    const lines = readLedger(root);
    const removeError = lines.find((l) => l.step === "worktree.remove.error");
    assert.ok(removeError, `expected a worktree.remove.error row, saw: ${[...new Set(lines.map((l) => l.step))].join(", ")}`);
    assert.equal(removeError!.on, "worker.abandoned", "the row names WHICH reclaim failed, not just that one did");
    // `worktreeRemove` shells git with `stdio: "inherit"`, so git's own "cannot remove a locked
    // working tree" text goes to the parent's stderr and never reaches `err.message` — the row
    // carries the failing command instead. Assert on what the row actually holds.
    assert.match(String(removeError!.error), /Command failed: git .*worktree remove --force/);

    // The positive control on the same corpus: the abandonment itself is still recorded, so the
    // failed reclaim is an extra row rather than a path that swallowed the whole branch.
    assert.ok(lines.some((l) => l.step === "verdict" && l.stage === "worker.abandoned"), "the abandonment verdict row still lands");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
