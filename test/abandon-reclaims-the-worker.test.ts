/**
 * test/abandon-reclaims-the-worker.test.ts — W1-T2261 (ABANDONING A SPAWN DOES NOT END IT).
 *
 * THE DEFECT THIS CLOSES. `spawnFixWorkerBounded` (src/run-task.ts) already AWAITS a killer —
 * `deps.reclaimWorker?.({ runId, taskId, elapsedMs })` — on the abandoned branch, and
 * `reclaimAbandonedWorker` already enumerates every live process and kills the one whose
 * markers name this run. But the fix-rung's OWN spawn (`fixArgs`, also src/run-task.ts) never
 * set `runId`/`taskId` on the `SpawnWorkerArgs` it handed to that spawn — so the child process
 * carried no `REMUDERO_RUN_ID`/`REMUDERO_TASK_ID` env (worker.ts's `workerMarkerEnv`), every
 * candidate's `readMarkers` (worker-containment.ts's `defaultReadMarkers`) read `undefined` for
 * it, `markers?.runId === info.runId` could never be true, and the abandoned worker survived —
 * silently, because the whole reclaim loop was wrapped in a swallowing try/catch with no log on
 * either the matched or the no-match path.
 *
 * THE FIX: (1) `fixArgs` now sets `runId`/`taskId` from the same `ctx` the abandonment path
 * already carries, so the marker the reclaim matches on is set at the spawn that will later be
 * abandoned. (2) `reclaimAbandonedWorker` takes an optional `log` seam and now records a
 * match (`fix.spawn_reclaimed`, once per killed candidate) DISTINCTLY from a no-match
 * (`fix.spawn_reclaim_no_match`, once, only when nothing matched) — both real call sites
 * (`runTaskBody`'s inline `reclaimWorker` wiring and `buildSweepEffects`'s `reclaimWorkerImpl`
 * default) now bind that seam to the SAME `log` the rung/sweep already writes
 * `fix.spawn_abandoned`/`fix.spawn_reclaim_failed` through.
 *
 * WHAT MUST NOT CHANGE (this task's own Q3): the wall-clock bound stays at its committed value
 * (`DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS`, W1-T1219's own row) — nothing here lengthens or
 * shortens it — and a spawn that has not exceeded the bound must never reach the teardown seam
 * at all (a worker still producing output is never killed).
 *
 * A NEW, DEDICATED file (the task's own `files:` list) — never folded into
 * test/sweep-wall-clock-bound.test.ts or test/fix-spawn-bound-split.test.ts, the sibling W1-T1044/
 * W1-T1219 suites this task's own rationale cites and deliberately does not duplicate.
 *
 * Five acceptance criteria, five sections below:
 *   1. a fix-rung spawn carries the attribution markers its own abandonment path later matches on
 *   2. an abandonment whose markers match invokes the injected teardown seam exactly once for
 *      that candidate
 *   3. a reclaim that matches no candidate records that outcome distinctly from one that invoked
 *      the teardown
 *   4. the wall-clock bound keeps its committed value, and a spawn that has not exceeded it never
 *      reaches the teardown seam
 *   5. a teardown seam that throws leaves the rung's verdict unchanged rather than propagating
 *      into it
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS } from "../src/lib/policy.js";
import { reclaimAbandonedWorker, runFixRung, type FixRungOutcome } from "../src/run-task.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

function fakeWorkerResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s-w1t2261",
    costUsd: 0,
    numTurns: 1,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(state: "success" | "failure", headSha = "deadbeef"): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria:
      state === "success"
        ? [criterion({ claim: "criterion A merges cleanly", met: true })]
        : [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })],
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

const NEVER_ISSUES: IssueGateway = {
  create() {
    throw new Error("no escalation expected in this fixture");
  },
};

function fixRungBaseOpts() {
  return {
    taskId: "W1-T2261FIX",
    runId: "W1-T2261FIX-1730000000000",
    task: { id: "W1-T2261FIX", title: "a task whose fix spawn is under test" },
    prUrl: "https://github.com/acme/remudero/pull/2261",
    branch: "run-W1-T2261FIX-1730000000000",
    worktreePath: "/tmp/rmd-abandon-reclaims-the-worker-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-abandon-reclaims-the-worker-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    strikeCap: 1,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-abandon-reclaims-the-worker-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-abandon-reclaims-the-worker-ledger-")), "ledger.ndjson");
}

// ── acceptance 1: the fix-rung spawn carries the markers its own abandonment matches on ────────

test("W1-T2261 (acceptance 1): the fix-rung spawn's own args carry this run's runId/taskId — the marker the abandon path later matches candidates against", async () => {
  let capturedArgs: SpawnWorkerArgs | undefined;
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    initialReview: fakeReview("failure"),
    deps: {
      spawn: async (args) => {
        capturedArgs = args;
        return fakeWorkerResult();
      },
      waitForCiGreen: async () => "green",
      runReview: async () => fakeReview("success", "sha-1"),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 5000,
    },
  });
  assert.equal(outcome.outcome, "fixed");
  assert.ok(capturedArgs, "the spawn must actually have been called");
  assert.equal(
    capturedArgs!.runId,
    "W1-T2261FIX-1730000000000",
    "the spawn's own runId must equal the rung's runId — the value reclaimAbandonedWorker later compares markers.runId against",
  );
  assert.equal(
    capturedArgs!.taskId,
    "W1-T2261FIX",
    "the spawn's own taskId must equal the rung's taskId",
  );
});

// ── acceptance 2: a matching abandonment invokes the teardown seam exactly once per candidate ──

test("W1-T2261 (acceptance 2): reclaimAbandonedWorker invokes the injected teardown seam exactly once for the ONE candidate whose marker names this run", () => {
  const killed: number[] = [];
  const markers: Record<number, { runId: string; taskId: string } | undefined> = {
    11: { runId: "OTHER-RUN", taskId: "W1-T-OTHER" },
    22: { runId: "THIS-RUN", taskId: "W1-T2261FIX" },
    33: undefined, // a process carrying no marker at all
  };
  reclaimAbandonedWorker(
    { runId: "THIS-RUN", taskId: "W1-T2261FIX", elapsedMs: 20 },
    {
      listCandidates: () => [{ pid: 11 }, { pid: 22 }, { pid: 33 }] as never,
      readMarkers: ((pid: number) => markers[pid]) as never,
      kill: (pid: number) => void killed.push(pid),
    },
  );
  assert.deepEqual(killed, [22], "the teardown seam fires exactly once, and only for the candidate whose marker names THIS run");
});

test("W1-T2261 (acceptance 2, end-to-end): a fix-rung spawn abandoned by the bound is reclaimed through the real markers it now carries", async () => {
  const reclaimCalls: Array<{ runId: string; taskId: string; elapsedMs: number }> = [];
  let capturedArgs: SpawnWorkerArgs | undefined;
  const killed: number[] = [];
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    initialReview: fakeReview("failure"),
    deps: {
      spawn: async (args) => {
        capturedArgs = args;
        return new Promise<WorkerResult>(() => {}); // never returns
      },
      waitForCiGreen: async () => "green",
      runReview: async () => fakeReview("failure"),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 20,
      reclaimWorker: (info) => {
        reclaimCalls.push(info);
        // Mirrors the production wiring end-to-end: the real reclaimAbandonedWorker, driven
        // against a candidate list carrying the SAME markers the (now-fixed) spawn args set —
        // proving the write side (fixArgs) and the read side (the marker-match predicate) agree.
        reclaimAbandonedWorker(info, {
          listCandidates: () => [{ pid: 4242, cmdline: "claude" }],
          readMarkers: (pid) =>
            pid === 4242 && capturedArgs?.runId !== undefined
              ? { runId: capturedArgs.runId, taskId: capturedArgs.taskId ?? "" }
              : undefined,
          kill: (pid) => void killed.push(pid),
        });
      },
    },
  });
  assert.equal(outcome.outcome, "spawn_abandoned");
  assert.equal(reclaimCalls.length, 1);
  assert.deepEqual(killed, [4242], "the abandoned worker's own process is torn down — the fix this task exists to make");
});

// ── acceptance 3: a no-match reclaim is recorded distinctly from an invoked teardown ────────────

test("W1-T2261 (acceptance 3): a reclaim that matches no candidate logs fix.spawn_reclaim_no_match, never fix.spawn_reclaimed", () => {
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  reclaimAbandonedWorker(
    { runId: "THIS-RUN", taskId: "W1-T2261FIX", elapsedMs: 42 },
    {
      listCandidates: () => [{ pid: 11 }, { pid: 33 }] as never,
      readMarkers: (() => undefined) as never, // nothing on the host carries this run's marker
      kill: () => {
        throw new Error("must never be called — nothing matched");
      },
      log: (step, extra) => steps.push({ step, extra }),
    },
  );
  const noMatch = steps.find((s) => s.step === "fix.spawn_reclaim_no_match");
  const matched = steps.find((s) => s.step === "fix.spawn_reclaimed");
  assert.ok(noMatch, "a no-match outcome must be recorded — this is the silent path W1-T2261 closes");
  assert.equal(matched, undefined, "a no-match run must never also claim a match");
  assert.equal(noMatch!.extra?.run_id, "THIS-RUN");
  assert.equal(noMatch!.extra?.task_id, "W1-T2261FIX");
});

test("W1-T2261 (acceptance 3): a reclaim that DOES match logs fix.spawn_reclaimed, never fix.spawn_reclaim_no_match", () => {
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  reclaimAbandonedWorker(
    { runId: "THIS-RUN", taskId: "W1-T2261FIX", elapsedMs: 42 },
    {
      listCandidates: () => [{ pid: 22 }] as never,
      readMarkers: (() => ({ runId: "THIS-RUN" })) as never,
      kill: () => {},
      log: (step, extra) => steps.push({ step, extra }),
    },
  );
  const noMatch = steps.find((s) => s.step === "fix.spawn_reclaim_no_match");
  const matched = steps.find((s) => s.step === "fix.spawn_reclaimed");
  assert.ok(matched, "a genuine match must be recorded");
  assert.equal(noMatch, undefined, "a matched run must never also claim no-match — the two outcomes are mutually exclusive and both distinctly named");
  assert.equal(matched!.extra?.pid, 22);
});

test("W1-T2261 (acceptance 3, wired through the rung): the SAME log-threading pattern the real call sites use (`(info) => reclaimAbandonedWorker(info, { log })`) reaches the rung's own ledger on a no-match abandonment", async () => {
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  // Mirrors production exactly: `runTaskBody`'s inline wiring and `buildSweepEffects`'s
  // `reclaimWorkerImpl` default are both `(info) => reclaimAbandonedWorker(info, { log })` —
  // the SAME `log` the rung already writes `fix.spawn_abandoned` through. Proves the call goes
  // through `spawnFixWorkerBounded`'s own `await deps.reclaimWorker?.(...)` unshortened, all
  // the way to the rung's real ledger sink, not merely the pure function in isolation.
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    initialReview: fakeReview("failure"),
    deps: {
      spawn: () => new Promise<WorkerResult>(() => {}),
      waitForCiGreen: async () => "green",
      runReview: async () => fakeReview("failure"),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => steps.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 20,
      reclaimWorker: (info) =>
        reclaimAbandonedWorker(info, {
          listCandidates: () => [{ pid: 999 }] as never, // present, but carries no marker at all
          readMarkers: (() => undefined) as never,
          log: (step, extra) => steps.push({ step, extra }),
        }),
    },
  });
  assert.equal(outcome.outcome, "spawn_abandoned");
  const noMatch = steps.find((s) => s.step === "fix.spawn_reclaim_no_match");
  assert.ok(noMatch, "the rung's own ledger must carry the no-match outcome, reached through the real wiring shape");
  assert.equal(noMatch!.extra?.run_id, "W1-T2261FIX-1730000000000");
});

// ── acceptance 4: the bound keeps its value, and an unexceeded spawn never reaches teardown ────

test("W1-T2261 (acceptance 4): the committed wall-clock bound is unchanged by this task", () => {
  assert.equal(
    DEFAULT_FIX_SPAWN_WALL_CLOCK_BOUND_MS,
    3_600_000,
    "W1-T1044/W1-T1219's committed bound value must not move — this task is not the remedy for the bound's SIZE",
  );
});

test("W1-T2261 (acceptance 4): a spawn that resolves well within the bound never invokes the teardown seam", async () => {
  const reclaimCalls: Array<unknown> = [];
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    initialReview: fakeReview("failure"),
    deps: {
      spawn: async () => fakeWorkerResult(),
      waitForCiGreen: async () => "green",
      runReview: async () => fakeReview("success", "sha-2"),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 5000, // comfortably above how long the fake spawn actually takes
      reclaimWorker: (info) => {
        reclaimCalls.push(info);
      },
    },
  });
  assert.equal(outcome.outcome, "fixed", "a spawn that returns in time is never abandoned");
  assert.equal(reclaimCalls.length, 0, "a worker still producing output — i.e. one that returned before the bound — must never reach the teardown seam");
});

// ── acceptance 5: a throwing teardown seam leaves the rung's verdict unchanged ──────────────────

test("W1-T2261 (acceptance 5): a teardown seam that throws inside reclaimAbandonedWorker itself never propagates", () => {
  assert.doesNotThrow(() =>
    reclaimAbandonedWorker(
      { runId: "THIS-RUN", taskId: "W1-T2261FIX", elapsedMs: 20 },
      {
        listCandidates: () => [{ pid: 22 }] as never,
        readMarkers: (() => ({ runId: "THIS-RUN" })) as never,
        kill: () => {
          throw new Error("ESRCH");
        },
      },
    ),
  );
});

test("W1-T2261 (acceptance 5): a reclaimWorker that throws leaves the rung's outcome as spawn_abandoned, never an unhandled rejection into the rung's own verdict", async () => {
  const steps: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungBaseOpts(),
    initialReview: fakeReview("failure"),
    deps: {
      spawn: () => new Promise<WorkerResult>(() => {}),
      waitForCiGreen: async () => "green",
      runReview: async () => fakeReview("failure"),
      push: () => {},
      issues: NEVER_ISSUES,
      ledgerPath: tmpLedgerPath(),
      log: (step, extra = {}) => steps.push({ step, extra: extra ?? {} }),
      say: () => {},
      account: (r) => r,
      spawnWallClockBoundMs: 20,
      reclaimWorker: () => {
        throw new Error("teardown seam exploded");
      },
    },
  });
  assert.equal(outcome.outcome, "spawn_abandoned", "a reclaim failure must never change the rung's own verdict");
  const failed = steps.find((s) => s.step === "fix.spawn_reclaim_failed");
  assert.ok(failed, "the failure is still recorded — a thrown teardown is never silently dropped");
  assert.match(String(failed!.extra.error), /teardown seam exploded/);
});
