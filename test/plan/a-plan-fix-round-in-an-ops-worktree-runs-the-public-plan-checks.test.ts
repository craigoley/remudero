/**
 * W1-T14453: a plan-scoped fix round preflights an ops plan pull request from a separate linked worktree of the
 * plan-destination checkout (runPlanScopedConflictRound calls planPrPreflightAtCommitAsync with no codeRoot). The
 * code root that worktree takes is the public one, exactly as the checkout itself takes, so the plan lint runs
 * instead of reading "scripts/lint-plan-precheck.mjs is absent from the tree" in the ops tree.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { planPrPreflight, planPrPreflightAsync, planPrPreflightAtCommit, planPrPreflightAtCommitAsync, type PlanPrPreflightChecks, type PlanPrPreflightAsyncChecks, type PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { gitRepo, originWithClone } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

function put(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
const BODY = "Acceptance:\n- fixture proof | grep: fixture in src/lib/held.ts\n";
const TITLE = "chore(plan): reconcile credited task statuses";
const GREEN = () => ({ status: 0, output: "fixture check passed" });
const otherChecks = { taskIdExistence: GREEN, shardCensus: GREEN, checkProof: () => 0 };
const ABSENT = /scripts\/lint-plan-precheck\.mjs is absent from the tree/;
function asAsyncChecks(checks: PlanPrPreflightChecks): PlanPrPreflightAsyncChecks {
  const { lintPlan, taskIdExistence, shardCensus, checkProof, ...common } = checks;
  return { ...common,
    ...(lintPlan ? { lintPlan: async (...args: Parameters<NonNullable<PlanPrPreflightChecks["lintPlan"]>>) => lintPlan(...args) } : {}),
    ...(taskIdExistence ? { taskIdExistence: async (...args: Parameters<NonNullable<PlanPrPreflightChecks["taskIdExistence"]>>) => taskIdExistence(...args) } : {}),
    ...(shardCensus ? { shardCensus: async (...args: Parameters<NonNullable<PlanPrPreflightChecks["shardCensus"]>>) => shardCensus(...args) } : {}),
    ...(checkProof ? { checkProof: async (...args: Parameters<NonNullable<PlanPrPreflightChecks["checkProof"]>>) => checkProof(...args) } : {}),
  };
}

/** A public code checkout carrying the lint script, and the ops plan destination checked out where the host
 *  resolver names it (`<state>/../repos/<repo>`), with a fix round's linked worktree beside it. */
function fixture(t: TestContext, codeKind = "fix-round-code") {
  const root = ownedFixtureDir(t, "fix-round-preflight").dir;
  const code = gitRepo({ scope: t, kind: codeKind });
  const trace = join(root, "lint-argv.ndjson");
  const program = `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(trace)},JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+String.fromCharCode(10));`;
  put(join(code.dir, "scripts/fixture-lint.mjs"), program);
  put(join(code.dir, "scripts/lint-plan-precheck.mjs"), program);
  put(join(code.dir, "package.json"), JSON.stringify({ scripts: { "lint-plan:fast": "node scripts/fixture-lint.mjs --base origin/main" } }));
  put(join(code.dir, "src/lib/held.ts"), "export const fixture = true;\n");
  put(join(code.dir, "plan/tasks.yaml"), "[]\n");
  code.git("add", "--all"); code.git("commit", "-qm", "code fixture");
  const state = join(root, "state");
  put(join(state, "plan-destination.json"), JSON.stringify({ repository: "fixture-owner/fixture-ops", kinds: ["task"] }));
  const { clone: checkout } = originWithClone(join(root, "repos", "fixture-ops"), { scope: t, seed: { "plan/tasks.yaml": "[]\n" } });
  const round = checkout.addWorktree(join(root, "rounds", "plan-round"), "plan-round-fixture", "origin/main");
  put(join(round.dir, "plan/tasks.yaml"), "- id: W1-T900\n  status: merged\n");
  round.git("add", "plan/tasks.yaml"); round.git("commit", "-qm", "chore(plan): fixture round");
  const head = round.git("rev-parse", "HEAD");
  const checks: PlanPrPreflightChecks = { ...otherChecks, destinationStateDir: () => state, publicCodeRoot: () => code.dir };
  return { root, code, state, checkout, round, head, trace, checks };
}
function traced(path: string): Array<{ cwd: string; args: string[] }> {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
}
const codeRootArg = (call: { args: string[] }): string | undefined =>
  call.args.includes("--code-root") ? call.args[call.args.indexOf("--code-root") + 1] : undefined;
function assertRanFromPublicCode(result: PlanPrPreflightResult): void {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.doesNotMatch(JSON.stringify(result), ABSENT);
  assert.deepEqual(result.unreadable, []);
}

test("W1-T14453 criterion 1: a fix round's linked worktree of the destination checkout takes the public code root", async t => {
  const f = fixture(t);
  assert.notEqual(realpathSync(f.round.dir), realpathSync(f.checkout.dir));
  assert.equal(realpathSync(f.round.git("rev-parse", "--path-format=absolute", "--git-common-dir")),
    realpathSync(f.checkout.git("rev-parse", "--path-format=absolute", "--git-common-dir")));
  assert.equal(existsSync(join(f.round.dir, "scripts/lint-plan-precheck.mjs")), false, "the ops tree carries no public scripts");
  const pr = { title: TITLE, body: BODY };
  const results = [
    await planPrPreflightAtCommitAsync(f.round.dir, f.head, pr, asAsyncChecks(f.checks)), // the plan-scoped fix round's own call
    planPrPreflightAtCommit(f.round.dir, f.head, pr, f.checks),
    planPrPreflight({ cwd: f.round.dir, ...pr }, f.checks),
    await planPrPreflightAsync({ cwd: f.round.dir, ...pr }, asAsyncChecks(f.checks)),
  ];
  for (const result of results) assertRanFromPublicCode(result);
  const calls = traced(f.trace);
  assert.equal(calls.length, 4, JSON.stringify(calls));
  for (const call of calls) assert.equal(codeRootArg(call), realpathSync(f.code.dir));
});

test("W1-T14453 criterion 2: a cwd that is neither the destination checkout nor one of its worktrees keeps no code root", async t => {
  const f = fixture(t);
  const unrelated = gitRepo({ scope: t, kind: "fix-round-unrelated" });
  const unrelatedWorktree = unrelated.addWorktree(join(f.root, "unrelated-worktree"), "unrelated-fixture");
  const separateClone = gitRepo({ scope: t, kind: "fix-round-separate-clone", cloneFrom: f.checkout.dir });
  const plainDir = join(f.root, "plain-dir"); mkdirSync(plainDir);
  for (const cwd of [unrelated.dir, unrelatedWorktree.dir, separateClone.dir, plainDir]) {
    const sync = planPrPreflight({ cwd, title: TITLE, body: BODY }, f.checks);
    const async = await planPrPreflightAsync({ cwd, title: TITLE, body: BODY }, asAsyncChecks(f.checks));
    for (const result of [sync, async]) {
      assert.equal(result.ok, true, JSON.stringify(result));
      const lint = result.unreadable.find(finding => finding.check === "lint-plan");
      assert.ok(lint, `${cwd}: ${JSON.stringify(result)}`);
      assert.match(lint.firstLine, ABSENT);
    }
  }
  assert.deepEqual(traced(f.trace), [], "no cwd outside the destination repository ran the public lint");
});

test("W1-T14453 criterion 2: an unreadable common dir is the existing public-code-root-unreadable reason", async t => {
  const f = fixture(t);
  const admin = realpathSync(f.round.git("rev-parse", "--path-format=absolute", "--git-dir"));
  assert.ok(admin.startsWith(realpathSync(join(f.checkout.dir, ".git", "worktrees"))), admin);
  rmSync(admin, { recursive: true, force: true }); // the round's .git pointer now names no gitdir
  const results = [
    planPrPreflight({ cwd: f.round.dir, title: TITLE, body: BODY }, f.checks),
    await planPrPreflightAsync({ cwd: f.round.dir, title: TITLE, body: BODY }, asAsyncChecks(f.checks)),
    await planPrPreflightAtCommitAsync(f.round.dir, f.head, { title: TITLE, body: BODY }, asAsyncChecks(f.checks)),
  ];
  for (const result of results) {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.unreadable.length, 1, JSON.stringify(result));
    assert.match(result.unreadable[0]!.firstLine, /\(public-code-root-unreadable\)$/);
    assert.equal(JSON.stringify(result).includes(f.root), false, "the reason names no host path");
  }
  assert.deepEqual(traced(f.trace), []);
});

test("W1-T14453 criterion 3: an explicit codeRoot and the destination checkout itself resolve as before", async t => {
  const f = fixture(t);
  const explicit = gitRepo({ scope: t, kind: "fix-round-explicit-code" });
  for (const path of ["scripts/fixture-lint.mjs", "scripts/lint-plan-precheck.mjs", "package.json", "src/lib/held.ts", "plan/tasks.yaml"]) {
    put(join(explicit.dir, path), readFileSync(join(f.code.dir, path), "utf8"));
  }
  explicit.git("add", "--all"); explicit.git("commit", "-qm", "explicit code fixture");
  const pr = { title: TITLE, body: BODY };
  const explicitResults = [
    planPrPreflight({ cwd: f.round.dir, ...pr, codeRoot: explicit.dir }, f.checks),
    await planPrPreflightAsync({ cwd: f.round.dir, ...pr, codeRoot: explicit.dir }, asAsyncChecks(f.checks)),
    await planPrPreflightAtCommitAsync(f.round.dir, f.head, { ...pr, codeRoot: explicit.dir }, asAsyncChecks(f.checks)),
  ];
  for (const result of explicitResults) assertRanFromPublicCode(result);
  const explicitCalls = traced(f.trace);
  assert.equal(explicitCalls.length, 3, JSON.stringify(explicitCalls));
  for (const call of explicitCalls) assert.equal(codeRootArg(call), realpathSync(explicit.dir));
  rmSync(f.trace, { force: true });
  const checkoutResults = [
    planPrPreflight({ cwd: f.checkout.dir, ...pr }, f.checks),
    await planPrPreflightAsync({ cwd: f.checkout.dir, ...pr }, asAsyncChecks(f.checks)),
  ];
  for (const result of checkoutResults) assertRanFromPublicCode(result);
  const checkoutCalls = traced(f.trace);
  assert.equal(checkoutCalls.length, 2, JSON.stringify(checkoutCalls));
  for (const call of checkoutCalls) assert.equal(codeRootArg(call), realpathSync(f.code.dir));
});
