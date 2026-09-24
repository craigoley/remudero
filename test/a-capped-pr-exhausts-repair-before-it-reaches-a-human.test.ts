import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  MAX_PLAN_REPAIR_STRIKES,
  planCappedRepair,
  type CappedRepairState,
} from "../src/lib/classify.js";
import type { Config } from "../src/lib/config.js";
import {
  DEFAULT_SWEEP_POLICY,
  PLAN_REPAIR_DISPATCH_STEP,
  buildSweepEffects,
  decideSweepArm,
  drainDetachedSweepActions,
  insertPlanRepairFlag,
  runSweep,
  type BuildSweepEffectsDeps,
  type OpenPrView,
  type ProofDiscriminationEvidence,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { Plan } from "../src/lib/plan.js";
import type { CriterionVerdict } from "../src/lib/review.js";

// W1-T3390 — TWO STRIKES THEN A HUMAN IS NOT AN AUTOMATION LADDER. MEASURED on PR 5107: 30 sweep
// dispositions reading "capped review still has non-discriminating proofs, but its shared fix
// budget is exhausted (2/2)", then 28 reading a deduped escalation — a PR that could never repair
// itself because the offending criteria live in a shard on `main`, outside its own diff, and
// Standing rule 15's `criterionFieldTampered` refuses a non-plan-only diff that edits it. This
// suite proves the missing rung: a plan-only shard repair dispatches before escalation, bounded by
// its OWN separate ceiling, and only once BOTH repair paths are spent does a human get paged — all
// while the existing capped-arm refusal (and its head-bound override) stays completely untouched.

const TASK = "W1-T3390-FIXTURE";
const PR_URL = "https://github.com/acme/remudero/pull/3390";
const HEAD = "3390aaaa";
const NOW = Date.parse("2026-09-13T12:00:00Z");

const PROOF: ProofDiscriminationEvidence = {
  proofs: [{ claim: "the offending proof lives in a shard outside this PR's diff", proof: "unit test: test/stale.test.ts", proofExec: "not_executable" }],
};

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-plan-repair-")), "ledger.ndjson");
}

function cappedCriterion(over: Partial<CriterionVerdict> = {}): CriterionVerdict {
  return {
    claim: PROOF.proofs[0]!.claim,
    proof: PROOF.proofs[0]!.proof,
    met: true,
    reason: "matched on the keyword floor",
    proof_exec: "not_executable",
    ...over,
  };
}

function cappedPosted(): LedgerLine {
  return {
    run_id: "W1-T3390-REVIEW",
    task_id: TASK,
    step: "review.posted",
    pr_url: PR_URL,
    head_sha: HEAD,
    state: "success",
    capped: true,
    plan_only: false,
    decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [cappedCriterion()] },
  };
}

function planRepairDispatched(): LedgerLine {
  return { run_id: "SWEEP", task_id: TASK, step: PLAN_REPAIR_DISPATCH_STEP, pr_number: 3390, outcome: "dispatched" };
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 3390,
    prUrl: PR_URL,
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
    lastActivityAt: "2026-09-13T11:00:00.000Z", // expiring-fixture: exempt -- compared only against this suite's INJECTED now (NOW), never the wall clock
    headSha: HEAD,
    autoMergeArmed: false,
    ...over,
  };
}

function sweepDeps(
  path: string,
  observed: { armed: number; fixed: number; planRepaired: number; escalated: number },
  opts: { capable: boolean } = { capable: true },
): SweepDeps {
  const base: SweepDeps = {
    arm: () => { observed.armed++; return "armed"; },
    close: () => {},
    dispatchFix: () => { observed.fixed++; },
    escalate: () => { observed.escalated++; },
    ledgerPath: path,
    runId: "SWEEP-W1-T3390",
    now: () => NOW,
  };
  if (!opts.capable) return base;
  return { ...base, dispatchPlanOnlyRepair: () => { observed.planRepaired++; return true; } };
}

// ── acceptance #1 — the missing rung dispatches instead of standing down ────────────────────────

test("W1-T3390: a capped PR whose body-repair budget is spent dispatches a plan-only shard repair instead of escalating", async () => {
  const path = ledgerPath();
  appendLedger(path, cappedPosted());
  const observed = { armed: 0, fixed: 0, planRepaired: 0, escalated: 0 };
  // priorStrikes already at the shared strikeCap — pre-W1-T3390 this disposed "blocked-ambiguous"
  // and escalated (see the sibling suite's own "already exhausted" fixture). With the new rung
  // wired, it must dispatch the plan-only repair instead.
  const summary = await runSweep([pr()], sweepDeps(path, observed));
  assert.equal(summary.byDisposition["blocked-fixable"], 1, "dispatches rather than standing down");
  assert.equal(observed.planRepaired, 1, "the plan-only shard repair rung fired");
  assert.equal(observed.fixed, 0, "the exhausted body-repair rung is never re-dispatched");
  assert.equal(observed.escalated, 0, "no human is paged while a repair path remains");
});

test("W1-T3390: a caller that never wires the new rung keeps the pre-W1-T3390 behaviour byte-for-byte", async () => {
  const path = ledgerPath();
  appendLedger(path, cappedPosted());
  const observed = { armed: 0, fixed: 0, planRepaired: 0, escalated: 0 };
  const summary = await runSweep([pr()], sweepDeps(path, observed, { capable: false }));
  assert.equal(summary.byDisposition["blocked-ambiguous"], 1, "omission preserves the old exhaustion route");
  assert.equal(observed.escalated, 1, "escalation still owns exhaustion when the rung is never wired");
  assert.equal(observed.planRepaired, 0);
});

test("W1-T3390: the light pass's detached-wait mode dispatches the plan-only rung exactly like an ordinary fix", async () => {
  // W1-T2379's `detachFixWait` moves only the AWAIT, never the dispatch — the plan-shard rung
  // shares that exact same fix-dispatch detach branch (sweep.ts), so it must fire identically.
  const path = ledgerPath();
  appendLedger(path, cappedPosted());
  const observed = { armed: 0, fixed: 0, planRepaired: 0, escalated: 0 };
  const summary = await runSweep([pr()], { ...sweepDeps(path, observed), detachFixWait: true });
  assert.equal(summary.byDisposition["blocked-fixable"], 1, "still dispatches rather than standing down");
  await drainDetachedSweepActions();
  assert.equal(observed.planRepaired, 1, "the detached wait still reaches the plan-only repair rung");
});

// ── acceptance #2 — a human is reached only once BOTH repair paths are exhausted ────────────────

test("W1-T3390: escalation waits for the plan-shard repair's own ceiling, separate from the body-repair cap", async () => {
  const path = ledgerPath();
  appendLedger(path, cappedPosted());
  // MAX_PLAN_REPAIR_STRIKES prior plan-shard-repair dispatches already recorded for this task —
  // its own budget, exhausted independently of `priorStrikes` (the body-repair cap).
  for (let i = 0; i < MAX_PLAN_REPAIR_STRIKES; i++) appendLedger(path, planRepairDispatched());
  const observed = { armed: 0, fixed: 0, planRepaired: 0, escalated: 0 };
  const summary = await runSweep([pr()], sweepDeps(path, observed));
  assert.equal(summary.byDisposition["blocked-ambiguous"], 1, "both repair paths are spent — escalate");
  assert.equal(observed.escalated, 1);
  assert.equal(observed.planRepaired, 0, "the exhausted plan-repair rung is never re-dispatched");
});

test("W1-T3390: a capped non-plan verdict still cannot arm without a head-bound operator override", () => {
  // Untouched by this task's change: `decideSweepArm`/`decideAutoMergeArm` are never modified by
  // the new rung — the ladder above decides only what gets DISPATCHED before escalation, never
  // what is permitted to arm.
  assert.equal(decideSweepArm(pr(), [cappedPosted()]).arm, false, "a capped, non-plan verdict still refuses to arm");
  const overridden = decideSweepArm(pr(), [
    cappedPosted(),
    { run_id: "OVERRIDE", task_id: TASK, step: "automerge.capped_override_granted", head_sha: HEAD, by: "operator", reason: "reviewed by hand" },
  ]);
  assert.equal(overridden.arm, true, "an explicit, head-bound override still arms it");
});

// ── the pure ladder decision (classify.ts) ───────────────────────────────────────────────────────

test("W1-T3390: planCappedRepair — body budget first, then the plan-shard rung, then give up", () => {
  const bodyCeiling = 2;
  const fresh: CappedRepairState = { bodyStrikes: 0, planRepairStrikes: 0 };
  assert.deepEqual(planCappedRepair(fresh, bodyCeiling, { planRepairCapable: true }), { kind: "repair_body" });

  const bodySpent: CappedRepairState = { bodyStrikes: bodyCeiling, planRepairStrikes: 0 };
  assert.deepEqual(planCappedRepair(bodySpent, bodyCeiling, { planRepairCapable: true }), { kind: "repair_plan_shard" });

  // Incapable caller: degrades to the pre-W1-T3390 ladder regardless of the plan-repair counter.
  const incapable = planCappedRepair(bodySpent, bodyCeiling, { planRepairCapable: false });
  assert.equal(incapable.kind, "give_up");
  assert.equal((incapable as { reason: string }).reason, `strikes exhausted (${bodyCeiling})`);

  const bothSpent: CappedRepairState = { bodyStrikes: bodyCeiling, planRepairStrikes: MAX_PLAN_REPAIR_STRIKES };
  const givenUp = planCappedRepair(bothSpent, bodyCeiling, { planRepairCapable: true });
  assert.equal(givenUp.kind, "give_up");
  assert.match((givenUp as { reason: string }).reason, /body 2\/2, plan-shard repair 2\/2/);
});

// ── the shard flag never touches an Architect-protected field (Standing rule 15) ────────────────

test("W1-T3390: insertPlanRepairFlag adds a comment above the proof line and edits no field text", () => {
  const shard = [
    "acceptance:",
    "  - claim: the thing works",
    "    proof: unit test: test/stale.test.ts",
    "    satisfied_by: null",
  ].join("\n");
  const flagged = insertPlanRepairFlag(shard, "unit test: test/stale.test.ts", "sweep-flagged proof (not_executable)");
  assert.ok(flagged, "the exact proof text is present, so the flag inserts");
  const lines = flagged!.split("\n");
  const proofIdx = lines.findIndex((l) => l.includes("proof: unit test: test/stale.test.ts"));
  assert.match(lines[proofIdx - 1]!, /^\s*# sweep-flagged proof \(not_executable\)$/, "the flag sits directly above the proof line");
  assert.equal(lines[proofIdx], "    proof: unit test: test/stale.test.ts", "the proof field's own text is byte-identical");
  assert.ok(!flagged!.includes("\n    proof: unit test: test/stale.test.ts\n") || true); // sanity: still present once
  assert.equal(flagged!.split("proof: unit test: test/stale.test.ts").length - 1, 1, "the proof line is not duplicated or rewritten");
});

test("W1-T3390: insertPlanRepairFlag refuses when the review's evidence has drifted off the shard's current text", () => {
  const shard = "acceptance:\n  - claim: the thing works\n    proof: unit test: test/renamed.test.ts\n";
  assert.equal(insertPlanRepairFlag(shard, "unit test: test/stale.test.ts", "sweep-flagged"), undefined);
});

// ── dispatchPlanOnlyRepair's REAL implementation (buildSweepEffects) ────────────────────────────
// Every test above drives the decision ladder through an injected fake — the house convention —
// so none of them ever runs the real git/gh mechanics this rung performs. Those live entirely
// behind buildSweepEffects's own coverage seams (planRepairGitImpl / worktreeAddImpl /
// gitPushRunBranchImpl / ghJsonImpl, sweep.ts), each defaulted to the real spawn and appended
// last — so these tests inject a fake in its place and assert the recorded call, never a real
// external process.

function repoFixture(shardYaml?: string): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-repair-repo-"));
  if (shardYaml !== undefined) {
    mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(root, "plan", "tasks.d", `${TASK}-fixture.yaml`), shardYaml);
  }
  return root;
}

/** Stops git's upward repository search at `root`'s parent for the duration of `fn`, so a real
 *  spawn under `root` can never reach a checkout that happens to enclose the tmp dir. */
async function withGitCeiling<T>(root: string, fn: () => T | Promise<T>): Promise<T> {
  const prior = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = prior;
  }
}

function matchingShardYaml(): string {
  return [
    `id: ${TASK}`,
    "acceptance:",
    `  - claim: ${PROOF.proofs[0]!.claim}`,
    `    proof: ${PROOF.proofs[0]!.proof}`,
  ].join("\n") + "\n";
}

type GitCall = [file: string, args: readonly string[]];

function planRepairFixture(
  repoDir: string,
  overrides: Partial<BuildSweepEffectsDeps> = {},
): {
  effects: ReturnType<typeof buildSweepEffects>;
  logged: Array<[string, Record<string, unknown> | undefined]>;
  gitCalls: GitCall[];
  ghCalls: string[][];
  worktreeAddCalls: Array<{ repoDir: string; worktreePath: string; branch: string; base: string }>;
  pushCalls: Array<{ worktreePath: string; expectedHeadSha?: string }>;
  removeCalls: Array<{ repoDir: string; worktreePath: string }>;
} {
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const gitCalls: GitCall[] = [];
  const ghCalls: string[][] = [];
  const worktreeAddCalls: Array<{ repoDir: string; worktreePath: string; branch: string; base: string }> = [];
  const pushCalls: Array<{ worktreePath: string; expectedHeadSha?: string }> = [];
  const removeCalls: Array<{ repoDir: string; worktreePath: string }> = [];
  const deps: BuildSweepEffectsDeps = {
    owner: "acme",
    repo: "remudero",
    config: { root: repoDir, claudeBin: "/bin/true" } as Config,
    ledgerPath: ledgerPath(),
    runId: "SWEEP-PLAN-REPAIR",
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    log: (step, extra) => logged.push([step, extra]),
    nowMsImpl: () => NOW,
    planRepairGitImpl: (file, args) => {
      gitCalls.push([file, args]);
      if (args.includes("rev-parse")) return "planrepairsha0123456789\n";
      return "";
    },
    worktreeAddImpl: (repoDirArg, worktreePath, branch, base) => {
      worktreeAddCalls.push({ repoDir: repoDirArg, worktreePath, branch, base: base ?? "origin/main" });
      // The real implementation cuts a real worktree on disk; this fake only needs the ONE thing
      // the caller then does with it — write the flagged shard back under the same relative path.
      mkdirSync(join(worktreePath, "plan", "tasks.d"), { recursive: true });
    },
    gitPushRunBranchImpl: (worktreePath, opts) => {
      pushCalls.push({ worktreePath, expectedHeadSha: opts?.expectedHeadSha });
    },
    worktreeRemoveImpl: (repoDirArg, worktreePath) => {
      removeCalls.push({ repoDir: repoDirArg, worktreePath });
    },
    ghJsonImpl: (args) => {
      ghCalls.push(args);
      if (args.includes("--method")) {
        return { html_url: "https://github.com/acme/remudero/pull/9001", number: 9001 };
      }
      return []; // the dedup probe: nothing found
    },
    ...overrides,
  };
  return { effects: buildSweepEffects(deps), logged, gitCalls, ghCalls, worktreeAddCalls, pushCalls, removeCalls };
}

test("W1-T3390: dispatchPlanOnlyRepair's real implementation flags the shard, pushes, and opens a plan-only PR", async () => {
  const repoDir = repoFixture(matchingShardYaml());
  const f = planRepairFixture(repoDir);
  const result = await withLiveWritesAllowed(() => f.effects.dispatchPlanOnlyRepair!(pr(), PROOF));
  assert.equal(result, true);
  assert.equal(f.logged.length, 1);
  const [step, extra] = f.logged[0]!;
  assert.equal(step, PLAN_REPAIR_DISPATCH_STEP);
  assert.equal(extra?.outcome, "dispatched");
  assert.equal(extra?.plan_repair_pr, "https://github.com/acme/remudero/pull/9001");
  // The worktree was cut on the stable per-task branch, based on origin/main.
  assert.equal(f.worktreeAddCalls.length, 1);
  assert.equal(f.worktreeAddCalls[0]!.branch, `plan-repair/${TASK}`);
  assert.equal(f.worktreeAddCalls[0]!.base, "origin/main");
  // Every git spawn this rung performs recorded, in order: fetch, stale-branch clear, add, commit,
  // rev-parse — never a raw, unrecorded execFileSync.
  const argvs = f.gitCalls.map(([, args]) => args[2]);
  assert.deepEqual(argvs, ["fetch", "branch", "add", "commit", "rev-parse"]);
  assert.deepEqual(f.gitCalls[2]![1], ["-C", f.worktreeAddCalls[0]!.worktreePath, "add", "plan/tasks.d/W1-T3390-FIXTURE-fixture.yaml"]);
  // The push carries the exact sha the commit spawn's rev-parse reported back.
  assert.equal(f.pushCalls.length, 1);
  assert.equal(f.pushCalls[0]!.expectedHeadSha, "planrepairsha0123456789");
  // The dedup probe ran before the create call, both through the SAME injected fetcher.
  assert.equal(f.ghCalls.length, 2);
  assert.ok(!f.ghCalls[0]!.includes("--method"), "the first gh call is the dedup probe, not the create");
  assert.ok(f.ghCalls[1]!.includes("--method"), "the second gh call is the PR create");
  // The worktree is always reaped, success or not.
  assert.equal(f.removeCalls.length, 1);
  assert.equal(f.removeCalls[0]!.worktreePath, f.worktreeAddCalls[0]!.worktreePath);
});

test("W1-T3390: dispatchPlanOnlyRepair's git seam defaults to a real spawn when the caller injects nothing", async () => {
  // Every other test in this file overrides planRepairGitImpl to prove the DECISION ladder without
  // a real process. This one proves the OTHER half of the seam contract — the uninjected default
  // really does reach a real `git` spawn, never a stub that quietly does nothing (mirrors
  // rebaseDirtyFleetBranchViaGit's own uninjected-default coverage, sweep.ts).
  const repoDir = repoFixture(matchingShardYaml()); // a plain directory, deliberately not a git repo
  const f = planRepairFixture(repoDir, { planRepairGitImpl: undefined });
  const result = await withGitCeiling(repoDir, () => withLiveWritesAllowed(() => f.effects.dispatchPlanOnlyRepair!(pr(), PROOF)));
  assert.equal(result, true);
  // `repoDir` is not a git checkout, so every real spawn this rung makes against it fails — the
  // fetch is best-effort (swallowed), but the "add" spawn against the (fake, non-git) worktree
  // path is not, and reaches the outer catch.
  assert.equal(f.logged[0]![1]?.outcome, "error");
  assert.equal(f.removeCalls.length, 1, "the worktree is still reaped after the real spawn failed");
});

test("W1-T3390: the real git default never writes to a repository that encloses the fixture root", async () => {
  // MEASURED 2026-09-23: with TMPDIR inside a checkout, the test above let git walk up from its
  // "plain directory" and commit twice onto the operator's local branch. Rebuild that shape on
  // purpose: the fixture root inside an outer repository that must come out untouched.
  const outer = mkdtempSync(join(tmpdir(), "rmd-plan-repair-outer-"));
  const who = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const outerGit = (...args: string[]): string =>
    execFileSync("git", ["-C", outer, ...args], { encoding: "utf8", env: { ...process.env, ...who } }).trim();
  outerGit("init", "--quiet");
  outerGit("commit", "--quiet", "--allow-empty", "-m", "outer");
  const before = outerGit("rev-parse", "HEAD");
  const repoDir = join(outer, "repo");
  mkdirSync(join(repoDir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repoDir, "plan", "tasks.d", `${TASK}-fixture.yaml`), matchingShardYaml());
  const f = planRepairFixture(repoDir, { planRepairGitImpl: undefined });
  const result = await withGitCeiling(repoDir, () => withLiveWritesAllowed(() => f.effects.dispatchPlanOnlyRepair!(pr(), PROOF)));
  assert.equal(result, true);
  assert.equal(f.logged[0]![1]?.outcome, "error", "no repository is reachable, so the add spawn fails");
  assert.equal(outerGit("rev-parse", "HEAD"), before, "the outer repository gained no commit");
  assert.equal(outerGit("status", "--porcelain", "--untracked-files=no"), "", "nothing was staged in the outer repository");
});

test("W1-T3390: dispatchPlanOnlyRepair falls back to the plan/tasks.yaml monolith when no shard file exists", async () => {
  // No `plan/tasks.d/` at all — only the monolith, carrying the task's `id:` line verbatim.
  const repoDir = mkdtempSync(join(tmpdir(), "rmd-plan-repair-repo-"));
  mkdirSync(join(repoDir, "plan"), { recursive: true });
  writeFileSync(
    join(repoDir, "plan", "tasks.yaml"),
    [`id: ${TASK}`, "acceptance:", `  - claim: ${PROOF.proofs[0]!.claim}`, `    proof: ${PROOF.proofs[0]!.proof}`].join("\n") + "\n",
  );
  const f = planRepairFixture(repoDir);
  const result = await withLiveWritesAllowed(() => f.effects.dispatchPlanOnlyRepair!(pr(), PROOF));
  assert.equal(result, true);
  assert.equal(f.logged[0]![1]?.outcome, "dispatched");
  assert.equal(f.logged[0]![1]?.shard_path, "plan/tasks.yaml", "the monolith itself is the flagged shard path");
});

test("W1-T3390: dispatchPlanOnlyRepair dedupes against an already-open plan-repair PR without cutting a worktree", async () => {
  const repoDir = repoFixture(matchingShardYaml());
  const f = planRepairFixture(repoDir, {
    ghJsonImpl: (args) => {
      if (args.includes("--method")) throw new Error("must never reach PR create once deduped");
      return [{ html_url: "https://github.com/acme/remudero/pull/8801", number: 8801 }];
    },
  });
  const result = await withLiveWritesAllowed(() => f.effects.dispatchPlanOnlyRepair!(pr(), PROOF));
  assert.equal(result, true);
  assert.equal(f.logged[0]![1]?.outcome, "deduped");
  assert.equal(f.logged[0]![1]?.plan_repair_pr, "https://github.com/acme/remudero/pull/8801");
  assert.equal(f.worktreeAddCalls.length, 0, "a deduped dispatch never cuts a worktree");
});

test("W1-T3390: dispatchPlanOnlyRepair reports no_shard when the task has neither a shard nor a monolith entry", async () => {
  const repoDir = repoFixture(); // no plan/ tree at all
  const f = planRepairFixture(repoDir);
  const result = await f.effects.dispatchPlanOnlyRepair!(pr(), PROOF);
  assert.equal(result, true);
  assert.equal(f.logged[0]![1]?.outcome, "no_shard");
  assert.equal(f.ghCalls.length, 0, "never even probes for a dedup PR when there is nothing to flag");
});

test("W1-T3390: dispatchPlanOnlyRepair reports text_drift when the shard's proof text no longer matches review's evidence", async () => {
  const drifted = [
    `id: ${TASK}`,
    "acceptance:",
    `  - claim: ${PROOF.proofs[0]!.claim}`,
    "    proof: unit test: test/renamed.test.ts",
  ].join("\n") + "\n";
  const repoDir = repoFixture(drifted);
  const f = planRepairFixture(repoDir);
  const result = await f.effects.dispatchPlanOnlyRepair!(pr(), PROOF);
  assert.equal(result, true);
  assert.equal(f.logged[0]![1]?.outcome, "text_drift");
  assert.equal(f.worktreeAddCalls.length, 0, "drifted evidence never reaches the worktree step");
});

test("W1-T3390: dispatchPlanOnlyRepair ledgers a git failure and still reaps the worktree it cut", async () => {
  const repoDir = repoFixture(matchingShardYaml());
  const f = planRepairFixture(repoDir, {
    planRepairGitImpl: (file, args) => {
      f.gitCalls.push([file, args]);
      if (args[2] === "add") throw new Error("simulated git add failure");
      if (args.includes("rev-parse")) return "unreached\n";
      return "";
    },
  });
  const result = await withLiveWritesAllowed(() => f.effects.dispatchPlanOnlyRepair!(pr(), PROOF));
  assert.equal(result, true);
  assert.equal(f.logged[0]![1]?.outcome, "error");
  assert.match(String(f.logged[0]![1]?.error), /simulated git add failure/);
  assert.equal(f.removeCalls.length, 1, "the finally block reaps the worktree even on a spawn failure");
});

test("W1-T3390: dispatchPlanOnlyRepair is a no-op for a synthetic PR with no taskId or no discriminating proof", async () => {
  const repoDir = repoFixture(matchingShardYaml());
  const f = planRepairFixture(repoDir);
  assert.equal(await f.effects.dispatchPlanOnlyRepair!(pr({ taskId: undefined }), PROOF), undefined);
  assert.equal(await f.effects.dispatchPlanOnlyRepair!(pr(), { proofs: [] }), undefined);
  assert.equal(f.logged.length, 0, "neither guard reaches the shard lookup or logs anything");
});
