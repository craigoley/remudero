import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { ACCEPTANCE_BULLET_RE, replaceBodyProofs, rewriteBodyProof, rewriteCriterionProofs } from "#src/lib/body-repair.js";
import { renderAcceptanceBlock } from "#src/lib/plan-pr-emitter.js";
import { acceptanceCriteriaRead, acceptanceProofSpans, bodyProofSetDivergence, markUnbackedBodyGuards, parseAcceptanceBlock } from "#src/lib/review.js";
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const authorGate = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "acceptance-author-gate.mjs")).href)) as {
  trailerBodyProofDivergenceRefusal: (input: { body: string;
    taskAcceptanceForId?: (taskId: string) => readonly { claim: string; proof: string }[] | undefined }) => { defect?: string } | undefined;
};

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

// The sixth review of #20963: a human-edited body showed the same grep in a fenced YAML example above its only Acceptance
// proof, and the rewrite counted the example as a second proof and refused. A rewrite given the parser's own proof lines
// touches only the lines parseAcceptanceBlock reads; the example stays byte for byte.
test("a quoted body proof reads its escapes as yaml does, and a fenced example above the header is never rewritten", () => {
  const proofLine = String.raw`  proof: "grep: \"driftCeiling\": 1 in f"`;
  const example = ["Example record:", "", "```yaml", "- claim: the ceiling stays", proofLine, "```", ""].join("\n");
  const body = `${example}\n## Acceptance\n- claim: the ceiling stays\n${proofLine}\n`;
  const oldProof = parseAcceptanceBlock(body)[0]!.proof;
  assert.equal(oldProof, String.raw`grep: "driftCeiling": 1 in f`);
  assert.deepEqual(acceptanceProofSpans(body).map((span) => span?.line), [body.split("\n").indexOf(proofLine, example.split("\n").length)]);
  const newProof = String.raw`grep: "driftCeiling": 2 in f`;
  for (const fixed of [rewriteBodyProof(body, oldProof, newProof, acceptanceCriteriaRead),
    replaceBodyProofs(body, [{ oldProof, newProof }], acceptanceCriteriaRead)]) {
    assert.notEqual(fixed, undefined, "the active proof is found once");
    assert.ok(fixed!.startsWith(example), "the fenced example is left exactly as written");
    assert.deepEqual(parseAcceptanceBlock(fixed!).map((c) => c.proof), [newProof]);
  }
  assert.equal(acceptanceProofSpans("no header\n- a | grep: x in f\n").length, 0, "no Acceptance header, no proof line");
});

// The seventh review of #20963: a human edit gave two criteria the same wrapped grep. Matched by text, each rewrite saw two
// hits and left both wrapped. The plan round and wrappedGrepBodyRepair now rewrite the diagnosed criterion's own line.
test("a quoted body proof reads its escapes as yaml does, and two criteria sharing one wrapped grep are each rewritten on their own line", () => {
  const wrapped = `grep: "driftCeiling" in scripts/clock-sweep-baseline.json`;
  const bare = "grep: driftCeiling in scripts/clock-sweep-baseline.json";
  const rendered = renderAcceptanceBlock([{ claim: "first | one", proof: wrapped }, { claim: "second | two", proof: wrapped }]);
  const hand = `## Acceptance\n- claim: first\n  proof: ${wrapped}\n- claim: second\n  proof: "${wrapped.replace(/"/g, '\\"')}"\n`;
  for (const body of [rendered, hand]) {
    const criteria = parseAcceptanceBlock(body);
    assert.deepEqual(criteria.map((c) => c.proof), [wrapped, wrapped], `both criteria read the wrapped grep: ${body}`);
    assert.equal(rewriteBodyProof(body, wrapped, bare, acceptanceCriteriaRead), undefined, "a text match sees two lines and refuses");
    // One edit per call, as the plan round and wrappedGrepBodyRepair each send it, then both in one call.
    let repaired = body;
    for (const index of criteria.keys()) {
      const next = rewriteCriterionProofs(repaired, [{ index, oldProof: criteria[index]!.proof, newProof: bare }], acceptanceCriteriaRead);
      assert.notEqual(next, undefined, `criterion ${index + 1} is rewritten on its own line`);
      repaired = next!;
    }
    assert.deepEqual(parseAcceptanceBlock(repaired).map((c) => c.proof), [bare, bare], repaired);
    const both = rewriteCriterionProofs(body, criteria.map((c, index) => ({ index, oldProof: c.proof, newProof: bare })), acceptanceCriteriaRead);
    assert.deepEqual(parseAcceptanceBlock(both!).map((c) => c.proof), [bare, bare], String(both));
  }
  const one = renderAcceptanceBlock([{ claim: "only", proof: wrapped }]);
  assert.equal(acceptanceProofSpans(one)[1], undefined, "a criterion the body does not hold has no span");
  assert.equal(rewriteCriterionProofs(one, [{ index: 1, oldProof: wrapped, newProof: bare }], acceptanceCriteriaRead), undefined,
    "an edit for a criterion the body does not hold refuses the whole rewrite");
  assert.equal(rewriteCriterionProofs(one, [{ index: 0, oldProof: "grep: absent in f", newProof: bare }], acceptanceCriteriaRead),
    undefined, "a criterion that does not read the old proof is left alone");
});

// The eighth review of #20963: a human-edited numbered bullet repeated the old grep in its claim and its proof, and the
// line rewrite replaced the claim's copy. A rewrite given the parser's spans edits only the proof value it read.
test("a quoted body proof reads its escapes as yaml does, and a claim repeating the proof is never rewritten", () => {
  const old = "grep: driftCeiling in f";
  const fresh = "grep: driftCeiling\\b in f";
  const bodies = [
    `## Acceptance\n1. the claim names ${old} | ${old}\n`,
    `## Acceptance\n1) the claim names ${old} — ${old}\n`,
    `## Acceptance\n1. claim: the claim names ${old}\n   proof: ${old}\n`,
    `## Acceptance\n- claim: "the claim names ${old}"\n  proof: "${old}"\n`,
    `## Acceptance\n- claim: the claim names ${old}\n  proof: '${old}'\n`,
  ];
  let checked = 0;
  for (const body of bodies) {
    const [criterion] = parseAcceptanceBlock(body);
    if (criterion?.proof !== old) continue; // a separator this parser does not split is not this test's shape
    checked += 1;
    const claim = criterion.claim;
    assert.ok(claim.includes(old), `the claim repeats the proof: ${body}`);
    for (const fixed of [rewriteBodyProof(body, old, fresh, acceptanceCriteriaRead), replaceBodyProofs(body, [{ oldProof: old, newProof: fresh }], acceptanceCriteriaRead),
      rewriteCriterionProofs(body, [{ index: 0, oldProof: old, newProof: fresh }], acceptanceCriteriaRead)]) {
      assert.notEqual(fixed, undefined, body);
      const [after] = parseAcceptanceBlock(fixed!);
      assert.equal(after!.proof, fresh, `the proof is rewritten: ${fixed}`);
      assert.equal(after!.claim, claim, `the claim is left exactly as written: ${fixed}`);
    }
  }
  assert.ok(checked >= 4, `the numbered, labelled and quoted shapes all ran (${checked})`);
  const [span] = acceptanceProofSpans(bodies[0]!);
  assert.equal(bodies[0]!.split("\n")[span!.line]!.slice(span!.start, span!.end), old, "the span is the proof value as written");
});

// The ninth review of #20963: a taskless PR's author wrote a bare numbered bullet, `1. unit test: <title>`, whose one text is
// both its claim and its proof. Rewriting the proof's span rewrote the claim too, and the live writer saved it. Every
// rewrite now re-reads the body and keeps it only when every claim and every other proof is unchanged; a bare bullet is
// expanded into a `claim:` bullet holding its text byte for byte and a `proof:` line (the tenth review).
test("a quoted body proof reads its escapes as yaml does, and a bare bullet's proof rewrite keeps its claim byte for byte", () => {
  const title = "unit test: a bare bullet's claim is its proof";
  const body = `## Acceptance\n1. ${title}\n- claim: second\n  proof: grep: x in f\n`;
  const read = acceptanceCriteriaRead(body);
  assert.deepEqual(read.map((c) => [c.claim, c.proof]), [[title, title], ["second", "grep: x in f"]], "the bare bullet reads as both");
  assert.notEqual(read[0]!.span, undefined, "CONTROL: the bare bullet's proof has a span, so the rewrite reaches the re-read");
  const newProof = "unit test: a renamed title";
  for (const fixed of [rewriteBodyProof(body, title, newProof, acceptanceCriteriaRead),
    replaceBodyProofs(body, [{ oldProof: title, newProof }], acceptanceCriteriaRead),
    rewriteCriterionProofs(body, [{ index: 0, oldProof: title, newProof }], acceptanceCriteriaRead)]) {
    assert.notEqual(fixed, undefined);
    assert.deepEqual(acceptanceCriteriaRead(fixed!).map((c) => [c.claim, c.proof]), [[title, newProof], ["second", "grep: x in f"]],
      `the claim is kept byte for byte:\n${fixed}`);
    assert.ok(fixed!.includes(`1. claim: ${title}\n  proof: ${newProof}\n`), fixed);
  }
  // The labelled criterion beside it still rewrites in place, with its claim and the bare bullet unchanged.
  const fixed = rewriteCriterionProofs(body, [{ index: 1, oldProof: "grep: x in f", newProof: "grep: y in f" }], acceptanceCriteriaRead);
  assert.deepEqual(acceptanceCriteriaRead(fixed!).map((c) => [c.claim, c.proof]), [[title, title], ["second", "grep: y in f"]]);
});

// The tenth review of #20963: a standalone wrapped grep bullet on a GitHub filing PR (`- grep: "x" in f`) shares one span
// between claim and proof, so the in-place unwrap failed the re-read and the plan round left it wrapped.
test("a quoted body proof reads its escapes as yaml does, and a standalone wrapped grep bullet is unwrapped with its claim kept", () => {
  const wrapped = `grep: "driftCeiling" in scripts/clock-sweep-baseline.json`;
  const bare = "grep: driftCeiling in scripts/clock-sweep-baseline.json";
  const body = `## Acceptance\n- ${wrapped}\n`;
  assert.deepEqual(parseAcceptanceBlock(body).map((c) => [c.claim, c.proof]), [[wrapped, wrapped]]);
  const fixed = rewriteCriterionProofs(body, [{ index: 0, oldProof: wrapped, newProof: bare }], acceptanceCriteriaRead);
  assert.equal(fixed, `## Acceptance\n- claim: ${wrapped}\n  proof: ${bare}\n`);
  assert.deepEqual(parseAcceptanceBlock(fixed!).map((c) => [c.claim, c.proof]), [[wrapped, bare]]);
});

// The tenth review of #20963 (F2): before this change the renderer wrote a quoted proof's backslashes as they were, so a
// stored body rendered for a claim holding `|` says `"grep: a\\b in f"` and means two backslashes. Read at head, the
// unescape collapses them to one and the body's `kind: guard` no longer matches its record. It reads as written only
// when that, and not the unescaped text, is a record criterion's proof.
test("a quoted body proof reads its escapes as yaml does, and a legacy-rendered body's guard stays backed by its record", () => {
  const recordProof = String.raw`grep: a\\b in f`;
  const legacy = `## Acceptance\n- claim: "the split | holds"\n  proof: "${recordProof}"\n  kind: guard\n`;
  const body = parseAcceptanceBlock(legacy);
  assert.equal(body[0]!.proof, String.raw`grep: a\b in f`, "CONTROL: head's parser unescapes the legacy body");
  const record = [{ claim: "the split | holds", proof: recordProof, kind: "guard" }] as unknown as unknown as AcceptanceCriterion[];
  assert.deepEqual(markUnbackedBodyGuards(record, body, false).unbacked, [], "the legacy guard is backed by its record");
  // The fallback is narrow: when the unescaped text is the record's proof, it is read, and a raw match alone backs nothing.
  const escapedRecord = [{ claim: "x", proof: String.raw`grep: a\b in f`, kind: "guard" }] as unknown as unknown as AcceptanceCriterion[];
  assert.deepEqual(markUnbackedBodyGuards(escapedRecord, parseAcceptanceBlock(legacy), false).unbacked, []);
  const unguardedRecord = [{ claim: "the split | holds", proof: recordProof }] as unknown as unknown as AcceptanceCriterion[];
  assert.deepEqual(markUnbackedBodyGuards(unguardedRecord, parseAcceptanceBlock(legacy), false).unbacked, [recordProof],
    "a legacy body guard over a record criterion that is not a guard is still refused");
});

// The eleventh review of #20963 (F1): the author-time trailer/body comparison read the legacy body unescaped too, so a
// body and record main matched were refused as divergent. It shares review's helper, so it accepts exactly that body.
test("a quoted body proof reads its escapes as yaml does, and the author gate matches a legacy-rendered body as main does", () => {
  const recordProof = String.raw`grep: a\\b in f`;
  const trailer = "\n\nRemudero-Task: W1-T999913\n";
  const legacy = `## Acceptance\n- claim: "the split | holds"\n  proof: "${recordProof}"\n${trailer}`;
  const refusal = (body: string, proof: string) =>
    authorGate.trailerBodyProofDivergenceRefusal({ body, taskAcceptanceForId: () => [{ claim: "the split | holds", proof }] });
  assert.equal(refusal(legacy, recordProof), undefined, "the legacy body matches its record as written, as on main");
  // A current body, escaped as YAML escapes it, matches its record by the unescaped text.
  const current = `## Acceptance\n- claim: "the split | holds"\n  proof: "grep: a\\\\\\\\b in f"\n${trailer}`;
  assert.equal(parseAcceptanceBlock(current)[0]!.proof, recordProof, "CONTROL: the current body reads as the record by YAML");
  assert.equal(refusal(current, recordProof), undefined, "a current body matches by its YAML reading");
  // Nothing new is accepted: a body whose proof matches the record neither unescaped nor as written still refuses.
  assert.equal(refusal(legacy, String.raw`grep: a\\c in f`)?.defect, "trailer-body-proof-divergence");
  assert.equal(refusal(`## Acceptance\n- claim: x\n  proof: "grep: q in f"\n${trailer}`, recordProof)?.defect, "trailer-body-proof-divergence");
});

// The eleventh review of #20963 (F2): a standalone grep bullet wrapped in a code span reads its claim with the backticks
// and its proof without, so the claim-equals-proof test refused to expand it and the wrapped grep stayed.
test("a quoted body proof reads its escapes as yaml does, and a code-spanned standalone grep bullet is unwrapped with its claim kept", () => {
  const spanned = "`grep: \"driftCeiling\" in scripts/clock-sweep-baseline.json`";
  const wrapped = `grep: "driftCeiling" in scripts/clock-sweep-baseline.json`;
  const bare = "grep: driftCeiling in scripts/clock-sweep-baseline.json";
  const body = `## Acceptance\n- ${spanned}\n`;
  assert.deepEqual(parseAcceptanceBlock(body).map((c) => [c.claim, c.proof]), [[spanned, wrapped]], "CONTROL: the parser's reading");
  const fixed = rewriteCriterionProofs(body, [{ index: 0, oldProof: wrapped, newProof: bare }], acceptanceCriteriaRead);
  assert.equal(fixed, `## Acceptance\n- claim: ${spanned}\n  proof: ${bare}\n`);
  assert.deepEqual(parseAcceptanceBlock(fixed!).map((c) => [c.claim, c.proof]), [[spanned, bare]]);
});

// The twelfth review of #20963: a record with two grep proofs differing only by one versus two backslashes, published by
// the legacy renderer. Per row both unescape to one backslash and the set lost a declared proof; the body's as-written
// set equals the record's, so it is read as written first.
test("a quoted body proof reads its escapes as yaml does, and a legacy body of two proofs differing only by escaping still matches its record", () => {
  const two = String.raw`grep: a\\b in f`, one = String.raw`grep: a\b in f`;
  const trailer = "\n\nRemudero-Task: W1-T999913\n";
  const legacy = `## Acceptance\n- claim: "two | backslashes"\n  proof: "${two}"\n  kind: guard\n- claim: "one | backslash"\n  proof: "${one}"\n${trailer}`;
  const declared = [{ claim: "two | backslashes", proof: two, kind: "guard" }, { claim: "one | backslash", proof: one }];
  assert.deepEqual(parseAcceptanceBlock(legacy).map((c) => c.proof), [one, one], "CONTROL: per row both unescape to one backslash");
  assert.equal(authorGate.trailerBodyProofDivergenceRefusal({ body: legacy, taskAcceptanceForId: () => declared }), undefined,
    "the body main matched still matches");
  const record = declared as unknown as AcceptanceCriterion[];
  assert.deepEqual(markUnbackedBodyGuards(record, parseAcceptanceBlock(legacy), false).unbacked, [], "its guard stays backed");
  // Nothing new is accepted: a body that drops the one-backslash row is still a divergence.
  const dropped = `## Acceptance\n- claim: "two | backslashes"\n  proof: "${two}"\n${trailer}`;
  assert.equal(authorGate.trailerBodyProofDivergenceRefusal({ body: dropped, taskAcceptanceForId: () => declared })?.defect,
    "trailer-body-proof-divergence");
});

// The thirteenth review of #20963: run-task's acceptance normalizer compared the unescaped proofs itself, so a legacy body
// the author gate passed read as divergent there and was rewritten from the record, losing a claim edited on GitHub and
// its kind: guard line. Every body-versus-record proof-set comparison now calls bodyProofSetDivergence.
test("a quoted body proof reads its escapes as yaml does, and the run-task normalizer's comparison matches a legacy body as the author gate does", () => {
  const two = String.raw`grep: a\\b in f`, one = String.raw`grep: a\b in f`;
  const legacy = `## Acceptance\n- claim: "edited on GitHub | two"\n  proof: "${two}"\n  kind: guard\n- claim: "one | backslash"\n  proof: "${one}"\n\nRemudero-Task: W1-T999913\n`;
  const record = [two, one];
  const read = parseAcceptanceBlock(legacy);
  assert.deepEqual(read.map((c) => c.proof), [one, one], "CONTROL: per row both unescape to one backslash");
  const collapsed = new Set(read.map((c) => c.proof.trim()));
  assert.equal(record.every((p) => collapsed.has(p)), false, "CONTROL: the unescaped set alone loses a declared proof");
  assert.deepEqual(bodyProofSetDivergence(read, record), { onlyInBody: [], onlyInRecord: [] }, "the shared comparison finds no divergence");
  assert.equal(authorGate.trailerBodyProofDivergenceRefusal({ body: legacy, taskAcceptanceForId: () => record.map((proof) => ({ claim: "c", proof })) }),
    undefined, "the author gate agrees");
  // A body that really diverges still does, on both sides of the comparison.
  const dropped = `## Acceptance\n- claim: "two | backslashes"\n  proof: "${two}"\n`;
  // Its one row unescapes to a record proof, so it reads so, and the proof it no longer carries is the other one.
  assert.deepEqual(bodyProofSetDivergence(parseAcceptanceBlock(dropped), record), { onlyInBody: [], onlyInRecord: [two] });
  const added = `## Acceptance\n- claim: "x | y"\n  proof: "grep: other in f"\n- claim: "two | backslashes"\n  proof: "${two}"\n- claim: "one | backslash"\n  proof: "${one}"\n`;
  // A row written `a\\b` is a legacy two-backslash proof or a current one-backslash one; once the sets differ that is not
  // decidable per row, so only the divergence itself is pinned: the extra proof is named.
  assert.deepEqual(bodyProofSetDivergence(parseAcceptanceBlock(added), record).onlyInBody, ["grep: other in f"]);
});

// The fourteenth review of #20963: reading each row by whichever form matched let a body edited on GitHub pass when
// neither complete reading matched its record. One row written with four backslashes decodes to the record's two; the
// other, written with two, matches the record only as written. The as-written set and the decoded set both differ from
// the record, so the body diverges, everywhere the comparison is made.
test("a quoted body proof reads its escapes as yaml does, and a body matching its record only by mixing readings row by row is refused", () => {
  const x2 = String.raw`grep: x\\y in f`, p2 = String.raw`grep: p\\q in f`;
  const x4 = String.raw`grep: x\\\\y in f`, p1 = String.raw`grep: p\q in f`;
  const record = [x2, p2];
  const mixed = `## Acceptance\n- claim: "x | y"\n  proof: "${x4}"\n  kind: guard\n- claim: "p | q"\n  proof: "${p2}"\n\nRemudero-Task: W1-T999913\n`;
  const read = parseAcceptanceBlock(mixed);
  assert.deepEqual(read.map((c) => c.proof), [x2, p1], "CONTROL: decoded, only the first row is a record proof");
  const divergence = bodyProofSetDivergence(read, record);
  assert.ok(divergence.onlyInBody.length > 0 && divergence.onlyInRecord.length > 0, JSON.stringify(divergence));
  assert.equal(authorGate.trailerBodyProofDivergenceRefusal({ body: mixed, taskAcceptanceForId: () => record.map((proof) => ({ claim: "c", proof })) })?.defect,
    "trailer-body-proof-divergence", "the author gate refuses it");
  const guarded = record.map((proof, i) => ({ claim: "c", proof, ...(i === 0 ? { kind: "guard" } : {}) })) as unknown as AcceptanceCriterion[];
  assert.equal(markUnbackedBodyGuards(guarded, parseAcceptanceBlock(mixed), false).unbacked.length, 0,
    "CONTROL: its guard row decodes to the record's guard proof, so it stays backed under the decoded reading");
  // A wholly legacy body still reads as written: both rows written as the legacy renderer wrote them.
  const legacy = `## Acceptance\n- claim: "x | y"\n  proof: "${x2}"\n- claim: "p | q"\n  proof: "${p2}"\n`;
  assert.deepEqual(bodyProofSetDivergence(parseAcceptanceBlock(legacy), record), { onlyInBody: [], onlyInRecord: [] });
});
