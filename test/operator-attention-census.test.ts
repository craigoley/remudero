import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildAttentionCensus, type AttentionCensusInput, type ThreadSummaryView } from "../src/lib/inbox-responder.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { fakeGitHub } from "./helpers/fake-github.js";

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

test("W1-T4742: why-me evidence names the task and source fact", () => {
  const result = buildAttentionCensus(input({
    judgeByTask: new Map([["W1-T216", { decision: "needs_operator", reason: "A security drill requires a bounded target." }]]),
  }));
  const row = result.items.find((item) => item.proposalId === "verify-human:W1-T216");
  assert.equal(row?.taskId, "W1-T216");
  assert.match(row?.whyMe ?? "", /W1-T216/);
  assert.ok(row?.sourceFacts.some((fact) => fact.source === "plan" && fact.detail.includes("verify: human")));
  assert.ok(row?.sourceFacts.some((fact) => fact.source === "judge" && fact.detail.includes("needs_operator")));
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

test("W1-T4742: archived release evidence flags an active ask without silently approving it", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-attention-archive-"));
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
    proposals: [{ id: "verify-human:W1-T216", summary: "Controlled drill decision.", evidenceAnchors: [] }],
  }));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  writeFileSync(join(root, "state", "ledger.2026-09-28T00-00-00-000Z.ndjson"),
    JSON.stringify({ step: "ratify.approved", task_id: "W1-T216", released: "verify-human" }) + "\n");
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
    const body = await response.json() as { state: string; discrepancy?: string; counts: { decision: number }; verifiedCounts: { decision: number }; items: Array<{ sourceFacts: Array<{ source: string }> }> };
    assert.equal(body.state, "partial");
    assert.equal(body.discrepancy, "active_human_ask_has_release_receipt");
    assert.equal(body.counts.decision, 1);
    assert.equal(body.verifiedCounts.decision, 0);
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
