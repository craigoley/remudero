import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import { defaultProofRunnerAsync, type OpenPullRequestProofResult } from "#src/lib/pr-open.js";
import { filedGrepProofMisses, withFiledGrepProofs, FILED_GREP_PROOF_STEP_NAME } from "#src/lib/preopen-filed-grep-proofs.js";
import { renderPreopenGatePrompt, type PreopenGateResult } from "#src/lib/preopen-gate.js";

const grepCriterion = (claim: string, proof: string): AcceptanceCriterion => ({ claim, proof }) as AcceptanceCriterion;
const pass: PreopenGateResult = { kind: "pass", durationMs: 5 };
const verdict = (status: number | null, extra: Partial<OpenPullRequestProofResult> = {}) => async (): Promise<OpenPullRequestProofResult> => ({ status, ...extra });

test("unit test: a filed grep proof that misses at head is a named failed step in the pre-open gate", async () => {
  const asked: Array<{ proof: string; base: string | undefined; cwd: string }> = [];
  const gate = withFiledGrepProofs(
    async () => pass,
    () => [grepCriterion("the label is written", "grep: Criterion 3 in docs/x.md")],
    async (proof, base, cwd) => { asked.push({ proof, base, cwd }); return { status: 3, stdout: "verdict:    no-match" }; },
  );
  const result = await gate("/the/worktree");
  assert.equal(result.kind, "fail", "a clean fast gate plus a missing proof text is a fail, so the repair round runs");
  assert.ok(result.kind === "fail");
  assert.equal(result.failedSteps.length, 1);
  assert.match(result.failedSteps[0], new RegExp(`^${FILED_GREP_PROOF_STEP_NAME}: .*grep: Criterion 3 in docs/x\\.md`));
  assert.match(result.failedSteps[0], /the label is written/);
  assert.deepEqual(asked, [{ proof: "grep: Criterion 3 in docs/x.md", base: undefined, cwd: "/the/worktree" }], "run at head only, in the worker's tree");
  // The repair round hands the worker exactly this step.
  assert.match(renderPreopenGatePrompt(result.failedSteps, true), /- filed-grep-proof: /);
});

test("unit test: a filed grep proof miss joins the fast gate's own failed steps", async () => {
  const gate = withFiledGrepProofs(
    async () => ({ kind: "fail", failedSteps: ["typecheck"], durationMs: 9, failedDetail: { typecheck: "TS2322" } }),
    () => [grepCriterion("c", "grep: absent in src/a.ts")],
    verdict(1),
  );
  const result = await gate("/w");
  assert.ok(result.kind === "fail");
  assert.equal(result.failedSteps[0], "typecheck");
  assert.match(result.failedSteps[1], /^filed-grep-proof: /);
  assert.deepEqual(result.failedDetail, { typecheck: "TS2322" }, "the gate's own detail survives");
});

test("unit test: a filed grep proof that matches, a unit test proof and a credited proof leave the gate as it was", async () => {
  let runs = 0;
  const counting = async (): Promise<OpenPullRequestProofResult> => { runs++; return { status: 0 }; };
  const gate = withFiledGrepProofs(
    async () => pass,
    () => [
      grepCriterion("matches", "grep: here in src/a.ts"),
      grepCriterion("a suite", "unit test: something a suite proves"),
      { claim: "credited", proof: "grep: gone in src/b.ts", satisfied_by: "PR-1" } as AcceptanceCriterion,
    ],
    counting,
  );
  assert.deepEqual(await gate("/w"), pass);
  assert.equal(runs, 1, "only the executable grep proof is run: not the suite proof, not the credited one");
});

test("unit test: a proof the harness could not look at is not handed to the worker", async () => {
  for (const result of [{ status: 4 }, { status: null, signal: "SIGTERM" }, { status: 3, error: "spawn failure" }, { status: 2 }, { status: 5 }]) {
    const misses = await filedGrepProofMisses([grepCriterion("c", "grep: x in src/a.ts")], "/w", verdict(result.status, result as Partial<OpenPullRequestProofResult>));
    assert.deepEqual(misses, [], `${JSON.stringify(result)} is the open's to retry, never a repair step`);
  }
});

test("unit test: an unmeasured or skipped pre-open gate is returned unchanged and runs no proof", async () => {
  let runs = 0;
  const criteria = () => [grepCriterion("c", "grep: x in src/a.ts")];
  const runner = async (): Promise<OpenPullRequestProofResult> => { runs++; return { status: 3 }; };
  const unmeasured: PreopenGateResult = { kind: "unmeasured", reason: "no sandbox", durationMs: 1 };
  const skipped: PreopenGateResult = { kind: "skipped", reason: "gate-unhealthy", durationMs: 0 };
  assert.deepEqual(await withFiledGrepProofs(async () => unmeasured, criteria, runner)("/w"), unmeasured);
  assert.deepEqual(await withFiledGrepProofs(async () => skipped, criteria, runner)("/w"), skipped);
  assert.equal(runs, 0);
});

test("unit test: the filed grep proof step runs the real check-proof against the worker's uncommitted tree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w14789-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "x.txt"), "hello label\n");
    execFileSync("git", ["init", "-q", dir]);
    const criteria = [
      grepCriterion("written", "grep: hello label in src/x.txt"),
      grepCriterion("never written", "grep: Criterion 9 label in src/x.txt"),
    ];
    const misses = await filedGrepProofMisses(criteria, dir, (proof, base, cwd, target) => defaultProofRunnerAsync(proof, base, cwd, target));
    assert.equal(misses.length, 1, "exactly the unwritten label is a miss");
    assert.match(misses[0], /Criterion 9 label/);
    assert.doesNotMatch(misses[0], /hello label/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
