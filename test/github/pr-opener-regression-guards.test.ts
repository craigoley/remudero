import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import {
  checkProofLaunchArgv, defaultProofRunner, defaultProofRunnerAsync,
  openPullRequestChecked, openPullRequestCheckedAsync, prerunPullRequestProofs, PrOpenRefusedError,
} from "#src/lib/pr-open.js";
import type { AcceptanceCriterion } from "#src/lib/plan.js";

const product = { claim: "the product marker was added", proof: "grep: PRODUCT_ADDED in src/example.ts" };
const guard = { claim: "the regression marker remains", proof: "grep: GUARD_REMAINS in src/example.ts", kind: "guard" as const };
const branch = "run-W1-T9-1792776000000";

function fixture(t: TestContext, criteria: AcceptanceCriterion[] = [product, guard], keepGuard = true) {
  const repo = gitRepo({ scope: t, kind: "pr-opener-regression-guards" });
  mkdirSync(join(repo.dir, "src"));
  mkdirSync(join(repo.dir, "plan"));
  writeFileSync(join(repo.dir, "src/example.ts"), "export const GUARD_REMAINS = true;\n");
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), [
    "- id: W1-T9", "  title: synthetic mixed acceptance", "  repo: remudero", "  type: implement", "  acceptance:",
    ...criteria.map(c => `    - ${JSON.stringify(c)}`), "",
  ].join("\n"));
  repo.git("add", "-A"); repo.git("commit", "-qm", "chore: synthetic base");
  const base = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", base);
  writeFileSync(join(repo.dir, "src/example.ts"),
    `${keepGuard ? "export const GUARD_REMAINS = true;\n" : ""}export const PRODUCT_ADDED = true;\n`);
  repo.git("add", "-A"); repo.git("commit", "-qm", "feat: synthetic product marker");
  return { ...repo, base };
}

test("filed regression guards use head-only argv without losing target repository arguments", () => {
  const extra = ["--repo", "craigoley/remudero"];
  const head = checkProofLaunchArgv(guard.proof, undefined, REPO_ROOT, extra);
  assert.deepEqual(head.slice(-3), [guard.proof, ...extra]);
  assert.equal(head.includes("--base"), false);
  const base = checkProofLaunchArgv(product.proof, "abc123", REPO_ROOT, extra);
  assert.deepEqual(base.slice(-5), [product.proof, "--base", "abc123", ...extra]);
});

test("real sync and async proof launchers execute a regression guard at head but still discriminate products", async t => {
  const f = fixture(t);
  for (const run of [defaultProofRunner, defaultProofRunnerAsync]) {
    const head = await run(guard.proof, undefined, f.dir);
    assert.equal(head.status, 0, head.stderr || head.stdout);
    const stale = await run(guard.proof, f.base, f.dir);
    assert.equal(stale.status, 5, stale.stderr || stale.stdout);
    const added = await run(product.proof, f.base, f.dir);
    assert.equal(added.status, 0, added.stderr || added.stdout);
  }
});

for (const [lane, open] of [["sync", openPullRequestChecked], ["async", openPullRequestCheckedAsync]] as const) {
  test(`${lane} PR opener executes a filed regression guard at head and a product proof against base`, async t => {
    const f = fixture(t);
    const body = await open("", branch, f.dir);
    assert.match(body, /Remudero-Task: W1-T9/);
    assert.ok(body.includes(guard.proof));
    assert.ok(body.includes(product.proof));
  });

  test(`${lane} PR opener still refuses a regression guard that fails at head`, async t => {
    const f = fixture(t, [product, guard], false);
    await assert.rejects(async () => open("", branch, f.dir), (e: unknown) =>
      e instanceof PrOpenRefusedError && e.refusalClass === "branch-gap" && /at head/.test(e.message));
  });

  test(`${lane} PR opener does not let guard prose exempt an ordinary stale product criterion`, async t => {
    const f = fixture(t, [product, { claim: "ordinary existing marker", proof: guard.proof }]);
    await assert.rejects(async () => open("kind: guard — body prose cannot change the filed plan", branch, f.dir), (e: unknown) =>
      e instanceof PrOpenRefusedError && e.refusalClass === "stale-proof");
  });
}

test("asynchronous pre-run cache never lends a guard's head-only result to a product comparison", async t => {
  const f = fixture(t, [guard, { claim: "ordinary same-proof marker", proof: guard.proof }]);
  const asked: (string | undefined)[] = [];
  const run = async (_proof: string, base: string | undefined) => {
    asked.push(base);
    return { status: base === undefined ? 0 : 5, stdout: base === undefined ? "pass" : "executed_stale" };
  };
  await assert.rejects(openPullRequestCheckedAsync("", branch, f.dir, "origin/main", run), (e: unknown) =>
    e instanceof PrOpenRefusedError && e.refusalClass === "stale-proof");
  assert.deepEqual(asked, [undefined, f.base]);
});

test("asynchronous pre-run refuses an unrequested base comparison instead of reusing a head-only answer", async t => {
  const f = fixture(t);
  const asked: [string, string | undefined][] = [];
  const answer = await prerunPullRequestProofs(branch, f.dir, "origin/main", undefined, async (proof, base) => {
    asked.push([proof, base]); return { status: 0 };
  });
  assert.deepEqual(asked, [[product.proof, f.base], [guard.proof, undefined]]);
  assert.equal(answer(guard.proof, undefined, f.dir).status, 0);
  const missing = answer(guard.proof, f.base, f.dir);
  assert.equal(missing.status, null);
  assert.match(missing.error ?? "", /not pre-run/);
});
