// W1-T3855: the durable automation-action-v1 routes' refusal, approval, emergency-stop, dry-run,
// and ledger-projection branches, plus the engine's bounded-history backstop. The five acceptance
// claims live in test/automation-action-contract.test.ts; this suite covers everything around them.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { fixedClock } from "../src/lib/clock.js";
import { createService } from "../src/lib/service.js";
import {
  AUTOMATION_ACTION_MAX_RECEIPTS,
  automationRedactionViolation,
  completeAutomationAction,
  executeAutomationAction,
  findForbiddenAutomationField,
  rollbackAutomationAction,
  validateAutomationAction,
  validateAutomationReceipt,
  type AutomationAction,
  type AutomationActionReceipt,
  type AutomationPreconditionObservation,
} from "../src/lib/automation-action.js";
import {
  buildOperatorAgentRoutes,
  OPERATOR_AGENT_ACTION_DECISION_STEP,
  OPERATOR_AGENT_ACTION_RECEIPT_STEP,
  OPERATOR_AGENT_ACTION_STEP,
  readOperatorAgentActions,
} from "../src/lib/operator-agent.js";

const READ_TOKEN = "action-routes-read-token";
const WRITE_TOKEN = "action-routes-write-token";
const NOW_MS = Date.parse("2026-09-20T11:00:00.000Z");
const CLOCK = fixedClock(NOW_MS);
const FRESH = "2026-09-20T10:59:00.000Z";
const ACTION_ID = "action:deploy:canary";

function actionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "automation-action-v1",
    actionId: ACTION_ID,
    capability: "deploy.canary",
    summary: "Promote the canary build to ten percent of traffic.",
    scope: { flowId: "flow:canary", repo: "owner/repo" },
    risk: "production",
    preconditions: [{ id: "health", source: "ledger:health", description: "The fleet health read is healthy." }],
    freshness: { maxAgeSeconds: 600 },
    idempotencyKey: "idem:deploy:canary:1",
    createdAt: "2026-09-20T10:00:00.000Z",
    expiresAt: "2026-09-20T12:00:00.000Z",
    dryRun: true,
    approval: { policy: "human" },
    rollback: { mode: "reversible", plan: "Route all traffic back to the stable build." },
    receiptRef: "ledger:panel.operator_agent_action_receipt",
    ...overrides,
  };
}

function validAction(overrides: Record<string, unknown> = {}): AutomationAction {
  const validated = validateAutomationAction(actionBody(overrides));
  assert.ok(validated.ok, JSON.stringify(validated));
  return validated.action;
}

const healthy: AutomationPreconditionObservation[] = [{ preconditionId: "health", state: "satisfied", source: "ledger:health", observedAt: FRESH }];

function fixtureLedger(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-automation-routes-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return join(root, "state", "ledger.ndjson");
}

async function withService<T>(ledgerPath: string, fn: (base: string) => Promise<T>, nowMs = NOW_MS): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: buildOperatorAgentRoutes({ ledgerPath, now: fixedClock(nowMs).now }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function states(base: string): Promise<Array<{ state: string; approval: string }>> {
  const res = await fetch(`${base}/v1/operator-agent/actions`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
  return ((await res.json()) as { actions: Array<{ state: string; approval: string }> }).actions;
}

test("W1-T3855: a human-policy action waits for one operator decision before execution is admitted", async () => {
  const ledgerPath = fixtureLedger();
  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/operator-agent/actions/decision", { actionId: ACTION_ID, decision: "approved" })).status, 404);
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: actionBody() })).status, 201);
    assert.deepEqual(await states(base), [{ ...(await states(base))[0], state: "registered", approval: "pending" }]);
    const refused = await post(base, "/v1/operator-agent/actions/execute", { actionId: ACTION_ID, observations: healthy });
    assert.equal(refused.status, 409);
    assert.equal((refused.body.receipt as AutomationActionReceipt).code, "approval-pending");
    const approved = await post(base, "/v1/operator-agent/actions/decision", { actionId: ACTION_ID, decision: "approved" });
    assert.equal(approved.status, 200);
    assert.equal(typeof approved.body.decidedBy, "string");
    assert.equal((await post(base, "/v1/operator-agent/actions/decision", { actionId: ACTION_ID, decision: "rejected" })).status, 409, "the first decision stands");
    assert.equal((await states(base))[0]?.state, "approved");
    const admitted = await post(base, "/v1/operator-agent/actions/execute", { actionId: ACTION_ID, observations: healthy });
    assert.equal(admitted.status, 202);
    assert.equal((await states(base))[0]?.state, "in-progress");
    const preflight = await post(base, "/v1/operator-agent/actions/preflight", { actionId: ACTION_ID, observations: healthy });
    assert.equal((preflight.body.preflight as { outcome: string }).outcome, "in-progress");
  });
  const steps = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).step);
  assert.deepEqual(steps, [OPERATOR_AGENT_ACTION_STEP, OPERATOR_AGENT_ACTION_RECEIPT_STEP, OPERATOR_AGENT_ACTION_DECISION_STEP, OPERATOR_AGENT_ACTION_RECEIPT_STEP]);
});

test("W1-T3855: a rejected, a no-policy, and an expired action cannot be decided again", async () => {
  const ledgerPath = fixtureLedger();
  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: actionBody() })).status, 201);
    assert.equal((await post(base, "/v1/operator-agent/actions/decision", { actionId: ACTION_ID, decision: "rejected" })).status, 200);
    assert.equal((await states(base))[0]?.state, "rejected");
    const refused = await post(base, "/v1/operator-agent/actions/execute", { actionId: ACTION_ID, observations: healthy });
    assert.equal((refused.body.receipt as AutomationActionReceipt).code, "approval-rejected");
    const lowRisk = actionBody({ actionId: "action:low", idempotencyKey: "idem:low", risk: "low", approval: { policy: "none" } });
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: lowRisk })).status, 201);
    assert.equal((await post(base, "/v1/operator-agent/actions/decision", { actionId: "action:low", decision: "approved" })).status, 409);
  });
  await withService(ledgerPath, async (base) => {
    const expiring = actionBody({ actionId: "action:expiring", idempotencyKey: "idem:expiring", expiresAt: "2026-09-20T11:30:00.000Z" });
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: expiring })).status, 201);
  });
  await withService(ledgerPath, async (base) => {
    const all = await states(base);
    assert.ok(all.some((history) => history.state === "expired"));
    assert.equal((await post(base, "/v1/operator-agent/actions/decision", { actionId: "action:expiring", decision: "approved" })).status, 409);
  }, Date.parse("2026-09-20T11:45:00.000Z"));
});

test("W1-T3855: an active emergency stop refuses execution before any receipt is decided", async () => {
  const ledgerPath = fixtureLedger();
  await withService(ledgerPath, async (base) => {
    const low = actionBody({ risk: "low", approval: { policy: "none" } });
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: low })).status, 201);
    const stop = await post(base, "/v1/operator-agent/emergency/stop", {
      scope: "repository",
      scopeTarget: "owner/repo",
      reason: "incident: canary regressions",
      issuedBy: "operator",
      clearPolicy: "explicit-clear-required",
      incidentReceiptId: "incident-1",
    });
    assert.equal(stop.status, 201);
    const refused = await post(base, "/v1/operator-agent/actions/execute", { actionId: ACTION_ID, observations: healthy });
    assert.equal(refused.status, 423);
    assert.equal(refused.body.error, "emergency_stop_active");
  });
  assert.equal(readOperatorAgentActions({ ledgerPath, now: CLOCK.now })[0]?.receipts.length, 0);
});

test("W1-T3855: dry runs, unknown actions, and malformed bodies are refused by name", async () => {
  const ledgerPath = fixtureLedger();
  await withService(ledgerPath, async (base) => {
    for (const path of ["/v1/operator-agent/actions/preflight", "/v1/operator-agent/actions/execute"]) {
      assert.equal((await post(base, path, { actionId: "action:none", observations: [] })).status, 404);
    }
    assert.equal((await post(base, "/v1/operator-agent/actions/complete", { actionId: "action:none", admissionReceiptId: "aar-x", outcome: "failed" })).status, 404);
    assert.equal((await post(base, "/v1/operator-agent/actions/rollback", { actionId: "action:none", reason: "r", evidenceRef: "e" })).status, 404);

    const low = actionBody({ risk: "low", approval: { policy: "none" } });
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: low })).status, 201);
    const dry = await post(base, "/v1/operator-agent/actions/execute", { actionId: ACTION_ID, observations: healthy, dryRun: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.disposition, "dry-run");
    assert.equal((await post(base, "/v1/operator-agent/actions/rollback", { actionId: ACTION_ID, reason: "r", evidenceRef: "e" })).status, 409, "nothing completed yet");
    assert.equal((await post(base, "/v1/operator-agent/actions/complete", { actionId: ACTION_ID, admissionReceiptId: "aar-missing", outcome: "failed" })).status, 409);

    const noDry = actionBody({ actionId: "action:no-dry", idempotencyKey: "idem:no-dry", risk: "low", approval: { policy: "none" }, dryRun: false });
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: noDry })).status, 201);
    const unsupported = await post(base, "/v1/operator-agent/actions/execute", { actionId: "action:no-dry", observations: healthy, dryRun: true });
    assert.equal(unsupported.status, 409);
    assert.equal((unsupported.body.receipt as AutomationActionReceipt).code, "dry-run-unsupported");

    const malformed: Array<[string, unknown]> = [
      ["/v1/operator-agent/actions", "not an object"],
      ["/v1/operator-agent/actions/decision", { decision: "approved" }],
      ["/v1/operator-agent/actions/decision", { actionId: ACTION_ID, decision: "maybe" }],
      ["/v1/operator-agent/actions/execute", { observations: healthy }],
      ["/v1/operator-agent/actions/execute", { actionId: ACTION_ID, observations: [{ preconditionId: "health" }] }],
      ["/v1/operator-agent/actions/execute", { actionId: ACTION_ID, observations: healthy, dryRun: "yes" }],
      ["/v1/operator-agent/actions/complete", { actionId: ACTION_ID, outcome: "failed" }],
      ["/v1/operator-agent/actions/complete", { actionId: ACTION_ID, admissionReceiptId: "aar-1", outcome: "done" }],
      ["/v1/operator-agent/actions/complete", { actionId: ACTION_ID, admissionReceiptId: "aar-1", outcome: "failed", evidenceRef: "e".repeat(500) }],
      ["/v1/operator-agent/actions/complete", { actionId: ACTION_ID, admissionReceiptId: "aar-1", outcome: "failed", reason: "r".repeat(500) }],
      ["/v1/operator-agent/actions/rollback", { reason: "r", evidenceRef: "e" }],
      ["/v1/operator-agent/actions/rollback", { actionId: ACTION_ID, reason: "r" }],
    ];
    for (const [path, body] of malformed) assert.equal((await post(base, path, body)).status, 400, `${path} ${JSON.stringify(body)}`);
  });
});

test("W1-T3855: the ledger projection keeps the first record and decision and drops foreign or duplicate receipts", async () => {
  const ledgerPath = fixtureLedger();
  const action = validAction({ risk: "low", approval: { policy: "none" } });
  const admitted = executeAutomationAction({ action, observations: healthy, receipts: [], clock: CLOCK });
  const rows = [
    { step: OPERATOR_AGENT_ACTION_STEP, action: { ...action, version: "automation-action-v0" } },
    { step: OPERATOR_AGENT_ACTION_STEP, action },
    { step: OPERATOR_AGENT_ACTION_STEP, action: { ...action, summary: "A later row can never rewrite the first." } },
    { step: OPERATOR_AGENT_ACTION_DECISION_STEP, action_id: "action:unknown", decision: "approved", decided_by: "op", at: FRESH },
    { step: OPERATOR_AGENT_ACTION_DECISION_STEP, action_id: ACTION_ID, decision: "maybe", decided_by: "op", at: FRESH },
    { step: OPERATOR_AGENT_ACTION_RECEIPT_STEP, action_id: "action:unknown", receipt: { ...admitted.receipt, actionId: "action:unknown" } },
    { step: OPERATOR_AGENT_ACTION_RECEIPT_STEP, action_id: ACTION_ID, receipt: admitted.receipt },
    { step: OPERATOR_AGENT_ACTION_RECEIPT_STEP, action_id: ACTION_ID, receipt: admitted.receipt },
    { step: OPERATOR_AGENT_ACTION_RECEIPT_STEP, action_id: ACTION_ID, receipt: { ...admitted.receipt, receiptId: "aar-bad", kind: "mutation" } },
  ];
  for (const row of rows) appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
  const histories = readOperatorAgentActions({ ledgerPath, now: CLOCK.now });
  assert.equal(histories.length, 1);
  assert.equal(histories[0]?.action.summary, action.summary);
  assert.equal(histories[0]?.approval, "not-required");
  assert.equal(histories[0]?.decision, undefined);
  assert.deepEqual(histories[0]?.receipts, [admitted.receipt]);
  assert.equal(histories[0]?.state, "in-progress");
});

test("W1-T3855: the receipt history backstop stops appending instead of growing without bound", () => {
  const action = validAction({ risk: "low", approval: { policy: "none" } });
  const refusal = executeAutomationAction({ action, observations: [], receipts: [], clock: CLOCK }).receipt;
  const full = Array.from({ length: AUTOMATION_ACTION_MAX_RECEIPTS }, (_, index) => ({ ...refusal, receiptId: `aar-${index}` }));
  const execute = executeAutomationAction({ action, observations: healthy, receipts: full, clock: CLOCK });
  assert.equal(execute.receipt.code, "receipt-history-full");
  assert.equal(execute.append, false);

  const admission = executeAutomationAction({ action, observations: healthy, receipts: [], clock: CLOCK }).receipt;
  const fullWithAdmission = [admission, ...full.slice(1)];
  const complete = completeAutomationAction({ action, receipts: fullWithAdmission, admissionReceiptId: admission.receiptId, outcome: "failed", clock: CLOCK });
  assert.equal(complete.receipt.code, "receipt-history-full");
  const completion = completeAutomationAction({ action, receipts: [admission], admissionReceiptId: admission.receiptId, outcome: "failed", clock: CLOCK }).receipt;
  const rollback = rollbackAutomationAction({ action, receipts: [admission, completion, ...full.slice(2)], reason: "r", evidenceRef: "e", clock: CLOCK });
  assert.equal(rollback.receipt.code, "receipt-history-full");
  assert.equal(rollback.append, false);
});

test("W1-T3855: a ledgered receipt with an unknown shape is refused on read", () => {
  const action = validAction({ risk: "low", approval: { policy: "none" } });
  const receipt = executeAutomationAction({ action, observations: healthy, receipts: [], clock: CLOCK }).receipt;
  for (const bad of [
    null,
    { ...receipt, version: "automation-action-v0" },
    { ...receipt, outcome: "maybe" },
    { ...receipt, receiptId: "" },
    { ...receipt, at: "yesterday" },
    { ...receipt, reason: 7 },
    { ...receipt, code: "c".repeat(500) },
    { ...receipt, preflight: "fine" },
  ]) {
    assert.equal(validateAutomationReceipt(bad), null, JSON.stringify(bad));
  }
  const full = { ...receipt, linkedReceiptId: "aar-1", code: "c", evidenceRef: "e", preflight: "ready" };
  assert.deepEqual(validateAutomationReceipt(full), full);
  assert.deepEqual(automationRedactionViolation("ghp_abcdefghijklmnopqrstuvwxyz"), { code: "secret-value", field: "(value)" });
  assert.deepEqual(automationRedactionViolation({ list: ["fine", "sk-abcdefghijk"] }), { code: "secret-value", field: "list.1" });
  let deep: Record<string, unknown> = { prompt: "too deep to matter" };
  for (let i = 0; i < 12; i += 1) deep = { nested: deep };
  assert.equal(findForbiddenAutomationField(deep), undefined, "the scan is depth-bounded");
});
