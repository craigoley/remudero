import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildAttentionCensus, type AttentionCensusInput, type ThreadSummaryView } from "#src/lib/inbox-responder.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createService } from "#src/lib/service.js";
import { classifyProposal, updateProposalRegistry } from "#src/lib/inbox.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { proposalFromJudgedShard } from "#src/lib/verify-human-judge.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

function view(proposalId: string, attention: ThreadSummaryView["attention"]): ThreadSummaryView {
  return {
    threadId: `thread:${proposalId}::inbox::-::-`, proposalId, headline: proposalId,
    snippet: "Latest daemon message", waitingOn: "operator", attention, lastActivity: null,
    messageCount: 1, unread: true,
  };
}

function input(overrides: Partial<AttentionCensusInput> = {}): AttentionCensusInput {
  return {
    views: [view("verify-human:W1-T216", "decision")],
    classifications: [{ proposalId: "verify-human:W1-T216", state: "not_ready", reasons: [] }],
    taskFacts: new Map([["W1-T216", { verify: "human", repo: "remudero", title: "Safe forged-status drill" }]]),
    releasedTaskIds: new Set(),
    judgeByTask: new Map(),
    sources: { plan: "observed", registry: "observed", liveLedger: "observed", archiveLedger: "observed", githubProjection: "observed" },
    ...overrides,
  };
}

test("W1-T4742: census counts attention rather than the last speaker", () => {
  const result = buildAttentionCensus(input({
    views: [view("new-producer:pending", "in_progress"), view("verify-human:W1-T216", "decision")],
    classifications: [
      { proposalId: "new-producer:pending", state: "not_ready", reasons: [] },
      { proposalId: "verify-human:W1-T216", state: "not_ready", reasons: [] },
    ],
  }));
  assert.equal(result.counts.decision, 1);
  assert.equal(result.counts.in_progress, 1);
  assert.equal(result.items.filter((row) => row.waitingOn === "operator").length, 2);
});

test("decision attention distinguishes a ready approval from an ask still awaiting preparation", () => {
  const result = buildAttentionCensus(input({
    views: [view("verify-human:W1-T216", "decision"), view("verify-human:W1-T217", "decision"), view("ruling:unreadable", "decision")],
    classifications: [
      { proposalId: "verify-human:W1-T216", state: "not_ready", reasons: [] },
      { proposalId: "verify-human:W1-T217", state: "ready", reasons: [] },
    ],
    taskFacts: new Map([
      ["W1-T216", { verify: "human", repo: "remudero", title: "Held drill" }],
      ["W1-T217", { verify: "human", repo: "remudero", title: "Prepared decision" }],
    ]),
    judgeByTask: new Map(["W1-T216", "W1-T217"].map(id => [id, { state: "judged", decision: "needs_operator", reason: "A current operator ruling is needed.", at: null }])),
  }));
  assert.equal(result.counts.decision, 3);
  assert.deepEqual(result.decisionReadiness, { ready: 1, needsPreparation: 1, needsTriage: 0, unknown: 1 });
  assert.equal(result.state, "partial", "the missing classification prevents a complete census");
});

test("W1-T4742: why-me evidence names the task and source fact", () => {
  const result = buildAttentionCensus(input({
    judgeByTask: new Map([["W1-T216", { state: "judged", decision: "needs_operator", reason: "A security drill requires a bounded target.", at: null }]]),
  }));
  const row = result.items.find((item) => item.proposalId === "verify-human:W1-T216");
  assert.equal(row?.taskId, "W1-T216");
  assert.match(row?.whyMe ?? "", /W1-T216/);
  assert.ok(row?.sourceFacts.some((fact) => fact.source === "plan" && fact.detail.includes("verify: human")));
  assert.ok(row?.sourceFacts.some((fact) => fact.source === "judge" && fact.detail.includes("needs_operator")));
});

test("machine-judge attention includes exact task context without approving its verification proposal", () => {
  const result = buildAttentionCensus(input({
    views: [view("machine-judge:W1-T5418", "decision")],
    classifications: [{ proposalId: "machine-judge:W1-T5418", state: "ready", reasons: [] }],
    taskFacts: new Map([["W1-T5418", { verify: "auto", repo: "remudero", title: "A bounded verification task", risk: "high" }]]),
    judgeByTask: new Map([["W1-T5418", { state: "judged", decision: "automate", reason: "Existing evidence supports bounded engineering preparation.", at: null }]]),
    releasedTaskIds: new Set(["W1-T5418"]),
    releaseReceipts: new Map([["W1-T5418", "A past verify-human release, not approval of this proposal"]]),
  }));
  const row = result.items[0]!;
  assert.equal(row.taskId, "W1-T5418");
  assert.ok(row.sourceFacts.some(f => f.source === "plan" && f.detail.includes("A bounded verification task")));
  assert.ok(row.sourceFacts.some(f => f.source === "judge" && f.detail.includes("not a proposal ruling")));
  assert.match(row.whyMe, /references W1-T5418/);
  assert.doesNotMatch(row.whyMe, /W1-T5418 requires an operator decision/);
  assert.equal(row.attention, "decision", "context cannot approve or retire the proposal");
  assert.equal(result.counts.decision, 1);
  assert.equal(result.discrepancy, undefined, "a task release is not release of its separate proposal");
  assert.ok(!row.sourceFacts.some(f => f.source === "ledger"));
});

test("an unresolved structural proposal task reference keeps attention evidence partial", () => {
  const result = buildAttentionCensus(input({
    views: [view("machine-judge:W1-T5418", "decision")],
    classifications: [{ proposalId: "machine-judge:W1-T5418", state: "ready", reasons: [] }],
    taskFacts: new Map(),
  }));
  assert.equal(result.items[0]?.taskId, "W1-T5418");
  assert.equal(result.state, "partial");
  assert.equal(result.verifiedCounts.decision, 0);
  assert.equal(result.counts.decision, 1);
});

test("proposal context does not infer task identity from an unrelated producer or free text", () => {
  const result = buildAttentionCensus(input({
    views: [view("unrelated:W1-T5418", "decision")],
    classifications: [{ proposalId: "unrelated:W1-T5418", state: "ready", reasons: [] }],
    taskFacts: new Map([["W1-T5418", { verify: "auto", repo: "remudero", title: "Must not be joined by suffix" }]]),
  }));
  assert.equal(result.items[0]?.taskId, undefined);
  assert.ok(!result.items[0]?.sourceFacts.some(f => f.source === "plan"));
});

test("a held security drill explains why a machine release did not settle the ask", () => {
  const result = buildAttentionCensus(input({
    taskFacts: new Map([["W1-T216", { verify: "human", repo: "remudero", title: "Controlled drill", dispatchHold: true, risk: "high" }]]),
    releasedTaskIds: new Set(["W1-T216"]),
    releaseReceipts: new Map([["W1-T216", "W1-T216 machine release receipt"]]),
  }));
  const row = result.items[0];
  assert.equal(row?.attention, "decision");
  assert.match(row?.whyMe ?? "", /dispatch hold/i);
  assert.ok(row?.sourceFacts.some((fact) => fact.source === "plan-lifecycle" && fact.detail.includes("dispatch_hold")));
  assert.ok(row?.sourceFacts.some((fact) => fact.source === "ledger" && fact.detail.includes("machine release")));
  assert.equal(result.discrepancy, "active_human_ask_has_release_receipt");
});

test("an alphanumeric task id still joins its plan and judge evidence", () => {
  const result = buildAttentionCensus(input({
    views: [view("verify-human:W1-T12e", "decision")],
    classifications: [{ proposalId: "verify-human:W1-T12e", state: "not_ready", reasons: [] }],
    taskFacts: new Map([["W1-T12e", { verify: "human", repo: "remudero", title: "Commissioning drill" }]]),
    judgeByTask: new Map([["W1-T12e", { decision: "needs_operator", reason: "Choose a safe drill window." }]]),
  }));
  assert.equal(result.items[0]?.taskId, "W1-T12e");
  assert.ok(result.items[0]?.sourceFacts.some((fact) => fact.source === "plan" && fact.detail.includes("Commissioning drill")));
  assert.ok(result.items[0]?.sourceFacts.some((fact) => fact.source === "judge" && fact.detail.includes("safe drill window")));
});

test("a plan-closed task alone preserves an unanswered human ask with its source facts", () => {
  const proposal = { id: "verify-human:W1-T1041", summary: "Choose a CI harness", evidenceAnchors: [] };
  const plan = loadPlanFromYaml(`- id: W1-T1041
  title: The duplicate CI harness
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  status: blocked
  retirement: closed
`, "closed-human-ask");
  const classification = classifyProposal(proposal, undefined, { plan, isMerged: () => false, isRatified: () => false,
    grepAnchorTrue: () => true, openProposalIds: new Set() });
  assert.equal(classification.state, "not_ready");
  const result = buildAttentionCensus(input({
    views: [view(proposal.id, "decision")], classifications: [classification],
    taskFacts: new Map([["W1-T1041", { verify: "human", repo: "remudero", title: "The duplicate CI harness", status: "blocked", retirement: "closed" }]]),
  }));
  assert.equal(result.counts.decision, 1); assert.equal(result.counts.history, 0);
  assert.equal(result.items[0]?.attention, "decision");
  assert.ok(result.items[0]?.sourceFacts.some((fact) => fact.source === "plan-lifecycle" && fact.detail.includes("retirement closed")));
});

test("W1-T4884: a stale verify-human ask remains in source-qualified history", () => {
  const taskId = "W1-T1216", proposal = proposalFromJudgedShard({ id: taskId, title: "Autonomous maintenance", rationale: "operator release",
    acceptance: ["a controlled check"], ageDays: 1, depsAllMerged: true, citedInSrc: false }, { decision: "needs_operator", reason: "The operator owns this release" });
  const plan = loadPlanFromYaml(`- id: ${taskId}
  title: Autonomous maintenance
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
`, "released-verification-history");
  const classification = classifyProposal(proposal, undefined, { plan, isMerged: () => false, isRatified: () => false,
    grepAnchorTrue: () => true, openProposalIds: new Set(), isReleasedHumanTask: id => id === taskId });
  assert.equal(classification.state, "retired", "the exact typed release supplies authority");
  const result = buildAttentionCensus(input({
    views: [],
    classifications: [classification],
    taskFacts: new Map([[taskId, { verify: "auto", repo: "remudero", title: "Autonomous maintenance", dispatchHold: false }]]),
    releasedTaskIds: new Set([taskId]),
    sources: { plan: "observed", registry: "observed", liveLedger: "observed", archiveLedger: "partial", githubProjection: "observed" },
  }));
  assert.equal(result.counts.decision, 0);
  assert.equal(result.counts.history, 1);
  assert.equal(result.state, "partial");
  assert.equal(result.verifiedCounts.history, 0);
  assert.equal(result.items[0]?.attention, "history");
  assert.ok(result.items[0]?.sourceFacts.some((fact) => fact.source === "plan" && fact.detail.includes("verify: auto")));
  assert.ok(result.items[0]?.sourceFacts.some((fact) => fact.source === "classification" && fact.detail.includes("was released to the fleet")));
});

test("W1-T4742: missing evidence is partial rather than a healthy zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-attention-census-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, `
- id: W1-T216
  title: "A controlled security drill"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  risk: high
  status: queued
  attempts: 0
  files: [test/controlled-task.test.ts]
  acceptance:
    - claim: "a controlled check"
      proof: "unit test: controlled check"
`);
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({
    proposals: [{ id: "verify-human:W1-T216", summary: "A security drill requires a human decision.", evidenceAnchors: [] }],
  }));
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath: join(root, "state", "ledger.ndjson"),
    github: { prView: () => null }, statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined }, inboxMainSha: () => "a".repeat(40),
  };
  const server = createService({ tokens: { read: "read-token", write: "write-token" }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox/attention-census`, {
      headers: { authorization: "Bearer read-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { state: string; scope: string; counts: { decision: number }; sources: { liveLedger: string } };
    assert.equal(body.scope, "core");
    assert.equal(body.state, "partial");
    assert.equal(body.sources.liveLedger, "unavailable");
    assert.equal(body.counts.decision, 1);
    assert.equal((body as typeof body & { verifiedCounts: { decision: number } }).verifiedCounts.decision, 0,
      "a missing release ledger can make a pending decision stale, so one observed ask is not one verified ask");
  } finally {
    server.close();
  }
});

test("the served inbox preserves an unanswered human ask after plan closure without deleting history", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-attention-closed-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, `
- id: W1-T1041
  title: "The duplicate CI harness was resolved by W1-T3207"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  risk: high
  status: blocked
  retirement: closed
  attempts: 0
  files: [test/workflow-single-suite-run.test.ts]
  acceptance:
    - claim: "single suite"
      proof: "unit test: single suite"
`);
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({
    proposals: [{ id: "verify-human:W1-T1041", summary: "Choose a CI harness", evidenceAnchors: [] }],
  }));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath: join(root, "state", "ledger.ndjson"),
    github: { prView: () => null }, statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined }, inboxMainSha: () => "a".repeat(40),
  };
  const server = createService({ tokens: { read: "read-token", write: "write-token" }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox/attention-census`, {
      headers: { authorization: "Bearer read-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { counts: { decision: number; history: number }; items: Array<{ attention: string; retiredReason?: string; sourceFacts: Array<{ source: string; detail: string }> }> };
    assert.equal(body.counts.decision, 1);
    assert.equal(body.counts.history, 0);
    assert.equal(body.items[0]?.attention, "decision");
    assert.equal(body.items[0]?.retiredReason, undefined);
    assert.equal(JSON.parse(readFileSync(join(root, "state", "inbox-proposals.json"), "utf8")).proposals[0].id, "verify-human:W1-T1041");
    assert.ok(body.items[0]?.sourceFacts.some((fact) => fact.source === "plan-lifecycle" && fact.detail.includes("retirement closed")));
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4768: archived release evidence reconciles an active ask without approving it", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-attention-archive-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, `
- id: W1-T1216
  title: "A controlled security drill"
  repo: remudero
  depends_on: []
  type: implement
  verify: human
  risk: high
  status: queued
  attempts: 0
  files: [test/controlled-task.test.ts]
  acceptance:
    - claim: "a controlled check"
      proof: "unit test: controlled check"
`);
  updateProposalRegistry(join(root, "state", "inbox-proposals.json"), () => [proposalFromJudgedShard({ id: "W1-T1216",
    title: "A controlled release", rationale: "operator release", acceptance: ["a controlled check"], ageDays: 1,
    depsAllMerged: true, citedInSrc: false }, { decision: "needs_operator", reason: "The operator owns this release" })]);
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  writeFileSync(join(root, "state", "ledger.2026-09-28T00-00-00-000Z.ndjson"),
    JSON.stringify({ step: "ratify.approved", task_id: "W1-T1216", released: "verify-human" }) + "\n");
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath: join(root, "state", "ledger.ndjson"),
    github: { prView: () => null }, statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined }, inboxMainSha: () => "a".repeat(40),
  };
  const server = createService({ tokens: { read: "read-token", write: "write-token" }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox/attention-census`;
    assert.equal((await fetch(url)).status, 401, "census must stay behind read auth");
    const response = await fetch(url, { headers: { authorization: "Bearer read-token" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { state: string; discrepancy?: string; sources: { archiveLedger: string }; counts: { decision: number; history: number }; verifiedCounts: { decision: number }; items: Array<{ proposalId: string; attention: string; sourceFacts: Array<{ source: string }> }> };
    assert.equal(body.state, "partial");
    assert.equal(body.discrepancy, undefined);
    assert.equal(body.sources.archiveLedger, "partial", "a retained archive is not proof of complete historical coverage");
    assert.equal(body.counts.decision, 0);
    assert.equal(body.counts.history, 1);
    assert.equal(body.verifiedCounts.decision, 0);
    assert.equal(body.items[0]?.attention, "history");
    assert.ok(body.items[0]?.sourceFacts.some((fact) => fact.source === "ledger"));
  } finally {
    server.close();
  }
});

test("W1-T4742: unchanged source facts keep one census key", () => {
  const a = buildAttentionCensus(input());
  const b = buildAttentionCensus(input());
  assert.equal(a.snapshotKey, b.snapshotKey);
  const changed = buildAttentionCensus(input({ releasedTaskIds: new Set(["W1-T216"]) }));
  assert.notEqual(a.snapshotKey, changed.snapshotKey);
  assert.equal(changed.state, "partial", "a release receipt contradicting an active human ask needs reconciliation");
});
