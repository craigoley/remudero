import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung } from "../src/run-task.js";
import {
  ESCALATION_JUDGED_STEP,
  FLEET_NOTICE_LABEL,
  NEEDS_HUMAN_LABEL,
  escalate,
  isEscalationJudgeExempt,
} from "../src/lib/escalate.js";
import type { Escalation, EscalationJudgeVerdict, IssueGateway } from "../src/lib/escalate.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

/**
 * W1-T3166 — THE RESIDUAL ESCALATION JUDGE HAD ZERO PRODUCTION CALLERS.
 *
 * W1-T349 built `escalateWithJudge`, its prompt, its exemptions, its fail-open default and a real
 * no-tools spawn, with six tests. Every producer then called plain `escalate()`. Three agreeing
 * reads established it on 2026-09-08: the callsite census found only tests and two prose mentions;
 * `gh issue list --label fleet-notice --state open` returned 0; and the ledger's judge step-name
 * census over 579 gz archives returned `risk_judge.escalated` (14 813) and `risk_judge.decision`
 * (349) AND NOTHING ELSE.
 *
 * These fixtures drive the REAL `runFixRung` — never a reimplementation of its escalation path —
 * mirroring test/fix-rung-retrigger-accounting.test.ts's own discipline.
 */

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(state: "success" | "failure", headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria: [criterion({ claim: "criterion A merges cleanly", met: state === "success", reason: "still broken" })],
    testTheater: false,
    summary: "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

function result(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s", costUsd: 0, numTurns: 0, text: "", blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "default",
    effort: "default", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, ...over,
  };
}

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-wired-`)), "ledger.ndjson");
}

/** An issue gateway that records the labels each issue was opened with, plus the first comment —
 *  the two things a demotion changes and a delivery does not. */
function recordingIssues(calls: Array<{ title: string; labels: string[]; comments: string[] }>): IssueGateway {
  return {
    create(title, _body, labels) {
      calls.push({ title, labels, comments: [] });
      return "https://github.com/acme/remudero/issues/9001";
    },
    ensureLabel: () => true,
    comment(_url, text) {
      calls[calls.length - 1]?.comments.push(text);
    },
  };
}

/** Drive the real rung to its retrigger-cap escalation, with `judge` injected. Returns everything
 *  the assertions below need: the issues opened, the ledger file, and how many times the judge ran. */
async function rungThatEscalates(judge: (e: Escalation) => Promise<EscalationJudgeVerdict>): Promise<{
  issueCalls: Array<{ title: string; labels: string[]; comments: string[] }>;
  ledgerPath: string;
  judged: Escalation[];
}> {
  const issueCalls: Array<{ title: string; labels: string[]; comments: string[] }> = [];
  const judged: Escalation[] = [];
  const ledgerPath = tmpLedgerPath();
  let spawnCalls = 0;
  await runFixRung({
    taskId: "W1-D",
    runId: "W1-D-1730000000000",
    task: { id: "W1-D", title: "Some task" },
    prUrl: "https://github.com/acme/remudero/pull/3121",
    branch: "run-W1-D-1730000000000",
    worktreePath: "/tmp/rmd-judge-wired-wt",
    initialSessionId: "session-0",
    mount: MOUNT,
    settingsFile: "/tmp/rmd-judge-wired-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-judge-wired-wt", reviewerMount: MOUNT },
    strikeCap: 50,
    retriggerCap: 2,
    initialReview: fakeReview("failure", "sha-0"),
    escalationJudge: async (e) => {
      judged.push(e);
      return judge(e);
    },
    deps: {
      spawn: async () => { spawnCalls++; return result({ sessionId: `fix-session-${spawnCalls}` }); },
      readRoundCommits: async () => [{ changedFiles: 0, subject: "ci: retrigger for a coverage-ratchet infra flake" }],
      waitForCiGreen: async () => "green",
      runReview: async () => fakeReview("failure", `sha-${spawnCalls}`),
      push: () => {},
      issues: recordingIssues(issueCalls),
      ledgerPath,
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });
  return { issueCalls, ledgerPath, judged };
}

function ledgerSteps(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── criterion 1: a production producer REACHES the judge ─────────────────────────────────────

test("W1-T3166: a production fix-rung escalation now reaches the judge — the census that returned ZERO callers is no longer zero", async () => {
  const { judged, issueCalls } = await rungThatEscalates(async () => ({ decision: "deliver", reason: "needs a human now" }));
  assert.equal(judged.length, 1, "the rung's escalation was judged exactly once");
  assert.equal(judged[0]?.class, "BLOCKED");
  assert.equal(issueCalls.length, 1);
});

test("W1-T3166: a DEMOTE verdict moves the issue off the needs-human board onto fleet-notice, with the judge's reason as its first comment", async () => {
  const { issueCalls } = await rungThatEscalates(async () => ({ decision: "demote", reason: "the fix rung is still retrying; nothing to decide yet" }));
  assert.equal(issueCalls.length, 1, "still opened — a demotion is never a suppression");
  assert.ok(issueCalls[0]?.labels.includes(FLEET_NOTICE_LABEL), `expected ${FLEET_NOTICE_LABEL}, got ${issueCalls[0]?.labels.join(",")}`);
  assert.ok(!issueCalls[0]?.labels.includes(NEEDS_HUMAN_LABEL), "a demoted item must NOT also carry needs-human");
  assert.deepEqual(issueCalls[0]?.comments, ["the fix rung is still retrying; nothing to decide yet"]);
});

// ── criterion 2: FAIL-OPEN holds AT THE CALLSITE, not only inside judgeEscalation ────────────

test("W1-T3166: a judge that THROWS still opens a needs-human issue — fail-open at the wired callsite", async () => {
  const { issueCalls } = await rungThatEscalates(async () => { throw new Error("spawn refused"); });
  assert.equal(issueCalls.length, 1, "the escalation was still delivered");
  assert.ok(issueCalls[0]?.labels.includes(NEEDS_HUMAN_LABEL), "an unreadable judge must never demote");
  assert.ok(!issueCalls[0]?.labels.includes(FLEET_NOTICE_LABEL));
});

test("W1-T3166: a judge returning an UNPARSEABLE-shaped verdict is treated as deliver, never as demote", async () => {
  // The library's parser fails open; this pins that the WIRING cannot invert it. An object whose
  // decision is neither "demote" nor "deliver" must not be read as a demotion by omission.
  const { issueCalls } = await rungThatEscalates(async () => ({ decision: "nonsense", reason: "" } as unknown as EscalationJudgeVerdict));
  assert.ok(issueCalls[0]?.labels.includes(NEEDS_HUMAN_LABEL), "anything that is not an explicit demote must deliver");
});

// ── criterion 3: the operator's own CLI stays structurally exempt ────────────────────────────

test("W1-T3166: MANUAL and GRILL remain exempt — the wiring cannot cause an operator-owned class to be judged", () => {
  const base = { taskId: "W1-D", runId: "r", summary: "s", detail: "d", options: [], recommendation: "x" };
  assert.equal(isEscalationJudgeExempt({ ...base, class: "MANUAL" } as Escalation), true);
  assert.equal(isEscalationJudgeExempt({ ...base, class: "GRILL" } as Escalation), true);
  assert.equal(isEscalationJudgeExempt({ ...base, class: "BLOCKED" } as Escalation), false);
});

test("W1-T3166: escalate() — the sync path `rmd escalate` uses — consults NO judge even when one is handed to it", () => {
  // escalate.ts's header: "Anything the operator's own CLI escalated is exempt STRUCTURALLY, not by
  // a field read: escalateCommand calls escalate(), never escalateWithJudge()." Asserted as
  // BEHAVIOUR rather than by reading run-task.ts as text — a prose read passes when the wording is
  // right and the behaviour is wrong. This is the stronger claim: the sync entry point is
  // judge-free no matter WHAT a caller passes, so no future wiring of escalateCommand can demote an
  // operator-authored escalation by accident.
  const issueCalls: Array<{ title: string; labels: string[]; comments: string[] }> = [];
  let judgeCalls = 0;
  const url = escalate(
    {
      class: "BLOCKED",
      taskId: "W1-D",
      runId: "RUN-1",
      summary: "an operator-authored escalation",
      detail: "d",
      options: [{ label: "a", detail: "do a" }],
      recommendation: "a",
    } as Escalation,
    {
      issues: recordingIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      runId: "RUN-1",
      judge: async () => {
        judgeCalls += 1;
        return { decision: "demote", reason: "a judge that must never be consulted here" };
      },
    } as never,
  );
  assert.ok(url.length > 0, "the escalation was opened");
  assert.equal(judgeCalls, 0, "escalate() must never consult a judge — the exemption is structural");
  assert.ok(issueCalls[0]?.labels.includes(NEEDS_HUMAN_LABEL), "and it lands on the operator's board");
  assert.ok(!issueCalls[0]?.labels.includes(FLEET_NOTICE_LABEL), "never demoted");
});

// ── criterion 4: the verdict is ledgered, and survives rotation ──────────────────────────────

test("W1-T3166: a judged escalation writes escalation.judged naming the decision AND the reason — one grep answers 'has the judge ever run'", async () => {
  const { ledgerPath } = await rungThatEscalates(async () => ({ decision: "demote", reason: "still retrying" }));
  const rows = ledgerSteps(ledgerPath).filter((r) => r.step === ESCALATION_JUDGED_STEP);
  assert.equal(rows.length, 1, `expected exactly one ${ESCALATION_JUDGED_STEP} row`);
  assert.equal(rows[0]?.judge_decision, "demote");
  assert.equal(rows[0]?.judge_reason, "still retrying");
  assert.equal(rows[0]?.class, "BLOCKED");
});

test("W1-T3166: the row is written on the DELIVER arm too — a judge that only leaves a trace when it demotes cannot be calibrated", async () => {
  const { ledgerPath } = await rungThatEscalates(async () => ({ decision: "deliver", reason: "a human must choose" }));
  const rows = ledgerSteps(ledgerPath).filter((r) => r.step === ESCALATION_JUDGED_STEP);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.judge_decision, "deliver");
  assert.equal(rows[0]?.judge_reason, "a human must choose");
});

test("W1-T3166: both judged steps are DECISION-RELEVANT, so a demotion is not lost to rotation", () => {
  // DECISIONS.md: a step that must survive rotation to be read needs DECISION_RELEVANT_LEDGER_STEPS
  // membership IN THE SAME CHANGE — "that omission has already cost this repo twice".
  // escalation.demoted was ALREADY absent before this task: a demotion is the one outcome an
  // operator cannot see on the needs-human board, so losing it loses the only evidence of the act.
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(ESCALATION_JUDGED_STEP));
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("escalation.demoted"));
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("escalation.issue_opened"), "the pre-existing sibling is untouched");
});
