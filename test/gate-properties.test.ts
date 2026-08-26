import { strict as assert } from "node:assert";
import { test } from "node:test";
import fc from "fast-check";
import { bodyContradictsDiff } from "../src/lib/review.js";
import { breMetacharsIn } from "../src/lib/task-linter.js";

/**
 * PROPERTY TESTS FOR THE TWO GATES WHOSE **WRONG** ANSWER BLOCKS CORRECT WORK.
 *
 * The sibling suite (`test/property-parsers.test.ts`, PR #1090) covers parsers whose wrong answer
 * lets bad work THROUGH. This one covers the opposite and rarer failure: a checker that fires when
 * it should be silent, refusing a PR that is fine. That is strictly worse than a miss, because a
 * blocked PR has no remedy — one that files no task logs `sweep.fix.no_task` and sits forever.
 *
 * `bodyContradictsDiff` fired five times in one day on sentences that were not about the changeset.
 * Its count pattern matched "Each unit-test proof resolves to exactly one file" — a statement about
 * PROOF CANDIDATE RESOLUTION — and read it as a claim about a seven-file diff, blocking a PR whose
 * own verdict recorded 5/5 `executed_pass` and zero unmet criteria. PR #1077 anchored the count
 * claim; these properties pin that boundary so it cannot drift back.
 *
 * The standard is the function's own (review.ts:1708-1712), and it is what every property here
 * asserts: "ANYTHING THIS CANNOT DECIDE IS SILENCE, NOT A VERDICT — prose these patterns do not
 * recognise returns `[]` … A checker that guesses at natural language would be a worse tripwire
 * than the gap it closes."
 *
 * Conventions match the existing suite: pinned seed, bounded runs, arbitraries built from the real
 * hazard space rather than random alphanumerics.
 */

const SEED = 20260801;
const RUNS = 300;
const CFG = { seed: SEED, numRuns: RUNS } as const;

// ── Arbitraries that actually REACH the predicate ────────────────────────────
//
// A checker that scans for "exactly N files" is never exercised by prose about weather. Both
// arbitraries below assemble sentences from the vocabulary the check scans for — counts, numerals,
// "file"/"files" — and differ ONLY in whether the subject is the changeset. That contrast is the
// whole experiment: the same count words must be a verdict in one position and silence in the other.

const COUNT_WORDS = ["exactly", "just", "only", "precisely"] as const;
const NUMBERS = ["one", "two", "three", "seven", "1", "2", "3", "7", "0", "zero"] as const;
const NOUNS = ["file", "files"] as const;

/** SUBJECTS THAT ARE NOT THE DIFF — drawn from the five real false positives. Every one of these
 *  is a thing this codebase genuinely counts files for, which is why the bug was reachable. */
const NON_CHANGESET_SUBJECTS = [
  "Each unit-test proof resolves to",
  "The candidate resolver narrows to",
  "resolveNameFilteredCandidates narrows to",
  "The name filter matched",
  "Every proof resolves to",
  "The glob expands to",
  "The allowlist names",
] as const;

/** SUBJECTS THAT ARE THE DIFF — these must still be caught, or the check is worthless. */
const CHANGESET_SUBJECTS = [
  "This PR changes",
  "The diff touches",
  "git show --stat listed",
  "This changeset modifies",
  "The PR adds",
] as const;

const TAILS = [
  " and matches 1 test.",
  ", which is the happy path.",
  " under the new anchoring.",
  ".",
  " — see the table above.",
] as const;

const nonChangesetClaim = fc
  .tuple(
    fc.constantFrom(...NON_CHANGESET_SUBJECTS),
    fc.constantFrom(...COUNT_WORDS),
    fc.constantFrom(...NUMBERS),
    fc.constantFrom(...NOUNS),
    fc.constantFrom(...TAILS),
  )
  .map(([subj, cnt, n, noun, tail]) => `${subj} ${cnt} ${n} ${noun}${tail}`);

const changesetClaim = fc
  .tuple(
    fc.constantFrom(...CHANGESET_SUBJECTS),
    fc.constantFrom(...COUNT_WORDS),
    fc.constantFrom(...NUMBERS),
    fc.constantFrom(...NOUNS),
    fc.constantFrom(...TAILS),
  )
  .map(([subj, cnt, n, noun, tail]) => `${subj} ${cnt} ${n} ${noun}${tail}`);

/** A file list that is never the claimed count, so a fired claim is always a CONTRADICTION. */
const sevenFiles = ["a.ts", "b.ts", "c.ts", "d.ts", "e.md", "f.md", "g.md"];

// ── 1. bodyContradictsDiff — the central property ────────────────────────────

test("PROPERTY bodyContradictsDiff: a count claim whose subject is NOT the changeset yields silence", () => {
  // THE #1077 CLASS. Five real false positives had exactly this shape. A sentence counting files
  // for some other reason is not a claim about the diff, and the function's own doc requires
  // silence for anything it cannot decide.
  fc.assert(
    fc.property(nonChangesetClaim, (body) => {
      assert.deepEqual(bodyContradictsDiff(body, sevenFiles), [], `fired on non-changeset prose: ${JSON.stringify(body)}`);
    }),
    CFG,
  );
});

test("PROPERTY bodyContradictsDiff: a changeset word in an EARLIER sentence does not license a later claim", () => {
  // Anchoring looks backward only to the start of the CURRENT sentence. Scanning the whole body
  // would re-create the unanchored match, because every PR body says "changes" somewhere.
  fc.assert(
    fc.property(nonChangesetClaim, fc.constantFrom(...CHANGESET_SUBJECTS), (claim, lead) => {
      const body = `${lead} seven files. ${claim}`;
      assert.deepEqual(bodyContradictsDiff(body, sevenFiles), [], `leaked across a sentence: ${JSON.stringify(body)}`);
    }),
    CFG,
  );
});

// ── 2. bodyContradictsDiff — the preservation properties ─────────────────────

test("PROPERTY bodyContradictsDiff: a FALSE count claim about the changeset is still caught", () => {
  // THE LOCK THAT STOPS THIS SUITE BEING WEAKENED TO NOTHING. A property suite pinning only "does
  // not fire" would pass against a function gutted to `return []`.
  fc.assert(
    fc.property(changesetClaim, (body) => {
      const claimed = /\b(?:exactly|just|only|precisely)\s+(\w+)\s+files?\b/i.exec(body);
      // Only "exactly" is a recognised count form; the others are deliberately NOT claims.
      if (!/\bexactly\b/i.test(body)) return;
      const word = claimed?.[1] ?? "";
      const asNum: Record<string, number> = { one: 1, two: 2, three: 3, seven: 7, zero: 0 };
      const n = word in asNum ? asNum[word] : /^\d+$/.test(word) ? Number(word) : undefined;
      if (n === undefined || n === sevenFiles.length) return; // a TRUE claim must stay silent
      assert.notEqual(
        bodyContradictsDiff(body, sevenFiles).length,
        0,
        `missed a false changeset claim: ${JSON.stringify(body)}`,
      );
    }),
    CFG,
  );
});

test("PROPERTY bodyContradictsDiff: a TRUE count claim about the changeset stays silent", () => {
  fc.assert(
    fc.property(fc.constantFrom(...CHANGESET_SUBJECTS), fc.constantFrom(...TAILS), (subj, tail) => {
      const body = `${subj} exactly seven files${tail}`;
      assert.deepEqual(bodyContradictsDiff(body, sevenFiles), [], `fired on a TRUE claim: ${JSON.stringify(body)}`);
    }),
    CFG,
  );
});

// NOTE the title deliberately avoids the two shorthand tokens themselves: a PR body citing this
// test as a proof would otherwise carry them, and the check would evaluate them against that
// PR's own diff — blocking it. That is not hypothetical; it is why this test is named this way.
test("PROPERTY bodyContradictsDiff: the scope shorthands still catch an out-of-scope diff", () => {
  // #1025's REAL SHAPE. It claimed "Data-only: no code" over a -515-line source revert that
  // silently reverted three merged PRs. Without this the suite would pin only "does not fire", and
  // someone could disable a shorthand entirely and still go green.
  const srcFile = fc.constantFrom("src/lib/x.ts", "src/run-task.ts", "test/a.test.ts");
  fc.assert(
    fc.property(fc.constantFrom("Data-only: no code changes.", "This is plan-only."), srcFile, (body, f) => {
      const hits = bodyContradictsDiff(body, [f, "docs/y.md"]);
      assert.notEqual(hits.length, 0, `missed an out-of-scope claim: ${JSON.stringify(body)} over ${f}`);
      assert.ok(hits.some((h) => h.files.includes(f)), "the violating file must be named in the verdict");
    }),
    CFG,
  );
});

// ── 3. bodyContradictsDiff — general invariants ──────────────────────────────

const HAZARDS = [
  "exactly", "one file", "files", "no ", "no code", "no src/", "plan-only", "data-only",
  "src/lib/x.ts", "test/a.test.ts", "MASTER-PLAN.md", ":", ",", ".", "\n", "\r\n", "  ",
  "😀", "\0", "`", "[", "]", "*", "^", "$",
];
const hazardText = fc
  .array(
    fc.oneof(
      fc.constantFrom(...HAZARDS),
      fc.string({ maxLength: 12 }),
      fc.string({ unit: "grapheme", maxLength: 8 }),
      fc.string({ unit: "binary", maxLength: 6 }),
    ),
    { maxLength: 12 },
  )
  .map((p) => p.join(""));

test("PROPERTY bodyContradictsDiff: never throws on arbitrary text", () => {
  fc.assert(
    fc.property(hazardText, fc.array(fc.string({ maxLength: 10 }), { maxLength: 5 }), (body, files) => {
      bodyContradictsDiff(body, files);
    }),
    CFG,
  );
});

test("PROPERTY bodyContradictsDiff: every reported claim appears verbatim in the body", () => {
  // The posted status QUOTES the claim back. A fabricated or mangled claim string sends the author
  // hunting for words they never wrote — the "unexplained red" shape the message exists to avoid.
  // `plan-only`/`data-only` are the two synthesised labels and are matched case-insensitively.
  // FED CLAIM-PRODUCING INPUT ON PURPOSE. An earlier draft used `hazardText` alone and passed even
  // with the claim string FABRICATED, because random text almost never assembles a body that fires
  // the predicate — it was reading as coverage while checking nothing. The union below guarantees
  // the loop below actually has claims to inspect.
  const claimBearing = fc.oneof(
    changesetClaim,
    fc.constantFrom(
      "git show --stat listed exactly one file: MASTER-PLAN.md.",
      "Data-only: no code changes here.",
      "This is plan-only.",
      "The diff touches exactly three files.",
      "No src/ is touched.",
    ),
    hazardText,
  );
  fc.assert(
    fc.property(claimBearing, (body) => {
      for (const c of bodyContradictsDiff(body, ["src/lib/x.ts", "docs/y.md"])) {
        assert.ok(
          body.toLowerCase().includes(c.claim.toLowerCase()),
          `claim ${JSON.stringify(c.claim)} absent from body ${JSON.stringify(body)}`,
        );
      }
    }),
    CFG,
  );
});

// ── 3b. The `no <token>` anchor (predicate (b)) ──────────────────────────────
//
// #1077 anchored the COUNT claim; predicate (b) was left unanchored and fired six times in one day
// on prose whose subject was not the changeset. These three properties pin the boundary the anchor
// draws — and the two preservation halves matter as much as the silence half, because a suite that
// only pinned "does not fire" would pass against a predicate deleted outright.

/** Tokens predicate (b) can act on at all: "code", or something path-shaped. */
const CLAIM_TOKENS = ["code", "src/", "test/", "src/lib/x.ts", "MASTER-PLAN.md", "docs/"] as const;

/** Ordinary head nouns. A token followed by one of these is a MODIFIER, not the thing claimed
 *  absent — "no code duplication" is about duplication, and the repo runs a jscpd gate, so that is
 *  a sentence a real PR body writes. */
const HEAD_NOUNS = ["duplication", "coverage", "smells", "convention", "directory", "review", "churn", "debt"] as const;

/** Words that make the claim about the changeset, drawn from CHANGESET_CONTEXT_RE itself. */
const CHANGESET_WORDS = ["changes", "touched", "modifications", "edits", "added", "removed", "deleted"] as const;

/** What can END a claim, leaving the token as the thing claimed absent. */
const TERMINATORS = [",", ".", '"', ")", "", " ", "\n"] as const;

test("PROPERTY bodyContradictsDiff: a no-CLAIM whose token MODIFIES a following noun stays silent", () => {
  // THE FIX'S CENTRAL INVARIANT. "no code duplication" / "no src/ directory" are about duplication
  // and directories, not about the diff, and must not produce a verdict against a source-touching PR.
  fc.assert(
    fc.property(fc.constantFrom(...CLAIM_TOKENS), fc.constantFrom(...HEAD_NOUNS), (tok, noun) => {
      const body = `This change introduces no ${tok} ${noun} anywhere.`;
      assert.deepEqual(
        bodyContradictsDiff(body, ["src/lib/x.ts", "docs/y.md"]),
        [],
        `fired on a modifier claim: ${JSON.stringify(body)}`,
      );
    }),
    CFG,
  );
});

test("PROPERTY bodyContradictsDiff: a no-CLAIM the token ENDS still fires", () => {
  // PRESERVATION HALF ONE — #1025's real shape, `the body's own "data-only: no code" claim`, and
  // #974's `no code, no plan/tasks.yaml`. Punctuation or end-of-line after the token means the
  // token IS the thing claimed absent.
  fc.assert(
    fc.property(fc.constantFrom("code", "src/", "src/lib"), fc.constantFrom(...TERMINATORS), (tok, term) => {
      // "Data-only:" is deliberately NOT the lead here. An earlier draft used it and the property
      // passed with the anchor MUTATED OUT, because the `data-only` shorthand fired independently
      // and satisfied a bare "something fired" assertion. The assertion now names the `no ` claim.
      // The trailing line matters: a word on the NEXT line belongs to another sentence and must not
      // be read as this claim's head noun. That is why the anchor scans `[ \t]*`, never `\s*`.
      const body = `The revert carries no ${tok}${term}\nduplication elsewhere is out of scope.`;
      const hits = bodyContradictsDiff(body, ["src/lib/x.ts"]);
      assert.ok(
        hits.some((h) => /^no /i.test(h.claim)),
        `missed a terminated claim: ${JSON.stringify(body)} -> ${JSON.stringify(hits.map((h) => h.claim))}`,
      );
    }),
    CFG,
  );
});

test("PROPERTY bodyContradictsDiff: a no-CLAIM followed by a changeset word still fires", () => {
  // PRESERVATION HALF TWO — #974's real shape, "Plan-only, no code touched". The changeset word
  // comes AFTER the token, which is exactly why #1077's backward-looking helper does not fit here.
  fc.assert(
    fc.property(fc.constantFrom("code", "src/", "src/lib"), fc.constantFrom(...CHANGESET_WORDS), (tok, word) => {
      // Same discipline as above: no shorthand lead, and the assertion names the `no ` claim, so a
      // reverted anchor cannot be masked by a different predicate firing.
      const body = `This revert carries no ${tok} ${word} at all.`;
      const hits = bodyContradictsDiff(body, ["src/lib/x.ts"]);
      assert.ok(
        hits.some((h) => /^no /i.test(h.claim)),
        `missed a changeset-word claim: ${JSON.stringify(body)} -> ${JSON.stringify(hits.map((h) => h.claim))}`,
      );
    }),
    CFG,
  );
});

test("PROPERTY bodyContradictsDiff: a no-CLAIM about a non-path word stays silent", () => {
  // The documented boundary: "no bugs"/"no issues" are not changeset claims. Only "code" or a
  // path-shaped token may fire, which is what keeps ordinary review prose out of the verdict.
  const plainWord = fc
    .string({ maxLength: 12 })
    .filter((w) => /^[A-Za-z]+$/.test(w) && w.toLowerCase() !== "code" && w.length > 0);
  fc.assert(
    fc.property(plainWord, (w) => {
      assert.deepEqual(
        bodyContradictsDiff(`I found no ${w} worth reporting.`, ["src/lib/x.ts"]),
        [],
        `fired on "no ${w}"`,
      );
    }),
    CFG,
  );
});

// ── 4. breMetacharsIn — the blocking lint gate ───────────────────────────────
//
// Ranked the top sibling because it BLOCKS: a false positive refuses a plan PR at lint time, and
// the author has no recourse but to reword a proof that was already correct. It is also a
// hand-rolled escape-aware string walker, which is the shape properties are best at.

/** The blocking/warning metacharacter set, escaped exactly as the lint message tells authors to. */
const BRE_META = ["[", "*", "^", "$", "."];
/** The character `proof-grep-safety` tells an author to write, PER CHARACTER — the property below
 *  asserts the prescribed remedy clears the check, so it must apply the remedy the message actually
 *  prescribes. A backslash is the remedy for every BRE metacharacter above. It is NOT the remedy for
 *  `?`: `\?` is a quantifier in GNU BRE and a literal in an ERE, exactly inverted from bare `?`, so
 *  escaping it moves the failure instead of removing it. The bracket form is literal under both. */
const applyPrescribedRemedy = (s: string): string =>
  [...s].map((c) => (c === "?" ? "[?]" : BRE_META.includes(c) || c === "\\" ? "\\" + c : c)).join("");

const patternText = fc.oneof(
  fc.string({ maxLength: 24 }),
  fc.string({ unit: "binary", maxLength: 12 }),
  fc
    // NUL and CRLF are listed EXPLICITLY. An earlier draft relied on `unit: "binary"` to produce
    // them and the throws-on-NUL mutation went uncaught — the property was passing without ever
    // seeing the byte it was meant to cover.
    .array(
      fc.constantFrom("[", "]", "*", ".", "^", "$", "\\", "(", ")", "{", "}", "+", "?", "|", "a", "/", "_", " ", "\u0000", "\r\n"),
      { maxLength: 14 },
    )
    .map((a) => a.join("")),
);

test("PROPERTY breMetacharsIn: never throws on arbitrary input", () => {
  fc.assert(
    fc.property(patternText, (p) => {
      breMetacharsIn(p);
    }),
    CFG,
  );
});

test("PROPERTY breMetacharsIn: escaping every metacharacter clears the block — the prescribed remedy works", () => {
  // THE PAYOFF PROPERTY. The lint failure tells the author to "Escape it (\\X)". If escaping did
  // not actually clear the check, the remedy the error message prescribes would be a lie and the
  // author would be stuck with no way to satisfy a blocking gate.
  fc.assert(
    fc.property(patternText, (p) => {
      const r = breMetacharsIn(applyPrescribedRemedy(p));
      assert.deepEqual(r.blocking, [], `escaping did not clear ${JSON.stringify(p)}`);
      assert.deepEqual(r.warning, [], `escaping left a warning on ${JSON.stringify(p)}`);
    }),
    CFG,
  );
});

test("PROPERTY breMetacharsIn: a pattern containing no BRE metacharacter is never blocked", () => {
  // The false-positive lock. `( ) ] { } + ? |` are ERE metacharacters, NOT BRE ones — blocking them
  // would break the call-site rule's own proofs, which are shaped `someSymbol(`.
  //
  // `?` MOVED OUT of this alphabet and into its own property below. It is still never BLOCKED — the
  // point this lock exists to hold — but it now carries a WARNING, because it is literal under the
  // executor's own BRE argv and a quantifier under an ERE, so the same pattern silently finds
  // nothing on an ERE-defaulting grep. Leaving it here would have asserted `warning: []` over a
  // character that must warn, which is a stronger claim than this lock was ever making.
  const safeChars = fc
    .array(fc.constantFrom("a", "Z", "0", "_", "-", "/", ":", "(", ")", "]", "{", "}", "+", "|", " "), {
      maxLength: 20,
    })
    .map((a) => a.join(""));
  fc.assert(
    fc.property(safeChars, (p) => {
      const r = breMetacharsIn(p);
      assert.deepEqual(r.blocking, [], `false block on safe pattern ${JSON.stringify(p)}`);
      assert.deepEqual(r.warning, [], `false warning on safe pattern ${JSON.stringify(p)}`);
    }),
    CFG,
  );
});

test("PROPERTY breMetacharsIn: a ? is ALWAYS warn-tier and NEVER blocking, wherever it sits", () => {
  // The half of the false-positive lock `?` took with it when it left `safeChars`: a warning is a
  // legibility signal, and blocking it would refuse patterns that genuinely match under the
  // executor's own `grep -arn`. Nothing about position may change that.
  const withQ = fc
    .array(fc.constantFrom("a", "Z", "0", "_", "-", "/", ":", "(", ")", "]", "{", "}", "+", "|", " ", "?"), { maxLength: 20 })
    .map((a) => a.join(""))
    .filter((s) => s.includes("?"));
  fc.assert(
    fc.property(withQ, (p) => {
      const r = breMetacharsIn(p);
      assert.deepEqual(r.blocking, [], `? must never block, but did on ${JSON.stringify(p)}`);
      assert.deepEqual(r.warning, ["?"], `? must warn, but did not on ${JSON.stringify(p)}`);
    }),
    CFG,
  );
});

test("PROPERTY breMetacharsIn: results are deduplicated and the two severities never overlap", () => {
  fc.assert(
    fc.property(patternText, (p) => {
      const r = breMetacharsIn(p);
      assert.equal(new Set(r.blocking).size, r.blocking.length, `blocking not deduped for ${JSON.stringify(p)}`);
      assert.equal(new Set(r.warning).size, r.warning.length, `warning not deduped for ${JSON.stringify(p)}`);
      for (const w of r.warning) {
        assert.equal(r.blocking.includes(w), false, `${JSON.stringify(w)} reported at both severities`);
      }
    }),
    CFG,
  );
});
