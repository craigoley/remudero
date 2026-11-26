/**
 * W1-T14934 — the shard-line proof matchers compare a YAML-PARSED proof to the shard's lines. A double-quoted scalar
 * holding `\"` or `\\` is stored escaped, so they must read each `proof:` line's parsed value, not its raw text, and the
 * writer must escape the replacement for the line's quoting style so the shard re-parses to the intended proof.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";

import { replaceProofScalar } from "#src/lib/proof-amendment.js";
import { claimForProof, insertPlanRepairFlag } from "#src/lib/sweep.js";

const CLAIM = "the drift ceiling stays 11";
const shard = (proofLine: string): string => [
  "- id: ZZ-ESC", "  acceptance:", `    - claim: "${CLAIM}"`, `      ${proofLine}`, "      kind: guard", "",
].join("\n");
const proofOf = (text: string): string => (parse(text) as Array<{ acceptance: Array<{ proof: string }> }>)[0]!.acceptance[0]!.proof;

test("W1-T14934 criterion 1: a shard proof holding escapes is found and replaced and reads the same after the write", () => {
  for (const line of [String.raw`proof: "grep: \"driftCeiling\": 11 in f"`, String.raw`proof: "grep: a\\b in f"`, `proof: 'grep: it''s "x" in f'`]) {
    const text = shard(line);
    const oldProof = proofOf(text);
    const newProof = String.raw`grep: "driftCeiling": 1\.1 \\ it's in f`;
    const replaced = replaceProofScalar(text, CLAIM, oldProof, newProof);
    assert.notEqual(replaced, undefined, `replaceProofScalar finds ${line}`);
    assert.equal(proofOf(replaced!), newProof, `the written shard parses to the new proof (${line})`);
    assert.equal(claimForProof(text, oldProof), CLAIM, `claimForProof finds ${line}`);
    const flagged = insertPlanRepairFlag(text, oldProof, "rmd:plan-repair");
    assert.notEqual(flagged, undefined, `insertPlanRepairFlag finds ${line}`);
    assert.match(flagged!, /# rmd:plan-repair\n {6}proof:/);
    assert.equal(proofOf(flagged!), oldProof);
  }
});

test("W1-T14934 criterion 2: a plain shard proof matches as today", () => {
  const text = shard("proof: unit test: the ceiling holds");
  const replaced = replaceProofScalar(text, CLAIM, "unit test: the ceiling holds", "unit test: the ceiling still holds");
  assert.equal(replaced, text.replace("unit test: the ceiling holds", "unit test: the ceiling still holds"));
  assert.equal(claimForProof(text, "unit test: the ceiling holds"), CLAIM);
  assert.equal(insertPlanRepairFlag(text, "unit test: the ceiling holds", "m"), text.replace("      proof:", "      # m\n      proof:"));
  assert.equal(replaceProofScalar(text, CLAIM, "unit test: absent", "x"), undefined);
  assert.equal(claimForProof(text, "unit test: absent"), undefined);
  // A quoted line YAML cannot read (an invalid escape) is matched literally, as before.
  const invalid = shard(String.raw`proof: "grep: a\q in f"`);
  assert.equal(claimForProof(invalid, String.raw`grep: a\q in f`), CLAIM);
  // A substring of a plain proof still matches literally, as before.
  assert.equal(claimForProof(text, "the ceiling holds"), CLAIM);
});
