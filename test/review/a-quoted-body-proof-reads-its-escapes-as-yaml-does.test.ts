import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { ACCEPTANCE_BULLET_RE, replaceBodyProofs, rewriteBodyProof } from "#src/lib/body-repair.js";
import { renderAcceptanceBlock } from "#src/lib/plan-pr-emitter.js";
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

// The reviewer's finding on #20963: replaceBodyProofs matched the raw line, so a proof written inside double quotes
// with an escape was never found, and a replacement written there unescaped re-read differently.
test("a body proof inside double quotes is replaced by its parsed value and re-read exactly", () => {
  const cases: Array<[string, string]> = [
    [String.raw`grep: "driftCeiling": 11 in f`, String.raw`grep: "driftCeiling": 12 in f`],
    [String.raw`grep: a\.b | c in f`, String.raw`grep: a\.d | e in f`],
    ["unit test: plain title", String.raw`grep: back\slash "and quote" in f`],
  ];
  for (const [oldProof, newProof] of cases) {
    const body = renderAcceptanceBlock([{ claim: "a | b", proof: oldProof }]);
    assert.equal(parseAcceptanceBlock(body)[0]!.proof, oldProof, "the fixture body parses to the old proof");
    const repaired = replaceBodyProofs(body, [{ oldProof, newProof }]);
    assert.notEqual(repaired, undefined, `found ${oldProof}`);
    assert.equal(parseAcceptanceBlock(repaired!)[0]!.proof, newProof);
  }
});

test("an unquoted body proof is still replaced literally", () => {
  const body = `## Acceptance\n- claim: plain\n  proof: grep: a\\"b in f\n`;
  const repaired = replaceBodyProofs(body, [{ oldProof: 'grep: a\\"b in f', newProof: 'grep: c\\"d in f' }]);
  assert.equal(parseAcceptanceBlock(repaired!)[0]!.proof, 'grep: c\\"d in f');
  assert.equal(replaceBodyProofs(body, [{ oldProof: "grep: absent in f", newProof: "x" }]), undefined);
});

// The second review of #20963: a quoted line not written in canonical escapes (a lone `\.` beside `\"`) was not found,
// and a replacement into a non-canonical quoted line was written unescaped.
test("a non-canonical quoted body proof is found by its parsed value and rewritten escaped", () => {
  const mixed = String.raw`## Acceptance` + "\n- claim: the ceiling stays\n" + String.raw`  proof: "grep: \"driftCeiling\": 1\.5 in f"` + "\n";
  const oldMixed = parseAcceptanceBlock(mixed)[0]!.proof;
  assert.equal(oldMixed, String.raw`grep: "driftCeiling": 1\.5 in f`);
  const newMixed = String.raw`grep: "driftCeiling": 2\.5 in f`;
  const fixed = replaceBodyProofs(mixed, [{ oldProof: oldMixed, newProof: newMixed }]);
  assert.notEqual(fixed, undefined, "the mixed-escape line is found");
  assert.equal(parseAcceptanceBlock(fixed!)[0]!.proof, newMixed);

  const lone = "## Acceptance\n- claim: the dot is literal\n" + String.raw`  proof: "grep: a\.b in f"` + "\n";
  const oldLone = parseAcceptanceBlock(lone)[0]!.proof;
  const newLone = String.raw`grep: a\\b in f`;
  const rewritten = replaceBodyProofs(lone, [{ oldProof: oldLone, newProof: newLone }]);
  assert.equal(parseAcceptanceBlock(rewritten!)[0]!.proof, newLone, "a newProof holding \\\\ re-reads exactly");
});

// The third review of #20963: a double-quoted proof line holding UNESCAPED inner quotes (a hand edit) is read by its
// whole quoted value, and a wrapped grep in a rendered pipe-form block is found although its quotes are escaped.
test("a hand-quoted body proof and a rendered wrapped grep are rewritten by the value they parse to", () => {
  const hand = "## Acceptance\n- claim: the ceiling stays\n" + String.raw`  proof: "grep: "x" in f"` + "\n";
  const oldHand = parseAcceptanceBlock(hand)[0]!.proof;
  assert.equal(oldHand, `grep: "x" in f`);
  const newHand = String.raw`grep: a\\b in f`;
  const fixed = replaceBodyProofs(hand, [{ oldProof: oldHand, newProof: newHand }]);
  assert.notEqual(fixed, undefined, "the hand-quoted line is found");
  assert.equal(parseAcceptanceBlock(fixed!)[0]!.proof, newHand, "and the replacement re-reads exactly");

  // wrappedGrepBodyRepair and the plan round rewrite through rewriteBodyProof: a wrapped grep in a rendered pipe-form
  // block is written with escaped quotes, and is still found by the proof it parses to.
  const wrapped = `grep: "driftCeiling" in scripts/clock-sweep-baseline.json`;
  const rendered = renderAcceptanceBlock([{ claim: "a | b", proof: wrapped }]);
  const repaired = rewriteBodyProof(rendered, parseAcceptanceBlock(rendered)[0]!.proof, "grep: driftCeiling in scripts/clock-sweep-baseline.json");
  assert.notEqual(repaired, undefined, "the wrapped grep is found in the rendered block");
  assert.equal(parseAcceptanceBlock(repaired!)[0]!.proof, "grep: driftCeiling in scripts/clock-sweep-baseline.json");
  assert.equal(rewriteBodyProof(rendered, "grep: absent in f", "x"), undefined, "a proof the body does not carry is not guessed at");
});

test("a body proof on every bullet shape the parser reads is rewritten, and the parser reads the replacement", () => {
  const oldProof = 'grep: "x" in f';
  const newProof = "grep: y in g";
  // Every shape ACCEPTANCE_BULLET_RE admits (`-`, `*`, `1.`, `1)`), single-line and as a `- claim:` with a `proof:` line.
  const bodies = [
    `## Acceptance\n- claim one | ${oldProof}\n`,
    `## Acceptance\n* claim one | ${oldProof}\n`,
    `## Acceptance\n1. claim one | ${oldProof}\n`,
    `## Acceptance\n1) claim one | ${oldProof}\n`,
    `## Acceptance\n12. claim one | ${oldProof}\n`,
    `## Acceptance\n  - claim one | ${oldProof}\n`,
    `## Acceptance\n1. claim: claim one\n   proof: ${oldProof}\n`,
    `## Acceptance\n2) claim: "claim one"\n   proof: "grep: \\"x\\" in f"\n`,
  ];
  for (const body of bodies) {
    assert.equal(parseAcceptanceBlock(body)[0]?.proof, oldProof, `the parser reads the old proof from ${JSON.stringify(body)}`);
    const rewritten = rewriteBodyProof(body, oldProof, newProof);
    assert.ok(rewritten !== undefined, `rewritten: ${JSON.stringify(body)}`);
    assert.equal(parseAcceptanceBlock(rewritten)[0]?.proof, newProof, `re-read: ${JSON.stringify(rewritten)}`);
  }
  for (const line of ["- a", "* a", "1. a", "1) a", "12. a", "  - a"]) assert.equal(ACCEPTANCE_BULLET_RE.test(line), true, line);
  for (const line of ["+ a", "-a", "1.a", "a. b", "proof: a", "- "]) assert.equal(ACCEPTANCE_BULLET_RE.test(line), false, line);
  assert.equal(rewriteBodyProof(`## Acceptance\n+ claim one | ${oldProof}\n`, oldProof, newProof), undefined,
    "a `+` line is no bullet the parser reads, so nothing there is rewritten");
});

test("numbered acceptance bullets are rewritten like the parser reads them", () => {
  for (const marker of ["1.", "1)"]) {
    const oldProof = String.raw`grep: "x" in f`;
    const newProof = String.raw`grep: "y" in f`;
    const body = `## Acceptance\n${marker} claim | ${oldProof}\n`;
    assert.equal(parseAcceptanceBlock(body)[0]!.proof, oldProof);
    const repaired = rewriteBodyProof(body, oldProof, newProof);
    assert.notEqual(repaired, undefined, `${marker} bullet is found`);
    assert.equal(parseAcceptanceBlock(repaired!)[0]!.proof, newProof);
  }
});

test("a fenced proof example before Acceptance is not counted as an active proof", () => {
  const oldProof = String.raw`grep: \"driftCeiling\": 11 in scripts/clock-sweep-baseline.json`;
  const newProof = String.raw`grep: \"driftCeiling\": 12 in scripts/clock-sweep-baseline.json`;
  const body = [
    "```yaml",
    `- claim: example only`,
    `  proof: "${oldProof}"`,
    "```",
    "## Acceptance",
    `- claim: active guard` ,
    `  proof: "${oldProof}"`,
    "  kind: guard",
    "",
    "## Validation",
    `- claim: later prose | ${oldProof}`,
  ].join("\n");
  assert.equal(parseAcceptanceBlock(body)[0]!.proof, `grep: "driftCeiling": 11 in scripts/clock-sweep-baseline.json`);
  const rewritten = rewriteBodyProof(body, parseAcceptanceBlock(body)[0]!.proof, `grep: "driftCeiling": 12 in scripts/clock-sweep-baseline.json`);
  assert.notEqual(rewritten, undefined, "the fenced sample and later section do not create duplicate matches");
  assert.equal(parseAcceptanceBlock(rewritten!)[0]!.proof, `grep: "driftCeiling": 12 in scripts/clock-sweep-baseline.json`);
  assert.ok(rewritten!.includes(`  proof: "${newProof}"`), "the active proof line is escaped and rewritten");
  assert.ok(rewritten!.includes(`  proof: "${oldProof}"`), "the fenced example remains untouched");
});
