import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { appendLedger } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "../src/lib/plan-pr-emitter.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { REFUSAL_AMENDMENT_STEP, extractRefusal } from "../src/lib/refusal-amendment.js";
import {
  PLAN_REPAIR_DISPATCH_STEP,
  buildSweepEffects,
  priorPlanRepairStrikesFromLedger,
  runSweep,
  type BuildSweepEffectsDeps,
  type OpenPrView,
  type ProofDiscriminationEvidence,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";
import { buildFixturePlanPrBody } from "./helpers/plan-pr-body-fixture.js";

// W1-T5405 — W1-T5348 (#8795) runs the filer preflight before three machine lanes open a plan PR; the sweep's
// two plan-PR rungs (the W1-T4838 refusal amendment and the W1-T3390 stale-proof flag) still pushed and opened
// with none, so a red result landed as an open red plan PR. These tests drive each rung's REAL effect over
// injected git/gh seams with a red, then a green, preflight verdict; one more lets the default seam shell out.

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const VERDICT_TS = "2026-10-03T11:00:00.000Z"; // expiring-fixture: exempt -- compared only against this suite's INJECTED now (NOW), never the wall clock
const TASK = "W1-T5405-FIXTURE";
const RUN = "RUN-REFUSED-5405";
const SHARD = ["- id: " + TASK, "  repo: remudero", "  status: queued", "  attempts: 0", ""].join("\n");
const REFUSAL = ["REFUSED:", "1. [premise-rotted] No headline at this checkout meets the task record's required condition"].join("\n");
const COMMIT_SHA = "5405c0ffee0123456789";

const RED: PlanPrPreflightResult = {
  ok: false,
  failures: [{ check: "lint-plan", firstLine: "lint-plan-precheck: W1-T5405-FIXTURE REFUSES — fixture red" }],
  unreadable: [],
};
const GREEN_UNREADABLE: PlanPrPreflightResult = {
  ok: true,
  failures: [],
  unreadable: [{ check: "shard-census", firstLine: "test/every-shard-on-main-is-lintable.test.ts is absent from the tree" }],
};

type Row = Record<string, unknown>;
type PreflightCall = { dir: string; sha: string; title: string; body: string };

function rows(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
}

function fixtureTask(): Task {
  return { id: TASK, repo: "remudero", status: "queued", attempts: 0, title: "fixture" } as unknown as Task;
}

/** One rung's real effect over recording fakes; `log` appends to the ledger exactly as `rmd sweep`'s own does. */
function effectsFixture(root: string, preflight: PlanPrPreflightResult | undefined, over: Partial<BuildSweepEffectsDeps> = {}) {
  const ledger = join(root, "state", "ledger.ndjson");
  const task = fixtureTask();
  const preflightCalls: PreflightCall[] = [];
  const pushes: Array<{ dir: string; sha?: string }> = [];
  const ghCalls: string[][] = [];
  const worktrees: string[] = [];
  const removed: string[] = [];
  const deps: BuildSweepEffectsDeps = {
    owner: "acme",
    repo: "remudero",
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: ledger,
    runId: "SWEEP-W1-T5405",
    plan: { tasks: [task], byId: new Map([[TASK, task]]) } as unknown as Plan,
    log: (step, extra) => appendLedger(ledger, { run_id: "SWEEP-W1-T5405", task_id: "SWEEP", step, ...extra }),
    nowMsImpl: () => NOW,
    planRepairGitImpl: (_file, args) => (args.includes("rev-parse") ? `${COMMIT_SHA}\n` : ""),
    worktreeAddImpl: (_repoDir, worktreePath) => {
      worktrees.push(worktreePath);
      mkdirSync(join(worktreePath, "plan", "tasks.d"), { recursive: true });
    },
    gitPushRunBranchImpl: (dir, opts) => {
      pushes.push({ dir, sha: opts?.expectedHeadSha });
    },
    worktreeRemoveImpl: (_repoDir, worktreePath) => {
      removed.push(worktreePath);
    },
    ghJsonImpl: (args) => {
      ghCalls.push(args);
      return args.includes("--method") ? { html_url: "https://github.com/acme/remudero/pull/9405", number: 9405 } : [];
    },
    buildPlanPrBodyImpl: buildFixturePlanPrBody,
    reloadPlanForFixImpl: () => undefined,
    ...(preflight
      ? {
          planPrPreflightImpl: (dir: string, sha: string, pr: { title: string; body: string }) => {
            preflightCalls.push({ dir, sha, ...pr });
            return preflight;
          },
        }
      : {}),
    ...over,
  };
  const creates = () => ghCalls.filter((c) => c.includes("--method"));
  return { ledger, effects: buildSweepEffects(deps), preflightCalls, pushes, creates, worktrees, removed };
}

function amendmentRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t5405-amend-"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.d", `${TASK}-fixture.yaml`), SHARD);
  return root;
}

function sweepDeps(f: ReturnType<typeof effectsFixture>): SweepDeps {
  return {
    arm: () => "armed",
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: f.ledger,
    runId: "SWEEP-W1-T5405",
    now: () => NOW,
    draftRefusalAmendments: f.effects.draftRefusalAmendments,
  };
}

test("W1-T5405: a red preflight on the refusal-amendment rung pushes nothing, opens no PR, and is not re-paid next pass", async () => {
  const f = effectsFixture(amendmentRoot(), RED);
  appendLedger(f.ledger, { run_id: RUN, task_id: TASK, step: "verdict", verdict: "no_pr", report_excerpt: REFUSAL, ts: VERDICT_TS });

  await withLiveWritesAllowed(() => runSweep([], sweepDeps(f)));

  assert.equal(f.preflightCalls.length, 2, "the committed tree, then (W1-T5531) its base alone, are preflighted once each");
  assert.equal(f.preflightCalls[0]!.dir, f.worktrees[0], "on the worktree that holds the commit");
  assert.equal(f.preflightCalls[0]!.sha, COMMIT_SHA, "at the exact sha the push would carry");
  assert.match(f.preflightCalls[0]!.title, /^chore\(plan\): propose an amendment for W1-T5405-FIXTURE/);
  assert.match(f.preflightCalls[0]!.body, /^Acceptance:\n- the shard records the worker.s refusal/m, "the preflight reads the body the PR would open with");
  assert.deepEqual(f.pushes, [], "a red preflight pushes nothing");
  assert.equal(f.creates().length, 0, "a red preflight opens no PR");
  assert.deepEqual(f.removed, f.worktrees, "the worktree is still disposed");

  const refused = rows(f.ledger).filter((r) => r.step === "plan_pr.preflight_refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.lane, "refusal_amendment");
  assert.equal(refused[0]!.branch, `refusal-amendment/${TASK}`);
  assert.deepEqual(refused[0]!.failures, RED.failures, "the ledger names the failing check");
  const outcome = rows(f.ledger).filter((r) => r.step === REFUSAL_AMENDMENT_STEP);
  assert.deepEqual(
    outcome.map((r) => [r.task_id, r.source_run_id, r.outcome]),
    [[TASK, RUN, "preflight_refused"]],
    "the refusal is this source run's recorded outcome",
  );

  await withLiveWritesAllowed(() => runSweep([], sweepDeps(f)));
  assert.equal(f.preflightCalls.length, 2, "the next pass finds the source run handled and does not re-run the preflight");
  assert.equal(f.creates().length, 0);
});

test("W1-T5405: a green preflight on the refusal-amendment rung opens the PR with the body it preflighted", async () => {
  const f = effectsFixture(amendmentRoot(), { ok: true, failures: [], unreadable: [] });
  const candidate = { taskId: TASK, runId: RUN, reportExcerpt: REFUSAL, refusals: extractRefusal(REFUSAL) };

  const [result] = await withLiveWritesAllowed(() => f.effects.draftRefusalAmendments!([candidate]));

  assert.equal(result!.outcome, "drafted");
  assert.equal(f.preflightCalls.length, 1);
  assert.deepEqual(f.pushes, [{ dir: f.worktrees[0], sha: COMMIT_SHA }], "the push follows the green preflight");
  assert.equal(f.creates().length, 1, "the PR opens as before");
  assert.ok(f.creates()[0]!.includes(`body=${f.preflightCalls[0]!.body}`), "the opened body is the preflighted body");
  assert.ok(f.creates()[0]!.includes(`title=${f.preflightCalls[0]!.title}`), "the opened title is the preflighted title");
  assert.equal(rows(f.ledger).filter((r) => r.step === "plan_pr.preflight_refused").length, 0);
});

// ── the W1-T3390 plan-repair rung ─────────────────────────────────────────────────────────────────

const PROOF: ProofDiscriminationEvidence = {
  proofs: [{ claim: "the offending proof lives in a shard outside this PR's diff", proof: "unit test: test/stale.test.ts", proofExec: "not_executable" }],
};

function repairRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t5405-repair-"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const shard = [`id: ${TASK}`, "acceptance:", `  - claim: ${PROOF.proofs[0]!.claim}`, `    proof: ${PROOF.proofs[0]!.proof}`, ""].join("\n");
  writeFileSync(join(root, "plan", "tasks.d", `${TASK}-fixture.yaml`), shard);
  return root;
}

function stalePr(): OpenPrView {
  return {
    prNumber: 5405,
    prUrl: "https://github.com/acme/remudero/pull/5405",
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 2,
    lastActivityAt: VERDICT_TS,
    headSha: "5405aaaa",
    autoMergeArmed: false,
  };
}

test("W1-T5405: a red preflight on the plan-repair rung pushes nothing, opens no PR, and spends a strike", async () => {
  const f = effectsFixture(repairRoot(), RED);

  const result = await withLiveWritesAllowed(() => f.effects.dispatchPlanOnlyRepair!(stalePr(), PROOF));

  assert.equal(result, true);
  assert.equal(f.preflightCalls.length, 1);
  assert.equal(f.preflightCalls[0]!.dir, f.worktrees[0]);
  assert.equal(f.preflightCalls[0]!.sha, COMMIT_SHA);
  assert.equal(f.preflightCalls[0]!.title, `chore(plan): flag a stale proof in ${TASK}'s shard for architect repair`);
  assert.deepEqual(f.pushes, [], "a red preflight pushes nothing");
  assert.equal(f.creates().length, 0, "a red preflight opens no PR");
  assert.deepEqual(f.removed, f.worktrees, "the worktree is still disposed");
  const dispatched = rows(f.ledger).filter((r) => r.step === PLAN_REPAIR_DISPATCH_STEP);
  assert.equal(dispatched.length, 1, "the rung keeps its ONE ledger row per dispatch");
  assert.equal(dispatched[0]!.outcome, "preflight_refused");
  assert.deepEqual(dispatched[0]!.failures, RED.failures, "the ledger names the failing check");
  assert.equal(dispatched[0]!.preflight_unreadable, undefined);
  assert.equal(priorPlanRepairStrikesFromLedger(stalePr(), rows(f.ledger)), 1, "the refusal counts toward MAX_PLAN_REPAIR_STRIKES");
});

test("W1-T5405: a green preflight on the plan-repair rung opens the PR and records any check that could not run", async () => {
  const f = effectsFixture(repairRoot(), GREEN_UNREADABLE);

  const result = await withLiveWritesAllowed(() => f.effects.dispatchPlanOnlyRepair!(stalePr(), PROOF));

  assert.equal(result, true);
  assert.deepEqual(f.pushes, [{ dir: f.worktrees[0], sha: COMMIT_SHA }]);
  assert.equal(f.creates().length, 1, "the PR opens as before");
  assert.ok(f.creates()[0]!.includes(`body=${f.preflightCalls[0]!.body}`), "the opened body is the preflighted body");
  const dispatched = rows(f.ledger).filter((r) => r.step === PLAN_REPAIR_DISPATCH_STEP);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.outcome, "dispatched");
  assert.deepEqual(dispatched[0]!.preflight_unreadable, GREEN_UNREADABLE.unreadable, "an unrunnable check is reported, never refusing");
});

// ── the default seam really shells out ───────────────────────────────────────────────────────────

test("W1-T5405: the uninjected preflight materializes the rung's real commit and reports its absent checks", async () => {
  const repo = gitRepo();
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.d", `${TASK}-fixture.yaml`), SHARD);
  repo.git("add", "plan");
  repo.git("commit", "--quiet", "-m", "seed the fixture shard");
  let wt: GitRepo | undefined;
  const f = effectsFixture(repo.dir, undefined, {
    worktreeAddImpl: (_repoDir, worktreePath, branch) => {
      wt = repo.addWorktree(worktreePath, branch);
    },
    // fetch and the stale-branch clear have no remote to reach; add, commit and rev-parse run for real.
    planRepairGitImpl: (_file, args) => (args[2] === "fetch" || args[2] === "branch" ? "" : `${wt!.git(...args.slice(2))}\n`),
    worktreeRemoveImpl: undefined,
  });
  const candidate = { taskId: TASK, runId: RUN, reportExcerpt: REFUSAL, refusals: extractRefusal(REFUSAL) };

  const [result] = await withLiveWritesAllowed(() => f.effects.draftRefusalAmendments!([candidate]));

  assert.equal(result!.outcome, "drafted", "checks a bare fixture tree cannot run are unreadable, not red");
  const headSha = f.pushes[0]?.sha;
  assert.match(headSha ?? "", /^[0-9a-f]{40}$/, "the push carries the real commit");
  assert.equal(repo.git("cat-file", "-t", headSha!), "commit");
  const unreadable = rows(f.ledger).filter((r) => r.step === "plan_pr.preflight_unreadable");
  assert.equal(unreadable.length, 1);
  assert.equal(unreadable[0]!.lane, "refusal_amendment");
  const checks = (unreadable[0]!.unreadable as Array<{ check: string; firstLine: string }>).map((u) => u.check);
  assert.ok(checks.includes("lint-plan") && checks.includes("shard-census"), `the real checks ran inside the materialized tree: ${checks.join(", ")}`);
  assert.ok(!checks.includes("tree"), "the commit was materialized, not skipped");
  assert.equal(repo.git("worktree", "list").split("\n").length, 1, "the preflight's own tree and the rung's worktree are both removed");
});
