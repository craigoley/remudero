// test/the-sweeps-plan-pr-preflight-runs-off-the-daemon-loop.test.ts — W1-T5521.
//
// W1-T5405 (#8898) made the sweep's two plan-PR rungs (the W1-T4838 refusal amendment and the W1-T3390 plan
// repair) preflight their commit through `planPrPreflightAtCommit`, whose every check is a `spawnSync`. The
// sweep runs in the daemon process, so the operator measured ~290 s of frozen timers per preflight, about twice
// a day. These suites drive each rung's REAL effect over a real git fixture whose tree carries a SLOW lint-plan
// script (a real child process, sleeping SLOW_CHECK_MS and then refusing), with the default preflight seam.
//
// THE OBSERVATION: a ticker set before the rung starts reads the script's start/done marks. It sees the check
// running only if the loop turns while the child is alive. The loop's worst delay is measured with
// `perf_hooks.monitorEventLoopDelay` across the rung.
//
// The control wires the sync `planPrPreflightAtCommit` back in (the task's falsifier). Its ticker must never see
// the check running and its probe must see a stall of about SLOW_CHECK_MS. Without it, a quiet probe proves nothing.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { appendLedger } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  planPrPreflight,
  planPrPreflightAsync,
  planPrPreflightAtCommit,
  planPrPreflightAtCommitAsync,
  type PlanPrPreflightReading,
} from "../src/lib/plan-pr-emitter.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { REFUSAL_AMENDMENT_STEP, extractRefusal } from "../src/lib/refusal-amendment.js";
import { PLAN_REPAIR_DISPATCH_STEP, buildSweepEffects, type BuildSweepEffectsDeps, type OpenPrView } from "../src/lib/sweep.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";
import { buildFixturePlanPrBody } from "./helpers/plan-pr-body-fixture.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const TASK = "W1-T5521-FIXTURE";
const RUN = "RUN-REFUSED-5521";
/** How long the fixture tree's lint-plan check holds its child process alive before it refuses. */
const SLOW_CHECK_MS = 2_000;
/** The declared bound on the loop's worst delay through a rung: half the slow check. */
const LAG_BOUND_MS = SLOW_CHECK_MS / 2;
const REFUSES_LINE = `lint-plan-precheck: ${TASK} REFUSES — slow fixture red`;
const STALE_PROOF = "unit test: test/stale.test.ts";
const SHARD = [
  `- id: ${TASK}`,
  "  repo: remudero",
  "  status: queued",
  "  attempts: 0",
  "  acceptance:",
  "    - claim: the offending proof lives in a shard outside this PR's diff",
  `      proof: ${STALE_PROOF}`,
  "",
].join("\n");
const REFUSAL = ["REFUSED:", "1. [premise-rotted] No headline at this checkout meets the task record's required condition"].join("\n");

type Row = Record<string, unknown>;

function rows(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
}

/** A repo whose committed tree carries the task shard and a lint-plan script that is slow, then red. */
function slowTree(): { repo: GitRepo; marks: string } {
  const repo = gitRepo();
  const marks = join(repo.dir, "..", `${repo.dir.split("/").pop()}-check-marks`);
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(repo.dir, "scripts"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.d", `${TASK}-fixture.yaml`), SHARD);
  writeFileSync(
    join(repo.dir, "scripts", "lint-plan-precheck.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(marks)}, "started\\n");`,
      `setTimeout(() => {`,
      `  appendFileSync(${JSON.stringify(marks)}, "done\\n");`,
      `  console.log(${JSON.stringify(REFUSES_LINE)});`,
      "  process.exit(1);",
      `}, ${SLOW_CHECK_MS});`,
      "",
    ].join("\n"),
  );
  repo.git("add", "plan", "scripts");
  repo.git("commit", "--quiet", "-m", "seed the fixture shard and the slow check");
  return { repo, marks };
}

/** One rung's real effect over the real fixture repo; only fetch, push and gh are faked. */
function rungFixture(over: Partial<BuildSweepEffectsDeps> = {}) {
  const { repo, marks } = slowTree();
  const ledger = join(repo.dir, "state", "ledger.ndjson");
  const task = { id: TASK, repo: "remudero", status: "queued", attempts: 0, title: "fixture" } as unknown as Task;
  const pushes: Array<{ dir: string; sha?: string }> = [];
  const ghCalls: string[][] = [];
  let wt: GitRepo | undefined;
  const effectsInput: BuildSweepEffectsDeps = {
    owner: "acme",
    repo: "remudero",
    config: { root: repo.dir, claudeBin: "/bin/true" } as Config,
    ledgerPath: ledger,
    runId: "SWEEP-W1-T5521",
    plan: { tasks: [task], byId: new Map([[TASK, task]]) } as unknown as Plan,
    log: (step, extra) => appendLedger(ledger, { run_id: "SWEEP-W1-T5521", task_id: "SWEEP", step, ...extra }),
    nowMsImpl: () => NOW,
    worktreeAddImpl: (_repoDir, worktreePath, branch) => {
      wt = repo.addWorktree(worktreePath, branch);
    },
    // fetch and the stale-branch clear have no remote to reach; add, commit and rev-parse run for real.
    planRepairGitImpl: (_file, args) => (args[2] === "fetch" || args[2] === "branch" ? "" : `${wt!.git(...args.slice(2))}\n`),
    gitPushRunBranchImpl: (dir, opts) => {
      pushes.push({ dir, sha: opts?.expectedHeadSha });
    },
    ghJsonImpl: (args) => {
      ghCalls.push(args);
      return args.includes("--method") ? { html_url: "https://github.com/acme/remudero/pull/9521", number: 9521 } : [];
    },
    buildPlanPrBodyImpl: buildFixturePlanPrBody,
    reloadPlanForFixImpl: () => undefined,
    ...over,
  };
  const creates = () => ghCalls.filter((c) => c.includes("--method"));
  return { repo, marks, ledger, effects: buildSweepEffects(effectsInput), pushes, creates };
}

/** Run `rung` with a ticker scheduled first; reports whether a tick saw the slow check alive, and the worst lag. */
async function observeLoop<T>(marks: string, rung: () => Promise<T>): Promise<{ result: T; sawCheckRunning: boolean; maxLagMs: number }> {
  let sawCheckRunning = false;
  const ticker = setInterval(() => {
    if (existsSync(marks) && readFileSync(marks, "utf8") === "started\n") sawCheckRunning = true;
  }, 20);
  const probe = monitorEventLoopDelay({ resolution: 10 });
  probe.enable();
  try {
    // The histogram's first tick only sets a baseline: warm it up so a stall at the start is measured.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await rung();
    // It records only when its own timer runs: give it the turn a stall ending last would miss.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { result, sawCheckRunning, maxLagMs: probe.max / 1e6 };
  } finally {
    probe.disable();
    clearInterval(ticker);
  }
}

function amendmentCandidate() {
  return { taskId: TASK, runId: RUN, reportExcerpt: REFUSAL, refusals: extractRefusal(REFUSAL) };
}

function stalePr(): OpenPrView {
  return {
    prNumber: 5521,
    prUrl: "https://github.com/acme/remudero/pull/5521",
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 2,
    lastActivityAt: "2026-10-03T11:00:00.000Z", // expiring-fixture: exempt -- read only against this suite's injected NOW
    headSha: "5521aaaa",
    autoMergeArmed: false,
  };
}

function assertRefusedOnLintPlan(failures: unknown): void {
  assert.deepEqual(failures, [{ check: "lint-plan", firstLine: REFUSES_LINE }], "the slow check's red is the named failure");
}

test("W1-T5521: the refusal-amendment rung's preflight check runs while a timer set before it fires, and its red still pushes nothing", async (t) => {
  const f = rungFixture();

  const { result, sawCheckRunning, maxLagMs } = await observeLoop(f.marks, () =>
    withLiveWritesAllowed(() => f.effects.draftRefusalAmendments!([amendmentCandidate()])),
  );
  t.diagnostic(`max loop delay, preflight awaited: ${maxLagMs.toFixed(0)} ms`);

  assert.equal(readFileSync(f.marks, "utf8"), "started\ndone\n", "the slow check ran to completion in a real child process");
  assert.ok(sawCheckRunning, "a tick landed while the preflight's child process was still running");
  assertWallClockBound(maxLagMs, LAG_BOUND_MS, `the loop's worst delay through the refusal-amendment rung was ${maxLagMs.toFixed(0)} ms`);
  assert.equal(result[0]!.outcome, "error", "the refused amendment is this pass's error outcome, as before");
  assert.deepEqual(f.pushes, [], "a red preflight pushes nothing");
  assert.equal(f.creates().length, 0, "a red preflight opens no PR");
  const refused = rows(f.ledger).filter((r) => r.step === "plan_pr.preflight_refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.lane, "refusal_amendment");
  assertRefusedOnLintPlan(refused[0]!.failures);
  assert.deepEqual(
    rows(f.ledger).filter((r) => r.step === REFUSAL_AMENDMENT_STEP).map((r) => r.outcome),
    ["preflight_refused"],
    "the refusal is this source run's recorded outcome",
  );
  assert.equal(f.repo.git("worktree", "list").split("\n").length, 1, "the preflight's tree and the rung's worktree are both removed");
});

test("W1-T5521: the plan-repair rung's preflight check runs while a timer set before it fires, and its red still pushes nothing", async (t) => {
  const f = rungFixture();

  const { result, sawCheckRunning, maxLagMs } = await observeLoop(f.marks, () =>
    withLiveWritesAllowed(async () =>
      f.effects.dispatchPlanOnlyRepair!(stalePr(), { proofs: [{ claim: "the offending proof", proof: STALE_PROOF, proofExec: "not_executable" }] }),
    ),
  );
  t.diagnostic(`max loop delay, preflight awaited: ${maxLagMs.toFixed(0)} ms`);

  assert.equal(result, true);
  assert.equal(readFileSync(f.marks, "utf8"), "started\ndone\n", "the slow check ran to completion in a real child process");
  assert.ok(sawCheckRunning, "a tick landed while the preflight's child process was still running");
  assertWallClockBound(maxLagMs, LAG_BOUND_MS, `the loop's worst delay through the plan-repair rung was ${maxLagMs.toFixed(0)} ms`);
  assert.deepEqual(f.pushes, [], "a red preflight pushes nothing");
  assert.equal(f.creates().length, 0, "a red preflight opens no PR");
  const dispatched = rows(f.ledger).filter((r) => r.step === PLAN_REPAIR_DISPATCH_STEP);
  assert.deepEqual(dispatched.map((r) => r.outcome), ["preflight_refused"], "the rung keeps its ONE ledger row per dispatch");
  assertRefusedOnLintPlan(dispatched[0]!.failures);
  assert.equal(f.repo.git("worktree", "list").split("\n").length, 1, "the preflight's tree and the rung's worktree are both removed");
});

test("W1-T5521 control: the sync planPrPreflightAtCommit wired back into the rung holds the loop for the whole check", async (t) => {
  const f = rungFixture({ planPrPreflightImpl: (dir, sha, pr) => planPrPreflightAtCommit(dir, sha, pr) });

  const { sawCheckRunning, maxLagMs } = await observeLoop(f.marks, () =>
    withLiveWritesAllowed(() => f.effects.draftRefusalAmendments!([amendmentCandidate()])),
  );
  t.diagnostic(`max loop delay, preflight on the loop: ${maxLagMs.toFixed(0)} ms`);

  assert.equal(readFileSync(f.marks, "utf8"), "started\ndone\n", "the same slow check ran");
  assert.equal(sawCheckRunning, false, "no tick can land while spawnSync holds the thread");
  assert.ok(maxLagMs >= SLOW_CHECK_MS * 0.9, `the probe saw the synchronous check: ${maxLagMs.toFixed(0)} ms against ${SLOW_CHECK_MS} ms`);
  assertRefusedOnLintPlan(rows(f.ledger).find((r) => r.step === "plan_pr.preflight_refused")?.failures);
  assert.deepEqual(f.pushes, []);
});

// ── the async core's verdict is the sync core's, check for check ─────────────────────────────────

/** A repo at a commit that edits one shard and adds another against a local `origin/main`. */
function changedShardsTree(): GitRepo {
  const repo = gitRepo();
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  const shard = (id: string, proofs: string[]) =>
    [`- id: ${id}`, "  acceptance:", ...proofs.flatMap((p) => [`    - claim: c`, `      proof: "${p}"`]), ""].join("\n");
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W9-T1-edited.yaml"), shard("W9-T1", ["grep: kept in a"]));
  repo.git("add", "plan");
  repo.git("commit", "--quiet", "-m", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W9-T1-edited.yaml"), shard("W9-T1", ["grep: kept in a", "grep: stale in b"]));
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W9-T2-new.yaml"), shard("W9-T2", ["grep: fresh in c"]));
  repo.git("add", "plan");
  repo.git("commit", "--quiet", "-m", "head");
  return repo;
}

test("W1-T5521: planPrPreflightAsync reaches the same verdict as planPrPreflight over the same check readings", async () => {
  const repo = changedShardsTree();
  const proofStatus: Record<string, number | null> = {
    "grep: red in body": 1,
    "grep: odd in body": 4,
    "grep: green in body": 0,
    "grep: kept in a": 5,
    "grep: stale in b": 5,
    "grep: fresh in c": 0,
  };
  const checked: string[][] = [[], []];
  const readings = {
    lintPlan: (): PlanPrPreflightReading => ({ status: 0, output: "" }),
    taskIdExistence: (): PlanPrPreflightReading => {
      throw new Error("task-id-existence could not start");
    },
    shardCensus: (): PlanPrPreflightReading => ({ status: null, output: "no # fail line" }),
  };
  const body = ["## Acceptance", "- red | grep: red in body", "- odd | grep: odd in body", "- green | grep: green in body"].join("\n");
  const input = { cwd: repo.dir, title: "chore(plan): file W9-T2", body };

  const sync = planPrPreflight(input, { ...readings, checkProof: (_cwd, proof) => (checked[0]!.push(proof), proofStatus[proof]!) });
  const awaited = await planPrPreflightAsync(input, {
    lintPlan: async () => readings.lintPlan(),
    taskIdExistence: async () => readings.taskIdExistence(),
    shardCensus: async () => readings.shardCensus(),
    checkProof: async (_cwd, proof) => (checked[1]!.push(proof), proofStatus[proof]!),
  });

  assert.deepEqual(awaited, sync, "the same findings, in the same order");
  assert.deepEqual(checked[1], checked[0], "the same proofs were checked, in the same order");
  assert.deepEqual(checked[0], ["grep: red in body", "grep: odd in body", "grep: green in body", "grep: stale in b", "grep: fresh in c"], "only the proofs the head introduces are re-checked");
  assert.equal(sync.ok, false);
  assert.deepEqual(sync.failures.map((x) => x.check), ["proof-discrimination"]);
  assert.match(sync.failures[0]!.firstLine, /PR-body proof "grep: red in body" fails on this tree/);
  assert.deepEqual(sync.unreadable.map((x) => x.check), ["task-id-existence", "shard-census"]);
});

test("W1-T5521: planPrPreflightAtCommitAsync reports a commit it cannot materialize as unreadable, never red", async () => {
  const repo = gitRepo();
  const ghost = "0".repeat(40);

  const r = await planPrPreflightAtCommitAsync(repo.dir, ghost, { title: "chore(plan): x", body: "" });

  assert.equal(r.ok, true);
  assert.deepEqual(r.failures, []);
  assert.equal(r.unreadable.length, 1);
  assert.equal(r.unreadable[0]!.check, "tree");
  assert.match(r.unreadable[0]!.firstLine, new RegExp(`^${ghost} could not be materialized: `));
  const tmpless = (line: string) => line.replace(/plan-pr-preflight-\w+/, "plan-pr-preflight-<tmp>");
  const syncLine = planPrPreflightAtCommit(repo.dir, ghost, { title: "chore(plan): x", body: "" }).unreadable[0]!.firstLine;
  assert.equal(tmpless(r.unreadable[0]!.firstLine), tmpless(syncLine), "the sync form's reading, word for word but for its temp dir");
});
