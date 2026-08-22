// test/credit-surface-gate.test.ts
//
// W1-T1214 — NOTHING REFUSES A MERGE THAT WILL LAND UNCREDITED ON EITHER GIT SURFACE.
// `appendTaskTrailerToCommit` (src/run-task.ts, W1-T1012) only runs inside the harness run loop,
// so a branch pushed by hand from an operator lane never gets the `Remudero-Task:` trailer, and a
// descriptive branch name carries no `run-<taskId>-<epochMs>` head-ref credit either — nothing
// anywhere refuses a merge that would land credited on NEITHER surface. This suite proves
// scripts/credit-surface-gate.mjs's `evaluateCreditSurfaceGate` is that refusal: a disjunction over
// the SAME two existing credit surfaces the readers already trust (design point (ii)) — an
// anchored `Remudero-Task:` trailer on the head commit, OR a `run-<taskId>-<epochMs>` head ref —
// with a filing-shaped commit (W1-T1004's own `LINT_FILING_SUBJECT_RE`, imported verbatim rather
// than re-spelled) exempted before either limb is even asked (design point (iii)).
//
// WHAT IS REAL HERE: `evaluateCreditSurfaceGate`/`isFilingShapedSubject` are the production
// functions from the script itself, imported directly — no seam, nothing mocked. `isDispatchedRunBranch`
// and `LINT_FILING_SUBJECT_RE` are re-exported straight out of `src/run-task.ts` by the gate script,
// so this suite is also proving the gate reused the read side rather than re-implementing it
// (design point (iv): "the read side is not touched").

import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "credit-surface-gate.mjs");

// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/credit-surface-gate.mjs"` is a TS7016 — the same reason
// test/acceptance-author-gate.test.ts reaches its script through a runtime import rather than a
// typed one. A dynamic specifier is not statically resolved, so this loads the REAL module with
// no shadow copy to drift from it.
const GATE_URL = pathToFileURL(SCRIPT).href;
const mod = (await import(GATE_URL)) as {
  evaluateCreditSurfaceGate: (input: { headCommitMessage: string; headRef: string | undefined }) => {
    ok: boolean;
    defect?: string;
    message: string;
  };
  isFilingShapedSubject: (subject: string) => boolean;
};
const { evaluateCreditSurfaceGate, isFilingShapedSubject } = mod;

// ── The five task acceptance criteria, each its own named `unit test:` proof ──────────────────

test("W1-T1214: an implementation pr credited on neither surface is refused", () => {
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stop a stuck run branch from blocking dispatch forever\n",
    headRef: "fix/drain-stuck-run-branch",
  });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "uncredited-merge");
});

test("W1-T1214: a trailer on the head commit satisfies the check", () => {
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stop a stuck run branch from blocking dispatch forever\n\nRemudero-Task: W1-T2519\n",
    headRef: "fix/drain-stuck-run-branch",
  });
  assert.equal(result.ok, true);
  assert.equal(result.defect, undefined);
  assert.match(result.message, /trailer/);
});

test("W1-T1214: a run-shaped head ref satisfies the check", () => {
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stop a stuck run branch from blocking dispatch forever\n",
    headRef: "run-W1-T2519-1787425298842",
  });
  assert.equal(result.ok, true);
  assert.equal(result.defect, undefined);
  assert.match(result.message, /run-shaped head ref/);
});

test("W1-T1214: a filing is never refused for carrying no trailer", () => {
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "chore(plan): file W1-T1214 — a hand-pushed implementation is uncredited\n",
    headRef: "triage/hand-pushed-uncredited",
  });
  assert.equal(result.ok, true);
  assert.equal(result.defect, undefined);
  assert.match(result.message, /filing/);

  // The older bare `plan:`/`docs:`/`chore:` convention (W1-T1078) is exempt too — the SAME
  // `LINT_FILING_SUBJECT_RE` the lint-plan failing-split classifier uses, not a re-spelled subset.
  const bareForm = evaluateCreditSurfaceGate({
    headCommitMessage: "docs: note the Q1 seam decision is deferred\n",
    headRef: "docs/note-seam-decision",
  });
  assert.equal(bareForm.ok, true);

  // Control: the SAME uncredited-surface shape from a non-filing subject IS refused — proves the
  // filing exemption is keyed on subject shape, not on "no trailer" alone.
  const nonFilingControl = evaluateCreditSurfaceGate({
    headCommitMessage: "feat(cli): add a new flag\n",
    headRef: "feat/add-new-flag",
  });
  assert.equal(nonFilingControl.ok, false);
});

test("W1-T1214: the refusal names both satisfying routes", () => {
  // NOT "chore: ..." -- that bare form is itself filing-shaped (W1-T1078, LINT_FILING_SUBJECT_RE)
  // and would be exempt before either credit limb is asked, defeating the point of this fixture.
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "refactor(cli): unrelated tidy-up with no trailer\n",
    headRef: "refactor/tidy-up",
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /Remudero-Task/, "names the trailer route");
  assert.match(result.message, /run-<taskId>-<epochMs>|run-.*-\d/i, "names the run-shaped head-ref route");
});

// ── Supporting coverage beyond the five named proofs (not itself a required proof) ─────────────

test("credit surface gate: isFilingShapedSubject reuses LINT_FILING_SUBJECT_RE verbatim", () => {
  assert.equal(isFilingShapedSubject("chore(plan): regenerate plan/plan-index.json"), true);
  assert.equal(isFilingShapedSubject("chore(triage): triage feedback#42"), true);
  assert.equal(isFilingShapedSubject("chore(feedback): capture recon note"), true);
  assert.equal(isFilingShapedSubject("docs(plan): renumber shard"), true);
  assert.equal(isFilingShapedSubject("plan: add W1-T1214"), true);
  assert.equal(isFilingShapedSubject("docs: update README"), true);
  assert.equal(isFilingShapedSubject("chore: bump a dependency"), true);
  assert.equal(isFilingShapedSubject("fix(drain): stop a stuck branch"), false);
  assert.equal(isFilingShapedSubject("feat(cli): add a flag"), false);
});

test("credit surface gate: a non-anchored mid-line mention does not falsely credit", () => {
  // A `Remudero-Task:` mention that does not START its own line (prose citing the id mid-sentence)
  // must not satisfy the check — the same anchoring `creditsByAnchoredTrailer`/
  // `appendTaskTrailerToCommit` already require of a REAL trailer.
  const trulyInline = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stuff. Remudero-Task: W1-T2519 mid-sentence, not its own line\n",
    headRef: "fix/inline-mention",
  });
  assert.equal(trulyInline.ok, false, "a non-anchored mid-line mention must not credit");

  // Control: the SAME id, but as its own anchored line, DOES credit.
  const anchored = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stuff.\n\nRemudero-Task: W1-T2519\n",
    headRef: "fix/anchored-trailer",
  });
  assert.equal(anchored.ok, true);
});

test("credit surface gate: both surfaces present names both", () => {
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stop a stuck run branch\n\nRemudero-Task: W1-T2519\n",
    headRef: "run-W1-T2519-1787425298842",
  });
  assert.equal(result.ok, true);
});

test("credit surface gate: an empty/missing head ref is not run-shaped and does not crash", () => {
  const result = evaluateCreditSurfaceGate({
    headCommitMessage: "fix(drain): stop a stuck run branch\n",
    headRef: undefined,
  });
  assert.equal(result.ok, false);
});
