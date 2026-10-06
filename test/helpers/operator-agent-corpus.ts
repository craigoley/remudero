// The E17 operator-agent corpus (W1-T5051: shared with the agent view's parity test): every GET route has
// something in it, half written through the routes and rotated into a gzip archive, half in the live file.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { fixedClock, type Clock } from "../../src/lib/clock.js";
import { createEmergencyStop } from "../../src/lib/emergency-control.js";
import { appendFollowUpCandidate, FOLLOW_UP_POLICY_VERSION, type FollowUpCandidate } from "../../src/lib/follow-up-policy.js";
import { EMERGENCY_STOP_ISSUED_LEDGER_STEP } from "../../src/lib/ledger.js";
import { buildOperatorAgentRoutes, OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP } from "../../src/lib/operator-agent.js";
import { appendPanelLedger } from "../../src/lib/panel-actions.js";
import { createService, type Route } from "../../src/lib/service.js";
import { makeTempDir } from "../../src/lib/tmp.js";
import { profileInput } from "./delegation-profile-fixture.js";
import { planInput } from "./intent-plan-fixture.js";

export const READ = "e17-read-token";
export const WRITE = "e17-write-token";
export const NOW = Date.parse("2026-09-20T11:00:00.000Z");
export const clock: Clock = fixedClock(NOW);
export const SCOPE = { principalId: "user_123", repository: "owner/repo" };

export async function listen(t: { after: (fn: () => void) => void }, routes: Route[]): Promise<string> {
  const server = createService({ tokens: { read: READ, write: WRITE }, routes });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function post(base: string, path: string, body: unknown): Promise<number> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  await res.text();
  return res.status;
}

export async function get(base: string, path: string): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${READ}` } });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

export function experiment(): Record<string, unknown> {
  return {
    version: "experiment-v1",
    experimentId: "experiment:repo:worker-pool",
    proposalId: "operator-agent:repo:scale:queue-pressure",
    hypothesis: "Increasing the worker pool will reduce queue latency for the repository's worker tasks.",
    intervention: { summary: "Increase the worker pool from 2 to 4 for one observation window.", plan: "Apply the scoped worker-pool setting and restore it if the regression guard fires." },
    scope: { repo: "owner/repo", taskType: "worker", lane: "main", evidenceAnchors: ["ledger:queue-latency"] },
    baseline: {
      metricName: "queue_latency_p50", value: 8, unit: "minutes", denominator: 20, comparisonPopulation: "owner/repo worker tasks on main",
      windowStart: "2026-09-18T10:00:00.000Z", windowEnd: "2026-09-20T10:00:00.000Z", source: "ledger:queue-latency", freshness: "verified",
    },
    rollback: { plan: "Restore worker pool size to 2 and record the deployment receipt.", reason: "Rollback if queue latency regresses.", receipt: "change:worker-pool-restore" },
    createdAt: "2026-09-20T10:00:00.000Z",
    state: "proposed",
  };
}

export function promotion(): Record<string, unknown> {
  return {
    version: "experiment-promotion-v1",
    promotionId: "promotion:repo:worker-pool",
    experimentId: "experiment:repo:worker-pool",
    candidate: "worker-pool-v2",
    baseline: "worker-pool-v1",
    scope: { repo: "owner/repo", policyScope: "owner/repo:worker", taskType: "worker", lane: "main" },
    comparisonPopulation: "owner/repo worker tasks on main",
    denominatorFloor: 10,
    observationWindow: { start: "2026-09-18T10:00:00.000Z", end: "2026-09-22T10:00:00.000Z" },
    guardMetrics: [{ metricName: "queue_latency_p50", unit: "minutes", direction: "max", abortThreshold: 12 }],
    maxExposure: 0.1,
    owner: "operator-agent",
    expiresAt: "2026-09-27T10:00:00.000Z",
    rollback: { plan: "Restore worker-pool-v1.", reason: "Rollback on regression.", receipt: "change:worker-pool-restore" },
    createdAt: "2026-09-20T11:00:00.000Z",
    state: "proposed",
  };
}

export const followUp: FollowUpCandidate = {
  version: FOLLOW_UP_POLICY_VERSION,
  candidateId: "follow-up:thread-1",
  sourceEvent: "operator_agent.outcome_observed",
  workstream: "repo/experiment",
  reason: "The accepted experiment has no observed outcome yet.",
  freshness: "verified",
  dependency: "owner response",
  deduplicationKey: "repo/experiment:outcome",
  maxAttempts: 2,
  owner: "operator@example.test",
  nextQuestion: "Would you like to record the observed outcome?",
  createdAt: "2026-09-20T10:00:00.000Z",
};

export function consequencePreflight(ledgerPath: string, id: string): void {
  appendPanelLedger(ledgerPath, OPERATOR_AGENT_CONSEQUENCE_PREFLIGHT_STEP, id, "test", {
    action_id: id, consequence_class: "irreversible", ready: false, at: "2026-09-20T10:30:00.000Z", code: "missing-approvers", reason: "needs an approver",
    approval: { target: `vendor:${id}`, expiresAt: "2026-09-21T10:00:00.000Z", approverRequired: true, recoveryStatement: "none" },
  });
}

export function stopRow(id: string): string {
  const stop = createEmergencyStop({ id, scope: "fleet", reason: "halt the fleet while the incident is triaged", issuedBy: "operator", issuedAt: "2026-09-20T10:00:00.000Z", clearPolicy: "explicit-clear-required", incidentReceiptId: `incident:${id}` });
  return `${JSON.stringify({ ts: new Date().toISOString(), step: EMERGENCY_STOP_ISSUED_LEDGER_STEP, stop })}\n`;
}

/**
 * A corpus every GET has something in: the first half written through the routes and then rotated
 * into a gzip archive, the second half written to the new live file.
 */
export async function corpus(t: { after: (fn: () => void) => void }): Promise<{ stateDir: string; ledgerPath: string }> {
  const root = makeTempDir("e17-operator-agent");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const base = await listen(t, buildOperatorAgentRoutes({ ledgerPath, now: () => NOW }));
  const proposal = {
    proposalId: "operator-agent:repo:scale:queue-pressure", repo: "owner/repo", proposalText: "Increase the worker pool for owner/repo.", confidence: 0.96,
    reasoning: "The queue and p50 latency crossed the conservative threshold together.", category: "scale", status: "pending",
    createdAt: "2026-09-20T10:00:00.000Z", expiresAt: "2026-09-27T10:00:00.000Z",
    evidence: [{ label: "Queued tasks", value: "8", source: "run-ledger", observedAt: "2026-09-20T10:00:00.000Z", freshness: "verified" }],
  };
  const context = {
    version: "context-item-v1", contextId: "ctx:operator:timezone", source: "operator-note:timezone", principal: "operator:alice", purpose: "schedule-follow-up",
    sensitivity: "moderate", authorityRef: "consent:alice:schedule", observedAt: "2026-09-20T10:00:00.000Z", freshness: "fresh",
    retention: { policy: "operator-configured", expiresAt: "2026-10-21T00:00:00.000Z" }, visibility: "private", derivationLinks: [], revocation: { state: "active" },
    content: "The operator prefers UTC reminders.",
  };
  const action = {
    version: "automation-action-v1", actionId: "action:deploy:canary", capability: "deploy.canary", summary: "Promote the canary build to ten percent of traffic.",
    scope: { flowId: "flow:canary", repo: "owner/repo" }, risk: "production", preconditions: [{ id: "health", source: "ledger:health", description: "The fleet health read is healthy." }],
    freshness: { maxAgeSeconds: 600 }, idempotencyKey: "idem:deploy:canary:1", createdAt: "2026-09-20T10:00:00.000Z", expiresAt: "2026-09-20T12:00:00.000Z", dryRun: true,
    approval: { policy: "human" }, rollback: { mode: "reversible", plan: "Route all traffic back to the stable build." }, receiptRef: "ledger:panel.operator_agent_action_receipt",
  };
  const written = [
    await post(base, "/v1/operator-agent/context", { context }),
    await post(base, "/v1/operator-agent/proposals", { proposal }),
    await post(base, "/v1/operator-agent/experiments", { experiment: experiment() }),
    await post(base, "/v1/operator-agent/promotions", { promotion: promotion() }),
    await post(base, "/v1/operator-agent/settings", { settings: { enabled: true, confidenceThreshold: 0.97 } }),
    await post(base, "/v1/operator-agent/actions", { action }),
    await post(base, "/v1/operator-agent/delegations", { profile: profileInput() }),
    await post(base, "/v1/operator-agent/intent-plans", planInput()),
    await post(base, "/v1/operator-agent/preferences/propose", { scope: SCOPE, effect: { kind: "ordering", value: "scale" } }),
  ];
  assert.deepEqual(written.map((status) => status >= 200 && status < 300), written.map(() => true), `every seed write landed: ${written.join(",")}`);
  consequencePreflight(ledgerPath, "cq-archived");
  appendFollowUpCandidate({ ledgerPath }, followUp);
  writeFileSync(ledgerPath, readFileSync(ledgerPath, "utf8") + stopRow("stop:fleet:archived"));
  // The rotation: everything so far moves into a gzip archive, and the live file starts empty.
  writeFileSync(join(stateDir, "ledger.2026-09-20T10-45-00-000Z.ndjson.gz"), gzipSync(readFileSync(ledgerPath)));
  writeFileSync(ledgerPath, "");
  const live = [
    await post(base, "/v1/operator-agent/proposals/decision", { proposalId: proposal.proposalId, decision: "more-info", note: "Show the queue window next time." }),
    await post(base, "/v1/operator-agent/experiments/decision", { experimentId: "experiment:repo:worker-pool", decision: "approved" }),
  ];
  assert.deepEqual(live, [200, 200]);
  consequencePreflight(ledgerPath, "cq-live");
  return { stateDir, ledgerPath };
}

