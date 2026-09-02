// test/retro-acceptance-block-shape.test.ts
//
// W1-T2437 — THE RETRO'S ACCEPTANCE BLOCK IS AUTHORED BY AN AGENT, NOT RENDERED BY CODE.
// `renderAcceptanceBlock` (lib/plan-pr-emitter.ts) gives the plan-FILING lane "one bullet per
// line" and nothing else BY CONSTRUCTION, but `retro.ts` builds no PR body at all — it does not
// import plan-pr-emitter — so that guarantee is structurally unreachable from `rmd retro`. The
// spawned Architect worker hand-writes the `Acceptance:` block from `retroPrompt()`'s own prose
// (src/run-task.ts), and two DISTINCT defects have shipped from that lane on the same PR
// (#3191): a claim wrapped onto a continuation line (`parseAcceptanceBlock` ends the block right
// there, discarding every bullet after it — `unparseable`), and separately, a proof carrying no
// recognised dialect prefix (capped at review time as `no-dialect`, even though the block itself
// parsed perfectly clean).
//
// WHAT THIS SUITE DOES AND DOES NOT PROVE (test/proof-grammar.test.ts's own framing, repeated
// here because it applies just as much): a PROMPT'S EFFECTIVENESS IS NOT UNIT-TESTABLE — nothing
// here simulates an LLM, and no assertion pins exact wording. Instead:
//
//   (1) `retroPrompt()` is required to CARRY the new shape+dialect rules verbatim — the only part
//       a revert of the wiring trips.
//   (2) The two proof FORMS those rules teach are instantiated the way a worker would and run
//       through the REAL dialect predicates (`isDialectPrefixed`/`parseWhitelistedProof`,
//       lib/review.ts) — the same functions `remudero-review` itself runs.
//   (3) The wrap and the missing-dialect failures are shown to be genuinely SEPARATE, using the
//       REAL, already-shipped functions that catch each one (`acceptanceAuthorTimeCheck`,
//       W1-T1060, for the wrap; `isDialectPrefixed`/`parseWhitelistedProof` for the dialect) — no
//       new gate or repair code is added by this task, and none is exercised here.
//   (4) The plan-FILING lane's own body assembly (`renderAcceptanceBlock`/`buildPlanPrBody`,
//       lib/plan-pr-emitter.ts) is locked against a fixed input/output pair, proving this task
//       left that module untouched.

import assert from "node:assert/strict";
import { test } from "node:test";

import { RETRO_ACCEPTANCE_BLOCK_GRAMMAR, retroPrompt } from "../src/run-task.js";
import {
  acceptanceAuthorTimeCheck,
  isDialectPrefixed,
  parseAcceptanceBlock,
  parseWhitelistedProof,
  wrappedGrepPattern,
} from "../src/lib/review.js";
import { buildPlanPrBody, renderAcceptanceBlock } from "../src/lib/plan-pr-emitter.js";

// ── 1. retroPrompt() actually carries the new rules ─────────────────────────────────────────

test("retroPrompt carries the retro acceptance-block shape+dialect grammar verbatim", () => {
  const prompt = retroPrompt("a fake deterministic gather", "a fake calibration table", "RETRO-1700000000000");
  assert.ok(RETRO_ACCEPTANCE_BLOCK_GRAMMAR.length > 0, "the grammar constant must not be empty");
  for (const line of RETRO_ACCEPTANCE_BLOCK_GRAMMAR) {
    assert.ok(
      prompt.includes(line),
      `retroPrompt is missing a grammar line: ${line.trim().slice(0, 70)}`,
    );
  }
});

test("retroPrompt still names all four required claims (this task narrows SHAPE, not CONTENT)", () => {
  const prompt = retroPrompt("gather", "cal", "RETRO-1700000000000");
  for (const phrase of ["SHIPPED log added", "NET STATE refreshed", "calibration table", "COMPRESSION"]) {
    assert.ok(prompt.includes(phrase), `retroPrompt dropped required content: ${phrase}`);
  }
});

// ── 5. no claim text is generated, altered or supplied by anything this task adds ───────────

test("the grammar this task adds is a TEMPLATE only — it supplies no filled-in claim of its own", () => {
  const text = RETRO_ACCEPTANCE_BLOCK_GRAMMAR.join("\n");
  // A worked, CONCRETE bullet (one of the four real retro claims, filled in) would mean this
  // task's own text is authoring content rather than constraining shape. Only placeholder forms
  // (`<claim>`, `<pattern>`, `<path>`, `<what a human can check>`) may appear.
  for (const concreteClaim of [/-\s*SHIPPED log entries added for #\d/i, /-\s*NET STATE section refreshed \|/i, /-\s*calibration table added with/i, /-\s*COMPRESSION:\s*folded/i]) {
    assert.equal(concreteClaim.test(text), false, `grammar text supplies a filled-in claim: ${concreteClaim}`);
  }
  assert.ok(text.includes("<claim>"), "the grammar must teach the bullet SHAPE via a placeholder, not a real bullet");
  assert.ok(text.includes("<pattern>") && text.includes("<path>"), "the grep form must stay a template");
  assert.ok(text.includes("<what a human can check>"), "the demonstration form must stay a template");
});

// ── 2. the two proof forms the grammar teaches parse under the real dialect predicates ──────

/** Every proof template the grammar shows, lifted OUT of the text itself (mirrors
 *  test/proof-grammar.test.ts's `proofFormsInGrammar`) — so a rewording is checked against
 *  itself, never against a copy that can silently go stale. */
function proofFormsInGrammar(): string[] {
  const forms: string[] = [];
  for (const line of RETRO_ACCEPTANCE_BLOCK_GRAMMAR) {
    const m = /^\s*((?:grep|demonstration):.+?)\s+—/.exec(line);
    if (m) forms.push(m[1]);
  }
  return forms;
}

const PLACEHOLDERS: ReadonlyArray<[string, string]> = [
  ["<pattern>", "as of 2026-08-28"],
  ["<path>", "MASTER-PLAN.md"],
  ["<what a human can check>", "MASTER-PLAN.md's Retro proposals section shrank by 12 lines this cycle"],
];

function instantiate(template: string): string {
  return PLACEHOLDERS.reduce((acc, [from, to]) => acc.split(from).join(to), template);
}

test("the grammar's grep form parses under the real parseWhitelistedProof and carries a dialect", () => {
  const forms = proofFormsInGrammar();
  assert.equal(forms.length, 2, `expected exactly the grep and demonstration forms, found ${forms.length}`);
  const grepForm = instantiate(forms.find((f) => f.startsWith("grep:"))!);
  assert.ok(isDialectPrefixed(grepForm), `grammar's grep form is not recognised as dialect-prefixed: "${grepForm}"`);
  const parsed = parseWhitelistedProof(grepForm);
  assert.ok(parsed, `the grammar teaches a grep proof the real parser REFUSES: "${grepForm}"`);
  assert.equal(parsed!.kind, "grep");
});

test("the grammar never teaches the literal quote wrapper that made PR #3591 fail 10 executed proofs", () => {
  const forms = proofFormsInGrammar();
  const grepForm = instantiate(forms.find((f) => f.startsWith("grep:"))!);
  assert.equal(wrappedGrepPattern(grepForm), undefined, `retro prompt still wraps its grep pattern: ${grepForm}`);
  assert.ok(
    RETRO_ACCEPTANCE_BLOCK_GRAMMAR.join("\n").includes("do not wrap"),
    "the producer must name the delimiter consequence, not rely on an example alone",
  );
});

test("the grammar's demonstration form is dialect-recognised but never executed, by design (W1-T277)", () => {
  const forms = proofFormsInGrammar();
  const demoForm = instantiate(forms.find((f) => f.startsWith("demonstration:"))!);
  assert.ok(isDialectPrefixed(demoForm), `grammar's demonstration form is not recognised as dialect-prefixed: "${demoForm}"`);
  // demonstration: is deliberately never executable — parseWhitelistedProof always returns null
  // for it (review.ts, W1-T277) — this is NOT the no-dialect defect, it is the honest opposite.
  assert.equal(parseWhitelistedProof(demoForm), null);
});

// ── 3./4. the wrap and the missing dialect are two SEPARATE, already-real failure modes ─────

/** Byte-identical in SHAPE to test/acceptance-author-gate.test.ts's own WRAPPED_BODY fixture: a
 *  claim long enough to wrap, with a `proof:` continuation line for the FIRST bullet only. Every
 *  proof here IS dialect-prefixed, so if this were refused for dialect reasons the wrap test
 *  below would be proving the wrong thing — it must fail on the wrap alone. */
const WRAPPED_BODY = `Acceptance:

- claim: SHIPPED log entries added for every PR merged since the last marker, each carrying
  its own working link back to that PR
  proof: grep: SHIPPED in MASTER-PLAN.md
- claim: NET STATE section refreshed
  proof: grep: as of in MASTER-PLAN.md
- claim: calibration table added with the observed counts
  proof: grep: CALIBRATION TABLE in MASTER-PLAN.md
`;

/** One criterion per PHYSICAL LINE, exactly what RETRO_ACCEPTANCE_BLOCK_GRAMMAR requires — no
 *  wrap anywhere, and every proof opens with a recognised dialect. */
const COMPLIANT_BODY = `Acceptance:
- SHIPPED log entries added for every PR merged since the last marker | grep: SHIPPED in MASTER-PLAN.md
- NET STATE section refreshed | grep: as of in MASTER-PLAN.md
- calibration table added with the observed counts | grep: CALIBRATION TABLE in MASTER-PLAN.md
- COMPRESSION: folded the stale W1-T900 note into its successor | demonstration: MASTER-PLAN.md's diff removes the superseded W1-T900 paragraph
`;

/** Same one-bullet-per-line SHAPE as COMPLIANT_BODY (so the author-time gate has nothing shape-
 *  wise to object to) but the second proof is ordinary prose, carrying no dialect prefix at all. */
const NO_DIALECT_BODY = `Acceptance:
- SHIPPED log entries added for every PR merged since the last marker | grep: SHIPPED in MASTER-PLAN.md
- NET STATE section refreshed | the section now describes the fleet as it actually is today
`;

test("a claim wrapped onto a continuation line is refused by the real author-time gate (unparseable)", () => {
  const result = acceptanceAuthorTimeCheck(WRAPPED_BODY);
  assert.equal(result.ok, false);
  assert.equal(result.defect, "unparseable");
});

test("the block a compliant retro produces round-trips through the parser the reviewer uses", () => {
  const result = acceptanceAuthorTimeCheck(COMPLIANT_BODY);
  assert.equal(result.ok, true, result.message);
  const parsed = parseAcceptanceBlock(COMPLIANT_BODY);
  assert.equal(parsed.length, 4, "one criterion per physical line — none dropped by a wrap");
  for (const c of parsed) {
    assert.ok(c.proof.length > 0, `criterion "${c.claim}" resolved with an empty proof`);
    assert.ok(isDialectPrefixed(c.proof), `criterion "${c.claim}"'s proof carries no recognised dialect: "${c.proof}"`);
    assert.equal(wrappedGrepPattern(c.proof), undefined, `criterion "${c.claim}" copied a literal proof wrapper`);
  }
});

test("a proof with no recognised dialect is a SEPARATE failure the author-time gate does not catch", () => {
  // The shape gate passes: no wrap, no empty proof — exactly the W1-T1060/#3191 lesson that
  // `no-dialect` is a REVIEW verdict, not a gate defect, and must not be conflated with the wrap.
  const gate = acceptanceAuthorTimeCheck(NO_DIALECT_BODY);
  assert.equal(gate.ok, true, `expected the shape gate to pass (dialect is not its concern): ${gate.message}`);

  const parsed = parseAcceptanceBlock(NO_DIALECT_BODY);
  assert.equal(parsed.length, 2);
  const [shipped, netState] = parsed;
  assert.ok(isDialectPrefixed(shipped.proof) && parseWhitelistedProof(shipped.proof), "the first proof is a healthy grep dialect proof (control)");
  assert.equal(isDialectPrefixed(netState.proof), false, "the second proof unexpectedly carries a dialect prefix");
  assert.equal(parseWhitelistedProof(netState.proof), null, "prose with no dialect label must not parse as executable");
});

// ── 6. the plan filing lane's own body shape is unchanged ───────────────────────────────────

test("renderAcceptanceBlock/buildPlanPrBody (the plan-filing lane) are byte-identical to before this task", () => {
  const criteria = [
    { claim: "W1-T9999 filed as a well-formed plan task shard, not (yet) implemented", proof: "unit test: test/fixture.test.ts" },
  ];
  const body = buildPlanPrBody({ intro: "Filing W1-T9999.", criteria });
  assert.equal(
    body,
    "Filing W1-T9999.\n\nAcceptance:\n- W1-T9999 filed as a well-formed plan task shard, not (yet) implemented | unit test: test/fixture.test.ts\n",
  );
  // Still guaranteed to round-trip, unchanged — this task never touches plan-pr-emitter.ts.
  const parsed = parseAcceptanceBlock(body);
  assert.deepEqual(parsed, criteria);
  assert.equal(renderAcceptanceBlock(criteria), "Acceptance:\n- W1-T9999 filed as a well-formed plan task shard, not (yet) implemented | unit test: test/fixture.test.ts");
});
