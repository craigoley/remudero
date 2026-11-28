/**
 * W1-T15278 — acceptance-author-gate finds a body `grep:` proof's moved test by its unique basename.
 *
 * #21209 (W1-T15171) was refused grep-proof-target-missing: its body proof named
 * test/an-expedited-task-is-admitted-past-the-wip-hold.test.ts, and the build placed that test under test/dispatch/,
 * where rmd test-place computes it. Every other reader (review, check-proof, the build's scope check, this gate's own
 * credited-test-path check) resolves a moved test by its unique basename (W1-T9860). The body check now does too, and
 * fails closed exactly as resolveTestPath does.
 *
 * Every fixture root is a REAL committed git repository: resolveTestPath indexes the root's HEAD tree.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitRepo } from "#test/helpers/git-repo.js";
import { basenameResolutionNote } from "#src/lib/test-path-resolver.js";

type Verdict = { ok: boolean; defect?: string; message: string };
// Scripts sit outside tsconfig's typed include; the package alias still loads the real gate.
const gateSpecifier = "#scripts/acceptance-author-gate.mjs";
const { evaluateGate, bodyProofTargetMissing } = (await import(gateSpecifier)) as {
  evaluateGate: (input: { body: string; authorLogin?: string; criteriaFromHeadPlan?: boolean; root: string }) => Verdict;
  bodyProofTargetMissing: (criteria: readonly { claim: string; proof: string }[], root?: string) => Verdict | undefined;
};

/** A committed repository holding `files` (path -> contents); returns its root. */
function rootWith(files: Record<string, string>): string {
  const repo = gitRepo({ kind: "w1-t15278" });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "fixture");
  return repo.dir;
}

function bodyCiting(...proofs: string[]): string {
  return `## Acceptance\n\n${proofs.map((proof, i) => `- claim: criterion ${i + 1}\n  proof: ${proof}\n`).join("")}`;
}

function judge(root: string, ...proofs: string[]): { direct: Verdict | undefined; gate: Verdict } {
  const criteria = proofs.map((proof, i) => ({ claim: `criterion ${i + 1}`, proof }));
  return {
    direct: bodyProofTargetMissing(criteria, root),
    gate: evaluateGate({ body: bodyCiting(...proofs), authorLogin: "a-human", root }),
  };
}

// #21209's real shape: the record (and so the body) named the test at test/ root; the build placed it at test/dispatch/.
const CITED_21209 = "test/an-expedited-task-is-admitted-past-the-wip-hold.test.ts";
const PLACED_21209 = "test/dispatch/an-expedited-task-is-admitted-past-the-wip-hold.test.ts";
const TITLE_21209 = "W1-T15171 criterion 1: an expedited task is admitted past the WIP hold";

test("W1-T15278 criterion 1: a body grep proof naming a moved test is found by its unique basename (the #21209 replay)", () => {
  const root = rootWith({ [PLACED_21209]: `test(${JSON.stringify(TITLE_21209)}, () => {});\n` });
  const { direct, gate } = judge(root, `grep: ${TITLE_21209} in ${CITED_21209}`);
  assert.equal(direct, undefined, `bodyProofTargetMissing resolves the moved test: ${direct?.message}`);
  assert.equal(gate.ok, true, gate.message);
  assert.notEqual(gate.defect, "grep-proof-target-missing");
  assert.ok(
    gate.message.includes(basenameResolutionNote(CITED_21209, PLACED_21209)),
    `the ok message names the cited and the resolved path: ${gate.message}`,
  );

  // A second, generic placement drift (W1-T14644's shape: one folder for another).
  const drifted = rootWith({ "test/daemon/a-drifted-suite.test.ts": 'test("x", () => {});\n' });
  const second = judge(drifted, "grep: x in test/dispatch/a-drifted-suite.test.ts");
  assert.equal(second.direct, undefined);
  assert.equal(second.gate.ok, true, second.gate.message);
  assert.ok(second.gate.message.includes(basenameResolutionNote("test/dispatch/a-drifted-suite.test.ts", "test/daemon/a-drifted-suite.test.ts")));

  // A resolved move does not swallow a later criterion's real absence: that one is still refused by its own number.
  const both = judge(root, `grep: ${TITLE_21209} in ${CITED_21209}`, "grep: x in test/never-written.test.ts");
  for (const verdict of [both.direct, both.gate]) {
    assert.equal(verdict?.ok, false);
    assert.equal(verdict?.defect, "grep-proof-target-missing");
    assert.match(verdict!.message, /^criterion 2's grep proof names `test\/never-written\.test\.ts`/);
  }
});

test("W1-T15278 criterion 2: the basename lookup fails closed exactly as resolveTestPath does", () => {
  // Absent: the basename matches no file.
  const empty = rootWith({ "test/other/unrelated.test.ts": "\n" });
  for (const verdict of Object.values(judge(empty, "grep: x in test/never-written.test.ts"))) {
    assert.equal(verdict?.ok, false);
    assert.equal(verdict?.defect, "grep-proof-target-missing");
    assert.match(verdict!.message, /test\/never-written\.test\.ts`, which does not exist at this head/);
  }

  // Ambiguous: two tests share the basename. Refused, and the refusal names both candidates.
  const twice = rootWith({ "test/a/shared-name.test.ts": "\n", "test/b/shared-name.test.ts": "\n" });
  for (const verdict of Object.values(judge(twice, "grep: x in test/shared-name.test.ts"))) {
    assert.equal(verdict?.ok, false);
    assert.equal(verdict?.defect, "grep-proof-target-missing");
    assert.ok(verdict!.message.includes("test/a/shared-name.test.ts"), verdict!.message);
    assert.ok(verdict!.message.includes("test/b/shared-name.test.ts"), verdict!.message);
    assert.doesNotMatch(verdict!.message, /resolved \S+ -> /, "no resolution note on a refusal");
  }

  // Non-test targets keep exact identity even when a same-named file exists elsewhere.
  const nonTest = rootWith({
    "plan/tasks.d/archive/W1-T99999-a-record.yaml": "- id: W1-T99999\n",
    "src/lib/other/widget.ts": "export {};\n",
    "test/helpers/sub/a-helper.ts": "export {};\n",
  });
  for (const cited of ["plan/tasks.d/W1-T99999-a-record.yaml", "src/lib/widget.ts", "test/helpers/a-helper.ts"]) {
    for (const verdict of Object.values(judge(nonTest, `grep: x in ${cited}`))) {
      assert.equal(verdict?.ok, false, `${cited} is never resolved by basename`);
      assert.equal(verdict?.defect, "grep-proof-target-missing");
      assert.ok(verdict!.message.includes(cited));
    }
  }

  // test/fixtures/ is never a basename target, nor a basename candidate.
  const fixtures = rootWith({ "test/other/fixture-shaped.test.ts": "\n", "test/fixtures/deep/only-a-fixture.test.ts": "\n" });
  for (const cited of ["test/fixtures/fixture-shaped.test.ts", "test/only-a-fixture.test.ts"]) {
    for (const verdict of Object.values(judge(fixtures, `grep: x in ${cited}`))) {
      assert.equal(verdict?.ok, false, `${cited} is refused`);
      assert.equal(verdict?.defect, "grep-proof-target-missing");
    }
  }
});

test("W1-T15278 criterion 3: existing and skipped targets are judged as on origin/main", () => {
  const root = rootWith({
    "test/exact/at-its-path.test.ts": 'test("x", () => {});\n',
    [PLACED_21209]: "\n",
  });

  // An exact target passes with no resolution note.
  const exact = judge(root, "grep: x in test/exact/at-its-path.test.ts");
  assert.equal(exact.direct, undefined);
  assert.equal(exact.gate.ok, true, exact.gate.message);
  assert.doesNotMatch(exact.gate.message, /by basename/);

  // Criteria resolved from the head plan skip the check entirely: no refusal for an absent target, no lookup note.
  for (const cited of ["test/never-written.test.ts", CITED_21209]) {
    const skipped = evaluateGate({ body: bodyCiting(`grep: x in ${cited}`), authorLogin: "a-human", criteriaFromHeadPlan: true, root });
    assert.equal(skipped.ok, true, skipped.message);
    assert.doesNotMatch(skipped.message, /by basename/);
  }

  // A legacy fenced proof's author-selected argv and a `unit test:` proof are not path-checked.
  for (const proof of ["`grep -n x test/never-written.test.ts`", "unit test: a title that names no path"]) {
    const unchecked = judge(root, proof);
    assert.equal(unchecked.direct, undefined, proof);
    assert.notEqual(unchecked.gate.defect, "grep-proof-target-missing", proof);
    assert.doesNotMatch(unchecked.gate.message, /by basename/);
  }

  // Every other refusal is unchanged: a missing target after an exact one is refused, naming its own criterion.
  const mixed = judge(root, "grep: x in test/exact/at-its-path.test.ts", "grep: x in test/never-written.test.ts");
  for (const verdict of [mixed.direct, mixed.gate]) {
    assert.equal(verdict?.ok, false);
    assert.equal(verdict?.defect, "grep-proof-target-missing");
    assert.match(verdict!.message, /^criterion 2's grep proof names `test\/never-written\.test\.ts`/);
    assert.match(verdict!.message, /path is absent, not the criterion failed/);
  }
  // A proof-shape refusal on an exact-target body reads as it did.
  const shape = judge(root, "grep: x in test/exact/at-its-path.test.ts", "no dialect here");
  assert.equal(shape.gate.ok, false);
  assert.equal(shape.gate.defect, "proof-shape");
  assert.match(shape.gate.message, /criterion 2 cannot execute/);
  assert.doesNotMatch(shape.gate.message, /by basename/);
});
