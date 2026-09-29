import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { judgeCriterion, PROOF_FORM_ADVISORY } from "../src/lib/review.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * 2026-09-29 operator ruling: refuse only what is risky or broken. MEASURED 2026-09-15..29, six reviewer-unmet fix
 * rounds (#5917 #5918 #6055 #6169 #6578 #7226) were a `grep:` proof whose text WAS in the file at head but could not
 * match as written — a YAML `\"` or `\.` escape, backticks, or a line a block scalar wrapped. Those now withdraw the
 * `executed_fail` override (the keyword floor decides) with PROOF_FORM_ADVISORY in the reason. A missing change, a
 * stale match and a proof's own declaration line still fail. The REAL grep executor runs in every case here.
 */

const SHARD = "plan/tasks.d/W1-T9991-x.yaml";

function trees(head: string, base: string | undefined, fn: (headDir: string, baseDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}proof-form-`));
  try {
    const headDir = join(root, "head");
    const baseDir = join(root, "base");
    mkdirSync(dirname(join(headDir, SHARD)), { recursive: true });
    mkdirSync(dirname(join(baseDir, SHARD)), { recursive: true });
    writeFileSync(join(headDir, SHARD), head);
    if (base !== undefined) writeFileSync(join(baseDir, SHARD), base);
    fn(headDir, baseDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function grade(proof: string, head: string, base: string | undefined, report: string) {
  let verdict: ReturnType<typeof judgeCriterion> | undefined;
  trees(head, base, (cwd, baseCwd) => {
    const tokens = new Set(report.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    verdict = judgeCriterion({ claim: "the shard names the falsifier", proof }, tokens, undefined, { cwd, baseCwd });
  });
  return verdict!;
}

const ESCAPED_SHARD = '- id: W1-T9991\n  acceptance:\n    - proof: "grep: test(\\"a stranded reservation is settled\\" in test/x.test.ts"\n';
const ESCAPED_PROOF = `grep: test("a stranded reservation is settled" in ${SHARD}`;

test("a grep whose YAML escape hides text that is present is an advisory not a refusal", () => {
  const v = grade(ESCAPED_PROOF, ESCAPED_SHARD, undefined, `The filed shard names the falsifier. ${ESCAPED_PROOF}`);
  assert.equal(v.proof_exec, "not_executable");
  assert.equal(v.proof_skip, "proof-form");
  assert.ok(v.reason.includes(PROOF_FORM_ADVISORY), v.reason);
  assert.equal(v.met, true, "the keyword floor decides, and this report substantiates it");
});

test("a grep whose text a YAML block scalar wrapped is an advisory not a refusal", () => {
  const head = "- id: W1-T9991\n  rationale: >-\n    The console still needs a file-shaped\n    artifact for its index.\n";
  const v = grade(`grep: still needs a file-shaped artifact in ${SHARD}`, head, undefined, "");
  assert.equal(v.proof_skip, "proof-form");
  assert.equal(v.met, false, "an empty report does not substantiate it: the override is withdrawn, the floor is not skipped");
});

test("a grep regex escape that blocks a literal match is an advisory not a refusal", () => {
  const head = "- id: W1-T9991\n  design: call strikeRegimeForDispatch(review\\.criteria) once\n";
  const v = grade(`grep: strikeRegimeForDispatch(review\\.criteria) in ${SHARD}`, head, undefined, "");
  assert.equal(v.proof_skip, "proof-form");
});

test("a grep whose text is absent at head still fails", () => {
  const v = grade(`grep: a stranded reservation is settled in ${SHARD}`, "- id: W1-T9991\n", undefined, "a stranded reservation is settled");
  assert.equal(v.proof_exec, "executed_fail");
});

test("a corrected grep that also matches the merge-base still fails", () => {
  const v = grade(ESCAPED_PROOF, ESCAPED_SHARD, ESCAPED_SHARD, "stranded reservation settled");
  assert.equal(v.proof_exec, "executed_fail", "present at the base too — it discriminates nothing");
});

test("a grep whose only match is its own declaration line still fails", () => {
  const head = `- id: W1-T9991\n  acceptance:\n    - proof: 'grep: holds\\\\.the\\\\.line in ${SHARD}'\n`;
  const v = grade(`grep: holds\\.the\\.line in ${SHARD}`, head, undefined, "holds the line");
  assert.equal(v.proof_exec, "executed_fail", "W1-T3208: a shard may not certify itself by quoting its own proof");
});
