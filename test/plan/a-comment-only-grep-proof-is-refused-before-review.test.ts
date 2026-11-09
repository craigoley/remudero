import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { AcceptanceCriterion, Task } from "#src/lib/plan.js";
import { redesignEditRefusal } from "#src/lib/redesign-gardener.js";
import { grepProofCanOnlyCertifyComments } from "#src/lib/review.js";
import { lintTask, proofGrepCommentOnlyViolations } from "#src/lib/task-linter.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TARGET = "src/lib/plan.ts";
const CODE_AND_COMMENT = "// marker phrase in a comment\nconst marker = 1;\n// another note\n";
const reader = (files: Record<string, string>) => (rel: string) => files[rel];

function task(acceptance: AcceptanceCriterion[], over: Partial<Task> = {}): Task {
  return {
    id: "W1-T11190", title: "fixture", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium",
    status: "queued", attempts: 0, origin: "architect", files: [TARGET], acceptance, ...over,
  };
}

const crit = (proof: string, extra: object = {}): AcceptanceCriterion => ({ claim: "c1", proof, ...extra }) as AcceptanceCriterion;
const commentOnly = (t: Task, files: Record<string, string>, base: AcceptanceCriterion[] = []) =>
  lintTask(t, { readGrepProofFile: reader(files), baseAcceptance: base }).violations.filter((v) => v.check === "proof-grep-comment-only");

test("W1-T11376: lint-plan refuses a comment-only grep proof", () => {
  // The #16752 proof, quotes and all: its pattern opens with the comment opener, so no file read is needed.
  const opener = commentOnly(task([crit('grep: "// comments compressed" in src/lib/plan.ts')]), {});
  assert.equal(opener.length, 1);
  assert.equal(opener[0]!.severity, "block");
  assert.match(opener[0]!.message, /executed_stale/);
  assert.match(opener[0]!.message, /unit test:/);

  // Every line the pattern matches at head is a comment.
  const allComments = commentOnly(task([crit("grep: marker phrase in src/lib/plan.ts")]), { [TARGET]: CODE_AND_COMMENT });
  assert.equal(allComments.length, 1);
  assert.match(allComments[0]!.message, /criterion 1 /);

  // A single code match makes it a real proof; a target not on disk is judged by the opener arm alone.
  assert.deepEqual(commentOnly(task([crit("grep: const marker in src/lib/plan.ts")]), { [TARGET]: CODE_AND_COMMENT }), []);
  assert.deepEqual(commentOnly(task([crit("grep: marker phrase in src/lib/plan.ts")]), {}), []);
  assert.deepEqual(commentOnly(task([crit("grep: marker in src/lib/plan.ts")]), { [TARGET]: CODE_AND_COMMENT }), []);
});

test("W1-T11376: lint-plan judges only added or changed non-guard criteria on verify auto", () => {
  const inherited = crit('grep: "// comments compressed" in src/lib/plan.ts');
  assert.deepEqual(proofGrepCommentOnlyViolations(task([inherited]), { baseAcceptance: [inherited] }), [], "unchanged is not judged");
  assert.equal(proofGrepCommentOnlyViolations(task([inherited]), { baseAcceptance: [] }).length, 1, "added is judged");
  const changed = crit("grep: // another comment in src/lib/plan.ts");
  assert.equal(proofGrepCommentOnlyViolations(task([changed]), { baseAcceptance: [inherited] }).length, 1, "a changed proof is judged");
  const guard = crit("grep: // comments compressed in src/lib/plan.ts", { kind: "guard" });
  assert.deepEqual(proofGrepCommentOnlyViolations(task([guard]), { baseAcceptance: [] }), []);
  assert.deepEqual(proofGrepCommentOnlyViolations(task([inherited], { verify: "human" }), { baseAcceptance: [] }), []);
  assert.deepEqual(proofGrepCommentOnlyViolations(task([inherited]), {}), [], "no base, no judgement");
  assert.deepEqual(proofGrepCommentOnlyViolations(task([crit("unit test: a comment-only proof")]), { baseAcceptance: [] }), []);
});

test("W1-T11376: the shared predicate reads each grammar's own comment opener", () => {
  assert.equal(grepProofCanOnlyCertifyComments("// x", "a.ts"), true);
  assert.equal(grepProofCanOnlyCertifyComments("/* x", "a.mjs"), true);
  assert.equal(grepProofCanOnlyCertifyComments("# x", "plan/a.yaml"), true);
  assert.equal(grepProofCanOnlyCertifyComments("# x", "README.md"), false, "markdown has no comment grammar");
  assert.equal(grepProofCanOnlyCertifyComments("# x", "a.ts"), false);
  assert.equal(grepProofCanOnlyCertifyComments("note", "a.yaml", "# note\nkey: v\n"), true);
  assert.equal(grepProofCanOnlyCertifyComments("key", "a.yaml", "# note\nkey: v\n"), false);
  assert.equal(grepProofCanOnlyCertifyComments("absent", "a.ts", "const a = 1;\n"), false, "no match is not comment-only");
});

/** Run the public `rmd check-proof` entry from a throwaway checkout holding `content` at src/marker.ts. */
function checkProof(content: string, proofArgs: string[]): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-comment-only-"));
  try {
    const file = join(dir, "src", "marker.ts");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    const result = spawnSync(process.execPath,
      ["--import", import.meta.resolve("tsx"), join(REPO_ROOT, "src", "check-proof-main.ts"), ...proofArgs],
      { cwd: dir, encoding: "utf8", timeout: 60_000 });
    assert.ifError(result.error);
    assert.notEqual(result.status, null, result.stderr);
    return { code: result.status!, out: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T11376: check-proof grades a comment-only grep proof executed_stale", () => {
  const viaOpener = checkProof(CODE_AND_COMMENT, ["grep:", "//", "marker", "phrase", "in", "src/marker.ts"]);
  assert.match(viaOpener.out, /^verdict:\s+pass\s*$/m, "the proof itself passes at head");
  assert.match(viaOpener.out, /^discrimination: executed_stale — every matching line is a comment$/m);
  assert.equal(viaOpener.code, 5);

  const viaMatches = checkProof(CODE_AND_COMMENT, ["grep:", "another", "note", "in", "src/marker.ts"]);
  assert.match(viaMatches.out, /^discrimination: executed_stale — every matching line is a comment$/m);
  assert.equal(viaMatches.code, 5);

  const real = checkProof(CODE_AND_COMMENT, ["grep:", "const", "marker", "in", "src/marker.ts"]);
  assert.doesNotMatch(real.out, /executed_stale/);
  assert.equal(real.code, 0);
});

test("W1-T11376: the redesign Architect refuses a comment-only grep proof", () => {
  const t = task([crit("grep: something in src/lib/plan.ts")]);
  const edit = (proof: string) => ({ filesAdd: [], proofs: [{ criterion: 1, proof }], amendment: "swap the proof", reason: "r" });
  const none = () => "file" as const;
  const opener = redesignEditRefusal(t, edit('grep: "// comments compressed" in src/lib/plan.ts'), none);
  assert.match(String(opener), /criterion 1's proof is refused/);
  assert.match(String(opener), /comment text in src\/lib\/plan\.ts/);
  assert.match(String(opener), /executed_stale/);

  const matches = redesignEditRefusal(t, edit("grep: marker phrase in src/lib/plan.ts"), none, reader({ [TARGET]: CODE_AND_COMMENT }));
  assert.match(String(matches), /can only match comment text/);

  // A proof on a code line, a missing target, and a `unit test:` proof are all left to the other guards.
  assert.equal(redesignEditRefusal(t, edit("grep: const marker in src/lib/plan.ts"), none, reader({ [TARGET]: CODE_AND_COMMENT })), undefined);
  assert.equal(redesignEditRefusal(t, edit("grep: marker phrase in src/lib/plan.ts"), none, reader({})), undefined);
  assert.equal(redesignEditRefusal(t, edit("unit test: a comment-only proof is refused"), none), undefined);
});
