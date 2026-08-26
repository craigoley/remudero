import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildRiskJudgePrompt,
  planRiskJudgeAction,
  type RiskJudgeInput,
  type RiskJudgeVerdict,
} from "../src/lib/risk-judge.js";

/**
 * W1-T2284 — THE JUDGE GRADES THE PATCH BY READING THE BUG REPORT.
 *
 * Every shard title in this repo is a defect statement in the negative voice, and
 * `runTask` hands the judge that title verbatim as `change.description` (see
 * src/run-task.ts). Issue #2853 quoted W1-T2263's title back as "the change" and
 * escalated the fix that REMOVED that defect at 0.85 confidence, over a
 * `remudero-review` PASS on 8 of 8 criteria — the judge read the polarity backwards.
 *
 * The remedy (design clause (i)) is FRAMING, not a diff and not a threshold move:
 * one instruction in `buildRiskJudgePrompt` telling the judge the description names
 * the defect the change REMOVES, not one it introduces — while explicitly refusing
 * to let that framing become a licence (design clause (iii)) and leaving every other
 * safety property (the veto, the confidence floor, the evidence qualifier) untouched
 * (design clause (v)).
 */

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

function baseInput(overrides: Partial<RiskJudgeInput> = {}): RiskJudgeInput {
  return {
    change: {
      description:
        "A SEMANTIC DOWNGRADE OVERWRITES THE ONLY FIELD THAT COULD NAME THE REMEDY — " +
        "the floor's accumulated reason is REPLACED by a fixed eight-word constant — " +
        "https://github.com/craigoley/remudero/pull/2852",
      files: ["src/lib/review.ts"],
    },
    gatesState: { review_state: "success", review_capped: false, ci: "pass" },
    planContext: { taskId: "W1-T2263", taskType: "implement" },
    ...overrides,
  };
}

function verdict(partial: Partial<RiskJudgeVerdict>): RiskJudgeVerdict {
  return { verdict: "low", reasons: ["well-trodden change, gates clean"], confidence: 0.9, ...partial };
}

// ── acceptance 1: the prompt states the description names the defect removed,
// and the change under assessment is the remedy ───────────────────────────

test("acceptance 1: buildRiskJudgePrompt tells the judge the description names the defect the change REMOVES", () => {
  const prompt = buildRiskJudgePrompt(baseInput());
  assert.match(prompt, /DESCRIPTION NAMES THE DEFECT/i);
  assert.match(prompt, /defect the change under assessment\s+REMOVES/i);
  assert.match(prompt, /THE CHANGE IS THE REMEDY/i);
});

// ── acceptance 2: a fix whose description states the defect in the negative
// voice is not classified high on that basis alone ────────────────────────

test("acceptance 2: the prompt explicitly forbids classifying HIGH on the description alone", () => {
  const prompt = buildRiskJudgePrompt(baseInput());
  assert.match(prompt, /Do NOT classify a change\s+HIGH on the strength of the description alone/i);
  assert.match(prompt, /do not read a sharply-named\s+defect as evidence the change is dangerous/i);
});

test("acceptance 2: the negative-voice W1-T2263 description alone still renders — the framing is textual, not a filter on the input", () => {
  // The judge remains a live LLM call this module cannot unit-test end to end; what a unit
  // test CAN pin is that the exact defect-shaped description from #2853 reaches the prompt
  // unmolested, immediately beside the new instruction not to grade it as the change itself.
  const prompt = buildRiskJudgePrompt(baseInput());
  assert.match(prompt, /SEMANTIC DOWNGRADE OVERWRITES THE ONLY FIELD/);
  assert.match(prompt, /CANDIDATE CHANGE: A SEMANTIC DOWNGRADE OVERWRITES/);
});

// ── acceptance 3: a genuinely concerning gates state still reaches high —
// the framing is not a licence ─────────────────────────────────────────────

test("acceptance 3: the prompt tells the judge the framing is NOT a licence and concerning gates still classify HIGH", () => {
  const prompt = buildRiskJudgePrompt(baseInput());
  assert.match(prompt, /THIS FRAMING IS NOT A LICENCE/i);
  assert.match(prompt, /GATES STATE below is itself concerning.*classify HIGH/is);
});

test("acceptance 3: planRiskJudgeAction still escalates a HIGH verdict regardless of a defect-named description", () => {
  // planRiskJudgeAction never sees `description` at all — it is a pure function of the
  // judge's verdict/confidence (Standing rule 12). This pins that the framing sentence has
  // no path into the deterministic controller: a HIGH verdict on a concerning gates state
  // still escalates, exactly as it did before this task.
  const action = planRiskJudgeAction(
    verdict({ verdict: "high", confidence: 0.95, reasons: ["gates state reports a failing CI check"] }),
  );
  assert.equal(action.kind, "escalate");
  assert.match(action.reason, /gates state reports a failing CI check/);
});

// ── acceptance 4: every non-internal reason still carries the
// no-diff-was-read qualifier ────────────────────────────────────────────

test("acceptance 4: a non-internal reason is still wrapped with the no-diff-was-read qualifier", () => {
  const action = planRiskJudgeAction(
    verdict({ verdict: "high", confidence: 0.8, reasons: ["description names a defect the change appears to remove"] }),
  );
  assert.match(action.reason, /on the change's description\/files alone, no diff was read —/);
});

test("acceptance 4: an internal judge-unavailable reason is exempt from the qualifier, unchanged", () => {
  const action = planRiskJudgeAction(
    verdict({ verdict: "high", confidence: 0, reasons: ["judge unavailable (timeout) — failing closed to ESCALATE"] }),
  );
  assert.doesNotMatch(action.reason, /on the change's description\/files alone, no diff was read —/);
  assert.match(action.reason, /judge unavailable/);
});

// ── acceptance 5: the confidence threshold is unchanged and a
// below-threshold verdict still escalates ──────────────────────────────

test("acceptance 5: the default confidence threshold is still 0.7 — a 0.68 verdict escalates, a 0.7 verdict does not", () => {
  const below = planRiskJudgeAction(verdict({ verdict: "low", confidence: 0.68 }));
  assert.equal(below.kind, "escalate");
  assert.match(below.reason, /low-confidence/);

  const atThreshold = planRiskJudgeAction(verdict({ verdict: "low", confidence: 0.7 }));
  assert.equal(atThreshold.kind, "proceed");
});

test("acceptance 5: nothing in this task moved the threshold below the two floor cases this shard measured (0.60, 0.68)", () => {
  // W1-T2216 (0.60) and W1-T2252 (0.68) both escalated on the confidence floor, correctly
  // reading the change — design clause (v): "DEFAULT_CONFIDENCE_THRESHOLD is not moved. Not
  // to 0.6, not anywhere." Both values must still escalate at the default threshold.
  for (const confidence of [0.6, 0.68]) {
    const action = planRiskJudgeAction(verdict({ verdict: "low", confidence }));
    assert.equal(action.kind, "escalate", `confidence ${confidence} must still escalate`);
  }
});

// ── acceptance 6: the task title is not delivered to the judge twice under
// two different labels ──────────────────────────────────────────────────

test("acceptance 6: runTask's risk-judge input no longer duplicates task.title under planContext.title", () => {
  // Before this task: `change: { description: \`${task.title} — ${prUrl}\` }` AND
  // `planContext: { taskId: task.id, title: task.title, taskType: task.type }` — the same
  // string, task.title, delivered to the judge twice under two different top-level labels
  // (`change.description` and `planContext.title`), and the PR's own title never. The fix
  // drops the redundant `title` key from planContext; `change.description` remains the one
  // place task.title reaches the judge.
  const riskJudgeInputSite = runTaskSrc.match(
    /const riskJudgeInput: RiskJudgeInput = \{[\s\S]*?\n {4}\};/,
  );
  assert.ok(riskJudgeInputSite, "expected to find the riskJudgeInput construction site in src/run-task.ts");
  const site = riskJudgeInputSite[0];

  assert.match(site, /change: \{ description: `\$\{task\.title\}/, "description still carries task.title");
  assert.match(site, /planContext: \{ taskId: task\.id, taskType: task\.type \}/);
  assert.doesNotMatch(site, /planContext:.*title: task\.title/, "planContext must not also carry task.title");
});

test("acceptance 6: buildRiskJudgePrompt renders the plan context without a duplicated title key", () => {
  const input = baseInput({ planContext: { taskId: "W1-T2263", taskType: "implement" } });
  const prompt = buildRiskJudgePrompt(input);
  const planContextSection = prompt.slice(prompt.indexOf("PLAN CONTEXT"));
  assert.doesNotMatch(planContextSection, /"title"/);
});
