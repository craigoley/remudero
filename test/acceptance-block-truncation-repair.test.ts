/**
 * test/acceptance-block-truncation-repair.test.ts — W1-T2316.
 *
 * THE DEFECT, reproduced twice on origin/main before this change (rationale (1)): r29 emitted an
 * acceptance block reading `bullets written: 5, criteria parsed: 1`; r30 re-wrapped a MASTER-PLAN
 * paragraph so a not-shipped qualifier landed on the same physical line as a shipped id. Both are
 * RENDERING failures, not findings failures — the retro's analysis was fine, its typography was not.
 *
 * BOTH CONSUMERS OF A RETRO'S TEXT ARE PHYSICAL-LINE READERS (rationale (2)): `parseAcceptanceBlock`
 * (src/lib/review.ts) ends an Acceptance block at any indented line that is not a fresh `proof:`,
 * so a claim wrapped onto a second line truncates every bullet after it; `notShippedLines`
 * (scripts/plan-state-claims.mjs) requires a not-shipped phrase and an id on the SAME physical line.
 * This file is about the FIRST of those two — the one `bodyNeedsAcceptanceRepair`
 * (src/lib/plan-pr-emitter.ts) exists to catch before a defective body ever reaches review.
 *
 * WHY THE PRE-EXISTING EMPTY-PROOF TRIGGER WAS NOT ENOUGH (rationale (4)). `bodyNeedsAcceptanceRepair`
 * already fired when a parsed criterion resolved with an EMPTY proof (the `- **"claim"** — prose`
 * shape, and the `claim:`/`proof:` continuation shape wrapped before any `proof:` line is reached).
 * But the single-line `- <claim> | <proof>` shape resolves its proof from the `|` on the SAME
 * physical line — so the FIRST bullet in a wrapped block can parse with a perfectly real, non-empty
 * proof, and the very next physical line (an indented continuation the parser does not recognise,
 * because the current criterion already has a proof) ends the block anyway, discarding every bullet
 * after it. `parsed.some((c) => !c.proof)` never sees this: every criterion that DID parse has a
 * proof, so the old predicate returned false and a five-criterion block that parsed to one read
 * HEALTHY to the one guard that exists to catch exactly that. Reproduced below as TRUNCATED_NO_EMPTY.
 *
 * THE FIX (design item ii): widen `bodyNeedsAcceptanceRepair` to consult
 * {@link "../src/lib/review.js".acceptanceBlockDiagnostics} — which counts `bulletsWritten` with the
 * parser's OWN bullet regex, off the SAME body being checked, so "fewer criteria parsed than bullets
 * written" needs no external record of authorial intent — and fire on `truncatedAtBullet !==
 * undefined` exactly as it already fires on zero criteria or an empty proof.
 *
 * WHAT IS REAL HERE: `bodyNeedsAcceptanceRepair`, `ensureJudgeableBody`, `parseAcceptanceBlock`,
 * `acceptanceBlockDiagnostics` and `isDialectPrefixed` are all the real production functions, called
 * directly — there is no seam and nothing is injected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { bodyNeedsAcceptanceRepair, ensureJudgeableBody, renderAcceptanceBlock } from "../src/lib/plan-pr-emitter.js";
import { acceptanceBlockDiagnostics, isDialectPrefixed, parseAcceptanceBlock } from "../src/lib/review.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

/**
 * The r29 shape, exactly: 5 bullets written in the single-line `- <claim> | <proof>` form, the
 * first followed by an indented continuation line that is neither a new bullet nor a `proof:`
 * continuation (the current criterion already has one). `parseAcceptanceBlock` resolves ONE
 * criterion — with a real, non-empty proof — and silently drops bullets 2 through 5.
 */
const TRUNCATED_NO_EMPTY = [
  "Acceptance:",
  "- the first criterion is proven | grep: alpha in src/a.ts",
  "  because the claim continues onto this indented line, which the parser does",
  "  not recognise as a new bullet or as a fresh proof continuation",
  "- the second criterion | grep: beta in src/b.ts",
  "- the third criterion | grep: gamma in src/c.ts",
  "- the fourth criterion | grep: delta in src/d.ts",
  "- the fifth criterion | grep: epsilon in src/e.ts",
  "",
].join("\n");

/** A body with an empty proof, but EVERY bullet written also parses — not a truncation case. */
const EMPTY_PROOF_NO_TRUNCATION = [
  "Acceptance:",
  "- claim: a claim with a real proof | grep: alpha in src/a.ts",
  "- claim: a claim with no proof written anywhere",
  "",
].join("\n");

/** No header at all — the original trigger's own case. */
const NO_HEADER = "This PR fixes the thing.\n\nSee the diff for details.\n";

/** A healthy, multi-criterion body: every bullet written parses, every proof is non-empty. */
const HEALTHY = [
  "Acceptance:",
  "- the first criterion holds | grep: alpha in src/a.ts",
  "- the second criterion holds | unit test: test/some-real.test.ts",
  "- the third criterion holds | grep: gamma in src/c.ts",
  "",
].join("\n");

/** A healthy block followed by a trailing prose section that itself carries `- ` bulleted lines —
 *  the shape `parseAcceptanceBlock`/`acceptanceBlockDiagnostics` both stop scanning at, and which a
 *  predicate that inspected free prose (rather than staying scoped to the block) could misread as
 *  more written-but-unparsed bullets. */
const HEALTHY_WITH_TRAILING_PROSE_BULLETS = `${HEALTHY}
## Validation

- an unrelated validation note, not a criterion
- another one, also not a criterion
- and a third, still not a criterion
`;

const REPAIR_FALLBACK_DIALECT = [
  { claim: "the retro's plan-only sync PR is gate-compliant", proof: "grep: SHIPPED in MASTER-PLAN.md" },
  { claim: "the plan index was regenerated", proof: "unit test: test/orientation.test.ts" },
];

// ── 1. a body writing more bullets than it parses is recognised as needing repair ──────────────

test("a body writing more bullets than it parses is recognised as needing repair", () => {
  // Confirm the premise from the REAL parser and diagnostics before trusting the fixture's shape.
  const parsed = parseAcceptanceBlock(TRUNCATED_NO_EMPTY);
  const diagnostics = acceptanceBlockDiagnostics(TRUNCATED_NO_EMPTY);
  assert.equal(diagnostics.bulletsWritten, 5, "five bullets were written");
  assert.equal(parsed.length, 1, "only the first survives the parse");
  assert.ok(diagnostics.bulletsWritten > diagnostics.criteriaParsed, "written strictly exceeds parsed");

  // THE CRUX: the one criterion that DID parse has a real, non-empty proof — so the pre-existing
  // empty-proof signal alone could never have caught this shape.
  assert.equal(parsed[0].proof.trim().length > 0, true, "the surviving criterion's proof is not empty");
  assert.equal(diagnostics.emptyProofs, 0, "no empty proof exists anywhere among what parsed");

  assert.equal(bodyNeedsAcceptanceRepair(TRUNCATED_NO_EMPTY), true, "the widened predicate fires anyway");
});

// ── 2. a body reporting a truncated bullet is recognised as needing repair ─────────────────────

test("a body reporting a truncated bullet is recognised as needing repair", () => {
  const diagnostics = acceptanceBlockDiagnostics(TRUNCATED_NO_EMPTY);
  assert.equal(diagnostics.truncatedAtBullet, 2, "the diagnostic names bullet 2 as the first one not reached");
  assert.equal(bodyNeedsAcceptanceRepair(TRUNCATED_NO_EMPTY), true);

  // A second, differently-shaped reproduction: the bold-quoted-prose wrap (the #1340 shape),
  // extended so a criterion AFTER the wrap point would otherwise be visible — this is the SAME
  // "truncatedAtBullet defined" signal from a different textual cause, not a coincidence tied to
  // one fixture.
  const wildTruncated = [
    "## Acceptance criteria",
    "",
    '- **"a governor that trips between the first and second dispatch of one batch refuses the',
    '  second, so two dispatches are never admitted on a single reading"** — `runDaemon` cannot',
    "  yet be driven through two dispatches in ONE tick, so this is proven by driving the seam",
    "- a second criterion entirely dropped by the wrap above | grep: needle in src/x.ts",
    "",
  ].join("\n");
  const d2 = acceptanceBlockDiagnostics(wildTruncated);
  assert.equal(d2.criteriaParsed, 1, "the first (prose, no `|`) bullet still resolves, with an empty proof");
  assert.equal(d2.truncatedAtBullet, 2, "the second bullet — the one this fixture exists to make visible — is dropped");
  assert.equal(bodyNeedsAcceptanceRepair(wildTruncated), true);
});

// ── 3. a body whose bullets all parse is left untouched ────────────────────────────────────────

test("a body whose bullets all parse is left untouched, so the widened predicate does not repair healthy bodies", () => {
  const diagnostics = acceptanceBlockDiagnostics(HEALTHY);
  assert.equal(diagnostics.bulletsWritten, diagnostics.criteriaParsed, "nothing is truncated");
  assert.equal(diagnostics.truncatedAtBullet, undefined);

  assert.equal(bodyNeedsAcceptanceRepair(HEALTHY), false, "a fully-parsing body must never be judged defective");
  assert.equal(ensureJudgeableBody(HEALTHY, REPAIR_FALLBACK_DIALECT), HEALTHY, "returned byte-identical, not rewritten");

  // The emitter's own round-trip guarantee, re-affirmed under the widened predicate: what
  // renderAcceptanceBlock writes must never be judged defective by the repair it feeds.
  const emitted = `Prose.\n\n${renderAcceptanceBlock([{ claim: "a claim", proof: "grep: alpha in src/a.ts" }])}\n`;
  assert.equal(bodyNeedsAcceptanceRepair(emitted), false);
});

// ── 4. the zero-criteria and empty-proof triggers still fire exactly as before ─────────────────

test("the zero-criteria trigger still fires exactly as before", () => {
  assert.equal(acceptanceBlockDiagnostics(NO_HEADER).criteriaParsed, 0);
  assert.equal(bodyNeedsAcceptanceRepair(NO_HEADER), true);
  assert.equal(bodyNeedsAcceptanceRepair(""), true, "an empty body is the same zero-criteria case");
});

test("the empty-proof trigger still fires exactly as before, on a body that is not truncated at all", () => {
  const diagnostics = acceptanceBlockDiagnostics(EMPTY_PROOF_NO_TRUNCATION);
  assert.equal(diagnostics.bulletsWritten, diagnostics.criteriaParsed, "everything written also parsed");
  assert.equal(diagnostics.truncatedAtBullet, undefined, "this is not the truncation shape");
  assert.equal(diagnostics.emptyProofs, 1, "one criterion resolved with nothing to execute");

  assert.equal(bodyNeedsAcceptanceRepair(EMPTY_PROOF_NO_TRUNCATION), true, "the pre-existing signal alone is still sufficient");

  // A whitespace-only proof still counts as empty — a space is not a proof.
  const whitespaceProof = ["Acceptance:", "- a claim |    ", ""].join("\n");
  assert.equal(parseAcceptanceBlock(whitespaceProof).length, 1);
  assert.equal(bodyNeedsAcceptanceRepair(whitespaceProof), true);
});

// ── 5. a repaired body parses every claim it writes and each proof carries a dialect prefix ────

test("a repaired body parses every claim it writes and each proof carries a dialect prefix", () => {
  assert.equal(bodyNeedsAcceptanceRepair(TRUNCATED_NO_EMPTY), true, "precondition: this body needs repair");

  const repaired = ensureJudgeableBody(TRUNCATED_NO_EMPTY, REPAIR_FALLBACK_DIALECT);
  assert.notEqual(repaired, TRUNCATED_NO_EMPTY, "the body is actually rewritten");

  const reparsed = parseAcceptanceBlock(repaired);
  assert.equal(reparsed.length, REPAIR_FALLBACK_DIALECT.length, "every claim the repair wrote is parsed back out");
  for (let i = 0; i < reparsed.length; i++) {
    assert.equal(reparsed[i].claim, REPAIR_FALLBACK_DIALECT[i].claim);
    assert.equal(reparsed[i].proof, REPAIR_FALLBACK_DIALECT[i].proof);
    assert.equal(
      isDialectPrefixed(reparsed[i].proof),
      true,
      `criterion ${i}'s proof ("${reparsed[i].proof}") must carry a house-dialect prefix — rationale (6): half a ` +
        "fix that makes truncated criteria visible without a dialect-prefixed proof only moves the verdict from " +
        "silently-truncated to loudly-capped",
    );
  }

  // Idempotent: the repaired body no longer needs repair.
  assert.equal(bodyNeedsAcceptanceRepair(repaired), false);
});

// ── 6. the predicate never inspects free prose outside an acceptance block ─────────────────────

test("the predicate never inspects free prose outside an acceptance block", () => {
  // Trailing `- ` bulleted prose AFTER a healthy block must not be misread as more
  // written-but-unparsed criteria — the diagnostic (and therefore the predicate) stops scanning at
  // the same boundary parseAcceptanceBlock itself stops at.
  const diagnostics = acceptanceBlockDiagnostics(HEALTHY_WITH_TRAILING_PROSE_BULLETS);
  assert.equal(diagnostics.bulletsWritten, 3, "counting stops at the end of the block, not at the end of the file");
  assert.equal(diagnostics.criteriaParsed, 3);
  assert.equal(diagnostics.truncatedAtBullet, undefined);

  assert.equal(
    bodyNeedsAcceptanceRepair(HEALTHY_WITH_TRAILING_PROSE_BULLETS),
    false,
    "trailing prose bullets outside the block must never trigger the repair",
  );
  assert.equal(
    ensureJudgeableBody(HEALTHY_WITH_TRAILING_PROSE_BULLETS, REPAIR_FALLBACK_DIALECT),
    HEALTHY_WITH_TRAILING_PROSE_BULLETS,
    "returned byte-identical",
  );
});

// ── 7. nothing in the widened path relaxes what counts as judgeable ────────────────────────────

test("nothing in the widened path relaxes what counts as judgeable", () => {
  // parseAcceptanceBlock's own end-of-block rule is UNCHANGED: it still resolves only one
  // criterion from TRUNCATED_NO_EMPTY. The widening moved when the REPAIR fires, never what the
  // parser itself accepts as parsed.
  assert.equal(parseAcceptanceBlock(TRUNCATED_NO_EMPTY).length, 1, "the parser still truncates exactly as before");

  // renderAcceptanceBlock's own refusal to emit an unjudgeable (empty) block is unrelaxed —
  // repair can never "succeed" by producing zero criteria.
  assert.throws(() => renderAcceptanceBlock([]), /at least one criterion is required/);

  // A "fix" that merely reflows without repairing the parse is STILL caught — the widened
  // predicate cannot be satisfied by cosmetic edits that leave the block still truncated.
  const stillTruncated = TRUNCATED_NO_EMPTY.replace("the fifth criterion", "the fifth criterion (reworded)");
  assert.equal(parseAcceptanceBlock(stillTruncated).length, 1, "sanity: still truncated after the cosmetic edit");
  assert.equal(bodyNeedsAcceptanceRepair(stillTruncated), true, "the predicate is not fooled by an edit that does not fix the parse");

  // And the repair itself cannot mark something judgeable while still discarding what was
  // written: ensureJudgeableBody's output for a truncated input must re-check healthy, never
  // merely "different".
  const repaired = ensureJudgeableBody(TRUNCATED_NO_EMPTY, REPAIR_FALLBACK_DIALECT);
  assert.equal(bodyNeedsAcceptanceRepair(repaired), false, "a real repair, and only a real repair, clears the predicate");
});
