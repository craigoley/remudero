import { strict as assert } from "node:assert";
import { test } from "node:test";
import { acceptanceAuthorTimeCheck, wrappedGrepPattern } from "../src/lib/review.js";

/**
 * W1-T2544 — two consecutive retro cycles, six hours apart, failed with entirely correct CONTENT
 * and nothing but proof formatting wrong. Both reached `ok: true, "Acceptance block is judgeable"`
 * with no indication anything was amiss.
 *
 * THE WRAPPER CHANGED BETWEEN THEM (#3356 double quotes, #3413 backticks), which is why nothing
 * here special-cases a delimiter.
 *
 * EVERYTHING THIS ADDS IS ADVISORY, AND THAT IS THE DESIGN, NOT A COMPROMISE. `acceptance-author-
 * gate` is a REQUIRED check and this function is pure, so it cannot read the target file — and a
 * wholly-wrapped pattern CAN be correct (MASTER-PLAN.md is full of code spans; JSON really does
 * contain `"key"`). Refusing would block correct PRs. W1-T1060/#3191 settled the same boundary from
 * the other side: this gate judges SHAPE; dialect is a REVIEW verdict.
 */

const BODY = (proofs: string[]) =>
  ["Some prose.", "", "Acceptance:", ...proofs.map((p, i) => `- claim ${i + 1} | ${p}`), ""].join("\n");

test("W1-T2544 criterion 1: a backticked grep pattern is reported, and the note names the bare pattern", () => {
  const r = acceptanceAuthorTimeCheck(BODY(["grep: `FOLDED BY R39` in MASTER-PLAN.md"]));
  assert.equal(r.ok, true, "advisory, never a refusal — a wrapped pattern can be legitimate");
  assert.equal(r.defect, undefined);
  assert.match(r.message, /grep: FOLDED BY R39 in <path>/, "names the bare pattern, so the fix is a copy-paste");
  assert.match(r.message, /no -F/, "and says WHY, so the next author does not rediscover it");
});

test("W1-T2544 criterion 2: every delimiter is reported alike — the one that changed between two cycles is not special-cased", () => {
  for (const d of ['"', "'", "`"]) {
    const r = acceptanceAuthorTimeCheck(BODY([`grep: ${d}THING${d} in MASTER-PLAN.md`]));
    assert.equal(r.ok, true, `delimiter ${d} is reported, never refused`);
    assert.match(r.message, /wrap their pattern in/, `delimiter ${d} must be reported`);
    assert.match(r.message, /grep: THING in <path>/);
  }
});

test("W1-T2544 criterion 4: a pattern that merely CONTAINS a delimiter, or has mismatched ones, is not even reported", () => {
  // The false-POSITIVE guard. A noisy advisory is skimmed past, which costs the arm its value.
  for (const p of [
    "grep: a `code span` inside in MASTER-PLAN.md", // contains, not wrapped
    "grep: `mismatched\" in MASTER-PLAN.md",        // mismatched pair
    "grep: plain text in MASTER-PLAN.md",           // no delimiter at all
    "grep: `a` and `b` in MASTER-PLAN.md",          // wraps, but a delimiter survives inside
  ]) {
    assert.equal(wrappedGrepPattern(p), undefined, `must not flag: ${p}`);
    const chk = acceptanceAuthorTimeCheck(BODY([p]));
    assert.equal(chk.ok, true, `must not refuse: ${p}`);
    assert.doesNotMatch(chk.message, /wrap their pattern/, `must not even report a wrap: ${p}`);
  }
});

test("W1-T2544 criterion 5: BOTH real retro bodies, replayed — reported as written, silent once unwrapped", () => {
  const r3413 = [
    "grep: `https://github.com/craigoley/remudero/pull/3404` in MASTER-PLAN.md",
    "grep: `THIS CYCLE (RETRO-1788193081371, 2026-08-31)` in MASTER-PLAN.md",
    "grep: `MINTED P63; THE HIGHEST EXISTING HEADER WAS P62` in MASTER-PLAN.md",
  ];
  const r3356 = [
    'grep: "https://github.com/craigoley/remudero/pull/3323" in MASTER-PLAN.md',
    'grep: "FOLDED TO TWELVE LINES BY R38" in MASTER-PLAN.md',
  ];
  for (const [name, proofs] of [["#3413", r3413], ["#3356", r3356]] as [string, string[]][]) {
    const noted = acceptanceAuthorTimeCheck(BODY(proofs));
    assert.equal(noted.ok, true, `${name} is reported, never refused`);
    assert.match(
      noted.message,
      new RegExp(`${proofs.length} grep proof\\(s\\) wrap`),
      `${name} must count ALL of them, not just the first`,
    );

    const fixed = proofs.map((p) => p.replace(/grep: (["'`])(.*)\1 in/, "grep: $2 in"));
    const clean = acceptanceAuthorTimeCheck(BODY(fixed));
    assert.equal(clean.ok, true, `${name} must pass once unwrapped`);
    assert.equal(
      clean.message,
      "Acceptance block is judgeable",
      `${name} unwrapped must be CLEAN — a note that never goes away is noise`,
    );
  }
});

test("W1-T2544 criterion 3: a proof that cannot execute is counted and its ceiling named, without blocking", () => {
  // `demonstration:` is a deliberate third dialect (W1-T277); task-linter refuses it only on a
  // `verify: auto` task, and a PR body carries no `verify` field. What IS unambiguous is the
  // ceiling, so that is what gets said.
  const r = acceptanceAuthorTimeCheck(
    BODY(["grep: REAL THING in MASTER-PLAN.md", "demonstration: the operator observes the console"]),
  );
  assert.equal(r.ok, true, "must NOT block — that is a policy this gate does not get to decide");
  assert.equal(r.defect, undefined);
  assert.match(r.message, /1 of 2 proof\(s\) cannot execute/);
  assert.match(r.message, /proof_exec 1\/2/, "names the ceiling the verdict will actually cap at");
  assert.match(r.message, /cannot arm auto-merge/, "and the consequence of that ceiling");
});

test("W1-T2544 criterion 6: a body that already passed still passes with the identical message", () => {
  // The regression lock: this adds a note, it does not reshape the contract.
  const r = acceptanceAuthorTimeCheck(BODY(["grep: A REAL PATTERN in MASTER-PLAN.md", "unit test: test/x.test.ts"]));
  assert.equal(r.ok, true);
  assert.equal(r.message, "Acceptance block is judgeable", "the unchanged message, exactly");
});

test("W1-T2544: both notes combine rather than one hiding the other", () => {
  const r = acceptanceAuthorTimeCheck(BODY(["grep: `WRAPPED` in MASTER-PLAN.md", "demonstration: an operator action"]));
  assert.match(r.message, /wrap their pattern/);
  assert.match(r.message, /cannot execute/);
});

test("W1-T2544: the pre-existing REFUSALS are untouched and still take precedence", () => {
  assert.equal(acceptanceAuthorTimeCheck("no header at all").defect, "no-header");
  assert.equal(acceptanceAuthorTimeCheck(BODY(["grep: `x` in y"]).replace("Acceptance:", "Stuff:")).defect, "no-header");
  assert.equal(acceptanceAuthorTimeCheck("Remudero-Task: W1-T1\n").ok, true, "a trailer body short-circuits, as before");
});
