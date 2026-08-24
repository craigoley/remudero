import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mount } from "../src/lib/mounts.js";
import type { spawnWorker, WorkerResult } from "../src/lib/worker.js";
import {
  buildRiskJudgeSpawnArgs,
  parseRiskJudgeResponse,
  planRiskJudgeAction,
  realRiskJudge,
  RISK_JUDGE_MAX_ATTEMPTS,
  type RiskJudgeInput,
  type RiskJudgeVerdict,
} from "../src/lib/risk-judge.js";
import {
  classifyTriageOutcome,
  decideTriage,
  parseTriageVerdict,
  runTriageWithRetry,
  TRIAGE_VERDICT_MAX_ATTEMPTS,
  type TriageAttemptResult,
} from "../src/lib/triage.js";

// ── shared fixtures ───────────────────────────────────────────────────────

function baseInput(overrides: Partial<RiskJudgeInput> = {}): RiskJudgeInput {
  return {
    change: { description: "add a fuzzy-search helper to serve.ts", files: ["src/lib/serve.ts"] },
    gatesState: { lint: "pass", typecheck: "pass", tests: "pass" },
    planContext: { taskId: "W1-T900", planRefs: ["P34"] },
    ...overrides,
  };
}

const MOUNT: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };

function fakeWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s-risk-judge",
    costUsd: 0.001,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "haiku",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

const UNPARSEABLE_TEXT = "not sure what to make of this diff, seems fine I guess";
const PARSED_HIGH_TEXT = "RISK_VERDICT: high\nRISK_CONFIDENCE: 0.9\nRISK_REASON: touches auth middleware";
const PARSED_LOW_TEXT = "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.9\nRISK_REASON: routine change";

// ═══════════════════════════════════════════════════════════════════════════
// RISK JUDGE (src/lib/risk-judge.ts)
// ═══════════════════════════════════════════════════════════════════════════

// ── acceptance 1: an unparseable response is a distinct state, not a verdict value ──

test("risk-judge acceptance 1: parseRiskJudgeResponse returns a DISTINCT `unparseable` state — not a fabricated verdict", () => {
  const outcome = parseRiskJudgeResponse(UNPARSEABLE_TEXT);
  assert.equal(outcome.kind, "unparseable");
  assert.ok(!("verdict" in outcome), "the unparseable arm carries no verdict field at all");
});

test("risk-judge acceptance 1: parseRiskJudgeResponse returns `parsed` with a real verdict on well-formed output", () => {
  const outcome = parseRiskJudgeResponse(PARSED_HIGH_TEXT);
  assert.equal(outcome.kind, "parsed");
  assert.equal(outcome.kind === "parsed" && outcome.verdict.verdict, "high");
});

// ── acceptance 2: a parsed adverse verdict is never retried ──────────────────

test("risk-judge acceptance 2: realRiskJudge spawns EXACTLY ONCE for a parsed HIGH (adverse) verdict — never retried", async () => {
  const calls: unknown[] = [];
  const spawn = (async (args: unknown) => {
    calls.push(args);
    return fakeWorkerResult(PARSED_HIGH_TEXT);
  }) as typeof spawnWorker;
  const judge = realRiskJudge({ mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  const verdict = await judge(baseInput());
  assert.equal(calls.length, 1, "a parsed verdict — adverse or not — must never be retried");
  assert.equal(verdict.verdict, "high");
});

test("risk-judge acceptance 2: realRiskJudge spawns EXACTLY ONCE for a parsed LOW verdict too", async () => {
  const calls: unknown[] = [];
  const spawn = (async (args: unknown) => {
    calls.push(args);
    return fakeWorkerResult(PARSED_LOW_TEXT);
  }) as typeof spawnWorker;
  const judge = realRiskJudge({ mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  await judge(baseInput());
  assert.equal(calls.length, 1);
});

// ── acceptance 3: every retry attempt carries an identical prompt and input ──

test("risk-judge acceptance 3: every retry attempt's spawn args are IDENTICAL (byte-identical prompt/input, never a re-ask)", async () => {
  const calls: unknown[] = [];
  const spawn = (async (args: unknown) => {
    calls.push(args);
    return fakeWorkerResult(UNPARSEABLE_TEXT); // unparseable on EVERY attempt — exhausts the bound
  }) as typeof spawnWorker;
  const judge = realRiskJudge({ mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn, maxAttempts: 3 });
  await judge(baseInput());
  assert.equal(calls.length, 3, "must retry up to the bound");
  const expected = buildRiskJudgeSpawnArgs({ input: baseInput(), mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/settings.json" });
  for (const call of calls) {
    assert.deepEqual(call, expected, "every attempt must carry the identical request");
  }
  // Reference identity too — built ONCE, reused, never rebuilt between attempts.
  assert.equal(calls[0], calls[1]);
  assert.equal(calls[1], calls[2]);
});

test("risk-judge acceptance 3: a LATER attempt parsing successfully still used the SAME args as the earlier failed one(s)", async () => {
  let n = 0;
  const calls: unknown[] = [];
  const spawn = (async (args: unknown) => {
    calls.push(args);
    n++;
    return fakeWorkerResult(n < 2 ? UNPARSEABLE_TEXT : PARSED_HIGH_TEXT);
  }) as typeof spawnWorker;
  const judge = realRiskJudge({ mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn, maxAttempts: 3 });
  const verdict = await judge(baseInput());
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(verdict.verdict, "high");
  assert.equal(verdict.confidence, 0.9, "the eventually-parsed verdict's own confidence, not a fail-closed one");
});

// ── acceptance 4: the retry stops at its bound and escalates exactly as it does today ──

test("risk-judge acceptance 4: realRiskJudge stops at RISK_JUDGE_MAX_ATTEMPTS and fails closed (still ESCALATES)", async () => {
  const calls: unknown[] = [];
  const spawn = (async (args: unknown) => {
    calls.push(args);
    return fakeWorkerResult(UNPARSEABLE_TEXT);
  }) as typeof spawnWorker;
  const judge = realRiskJudge({ mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  const verdict = await judge(baseInput());
  assert.equal(calls.length, RISK_JUDGE_MAX_ATTEMPTS, "the bound is a SMALL, HARD cap");
  assert.equal(verdict.verdict, "high");
  const action = planRiskJudgeAction(verdict);
  assert.equal(action.kind, "escalate", "the SAME class/blocking effect as today — still escalates");
});

test("risk-judge acceptance 4: a custom (smaller) maxAttempts is honored", async () => {
  const calls: unknown[] = [];
  const spawn = (async (args: unknown) => {
    calls.push(args);
    return fakeWorkerResult(UNPARSEABLE_TEXT);
  }) as typeof spawnWorker;
  const judge = realRiskJudge({ mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn, maxAttempts: 1 });
  await judge(baseInput());
  assert.equal(calls.length, 1);
});

// ── acceptance 5: an unreadable verdict still blocks and nothing proceeds on it ──

test("risk-judge acceptance 5: the exhausted-retry verdict NEVER proceeds — planRiskJudgeAction always escalates it", async () => {
  const spawn = (async () => fakeWorkerResult(UNPARSEABLE_TEXT)) as typeof spawnWorker;
  const judge = realRiskJudge({ mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  const verdict = await judge(baseInput());
  const action = planRiskJudgeAction(verdict);
  assert.notEqual(action.kind, "proceed");
  assert.equal(action.kind, "escalate");
});

// ── acceptance 6: the escalation names a malformed response apart from an adverse judgment ──

test("risk-judge acceptance 6: the exhausted-retry escalation's reason names a MALFORMED RESPONSE, distinct from a genuine adverse verdict's reason", async () => {
  const spawn = (async () => fakeWorkerResult(UNPARSEABLE_TEXT)) as typeof spawnWorker;
  const judge = realRiskJudge({ mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  const malformedVerdict = await judge(baseInput());
  const malformedAction = planRiskJudgeAction(malformedVerdict);
  assert.match(malformedAction.reason, /MALFORMED RESPONSE/);

  const adverseVerdict: RiskJudgeVerdict = { verdict: "high", confidence: 0.92, reasons: ["touches CI workflow files"] };
  const adverseAction = planRiskJudgeAction(adverseVerdict);
  assert.doesNotMatch(adverseAction.reason, /MALFORMED RESPONSE/, "a real adverse judgment must never be mislabeled as malformed");
});

test("risk-judge acceptance 6 (W1-T2212 design iv): the malformed-response verdict's confidence is 0, never 1 — it never read a verdict to be confident about", async () => {
  const spawn = (async () => fakeWorkerResult(UNPARSEABLE_TEXT)) as typeof spawnWorker;
  const judge = realRiskJudge({ mount: MOUNT, cwd: "/tmp/x", settingsFile: "/tmp/settings.json", spawn });
  const verdict = await judge(baseInput());
  assert.equal(verdict.confidence, 0);
  assert.match(verdict.reasons.join(" "), /MALFORMED RESPONSE/);
});

test("risk-judge acceptance 6: parseRiskJudgeResponse alone never fabricates a 'high, confidence 1' verdict for unparseable text (the issue #2696 shape)", () => {
  const outcome = parseRiskJudgeResponse(UNPARSEABLE_TEXT);
  assert.equal(outcome.kind, "unparseable");
});

// ═══════════════════════════════════════════════════════════════════════════
// TRIAGE (src/lib/triage.ts)
// ═══════════════════════════════════════════════════════════════════════════

const PROMPT = "(the fixed triage prompt for this run)";

function triageAttempts(texts: string[]): { spawnAttempt: (p: string) => Promise<TriageAttemptResult>; calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    spawnAttempt: async (prompt: string) => {
      calls.push(prompt);
      const text = texts[Math.min(n, texts.length - 1)];
      n++;
      return { text, changedFiles: [] };
    },
  };
}

// ── acceptance 1: an unparseable response is a distinct state rather than a verdict value ──

test("triage acceptance 1: classifyTriageOutcome returns a DISTINCT `unparseable` state — never a fabricated verdict", () => {
  const outcome = classifyTriageOutcome("some rambling text with no verdict marker at all");
  assert.equal(outcome.kind, "unparseable");
  assert.ok(!("verdict" in outcome));
});

test("triage acceptance 1: classifyTriageOutcome returns `verdict` for well-formed output", () => {
  const outcome = classifyTriageOutcome("ALREADY_DECIDED: MASTER-PLAN.md §7B");
  assert.equal(outcome.kind, "verdict");
  assert.equal(outcome.kind === "verdict" && outcome.verdict.kind, "already_decided");
});

// ── acceptance 2: a parsed adverse verdict is never retried ──────────────────

test("triage acceptance 2: runTriageWithRetry spawns EXACTLY ONCE for a parsed verdict, even an inconsistency (adverse) one", async () => {
  const { spawnAttempt, calls } = triageAttempts(["PROPOSED: add a task"]); // parsed, but no files changed -> inconsistency
  const result = await runTriageWithRetry(PROMPT, { spawnAttempt });
  assert.equal(calls.length, 1, "a parsed verdict must never be retried, even when decideTriage then calls it an error");
  assert.equal(result.decision.action, "error");
  assert.equal(result.decision.action === "error" && result.decision.cause, "inconsistent_verdict");
});

test("triage acceptance 2: a clean PROPOSED verdict (with a changed file) also spawns exactly once", async () => {
  const calls: string[] = [];
  const result = await runTriageWithRetry(PROMPT, {
    spawnAttempt: async (prompt) => {
      calls.push(prompt);
      return { text: "PROPOSED: add W1-T9999", changedFiles: ["plan/tasks.yaml"] };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.decision.action, "propose");
});

// ── acceptance 3: every retry attempt carries an identical prompt and input ──

test("triage acceptance 3: every spawnAttempt call receives the IDENTICAL prompt across all retries", async () => {
  const { spawnAttempt, calls } = triageAttempts(["no marker here", "still nothing", "nor here"]);
  await runTriageWithRetry(PROMPT, { spawnAttempt }, 3);
  assert.equal(calls.length, 3);
  for (const p of calls) assert.equal(p, PROMPT);
});

// ── acceptance 4: the retry stops at its bound and escalates exactly as it does today ──

test("triage acceptance 4: runTriageWithRetry stops at TRIAGE_VERDICT_MAX_ATTEMPTS and produces the SAME error decideTriage(verdict:null) always has", async () => {
  const { spawnAttempt, calls } = triageAttempts(["no marker whatsoever"]);
  const result = await runTriageWithRetry(PROMPT, { spawnAttempt });
  assert.equal(calls.length, TRIAGE_VERDICT_MAX_ATTEMPTS);
  assert.equal(result.attempts, TRIAGE_VERDICT_MAX_ATTEMPTS);
  const directDecision = decideTriage({ verdict: null, changedFiles: [] });
  assert.equal(result.decision.action, "error");
  assert.equal(directDecision.action, "error");
  assert.equal(
    result.decision.action === "error" && directDecision.action === "error" && result.decision.cause,
    directDecision.action === "error" ? directDecision.cause : undefined,
  );
});

test("triage acceptance 4: a custom (smaller) maxAttempts is honored", async () => {
  const { spawnAttempt, calls } = triageAttempts(["no marker"]);
  await runTriageWithRetry(PROMPT, { spawnAttempt }, 1);
  assert.equal(calls.length, 1);
});

// ── acceptance 5: an unreadable verdict still blocks and nothing proceeds on it ──

test("triage acceptance 5: exhausting retries NEVER yields propose/grill/no_task — only error", async () => {
  const { spawnAttempt } = triageAttempts(["no marker whatsoever"]);
  const result = await runTriageWithRetry(PROMPT, { spawnAttempt });
  assert.equal(result.decision.action, "error");
});

// ── acceptance 6: the escalation names a malformed response apart from an adverse judgment ──

test("triage acceptance 6: the exhausted-retry decision's reason names a MALFORMED RESPONSE, and carries the attempt count", async () => {
  const { spawnAttempt } = triageAttempts(["no marker whatsoever"]);
  const result = await runTriageWithRetry(PROMPT, { spawnAttempt });
  assert.equal(result.decision.action, "error");
  const reason = result.decision.action === "error" ? result.decision.reason : "";
  assert.match(reason, /MALFORMED RESPONSE/);
  assert.match(reason, new RegExp(`after ${TRIAGE_VERDICT_MAX_ATTEMPTS} attempt`));
});

test("triage acceptance 6: an inconsistent (adverse) parsed verdict's error reason is NEVER labeled a malformed response", () => {
  const d = decideTriage({ verdict: { kind: "already_decided", citation: "§7B" }, changedFiles: ["plan/tasks.yaml"] });
  assert.equal(d.action, "error");
  const reason = d.action === "error" ? d.reason : "";
  assert.doesNotMatch(reason, /MALFORMED RESPONSE/);
});

test("triage: decideTriage's existing direct caller (no `attempts` passed) keeps the BYTE-IDENTICAL message from before this task", () => {
  const d = decideTriage({ verdict: null, changedFiles: [] });
  assert.equal(d.action, "error");
  assert.equal(
    d.action === "error" ? d.reason : "",
    "no ALREADY_DECIDED:/AMBIGUOUS:/PROPOSED: verdict line found in the worker's output",
  );
});

// ── acceptance 7: the triage rung reports its cause as data rather than as prose alone ──

test("triage acceptance 7: `cause` distinguishes unparseable output from a worker that physically misbehaved — as DATA, not prose", () => {
  const unparseable = decideTriage({ verdict: null, changedFiles: [] });
  const misbehaved = decideTriage({ verdict: null, changedFiles: ["src/lib/triage.ts"] });
  assert.equal(unparseable.action, "error");
  assert.equal(misbehaved.action, "error");
  assert.equal(unparseable.action === "error" ? unparseable.cause : undefined, "unparseable_verdict");
  assert.equal(misbehaved.action === "error" ? misbehaved.cause : undefined, "non_plan_files");
  assert.notEqual(
    unparseable.action === "error" ? unparseable.cause : undefined,
    misbehaved.action === "error" ? misbehaved.cause : undefined,
  );
});

test("triage acceptance 7: a parsed-but-inconsistent verdict carries cause 'inconsistent_verdict' — a THIRD distinct value, not folded into either of the other two", () => {
  const d = decideTriage({ verdict: { kind: "proposed", summary: "x" }, changedFiles: [] });
  assert.equal(d.action, "error");
  assert.equal(d.action === "error" ? d.cause : undefined, "inconsistent_verdict");
});

// ── Cross-cutting: parseTriageVerdict itself is unaffected (still `null` on unparseable, not a fake verdict) ──

test("triage: parseTriageVerdict itself already returned null (not a fabricated verdict) on unparseable text — the defect was one layer up, in decideTriage's collapse", () => {
  assert.equal(parseTriageVerdict("nothing resembling a verdict marker here"), null);
});
