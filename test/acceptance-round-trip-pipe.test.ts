// test/acceptance-round-trip-pipe.test.ts
//
// THE DEFECT, measured at f7ceb86 (recon-2026-09-05 R-13). `renderAcceptanceBlock`
// (`src/lib/plan-pr-emitter.ts`) emitted `- ${claim} | ${proof}` with no escaping, and
// `parseAcceptanceBlock` (`src/lib/review.ts`) split each bullet at the FIRST bare `|`. A claim
// carrying a pipe of its own — a `|| true` it is quoting, a BRE alternation, a markdown table
// fragment — was therefore truncated at that pipe, and everything after it, INCLUDING the real
// proof, became the "proof". `parseWhitelistedProof` refuses that as prose, so the criterion fell
// silently to the keyword floor: no dialect error, no empty proof, `acceptanceAuthorTimeCheck`
// still `ok`, and nothing anywhere said the proof had stopped executing.
//
// It is live in the plan, not hypothetical: W1-T2781's second criterion quotes `|| true` and is
// read from its real shard below rather than paraphrased, so this test tracks the plan instead of
// asserting against a copy that can drift.
//
// THE FIX HAS TWO HALVES AND EACH IS LOAD-BEARING HERE:
//   - the PARSER now splits at the LAST ` | ` (pipe with a space on each side) — the separator
//     the emitter actually writes — so a pipe inside a claim survives whenever the proof carries
//     none. Deleting this reddens "a claim quoting `|| true`" below.
//   - the EMITTER now falls back to the `- claim: "…"` / indented `  proof: "…"` shape whenever
//     EITHER side contains a `|`, because a pipe in the PROOF still moves the last-` | ` split
//     into the proof. Deleting this reddens "a pipe inside the proof" below.
// The third test locks the far more common no-pipe body: byte-identical render, identical parse.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { renderAcceptanceBlock } from "../src/lib/plan-pr-emitter.js";
import {
  acceptanceAuthorTimeCheck,
  acceptanceBlockDiagnostics,
  parseAcceptanceBlock,
  parseWhitelistedProof,
} from "../src/lib/review.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";

const SHARD = fileURLToPath(
  new URL("../plan/tasks.d/W1-T2781-the-mkdtemp-callsite-check-is-not-run-by-ci.yaml", import.meta.url),
);

/** W1-T2781's own acceptance criteria, as the plan carries them today. */
function shardCriteria(): AcceptanceCriterion[] {
  const tasks = parseYaml(readFileSync(SHARD, "utf8")) as Array<{
    id: string;
    acceptance?: Array<{ claim: string; proof: string }>;
  }>;
  const task = tasks.find((t) => t.id === "W1-T2781");
  assert.ok(task?.acceptance?.length, "W1-T2781's shard must carry acceptance criteria");
  return task.acceptance.map(({ claim, proof }) => ({ claim, proof }));
}

/** Render one criterion into a realistic PR body and read it back out. */
function roundTrip(criterion: AcceptanceCriterion): AcceptanceCriterion[] {
  const body = `## Summary\n\nDoes a thing.\n\n${renderAcceptanceBlock([criterion])}\n\nRemudero-Task: none\n`;
  return parseAcceptanceBlock(body);
}

test("a claim quoting `|| true` survives the render/parse round trip with its proof still executable", () => {
  const criteria = shardCriteria();
  const piped = criteria.filter((c) => c.claim.includes("|"));
  assert.ok(
    piped.length > 0,
    "W1-T2781's shard is the live instance this task exists for — a criterion whose CLAIM contains a `|`",
  );

  for (const criterion of piped) {
    const parsed = roundTrip(criterion);
    assert.equal(parsed.length, 1, `one criterion in, one out: ${JSON.stringify(criterion.claim)}`);
    assert.equal(parsed[0].claim, criterion.claim, "the claim must arrive whole, not truncated at its own pipe");
    assert.equal(parsed[0].proof, criterion.proof, "the proof must arrive whole");
    assert.ok(
      parseWhitelistedProof(parsed[0].proof),
      `the round-tripped proof must still be executable, not prose: ${JSON.stringify(parsed[0].proof)}`,
    );
  }
});

test("a pipe inside the PROOF survives the round trip too — the split never lands inside the proof", () => {
  // A `grep:` pattern is a BRE handed to execFile as one argv element, so it can hold anything —
  // including the ` | ` this very file is about, which is what a proof searching for an emitted
  // acceptance bullet looks like. Scanning for the LAST ` | ` is NOT enough on its own: that last
  // one is inside the proof. What decides the split is which side reads as a dialect proof.
  const criterion: AcceptanceCriterion = {
    claim: "the emitted acceptance bullet keeps its documented separator",
    proof: "grep: claim | proof in src/lib/review.ts",
  };
  const parsed = roundTrip(criterion);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].claim, criterion.claim, "the claim must not swallow the proof's dialect prefix");
  assert.equal(parsed[0].proof, criterion.proof, "the proof must arrive whole, pipe included");
  assert.ok(
    parseWhitelistedProof(parsed[0].proof),
    `the round-tripped proof must still be executable, not prose: ${JSON.stringify(parsed[0].proof)}`,
  );
});

test("pipes on BOTH sides round-trip — claim separator and proof separator are told apart", () => {
  // Every candidate split here has a rival: the claim quotes the house separator, and the proof's
  // BRE holds another. What resolves it is the dialect prefix — the ` | ` immediately before
  // `grep:` is the only split whose right-hand side reads as a proof at all.
  const criterion: AcceptanceCriterion = {
    claim: "the house bullet is documented as `- <claim> | <proof>`",
    proof: "grep: claim | proof in src/lib/review.ts",
  };
  const parsed = roundTrip(criterion);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].claim, criterion.claim, "the claim must arrive whole, its own separator included");
  assert.equal(parsed[0].proof, criterion.proof, "the proof must arrive whole");
  assert.ok(parseWhitelistedProof(parsed[0].proof), "the round-tripped proof must still be executable");
});

test("a claim QUOTING a dialect-looking fragment after a pipe still round-trips — the emitter stops guessing", () => {
  // THE CASE THE PARSER CANNOT WIN, and the reason `renderAcceptanceBlock` changes shape rather
  // than leaning on it. `acceptanceSeparator` resolves an ambiguous bullet by asking which split
  // yields a dialect proof; a claim that QUOTES a dialect prefix after a `|` — routine in this
  // repo, whose acceptance claims are largely about proof syntax — makes the earlier, wrong split
  // answer yes too, and the historical first-`|` reading wins it. Nothing downstream can recover
  // the author's intent from that line, so the emitter never writes the line: with both sides
  // quoted on their own labelled lines there is no separator to resolve. Deleting the emitter's
  // shape switch reddens this test; deleting the parser rule reddens the three above.
  const criterion: AcceptanceCriterion = {
    claim: "a bullet written `- claim|unit test: fabricated` is refused rather than executed",
    proof: "unit test: test/acceptance-round-trip-pipe.test.ts",
  };
  const parsed = roundTrip(criterion);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].claim, criterion.claim, "the claim must arrive whole, quoted fragment included");
  assert.equal(parsed[0].proof, criterion.proof, "the proof must be the author's, not the fragment the claim quotes");
  assert.ok(parseWhitelistedProof(parsed[0].proof), "the round-tripped proof must still be executable");
});

test("a body whose criteria carry NO pipe renders byte-identically and parses identically", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "alpha does a thing", proof: "unit test: test/acceptance-round-trip-pipe.test.ts" },
    { claim: "beta does another", proof: "grep: acceptanceSeparator in src/lib/review.ts" },
  ];
  const block = renderAcceptanceBlock(criteria);
  assert.equal(
    block,
    [
      "Acceptance:",
      "- alpha does a thing | unit test: test/acceptance-round-trip-pipe.test.ts",
      "- beta does another | grep: acceptanceSeparator in src/lib/review.ts",
    ].join("\n"),
    "the pipe-free house form is untouched — one bullet per criterion, ` | ` separated",
  );
  assert.deepEqual(parseAcceptanceBlock(block), criteria);
});

test("both emitted shapes pass the author-time gate a PR body is actually judged by", () => {
  for (const criterion of [
    ...shardCriteria().filter((c) => c.claim.includes("|")),
    { claim: "a BRE alternation in the proof", proof: "grep: alpha\\|beta in src/lib/review.ts" },
    { claim: "a spaced pipe in the proof", proof: "grep: claim | proof in src/lib/review.ts" },
    { claim: "no pipe anywhere", proof: "unit test: test/acceptance-round-trip-pipe.test.ts" },
  ]) {
    const body = `## Summary\n\nDoes a thing.\n\n${renderAcceptanceBlock([criterion])}\n\nRemudero-Task: none\n`;
    const diagnostics = acceptanceBlockDiagnostics(body);
    assert.equal(diagnostics.criteriaParsed, 1, JSON.stringify(criterion.claim));
    assert.equal(diagnostics.emptyProofs, 0, JSON.stringify(criterion.claim));
    assert.equal(diagnostics.defective, false, JSON.stringify(criterion.claim));
    assert.equal(acceptanceAuthorTimeCheck(body).ok, true, JSON.stringify(criterion.claim));
  }
});

test("the readings this does NOT change: a bare `a|b` bullet and a code-spanned proof", () => {
  // `acceptanceSeparator` only ever departs from the historical first-bare-`|` split when that
  // split does not already yield a dialect proof, so the shapes that parse today keep parsing
  // byte-for-byte. Both of these resolve through the legacy reading, unchanged.
  assert.deepEqual(parseAcceptanceBlock("Acceptance:\n- alpha|some prose proof"), [
    { claim: "alpha", proof: "some prose proof" },
  ]);
  // A proof wrapped in a markdown code span is the same proof (the #1037/#1057 lesson) — it is
  // still what makes its split the executable one, so the separator resolution reads it the same
  // way `parseWhitelistedProof` does rather than through a second, drifting spelling.
  const spanned = parseAcceptanceBlock(
    "Acceptance:\n- a claim quoting `|| true` | `unit test: test/acceptance-round-trip-pipe.test.ts`",
  );
  assert.equal(spanned.length, 1);
  assert.equal(spanned[0].claim, "a claim quoting `|| true`");
  assert.ok(parseWhitelistedProof(spanned[0].proof), "a code-spanned proof stays executable");
});
