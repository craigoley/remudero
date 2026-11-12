import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { planPrPreflight, planPrPreflightAsync, planPrPreflightAtCommit, planPrPreflightAtCommitAsync } from "#src/lib/plan-pr-emitter.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function put(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
const BODY = "Acceptance:\n- fixture proof | grep: fixture in src/lib/held.ts\n";
const GREEN = () => ({ status: 0, output: "fixture check passed" });
const otherChecks = { taskIdExistence: GREEN, shardCensus: GREEN, checkProof: () => 0 };
function fixture(t: TestContext) {
  const root = ownedFixtureDir(t, "cross-catalog-preflight").dir;
  const code = gitRepo({ scope: t, kind: "preflight-code" });
  const plan = gitRepo({ scope: t, kind: "preflight-plan" });
  const trace = join(root, "lint-argv.ndjson");
  const program = `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(trace)},JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+String.fromCharCode(10));`;
  put(join(code.dir, "scripts/fixture-lint.mjs"), program);
  put(join(code.dir, "scripts/lint-plan-precheck.mjs"), program);
  put(join(code.dir, "package.json"), JSON.stringify({ scripts: { "lint-plan:fast": "node scripts/fixture-lint.mjs --base origin/main" } }));
  put(join(code.dir, "src/lib/held.ts"), "export const fixture = true;\n");
  put(join(code.dir, "plan/tasks.yaml"), "[]\n");
  code.git("add", "--all"); code.git("commit", "-qm", "code fixture");
  put(join(plan.dir, "plan/tasks.yaml"), "[]\n");
  plan.git("add", "--all"); plan.git("commit", "-qm", "plan fixture base");
  plan.git("update-ref", "refs/remotes/origin/main", "HEAD");
  plan.git("commit", "--allow-empty", "-qm", "plan fixture head");
  return { root, code, plan, trace };
}
function traced(path: string): Array<{cwd: string; args: string[]}> {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
}

test("W1-T12205 criterion 1: all four real preflight forms pass --code-root to the configured lint child", async t => {
  const f = fixture(t); const input = { cwd: f.plan.dir, title: "chore(plan): fixture", body: BODY, codeRoot: f.code.dir };
  const head = f.plan.git("rev-parse", "HEAD");
  const results = [planPrPreflight(input, otherChecks), await planPrPreflightAsync(input, otherChecks),
    planPrPreflightAtCommit(f.plan.dir, head, input, otherChecks), await planPrPreflightAtCommitAsync(f.plan.dir, head, input, otherChecks)];
  for (const result of results) { assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(result.unreadable, []); }
  const calls = traced(f.trace); assert.equal(calls.length, 4);
  for (const call of calls) { assert.equal(call.args[call.args.indexOf("--code-root") + 1], f.code.dir); assert.notEqual(call.cwd, f.code.dir); }
});

test("W1-T12205 criterion 2: sync and gardener-shaped async proof readers use the code checkout", async t => {
  const f = fixture(t); const seen: string[] = [];
  const checks = { lintPlan: GREEN, taskIdExistence: GREEN, shardCensus: GREEN,
    checkProof: (cwd: string) => { seen.push(cwd); return existsSync(join(cwd, "src/lib/held.ts")) ? 0 : 1; } };
  const input = { cwd: f.plan.dir, title: "chore(plan): fixture", body: BODY, codeRoot: f.code.dir };
  assert.equal(planPrPreflight(input, checks).ok, true);
  assert.equal((await planPrPreflightAsync(input, checks)).ok, true);
  assert.deepEqual(seen, [f.code.dir, f.code.dir]);
});

test("W1-T12205 criterion 2: the actual task-ID CLI resolves declarations in both catalogs without a second namespace", t => {
  const f = fixture(t); const origin = gitRepo({ bare: true, scope: t }); const opsOrigin = gitRepo({ bare: true, scope: t });
  f.code.addRemote("origin", origin.dir); f.plan.addRemote("origin", opsOrigin.dir);
  put(join(f.code.dir, "plan/tasks.yaml"), "- id: W1-T800\n");
  put(join(f.plan.dir, "plan/tasks.yaml"), "- id: W1-T801\n  depends_on: [W1-T800, W1-T802]\n");
  f.code.git("add", "--all"); f.code.git("commit", "-qm", "public declaration");
  f.plan.git("add", "--all"); f.plan.git("commit", "-qm", "private declaration");
  f.code.git("push", "--quiet", "origin", "HEAD:refs/rmd-id/W1-T802");
  assert.equal(opsOrigin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id/"), "");
  const baseline = join(f.root, "baseline.json"); put(baseline, "[]\n");
  const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/task-id-existence-check.mjs"), "--cwd", f.plan.dir,
    "--code-root", f.code.dir, "--dir", "plan", "--baseline", baseline], { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.error, undefined); assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /UNKNOWN|does not resolve/);
});

test("W1-T12205 criterion 4: no code root preserves the existing lint argv and proof cwd", async t => {
  const f = fixture(t); const program = readFileSync(join(f.code.dir, "scripts/lint-plan-precheck.mjs"), "utf8");
  put(join(f.plan.dir, "scripts/lint-plan-precheck.mjs"), program);
  const proofCwds: string[] = []; const checks = { ...otherChecks, checkProof: (cwd: string) => { proofCwds.push(cwd); return 0; } };
  const input = { cwd: f.plan.dir, title: "chore(plan): fixture", body: BODY };
  const a = planPrPreflight(input, checks), b = await planPrPreflightAsync(input, checks);
  assert.equal(a.ok, true); assert.equal(b.ok, true); assert.deepEqual(a.unreadable, []); assert.deepEqual(b.unreadable, []);
  assert.deepEqual(traced(f.trace).map(c => c.args), [[], []]); assert.deepEqual(proofCwds, [f.plan.dir, f.plan.dir]);
});

test("W1-T12205 criterion 5: async preflight derives its code root through the real host destination resolver", async t => {
  const f = fixture(t); const state = join(f.root, "state"); const selected = join(f.root, "repos", "fixture-ops");
  f.plan.addWorktree(selected, "selected-preflight-fixture");
  put(join(state, "plan-destination.json"), JSON.stringify({ repository: "fixture-owner/fixture-ops", kinds: ["task"] }));
  const checks = { ...otherChecks, destinationStateDir: () => state, publicCodeRoot: () => f.code.dir };
  const r = await planPrPreflightAsync({ cwd: selected, title: "chore(plan): fixture", body: BODY }, checks);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(r.unreadable, []);
  const calls = traced(f.trace); assert.equal(calls.length, 1); assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--code-root") + 1], f.code.dir);
});
