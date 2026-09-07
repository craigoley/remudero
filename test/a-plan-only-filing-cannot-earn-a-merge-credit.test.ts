// W1-T3067 — the diff-based plan-only refusal existed and was SKIPPED. `ownsOwnRunBranch` suppressed
// it on the stated assumption that "a worker's own run-branch PR is an implementation by
// construction" — false: a lane dispatched on a task files an AMENDMENT from that same branch.
// MEASURED: #3195 (head run-W1-T2371-…, whole diff one shard file) and #3896 (head run-W1-T2648-…).
// The ledger arm cannot catch them either, so nothing did — and W1-T2794's rung closed #4461.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
function functionBody(src: string, name: string): string {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, name + " not found");
  const next = src.indexOf("\nfunction ", start + 1);
  const alt = src.indexOf("\nexport function ", start + 1);
  const end = Math.min(next === -1 ? src.length : next, alt === -1 ? src.length : alt);
  return src.slice(start, end);
}

test("W1-T3067: every DESTRUCTIVE credit consumer supplies mergedPathsByPr", () => {
  // buildCreditCandidates closes a PR; buildEscalationReconcileCandidates closes a needs-human
  // issue. BOTH read proj.merged, so a filing-earned credit in either destroys something. Wiring
  // one and not the other is the failure this pins: the refusal fixed in one surface, open in the
  // other. Structural because these builders construct DeriveDeps inline — nothing but the source
  // says whether the evidence reaches them.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(root, "src", "run-task.ts"), "utf8");
  for (const fn of ["buildCreditCandidates", "buildEscalationReconcileCandidates"]) {
    const body = functionBody(src, fn);
    assert.match(body, /DeriveDeps = \{/, fn + " should construct DeriveDeps");
    assert.match(body, /mergedPathsByPr: readMergedPathsByPr\(/,
      fn + " drives a destructive act on proj.merged, so it MUST supply the local path evidence");
  }
});

test("W1-T3067: the DISPLAY consumers are deliberately NOT wired, and that is a recorded cost decision", () => {
  // The board, inboxCommand and the ratify loaders also derive status and supply no map. None of
  // them closes anything, and the board renders per request while readMergedPathsByPr scans
  // thousands of commits. Recorded as a test so the asymmetry is a decision on the record rather
  // than an oversight a later reader "fixes" into a per-render repo scan.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const board = readFileSync(join(root, "src", "lib", "status-board.ts"), "utf8");
  assert.match(board, /DeriveDeps = \{/, "the board does derive status");
  assert.doesNotMatch(board, /mergedPathsByPr/,
    "display-only and per-request: wiring it would pay a repo-wide git log per render");
});
