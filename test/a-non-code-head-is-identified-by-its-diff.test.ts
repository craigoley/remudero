// W1-T3706 — THE ADMITTED-FORM LIST HAD GROWN ONE SPELLING AT A TIME.
//
// `evaluateHeadIdentityGate` admitted a filing-shaped SUBJECT (W1-T1004), a `Remudero-Task`
// trailer, a run-shaped head ref, or a dependency bump (W1-T3680) — all four gated on a
// FORGEABLE, FREE-FORM string. PR #5809 committed a DECISIONS.md ruling as `chore(docs):` and was
// refused; the identical ruling committed as `docs:` would have been admitted, for no reason but
// spelling. A plan filing, a dependency bump and a documentation ruling all BUILD NO TASK — so a
// trailer would be a false credit and a run-shaped branch a lie about origin — and what makes each
// safe to admit is that its diff touches no code, a fact about the DIFF nobody can misspell.
//
// This suite pins the FIFTH admitted form (keyed on the diff, not the subject) and, just as hard,
// the two ways it must not become a hole: one `src/` path in an otherwise non-code diff still
// refuses the whole head, and an UNREADABLE diff refuses rather than admitting.
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "head-identity-gate.mjs");

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static import is a TS7016 — reached by
// dynamic import, exactly as test/a-dependabot-head-is-identified-without-a-task.test.ts does.
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  evaluateHeadIdentityGate: (input: {
    headCommitMessage: string;
    headRef: string | undefined;
    changedPaths?: readonly string[];
  }) => { ok: boolean; defect?: string; message: string };
  isNonCodeHead: (input: { changedPaths: readonly string[] | undefined }) => boolean;
  isNonCodePath: (path: string) => boolean;
};
const { evaluateHeadIdentityGate, isNonCodeHead, isNonCodePath } = mod;

const NON_RUN_SHAPED_REF = "chore/rule-implement-stays-claude-only-abc123";
// The unlisted spelling PR #5809 was refused on — not one of the enumerated subject forms.
const UNLISTED_SUBJECT = "chore(docs): rule that the implement lane stays claude-only";
const NON_CODE_PATHS = ["DECISIONS.md", "docs/architecture/gates.md", "plan/notes/ruling.md", "learnings/gate.md"];

// ── Criterion 1: an unlisted-subject, non-code-only head is admitted by its diff ────────────────

test("a non-code-only head is admitted whatever its subject spelling", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: `${UNLISTED_SUBJECT}\n`,
    headRef: NON_RUN_SHAPED_REF,
    changedPaths: ["DECISIONS.md"],
  });
  assert.equal(result.ok, true, "an unlisted subject spelling must not sink a non-code diff");
  assert.equal(result.defect, undefined);
  // The message must say WHY it was admitted, so the exemption is auditable in a log — a bare OK
  // would be indistinguishable from the run-shaped-ref arm.
  assert.match(result.message, /non-code head/);
  assert.match(result.message, /whatever its subject/);
});

test("every non-code path shape is admitted together, not just a single .md file", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: `${UNLISTED_SUBJECT}\n`,
    headRef: NON_RUN_SHAPED_REF,
    changedPaths: NON_CODE_PATHS,
  });
  assert.equal(result.ok, true);
  for (const path of NON_CODE_PATHS) {
    assert.equal(isNonCodePath(path), true, `${path} must be treated as non-code`);
  }
});

// ── Criterion 2: one source path in an otherwise non-code diff refuses the whole head ────────────

test("one src/ path in an otherwise non-code diff refuses the whole head", () => {
  // THE PREDICATE ITSELF, not just the gate's overall verdict — every non-run-shaped, untrailered
  // head with a mixed diff was ALREADY refused before this form existed, so an assertion on the
  // gate alone would pass on both trees and discriminate nothing.
  assert.equal(
    isNonCodeHead({ changedPaths: ["DECISIONS.md", "src/run-task.ts"] }),
    false,
    "one source path must sink the whole exemption",
  );
  const result = evaluateHeadIdentityGate({
    headCommitMessage: `${UNLISTED_SUBJECT}\n`,
    headRef: NON_RUN_SHAPED_REF,
    changedPaths: ["DECISIONS.md", "src/run-task.ts"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "unidentified-head");
});

test("scripts/head-identity-gate.mjs itself is not treated as non-code", () => {
  assert.equal(isNonCodePath("scripts/head-identity-gate.mjs"), false);
  assert.equal(isNonCodePath("test/a-non-code-head-is-identified-by-its-diff.test.ts"), false);
});

// ── Criterion 3: an unreadable diff refuses rather than admitting ───────────────────────────────

test("an UNREADABLE diff refuses rather than admitting", () => {
  for (const changedPaths of [undefined, []]) {
    // Same reasoning as the src/ case above: assert on the predicate, which only exists once the
    // fix does, so this reddens when the fix is removed instead of passing on both trees.
    assert.equal(
      isNonCodeHead({ changedPaths }),
      false,
      `changedPaths=${JSON.stringify(changedPaths)} must fail closed`,
    );
    const result = evaluateHeadIdentityGate({
      headCommitMessage: `${UNLISTED_SUBJECT}\n`,
      headRef: NON_RUN_SHAPED_REF,
      changedPaths,
    });
    assert.equal(result.ok, false);
    assert.equal(result.defect, "unidentified-head");
  }
});

// ── Criterion 4: every subject spelling admitted today is still admitted ────────────────────────

test("the four pre-existing admitted forms are untouched", () => {
  const filing = evaluateHeadIdentityGate({
    headCommitMessage: "docs: update\n",
    headRef: "plan/whatever",
    changedPaths: ["src/run-task.ts"],
  });
  assert.equal(filing.ok, true);
  assert.match(filing.message, /filing-shaped subject/);

  const chore = evaluateHeadIdentityGate({
    headCommitMessage: "chore: tidy\n",
    headRef: "chore/tidy",
    changedPaths: ["src/run-task.ts"],
  });
  assert.equal(chore.ok, true);
  assert.match(chore.message, /filing-shaped subject/);

  const runShaped = evaluateHeadIdentityGate({
    headCommitMessage: "fix(drain): stop a stuck run branch\n",
    headRef: "run-W1-T2519-1787425298842",
    changedPaths: ["src/run-task.ts"],
  });
  assert.equal(runShaped.ok, true);
  assert.match(runShaped.message, /run-shaped head ref/);

  const trailered = evaluateHeadIdentityGate({
    headCommitMessage: "fix(gate): patch something\n\nRemudero-Task: W1-T1\n",
    headRef: "some-branch",
    changedPaths: ["src/run-task.ts"],
  });
  assert.equal(trailered.ok, true);
  assert.match(trailered.message, /Remudero-Task trailer/);

  const bump = evaluateHeadIdentityGate({
    headCommitMessage: "chore(deps): bump the npm-minor-and-patch group with 6 updates\n",
    headRef: "dependabot/npm_and_yarn/npm-minor-and-patch-4616289c19",
    changedPaths: ["package.json", "package-lock.json"],
  });
  assert.equal(bump.ok, true);
  assert.match(bump.message, /dependency-bump head/);
});

// ── Criterion 5: the refusal text for a head satisfying no form is unchanged ────────────────────

test("an ordinary unidentified head is refused with its text unchanged", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: "refactor(cli): unrelated tidy-up with no trailer\n",
    headRef: "refactor/tidy-up",
    changedPaths: ["src/run-task.ts"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "unidentified-head");
  assert.equal(
    result.message,
    "REFUSED — this head matches neither conforming form and carries no valid Remudero-Task " +
      "trailer. Satisfy one: (1) push to a session branch shaped " +
      "`run-<taskId>-<epochMs>` when building a filed task, or `run-unfiled-<epochMs>` " +
      "when the work has no filed task, or (2) carry an anchored `Remudero-Task: <id>` trailer " +
      "on the head commit (either is enough — see W1-T3388).",
  );
});
