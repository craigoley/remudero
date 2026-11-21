import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveFixMode, FIX_CLASS_NOT_PROBE_LINES, renderFixPrompt, type FixEvidence } from "#src/lib/prompt-render.js";
import { REFUSAL_REASON_CLASSES, type CriterionVerdict } from "#src/lib/review.js";

// W1-T14167: a fix round answering reviewer findings is told that each finding is one probe of a
// class, so it fixes the rule the probe broke and names that class (and its test) in its report.
// Only the reviewer-unmet round carries the block; every other round renders as before.

const task = { id: "W1-T9", title: "fixture task", files: ["src/lib/fixture.ts"], design: "FIXTURE DESIGN TEXT" };
const branch = "run-W1-T9-1795000000000";

const unmet = (over: Partial<CriterionVerdict> = {}): CriterionVerdict & { criterionIndex: number } => ({
  claim: "the parser refuses a malformed record", proof: "grep: refuses in test/fixture.test.ts", met: false,
  reason: "a record missing its second field still parses", proof_exec: "executed_fail", criterionIndex: 1, ...over,
});

const review: FixEvidence["review"] = { unmetCriteria: [unmet()], summary: "one visible gap" };
const ciFailures = [{ name: "unit", logTail: "not ok 1 - boom" }];

/** Every fix mode except reviewer-unmet, each with the mode its evidence must derive (the control). */
const OTHER_ROUNDS: ReadonlyArray<{ label: string; mode: string; evidence: FixEvidence }> = [
  { label: "ci-log", mode: "ci-log", evidence: { ciFailures } },
  { label: "ci-log beside a same-head review", mode: "ci-log", evidence: { ciFailures, review } },
  {
    label: "merge-conflict", mode: "merge-conflict",
    evidence: { mergeConflict: { files: [{ path: "src/lib/fixture.ts", oursDeleted: 1, theirsDeleted: 1 }], oursLog: "ours", theirsLog: "theirs" } },
  },
  { label: "plan-gate", mode: "plan-gate", evidence: { planGateFindings: [{ check: "plan-lint", firstLine: "bad key" }] } },
  { label: "gate-fix", mode: "gate-fix", evidence: { actionableGateFailures: [{ reason: "add the missing trailer" }] } },
  {
    label: "proof-discrimination", mode: "proof-discrimination",
    evidence: { proofDiscrimination: { proofs: [{ claim: "c", proof: "grep: x in y", proofExec: "not_executable" }] } },
  },
  {
    label: "body-coverage", mode: "body-coverage",
    evidence: { review: { unmetCriteria: [unmet({ reason: "matched 1/3 proof keywords", proof_exec: "not_executable" })], summary: "keyword gap" } },
  },
  { label: "a review with no unmet criterion", mode: "reviewer-unmet", evidence: { review: { unmetCriteria: [], summary: "test theater" } } },
];

const render = (evidence: FixEvidence, harnessCommits = false): string =>
  renderFixPrompt({ task, round: 2, branch, evidence, harnessCommits });

/** The block exactly as the review round splices it after the findings: a blank separator line, then the lines. */
const BLOCK = ["", "", ...FIX_CLASS_NOT_PROBE_LINES].join("\n");
const FOOTER_START = "\nReport exactly one anchored `FIX_OUTCOME:` line";
const countOf = (text: string, needle: string): number => text.split(needle).length - 1;
const footerOf = (prompt: string): string => {
  const at = prompt.indexOf(FOOTER_START);
  assert.ok(at >= 0, "the prompt carries the outcome footer");
  return prompt.slice(at);
};

test("W1-T14167 criterion 1: a reviewer-unmet round renders the class-not-probe block once, between the findings and the footer", () => {
  assert.equal(deriveFixMode({ review }), "reviewer-unmet", "control: the fixture reaches the review round");
  assert.ok(FIX_CLASS_NOT_PROBE_LINES.length >= 3 && FIX_CLASS_NOT_PROBE_LINES.length <= 4, "three or four short lines");
  for (const harnessCommits of [false, true]) {
    const prompt = render({ review }, harnessCommits);
    assert.equal(countOf(prompt, BLOCK), 1, "the block renders once, contiguous");
    for (const line of FIX_CLASS_NOT_PROBE_LINES) assert.equal(countOf(prompt, line), 1, `rendered once: ${line}`);
    const at = prompt.indexOf(BLOCK);
    assert.ok(prompt.indexOf("reviewer verdict: UNMET — a record missing its second field still parses") < at, "after the findings");
    assert.ok(at < prompt.indexOf(FOOTER_START), "before the outcome footer");
  }
  const text = FIX_CLASS_NOT_PROBE_LINES.join("\n");
  assert.match(text, /each review finding .*one probe of a class/i);
  assert.match(text, /fix the rule the probe broke/i);
  assert.match(text, /neighbouring inputs are covered/i);
  assert.match(text, /parser validates the record's whole shape, not .*malformed field shown/i);
  assert.match(text, /name each finding's class and the test/i);
  assert.match(text, /never reverse a requirement an earlier round of this PR satisfied without naming/i);
});

test("W1-T14167 criterion 2: no other round carries the block", () => {
  for (const { label, mode, evidence } of OTHER_ROUNDS) {
    assert.equal(deriveFixMode(evidence), mode, `control: the ${label} fixture derives ${mode}`);
    for (const harnessCommits of [false, true]) {
      const prompt = render(evidence, harnessCommits);
      assert.ok(prompt.includes(`MODE: ${mode}.`), `control: the ${label} prompt names its mode`);
      for (const line of FIX_CLASS_NOT_PROBE_LINES) {
        assert.ok(!prompt.includes(line), `${label} (harnessCommits=${harnessCommits}) must not carry: ${line}`);
      }
    }
  }
});

test("W1-T14167 criterion 2: the FIX_OUTCOME lines and the REFUSED grammar are unchanged and shared by every round", () => {
  const reviewFooter = footerOf(render({ review }));
  assert.equal(countOf(reviewFooter, FIX_CLASS_NOT_PROBE_LINES[0]!), 0, "the block is not part of the footer");
  assert.deepEqual(reviewFooter.split("\n").slice(1, 11), [
    "Report exactly one anchored `FIX_OUTCOME:` line before COMMIT_MESSAGE/PR_URL, choosing one outcome:",
    "FIX_OUTCOME: FIXED — the saved edits fix this head; name COMMIT_MESSAGE if you can.",
    "FIX_OUTCOME: BASE_RED — the failing tests also fail at origin/main's tip; the harness verifies before refunding a strike.",
    "FIX_OUTCOME: FLAKE — rerun the failing jobs once on this head; only green CI refunds the strike.",
    "FIX_OUTCOME: NEEDS_SCOPE <path>[,<path>...] — name repo-relative paths with no ..; non-test paths go to scope escalation. " +
      "NEEDS_SCOPE is for a red this PR's diff causes: a red in a file the diff does not touch or reach, which passes at main, is FLAKE, and the harness reruns it as one either way. " +
      "Leave those out-of-scope edits saved (uncommitted) in the worktree when you report — never revert them: the scope amendment admits only paths this round actually changed.",
    "FIX_OUTCOME: NEEDS_DESIGN <reason> — name the design blocker in at most 500 characters; no second round runs on this head.",
    "If the blocker is that an acceptance criterion cannot be met as written, put this block above the FIX_OUTCOME line, one line per criterion:",
    "REFUSED:",
    `<criterion index>. [${REFUSAL_REASON_CLASSES.join("|")}] <one concrete sentence>`,
    "Files under test/ may be added or edited although undeclared (R1); weakened assertions are judged by the reviewer's test-theater and assertion-discrimination gates.",
  ]);
  for (const { label, evidence } of OTHER_ROUNDS) {
    if (deriveFixMode(evidence) === "plan-gate") continue; // the plan-gate round never carried this footer
    assert.equal(footerOf(render(evidence)), reviewFooter, `${label} shares the review round's footer byte for byte`);
  }
});

test("W1-T14167 criterion 2: the review round's scope lines and design block are unchanged around the block", () => {
  const prompt = render({ review });
  const stripped = prompt.replace(BLOCK, "");
  for (const line of FIX_CLASS_NOT_PROBE_LINES) assert.ok(!stripped.includes(line), "the block is spliced in one place only");
  assert.ok(stripped.includes("one visible gap\n\n1. claim: the parser refuses a malformed record"), "summary then findings, as before");
  assert.ok(stripped.includes("rerun the proof yourself before claiming FIXED.\n" + FOOTER_START),
    "the findings' last line runs straight into the footer once the block is removed");
  assert.equal(countOf(stripped, "AUTHORITATIVE TASK DESIGN:\nFIXTURE DESIGN TEXT"), 1, "the design block renders once");
  assert.equal(countOf(stripped, "DECLARED SCOPE (W1-T1227): this task's PR may only touch: src/lib/fixture.ts."), 1, "the scope line renders once");
  // Everything ahead of the round's own body (header, design, scope) matches the ci-log round's, mode line aside.
  const lead = (text: string, bodyStart: string) => text.slice(0, text.indexOf(bodyStart)).replace(/^MODE: .*$/m, "MODE: X.");
  assert.equal(lead(prompt, "The review gate is FAILING"), lead(render({ ciFailures }), "Required CI check(s) are FAILING"));
});
