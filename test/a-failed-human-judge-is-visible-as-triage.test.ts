import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { buildAttentionCensus, type AttentionCensusInput, type ThreadSummaryView } from "#src/lib/inbox-responder.js";
import { classifyAllProposalsSliced, buildPanelGraphRoutes, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { persistedInboxPath, readPersistedInbox, writePersistedInbox } from "#src/lib/fleet-lane.js";
import { createService } from "#src/lib/service.js";
import { refreshInboxClassification } from "#src/lib/inbox-view.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

function view(id: string): ThreadSummaryView {
  return { threadId: `thread:${id}::inbox::-::-`, proposalId: id, headline: id, snippet: "Current ask",
    waitingOn: "operator", attention: "decision", lastActivity: null, messageCount: 1, unread: true };
}

function input(): AttentionCensusInput {
  const ids = ["W1-T216", "W1-T217", "W1-T218"];
  return {
    views: ids.map(id => view(`verify-human:${id}`)),
    classifications: ids.map(id => ({ proposalId: `verify-human:${id}`, state: "ready", reasons: [] })),
    taskFacts: new Map(ids.map(id => [id, { verify: "human", repo: "remudero", title: id }])),
    releasedTaskIds: new Set(),
    judgeByTask: new Map([
      ["W1-T216", { state: "unclassified", reason: "the judge failed and its verdict is a fail-open default" }],
      ["W1-T217", { state: "judged", decision: "needs_operator", reason: "Keep the explicit security hold.", at: null }],
      ["W1-T218", { state: "unclassified", reason: "the ruling predates the current dependency state" }],
    ]),
    sources: { plan: "observed", registry: "observed", liveLedger: "observed", archiveLedger: "observed", githubProjection: "observed" },
  };
}

test("a failed human judge is counted as triage without changing attention rank", () => {
  const result = buildAttentionCensus(input());
  assert.deepEqual(result.decisionReadiness, { ready: 1, needsPreparation: 0, needsTriage: 2, unknown: 0 });
  assert.equal(result.counts.decision, 3);
  assert.ok(result.items.every(item => item.attention === "decision"));
  assert.equal(result.items[0]?.judgment?.state, "unclassified");
  assert.match(result.items[0]?.judgment?.reason ?? "", /judge failed/);
  assert.match(result.items[0]?.whyMe ?? "", /triage its evidence/);
  assert.doesNotMatch(result.items[0]?.whyMe ?? "", /requires an operator decision/);
  assert.equal(result.items[1]?.judgment?.state, "judged");
  assert.match(result.items[2]?.judgment?.reason ?? "", /dependency state/);
  assert.ok(result.items[0]?.sourceFacts.some(f => f.source === "judge" && f.detail.startsWith("unclassified:")));
});

test("a triage count preserves partial source evidence and the decision denominator", () => {
  const source = input();
  source.sources.archiveLedger = "unavailable";
  source.classifications = source.classifications.slice(0, 2);
  source.views.push(view("new-producer:unverified"));
  const result = buildAttentionCensus(source);
  assert.equal(result.state, "partial");
  assert.equal(result.sources.archiveLedger, "unavailable");
  assert.equal(result.verifiedCounts.decision, 0);
  assert.equal(Object.values(result.decisionReadiness).reduce((n, value) => n + value, 0), result.counts.decision);
  assert.deepEqual(result.decisionReadiness, { ready: 1, needsPreparation: 0, needsTriage: 2, unknown: 1 });
});

test("current failed and stale judgements survive both panel readers and persistence", async t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-triage-census-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), planPath = join(root, "plan/tasks.yaml"), ledgerPath = join(stateDir, "ledger.ndjson");
  mkdirSync(stateDir); mkdirSync(join(root, "plan"));
  const task = (id: string, dependencies: string[] = []) => `- id: ${id}
  title: "A bounded operator ask"
  repo: remudero
  depends_on: ${JSON.stringify(dependencies)}
  type: implement
  verify: human
  risk: high
  status: queued
  attempts: 0
  files: [test/bounded.test.ts]
  acceptance:
    - claim: "bounded evidence"
      proof: "unit test: bounded evidence"
`;
  writeFileSync(planPath, task("W1-T216") + task("W1-T217") + task("W1-T218", ["W1-T219"]) + task("W1-T219"));
  const ids = ["W1-T216", "W1-T217", "W1-T218"];
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: ids.map(id => ({
    id: `verify-human:${id}`, summary: "A held operator ask", evidenceAnchors: [], conflictsWith: [],
  })) }));
  const at = new Date().toISOString();
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ ts: at, run_id: `JUDGE-${id}`, task_id: id,
    step: "verify_human.judged", judge_decision: "needs_operator", judge_reason: "An operator must keep the hold.",
    observed_state: `${id}:current:deps=1:cited=0`, ...extra });
  writeFileSync(join(stateDir, `ledger.${at.replaceAll(":", "-")}.ndjson.gz`), gzipSync(JSON.stringify(row("W1-T216", { judge_failed: true })) + "\n"));
  writeFileSync(ledgerPath, [row("W1-T217"), row("W1-T218")].map(r => JSON.stringify(r)).join("\n") + "\n");
  const deps: PanelGraphDeps = { root, inboxRoot: root, planPath, ledgerPath, github: { prView: () => null },
    statusGithub: fakeGitHub(), ratify: { approve: () => undefined, reframe: () => undefined }, inboxMainSha: () => "a".repeat(40) };
  const classified = await classifyAllProposalsSliced(deps);
  assert.equal(classified.attentionEvidence?.judges.find(([id]) => id === "W1-T216")?.[1].state, "unclassified");
  assert.equal(classified.attentionEvidence?.judges.find(([id]) => id === "W1-T218")?.[1].state, "unclassified");
  await refreshInboxClassification(deps, {});
  assert.equal(readPersistedInbox(stateDir)?.attentionEvidence?.judges.length, 3);
  const census = async (routeDeps: PanelGraphDeps) => {
    const server = createService({ tokens: { read: "triage-read", write: "triage-write" }, routes: buildPanelGraphRoutes(routeDeps) });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox/attention-census`, { headers: { authorization: "Bearer triage-read" } });
      assert.equal(r.status, 200); return await r.json() as ReturnType<typeof buildAttentionCensus>;
    } finally { server.closeAllConnections(); server.close(); }
  };
  const direct = await census(deps), persisted = await census({ ...deps, inboxFromSlowLane: true, readPlanSnapshot: () => classified.plan });
  for (const result of [direct, persisted]) {
    assert.equal(result.decisionReadiness.needsTriage, 2);
    assert.equal(result.counts.decision, 3);
    assert.equal(result.items.find(i => i.taskId === "W1-T217")?.judgment?.state, "judged");
    assert.match(result.items.find(i => i.taskId === "W1-T218")?.judgment?.reason ?? "", /predates/);
  }
});

test("legacy or absent judgement evidence never invents a successful ruling", () => {
  const source = input();
  source.judgeByTask = new Map([["W1-T216", { decision: "needs_operator", reason: "Old narrowed evidence" }]]);
  const result = buildAttentionCensus(source);
  assert.equal(result.decisionReadiness.needsTriage, 3);
  assert.match(result.items[0]?.judgment?.reason ?? "", /omitted judgement state/);
  assert.equal(result.items[1]?.judgment?.state, "unclassified");
  const machine = buildAttentionCensus({ ...source, views: [view("machine-judge:W1-T216")],
    classifications: [{ proposalId: "machine-judge:W1-T216", state: "ready", reasons: [] }] });
  assert.equal(machine.decisionReadiness.needsTriage, 0, "task verification cannot become a proposal ruling");
  assert.equal(machine.decisionReadiness.ready, 1);
  assert.ok(machine.items[0]?.sourceFacts.some(f => f.detail.startsWith("Task verification context")));
});

test("a persisted census refuses invalid judgement states while retaining legacy evidence", t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-triage-persist-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = input();
  const content = { proposals: [{ id: "verify-human:W1-T216", summary: "Held ask", evidenceAnchors: [], conflictsWith: [] }],
    classifications: source.classifications.slice(0, 1), ledgerRows: [], mergedTaskIds: [], projectionIndeterminate: false,
    complete: true, attentionEvidence: { archiveLedger: "partial" as const, releases: [], judges: [["W1-T216", { state: "unclassified" as const, reason: "judge failed" }]] as const } };
  writePersistedInbox(root, { ...content, attentionEvidence: { ...content.attentionEvidence, judges: [["W1-T216", { state: "unclassified", reason: "judge failed" }]] } }, Date.now());
  const original = JSON.parse(readFileSync(persistedInboxPath(root), "utf8"));
  for (const judge of [{ state: "invented", reason: "bad" }, { state: "judged", decision: "approve", reason: "bad", at: null },
    { state: "judged", decision: "needs_operator", reason: "bad", at: 0 }, { state: "unclassified", reason: "x".repeat(301) }]) {
    writeFileSync(persistedInboxPath(root), JSON.stringify({ ...original, attentionEvidence: { ...original.attentionEvidence, judges: [["W1-T216", judge]] } }));
    assert.equal(readPersistedInbox(root)?.attentionEvidence, undefined);
  }
  writeFileSync(persistedInboxPath(root), JSON.stringify({ ...original, attentionEvidence: { ...original.attentionEvidence, judges: [["W1-T216", { decision: "needs_operator", reason: "legacy" }]] } }));
  assert.equal(readPersistedInbox(root)?.attentionEvidence?.judges.length, 1);
  writeFileSync(persistedInboxPath(root), JSON.stringify({ ...original, attentionEvidence: { ...original.attentionEvidence,
    judges: [["W1-T216", { state: "judged", decision: "needs_operator", reason: "current", at: null }]] } }));
  assert.equal(readPersistedInbox(root)?.attentionEvidence?.judges[0]?.[1].state, "judged");
});
