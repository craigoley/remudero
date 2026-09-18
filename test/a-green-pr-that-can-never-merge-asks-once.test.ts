/**
 * CAPPED-ARM-ESCALATION (on W1-T185/W1-T229) — THE GREEN PR THAT CAN NEVER MERGE, AND SAID SO TO NOBODY.
 *
 * Two correct behaviours combine into a defect:
 *
 *   - a CAPPED verdict posts `state: "success"` ON PURPOSE. CAPPED IS NOT FAIL, and W1-T185
 *     criterion 3 forbids reddening a PR just because a proof would not parse.
 *   - `decideAutoMergeArm` refuses to arm a capped verdict without an executed proof or a
 *     ledgered operator override.
 *
 * So GitHub renders the PR fully green, every required check passing, and the sweep declines to
 * arm it — recording `acted: false` and a stand-down reason, every pass, forever. Measured on
 * #5941, whose task record carried three `grep:` proofs naming a test file that does not exist
 * (`capped_reason: exec-error:3`). The operator merged it by hand and asked why the fleet had not.
 *
 * A STUCK PR THAT LOOKS FINE IS WORSE THAN ONE THAT LOOKS BROKEN. This asks a human, once.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, each pinned below: it does not merge, does not weaken the
 * CAPPED floor, does not grant an override, and does not change the stand-down that lets a repaired
 * PR arm itself on the very next pass.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DISPOSITION_RULES, type OpenPrView } from "../src/lib/sweep.js";
import { terminalArmRefusal } from "../src/run-task.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";

const HEAD = "aaaa111";
const OTHER_HEAD = "bbbb222";

function posted(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { step: "review.posted", task_id: "W1-T1", head_sha: HEAD, state: "success", capped: true, ...over };
}

function greenPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 5941,
    prUrl: "https://github.com/o/r/pull/5941",
    taskId: "W1-T1",
    headSha: HEAD,
    checksState: "green",
    reviewState: "success",
    unmetCriteria: [],
    ...over,
  } as OpenPrView;
}

/** The disposition this board state actually resolves to, first match wins. A FRESH PR (age 0) at a
 *  fixed clock, so no age- or time-gated row can claim the state out from under the assertion. */
const AGE_DAYS = 0;
const NOW = Date.parse("2026-09-17T12:00:00Z");

function ruleFor(pr: OpenPrView) {
  return DISPOSITION_RULES.find((r) => r.when(pr, DEFAULT_SWEEP_POLICY, AGE_DAYS, NOW));
}

function dispositionFor(pr: OpenPrView): string | undefined {
  return ruleFor(pr)?.disposition;
}

test("capped-arm-escalation: a capped, un-overridden verdict at this head is TERMINAL", () => {
  assert.equal(terminalArmRefusal([posted()], "W1-T1", HEAD), true);
});

test("capped-arm-escalation: everything that CAN still arm reads false, not terminal", () => {
  // An uncapped verdict arms outright.
  assert.equal(terminalArmRefusal([posted({ capped: false })], "W1-T1", HEAD), false);
  // A plan-only capped verdict arms WITHOUT an override (the W1-T205 carve-out). Escalating on it
  // would file a question about a PR that merges perfectly well — noise, and the fastest way to
  // get a genuine escalation ignored.
  assert.equal(terminalArmRefusal([posted({ plan_only: true })], "W1-T1", HEAD), false);
});

test("capped-arm-escalation: ABSENT IS NOT TERMINAL — an unreadable ledger cannot manufacture a question", () => {
  // No verdict recoverable at all. `decideSweepArm` ARMS on this absence ("no evidence to refuse
  // on"), so there is nothing to warn about. A rotated ledger, or a PR reviewed on another machine,
  // must never turn into an escalation.
  assert.equal(terminalArmRefusal([], "W1-T1", HEAD), undefined);
  assert.equal(terminalArmRefusal([posted({ head_sha: OTHER_HEAD })], "W1-T1", HEAD), undefined, "another head's verdict says nothing about this one");
  assert.equal(terminalArmRefusal([posted()], undefined, HEAD), undefined);
  assert.equal(terminalArmRefusal([posted()], "W1-T1", undefined), undefined);
  // A line carrying no `capped` key is not recoverable as arm facts either.
  assert.equal(terminalArmRefusal([posted({ capped: undefined })], "W1-T1", HEAD), undefined);
});

test("capped-arm-escalation: an operator override makes the refusal non-terminal again", () => {
  const withOverride = [
    posted(),
    { step: "automerge.capped_override_granted", task_id: "W1-T1", head_sha: HEAD, by: "craig", reason: "measured by hand" },
  ];
  assert.equal(terminalArmRefusal(withOverride, "W1-T1", HEAD), false, "an override recorded for THIS head must clear the terminal reading");

  // ... and it is HEAD-BOUND. An override granted against an earlier head must not quietly cover a
  // new one — that binding is W1-T219's, and this reading must not be the thing that loses it.
  const staleOverride = [
    posted(),
    { step: "automerge.capped_override_granted", task_id: "W1-T1", head_sha: OTHER_HEAD, by: "craig", reason: "an older head" },
  ];
  assert.equal(terminalArmRefusal(staleOverride, "W1-T1", HEAD), true);
});

test("capped-arm-escalation: the terminal PR escalates instead of being called mergeable", () => {
  // THE WHOLE POINT. Before this row, this exact board state matched `mergeable`, called the arm
  // effector, was refused, and recorded `acted: false` — forever, silently.
  assert.equal(dispositionFor(greenPr({ armRefusalIsTerminal: true })), "blocked-ambiguous");
});

test("capped-arm-escalation: POSITIVE MATCH ONLY — absent or false still reaches mergeable, unchanged", () => {
  // Never inferred from the absence of `false`, the same discipline `mergeable` and the draft row
  // apply. These two cases are every PR on a healthy board, and they must be byte-identical to
  // before this change.
  assert.equal(dispositionFor(greenPr()), "mergeable", "an absent reading changes nothing");
  assert.equal(dispositionFor(greenPr({ armRefusalIsTerminal: false })), "mergeable");
});

test("capped-arm-escalation: the row cannot fire on a PR that is not already green and reviewed", () => {
  // It is an EARLIER STOP on the mergeable path, not a new way to block. A red or unreviewed PR
  // keeps whichever row owns it today, so this can never preempt the fix rungs.
  assert.notEqual(dispositionFor(greenPr({ armRefusalIsTerminal: true, checksState: "red" })), "blocked-ambiguous");
  assert.notEqual(dispositionFor(greenPr({ armRefusalIsTerminal: true, reviewState: "failure", unmetCriteria: ["x"] as never })), "blocked-ambiguous");
});

test("capped-arm-escalation: the escalation reason names the remedy, not just the refusal", () => {
  // An unexplained block is the shape that gets overridden blind. The operator reading this must
  // learn BOTH exits: repair the proofs (a new head re-earns the arm automatically) or record an
  // explicit override.
  const pr = greenPr({ armRefusalIsTerminal: true });
  const reason = ruleFor(pr)!.reason(pr, DEFAULT_SWEEP_POLICY, AGE_DAYS, NOW);
  assert.match(reason, /CAPPED/);
  assert.match(reason, /looks mergeable on GitHub and is not/);
  assert.match(reason, /--override-capped-by/, "the operator exit must be named");
  assert.match(reason, /repairing the proofs/, "the self-healing exit must be named FIRST-class, not implied");
});
