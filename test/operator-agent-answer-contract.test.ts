import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { coldAnalyticsSnapshot } from "../src/lib/analytics-route.js";
import { buildOperatorAgentAnswer, readInboxAnswerEvidence } from "../src/lib/operator-agent-answer.js";
import { adaptOperatorAgentProofRows } from "../src/lib/operator-agent-proof.js";
import { inboxThreadId } from "../src/lib/inbox-thread.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { AnalyticsSnapshot } from "../src/lib/analytics-route.js";

const NOW = Date.parse("2026-09-26T10:00:00.000Z");

function snapshot(asOf: string | null = new Date(NOW).toISOString()): Pick<AnalyticsSnapshot, "asOf" | "consoleV1" | "queue"> {
  const cold = coldAnalyticsSnapshot();
  return {
    asOf,
    consoleV1: {
      ...cold.consoleV1,
      operatorAgent: {
        ...cold.consoleV1.operatorAgent,
        proof: adaptOperatorAgentProofRows([{ step: "review.posted", task_id: "W1-T1", proof_exec: ["executed_pass", "executed_fail"] }]),
      },
    },
    queue: cold.queue,
  };
}

const answer = (question: string, source = snapshot()) => buildOperatorAgentAnswer({
  question, repository: "owner/repo", instance: "core", snapshot: source, now: NOW,
});

test("answer-v1 cites a fresh, bounded proof observation under the server-owned repository", () => {
  const result = answer("How are proof validations doing in owner/repo?");
  assert.equal(result.version, "answer-v1");
  assert.equal(result.repository, "owner/repo");
  assert.equal(result.instance, "core");
  assert.equal(result.lens, "current-repository");
  assert.equal(result.coverage, "verified");
  assert.match(result.answer, /1 of 2 executed proofs passed/);
  assert.deepEqual(result.citations.map((cite) => cite.freshness), ["verified"]);
  assert.equal(result.citations[0]?.observedAt, new Date(NOW).toISOString());
  assert.ok(result.citations.length <= 4);
  assert.ok(result.answer.length <= 700);
});

test("unavailable evidence never produces a verified operator answer", () => {
  const cold = answer("Why do proofs fail?", snapshot(null));
  assert.equal(cold.coverage, "unavailable");
  assert.equal(cold.citations.length, 0);
  assert.match(cold.missingSources[0]?.reason ?? "", /refresh/);

  const stale = answer("How are proof validations doing?", snapshot(new Date(NOW - 31 * 60_000).toISOString()));
  assert.equal(stale.coverage, "partial");
  assert.equal(stale.citations[0]?.freshness, "stale");
  assert.ok(stale.missingSources.some((gap) => gap.sourceId.endsWith("#asOf")));

  const noProof = coldAnalyticsSnapshot();
  const missing = answer("How are proofs doing?", { asOf: new Date(NOW).toISOString(), consoleV1: noProof.consoleV1, queue: noProof.queue });
  assert.equal(missing.coverage, "unavailable");
  assert.equal(missing.citations.length, 0);
});

test("another repository and an unsupported question cannot become local verified claims", () => {
  const foreign = answer("Show me proof failures in other/repo");
  assert.equal(foreign.coverage, "unsupported");
  assert.equal(foreign.citations.length, 0);
  assert.equal(answer("What is the weather?").coverage, "unsupported");
  const inbox = answer("Which inbox replies need my response?");
  assert.equal(inbox.coverage, "unavailable");
  assert.match(inbox.missingSources[0]?.sourceId ?? "", /inbox/);
});

test("queue alone is partial and cannot imply a worker scaling recommendation", () => {
  const source = snapshot();
  const result = answer("Should we scale the worker fleet?", {
    ...source,
    queue: { ...source.queue, pending: { state: "observed", value: 8, asOf: new Date(NOW).toISOString() } },
  });
  assert.equal(result.coverage, "partial");
  assert.match(result.answer, /does not justify a scaling recommendation/);
  assert.ok(result.missingSources.some((gap) => gap.sourceId.includes("capacity")));
});

test("task outcomes and operator decisions use separate measured populations", () => {
  const source = snapshot();
  const agent = source.consoleV1.operatorAgent;
  const enriched = {
    ...source,
    consoleV1: {
      ...source.consoleV1,
      operatorAgent: {
        ...agent,
        outcomes: { ...agent.outcomes, status: "measured" as const, armsSeen: 4, armsClassified: 3 },
        decisions: { ...agent.decisions, status: "measured" as const, explicitDecisionCount: 2, automaticMergeEventCount: 100 },
      },
    },
  };
  const outcomes = answer("What is the task outcome trend?", enriched);
  assert.equal(outcomes.coverage, "partial", "an unclassified arm is a missing source, not a verified complete trend");
  assert.match(outcomes.answer, /3 of 4/);
  const decisions = answer("How many operator approvals were there?", enriched);
  assert.equal(decisions.coverage, "verified");
  assert.match(decisions.answer, /2 explicit operator decisions/);
  assert.doesNotMatch(decisions.answer, /100/);
  assert.equal(answer("Show task outcomes", source).coverage, "unavailable");
  assert.equal(answer("Show approvals", source).coverage, "unavailable");
});

test("capacity citations use the underlying measurement window rather than the refresh time", () => {
  const source = snapshot();
  const oldWindow = new Date(NOW - 40 * 60_000).toISOString();
  const capacity = {
    ...source.consoleV1.operatorAgent.capacity,
    status: "measured" as const,
    measurements: [{ repo: "owner/repo", configuredCapacity: 4, admittedLanes: 4, activeWorkers: 3, queuedWork: 2,
      utilizationRatio: 0.75, windowStart: new Date(NOW - 41 * 60_000).toISOString(), windowEnd: oldWindow, recommendation: "balanced" as const }],
  };
  const enriched = { ...source, consoleV1: { ...source.consoleV1, operatorAgent: { ...source.consoleV1.operatorAgent, capacity } } };
  const result = answer("How is fleet capacity?", enriched);
  assert.equal(result.coverage, "partial");
  assert.equal(result.citations[0]?.observedAt, oldWindow);
  assert.equal(result.citations[0]?.freshness, "stale");
  assert.match(result.answer, /3 of 4 workers/);
  assert.equal(answer("How is fleet capacity?", source).coverage, "unavailable");
});

test("modeled cost is labeled as modeled, and absent metrics remain partial or unavailable", () => {
  const source = snapshot();
  const measured = answer("How many tokens and what cost?", source);
  assert.equal(measured.coverage, "verified");
  assert.match(measured.answer, /modeled cost/);
  assert.match(measured.answer, /not a cash-spend receipt/);
  const noMetrics = { ...source, consoleV1: { ...source.consoleV1, metrics: [] } };
  assert.equal(answer("What is the cost?", noMetrics).coverage, "unavailable");
  const noIdentity = buildOperatorAgentAnswer({ question: "proof?", instance: "core", snapshot: source, now: NOW });
  assert.equal(noIdentity.coverage, "unavailable");
  assert.equal(noIdentity.repository, null);
});

test("bounded inbox evidence summarizes stored threads but never claims a reply is needed", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}answer-inbox-`));
  const storePath = join(root, "inbox-threads.jsonl");
  try {
    assert.equal(readInboxAnswerEvidence(storePath).status, "unavailable");
    const threadId = inboxThreadId("proposal-1");
    writeFileSync(storePath, JSON.stringify({ threadId, seq: 1, role: "escalation", body: "private details", ts: NOW }) + "\n");
    utimesSync(storePath, new Date(NOW), new Date(NOW));
    const inbox = readInboxAnswerEvidence(storePath);
    assert.deepEqual(inbox, { status: "measured", threadCount: 1, latestFleetMessageCount: 1, observedAt: new Date(NOW).toISOString() });
    const result = buildOperatorAgentAnswer({ question: "Which inbox threads need my reply?", repository: "owner/repo", instance: "core", snapshot: snapshot(null), inbox, now: NOW });
    assert.equal(result.coverage, "partial");
    assert.match(result.answer, /does not establish which need your reply/);
    assert.doesNotMatch(JSON.stringify(result), /private details/);
    writeFileSync(storePath, "broken-json\n");
    assert.equal(readInboxAnswerEvidence(storePath).status, "unavailable");
    writeFileSync(storePath, JSON.stringify({ threadId, seq: 0, role: "reply", ts: NOW }) + "\n");
    assert.equal(readInboxAnswerEvidence(storePath).status, "unavailable", "a syntactically valid but malformed row is not an empty thread");
    assert.equal(readInboxAnswerEvidence(storePath, () => { throw new Error("read failed"); }).status, "unavailable");
    writeFileSync(storePath, "x".repeat(256 * 1024 + 1));
    assert.equal(readInboxAnswerEvidence(storePath).status, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid source timestamp cannot produce a citation or a verified answer", () => {
  const source = snapshot();
  const agent = source.consoleV1.operatorAgent;
  const capacity = { ...agent.capacity, status: "measured" as const, measurements: [{
    repo: "owner/repo", configuredCapacity: 4, admittedLanes: 4, activeWorkers: 3, queuedWork: 2,
    utilizationRatio: 0.75, windowStart: "not-a-date", windowEnd: "not-a-date", recommendation: "balanced" as const,
  }] };
  const result = answer("How is worker capacity?", { ...source, consoleV1: { ...source.consoleV1, operatorAgent: { ...agent, capacity } } });
  assert.equal(result.coverage, "unavailable");
  assert.equal(result.citations.length, 0);
  assert.match(result.missingSources[0]?.reason ?? "", /observation time is invalid/);
});
