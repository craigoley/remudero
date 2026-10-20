// W1-T9213 — A FILING SUBJECT ALONE NEVER IDENTIFIES A HEAD.
//
// `evaluateHeadIdentityGate` used to return ok for any filing-worded subject (bare `chore:`, `docs:`,
// `plan:` included) BEFORE reading the diff, so a `chore: tidy` head touching src/ passed with no
// run-shaped branch and no Remudero-Task trailer. The subject is forgeable free text; the diff is not.
// The subject form is now a labelled case of the diff form: admitted only with a readable, wholly
// non-code diff, and an unreadable or empty diff fails closed.
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "head-identity-gate.mjs");

// `scripts/**` sits OUTSIDE tsconfig's `include`, so it is reached by dynamic import.
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  evaluateHeadIdentityGate: (input: {
    headCommitMessage: string;
    headRef: string | undefined;
    changedPaths?: readonly string[];
  }) => { ok: boolean; defect?: string; message: string };
};
const { evaluateHeadIdentityGate } = mod;

const NON_RUN_REF = "chore/tidy";

test("W1-T9213: a filing-worded head that touches code is refused", () => {
  for (const subject of ["chore: tidy", "docs: update", "plan: file a thing", "chore(plan): file a thing"]) {
    const result = evaluateHeadIdentityGate({
      headCommitMessage: `${subject}\n`,
      headRef: NON_RUN_REF,
      changedPaths: ["plan/tasks.d/W1-T1.yaml", "src/run-task.ts"],
    });
    assert.equal(result.ok, false, `${subject} touching src/ must be refused`);
    assert.equal(result.defect, "unidentified-head");
    // The refusal names the code path that disqualifies it and both repairs.
    assert.match(result.message, /filing subject alone never identifies a head/);
    assert.match(result.message, /src\/run-task\.ts/);
    assert.doesNotMatch(result.message, /touches code: [^.]*plan\/tasks\.d/, "non-code paths are not blamed");
    assert.match(result.message, /run-<taskId>-<epochMs>/);
    assert.match(result.message, /Remudero-Task/);
  }
});

test("W1-T9213: a plan-only filing is admitted and an unreadable diff is refused", () => {
  const admitted = evaluateHeadIdentityGate({
    headCommitMessage: "chore(plan): file W1-T9213\n",
    headRef: "triage/hand-pushed-filing",
    changedPaths: ["plan/tasks.d/W1-T9213-x.yaml", "docs/notes.md"],
  });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.defect, undefined);
  assert.match(admitted.message, /filing-shaped subject/);
  assert.match(admitted.message, /W1-T9213/);

  for (const changedPaths of [undefined, []]) {
    const refused = evaluateHeadIdentityGate({
      headCommitMessage: "chore(plan): file W1-T9213\n",
      headRef: "triage/hand-pushed-filing",
      changedPaths,
    });
    assert.equal(refused.ok, false, `changedPaths=${JSON.stringify(changedPaths)} must fail closed`);
    assert.equal(refused.defect, "unidentified-head");
    assert.match(refused.message, /could not be read or is empty/);
  }
});

test("W1-T9213: a filing-worded head with more than five code paths elides the rest", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: "chore: tidy\n",
    headRef: NON_RUN_REF,
    changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"],
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /src\/e\.ts, …/);
  assert.doesNotMatch(result.message, /src\/f\.ts/);
});

test("W1-T9213: a filing-worded head with a run-shaped ref or trailer is still identified", () => {
  const byRef = evaluateHeadIdentityGate({
    headCommitMessage: "chore: tidy\n",
    headRef: "run-unfiled-1787425298842",
    changedPaths: ["src/run-task.ts"],
  });
  assert.equal(byRef.ok, true);
  const byTrailer = evaluateHeadIdentityGate({
    headCommitMessage: "chore: tidy\n\nRemudero-Task: W1-T1\n",
    headRef: NON_RUN_REF,
    changedPaths: ["src/run-task.ts"],
  });
  assert.equal(byTrailer.ok, true);
});
