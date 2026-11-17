/**
 * W1-T13351 — A REPAIR PROOF THAT PASSES AT THE BASE IS REPLACED BEFORE THE PR OPENS.
 *
 * 2026-11-17: ubuntu-latest moved to ubuntu-26.04, which ships bwrap, and test/proof-spawner-env-isolation.test.ts went
 * red in CI. The red-main lane opened #19011 with `unit test:` of that suite, but inside the proof sandbox the suite
 * passes at the base too, so the required proof-discrimination gate graded both proofs executed_stale and refused the
 * correct repair. These cases replay that body against the grading step and its real check-proof executor.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { type BaseProofGrade, withoutStaleRepairProofs } from "#src/lib/main-repair-acceptance.js";
import { CHECK_PROOF_EXIT } from "#src/lib/check-proof.js";
import { checkProofBaseGrader, gradeFromCheckProofExit, runCheckProofChild } from "#src/lib/repair-proof-grader.js";
import { parseAcceptanceBlock } from "#src/lib/review.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SUITE = "test/proof-spawner-env-isolation.test.ts";
const CONTAINMENT = "test/containment.test.ts";
const COMMENT = "// bwrap sets PWD to its --chdir target.";
const CODE = 'const SANDBOX_CHDIR_ENV = "PWD";';

const diffOf = (path: string, added: string[]): string =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,0 +1,${added.length} @@`, ...added.map((l) => `+${l}`), ""].join("\n");

/** #19011's body as the dispatcher opened it. */
const BODY_19011 = [
  "Repairs `main`, red since `9be1ffbcb82a`.",
  "",
  "Acceptance:",
  `- ${SUITE} passes again on the repaired head | unit test: ${SUITE}`,
  `- ${CONTAINMENT} passes again on the repaired head | unit test: ${CONTAINMENT}`,
  "",
  "Remudero-Task: main-repair-9be1ffbcb82a",
  "",
].join("\n");

const grades = (byProof: Record<string, BaseProofGrade>) => async (proof: string): Promise<BaseProofGrade> => byProof[proof] ?? "unknown";

test("W1-T13351 criterion 1: #19011's stale unit test proofs are replaced by a grep of the line the repair adds", async () => {
  const verdict = await withoutStaleRepairProofs({
    body: BODY_19011,
    diffText: diffOf(SUITE, [COMMENT, CODE]),
    grade: grades({ [`unit test: ${SUITE}`]: "stale", [`unit test: ${CONTAINMENT}`]: "stale" }),
  });
  assert.equal(verdict.resolution, "rewritten");
  assert.deepEqual(verdict.stale, [`unit test: ${SUITE}`, `unit test: ${CONTAINMENT}`]);
  const proofs = parseAcceptanceBlock(verdict.body).map((c) => c.proof);
  assert.deepEqual(proofs, [`grep: ${CODE} in ${SUITE}`], "the comment line is skipped, the code line anchors");
  assert.match(verdict.body, /^Remudero-Task: main-repair-9be1ffbcb82a$/m, "the rest of the body is kept");
});

test("W1-T13351 criterion 2: proofs that discriminate are kept as written", async () => {
  const verdict = await withoutStaleRepairProofs({ body: BODY_19011, diffText: diffOf(SUITE, [CODE]), grade: grades({
    [`unit test: ${SUITE}`]: "discriminates", [`unit test: ${CONTAINMENT}`]: "unknown" }) });
  assert.deepEqual(verdict, { body: BODY_19011, stale: [], resolution: "kept" });
});

test("W1-T13351 criterion 3: a stale proof beside a discriminating one is dropped and the anchor joins the survivor", async () => {
  const verdict = await withoutStaleRepairProofs({ body: BODY_19011, diffText: diffOf(SUITE, [CODE]), grade: grades({
    [`unit test: ${SUITE}`]: "discriminates", [`unit test: ${CONTAINMENT}`]: "stale" }) });
  assert.deepEqual(parseAcceptanceBlock(verdict.body).map((c) => c.proof), [`unit test: ${SUITE}`, `grep: ${CODE} in ${SUITE}`]);
});

test("W1-T13351 criterion 4: with no safe line to anchor, a body of only stale proofs is returned unchanged with the reason", async () => {
  const verdict = await withoutStaleRepairProofs({ body: BODY_19011, diffText: diffOf(SUITE, [COMMENT]), grade: async () => "stale" });
  assert.equal(verdict.resolution, "anchor-unavailable");
  assert.equal(verdict.body, BODY_19011);
  assert.ok("reason" in verdict && verdict.reason === "no-safe-candidate");
});

test("W1-T13351: with no safe anchor, a discriminating survivor still sheds the stale proof", async () => {
  const verdict = await withoutStaleRepairProofs({ body: BODY_19011, diffText: undefined, grade: grades({
    [`unit test: ${SUITE}`]: "discriminates", [`unit test: ${CONTAINMENT}`]: "stale" }) });
  assert.equal(verdict.resolution, "rewritten");
  assert.deepEqual(parseAcceptanceBlock(verdict.body).map((c) => c.proof), [`unit test: ${SUITE}`]);
});

test("W1-T13351: an anchor already among the kept proofs is not added twice", async () => {
  const anchor = `grep: ${CODE} in ${SUITE}`;
  const body = `Acceptance:\n- it is stale | unit test: ${SUITE}\n- the line is there | ${anchor}\n`;
  const verdict = await withoutStaleRepairProofs({ body, diffText: diffOf(SUITE, [CODE]), grade: grades({ [`unit test: ${SUITE}`]: "stale" }) });
  assert.deepEqual(parseAcceptanceBlock(verdict.body).map((c) => c.proof), [anchor]);
});

test("W1-T13351 criterion 5: only check-proof's executed_stale exit grades stale, and only a clean pass discriminates", () => {
  assert.equal(gradeFromCheckProofExit(CHECK_PROOF_EXIT.executedStale), "stale");
  assert.equal(gradeFromCheckProofExit(CHECK_PROOF_EXIT.pass), "discriminates");
  for (const code of [CHECK_PROOF_EXIT.fail, CHECK_PROOF_EXIT.refused, CHECK_PROOF_EXIT.noMatch, CHECK_PROOF_EXIT.execError, null]) {
    assert.equal(gradeFromCheckProofExit(code), "unknown", String(code));
  }
});

test("W1-T13351: the grader runs the worktree's own check-proof against the merge base, inside the worktree", async () => {
  const calls: Array<{ argv: string[]; cwd: string; timeoutMs: number }> = [];
  const grade = checkProofBaseGrader("/wt/repair", "abc123", async (argv, opts) => {
    calls.push({ argv, ...opts });
    return CHECK_PROOF_EXIT.executedStale;
  }, 1234);
  assert.equal(await grade(`unit test: ${SUITE}`), "stale");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.argv.slice(-3), [`unit test: ${SUITE}`, "--base", "abc123"]);
  assert.ok(calls[0]!.argv.some((a) => a.startsWith("/wt/repair/") && a.endsWith("check-proof-main.ts")), calls[0]!.argv.join(" "));
  assert.equal(calls[0]!.cwd, "/wt/repair");
  assert.equal(calls[0]!.timeoutMs, 1234);
});

test("W1-T13351: the real check-proof child grades a proof that matches at head and base as stale", async () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const grade = checkProofBaseGrader(REPO_ROOT, head);
  assert.equal(await grade("grep: export function diffAnchor in src/lib/main-repair-acceptance.ts"), "stale");
});

test("W1-T13351: a check-proof child that cannot start grades unknown, never stale", async () => {
  assert.equal(await runCheckProofChild(["-e", "0"], { cwd: "/rmd-no-such-dir-for-w1-t13351", timeoutMs: 10_000 }), null);
});

test("W1-T13351: a check-proof child killed at its loop-time budget grades unknown, and a non-zero exit keeps its code", async () => {
  assert.equal(await runCheckProofChild(["-e", "setTimeout(() => {}, 30000)"], { cwd: process.cwd(), timeoutMs: 300 }), null);
  assert.equal(await runCheckProofChild(["-e", "process.exit(5)"], { cwd: process.cwd(), timeoutMs: 10_000 }), 5);
  assert.equal(await runCheckProofChild(["-e", "0"], { cwd: process.cwd(), timeoutMs: 10_000 }), 0);
});
