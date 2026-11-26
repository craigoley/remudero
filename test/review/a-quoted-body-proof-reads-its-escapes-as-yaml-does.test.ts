import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { parseAcceptanceBlock } from "#src/lib/review.js";

// W1-T14913: a body proof in YAML double quotes must read as the record's YAML scalar does, or a body `kind: guard`
// finds no record row and is refused (core #20913).
test("a quoted body proof reads its escapes as yaml does", () => {
  const line = String.raw`grep: \"driftCeiling\": 11 in scripts/clock-sweep-baseline.json`;
  const body = `## Acceptance\n- claim: "the ceiling stays 11 \\\\ not raised"\n  proof: "${line}"\n  kind: guard\n`;
  const [criterion] = parseAcceptanceBlock(body);
  const record = parse(`proof: "${line}"\nclaim: "the ceiling stays 11 \\\\ not raised"\n`) as { proof: string; claim: string };
  assert.equal(criterion.proof, record.proof);
  assert.equal(criterion.proof, `grep: "driftCeiling": 11 in scripts/clock-sweep-baseline.json`);
  assert.equal(criterion.claim, record.claim);
});

test("an unquoted body proof keeps its backslashes", () => {
  const proof = String.raw`grep: a\"b\\c\.d in f`;
  const [criterion] = parseAcceptanceBlock(`## Acceptance\n- claim: plain\n  proof: ${proof}\n`);
  assert.equal(criterion.proof, proof);
  const [single] = parseAcceptanceBlock(`## Acceptance\n- claim: plain\n  proof: '${proof}'\n`);
  assert.equal(single.proof, proof);
});
