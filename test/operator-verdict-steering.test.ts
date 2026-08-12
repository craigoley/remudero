import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, operatorVerdictEvidence, type OpenPrView } from "../src/lib/sweep.js";
import { buildFixRungDispatchArgs } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";

// ── W1-T435: "operator judgment on a run still evaporates" — the one-tap verdict
// (POST /v1/drain/feedback, W1-T141) plus a steering note, and a console-answered
// clarification (POST /v1/questions/answer, W1-T78), both feed `operatorVerdictEvidence`
// (lib/sweep.ts) — the SAME evidence pass `buildOpenPrViews` (run-task.ts) calls per open PR
// to populate `OpenPrView.pendingAnswer`, the field W1-T78 wired end-to-end but never had a
// producer for. THE TWO FALSIFIER DIRECTIONS THIS FILE PROVES (design note v):
//   (1) a `wrong`/`needs-follow-up` verdict WITH a note re-arms the fix rung, and the note
//       rides the fix prompt's own `constraint` field VERBATIM (buildFixRungDispatchArgs).
//   (2) a `good` verdict (praise) and an UNANSWERED question (silence) never re-arm anything —
//       a rung that re-armed on either would spin forever, the loop-containment half.
// Pure throughout: every input is an injected ledger/questions-file line array, no gh/fs
// (verify:auto — "the evidence assembly is pure over injected readers").

const TASK = "W1-STEER";
const OTHER_TASK = "W1-OTHER";

function feedbackLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { step: "operator_feedback", task_id: TASK, verdict: "wrong", ts: "2026-08-12T10:00:00Z", ...over };
}
function questionLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: "2026-08-12T09:00:00Z", task: TASK, question: "which approach?", current_assumption: "A", impact_if_wrong: "med", ...over };
}
function answerLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: "2026-08-12T09:05:00Z", task: TASK, answer: "use approach B, not A", origin: "tok:abc", ...over };
}

// ── operatorVerdictEvidence: pure unit coverage ──────────────────────────────────────────

test("operatorVerdictEvidence: a `wrong` verdict with a steering note produces a constraint quoting the note VERBATIM, with attribution", () => {
  const note = "the retry loop never backs off — see the flaky assertion at line 88";
  const result = operatorVerdictEvidence(TASK, [feedbackLine({ verdict: "wrong", note })], []);
  assert.ok(result, "a wrong verdict with a note must produce evidence");
  assert.ok(result!.constraint.includes(note), "the note's own words must appear unedited — never paraphrased");
  assert.match(result!.constraint, /wrong/, "attribution: the constraint names the verdict it came from");
});

test("operatorVerdictEvidence: a `needs-follow-up` verdict with a note ALSO produces a constraint (both non-good verdicts count)", () => {
  const note = "double-check the migration is idempotent";
  const result = operatorVerdictEvidence(TASK, [feedbackLine({ verdict: "needs-follow-up", note })], []);
  assert.ok(result);
  assert.ok(result!.constraint.includes(note));
});

test("operatorVerdictEvidence FALSIFIER (praise): a `good` verdict's note is NEVER quoted — re-arming on praise would spin the rung forever", () => {
  const result = operatorVerdictEvidence(TASK, [feedbackLine({ verdict: "good", note: "great work, ship it" })], []);
  assert.equal(result, undefined, "a good verdict must never produce re-arm evidence, note or not");
});

test("operatorVerdictEvidence: a `wrong` verdict with NO note (a bare tap) produces no constraint — nothing to quote", () => {
  const result = operatorVerdictEvidence(TASK, [feedbackLine({ verdict: "wrong", note: undefined })], []);
  assert.equal(result, undefined);
});

test("operatorVerdictEvidence: an ANSWERED clarification's answer text becomes the constraint, verbatim", () => {
  const result = operatorVerdictEvidence(TASK, [], [questionLine(), answerLine()]);
  assert.ok(result);
  assert.equal(result!.constraint, "use approach B, not A");
});

test("operatorVerdictEvidence FALSIFIER (silence): a QUESTION with no matching answer produces NO constraint — an unanswered question must never re-arm", () => {
  const result = operatorVerdictEvidence(TASK, [], [questionLine()]);
  assert.equal(result, undefined, "the question alone, unanswered, carries no re-arm signal");
});

test("operatorVerdictEvidence: a good verdict PLUS an unanswered question — combined — still produce NO re-arm (both falsifier directions at once)", () => {
  const result = operatorVerdictEvidence(TASK, [feedbackLine({ verdict: "good", note: "nice" })], [questionLine()]);
  assert.equal(result, undefined);
});

test("operatorVerdictEvidence: feedback/answer lines for a DIFFERENT task are ignored — scoped strictly by taskId", () => {
  const result = operatorVerdictEvidence(
    TASK,
    [feedbackLine({ task_id: OTHER_TASK, verdict: "wrong", note: "not mine" })],
    [questionLine({ task: OTHER_TASK }), answerLine({ task: OTHER_TASK, answer: "not mine either" })],
  );
  assert.equal(result, undefined);
});

test("operatorVerdictEvidence: the NEWEST operator_feedback line for a task wins when several exist", () => {
  const result = operatorVerdictEvidence(
    TASK,
    [
      feedbackLine({ verdict: "wrong", note: "stale note", ts: "2026-08-12T08:00:00Z" }),
      feedbackLine({ verdict: "wrong", note: "fresh note", ts: "2026-08-12T11:00:00Z" }),
    ],
    [],
  );
  assert.ok(result);
  assert.ok(result!.constraint.includes("fresh note"));
  assert.ok(!result!.constraint.includes("stale note"));
});

test("operatorVerdictEvidence: a wrong-verdict note AND an answered question both surface — the worker sees both, neither is dropped", () => {
  const note = "watch out for the race in the poller";
  const result = operatorVerdictEvidence(TASK, [feedbackLine({ verdict: "wrong", note })], [questionLine(), answerLine()]);
  assert.ok(result);
  assert.ok(result!.constraint.includes(note));
  assert.ok(result!.constraint.includes("use approach B, not A"));
});

test("operatorVerdictEvidence: no operator_feedback and no answered question -> undefined", () => {
  assert.equal(operatorVerdictEvidence(TASK, [], []), undefined);
});

// ── End-to-end falsifier (1): a wrong verdict + note RE-ARMS the strikes-exhausted fix rung ──

function strikesExhaustedPr(): OpenPrView {
  return {
    prNumber: 13,
    prUrl: "url/13",
    taskId: TASK,
    reviewState: "failure",
    checksState: "red",
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap, // exhausted
    unmetCriteria: [{ claim: "still unmet", proof: "unit test", met: false, reason: "not done", proof_exec: "executed_fail" } as never],
    lastActivityAt: "2026-08-12T09:00:00Z",
    headSha: "aaaa111",
    autoMergeArmed: false,
    reviewSummary: "still failing after strikes",
  };
}

const NOW = Date.parse("2026-08-12T12:00:00Z");

test("FALSIFIER 1: a wrong-verdict-with-note fixture RE-ARMS the fix rung — unanswered it escalates, with the note quoted it re-arms to blocked-fixable", () => {
  const baseline = deriveDisposition(strikesExhaustedPr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(baseline.disposition, "blocked-ambiguous", "an exhausted PR with no operator signal must still escalate");

  const note = "the assertion is checking the wrong field — compare status, not code";
  const pendingAnswer = operatorVerdictEvidence(TASK, [feedbackLine({ verdict: "wrong", note })], []);
  assert.ok(pendingAnswer, "the wrong verdict + note must produce pendingAnswer evidence");

  const rearmed: OpenPrView = { ...strikesExhaustedPr(), pendingAnswer };
  const result = deriveDisposition(rearmed, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-fixable", "the operator's steering note re-arms the exhausted rung");
  assert.match(result.reason, /operator answered/);
});

test("FALSIFIER 1 (the fix prompt quotes the note verbatim): buildFixRungDispatchArgs carries operatorVerdictEvidence's constraint straight into runFixRung's own `constraint` field, unedited", () => {
  const note = "the retry loop never backs off — see the flaky assertion at line 88";
  const pendingAnswer = operatorVerdictEvidence(TASK, [feedbackLine({ verdict: "wrong", note })], []);
  assert.ok(pendingAnswer);

  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };
  const args = buildFixRungDispatchArgs({
    task: { id: TASK, title: "Some task" },
    runId: "SWEEP-1730000000000",
    prUrl: "https://github.com/acme/remudero/pull/13",
    branch: "run-W1-STEER-1730000000000",
    worktreePath: "/tmp/rmd-steer-wt",
    mount,
    settingsFile: "/tmp/rmd-steer-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    strikeCap: DEFAULT_SWEEP_POLICY.strikeCap,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-steer-wt", reviewerMount: mount },
    evidence: { unmetCriteria: [] },
    pr: { headSha: "aaaa111", pendingAnswer },
  });

  assert.equal(args.constraint, pendingAnswer!.constraint, "runFixRung's own constraint field carries operatorVerdictEvidence's output unchanged");
  assert.ok(args.constraint!.includes(note), "and that field's text still contains the operator's own words verbatim — deleting the consumer would break this");
});

// ── End-to-end falsifier (2): a good verdict + an unanswered question re-arm NOTHING ─────────

test("FALSIFIER 2: a good verdict plus an unanswered question produce NO re-arm — the strikes-exhausted PR stays blocked-ambiguous, exactly as with no operator signal at all", () => {
  const pendingAnswer = operatorVerdictEvidence(TASK, [feedbackLine({ verdict: "good", note: "nice work" })], [questionLine()]);
  assert.equal(pendingAnswer, undefined, "neither the praise nor the silent question earns a re-arm");

  const notRearmed: OpenPrView = { ...strikesExhaustedPr(), pendingAnswer };
  const result = deriveDisposition(notRearmed, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-ambiguous", "a rung that re-armed here would spin forever on praise or on silence");
});
