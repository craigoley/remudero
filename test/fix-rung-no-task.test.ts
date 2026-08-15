/**
 * test/fix-rung-no-task.test.ts — impl-FY.
 *
 * THE DEFECT. `dispatchFix` looked its PR's task up in the plan and RETURNED when it found none,
 * logging `sweep.fix.no_task`. An agent-authored PR has a descriptive branch and no
 * `Remudero-Task:` trailer, so it matches no plan task — and the rung that exists to repair a
 * CI-failing PR could not act on it. Measured over the unioned ledger: 79 deduped rows across 65
 * distinct PRs, including #1115/#1116/#1117/#1118/#1120/#1127/#1132, the last of which was
 * dispositioned `blocked-fixable, acted=false` — the sweep classifying a fixable PR and then doing
 * nothing, every poll, silently.
 *
 * NO GATEWAY IS REACHED HERE. Every test below drives PURE functions or the pure disposition
 * classifier. Nothing in this file constructs a gh gateway, and the suite is proven gateway-free by
 * the sabotage check in the report (a `gh` on PATH that exits non-zero on every invocation).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveDisposition, DEFAULT_SWEEP_POLICY, type OpenPrView } from "../src/lib/sweep.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { escalationTaskIdFor, fixHeadAcceptable, fixRungTaskFor, priorStrikesFor } from "../src/run-task.js";

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
