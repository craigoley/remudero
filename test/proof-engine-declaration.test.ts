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
