import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessRisk,
  buildRiskJudgePrompt,
  runRiskJudge,
  scrubRiskJudgeText,
  type RiskJudgeInput,
  type RiskJudgeOrchestratorDeps,
  type RiskJudgeVerdict,
} from "../src/lib/risk-judge.js";

function input(overrides: Partial<RiskJudgeInput> = {}): RiskJudgeInput {
  return {
    change: {
      description: "routine change",
      files: ["src/lib/risk-judge.ts"],
    },
    gatesState: { ci: "pass" },
    planContext: { taskId: "W1-T999" },
    ...overrides,
  };
}

function lowVerdict(reasons = ["routine change"]): RiskJudgeVerdict {
  return { verdict: "low", confidence: 0.95, reasons };
}

test("scrubRiskJudgeText removes PII and credential-shaped material with stable placeholders", () => {
  const raw = [
    "contact person@example.com or +1 212 555 0198",
    "remote https://alice:correct-horse-battery-staple@github.com/craigoley/remudero/pull/7",
    "local /Users/craigoley/Remudero/remudero/src/run-task.ts",
    "api_key=ordinary-placeholder",
  ].join(" | ");

  const scrubbed = scrubRiskJudgeText(raw);

  assert.equal(scrubbed.findings.length, 1);
  assert.equal(scrubbed.findings[0], "credential");
  assert.doesNotMatch(scrubbed.text, /person@example\.com|212 555 0198|correct-horse-battery-staple|craigoley/);
  assert.match(scrubbed.text, /<redacted-email>/);
  assert.match(scrubbed.text, /<redacted-phone>/);
  assert.match(scrubbed.text, /<redacted-credential>/);
  assert.match(scrubbed.text, /<redacted-secret>/);
  assert.match(scrubbed.text, /<redacted-user-home>\/Remudero\/remudero\/src\/run-task\.ts/);
  assert.match(scrubbed.text, /github\.com\/<redacted-owner>\/remudero\/pull\/7/);
});

test("the prompt receives scrubbed context, retains useful shape, and records a credential finding", () => {
  const rawCredential = "https://alice:correct-horse-battery-staple@github.com/craigoley/remudero/pull/7";
  const prompt = buildRiskJudgePrompt(
    input({
      change: { description: `review ${rawCredential}`, files: ["src/lib/risk-judge.ts"] },
      gatesState: { ci: "pass", note: "contact person@example.com" },
    }),
  );

  assert.doesNotMatch(prompt, /correct-horse-battery-staple|person@example\.com|craigoley/);
  assert.match(prompt, /DETERMINISTIC SECURITY FINDING/);
  assert.match(prompt, /hard-stop candidate/);
  assert.match(prompt, /src\/lib\/risk-judge\.ts/);
});

test("credential findings force STOP after the LLM call, while the LLM sees only scrubbed input", async () => {
  const rawCredential = "https://alice:correct-horse-battery-staple@github.com/craigoley/remudero/pull/7";
  let judgedInput: RiskJudgeInput | undefined;
  const result = await assessRisk(
    input({ change: { description: rawCredential, files: ["src/lib/risk-judge.ts"] } }),
    {
      judge: async (safeInput) => {
        judgedInput = safeInput;
        return lowVerdict();
      },
    },
  );

  assert.ok(judgedInput);
  assert.doesNotMatch(JSON.stringify(judgedInput), /correct-horse-battery-staple|craigoley/);
  assert.equal(result.verdict, "high");
  assert.equal(result.confidence, 1);
  assert.equal(result.gateConsequence, "STOP");
  assert.match(result.reasons[0], /credential-shaped material/);
});

test("ordinary PII redaction does not change autonomous flow and is absent from the ledger", async () => {
  const log: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps: RiskJudgeOrchestratorDeps = {
    judge: async () => lowVerdict(["contact person@example.com if this fails"]),
    escalate: () => "unused",
    log: (step, extra) => log.push({ step, extra }),
  };

  const result = await runRiskJudge(
    input({ change: { description: "contact person@example.com", files: ["src/lib/risk-judge.ts"] } }),
    deps,
  );

  assert.equal(result.action.kind, "proceed");
  const decision = log.find((entry) => entry.step === "risk_judge.decision");
  assert.ok(decision);
  assert.doesNotMatch(JSON.stringify(decision), /person@example\.com/);
  assert.match(JSON.stringify(decision), /<redacted-email>/);
});
