import assert from "node:assert/strict";
import { test } from "node:test";
import { lintTask, proofEngineDivergenceViolations, proofGrepSafetyViolations } from "../src/lib/task-linter.js";
import { parseWhitelistedProof } from "../src/lib/review.js";
import type { Task } from "../src/lib/plan.js";

// ── W1-T2294 — a `grep:` PROOF PATTERN'S MEANING DEPENDS ON A REGEX ENGINE NOTHING DECLARES ──
//
// The house `grep:` dialect (parseDialectGrep, review.ts) always compiles to a fixed
// `["-arn", "--", pattern, path]` — BRE, author-unselectable, no `-E` reachable, and stays that
// way (design (ii): "grep: KEEPS ITS CURRENT INVOCATION"). The LEGACY fenced `` `grep ...` ``
// shape (parseWhitelistedProof's GREP_FENCE_RE branch) tokenises the author's own argv verbatim,
// so `-E` IS reachable there, and `proofGrepSafetyViolations` never looked at that arm at all
// (it matches `^grep:` before doing anything). `proofEngineDivergenceViolations` closes that gap
// behaviourally: it runs a legacy proof's pattern as both a BRE and an ERE against the file the
// proof already names and reports the two disagreeing, rather than trusting either verdict alone.

/** A minimal, otherwise-clean Task fixture — mirrors test/lint-grep-unmatchable.test.ts's own
 *  helper so this suite reads consistently with the rest of the linter's tests. */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    files: ["src/lib/example.ts"],
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
    ...over,
  };
}

function reader(files: Record<string, string>): (rel: string) => string | undefined {
  return (rel) => files[rel];
}

// Mirrors the task's own rationale exactly: `mergeConflict?: MergeConflictEvidence` reads 2 hits
// under BRE and 0 under ERE against src/lib/sweep.ts on this repo's live head. The fixture below
// is a controlled, minimal stand-in for that same shape so this suite never depends on
// src/lib/sweep.ts's own text drifting out from under it.
const DIVERGENT_PATTERN = "mergeConflict?:";
const DIVERGENT_FIXTURE_PATH = "fixture/divergent.ts";
const DIVERGENT_FIXTURE_TEXT = "  mergeConflict?: MergeConflictEvidence;\n";

const CONVERGENT_PATTERN = "TODO";
const CONVERGENT_FIXTURE_PATH = "fixture/convergent.ts";
const CONVERGENT_FIXTURE_TEXT = "  // TODO: revisit this\n";

// ── CLAIM 1: a proof whose meaning changes with the regex engine is reported, not silently
//    passed under whichever engine happened to run ─────────────────────────────────────────

test("CLAIM 1: a legacy backticked grep proof whose pattern reads different hit counts under BRE vs ERE is reported", () => {
  const t = task({
    id: "W1-T2294-DIVERGENT",
    acceptance: [
      {
        claim: "the merge-conflict field is declared",
        proof: `\`grep -Ean -- ${DIVERGENT_PATTERN} ${DIVERGENT_FIXTURE_PATH}\``,
      },
    ],
  });
  const opts = { readGrepProofFile: reader({ [DIVERGENT_FIXTURE_PATH]: DIVERGENT_FIXTURE_TEXT }) };
  const violations = proofEngineDivergenceViolations(t, opts);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-engine-divergence");
  assert.equal(violations[0]!.severity, "warn"); // reported, but never silently overrides a pass
  assert.match(violations[0]!.message, /1 hit\(s\) under a BASIC regular expression/);
  assert.match(violations[0]!.message, /0 under an EXTENDED one/);

  // The SAME fact is directly observable behind the report: the two engines really do disagree —
  // this is not a manufactured warning over a pattern that actually behaves identically.
  const parsed = parseWhitelistedProof(`\`grep -Ean -- ${DIVERGENT_PATTERN} ${DIVERGENT_FIXTURE_PATH}\``);
  assert.ok(parsed && parsed.kind === "grep" && parsed.authorSelectedArgv === true);
  const breHits = DIVERGENT_FIXTURE_TEXT.split("\n").filter((l) => l.includes("mergeConflict?:")).length;
  assert.equal(breHits, 1); // BRE: `?` is literal, matches the file's own literal `?`
  // ERE: `?` is a quantifier on `t`, so neither "mergeConflict:" nor "mergeConflic:" occurs.
  assert.equal(/mergeConflic(t)?:/.test(DIVERGENT_FIXTURE_TEXT), false);
});

// Exercises breEmulatingSource's own backslash handling directly (it is not exported, so this
// is observed only through proofEngineDivergenceViolations's verdict): `\(` and `\)` OPEN a
// BRE group — the pair is dropped from the emulated source entirely, so `foo\(bar\)` means
// "foo immediately followed by bar" (no literal parens required) under BRE, while the SAME two
// characters are an ordinary escaped literal paren pair under ERE (`foo\(bar\)` there matches
// only the literal text `foo(bar)`). A fixture line containing the literal text `foo(bar)`
// therefore matches under ERE but NOT under BRE — real divergence, not a manufactured one.
const PAREN_PATTERN = "foo\\(bar\\)";
const PAREN_FIXTURE_PATH = "fixture/paren-divergent.ts";
const PAREN_FIXTURE_TEXT = "  match: foo(bar) here\n";

test("CLAIM 1 (BRE emulation treats \\( \\) as a BRE group-open/close, diverging from the same two characters read as literal parens under ERE)", () => {
  const t = task({
    id: "W1-T2294-PAREN-DIVERGENT",
    acceptance: [
      { claim: "the paren-wrapped call is present", proof: `\`grep -Ean -- ${PAREN_PATTERN} ${PAREN_FIXTURE_PATH}\`` },
    ],
  });
  const opts = { readGrepProofFile: reader({ [PAREN_FIXTURE_PATH]: PAREN_FIXTURE_TEXT }) };
  const violations = proofEngineDivergenceViolations(t, opts);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /0 hit\(s\) under a BASIC regular expression/);
  assert.match(violations[0]!.message, /1 under an EXTENDED one/);

  // The same fact, directly observable: under ERE the pattern is literally `foo(bar)`, which the
  // fixture line contains verbatim; under BRE-emulation the parens vanish (a group, not a literal),
  // so the fixture line — which never contains contiguous "foobar" — cannot match.
  assert.equal(/foo\(bar\)/.test(PAREN_FIXTURE_TEXT), true);
  assert.equal(/foo(bar)/.test(PAREN_FIXTURE_TEXT.replace("foo(bar)", "")), false);
});

test("CLAIM 1 (folded into lintTask's own aggregate): the divergence report is not lost when merged with the rest of the linter's violations", () => {
  const t = task({
    id: "W1-T2294-DIVERGENT-MERGED",
    acceptance: [
      { claim: "x", proof: `\`grep -Ean -- ${DIVERGENT_PATTERN} ${DIVERGENT_FIXTURE_PATH}\`` },
    ],
  });
  const opts = { readGrepProofFile: reader({ [DIVERGENT_FIXTURE_PATH]: DIVERGENT_FIXTURE_TEXT }) };
  const merged = [...lintTask(t, opts).violations, ...proofEngineDivergenceViolations(t, opts)];
  assert.ok(merged.some((v) => v.check === "proof-engine-divergence"));
});

// ── CLAIM 2: a pattern that means the same thing under either engine draws no report ─────────

test("CLAIM 2: a legacy backticked grep proof whose pattern agrees under both engines draws no report", () => {
  const t = task({
    id: "W1-T2294-CONVERGENT",
    acceptance: [
      { claim: "a TODO marker is present", proof: `\`grep -an -- ${CONVERGENT_PATTERN} ${CONVERGENT_FIXTURE_PATH}\`` },
    ],
  });
  const opts = { readGrepProofFile: reader({ [CONVERGENT_FIXTURE_PATH]: CONVERGENT_FIXTURE_TEXT }) };
  assert.deepEqual(proofEngineDivergenceViolations(t, opts), []);
});

test("CLAIM 2 (does not fire on ordinary proofs): the house `grep:` dialect never draws a divergence report, even for the SAME divergent pattern — it is fixed BRE and cannot diverge", () => {
  const t = task({
    id: "W1-T2294-DIALECT-NEVER-DIVERGES",
    acceptance: [
      { claim: "the merge-conflict field is declared", proof: `grep: ${DIVERGENT_PATTERN} in ${DIVERGENT_FIXTURE_PATH}` },
    ],
  });
  const opts = { readGrepProofFile: reader({ [DIVERGENT_FIXTURE_PATH]: DIVERGENT_FIXTURE_TEXT }) };
  assert.deepEqual(proofEngineDivergenceViolations(t, opts), []);
});

test("CLAIM 2 (no reader ⇒ no opinion): absent opts.readGrepProofFile leaves the check silent, matching every other injected-predicate check here", () => {
  const t = task({
    id: "W1-T2294-NO-READER",
    acceptance: [
      { claim: "x", proof: `\`grep -Ean -- ${DIVERGENT_PATTERN} ${DIVERGENT_FIXTURE_PATH}\`` },
    ],
  });
  assert.deepEqual(proofEngineDivergenceViolations(t), []);
  assert.deepEqual(proofEngineDivergenceViolations(t, {}), []);
});

test("CLAIM 2 (forward reference stays silent): a path not yet on disk is not judged", () => {
  const t = task({
    id: "W1-T2294-FORWARD-PATH",
    acceptance: [{ claim: "x", proof: `\`grep -Ean -- ${DIVERGENT_PATTERN} fixture/not-written-yet.ts\`` }],
  });
  assert.deepEqual(proofEngineDivergenceViolations(t, { readGrepProofFile: reader({}) }), []);
});

// A pattern ending in a lone, unescaped backslash is a DANGLING escape — invalid as a JS-compiled
// regular expression (the direct ERE reading throws "\\ at end of pattern"), even though the SAME
// trailing backslash is well-formed once emulated as BRE (it becomes an escaped literal backslash
// there, since a BRE has no "backslash at all" state, only "escaped char" or "ordinary char").
// boundedRegExp declines (returns undefined) on that throw rather than guessing a verdict from
// only the engine that DID compile — matching every other decline case in this file.
const TRAILING_BACKSLASH_PATTERN = "TODO\\"; // literal: T O D O \
const TRAILING_BACKSLASH_FIXTURE_PATH = "fixture/trailing-backslash.ts";
const TRAILING_BACKSLASH_FIXTURE_TEXT = "  // TODO\\ revisit\n";

test("CLAIM 2 (declines rather than guesses): a pattern with a dangling trailing backslash fails to compile as an ERE, so no verdict is reported even though the BRE emulation compiles fine", () => {
  const t = task({
    id: "W1-T2294-TRAILING-BACKSLASH",
    acceptance: [
      {
        claim: "x",
        proof: `\`grep -Ean -- ${TRAILING_BACKSLASH_PATTERN} ${TRAILING_BACKSLASH_FIXTURE_PATH}\``,
      },
    ],
  });
  const opts = { readGrepProofFile: reader({ [TRAILING_BACKSLASH_FIXTURE_PATH]: TRAILING_BACKSLASH_FIXTURE_TEXT }) };
  assert.deepEqual(proofEngineDivergenceViolations(t, opts), []);

  // The same fact, directly observable: the raw pattern is not a compilable JS regex source at
  // all (a dangling trailing backslash), which is exactly what makes the direct ERE reading fail.
  assert.throws(() => new RegExp(TRAILING_BACKSLASH_PATTERN, ""));
});

// ── CLAIM 3: the engine the house dialect actually runs under is stated where an author reads
//    it, and matches the argv the parser emits ────────────────────────────────────────────────

test("CLAIM 3: parseDialectGrep's own emitted argv is `-arn` (BRE), and proof-grep-safety's violation message states that exact invocation", () => {
  const parsed = parseWhitelistedProof("grep: [call-site] in docs/foo.md");
  assert.ok(parsed && parsed.kind === "grep");
  assert.deepEqual(parsed!.args, ["-arn", "--", "[call-site]", "docs/foo.md"]);

  const t = task({
    id: "W1-T2294-DRIFT-CHECK",
    acceptance: [{ claim: "x", proof: "grep: [call-site] in docs/foo.md" }],
  });
  const violations = proofGrepSafetyViolations(t);
  const blocking = violations.find((v) => v.severity === "block");
  assert.ok(blocking);
  // The message names the SAME invocation the parser actually emits — no more `-rn` drift
  // between what an author reads and what `execWhitelistedProof` (review.ts) actually runs.
  assert.match(blocking!.message, /`grep -arn -- <pattern> <path>`/);
  assert.match(blocking!.message, /BASIC REGULAR EXPRESSION/);
  assert.doesNotMatch(blocking!.message, /`grep -rn -- <pattern> <path>`/);
});

// ── CLAIM 4: the house dialect still compiles to the same invocation it does today, so existing
//    proofs keep their meaning ───────────────────────────────────────────────────────────────

test("CLAIM 4: an ordinary house-dialect grep proof (no metacharacters) still compiles to `[-arn, --, pattern, path]`, unchanged", () => {
  const parsed = parseWhitelistedProof("grep: loadPolicy in src/lib/review.ts");
  assert.ok(parsed && parsed.kind === "grep");
  assert.equal(parsed!.command, "grep");
  assert.deepEqual(parsed!.args, ["-arn", "--", "loadPolicy", "src/lib/review.ts"]);
  assert.equal(parsed!.label, "loadPolicy in src/lib/review.ts");
  // 325 live shards' worth of dialect proofs (46 containing `(`, 15 containing `.`) depend on this
  // exact BRE invocation never changing — `authorSelectedArgv` is absent (falsy) on this shape,
  // confirming the dialect form is not the one this task's new check ever examines.
  assert.equal(parsed!.authorSelectedArgv, undefined);
});
