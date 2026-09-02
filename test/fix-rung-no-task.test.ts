/**
 * test/fix-rung-no-task.test.ts — impl-FY, then W1-T1095.
 *
 * THE DEFECT. `dispatchFix` looked its PR's task up in the plan and RETURNED when it found none,
 * logging `sweep.fix.no_task`. An agent-authored PR has a descriptive branch and no
 * `Remudero-Task:` trailer, so it matches no plan task — and the rung that exists to repair a
 * CI-failing PR could not act on it. Measured over the unioned ledger: 79 deduped rows across 65
 * distinct PRs, including #1115/#1116/#1117/#1118/#1120/#1127/#1132, the last of which was
 * dispositioned `blocked-fixable, acted=false` — the sweep classifying a fixable PR and then doing
 * nothing, every poll, silently.
 *
 * NO GATEWAY IS REACHED HERE, for either concern below. Every test drives PURE functions, the
 * pure disposition classifier, or `runFixRung` fed hand-rolled fakes (never a real subprocess or
 * `gh` call) — the SAME discipline `test/strike-accounting.test.ts` established for driving the
 * real dispatch loop. The one exception (a stub `gh` written to PATH for the REFUSAL test below)
 * is a fake gateway, never a live one; the suite is proven gateway-free by the sabotage check in
 * the report (a `gh` on PATH that exits non-zero on every invocation).
 *
 * W1-T1095 (added below, THE FIX RUNG CANNOT RESOLVE A BLOCKER OUTSIDE ITS OWN DIFF) is a
 * SEPARATE, later concern that happens to share this rung's own test home per that task's own
 * `note:` (an existing home is declared rather than a new file, so the concern count is not
 * inflated by a filename) — it covers capability 1 of that task's three (record-and-resume:
 * park against a prerequisite instead of retrying), never the no-task-PR defect above.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deriveDisposition, DEFAULT_SWEEP_POLICY, type LiveStateResult, type OpenPrView } from "../src/lib/sweep.js";
import type { Plan, Task } from "../src/lib/plan.js";
import {
  decideFixRebase,
  escalationTaskIdFor,
  fixHeadAcceptable,
  fixRebaseAlreadySpent,
  fixRebaseMergeFactsFromRest,
  fixRungTaskFor,
  fixRungTerminationVerdict,
  ghUpdateBranch,
  ghUpdateBranchArgv,
  mergeFactsFromRest,
  outOfDiffBlockerFor,
  prerequisiteMerged,
  priorStrikesFor,
  runFixRebase,
  runFixRung,
  type FixRungOutcome,
} from "../src/run-task.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");

const T = (id: string, over: Partial<Task> = {}): Task =>
  ({ id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", status: "queued", attempts: 0, ...over }) as Task;

const PLAN: Plan = (() => {
  const tasks = [T("W1-T500")];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
})();

/** A CI-failing agent PR: no trailer, descriptive branch — the shape the rung could not act on. */
const AGENT_PR: OpenPrView = {
  prNumber: 1132,
  prUrl: "https://github.com/craigoley/remudero/pull/1132",
  headSha: "cafe1234",
  headRefName: "fix/deploy-identical-discard",
  taskId: undefined,
  reviewState: "none",
  checksState: "red",
  unmetCriteria: [],
  priorStrikes: 0,
  lastActivityAt: new Date().toISOString(),
} as unknown as OpenPrView;

// ── (6) THE RUNG CAN NOW REACH A NO-TASK PR ──────────────────────────────────

test("a PR with no plan task now resolves to a SYNTHETIC task instead of being skipped", () => {
  const { task, synthetic } = fixRungTaskFor(PLAN, AGENT_PR);
  assert.equal(synthetic, true);
  assert.equal(task.id, "PR-1132", "the id is the review lane's own synthetic form");
  assert.equal(task.id, escalationTaskIdFor(AGENT_PR), "and it is the SAME mechanism, not a second one");
  assert.deepEqual(task.acceptance, [], "a no-task PR carries no plan criteria — the ci-log mode targets the failing checks");
});

// ── round-2 fix (PR #1146's own review floor): a synthetic task's `acceptance` ──
// used to be hardcoded `[]`, which made `runFixRung`'s post-strike `runReview`
// (which judges `task.acceptance` DIRECTLY, never the PR body) permanently
// report "no acceptance criteria to judge" for ANY `blocked_review` synthetic
// dispatch — an unfixable loop, not merely a no-op one. `fixRungTaskFor` now
// takes the PR body and resolves it the SAME way `reviewCommand` already does
// for a manual/plan PR: `parseAcceptanceBlock` over the `## Acceptance` block.
test("a no-task PR's synthetic acceptance is resolved from its own PR body's Acceptance block", () => {
  const body = [
    "## Acceptance",
    "",
    "- the value is fifteen | grep: value: 15 in plan/policy.yaml",
    "- the cap still binds | grep: maxPerDay in plan/policy.yaml",
    "",
  ].join("\n");
  const { task, synthetic } = fixRungTaskFor(PLAN, AGENT_PR, body);
  assert.equal(synthetic, true);
  assert.deepEqual(task.acceptance, [
    { claim: "the value is fifteen", proof: "grep: value: 15 in plan/policy.yaml" },
    { claim: "the cap still binds", proof: "grep: maxPerDay in plan/policy.yaml" },
  ]);
});

test("a no-task PR whose body carries no Acceptance block still resolves to []", () => {
  const { task } = fixRungTaskFor(PLAN, AGENT_PR, "no acceptance section here at all");
  assert.deepEqual(task.acceptance, []);
});

test("a PR WITH a plan task is untouched — the real task, not a synthetic one", () => {
  const { task, synthetic } = fixRungTaskFor(PLAN, { prNumber: 9, taskId: "W1-T500" });
  assert.equal(synthetic, false);
  assert.equal(task.id, "W1-T500");
  assert.equal(task, PLAN.tasks[0], "the identical object — no copy, no defaults applied over it");
});

test("a LANE PR whose id is real but absent from the plan keeps its own identity", () => {
  // 20 of the 65 PRs in the measured trail are this shape (TRIAGE-*/RETRO-*/PLAN-create).
  const { task, synthetic } = fixRungTaskFor(PLAN, { prNumber: 554, taskId: "TRIAGE-fb-1784732585507-04eac2" });
  assert.equal(synthetic, true, "not in plan.tasks");
  assert.equal(task.id, "TRIAGE-fb-1784732585507-04eac2", "its OWN id is preserved — never renamed to PR-554");
});

test("synthetic orchestrator lane trailers own their exact run-<full-id> branches without shortening the ledger identity", () => {
  const laneIds = [
    "RETRO-1788350665543",
    "TRIAGE-fb-1784732585507-04eac2",
    "PLAN-create-1788350665543",
    "APPROVE-fb-1784732585507-04eac2",
  ];

  for (const [index, laneId] of laneIds.entries()) {
    const head = `run-${laneId}`;
    const { task, synthetic } = fixRungTaskFor(PLAN, { prNumber: 3639 + index, taskId: laneId }, "", head);
    assert.equal(synthetic, true, `${laneId} is an orchestrator lane absent from plan.tasks`);
    assert.equal(task.id, laneId, "the full trailer identity remains the strike/review ledger key");
    assert.equal(fixHeadAcceptable(head, task.id, synthetic), true, `${head} is that synthetic lane's own branch`);
  }

  assert.equal(
    fixHeadAcceptable("run-W1-T500", "W1-T500", false),
    false,
    "a real plan task still requires its ordinary run-<task>-<dispatch epoch> branch",
  );
  assert.equal(
    fixHeadAcceptable("run-W1-T999-1785600000000", "RETRO-1788350665543", true),
    false,
    "a synthetic lane still cannot amend a foreign W1 task branch",
  );
});

test("a plan-only RETRO PR without credited task derives only its lane identity from its own head", () => {
  const head = "run-RETRO-1788324628827";
  const { task, synthetic } = fixRungTaskFor(PLAN, { prNumber: 3591 }, "", head);
  assert.equal(synthetic, true, "RETRO is an orchestrator lane, not a plan task to credit");
  assert.equal(task.id, "RETRO", "the fix identity matches the lane id embedded in its own run branch");
  assert.equal(fixHeadAcceptable(head, task.id, synthetic), true, "the fix rung can amend its own RETRO branch");
});

test("a PR without credited task on a W1 task branch never derives that task from the head", () => {
  const head = "run-W1-T999-1785600000000";
  const { task, synthetic } = fixRungTaskFor(PLAN, { prNumber: 3591 }, "", head);
  assert.equal(synthetic, true);
  assert.equal(task.id, "PR-3591", "a task identity still requires the trailer/body resolver, never the branch fallback");
  assert.equal(fixHeadAcceptable(head, task.id, synthetic), false, "the foreign task branch remains protected");
});

// ── (7) THE DISPOSITION SET IS UNCHANGED ─────────────────────────────────────

test("AGGREGATE: no PR becomes fixable that was not before — every disposition is byte-identical", () => {
  // Drive the REAL classifier over a spread of shapes and compare the FULL disposition, not one
  // case. This change is about the rung being able to ACT, never about what qualifies.
  const shapes: Array<[string, Partial<OpenPrView>]> = [
    ["agent ci-red no task", { checksState: "red", reviewState: "none", taskId: undefined }],
    ["agent ci-green review-success", { checksState: "green", reviewState: "success", taskId: undefined }],
    ["agent ci-green no review", { checksState: "green", reviewState: "none", taskId: undefined }],
    ["task ci-red", { checksState: "red", reviewState: "none", taskId: "W1-T500" }],
    ["task review-failure", { checksState: "green", reviewState: "failure", taskId: "W1-T500" }],
    ["ci pending", { checksState: "pending", reviewState: "none", taskId: undefined }],
  ];
  const got = shapes.map(([label, over]) => {
    const pr = { ...AGENT_PR, ...over } as OpenPrView;
    return `${label} => ${deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW).disposition}`;
  });
  // Recorded from pristine origin/main BEFORE the change (see the report's §7 paste).
  assert.deepEqual(got, [
    "agent ci-red no task => blocked-fixable",
    "agent ci-green review-success => mergeable",
    "agent ci-green no review => post-review",
    "task ci-red => blocked-fixable",
    "task review-failure => blocked-ambiguous",
    "ci pending => wait",
  ]);
});

// ── (8) THE CAP BINDS A NO-TASK PR ───────────────────────────────────────────

test("the strike cap BINDS a no-task PR — which it could not before, because it keys on the id", () => {
  // priorStrikesFor returns 0 for an undefined taskId (run-task.ts), so an un-synthesised PR would
  // have been not merely reachable but UNBOUNDED — the same shape as the defect being fixed.
  const ledger = [
    { step: "fix.dispatch", task_id: "PR-1132", verdict_regime: "executed" },
    { step: "fix.dispatch", task_id: "PR-1132", verdict_regime: "executed" },
    { step: "fix.dispatch", task_id: "W1-T500", verdict_regime: "executed" },
  ];
  assert.equal(priorStrikesFor(ledger, undefined, "executed"), 0, "UNBOUNDED without an id — the hazard");
  const { task } = fixRungTaskFor(PLAN, AGENT_PR);
  assert.equal(priorStrikesFor(ledger, task.id, "executed"), 2, "with the synthetic id the cap counts this PR's own strikes");
  assert.equal(priorStrikesFor(ledger, "PR-9999", "executed"), 0, "and does not leak across PRs");
});

// ── (9) TRAP 1: THE RUNG CANNOT PUSH ONTO A BRANCH IT DOES NOT OWN ───────────

test("a synthetic PR whose head claims ANOTHER task is REFUSED — mis-trailered, not task-less", () => {
  // The load-bearing half of the relaxation: amending this would push commits onto W1-T123's own
  // run branch under a synthetic identity.
  assert.equal(fixHeadAcceptable("run-W1-T123-1785600000000", "PR-1132", true), false);
  assert.equal(fixHeadAcceptable("run-W1-T500-1", "PR-1132", true), false);
});

test("a synthetic PR's OWN descriptive head is accepted; a lane PR's own run branch is too", () => {
  assert.equal(fixHeadAcceptable("fix/deploy-identical-discard", "PR-1132", true), true);
  assert.equal(fixHeadAcceptable("impl-fy-fix-no-task", "PR-1132", true), true);
  assert.equal(
    fixHeadAcceptable("run-TRIAGE-fb-1784732585507-04eac2-1784740000000", "TRIAGE-fb-1784732585507-04eac2", true),
    true,
    "a lane PR's own run branch is its own, not a foreign claim",
  );
});

test("a PLAN-TASK PR is still strict — the creditability gate is unchanged for it", () => {
  assert.equal(fixHeadAcceptable("run-W1-T500-1785600000000", "W1-T500", false), true);
  assert.equal(fixHeadAcceptable("fix/something", "W1-T500", false), false, "a fix/* head still cannot credit");
  assert.equal(fixHeadAcceptable("run-W1-T5001-1", "W1-T500", false), false, "prefix collision still refused");
  assert.equal(fixHeadAcceptable(undefined, "W1-T500", false), false, "an unresolvable head is never acceptable");
});

test("the push itself can never force — the helper takes no force flag at all", async () => {
  // TRAP 1's other half, asserted on the real argv rather than on a comment: if the branch moved
  // under the rung, a plain push is REJECTED as non-fast-forward and the fix site swallows it.
  const { gitPushRunBranch } = await import("../src/lib/git-push.js");
  const { withLiveWritesAllowed } = await import("../src/lib/live-write-guard.js");
  let argv: string[] = [];
  withLiveWritesAllowed(() => gitPushRunBranch("/tmp/nowhere", { exec: (_f, a) => void (argv = a) }));
  assert.deepEqual(argv, ["-C", "/tmp/nowhere", "push", "origin", "HEAD"]);
  assert.ok(!argv.includes("--force") && !argv.includes("-f") && !argv.some((a) => a.startsWith("+")),
    `no force in any form; got ${JSON.stringify(argv)}`);
});

// ── the REFUSAL branch, driven through the real dispatchFix closure ──────────

test("dispatchFix REFUSES a synthetic PR whose head claims another task, before any git side effect", async () => {
  // The one branch the pure helpers cannot reach: the closure's own log+return. Driven with a `gh`
  // STUB ON PATH (the pattern test/run-task.test.ts already uses for this same closure) — a stub,
  // never the real gateway, which is why the sabotage check still passes. The refusal happens
  // BEFORE `git worktree add`, so no repository is needed and none is created.
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildSweepEffects } = await import("../src/run-task.js");
  const { DEFAULT_SWEEP_POLICY: POLICY } = await import("../src/lib/sweep.js");

  const root = mkdtempSync(join(tmpdir(), "fy-refuse-"));
  const bin = mkdtempSync(join(tmpdir(), "fy-gh-"));
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      'const a = process.argv.slice(2); const i = a.indexOf("--json"); const f = i >= 0 ? a[i+1] : undefined;',
      // A FOREIGN run-branch: this PR carries no task, but its head claims W1-T999.
      // `dispatchFix` now asks for `headRefName,body` in ONE call (never two `gh pr view`s).
      'if (f && f.includes("headRefName")) process.stdout.write(JSON.stringify({ headRefName: "run-W1-T999-1785600000000", body: "" }));',
      'else if (f === "state") process.stdout.write(JSON.stringify({ state: "OPEN" }));',
      // W1-T511: `ghLiveState` reads live PR state over REST now (`gh api repos/{o}/{r}/pulls/{n}`),
      // not `gh pr view --json state`. Without this arm the read falls through to the `{}` default,
      // `prStateFromRest` folds that to NOT-OPEN, and the refusal under test never runs — the run
      // stands down at `sweep.fix.not_open` instead. REST reports an open PR as
      // `{state:"open",merged:false}`, which is what that fold expects.
      'else if (a[0] === "api" && typeof a[1] === "string" && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+$/.test(a[1])) process.stdout.write(JSON.stringify({ state: "open", merged: false }));',
      'else process.stdout.write("{}");',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  try {
    mkdirSync(join(root, "repos"), { recursive: true });
    const effects = buildSweepEffects(
      "acme", "scratch-fy-repo", { root } as never, join(root, "ledger.ndjson"), "SWEEP-FY",
      PLAN, (step, extra) => void logs.push({ step, extra }), POLICY,
    );
    await effects.dispatchFix(
      { ...AGENT_PR, prNumber: 4242, taskId: undefined, headRefName: "run-W1-T999-1785600000000" } as never,
      { unmetCriteria: [], ciFailures: [] } as never,
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }

  const refusal = logs.find((l) => l.step === "sweep.fix.uncreditable_head");
  assert.ok(refusal, `the foreign head must be refused; got ${JSON.stringify(logs.map((l) => l.step))}`);
  assert.equal(refusal.extra?.synthetic, true, "and the line says it was a synthetic-id dispatch");
  assert.equal(refusal.extra?.head, "run-W1-T999-1785600000000");
  assert.ok(!logs.some((l) => l.step === "fix.dispatch"), "no strike was spent");
});

test("dispatchFix sends the production RETRO trailer/head shape to a worker under the full trailer identity", async () => {
  const owner = "acme";
  const repo = "scratch-retro-own-head-repo";
  const laneId = "RETRO-1788350665543";
  const branch = `run-${laneId}`;
  const root = mkdtempSync(join(tmpdir(), "retro-own-head-root-"));
  const bare = mkdtempSync(join(tmpdir(), "retro-own-head-origin-"));
  const seed = mkdtempSync(join(tmpdir(), "retro-own-head-seed-"));
  const bin = mkdtempSync(join(tmpdir(), "retro-own-head-gh-"));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "rmd-test",
    GIT_AUTHOR_EMAIL: "rmd-test@example.invalid",
    GIT_COMMITTER_NAME: "rmd-test",
    GIT_COMMITTER_EMAIL: "rmd-test@example.invalid",
  };
  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv });

  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { env: gitEnv });
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { env: gitEnv });
  writeFileSync(join(seed, "README.md"), "retro fixture\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  git(seed, "checkout", "--quiet", "-b", branch);
  git(seed, "push", "--quiet", "origin", branch);
  const branchSha = git(seed, "rev-parse", "HEAD").trim();

  const repoDir = join(root, "repos", repo);
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", bare, repoDir], { env: gitEnv });
  git(repoDir, "config", "user.name", "rmd-test");
  git(repoDir, "config", "user.email", "rmd-test@example.invalid");

  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"headRefName"*) printf \'{"headRefName":"%s","body":""}\\n\' ' + JSON.stringify(branch) + " ;;",
      '  *"/check-runs"*) echo \'{"check_runs":[{"name":"ci","status":"completed","conclusion":"success"}]}\' ;;',
      '  *"/commits/"*"/status"*) echo \'{"statuses":[]}\' ;;',
      '  *"api"*"pulls/"*) echo ' + JSON.stringify(JSON.stringify({ state: "open", merged: false, head: { sha: branchSha } })) + " ;;",
      "  *) echo '{}' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let spawnCalls = 0;
  try {
    const effects = (await import("../src/run-task.js")).buildSweepEffects(
      owner,
      repo,
      { claudeBin: "/usr/bin/true", root } as never,
      join(root, "ledger.ndjson"),
      "SWEEP-W1-T2703",
      { tasks: [], byId: new Map() },
      (step, extra) => void logs.push({ step, extra }),
      DEFAULT_SWEEP_POLICY,
      undefined,
      async () => {
        spawnCalls += 1;
        return {
          sessionId: "W1-T2703-SESSION",
          costUsd: 0,
          numTurns: 1,
          text: "REPORT\nretro repair attempted\n",
          blocks: ["REPORT\nretro repair attempted\n"],
          stderr: "",
          subtype: "success",
          isError: false,
          apiError: false,
          permissionDenials: [],
          childEnvKeys: [],
          model: "test-model",
          effort: "high",
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {},
          compactionEvents: [],
          qualitySuspect: false,
        } satisfies WorkerResult;
      },
    );

    await withLiveWritesAllowed(() =>
      effects.dispatchFix(
        {
          ...AGENT_PR,
          prNumber: 3639,
          prUrl: `https://github.com/${owner}/${repo}/pull/3639`,
          taskId: laneId,
          headRefName: branch,
          headSha: branchSha,
          ciFailures: [{ name: "ci", logTail: "assertion failed" }],
        } as never,
        { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "assertion failed" }] } as never,
      ),
    );

    assert.equal(spawnCalls, 1, "the production-shaped RETRO PR reaches the worker exactly once");
    assert.ok(!logs.some((line) => line.step === "sweep.fix.uncreditable_head"), "its own branch is not refused as foreign");
    assert.ok(
      logs.some((line) => line.step === "fix.dispatch" && line.extra?.task_id === laneId),
      `the strike keeps the full trailer identity; got ${JSON.stringify(logs)}`,
    );
  } finally {
    process.env.PATH = oldPath;
    for (const dir of [root, bare, seed, bin]) rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T1095: THE FIX RUNG CANNOT RESOLVE A BLOCKER THAT LIVES OUTSIDE ITS OWN DIFF ──────────
//
// Capability 1 of 3 (design note (i) — record-and-resume, landed first because it is inert on
// its own and makes the other two capabilities observable). Before this, a review that named an
// out-of-diff prerequisite ("blocked on #N") was indistinguishable from an ordinary in-diff
// deficiency: the rung struck against it up to `strikeCap`, then escalated as if a human were
// needed, even though the remedy was a separate PR one merge away (#2363/#2365, this task's own
// rationale (5)).
//
// STILL GATEWAY-FREE, same discipline as the tests above: every `runFixRung` drive below is
// fed hand-rolled fakes for `spawn`/`waitForCiGreen`/`runReview`/`push`/`issues`/
// `readLiveState`/`readPrerequisiteState` — never a real subprocess, `gh` call, or network
// request. This is the SAME harness `test/strike-accounting.test.ts`/
// `test/sweep-wall-clock-bound.test.ts` already established for driving the real dispatch loop
// (never a hand-rolled reimplementation of its accounting).

function fixRungCriterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fixRungReview(
  state: "success" | "failure",
  criteria: CriterionVerdict[],
  headSha = "deadbeef",
  summary = state === "success" ? "all criteria met" : "unmet criteria",
): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary,
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

function fixRungWorkerResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
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
    ...over,
  };
}

const FIX_RUNG_TEST_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungTestOpts() {
  return {
    taskId: "W1-T1095FIX",
    runId: "W1-T1095FIX-1730000000000",
    task: { id: "W1-T1095FIX", title: "Some task blocked on a prerequisite" },
    prUrl: "https://github.com/acme/remudero/pull/2365",
    branch: "run-W1-T1095FIX-1730000000000",
    worktreePath: "/tmp/rmd-w1-t1095-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_TEST_MOUNT,
    settingsFile: "/tmp/rmd-w1-t1095-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-w1-t1095-wt", reviewerMount: FIX_RUNG_TEST_MOUNT },
  };
}

function fixRungTestLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-w1-t1095-ledger-")), "ledger.ndjson");
}

function fixRungTestIssues(calls: Array<{ title: string; body: string; labels: string[] }> = []): IssueGateway {
  return {
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return "https://github.com/acme/remudero/issues/9999";
    },
  };
}

/** Collects every `log(step, extra)` call, the raw shape the ledger-reading pure functions
 *  (`priorStrikesFor` etc.) already read in `test/strike-accounting.test.ts`. */
function fixRungTestLog(): {
  lines: Array<{ task_id: string; step: string } & Record<string, unknown>>;
  log: (step: string, extra?: Record<string, unknown>) => void;
} {
  const lines: Array<{ task_id: string; step: string } & Record<string, unknown>> = [];
  return {
    lines,
    log: (step, extra) => lines.push({ task_id: "W1-T1095FIX", step, ...(extra ?? {}) }),
  };
}

const NEVER_SPAWN = async (): Promise<WorkerResult> => {
  throw new Error("must never be called — an out-of-diff blocker parks BEFORE any strike is spent");
};

// ── the pure classifier itself ────────────────────────────────────────────────────────────────

test("W1-T1095: outOfDiffBlockerFor recognizes the 'blocked on #N' idiom and nothing looser", () => {
  const blocked = fixRungReview("failure", [
    fixRungCriterion({ claim: "the ceiling still binds", met: false, reason: "blocked on #2363 — that PR must land first" }),
  ]);
  assert.equal(outOfDiffBlockerFor(blocked), 2363);

  const summaryBlocked = fixRungReview(
    "failure",
    [fixRungCriterion({ claim: "the override threads through", met: false, reason: "needs more work" })],
    "sha",
    "blocked on #2365",
  );
  assert.equal(outOfDiffBlockerFor(summaryBlocked), 2365);

  const merelyMentions = fixRungReview("failure", [
    fixRungCriterion({ claim: "x", met: false, reason: "see #40 for prior art on this pattern" }),
  ]);
  assert.equal(outOfDiffBlockerFor(merelyMentions), undefined, "a bare PR mention is never mistaken for a park-worthy blocker");

  const ordinary = fixRungReview("failure", [fixRungCriterion({ claim: "x", met: false, reason: "still missing a test" })]);
  assert.equal(outOfDiffBlockerFor(ordinary), undefined);
});

test("W1-T1095: prerequisiteMerged is fail-safe — only an explicit MERGED read counts", () => {
  assert.equal(prerequisiteMerged({ ok: true, state: "MERGED" }), true);
  assert.equal(prerequisiteMerged({ ok: true, state: "OPEN" }), false);
  assert.equal(prerequisiteMerged({ ok: false }), false, "a failed/indeterminate read never reads as merged");
  assert.equal(prerequisiteMerged(undefined), false, "no reader at all never reads as merged");
});

// ── acceptance criterion 1 ──────────────────────────────────────────────────────────────────

test("W1-T1095: an out-of-diff blocker parks against a prerequisite instead of retrying", async () => {
  const { lines, log } = fixRungTestLog();
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungTestOpts(),
    strikeCap: 2,
    initialReview: fixRungReview("failure", [
      fixRungCriterion({
        claim: "the ArmDeps override threads through",
        met: false,
        reason: "blocked on #2363 — the plan-proof-debt ceiling PR must land first",
      }),
    ]),
    deps: {
      spawn: NEVER_SPAWN,
      waitForCiGreen: async () => {
        throw new Error("must never be called — parking happens before CI is ever awaited");
      },
      runReview: async () => {
        throw new Error("must never be called — parking happens before any re-review");
      },
      push: () => {
        throw new Error("must never be called — parking happens before any push");
      },
      issues: fixRungTestIssues(),
      ledgerPath: fixRungTestLedgerPath(),
      log,
      say: () => {},
      account: (r) => r,
      // No `readPrerequisiteState` at all — omitted behaves as "not yet merged" (fail-safe).
    },
  });
  assert.equal(outcome.outcome, "parked");
  assert.equal(outcome.blockedOnPr, 2363);
  assert.equal(outcome.strikes, 0, "no strike was ever spent trying to fix work that lives outside this diff");
  assert.match(outcome.reason, /blocked on #2363/);
  const parked = lines.find((l) => l.step === "fix.parked");
  assert.ok(parked, `expected a fix.parked row; got ${JSON.stringify(lines.map((l) => l.step))}`);
  assert.equal(parked!.blocked_on_pr, 2363);
});

// ── acceptance criterion 2 ──────────────────────────────────────────────────────────────────

test("W1-T1095: a parked pull request consumes no strike", async () => {
  const { lines, log } = fixRungTestLog();
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungTestOpts(),
    strikeCap: 2,
    initialReview: fixRungReview("failure", [
      fixRungCriterion({ claim: "criterion A", met: false, reason: "blocked on #2363 — must land first" }),
    ]),
    deps: {
      spawn: NEVER_SPAWN,
      waitForCiGreen: async () => "green",
      runReview: async () => fixRungReview("success", []),
      push: () => {},
      issues: fixRungTestIssues(),
      ledgerPath: fixRungTestLedgerPath(),
      log,
      say: () => {},
      account: (r) => r,
    },
  });
  assert.equal(outcome.outcome, "parked");
  assert.ok(!lines.some((l) => l.step === "fix.dispatch"), "no fix.dispatch line — nothing for priorStrikesFor to ever count as a strike");
  assert.equal(priorStrikesFor(lines, "W1-T1095FIX"), 0, "the strike counter, read back from the ledger, stays at zero");
});

// ── acceptance criterion 3 ──────────────────────────────────────────────────────────────────

test("W1-T1095: a parked pull request resumes when its prerequisite merges", async () => {
  const blockedReview = fixRungReview("failure", [
    fixRungCriterion({ claim: "criterion A", met: false, reason: "blocked on #2363 — must land first" }),
  ]);

  // First: the prerequisite is still OPEN — parks, exactly like criterion 1/2 above.
  {
    const { log } = fixRungTestLog();
    const outcome = await runFixRung({
      ...fixRungTestOpts(),
      strikeCap: 2,
      initialReview: blockedReview,
      deps: {
        spawn: NEVER_SPAWN,
        waitForCiGreen: async () => "green",
        runReview: async () => fixRungReview("success", []),
        push: () => {},
        issues: fixRungTestIssues(),
        ledgerPath: fixRungTestLedgerPath(),
        log,
        say: () => {},
        account: (r) => r,
        readPrerequisiteState: (n): LiveStateResult => {
          assert.equal(n, 2363);
          return { ok: true, state: "OPEN" };
        },
      },
    });
    assert.equal(outcome.outcome, "parked", "still open — still parked");
  }

  // Then: the SAME review, but the prerequisite has now merged — the rung resumes and
  // dispatches a real strike instead of parking again.
  {
    const { lines, log } = fixRungTestLog();
    let spawnCalls = 0;
    const outcome = await runFixRung({
      ...fixRungTestOpts(),
      strikeCap: 2,
      initialReview: blockedReview,
      deps: {
        spawn: async () => {
          spawnCalls++;
          return fixRungWorkerResult({ sessionId: "fix-session-resumed" });
        },
        waitForCiGreen: async () => "green",
        runReview: async () => fixRungReview("success", []),
        push: () => {},
        issues: fixRungTestIssues(),
        ledgerPath: fixRungTestLedgerPath(),
        log,
        say: () => {},
        account: (r) => r,
        readPrerequisiteState: (n): LiveStateResult => {
          assert.equal(n, 2363);
          return { ok: true, state: "MERGED" };
        },
      },
    });
    assert.equal(outcome.outcome, "fixed", "resumed and the strike resolved it — never parked again");
    assert.equal(spawnCalls, 1, "a real fix worker was dispatched once the prerequisite merged");
    const resumed = lines.find((l) => l.step === "fix.resumed");
    assert.ok(resumed, `expected a fix.resumed row; got ${JSON.stringify(lines.map((l) => l.step))}`);
    assert.equal(resumed!.blocked_on_pr, 2363);
    assert.ok(!lines.some((l) => l.step === "fix.parked"), "this pass never parked");
  }
});

// ── acceptance criterion 4 ──────────────────────────────────────────────────────────────────

test("W1-T1095: every rung termination writes a reason", async () => {
  // (a) fixed
  {
    const { lines, log } = fixRungTestLog();
    const outcome = await runFixRung({
      ...fixRungTestOpts(),
      strikeCap: 2,
      initialReview: fixRungReview("failure", [fixRungCriterion({ claim: "x", met: false, reason: "still missing a test" })], "sha-0"),
      deps: {
        spawn: async () => fixRungWorkerResult(),
        waitForCiGreen: async () => "green",
        runReview: async () => fixRungReview("success", [], "sha-1"),
        push: () => {},
        issues: fixRungTestIssues(),
        ledgerPath: fixRungTestLedgerPath(),
        log,
        say: () => {},
        account: (r) => r,
      },
    });
    assert.equal(outcome.outcome, "fixed");
    assert.ok(outcome.reason && outcome.reason.length > 0, "the outcome itself names a reason");
    const resolved = lines.find((l) => l.step === "fix.resolved");
    assert.ok(resolved && typeof resolved.reason === "string" && resolved.reason.length > 0, "the fix.resolved row names a reason");
  }

  // (b) escalated — plain strike-cap exhaustion (never rule15/instrument/false-block)
  {
    const { lines, log } = fixRungTestLog();
    const outcome = await runFixRung({
      ...fixRungTestOpts(),
      strikeCap: 1,
      initialReview: fixRungReview("failure", [fixRungCriterion({ claim: "x", met: false, reason: "still missing a test" })], "sha-0"),
      deps: {
        spawn: async () => fixRungWorkerResult(),
        waitForCiGreen: async () => "green",
        // A DIFFERENT head sha than the initial review — real progress, still failing — so
        // detectReviewFalseBlock never fires and this reaches the plain exhaustion branch.
        runReview: async () => fixRungReview("failure", [fixRungCriterion({ claim: "x", met: false, reason: "still missing a test" })], "sha-1"),
        push: () => {},
        issues: fixRungTestIssues(),
        ledgerPath: fixRungTestLedgerPath(),
        log,
        say: () => {},
        account: (r) => r,
      },
    });
    assert.equal(outcome.outcome, "escalated");
    assert.ok(outcome.reason && outcome.reason.length > 0, "the outcome itself names a reason");
    const exhausted = lines.find((l) => l.step === "fix.exhausted");
    assert.ok(exhausted && typeof exhausted.reason === "string" && exhausted.reason.length > 0, "the fix.exhausted row names a reason");
  }

  // (c) stood_down — a terminal live-state read before any strike is spent
  {
    const { lines, log } = fixRungTestLog();
    const outcome = await runFixRung({
      ...fixRungTestOpts(),
      strikeCap: 2,
      initialReview: fixRungReview("failure", [fixRungCriterion({ claim: "x", met: false, reason: "still missing a test" })]),
      deps: {
        spawn: NEVER_SPAWN,
        waitForCiGreen: async () => {
          throw new Error("must never be called");
        },
        runReview: async () => {
          throw new Error("must never be called");
        },
        push: () => {
          throw new Error("must never be called");
        },
        issues: fixRungTestIssues(),
        ledgerPath: fixRungTestLedgerPath(),
        log,
        say: () => {},
        account: (r) => r,
        readLiveState: async (): Promise<LiveStateResult> => ({ ok: true, state: "CLOSED" }),
      },
    });
    assert.equal(outcome.outcome, "stood_down");
    assert.ok(outcome.reason && outcome.reason.length > 0, "the outcome itself names a reason");
    const stoodDown = lines.find((l) => l.step === "fix.stood_down");
    assert.ok(stoodDown && typeof stoodDown.reason === "string" && stoodDown.reason.length > 0, "the fix.stood_down row names a reason");
  }

  // (d) spawn_abandoned — a worker that never returns
  {
    const { lines, log } = fixRungTestLog();
    const outcome = await runFixRung({
      ...fixRungTestOpts(),
      strikeCap: 2,
      initialReview: fixRungReview("failure", [fixRungCriterion({ claim: "x", met: false, reason: "still missing a test" })]),
      deps: {
        spawn: () => new Promise<WorkerResult>(() => {}),
        waitForCiGreen: async () => "green",
        runReview: async () => fixRungReview("success", []),
        push: () => {},
        issues: fixRungTestIssues(),
        ledgerPath: fixRungTestLedgerPath(),
        log,
        say: () => {},
        account: (r) => r,
        spawnWallClockBoundMs: 20,
      },
    });
    assert.equal(outcome.outcome, "spawn_abandoned");
    assert.ok(outcome.reason && outcome.reason.length > 0, "the outcome itself names a reason");
    const abandoned = lines.find((l) => l.step === "fix.spawn_abandoned");
    assert.ok(abandoned && typeof abandoned.reason === "string" && abandoned.reason.length > 0, "the fix.spawn_abandoned row names a reason");
  }

  // (e) parked — the new out-of-diff-blocker outcome
  {
    const { lines, log } = fixRungTestLog();
    const outcome = await runFixRung({
      ...fixRungTestOpts(),
      strikeCap: 2,
      initialReview: fixRungReview("failure", [
        fixRungCriterion({ claim: "x", met: false, reason: "blocked on #2363 — must land first" }),
      ]),
      deps: {
        spawn: NEVER_SPAWN,
        waitForCiGreen: async () => "green",
        runReview: async () => fixRungReview("success", []),
        push: () => {},
        issues: fixRungTestIssues(),
        ledgerPath: fixRungTestLedgerPath(),
        log,
        say: () => {},
        account: (r) => r,
      },
    });
    assert.equal(outcome.outcome, "parked");
    assert.ok(outcome.reason && outcome.reason.length > 0, "the outcome itself names a reason");
    const parked = lines.find((l) => l.step === "fix.parked");
    assert.ok(parked && typeof parked.reason === "string" && parked.reason.length > 0, "the fix.parked row names a reason");
  }
});

// ── acceptance criterion 5 ──────────────────────────────────────────────────────────────────

test("W1-T1095: in-diff work still stops at the existing strike ceiling", async () => {
  const { lines, log } = fixRungTestLog();
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  let spawnCalls = 0;
  const outcome: FixRungOutcome = await runFixRung({
    ...fixRungTestOpts(),
    strikeCap: 2,
    initialReview: fixRungReview("failure", [fixRungCriterion({ claim: "criterion A", met: false, reason: "still broken" })], "sha-0"),
    deps: {
      spawn: async () => {
        spawnCalls++;
        return fixRungWorkerResult({ sessionId: `fix-session-${spawnCalls}` });
      },
      waitForCiGreen: async () => "green",
      // A fresh head sha every strike (real, if insufficient, progress) so this never trips
      // the review false-block escape — it must exhaust the cap like any ordinary in-diff
      // deficiency, exactly as it did before W1-T1095.
      runReview: async () =>
        fixRungReview("failure", [fixRungCriterion({ claim: "criterion A", met: false, reason: "still broken" })], `sha-${spawnCalls}`),
      push: () => {},
      issues: fixRungTestIssues(issueCalls),
      ledgerPath: fixRungTestLedgerPath(),
      log,
      say: () => {},
      account: (r) => r,
    },
  });
  assert.equal(outcome.outcome, "escalated", "in-diff work still exhausts and escalates, never parks");
  assert.equal(outcome.strikes, 2, "the strike cap (2) was reached — never bypassed, never widened");
  assert.equal(spawnCalls, 2, "exactly strikeCap fix workers were dispatched — no third strike");
  assert.equal(issueCalls.length, 1, "exactly one BLOCKED issue opened on exhaustion");
  assert.ok(!lines.some((l) => l.step === "fix.parked"), "ordinary in-diff work is never parked");
});

// ── The one difference between the two non-spending terminations, as a unit ──────────────────
//
// `parked` originally shipped as its own near-identical emission block inside `runTaskBody` — a
// closure nested in `runTask` that no test drives directly — so every added line was reachable
// by nothing and `diff-coverage` blocked on all of them. The blocks are now folded, and the
// genuinely differing part is `fixRungTerminationVerdict`. These are its two arms.

test("W1-T1095: a parked termination names its prerequisite in the reason, the row and the console line", () => {
  const t = fixRungTerminationVerdict({
    outcome: "parked",
    reason: "blocked on #2411 — the remedy is out of this diff",
    blockedOnPr: 2411,
  });
  assert.equal(t.reason, "blocked on #2411 — the remedy is out of this diff", "the rung's own reason, verbatim");
  assert.deepEqual(t.extra, { blocked_on_pr: 2411 }, "the prerequisite rides on the ledger row as a FIELD");
  assert.equal(t.phrase, "parked on prerequisite #2411");
});

test("W1-T1095: a stood-down termination is byte-identical to what it emitted before the fold", () => {
  const t = fixRungTerminationVerdict({
    outcome: "stood_down",
    reason: "pr went terminal mid-rung",
    standDownReason: "the PR was merged while the rung was running",
  });
  // The pre-fold strings, asserted verbatim: this fold must not have moved the stood-down text.
  assert.equal(t.reason, "stood down — the PR was merged while the rung was running");
  assert.equal(t.phrase, "stood down (the PR was merged while the rung was running)");
  assert.deepEqual(t.extra, {}, "and it adds NO blocked_on_pr field — that is the parked arm's alone");
  // PAIRED POSITIVE CONTROL: the two arms genuinely differ, so neither assertion above is
  // satisfied by a helper that returns one shape for everything.
  const parked = fixRungTerminationVerdict({ outcome: "parked", reason: "r", blockedOnPr: 7 });
  assert.notEqual(parked.phrase, t.phrase);
  assert.notDeepEqual(parked.extra, t.extra);
});

// ── W1-T1095 capability 3 — REBASE ──────────────────────────────────────────────────────────
//
// The rung can now PARK on a prerequisite and RESUME when it merges (capability 1, above). But a
// resumed pull request still does not CONTAIN the merged prerequisite, so the next strike would
// re-run a fix worker against a checkout that lacks the very remedy the review named. These
// tests drive the decision and its thin I/O wrapper directly; no gateway is reached — the
// `updateBranch`/`readMergeFacts` seams are fakes on every path, and the one test that calls the
// real write asserts the live-write guard REFUSES it.

/** The facts a rebase-worthy resumed PR presents — every test below mutates exactly one field,
 *  so each assertion discriminates on that field alone rather than on a lucky default. */
const REBASE_OK = {
  prerequisitePr: 2411,
  reviewPassed: false,
  mergeable: "MERGEABLE" as const,
  behindBy: 3,
  alreadyRebased: false,
};

test("W1-T1095: a resumed pull request behind its base is rebased, and the reason names the field that justified it", () => {
  const d = decideFixRebase(REBASE_OK);
  assert.equal(d.rebase, true);
  assert.match(d.reason, /prerequisite #2411 merged/);
  assert.match(d.reason, /3 commit\(s\) behind its base/, "the reason names behind_by, not a bare 'behind main'");
});

test("W1-T1095: a rebase never fires on a pull request whose review already passed", () => {
  const d = decideFixRebase({ ...REBASE_OK, reviewPassed: true });
  assert.equal(d.rebase, false, "a new head would discard the posted verdict");
  assert.match(d.reason, /review already passed/);
  assert.match(d.reason, /review-orphan slot/, "and it says what the new head would cost");
  // DISCRIMINATION: the only difference from the rebasing case above is this one field.
  assert.equal(decideFixRebase({ ...REBASE_OK, reviewPassed: false }).rebase, true);
});

test("W1-T1095: a rebase fires at most once per pull request", () => {
  const d = decideFixRebase({ ...REBASE_OK, alreadyRebased: true });
  assert.equal(d.rebase, false);
  assert.match(d.reason, /already rebased once/);
  assert.match(d.reason, /the bound is one rebase-and-retry/);
});

test("W1-T1095: the rebase refuses a conflicted head and leaves the conflict path to the sweep", () => {
  const d = decideFixRebase({ ...REBASE_OK, mergeable: "CONFLICTING" });
  assert.equal(d.rebase, false);
  assert.match(d.reason, /conflicts with its base/);
  assert.match(d.reason, /belongs to the sweep/);
});

test("W1-T1095: the rebase refuses an unreadable merge state rather than acting on it", () => {
  for (const mergeable of ["UNKNOWN" as const, undefined]) {
    const d = decideFixRebase({ ...REBASE_OK, mergeable });
    assert.equal(d.rebase, false, `mergeable=${String(mergeable)} must not rebase`);
    assert.match(d.reason, /not a definite MERGEABLE/);
  }
  assert.match(decideFixRebase({ ...REBASE_OK, mergeable: undefined }).reason, /unreadable/);
});

test("W1-T1095: the rebase refuses an unreadable comparison, and refuses a head already level with its base", () => {
  const unreadable = decideFixRebase({ ...REBASE_OK, behindBy: undefined });
  assert.equal(unreadable.rebase, false);
  assert.match(unreadable.reason, /cannot read how far behind/);

  for (const behindBy of [0, -1]) {
    const level = decideFixRebase({ ...REBASE_OK, behindBy });
    assert.equal(level.rebase, false, `behindBy=${behindBy} has nothing to take`);
    assert.match(level.reason, /already contains its base/);
  }
});

test("W1-T1095: the update-branch call is a pure API argv needing no branch and no checkout", () => {
  const argv = ghUpdateBranchArgv("craigoley", "remudero", 2411);
  assert.deepEqual(argv, ["api", "--method", "PUT", "repos/craigoley/remudero/pulls/2411/update-branch"]);
  // FALSIFIER: nothing in the argv names a branch, a worktree, or a local git verb — the daemon
  // is detached on every boot, which is what broke armAuto's --delete-branch (W1-T1111).
  for (const forbidden of ["checkout", "worktree", "rebase", "branch", "-C"]) {
    assert.ok(!argv.includes(forbidden), `argv must not carry ${forbidden}`);
  }
});

test("W1-T1095: the one-rebase bound is folded from the ledger, per pull request", () => {
  const lines = [
    { step: "fix.rebased", pr_number: 2411 },
    { step: "fix.rebase_refused", pr_number: 2434 },
    { step: "fix.dispatch", pr_number: 2434 },
  ];
  assert.equal(fixRebaseAlreadySpent(lines, 2411), true);
  assert.equal(fixRebaseAlreadySpent(lines, 2434), false, "a refusal is not a spent rebase");
  assert.equal(fixRebaseAlreadySpent([], 2411), false);
});

test("W1-T1095: GitHub's REST payloads map onto the facts, resolving toward refusal on anything undecided", () => {
  assert.deepEqual(mergeFactsFromRest({ mergeable: true }, { behind_by: 4 }), {
    mergeable: "MERGEABLE",
    behindBy: 4,
  });
  assert.equal(mergeFactsFromRest({ mergeable: false }, {}).mergeable, "CONFLICTING");
  assert.equal(mergeFactsFromRest({ mergeable_state: "dirty" }, {}).mergeable, "CONFLICTING");
  assert.equal(mergeFactsFromRest({ mergeable: null }, {}).mergeable, "UNKNOWN", "a null GitHub has not computed is never MERGEABLE");
  assert.equal(mergeFactsFromRest(undefined, undefined).mergeable, "UNKNOWN");
  assert.equal(mergeFactsFromRest({ mergeable: true }, { behind_by: "3" }).behindBy, undefined, "a non-number behind_by is unreadable, not zero");
});

test("W1-T1095: the REST reader composes two reads and fails soft to an empty reading", () => {
  const seen: string[][] = [];
  const facts = fixRebaseMergeFactsFromRest("o", "r", 7, (args) => {
    seen.push(args);
    return args[1].includes("/compare/")
      ? { behind_by: 2 }
      : { mergeable: true, base: { ref: "main" }, head: { sha: "abc123" } };
  });
  assert.deepEqual(facts, { mergeable: "MERGEABLE", behindBy: 2 });
  assert.deepEqual(seen[0], ["api", "repos/o/r/pulls/7"]);
  assert.deepEqual(seen[1], ["api", "repos/o/r/compare/main...abc123"]);

  // A THROWING gateway yields NOTHING, which decideFixRebase then refuses on.
  const soft = fixRebaseMergeFactsFromRest("o", "r", 7, () => {
    throw new Error("rate limited");
  });
  assert.deepEqual(soft, {});
  assert.equal(decideFixRebase({ ...REBASE_OK, mergeable: undefined, behindBy: undefined }).rebase, false);

  // A payload with no base/head skips the compare entirely rather than building a broken ref.
  const noCompare: string[][] = [];
  const partial = fixRebaseMergeFactsFromRest("o", "r", 7, (args) => {
    noCompare.push(args);
    return { mergeable: true };
  });
  assert.equal(noCompare.length, 1, "no second read when the first payload names no base/head");
  assert.equal(partial.behindBy, undefined);
});

test("W1-T1095: every rebase outcome writes a row naming its reason, including every refusal", async () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const io = (over: Partial<Parameters<typeof runFixRebase>[1]> = {}) => ({
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
    say: () => {},
    ledgerLines: () => [] as Array<Record<string, unknown>>,
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 2 }),
    updateBranch: () => ({ ok: true }),
    ...over,
  });
  const args = { prUrl: "https://github.com/o/r/pull/7", prerequisitePr: 2411, reviewPassed: false, strikes: 1 };

  // 1. the happy path
  const ok = await runFixRebase(args, io());
  assert.equal(ok.rebased, true);
  assert.equal(rows.at(-1)?.step, "fix.rebased");
  assert.equal(rows.at(-1)?.extra?.behind_by, 2, "the row carries the field that justified it");

  // 2. the write failed
  rows.length = 0;
  const failed = await runFixRebase(args, io({ updateBranch: () => ({ ok: false, error: "422 not mergeable" }) }));
  assert.equal(failed.rebased, false);
  assert.equal(rows.at(-1)?.step, "fix.rebase_failed");
  assert.match(String(rows.at(-1)?.extra?.reason), /422 not mergeable/);

  // 3. the decision refused
  rows.length = 0;
  const refused = await runFixRebase(args, io({ readMergeFacts: () => ({ mergeable: "CONFLICTING" }) }));
  assert.equal(refused.rebased, false);
  assert.equal(rows.at(-1)?.step, "fix.rebase_refused");
  assert.match(String(rows.at(-1)?.extra?.reason), /conflicts with its base/);

  // 4. no write dep wired — refused, never silently skipped
  rows.length = 0;
  const unwired = await runFixRebase(args, io({ updateBranch: undefined }));
  assert.equal(unwired.rebased, false);
  assert.equal(rows.at(-1)?.step, "fix.rebase_refused");
  assert.match(String(rows.at(-1)?.extra?.reason), /no update-branch dep wired/);

  // 5. an unparseable url — still a row, still a reason
  rows.length = 0;
  const badUrl = await runFixRebase({ ...args, prUrl: "not-a-url" }, io());
  assert.equal(badUrl.rebased, false);
  assert.equal(rows.at(-1)?.step, "fix.rebase_refused");
  assert.match(String(rows.at(-1)?.extra?.reason), /does not parse/);

  // 6. no read dep wired — the merge state is unreadable, so it refuses
  rows.length = 0;
  const noRead = await runFixRebase(args, io({ readMergeFacts: undefined }));
  assert.equal(noRead.rebased, false);
  assert.match(String(rows.at(-1)?.extra?.reason), /not a definite MERGEABLE/);

  // 7. the bound, read through the real fold rather than a flag
  rows.length = 0;
  const bounded = await runFixRebase(args, io({ ledgerLines: () => [{ step: "fix.rebased", pr_number: 7 }] }));
  assert.equal(bounded.rebased, false);
  assert.match(String(rows.at(-1)?.extra?.reason), /already rebased once/);

  // NO PATH RETURNED WITHOUT LEDGERING: every case above ended on a row.
  assert.ok(rows.length > 0);
});

test("W1-T1095: the real update-branch write sits behind the live-write guard", () => {
  // Under the node test runner the guard REFUSES before any subprocess is reached — the boundary
  // is named for this write, not borrowed from the merge or push boundary beside it.
  assert.throws(() => ghUpdateBranch("o", "r", 7), /gh-pr-update-branch/);

  // With the guard explicitly lifted, the injected exec receives exactly the pure-API argv, and a
  // throwing exec is reported rather than propagated.
  withLiveWritesAllowed(() => {
    const calls: Array<[string, string[]]> = [];
    const ok = ghUpdateBranch("o", "r", 7, ((cmd: string, argv: string[]) => {
      calls.push([cmd, argv]);
      return Buffer.from("");
    }) as never);
    assert.deepEqual(ok, { ok: true });
    assert.equal(calls[0][0], "gh");
    assert.deepEqual(calls[0][1], ghUpdateBranchArgv("o", "r", 7));

    const bad = ghUpdateBranch("o", "r", 7, (() => {
      throw new Error("boom");
    }) as never);
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /boom/);
  });
});

test("W1-T1095: a successful rebase ENDS the rung without spending a strike, because the head has moved", () => {
  const t = fixRungTerminationVerdict({
    outcome: "rebased",
    reason: "prerequisite #2411 merged and this head is 3 commit(s) behind its base",
    blockedOnPr: 2411,
  });
  assert.equal(t.phrase, "rebased onto its base (prerequisite #2411)");
  assert.deepEqual(t.extra, { blocked_on_pr: 2411 }, "the prerequisite rides on the row as a field");
  assert.match(t.reason, /3 commit\(s\) behind its base/);
  // DISCRIMINATION: rebased and parked are distinguishable terminations, not one shape twice.
  const parked = fixRungTerminationVerdict({ outcome: "parked", reason: "r", blockedOnPr: 2411 });
  assert.notEqual(parked.phrase, t.phrase);
  // ...and neither is the stood-down shape.
  const stood = fixRungTerminationVerdict({ outcome: "stood_down", reason: "r", standDownReason: "s" });
  assert.notEqual(stood.phrase, t.phrase);
  assert.notDeepEqual(stood.extra, t.extra);
});

test("W1-T1095: a resumed pull request behind its base rebases instead of spending the next strike", async () => {
  const blockedReview = fixRungReview("failure", [
    fixRungCriterion({ claim: "criterion A", met: false, reason: "blocked on #2363 — must land first" }),
  ]);
  const { lines, log } = fixRungTestLog();
  let spawnCalls = 0;
  let updated = 0;

  const outcome = await runFixRung({
    ...fixRungTestOpts(),
    strikeCap: 2,
    initialReview: blockedReview,
    deps: {
      spawn: async () => {
        spawnCalls++;
        return fixRungWorkerResult({ sessionId: "should-not-run" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => fixRungReview("success", []),
      push: () => {},
      issues: fixRungTestIssues(),
      ledgerPath: fixRungTestLedgerPath(),
      log,
      say: () => {},
      account: (r) => r,
      readPrerequisiteState: (): LiveStateResult => ({ ok: true, state: "MERGED" }),
      ledgerLines: () => [],
      readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 2 }),
      updateBranch: () => {
        updated++;
        return { ok: true };
      },
    },
  });

  assert.equal(outcome.outcome, "rebased", "the head moved, so the rung ended here");
  assert.equal(updated, 1, "update-branch was called exactly once");
  assert.equal(spawnCalls, 0, "NO strike was spent — a stale worktree would have pushed nothing");
  assert.equal(outcome.strikes, 0, "and the strike counter did not move");
  const rebased = lines.find((l) => l.step === "fix.rebased");
  assert.ok(rebased, `expected a fix.rebased row; got ${JSON.stringify(lines.map((l) => l.step))}`);
  assert.equal(rebased!.behind_by, 2);
  assert.ok(lines.some((l) => l.step === "fix.resumed"), "and it resumed before it rebased");

  // PAIRED CONTROL: the SAME rung with the head already level with its base refuses to rebase and
  // proceeds to a real strike — so the assertions above discriminate on `behindBy`, not on the
  // deps merely being wired.
  const { lines: lines2, log: log2 } = fixRungTestLog();
  let spawn2 = 0;
  let updated2 = 0;
  const level = await runFixRung({
    ...fixRungTestOpts(),
    strikeCap: 2,
    initialReview: blockedReview,
    deps: {
      spawn: async () => {
        spawn2++;
        return fixRungWorkerResult({ sessionId: "fix-session-resumed" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => fixRungReview("success", []),
      push: () => {},
      issues: fixRungTestIssues(),
      ledgerPath: fixRungTestLedgerPath(),
      log: log2,
      say: () => {},
      account: (r) => r,
      readPrerequisiteState: (): LiveStateResult => ({ ok: true, state: "MERGED" }),
      ledgerLines: () => [],
      readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 0 }),
      updateBranch: () => {
        updated2++;
        return { ok: true };
      },
    },
  });
  assert.equal(level.outcome, "fixed", "nothing to take, so the ordinary strike ran");
  assert.equal(updated2, 0, "and update-branch was never called");
  assert.equal(spawn2, 1);
  assert.ok(lines2.some((l) => l.step === "fix.rebase_refused"), "the refusal is still ledgered");
});
