// W1-T2371 — an amendment PR EDITS a shard; it does not perform the work that shard declares. So
// the declared-versus-actual comparison must ALWAYS mismatch for the entire class, and the judge
// read that mismatch as "incomplete work or misdeclared scope". MEASURED at filing: of 776 merged
// PRs, 21 of 21 resolvable amendments had a plan-only diff AND amended a shard declaring source.
//
// THE JUDGE READS NO DIFF BY DESIGN (empty tool allowlist, cheapest tier, 60-file cap), so the
// narrowing had to be computable from what it is ALREADY handed. These tests pin that.

import assert from "node:assert/strict";
import test from "node:test";

import { FILING_SUBJECT_RE } from "../src/lib/sweep.js";

import {
  PLAN_DECLARING_SUBJECT_RE,
  RISK_JUDGE_CHANGE_VIEW_FILE_CAP,
  RISK_JUDGE_TOOLS,
  boundRiskJudgeChangeView,
  buildRiskJudgePrompt,
  isPlanOnlyAmendment,
  type RiskJudgeChangedFile,
  type RiskJudgeInput,
} from "../src/lib/risk-judge.js";

const f = (path: string): RiskJudgedFileShim => ({ path, additions: 1, deletions: 1 });
type RiskJudgedFileShim = RiskJudgeChangedFile;

/** The founding shape: a shard declaring SOURCE, amended by a diff touching one YAML. */
function amendmentInput(over: Partial<RiskJudgeInput["change"]> = {}): RiskJudgeInput {
  return {
    change: {
      description: "chore(plan): amend W1-T2318's acceptance to name the executor",
      files: ["src/run-task.ts", "src/lib/status.ts", "test/x.test.ts"],
      changeView: boundRiskJudgeChangeView([f("plan/tasks.d/W1-T2318-x.yaml")]),
      ...over,
    },
    gatesState: {},
    planContext: { taskId: "W1-T2318" },
  };
}

test("W1-T2371 criterion 1: the founding shape is recognised and the prompt says the mismatch is expected", () => {
  const prompt = buildRiskJudgePrompt(amendmentInput());
  assert.match(prompt, /THIS IS A PLAN-ONLY AMENDMENT/);
  assert.match(prompt, /NOT\n?\s*evidence of incomplete work or of misdeclared scope/);
  assert.match(prompt, /Do not classify HIGH on\n?that mismatch alone/);
});

test("W1-T2371 criterion 2 (falsifier): BOTH HALVES ARE REQUIRED — a plan subject over source is judged as today", () => {
  // The half an author can type must not be enough on its own.
  const sourceTouching = amendmentInput({
    changeView: boundRiskJudgeChangeView([f("plan/tasks.d/W1-T2318-x.yaml"), f("src/run-task.ts")]),
  });
  assert.equal(isPlanOnlyAmendment(sourceTouching.change.description, sourceTouching.change.changeView), false);
  assert.doesNotMatch(buildRiskJudgePrompt(sourceTouching), /PLAN-ONLY AMENDMENT/);
});

test("W1-T2371 criterion 2 (falsifier): and a NON-declaring subject over a plan-only diff is not narrowed", () => {
  const featSubject = amendmentInput({ description: "feat(status): rewrite the projection" });
  assert.equal(isPlanOnlyAmendment(featSubject.change.description, featSubject.change.changeView), false);
  assert.doesNotMatch(buildRiskJudgePrompt(featSubject), /PLAN-ONLY AMENDMENT/);
});

test("W1-T2371 criterion 3: a change declaring NOTHING is unaffected, and so is an ordinary mismatch", () => {
  const declaresNothing = amendmentInput({ description: "feat(x): do a thing", files: [] });
  assert.doesNotMatch(buildRiskJudgePrompt(declaresNothing), /PLAN-ONLY AMENDMENT/);
  const ordinary = amendmentInput({
    description: "fix(sweep): close a leftover PR",
    changeView: boundRiskJudgeChangeView([f("src/lib/sweep.ts")]),
  });
  assert.doesNotMatch(buildRiskJudgePrompt(ordinary), /PLAN-ONLY AMENDMENT/);
});

test("W1-T2371 (falsifier): A TRUNCATED VIEW CANNOT PROVE PLAN-ONLY, so it declines", () => {
  // THE ROW THAT MATTERS FOR SAFETY. Absence from a capped enumeration is not absence from the
  // change — the same reasoning declaredFilesAbsentFromChange already applies. Fail toward today.
  const many: RiskJudgeChangedFile[] = Array.from({ length: RISK_JUDGE_CHANGE_VIEW_FILE_CAP + 1 }, (_, i) =>
    f(`plan/tasks.d/W1-T${i}.yaml`),
  );
  const view = boundRiskJudgeChangeView(many);
  assert.equal(view.truncated, true, "sanity: the fixture must actually be truncated");
  assert.equal(isPlanOnlyAmendment("chore(plan): amend many", view), false);
});

test("W1-T2371 (falsifier): an empty or absent change view declines", () => {
  assert.equal(isPlanOnlyAmendment("chore(plan): x", undefined), false);
  assert.equal(isPlanOnlyAmendment("chore(plan): x", boundRiskJudgeChangeView([])), false);
  assert.equal(isPlanOnlyAmendment(undefined, boundRiskJudgeChangeView([f("plan/a.yaml")])), false);
});

test("W1-T2371: PLAN_DECLARING_SUBJECT_RE matches a filing subject and does NOT match an implementation subject", () => {
  // The surface driven DIRECTLY, both arms, with literal arguments — the shape
  // negative-reachability-ratchet recognises (see test/dep-review.test.ts's CONVENTIONAL_TITLE_
  // PREFIX_RE precedent, filed for exactly this census hit). A loop over an array of cases drives
  // the same assertions but hides both arms from a static scan, so the ratchet reads the surface as
  // fixture-less and is RIGHT to: nothing in the file shows where the pattern stops.
  assert.equal(PLAN_DECLARING_SUBJECT_RE.test("chore(plan): amend W1-T2318"), true);
  assert.equal(PLAN_DECLARING_SUBJECT_RE.test("chore(triage): file a finding"), true);
  assert.equal(PLAN_DECLARING_SUBJECT_RE.test("chore(feedback): record a ruling"), true);
  assert.equal(PLAN_DECLARING_SUBJECT_RE.test("docs(plan): restate a rule"), true);
  assert.equal(PLAN_DECLARING_SUBJECT_RE.test("plan: file a shard"), true);
  assert.equal(PLAN_DECLARING_SUBJECT_RE.test("docs: a doc change"), true);
  // The negative arm: an IMPLEMENTATION subject must never buy the narrowing, however plan-ish.
  assert.equal(PLAN_DECLARING_SUBJECT_RE.test("feat(plan): build the plan reconciler"), false, "feat is not a filing");
  assert.equal(PLAN_DECLARING_SUBJECT_RE.test("fix(plan): repair a shard loader"), false, "fix is not a filing");
  assert.equal(PLAN_DECLARING_SUBJECT_RE.test("chore(deps): bump a package"), false);
  assert.equal(PLAN_DECLARING_SUBJECT_RE.test("refactor: move a module"), false);
  assert.equal(PLAN_DECLARING_SUBJECT_RE.test(" chore(plan): leading space"), false, "anchored at the start");
});

test("W1-T2371 criterion 4: the judge STILL reads no diff and STILL carries an empty tool allowlist", () => {
  // The narrowing must cost no extra input and no extra budget.
  assert.deepEqual(RISK_JUDGE_TOOLS, [], "the empty allowlist is the cost bound this task must not spend");
  const prompt = buildRiskJudgePrompt(amendmentInput());
  assert.match(prompt, /YOU ARE NOT SHOWN A DIFF/);
  assert.doesNotMatch(prompt, /^\+\+\+ |^--- |^@@ /m, "no hunk, no patch");
});

test("W1-T2371 criterion 5: it reads the SAME bounded view the prompt already renders", () => {
  // Not a second enumeration: the identical changeView drives both the ACTUAL CHANGE section and
  // the narrowing, so the two can never disagree about what was touched.
  const input = amendmentInput();
  const prompt = buildRiskJudgePrompt(input);
  assert.match(prompt, /ACTUAL CHANGE \(REST-sourced/);
  assert.match(prompt, /plan\/tasks\.d\/W1-T2318-x\.yaml: \+1\/-1/);
  assert.equal(isPlanOnlyAmendment(input.change.description, input.change.changeView), true);
});

test("W1-T2371: the narrowing does not license the change — every other ground for HIGH survives", () => {
  const prompt = buildRiskJudgePrompt(amendmentInput());
  assert.match(prompt, /THIS NARROWS ONE INFERENCE ONLY/);
  assert.match(prompt, /classify HIGH exactly as you/);
  assert.match(prompt, /THIS FRAMING IS NOT A LICENCE/, "the pre-existing licence disclaimer must survive");
});

test("W1-T2371: the subject vocabulary has ONE definition in effect — drift is forbidden here", () => {
  // PLAN_DECLARING_SUBJECT_RE cannot IMPORT FILING_SUBJECT_RE: `risk-judge` -> `sweep` closes a
  // cycle through feedback.ts, and depcruise counts 15 further no-circular violations for it
  // (13 -> 28, measured). A test may import both — tests are outside the graph depcruise cruises —
  // so this is where the two are held identical. If either changes alone, this fails by name.
  assert.equal(PLAN_DECLARING_SUBJECT_RE.source, FILING_SUBJECT_RE.source);
  assert.equal(PLAN_DECLARING_SUBJECT_RE.flags, FILING_SUBJECT_RE.flags, "a stray /g would make .test() stateful");
});
