import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import {
  defaultProofRunnerAsync,
  openPullRequestCheckedAsync,
  PrOpenRefusedError,
  type OpenPullRequestProofResult,
} from "#src/lib/pr-open.js";
import { renderPreopenGatePrompt, withFiledProofCheck, type PreopenGateResult } from "#src/lib/preopen-gate.js";

const criterion = (proof: string, extra: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion =>
  ({ claim: "a claim", proof, ...extra }) as AcceptanceCriterion;
const pass: PreopenGateResult = { kind: "pass", durationMs: 5 };
const answering = (status: number | null, extra: Partial<OpenPullRequestProofResult> = {}) =>
  async (): Promise<OpenPullRequestProofResult> => ({ status, ...extra });

test("W1-T14789 criterion 1: a filed grep proof that misses at head gets a preopen repair round", async () => {
  const asked: Array<{ proof: string; base: string | undefined; cwd: string }> = [];
  const gate = withFiledProofCheck(
    async () => pass,
    [criterion("grep: Criterion 3 in test/x.test.ts")],
    async (proof, base, cwd) => { asked.push({ proof, base, cwd }); return { status: 1 }; },
  );
  const result = await gate("/the/worktree");
  assert.ok(result.kind === "fail", "a clean base gate plus a missing proof text is a fail, so the repair round runs");
  assert.equal(result.failedSteps.length, 1);
  assert.equal(
    result.failedSteps[0],
    "filed-proof: `grep: Criterion 3 in test/x.test.ts` matches nothing at your head. The task's acceptance requires that text " +
      "in that file: write it where the criterion is proven (a criterion label goes in the title of the test that proves it)",
  );
  assert.deepEqual(asked, [{ proof: "grep: Criterion 3 in test/x.test.ts", base: undefined, cwd: "/the/worktree" }], "run at the worker's head, in its tree");
  assert.match(renderPreopenGatePrompt(result.failedSteps, true), /- filed-proof: /, "the repair prompt hands the worker the step");
});

test("W1-T14789 criterion 2: a filed proof miss keeps the base gate's steps in order and a base failure alone stays a fail", async () => {
  const failing: PreopenGateResult = { kind: "fail", failedSteps: ["typecheck", "lint"], durationMs: 9, failedDetail: { typecheck: "TS2322" } };
  const both = await withFiledProofCheck(async () => failing, [criterion("grep: absent in src/a.ts")], answering(1))("/w");
  assert.ok(both.kind === "fail");
  assert.deepEqual(both.failedSteps.slice(0, 2), ["typecheck", "lint"]);
  assert.match(both.failedSteps[2], /^filed-proof: /);
  assert.equal(both.failedSteps.length, 3);
  assert.deepEqual(both.failedDetail, { typecheck: "TS2322" }, "the base gate's own detail survives");

  const baseOnly = await withFiledProofCheck(async () => failing, [criterion("grep: present in src/a.ts")], answering(0))("/w");
  assert.deepEqual(baseOnly, failing, "a matching proof adds nothing to a failing base gate");
});

test("W1-T14789 criterion 2: a matching, inconclusive, non-grep or credited proof leaves the gate as it was", async () => {
  let runs = 0;
  const counting = async (): Promise<OpenPullRequestProofResult> => { runs++; return { status: 0 }; };
  const gate = withFiledProofCheck(
    async () => pass,
    [
      criterion("grep: here in src/a.ts"),
      criterion("unit test: something a suite proves"),
      criterion("grep: gone in src/b.ts", { satisfied_by: "PR-1" } as Partial<AcceptanceCriterion>),
    ],
    counting,
  );
  assert.deepEqual(await gate("/w"), pass);
  assert.equal(runs, 1, "only the executable grep proof runs: not the suite proof, not the credited one");

  const answers: OpenPullRequestProofResult[] = [
    { status: 4 },
    { status: null, signal: "SIGTERM" },
    { status: 1, error: "spawn failure" },
    { status: 0 },
  ];
  for (const answer of answers) {
    const answered = async (): Promise<OpenPullRequestProofResult> => answer;
    const result: PreopenGateResult = await withFiledProofCheck(async () => pass, [criterion("grep: x in src/a.ts")], answered)("/w");
    assert.deepEqual(result, pass, `${JSON.stringify(answer)} adds no step`);
  }
});

test("W1-T14789 criterion 4: a proof the gate flags is still refused at PR open exactly as before", async (t) => {
  const missing = { claim: "the marker was added", proof: "grep: MISSING_MARKER in src/example.ts" };
  const repo = gitRepo({ scope: t, kind: "preopen-filed-proof-open-unchanged" });
  mkdirSync(join(repo.dir, "src"));
  mkdirSync(join(repo.dir, "plan"));
  writeFileSync(join(repo.dir, "src/example.ts"), "export const OTHER = true;\n");
  writeFileSync(join(repo.dir, "plan/tasks.yaml"), [
    "- id: W1-T9", "  title: synthetic acceptance", "  repo: remudero", "  type: implement", "  acceptance:",
    `    - ${JSON.stringify({ ...missing, kind: "guard" })}`, "",
  ].join("\n"));
  repo.git("add", "-A");
  repo.git("commit", "-qm", "chore: synthetic base");
  repo.git("update-ref", "refs/remotes/origin/main", repo.git("rev-parse", "HEAD"));

  const gated = await withFiledProofCheck(async () => pass, [criterion(missing.proof)], defaultProofRunnerAsync)(repo.dir);
  assert.ok(gated.kind === "fail", "the pre-open gate names the proof that matches nothing at head");
  assert.match(gated.failedSteps[0], /^filed-proof: `grep: MISSING_MARKER in src\/example\.ts` matches nothing at your head/);

  await assert.rejects(
    async () => openPullRequestCheckedAsync("", "run-W1-T9-1792776000000", repo.dir, "origin/main", defaultProofRunnerAsync),
    (e: unknown) => e instanceof PrOpenRefusedError && e.refusalClass === "branch-gap" && /at head/.test(e.message),
    "PR open still refuses a proof that fails after the repair round, with the unchanged refusal class",
  );
});

test("W1-T14789 criterion 2: a gate that measured nothing is returned unchanged and runs no filed proof", async () => {
  let runs = 0;
  const runner = async (): Promise<OpenPullRequestProofResult> => { runs++; return { status: 1 }; };
  const unmeasured: PreopenGateResult = { kind: "unmeasured", reason: "no sandbox", durationMs: 1 };
  const skipped: PreopenGateResult = { kind: "skipped", reason: "gate-unhealthy", durationMs: 0 };
  const criteria = [criterion("grep: x in src/a.ts")];
  assert.deepEqual(await withFiledProofCheck(async () => unmeasured, criteria, runner)("/w"), unmeasured);
  assert.deepEqual(await withFiledProofCheck(async () => skipped, criteria, runner)("/w"), skipped);
  assert.equal(runs, 0);
});
