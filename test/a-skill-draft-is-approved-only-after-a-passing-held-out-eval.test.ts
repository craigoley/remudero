// Phase 5 of the held-out skill eval: `rmd approve` writes a skill-workshop draft under `.claude/skills/` only when
// `rmd skill-eval` recorded a passing held-out eval for the draft's CURRENT text (src/lib/skill-eval-gate.ts). Every
// other case is refused before any gateway call, naming what clears it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  approveProposal,
  classifyProposal,
  type InboxClassification,
  type Proposal,
  type RatifyGateway,
  type SkillEvalRecord,
  type SkillFilePayload,
} from "#src/lib/inbox.js";
import { skillEvalVerdict } from "#src/lib/skill-eval.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const ID = "skill-draft:proc-gate";
const SKILL: SkillFilePayload = {
  name: "implement-gated-procedure",
  markdown: "---\nname: implement-gated-procedure\ndescription: d\napplies-to: implement\n---\n\n## Procedure\n- step\n",
};
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function evalRecord(over: Partial<SkillEvalRecord> = {}): SkillEvalRecord {
  return { draftSha256: sha256(SKILL.markdown), heldOutSetHash: "h", taskIds: ["T1", "T2", "T3"], verdict: "pass",
    reason: "held-out-benefit", detail: "mean pass-rate gain 0.5 with no task regressed", delta: 0.5, measurableTasks: 3,
    totalCostUsd: 42, evaluatedAt: "2026-10-13T00:00:00Z", ...over };
}

function ready(skillEval?: SkillEvalRecord): InboxClassification {
  return { proposalId: ID, state: "ready", reasons: [], skillFile: SKILL, ...(skillEval ? { skillEval } : {}) };
}

function recorder(): { gateway: RatifyGateway; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    gateway: {
      createRatificationBranch: () => (calls.push("createRatificationBranch"), "b"),
      openPlanPr: () => (calls.push("openPlanPr"), "https://github.com/craigoley/remudero/pull/1"),
      writeSkillFile: () => (calls.push("writeSkillFile"), "run-APPROVE-skill-1"),
    },
  };
}

function approve(classification: InboxClassification) {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}skill-eval-gate-`)), "ledger.ndjson");
  const { gateway, calls } = recorder();
  const result = approveProposal(classification, gateway, { ledgerPath, runId: "R" });
  const rows = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  return { result, calls, rows };
}

function assertRefused(outcome: ReturnType<typeof approve>, pattern: RegExp): void {
  assert.equal(outcome.result.ok, false);
  assert.match((outcome.result as { refusal: string }).refusal, pattern);
  assert.deepEqual(outcome.calls, [], "a refusal makes no gateway call");
  const refused = outcome.rows.filter((r) => r.step === "ratify.approve_refused");
  assert.equal(refused.length, 1);
  assert.match(String(refused[0]!.reason), pattern);
}

test("a skill draft with no recorded held-out eval is refused at approval and told the eval command", () => {
  assertRefused(approve(ready()), new RegExp(`no held-out eval recorded; run \`rmd skill-eval ${ID} --confirm-spend\``));
});

test("a held-out eval recorded for an earlier text of a skill draft does not approve its current text", () => {
  const earlier = sha256("an earlier, shorter procedure");
  assertRefused(approve(ready(evalRecord({ draftSha256: earlier }))),
    new RegExp(`measured an earlier text of the draft \\(sha256 ${earlier.slice(0, 12)}\\)`));
});

test("a refusing held-out eval keeps a skill draft unapprovable without inviting a re-run", () => {
  const outcome = approve(ready(evalRecord({ verdict: "refuse", reason: "no-benefit", detail: "the mean gain is 0" })));
  assertRefused(outcome, /held-out eval refused this text \(no-benefit: the mean gain is 0\); decline it/);
  assert.doesNotMatch((outcome.result as { refusal: string }).refusal, /rmd skill-eval/, "a refusal is never laundered by a re-draw");
});

test("an eval that measured too few tasks asks for another run instead of a decline", () => {
  const unmeasured = skillEvalVerdict([]);
  assert.equal(unmeasured.verdict, "refuse", "the runner's own unmeasured verdict, so a renamed reason fails here");
  const outcome = approve(ready(evalRecord({ verdict: unmeasured.verdict, reason: unmeasured.reason, detail: unmeasured.detail })));
  assertRefused(outcome, new RegExp(`measured too few tasks to judge this text .*run \`rmd skill-eval ${ID} --confirm-spend\` again`));
});

test("a passing held-out eval for the stored text lets approval write the skill", () => {
  const outcome = approve(ready(evalRecord()));
  assert.equal(outcome.result.ok, true);
  assert.deepEqual(outcome.calls, ["writeSkillFile", "openPlanPr"]);
  assert.ok(outcome.rows.some((r) => r.step === "ratify.approved"));
});

test("the inbox classification carries a proposal's recorded eval to the approval gate", () => {
  const classify = (proposal: Proposal) => classifyProposal(proposal, undefined, {
    plan: { tasks: [], byId: new Map() },
    isMerged: () => true,
    grepAnchorTrue: () => true,
    openProposalIds: new Set([proposal.id]),
    isRatified: () => false,
  });
  const base: Proposal = { id: ID, summary: "s", evidenceAnchors: [], skillFile: SKILL };

  const evaluated = classify({ ...base, skillEval: evalRecord() });
  assert.deepEqual(evaluated.skillEval, evalRecord());
  assert.equal(approve(evaluated).result.ok, true);

  const unevaluated = classify(base);
  assert.equal(unevaluated.state, "ready", "an unevaluated draft is still listed; approval is where it is refused");
  assert.equal("skillEval" in unevaluated, false);
  assert.equal(approve(unevaluated).result.ok, false);
});
