import { strict as assert } from "node:assert";
import { test } from "node:test";
import fc from "fast-check";
import { parseWhitelistedProof } from "#src/lib/review.js";
import { prStateFromRest } from "#src/lib/open-prs-rest.js";
import { prReferentFromIssueText } from "#src/lib/escalate.js";
import { parsePlanVerdict } from "#src/lib/plan-architect.js";

/**
 * PROPERTY TESTS FOR THIS REPO'S FOUR LOAD-BEARING PURE PARSERS.
 *
 * WHY THESE FOUR, AND WHY PROPERTIES. The recurring defect shape here is a parser meeting an input
 * nobody imagined, and every instance in the last week was found in production rather than in a
 * test: a `grep:` pattern read as a fixed string when the executor runs a BASIC REGEX (`[call-site]`
 * silently became a character class); two source files carrying raw NUL bytes, so a proof's outcome
 * differed BY GREP IMPLEMENTATION; a bare `#707` ambiguous between an issue and a PR; and `merged`
 * ABSENT from GitHub's pull-request LIST endpoint, which blinded the merged-credit derivation and
 * produced a five-dispatch runaway loop.
 *
 * Example-based tests cannot find that class, because the whole failure is an input the author did
 * not think of. So every arbitrary below is built to explore the SPACE THOSE DEFECTS LIVED IN —
 * regex metacharacters, NUL bytes, CRLF, unicode, and the parsers' OWN tokens embedded in
 * unexpected positions — rather than random alphanumerics, which would find none of them.
 *
 * DETERMINISM. Every property pins {@link SEED}. A property test that fails differently on each run
 * is a flake, and this repo has spent real time on flakes. The cost is stated at SEED's declaration.
 */

/** Pinned so a failure is reproducible and a pass is stable.
 *
 *  WHAT IT COSTS: with a fixed seed each CI run explores the SAME `numRuns` inputs, so the suite
 *  cannot discover a new counterexample on a later run the way an unseeded one might. That is the
 *  deliberate trade — a flaky gate gets deleted, a deterministic one gets trusted. The mitigation is
 *  breadth per run (`numRuns` below) and hazard-weighted arbitraries rather than luck over time. */
const SEED = 20260801;
/** Kept modest ON PURPOSE: CI runs this, and a suite that takes minutes is resented and eventually
 *  deleted. Measured wall-clock for the whole file is reported in the PR. */
const RUNS = 300;
const CFG = { seed: SEED, numRuns: RUNS } as const;

/**
 * The token alphabet, drawn from the ACTUAL defects rather than imagination. Each entry is here
 * because a real bug lived on it:
 *   - `[ ] * . ^ $ \` — BRE metacharacters; `[call-site]` became a character class (PR #1077).
 *   - `\0`             — the two-char escape now, in place of a raw NUL byte; flight-signals.ts /
 *                       task-linter.ts / verdict-calibration.ts used to carry one raw,
 *                       which made grep silent — test/no-raw-nul.test.ts gates that
 *                       class shut for good.
 *   - "` "            — markdown code spans made proofs unparseable (~81% of zero-execution verdicts
 *                       until PR #1063).
 *   - `\r\n`, `\n`    — line-oriented parsing; `grep -rn` cannot span newlines.
 *   - `#707`, `/pull/7` — the issue-vs-PR referent ambiguity.
 *   - the parsers' own markers — embedded mid-string, where a parser expecting them at a boundary
 *     is most likely to be wrong.
 */
const HAZARDS = [
  "[", "]", "*", ".", "^", "$", "\\", "(", ")", "{", "}", "+", "?", "|",
  "\0", "`", "\r\n", "\n", "\t", "   ",
  "grep:", "unit test:", " in ", "..", "test/a.test.ts", "src/lib/x.ts",
  "CLEAR:", "GRILL:", "PROPOSED:", "#707", "/pull/7", "/pull/", "; ", " -> ",
  "😀", "​", "é", "�", "'", '"',
];

/** Arbitrary text: random unicode INTERLEAVED with the hazard tokens, so markers land in unexpected
 *  positions rather than only where a well-formed input would put them. */
const hazardText = fc
  .array(
    fc.oneof(
      fc.constantFrom(...HAZARDS),
      fc.string({ maxLength: 12 }),
      // fast-check v4 replaced `fullUnicodeString` with a `unit` option. "grapheme" reaches astral
      // planes and combining marks; "binary" reaches raw code units — lone surrogates, control
      // characters and NUL — which is the half that matters for a parser fed real file bytes.
      fc.string({ unit: "grapheme", maxLength: 10 }),
      fc.string({ unit: "binary", maxLength: 8 }),
    ),
    { maxLength: 14 },
  )
  .map((parts) => parts.join(""));

// ── 1. parseWhitelistedProof (review.ts:781) ─────────────────────────────────

test("PROPERTY parseWhitelistedProof: never throws on arbitrary text", () => {
  fc.assert(
    fc.property(hazardText, (s) => {
      parseWhitelistedProof(s);
    }),
    CFG,
  );
});

test("PROPERTY parseWhitelistedProof: a parsed grep proof never carries an empty path", () => {
  // The caller spawns `grep -arn -- <pattern> <path>`. An empty path argument would make grep read
  // STDIN and hang the review, or search the wrong thing — a real, caller-visible defect.
  fc.assert(
    fc.property(hazardText, (s) => {
      const w = parseWhitelistedProof(s);
      if (!w || w.kind !== "grep") return;
      const target = w.args[w.args.length - 1];
      assert.ok(typeof target === "string" && target.length > 0, `empty grep path from ${JSON.stringify(s)}`);
    }),
    CFG,
  );
});

/**
 * Proofs SHAPED like a traversal attempt, constructed rather than stumbled upon.
 *
 * WHY THIS EXISTS AS ITS OWN ARBITRARY: the traversal property below passed against `hazardText`
 * even with the guards MUTATED OUT — random text essentially never assembles a well-formed dialect
 * proof that also contains `..`, so the property was passing trivially, which is worse than no
 * property at all because it reads as coverage. This arbitrary makes the guard actually reachable,
 * and the mutation proof only fails once it is used.
 */
const traversalProof = fc
  .tuple(
    fc.constantFrom("unit test: test/", "grep: needle in src/", "grep: needle in test/"),
    fc.array(fc.constantFrom("..", "a", "lib", "."), { minLength: 1, maxLength: 4 }).map((p) => p.join("/")),
    fc.constantFrom("/x.test.ts", "/x.ts", ".test.ts", ""),
  )
  .map(([head, mid, tail]) => `${head}${mid}${tail}`);

test("PROPERTY parseWhitelistedProof: no parsed proof argument ever contains a path traversal", () => {
  // The parser refuses `..` at four sites (review.ts:706, :822, and the grep path guard). This is
  // the invariant those guards exist FOR: a proof is attacker-adjacent text (it comes from a PR
  // body), and a traversing path would read outside the materialised checkout.
  fc.assert(
    fc.property(fc.oneof(hazardText, traversalProof), (s) => {
      const w = parseWhitelistedProof(s);
      if (!w) return;
      for (const a of w.args) assert.equal(String(a).includes(".."), false, `traversal in ${JSON.stringify(w.args)}`);
    }),
    CFG,
  );
});

// ── 2. prStateFromRest (open-prs-rest.ts:267) ────────────────────────────────
//
// THE PAYOFF. Three separate defects violated this contract, all because the pull-request LIST
// endpoint OMITS `merged` — and an absent key yields `undefined`, which is falsy and
// indistinguishable from "not fetched yet". So the arbitrary below builds rows with keys GENUINELY
// ABSENT, not merely set to undefined, because that is the shape the defects had.

/** A row whose keys are genuinely absent rather than undefined-valued. */
const restRow = fc
  .record(
    {
      state: fc.option(fc.oneof(fc.constantFrom("open", "closed", "OPEN", "CLOSED", "", "MeRgEd"), fc.string()), {
        nil: undefined,
      }),
      merged: fc.option(fc.boolean(), { nil: undefined }),
      merged_at: fc.option(fc.oneof(fc.constant(null), fc.date({ noInvalidDate: true }).map((d) => d.toISOString()), fc.string()), {
        nil: undefined,
      }),
    },
    { requiredKeys: [] },
  )
  .map((r) => {
    // DELETE rather than leave undefined — a list row does not carry the key at all.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) if (v !== undefined) out[k] = v;
    return out as { state?: string; merged?: boolean; merged_at?: string | null };
  });

test("PROPERTY prStateFromRest: merged_at present implies MERGED for every combination of the other fields", () => {
  // The exact contract #1017 restored. `merged_at != null` is the ONLY discriminator the list
  // endpoint supplies, so it must win regardless of what `state` or a missing `merged` says.
  fc.assert(
    fc.property(restRow, (row) => {
      if (row.merged_at === undefined || row.merged_at === null) return;
      assert.equal(prStateFromRest(row), "MERGED", `merged_at=${JSON.stringify(row.merged_at)} row=${JSON.stringify(row)}`);
    }),
    CFG,
  );
});

test("PROPERTY prStateFromRest: never returns the empty string", () => {
  // `terminalStateReason` treats ANY value other than "OPEN" as terminal, so an empty return would
  // read as terminal and make `rmd fix` refuse every live PR.
  fc.assert(
    fc.property(restRow, (row) => {
      assert.notEqual(prStateFromRest(row), "", `empty state from ${JSON.stringify(row)}`);
    }),
    CFG,
  );
});

test("PROPERTY prStateFromRest: an absent merged key is never read as NOT merged when merged_at says otherwise", () => {
  // The LIST-endpoint shape specifically: `merged` absent, `merged_at` set. This is what collapsed
  // every merged pull to "CLOSED" and made 60 merged tasks dispatch-eligible.
  fc.assert(
    fc.property(fc.oneof(fc.constantFrom("closed", "open", "", "CLOSED"), fc.string()), fc.date({ noInvalidDate: true }), (state, when) => {
      const listRow = { state, merged_at: when.toISOString() }; // NOTE: no `merged` key at all
      assert.equal(prStateFromRest(listRow), "MERGED");
    }),
    CFG,
  );
});

// ── 3. prReferentFromIssueText (escalate.ts:314) ─────────────────────────────

test("PROPERTY prReferentFromIssueText: returns only a positive safe integer or undefined", () => {
  fc.assert(
    fc.property(hazardText, (s) => {
      const n = prReferentFromIssueText(s);
      if (n === undefined) return;
      assert.ok(Number.isSafeInteger(n) && n > 0, `bad referent ${n} from ${JSON.stringify(s)}`);
    }),
    CFG,
  );
});

test("PROPERTY prReferentFromIssueText: text with no pull URL never yields a number", () => {
  // THE BARE-#707 AMBIGUITY LOCK. `#707` alone cannot distinguish an issue from a PR, so only an
  // explicit /pull/<n> may produce a referent. Retiring the wrong object is the failure this stops.
  const noPullUrl = hazardText.filter((s) => !/\/pull\/\d/.test(s));
  fc.assert(
    fc.property(noPullUrl, (s) => {
      assert.equal(prReferentFromIssueText(s), undefined, `referent invented from ${JSON.stringify(s)}`);
    }),
    CFG,
  );
});

test("PROPERTY prReferentFromIssueText: a returned number appears verbatim in the input", () => {
  fc.assert(
    fc.property(hazardText, (s) => {
      const n = prReferentFromIssueText(s);
      if (n === undefined) return;
      assert.ok(s.includes(String(n)), `referent ${n} not present in ${JSON.stringify(s)}`);
    }),
    CFG,
  );
});

// ── 4. parsePlanVerdict (plan-architect.ts:251) ──────────────────────────────

/** Lines that are markers, interleaved with arbitrary noise lines. */
const markerKinds = ["CLEAR", "GRILL", "PROPOSED"] as const;
const verdictText = fc
  .array(
    fc.oneof(
      fc.tuple(fc.constantFrom(...markerKinds), fc.string({ minLength: 1, maxLength: 20 })).map(
        ([k, body]) => `${k}: ${body.replace(/[\r\n]/g, " ")}`,
      ),
      fc.constantFrom(...HAZARDS),
      fc.string({ maxLength: 20 }).map((s) => s.replace(/[\r\n]/g, " ")),
    ),
    { maxLength: 10 },
  )
  .map((lines) => lines.join("\n"));

test("PROPERTY parsePlanVerdict: never throws under arbitrary interleaving", () => {
  fc.assert(
    fc.property(fc.oneof(verdictText, hazardText), (s) => {
      parsePlanVerdict(s);
    }),
    CFG,
  );
});

test("PROPERTY parsePlanVerdict: last marker wins under arbitrary interleaving", () => {
  // The caller acts on ONE verdict. If an earlier marker could win, an Architect that reconsidered
  // mid-output would have its FIRST answer executed — the opposite of what it decided.
  const KIND_OF: Record<string, string> = { CLEAR: "clear", GRILL: "grill", PROPOSED: "proposed" };
  fc.assert(
    fc.property(verdictText, (s) => {
      const v = parsePlanVerdict(s);
      // Independently re-derive the LAST well-formed marker line in the text.
      const all = [...s.matchAll(/^[ \t]*(CLEAR|GRILL|PROPOSED)[ \t]*:[ \t]*(.+)$/gim)];
      if (all.length === 0) {
        assert.equal(v, null, `verdict invented from ${JSON.stringify(s)}`);
        return;
      }
      const last = all[all.length - 1][1].toUpperCase();
      assert.ok(v, `no verdict despite ${all.length} marker(s) in ${JSON.stringify(s)}`);
      assert.equal(v!.kind, KIND_OF[last], `expected ${KIND_OF[last]} from ${JSON.stringify(s)}`);
    }),
    CFG,
  );
});
