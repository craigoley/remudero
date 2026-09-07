// W1-T3067 — the diff-based plan-only refusal existed and was SKIPPED. `ownsOwnRunBranch` suppressed
// it on the stated assumption that "a worker's own run-branch PR is an implementation by
// construction" — false: a lane dispatched on a task files an AMENDMENT from that same branch.
// MEASURED: #3195 (head run-W1-T2371-…, whole diff one shard file) and #3896 (head run-W1-T2648-…).
// The ledger arm cannot catch them either, so nothing did — and W1-T2794's rung closed #4461.

import assert from "node:assert/strict";
import test from "node:test";

import { isPlanOnlyChangeset } from "../src/lib/status.js";
import { readMergedPathsByPr } from "../src/run-task.js";

/** The #3195 shape: a filing opened from the task's OWN run branch. */
const FILING_PATHS = ["plan/tasks.d/W1-T2371-the-risk-judge-cannot-pass-an-amendment.yaml"];
/** A docs change that IS real work. NOT #3614 — I first attributed this shape to that PR from its
 *  `docs:` subject, and the producer later showed #3614's actual diff is `plan/tasks.d/*.yaml`.
 *  The fixture is kept because the PROPERTY it pins is real (a docs diff is not a filing); only the
 *  attribution was wrong, and naming a fixture after a PR it does not describe is how a false
 *  premise survives in a test suite. */
const DOCS_IMPL_PATHS = ["CLAUDE.md"];
/** An ordinary implementation. */
const SRC_PATHS = ["src/lib/risk-judge.ts", "test/risk-judge-plan-only-amendment.test.ts"];

test("W1-T3067 criterion 1: the #3195 shape IS a plan-only changeset, so the refusal has something to fire on", () => {
  // The predicate was never wrong; it was never consulted. This pins that the evidence is decisive.
  assert.equal(isPlanOnlyChangeset(FILING_PATHS), true);
});

test("W1-T3067 criterion 2 (falsifier): a docs or src diff is NOT plan-only, so a real implementation keeps its credit", () => {
  // THE ROW THAT STOPS AN OVERCORRECTION: #1926 and #2146 are ordinary implementations under a
  // `chore: wip` subject, and subject-matching would strip both. The paths keep them.
  assert.equal(isPlanOnlyChangeset(DOCS_IMPL_PATHS), false);
  assert.equal(isPlanOnlyChangeset(SRC_PATHS), false);
  assert.equal(isPlanOnlyChangeset([...FILING_PATHS, ...SRC_PATHS]), false, "a mixed diff is not a filing");
});

test("W1-T3067 criterion 3 (falsifier): an EMPTY or unknown changeset is not a filing", () => {
  // Absence of evidence must never become a refusal: a transient read failure would otherwise
  // silently uncredit the plan.
  assert.equal(isPlanOnlyChangeset([]), false);
});

test("W1-T3067 criterion 4: the refusal is SUBTRACT-ONLY — no path input can create credit", () => {
  // Every arrangement of the new evidence, over a changeset that is not plan-only, leaves the
  // refusal false; the refusal can only ever remove a credit that would otherwise stand.
  for (const paths of [SRC_PATHS, DOCS_IMPL_PATHS, [], [...FILING_PATHS, "src/x.ts"]]) {
    assert.equal(isPlanOnlyChangeset(paths), false, `${JSON.stringify(paths)} must not read as a filing`);
  }
});

test("W1-T3067: a run-branch head is NOT evidence of an implementation", () => {
  // The assumption the removed shortcut rested on, stated as a test: the branch name and the diff
  // are independent, and only the diff answers the question. Both #3195 and #3896 carried a
  // task-shaped run branch AND a plan-only diff.
  const runBranchHeads = ["run-W1-T2371-1787887882921", "run-W1-T2648-1788508326964"];
  for (const head of runBranchHeads) {
    assert.match(head, /^run-W1-T\d+-\d+$/, "sanity: these ARE the branch shape the shortcut trusted");
  }
  assert.equal(isPlanOnlyChangeset(FILING_PATHS), true, "yet the diff on that branch is a filing");
});

// ══════════ the producer — without it the refusal above is inert ══════════════════════════════

test("W1-T3067: the producer maps a PR to its merge commit's paths, or abstains", () => {
  // Injected root, so this never depends on the repo it happens to run in.
  const empty = readMergedPathsByPr("/definitely/not/a/repo/12345");
  assert.equal(empty.size, 0, "an unreadable root yields an EMPTY map, never a throw");
  // and an empty map is 'no opinion' everywhere it is consulted
  assert.equal(empty.get(3195), undefined);
});

test("W1-T3067 (falsifier): SUBJECT AND DIFF DISAGREE, AND THE DIFF IS RIGHT", () => {
  // Measured against the real repository while building this: #3614's subject reads
  // `docs: retire stale CLAUDE.md cap figures`, which I inferred was an implementation. Its actual
  // merge diff is `plan/tasks.d/W1-T2282-*.yaml` — a filing. The subject misled a careful reader on
  // the very sample being used to argue against subject-matching, which is the whole case for
  // deciding on paths.
  const subjectSaysImplementation = "docs: retire stale CLAUDE.md cap figures, cite enforcer instead";
  assert.doesNotMatch(subjectSaysImplementation, /^chore\(plan\)/, "its subject is not filing-shaped");
  assert.equal(
    isPlanOnlyChangeset(["plan/tasks.d/W1-T2282-docs-is-the-uncovered-knowledge-corpus.yaml"]),
    true,
    "yet its diff is plan-only — the paths decide, not the words",
  );
});

// ══════════ WHICH CONSUMERS MUST CARRY THE EVIDENCE ══════════════════════════════════════════

/** Read one function body out of run-task.ts, for the structural checks below. */
