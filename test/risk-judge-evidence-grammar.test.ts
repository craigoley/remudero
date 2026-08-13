import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRiskJudgePrompt,
  planRiskJudgeAction,
  runRiskJudge,
  type RiskJudgeInput,
  type RiskJudgeOrchestratorDeps,
  type RiskJudgeVerdict,
} from "../src/lib/risk-judge.js";

/**
 * W1-T454: the risk judge is NEVER shown a diff — {@link RiskJudgeChange} (see
 * risk-judge.ts's own module doc) carries only a free-text `description` and a
 * `files` path list, never a patch — yet issue #1723 printed its four reasons in
 * the grammar of OBSERVATIONS ('Unspent nonces ARE never deleted—only consumed
 * nonces are removed') against PR #1722's diff, and each was refuted by code the
 * judge never read. This file proves the escalation/proceed-facing reason text
 * now states what evidence it actually rests on, BY CONSTRUCTION — a
 * deterministic transform downstream of the judge's own words, not a prompt
 * instruction it could ignore — so it stays honest even when the judge's own
 * prose is not (the W1-T186 emitter discipline applied to the judge's own
 * evidentiary limits).
 */

function baseInput(): RiskJudgeInput {
  return {
    change: {
      description: "expire and evict confirm nonces (W1-T451) — https://github.com/owner/repo/pull/1722",
      files: ["src/lib/confirm.ts"],
    },
    gatesState: { review_state: "success" },
    planContext: { taskId: "W1-T451" },
  };
}

function verdict(partial: Partial<RiskJudgeVerdict>): RiskJudgeVerdict {
  return { verdict: "low", reasons: [], confidence: 0.9, ...partial };
}

test("an ESCALATE reason states the evidence it rests on, preserving the judge's own words verbatim alongside it", () => {
  const action = planRiskJudgeAction(
    verdict({
      verdict: "high",
      confidence: 0.92,
      reasons: ["Unspent nonces are never deleted—only consumed nonces are removed"],
    }),
  );
  assert.equal(action.kind, "escalate");
  assert.match(action.reason, /Unspent nonces are never deleted—only consumed nonces are removed/);
  assert.match(action.reason, /no diff was read/i);
  assert.match(action.reason, /description\/files/i);
});

test("EVERY stated reason carries its own evidence qualifier, not just the first", () => {
  const action = planRiskJudgeAction(
    verdict({
      verdict: "high",
      confidence: 0.9,
      reasons: [
        "creating unbounded Map growth (resource exhaustion)",
        "contradicts established nonce lifecycle practice",
      ],
    }),
  );
  const occurrences = action.reason.match(/no diff was read/gi) ?? [];
  assert.equal(occurrences.length, 2, "each separate reason must be individually qualified, not just the joined string once");
});

test("a PROCEED action's reason is ALSO evidence-qualified — honesty applies regardless of which way the verdict landed", () => {
  const action = planRiskJudgeAction(verdict({ verdict: "low", confidence: 0.95, reasons: ["well-trodden change"] }));
  assert.equal(action.kind, "proceed");
  assert.match(action.reason, /no diff was read/i);
});

test("a low-confidence ESCALATE reason is ALSO evidence-qualified", () => {
  const action = planRiskJudgeAction(
    verdict({ verdict: "low", confidence: 0.3, reasons: ["gates state was incomplete"] }),
  );
  assert.equal(action.kind, "escalate");
  assert.match(action.reason, /no diff was read/i);
});

test("a verdict with NO stated reasons reports honestly ('no reasons stated') — the qualifier never invents an observation from nothing", () => {
  const action = planRiskJudgeAction(verdict({ verdict: "high", confidence: 0.9, reasons: [] }));
  assert.match(action.reason, /no reasons stated/);
  assert.doesNotMatch(action.reason, /no diff was read/i);
});

test("the JUDGE-UNAVAILABLE fail-closed reason is left UNTOUCHED — it already truthfully names its OWN basis (the judge itself), not a claim about the change", async () => {
  const deps: RiskJudgeOrchestratorDeps = {
    judge: async () => {
      throw new Error("spawn timed out after 400 turns");
    },
    escalate: async () => "https://github.com/owner/repo/issues/1",
  };
  const result = await runRiskJudge(baseInput(), deps);
  assert.equal(result.action.kind, "escalate");
  assert.match(result.action.reason, /judge unavailable/i);
  assert.doesNotMatch(
    result.action.reason,
    /no diff was read/i,
    "a reason about the JUDGE's own unavailability must not be doubly (and misleadingly) qualified as though it were about the change",
  );
});

test("the unparseable-output fail-closed reason is also left UNTOUCHED for the same reason", async () => {
  const deps: RiskJudgeOrchestratorDeps = {
    judge: async () => ({
      verdict: "high",
      confidence: 1,
      reasons: ["judge output carried no parseable RISK_VERDICT — failing closed (never silent-proceed)"],
    }),
    escalate: async () => "https://github.com/owner/repo/issues/2",
  };
  const result = await runRiskJudge(baseInput(), deps);
  assert.match(result.action.reason, /judge output carried no parseable RISK_VERDICT/);
  assert.doesNotMatch(result.action.reason, /no diff was read/i);
});

test("buildRiskJudgePrompt tells the judge outright that it is NOT shown a diff, and instructs it to phrase reasons from the input text, not from code it has not read", () => {
  const prompt = buildRiskJudgePrompt(baseInput());
  assert.match(prompt, /NOT SHOWN A DIFF/i);
  assert.match(prompt, /description\/files\/gates state below actually show or imply/i);
});
