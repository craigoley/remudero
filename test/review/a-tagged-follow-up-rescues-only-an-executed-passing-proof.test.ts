// W1-T14242: a reviewer FAIL tagged (b) is a follow-up beyond the claim, and leaves its criterion met ONLY when that
// criterion's proof executed and passed. On any other proof outcome the criterion rests on the keyword floor, and a
// misclassified (b) would turn an explained FAIL into a pass, so the FAIL folds as an (a).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import { judgeCriterion, type ProofExecContext, type ProofExecOutcome } from "#src/lib/review.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const CLAUSE = "the padded final log line drops the crash cause when the child exits on a signal";
const GREP: AcceptanceCriterion = { claim: "the marker is written", proof: "grep: REQUIRED_MARKER in src/marker.ts" };
const GREP_TOKENS = new Set(["required_marker", "required", "marker", "src", "marker.ts", "ts", "written"]);
const TEST_PATH = "test/review/declared-but-unbuilt.test.ts";
const UNIT: AcceptanceCriterion = { claim: "the unbuilt suite passes", proof: `unit test: ${TEST_PATH}` };
const UNIT_TOKENS = new Set(["test", "review", "declared", "but", "unbuilt", "declared-but-unbuilt.test.ts", "ts", "suite", "passes"]);

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}tagged-follow-up-`));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

type Case = { outcome: ProofExecOutcome; criterion: AcceptanceCriterion; tokens: Set<string>; ctx: (root: string) => ProofExecContext | undefined };
const NON_PASSING: Case[] = [
  { outcome: "not_executable", criterion: GREP, tokens: GREP_TOKENS, ctx: () => undefined },
  { outcome: "exec_error", criterion: GREP, tokens: GREP_TOKENS, ctx: (root) => ({ cwd: root, exec: () => { throw new Error("spawn exploded"); } }) },
  { outcome: "executed_stale", criterion: GREP, tokens: GREP_TOKENS, ctx: (root) => ({ cwd: root, baseCwd: root, exec: () => "pass" }) },
  { outcome: "base_unreadable", criterion: GREP, tokens: GREP_TOKENS,
    ctx: (root) => ({ cwd: root, baseCwd: root, baseUnreadablePaths: new Set(["src/marker.ts"]), exec: () => "pass" }) },
  { outcome: "not_yet_built", criterion: UNIT, tokens: UNIT_TOKENS,
    ctx: (root) => ({ cwd: root, planOnlyDiff: true, forwardReferenceFiles: new Set([TEST_PATH]), exec: () => { throw new Error("never spawned"); } }) },
];

test("W1-T14242 criterion 1: a (b) FAIL on a keyword-met criterion whose proof did not execute and pass is unmet and keeps the clause", () => {
  for (const c of NON_PASSING) {
    withRoot((root) => {
      const floor = judgeCriterion(c.criterion, c.tokens, undefined, c.ctx(root));
      assert.equal(floor.proof_exec, c.outcome, `fixture reaches ${c.outcome}`);
      assert.equal(floor.met, true, `${c.outcome}: the keyword floor alone meets the criterion`);
      const v = judgeCriterion(c.criterion, c.tokens, false, c.ctx(root), undefined, `(b) ${CLAUSE}`);
      assert.equal(v.proof_exec, c.outcome);
      assert.equal(v.met, false, `${c.outcome}: a (b) FAIL cannot leave a criterion met that no passing proof backs`);
      assert.equal(v.floorMet, true);
      assert.ok(v.reason.includes(CLAUSE), `${c.outcome}: the reason keeps the reviewer's clause: ${v.reason}`);
      assert.ok(v.reason.includes(`(b) not honoured`) && v.reason.includes(c.outcome), `${c.outcome}: the reason says why (b) was not honoured: ${v.reason}`);
      assert.equal(v.followUp, undefined, `${c.outcome}: no follow-up is written in place of the failure`);
      assert.equal(v.downgrade_class, "a", `${c.outcome}: the FAIL folds as an (a)`);
    });
  }
});

test("W1-T14242 criterion 1: (a), (c) and untagged FAILs on a keyword-met criterion are unchanged", () => {
  for (const [clause, cls] of [[`(a) ${CLAUSE}`, "a"], [`(c) ${CLAUSE}`, "c"], [CLAUSE, "unclassified"]] as const) {
    const v = judgeCriterion(GREP, GREP_TOKENS, false, undefined, undefined, clause);
    assert.equal(v.met, false);
    assert.equal(v.downgrade_class, cls);
    assert.ok(v.reason.endsWith(`(semantic downgrade): ${CLAUSE}`), v.reason);
    assert.ok(!v.reason.includes("not honoured"));
  }
});

test("W1-T14242 criterion 2: a (b) FAIL on an executed_pass criterion stays met and records its follow-up", () => {
  withRoot((root) => {
    const ctx: ProofExecContext = { cwd: root, exec: () => "pass" };
    const v = judgeCriterion(GREP, new Set(), false, ctx, undefined, `(b) ${CLAUSE}`);
    assert.equal(v.proof_exec, "executed_pass");
    assert.equal(v.met, true, "an observed passing proof is not outweighed by a follow-up beyond the claim");
    assert.equal(v.downgrade_class, "b");
    assert.equal(v.followUp, CLAUSE);
    assert.ok(!v.reason.includes("not honoured"), v.reason);
    const unexplained = judgeCriterion(GREP, new Set(), false, ctx);
    assert.equal(unexplained.met, true, "an unexplained FAIL still cannot outweigh an executed_pass");
    assert.equal(unexplained.followUp, undefined);
  });
});
