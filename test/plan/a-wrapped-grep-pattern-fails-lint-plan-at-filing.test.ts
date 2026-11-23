import assert from "node:assert/strict";
import { test } from "node:test";

import type { AcceptanceCriterion, Task } from "#src/lib/plan.js";
import { wrappedGrepPattern } from "#src/lib/review.js";
import { lintTask, proofGrepWrappedPatternViolations, type LintOpts } from "#src/lib/task-linter.js";

const TARGET = "src/lib/review.ts";
const BACKTICK = String.fromCharCode(96);
const DOUBLE = String.fromCharCode(34);
const SINGLE = String.fromCharCode(39);
const wrap = (d: string, text: string) => `${d}${text}${d}`;
const grepProof = (pattern: string, path = TARGET) => `grep: ${pattern} in ${path}`;

function task(acceptance: AcceptanceCriterion[]): Task {
  return {
    id: "W1-T14426", title: "fixture", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium",
    status: "queued", attempts: 0, origin: "architect", files: [TARGET], acceptance,
  };
}

const crit = (proof: string, extra: object = {}): AcceptanceCriterion => ({ claim: "c1", proof, ...extra }) as AcceptanceCriterion;
const wrappedFromLint = (t: Task, opts: LintOpts) =>
  lintTask(t, opts).violations.filter((v) => v.check === "proof-grep-safety" && /wraps its grep pattern/.test(v.message));

test("W1-T14426 criterion 1: lintTask with a base blocks a new wrapped grep proof and names the bare form", () => {
  const added = crit(grepProof(wrap(DOUBLE, "validatingTails")));
  const t = task([crit("unit test: test/a.test.ts"), added]);
  const found = wrappedFromLint(t, { baseAcceptance: [] });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, "block");
  assert.match(found[0]!.message, /^criterion 2 /);
  assert.ok(found[0]!.message.includes("grep: validatingTails in src/lib/review.ts"), found[0]!.message);
  assert.match(found[0]!.message, /acceptance-author gate/);
  assert.equal(lintTask(t, { baseAcceptance: [] }).ok, false);
});

test("W1-T14426 criterion 2: the rule flags a proof if and only if wrappedGrepPattern returns a value", () => {
  const flagged = [wrap(BACKTICK, "validatingTails"), wrap(DOUBLE, "validatingTails"), wrap(SINGLE, "validatingTails")];
  const notFlagged = ["validatingTails", wrap(DOUBLE, `valid${DOUBLE}atingTails`), wrap(SINGLE, `a${SINGLE}b`), `${DOUBLE}open only`];
  for (const pattern of [...flagged, ...notFlagged]) {
    const proof = grepProof(pattern);
    const hits = proofGrepWrappedPatternViolations(task([crit(proof)]), { baseAcceptance: [] });
    assert.equal(hits.length, wrappedGrepPattern(proof) === undefined ? 0 : 1, proof);
  }
  for (const pattern of flagged) assert.equal(proofGrepWrappedPatternViolations(task([crit(grepProof(pattern))]), { baseAcceptance: [] }).length, 1);
  for (const pattern of notFlagged) assert.equal(proofGrepWrappedPatternViolations(task([crit(grepProof(pattern))]), { baseAcceptance: [] }).length, 0);
  const backtick = proofGrepWrappedPatternViolations(task([crit(grepProof(wrap(BACKTICK, "x y")))]), { baseAcceptance: [] });
  assert.ok(backtick[0]!.message.includes(`wraps its grep pattern in ${BACKTICK}; use: grep: x y in ${TARGET}`));
});

test("W1-T14426 criterion 3: the rule does not read the target file, so real quoted text there does not excuse it", () => {
  let reads = 0;
  const readGrepProofFile = (rel: string) => {
    reads++;
    return rel === TARGET ? `const s = ${wrap(DOUBLE, "validatingTails")};\n` : undefined;
  };
  const t = task([crit(grepProof(wrap(DOUBLE, "validatingTails")))]);
  assert.equal(proofGrepWrappedPatternViolations(t, { baseAcceptance: [], readGrepProofFile }).length, 1);
  assert.equal(reads, 0);
  const found = wrappedFromLint(t, { baseAcceptance: [], readGrepProofFile, grepProofTargetKind: () => "file" });
  assert.equal(found.length, 1);
});

test("W1-T14426 criterion 4: a standing proof, a satisfied_by criterion and the whole-plan pass draw no violation", () => {
  const standing = crit(grepProof(wrap(DOUBLE, "validatingTails")));
  assert.equal(wrappedFromLint(task([standing]), { baseAcceptance: [standing] }).length, 0, "same proof as the base");
  const satisfied = crit(grepProof(wrap(DOUBLE, "validatingTails")), { satisfied_by: "W1-T1" });
  assert.equal(proofGrepWrappedPatternViolations(task([satisfied]), { baseAcceptance: [] }).length, 0, "satisfied_by");
  assert.equal(wrappedFromLint(task([standing]), {}).length, 0, "whole-plan pass");
  assert.equal(proofGrepWrappedPatternViolations(task([standing]), {}).length, 0, "whole-plan pass, direct");
  const changed = crit(grepProof(wrap(BACKTICK, "validatingTails")));
  assert.equal(wrappedFromLint(task([changed]), { baseAcceptance: [crit(grepProof("validatingTails"))] }).length, 1, "a changed proof is judged");
});
