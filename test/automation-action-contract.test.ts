// W1-T3855: automation-action-v1 — the explicit preflight, idempotency, approval, rollback, and
// receipt contract between "the system recommends this" and "the system may execute this".
// The five acceptance tests below each drive the pure engine (src/lib/automation-action.ts) AND
// the durable operator-agent routes that ledger it (src/lib/operator-agent.ts).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { fixedClock } from "../src/lib/clock.js";
import { createService } from "../src/lib/service.js";
import {
  AUTOMATION_ACTION_FORBIDDEN_FIELD_RE,
  AUTOMATION_ACTION_MAX_TEXT_CHARS,
  AUTOMATION_ACTION_SECRET_VALUE_RE,
  completeAutomationAction,
  executeAutomationAction,
  findForbiddenAutomationField,
  preflightAutomationAction,
  rollbackAutomationAction,
  validateAutomationAction,
  validateAutomationObservations,
  validateAutomationReceipt,
  type AutomationAction,
  type AutomationActionReceipt,
  type AutomationPreconditionObservation,
} from "../src/lib/automation-action.js";
import { buildOperatorAgentRoutes, OPERATOR_AGENT_ACTION_RECEIPT_STEP, OPERATOR_AGENT_ACTION_STEP } from "../src/lib/operator-agent.js";

const READ_TOKEN = "action-read-token";
const WRITE_TOKEN = "action-write-token";
const CREATED = "2026-09-20T10:00:00.000Z";
const NOW_MS = Date.parse("2026-09-20T11:00:00.000Z");
const CLOCK = fixedClock(NOW_MS);
const FRESH = "2026-09-20T10:59:00.000Z";

function actionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "automation-action-v1",
    actionId: "action:worker-pool:resize",
    capability: "worker-pool.resize",
    summary: "Resize the worker pool from 2 to 4 for one observation window.",
    scope: { flowId: "flow:scale-workers", experimentId: "experiment:repo:worker-pool", repo: "owner/repo" },
    risk: "medium",
    preconditions: [
      { id: "queue-depth", source: "ledger:queue-depth", description: "Queue depth is above the scale-up threshold." },
      { id: "ci-green", source: "github:checks", description: "Main branch CI is green." },
    ],
    freshness: { maxAgeSeconds: 900 },
    idempotencyKey: "idem:worker-pool:2026-09-20",
    createdAt: CREATED,
    expiresAt: "2026-09-21T10:00:00.000Z",
    dryRun: true,
    approval: { policy: "none" },
    rollback: { mode: "reversible", plan: "Restore the worker pool size to 2." },
    receiptRef: "ledger:panel.operator_agent_action_receipt",
    ...overrides,
  };
}

function validAction(overrides: Record<string, unknown> = {}): AutomationAction {
  const validated = validateAutomationAction(actionBody(overrides));
  assert.ok(validated.ok, JSON.stringify(validated));
  return validated.action;
}

function satisfied(observedAt = FRESH): AutomationPreconditionObservation[] {
  return [
    { preconditionId: "queue-depth", state: "satisfied", source: "ledger:queue-depth", observedAt },
    { preconditionId: "ci-green", state: "satisfied", source: "github:checks", observedAt },
  ];
}

function fixtureLedger(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-automation-action-"));
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

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readActions(base: string): Promise<{ version: string; actions: Array<{ action: AutomationAction; state: string; approval: string; receipts: AutomationActionReceipt[] }> }> {
  const res = await fetch(`${base}/v1/operator-agent/actions`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
  assert.equal(res.status, 200);
  return (await res.json()) as never;
}

function ledgerSteps(ledgerPath: string): string[] {
  return readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).step as string);
}

test("automation action refuses incomplete scope freshness approval or rollback metadata", async () => {
  assert.ok(validateAutomationAction(actionBody()).ok, "the complete fixture is valid");
  const cases: Array<[string, Record<string, unknown> | unknown]> = [
    ["not-an-object", ["an", "array"]],
    ["invalid-version", actionBody({ version: "automation-action-v0" })],
    ["missing-identity", actionBody({ actionId: "" })],
    ["missing-scope", actionBody({ scope: undefined })],
    ["missing-scope", actionBody({ scope: { repo: "owner/repo" } })],
    ["missing-scope", actionBody({ scope: { flowId: "flow:scale-workers" } })],
    ["missing-scope", actionBody({ scope: { flowId: "", repo: "owner/repo" } })],
    ["invalid-risk", actionBody({ risk: "catastrophic" })],
    ["missing-preconditions", actionBody({ preconditions: [] })],
    ["missing-preconditions", actionBody({ preconditions: [{ id: "a", source: "ledger:a", description: "A." }, { id: "a", source: "ledger:a", description: "A." }] })],
    ["missing-preconditions", actionBody({ preconditions: [{ id: "a", source: "", description: "A." }] })],
    ["missing-preconditions", actionBody({ preconditions: ["queue-depth"] })],
    ["missing-freshness", actionBody({ freshness: undefined })],
    ["missing-freshness", actionBody({ freshness: { maxAgeSeconds: 0 } })],
    ["missing-freshness", actionBody({ freshness: { maxAgeSeconds: 31 * 24 * 60 * 60 } })],
    ["missing-idempotency-key", actionBody({ idempotencyKey: undefined })],
    ["invalid-expiry", actionBody({ expiresAt: CREATED })],
    ["invalid-expiry", actionBody({ expiresAt: "not a date" })],
    ["missing-dry-run", actionBody({ dryRun: "yes" })],
    ["missing-approval", actionBody({ approval: undefined })],
    ["approval-too-weak", actionBody({ risk: "production", approval: { policy: "none" } })],
    ["missing-rollback", actionBody({ rollback: undefined })],
    ["missing-rollback", actionBody({ rollback: { mode: "reversible" } })],
    ["missing-rollback", actionBody({ rollback: { mode: "irreversible", plan: "Restore." } })],
    ["missing-receipt-ref", actionBody({ receiptRef: "" })],
  ];
  for (const [code, body] of cases) {
    const validated = validateAutomationAction(body);
    assert.equal(validated.ok, false, `${code} must refuse`);
    assert.equal(validated.ok ? undefined : validated.code, code, JSON.stringify(body));
  }
  // An irreversible action is complete when it names its refusal path instead of a plan.
  assert.ok(validateAutomationAction(actionBody({ rollback: { mode: "irreversible", refusal: "Forward-fix through a new PR." } })).ok);
  assert.ok(validateAutomationAction(actionBody({ scope: { experimentId: "experiment:x", instance: "rmd-1" } })).ok);

  const ledgerPath = fixtureLedger();
  await withService(ledgerPath, async (base) => {
    for (const action of [actionBody({ scope: { repo: "owner/repo" } }), actionBody({ freshness: undefined }), actionBody({ risk: "high" }), actionBody({ rollback: undefined })]) {
      const res = await post(base, "/v1/operator-agent/actions", { action });
      assert.equal(res.status, 400);
    }
    const detail = ((await (await post(base, "/v1/operator-agent/actions", { action: actionBody({ risk: "high" }) })).json()) as { detail: string }).detail;
    assert.match(detail, /^approval-too-weak:/);
  });
  assert.equal(existsSync(ledgerPath), false, "an incomplete action never reaches the ledger");
});

test("automation action preserves explicit preflight refusal states", async () => {
  const action = validAction();
  const preflight = (observations: AutomationPreconditionObservation[], extra: Partial<Parameters<typeof preflightAutomationAction>[0]> = {}) =>
    preflightAutomationAction({ action, observations, receipts: [], clock: CLOCK, ...extra });

  const ready = preflight(satisfied());
  assert.equal(ready.outcome, "ready");
  assert.deepEqual(ready.findings, []);
  assert.equal(ready.approval, "not-required");

  const [queue, ci] = satisfied();
  const codes = (result: ReturnType<typeof preflight>) => result.findings.map((finding) => finding.code);
  assert.equal(preflight([queue!]).outcome, "unknown", "a missing observation is unknown, never ready");
  assert.deepEqual(codes(preflight([queue!])), ["not-observed"]);
  const unavailable = preflight([queue!, { ...ci!, state: "unavailable", reason: "GitHub checks API returned 503" }]);
  assert.equal(unavailable.outcome, "unknown", "an unavailable source is never mapped to ready");
  assert.equal(unavailable.findings[0]?.detail, "GitHub checks API returned 503");
  assert.equal(preflight([queue!, { ...ci!, state: "unavailable" }]).findings[0]?.code, "source-unavailable");
  assert.equal(preflight([queue!, { ...ci!, source: "browser:console-tile" }]).findings[0]?.code, "unauthoritative-source");
  assert.equal(preflight([queue!, { ...ci!, source: "ledger:someone-else" }]).outcome, "unknown");
  assert.equal(preflight([queue!, { ...ci!, observedAt: "2026-09-20T12:00:00.000Z" }]).findings[0]?.code, "observed-in-future");
  assert.equal(preflight([queue!, { ...ci!, observedAt: "2026-09-20T10:00:00.000Z" }]).outcome, "stale");
  const unsatisfied = preflight([queue!, { ...ci!, state: "unsatisfied" }]);
  assert.equal(unsatisfied.outcome, "refused");
  assert.equal(unsatisfied.findings[0]?.code, "precondition-unsatisfied");
  assert.equal(preflight([queue!, { ...ci!, state: "unsatisfied", reason: "main is red" }]).findings[0]?.detail, "main is red");
  // Precedence: refused > unknown > stale, and every finding is kept.
  assert.equal(preflight([{ ...queue!, state: "unsatisfied" }]).outcome, "refused");
  assert.deepEqual(codes(preflight([{ ...queue!, state: "unsatisfied" }])), ["precondition-unsatisfied", "not-observed"]);
  assert.equal(preflight([{ ...queue!, observedAt: "2026-09-20T09:00:00.000Z" }]).outcome, "unknown");

  assert.equal(preflight(satisfied(), { clock: fixedClock(Date.parse("2026-09-21T10:00:00.000Z")) }).outcome, "expired");

  const gated = validAction({ risk: "high", approval: { policy: "human" } });
  const gatedPreflight = (approval?: { decision: "approved" | "rejected"; decidedBy: string; decidedAt: string }) =>
    preflightAutomationAction({ action: gated, observations: satisfied(), receipts: [], clock: CLOCK, ...(approval ? { approval } : {}) });
  assert.equal(gatedPreflight().outcome, "refused");
  assert.equal(gatedPreflight().approval, "pending");
  assert.equal(gatedPreflight().findings[0]?.code, "approval-pending");
  assert.equal(gatedPreflight({ decision: "rejected", decidedBy: "op", decidedAt: FRESH }).findings[0]?.code, "approval-rejected");
  assert.equal(gatedPreflight({ decision: "approved", decidedBy: "op", decidedAt: FRESH }).outcome, "ready");

  const admitted = executeAutomationAction({ action, observations: satisfied(), receipts: [], clock: CLOCK });
  assert.equal(preflight(satisfied(), { receipts: [admitted.receipt] }).outcome, "in-progress");
  const completed = completeAutomationAction({ action, receipts: [admitted.receipt], admissionReceiptId: admitted.receipt.receiptId, outcome: "succeeded", evidenceRef: "github:owner/repo#42", clock: CLOCK });
  const afterCompletion = preflight(satisfied(), { receipts: [admitted.receipt, completed.receipt] });
  assert.equal(afterCompletion.outcome, "refused");
  assert.equal(afterCompletion.findings[0]?.code, "already-executed");

  const ledgerPath = fixtureLedger();
  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: actionBody() })).status, 201);
    for (const [observations, outcome] of [[satisfied(), "ready"], [[queue!], "unknown"], [[queue!, { ...ci!, state: "unavailable" }], "unknown"]] as const) {
      const res = await post(base, "/v1/operator-agent/actions/preflight", { actionId: action.actionId, observations });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { preflight: { outcome: string } }).preflight.outcome, outcome);
    }
  });
  assert.deepEqual(ledgerSteps(ledgerPath), [OPERATOR_AGENT_ACTION_STEP], "preflight evaluates and appends nothing");
});

test("automation action is idempotent and reuses its receipt", async () => {
  const action = validAction();
  // A refused attempt does not burn the key: a later, fresh attempt is still admitted.
  const stale = executeAutomationAction({ action, observations: satisfied("2026-09-20T10:00:00.000Z"), receipts: [], clock: CLOCK });
  assert.equal(stale.disposition, "refused");
  assert.equal(stale.receipt.preflight, "stale");
  assert.equal(stale.append, true);
  const first = executeAutomationAction({ action, observations: satisfied(), receipts: [stale.receipt], clock: CLOCK });
  assert.equal(first.disposition, "admitted");
  assert.equal(first.receipt.outcome, "in-progress", "admission is never an optimistic success");
  const second = executeAutomationAction({ action, observations: satisfied(), receipts: [stale.receipt, first.receipt], clock: fixedClock(NOW_MS + 5_000) });
  assert.equal(second.disposition, "reused");
  assert.equal(second.append, false, "a duplicate key appends nothing");
  assert.deepEqual(second.receipt, first.receipt);
  // Even an unready duplicate returns the existing receipt instead of a fresh refusal.
  assert.deepEqual(executeAutomationAction({ action, observations: [], receipts: [first.receipt], clock: CLOCK }).receipt, first.receipt);
  const completion = completeAutomationAction({ action, receipts: [first.receipt], admissionReceiptId: first.receipt.receiptId, outcome: "failed", clock: CLOCK });
  assert.deepEqual(executeAutomationAction({ action, observations: satisfied(), receipts: [first.receipt, completion.receipt], clock: CLOCK }).receipt, completion.receipt);
  const repeatCompletion = completeAutomationAction({ action, receipts: [first.receipt, completion.receipt], admissionReceiptId: first.receipt.receiptId, outcome: "succeeded", evidenceRef: "x", clock: CLOCK });
  assert.equal(repeatCompletion.disposition, "reused");
  assert.deepEqual(repeatCompletion.receipt, completion.receipt);

  const ledgerPath = fixtureLedger();
  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: actionBody() })).status, 201);
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: actionBody() })).status, 200, "identical re-registration is idempotent");
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: actionBody({ summary: "Something else entirely." }) })).status, 409);
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: actionBody({ actionId: "action:other" }) })).status, 409, "one idempotency key binds one action");
    const execute = () => post(base, "/v1/operator-agent/actions/execute", { actionId: action.actionId, observations: satisfied() });
    const firstRes = await execute();
    assert.equal(firstRes.status, 202);
    const firstBody = (await firstRes.json()) as { disposition: string; receipt: AutomationActionReceipt };
    assert.equal(firstBody.disposition, "admitted");
    const secondRes = await execute();
    assert.equal(secondRes.status, 200);
    const secondBody = (await secondRes.json()) as { disposition: string; receipt: AutomationActionReceipt };
    assert.equal(secondBody.disposition, "reused");
    assert.deepEqual(secondBody.receipt, firstBody.receipt);
  });
  assert.deepEqual(ledgerSteps(ledgerPath), [OPERATOR_AGENT_ACTION_STEP, OPERATOR_AGENT_ACTION_RECEIPT_STEP], "exactly one admission is durable");
});

test("automation action records execution and rollback as linked receipts", async () => {
  const irreversible = validAction({ rollback: { mode: "irreversible", refusal: "Forward-fix through a new PR; a merge cannot be unmade." } });
  const admitted = executeAutomationAction({ action: irreversible, observations: satisfied(), receipts: [], clock: CLOCK });
  assert.equal(rollbackAutomationAction({ action: irreversible, receipts: [admitted.receipt], reason: "r", evidenceRef: "e", clock: CLOCK }).receipt.code, "nothing-to-roll-back");
  const done = completeAutomationAction({ action: irreversible, receipts: [admitted.receipt], admissionReceiptId: admitted.receipt.receiptId, outcome: "succeeded", evidenceRef: "github:owner/repo#7", clock: CLOCK });
  const refusedRollback = rollbackAutomationAction({ action: irreversible, receipts: [admitted.receipt, done.receipt], reason: "regressed", evidenceRef: "e", clock: CLOCK });
  assert.equal(refusedRollback.disposition, "refused");
  assert.equal(refusedRollback.append, true, "the refusal is on record");
  assert.equal(refusedRollback.receipt.code, "irreversible");
  assert.equal(refusedRollback.receipt.reason, "Forward-fix through a new PR; a merge cannot be unmade.");
  assert.equal(refusedRollback.receipt.linkedReceiptId, done.receipt.receiptId);

  const ledgerPath = fixtureLedger();
  const action = validAction();
  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: actionBody() })).status, 201);
    const admission = ((await (await post(base, "/v1/operator-agent/actions/execute", { actionId: action.actionId, observations: satisfied() })).json()) as { receipt: AutomationActionReceipt }).receipt;
    const noEvidence = await post(base, "/v1/operator-agent/actions/complete", { actionId: action.actionId, admissionReceiptId: admission.receiptId, outcome: "succeeded" });
    assert.equal(noEvidence.status, 409, "success is never claimed without its authoritative evidence");
    assert.equal(((await noEvidence.json()) as { receipt: AutomationActionReceipt }).receipt.code, "evidence-required");
    const completeRes = await post(base, "/v1/operator-agent/actions/complete", {
      actionId: action.actionId,
      admissionReceiptId: admission.receiptId,
      outcome: "succeeded",
      evidenceRef: "github:owner/repo#42",
      reason: "worker pool resized",
    });
    assert.equal(completeRes.status, 200);
    const completion = ((await completeRes.json()) as { receipt: AutomationActionReceipt }).receipt;
    assert.equal(completion.kind, "completion");
    assert.equal(completion.linkedReceiptId, admission.receiptId);
    assert.equal(completion.evidenceRef, "github:owner/repo#42");
    assert.equal((await readActions(base)).actions[0]?.state, "succeeded");

    const rollbackRes = await post(base, "/v1/operator-agent/actions/rollback", { actionId: action.actionId, reason: "queue latency regressed", evidenceRef: "github:owner/repo#43" });
    assert.equal(rollbackRes.status, 200);
    const rollback = ((await rollbackRes.json()) as { receipt: AutomationActionReceipt }).receipt;
    assert.equal(rollback.kind, "rollback");
    assert.equal(rollback.outcome, "rolled_back");
    assert.equal(rollback.linkedReceiptId, completion.receiptId);
    const again = await post(base, "/v1/operator-agent/actions/rollback", { actionId: action.actionId, reason: "again", evidenceRef: "github:owner/repo#44" });
    assert.deepEqual(((await again.json()) as { receipt: AutomationActionReceipt }).receipt, rollback, "a second rollback returns the first");

    const history = (await readActions(base)).actions[0]!;
    assert.equal(history.state, "rolled_back");
    assert.deepEqual(history.action, action, "the original action is never rewritten");
    assert.deepEqual(history.receipts, [admission, completion, rollback], "the original receipts are kept, in order, unchanged");
  });
  assert.deepEqual(ledgerSteps(ledgerPath), [
    OPERATOR_AGENT_ACTION_STEP,
    OPERATOR_AGENT_ACTION_RECEIPT_STEP,
    OPERATOR_AGENT_ACTION_RECEIPT_STEP,
    OPERATOR_AGENT_ACTION_RECEIPT_STEP,
  ]);
});

test("automation action redacts sensitive and unbounded fields", async () => {
  assert.equal(AUTOMATION_ACTION_FORBIDDEN_FIELD_RE.test("rawPrompt"), true);
  assert.equal(AUTOMATION_ACTION_FORBIDDEN_FIELD_RE.test("browserMeasurements"), true);
  assert.equal(AUTOMATION_ACTION_FORBIDDEN_FIELD_RE.test("summary"), false);
  assert.equal(AUTOMATION_ACTION_FORBIDDEN_FIELD_RE.test("receiptRef"), false);
  assert.equal(AUTOMATION_ACTION_SECRET_VALUE_RE.test("use ghp_abcdefghijklmnopqrstuvwxyz"), true);
  assert.equal(AUTOMATION_ACTION_SECRET_VALUE_RE.test("Authorization: Bearer abcdefghijklmnop"), true);
  assert.equal(AUTOMATION_ACTION_SECRET_VALUE_RE.test("spend at most one token budget"), false);

  const forbidden: Array<[string, Record<string, unknown>]> = [
    ["prompt", actionBody({ prompt: "You are an agent. Resize the pool." })],
    ["transcript", actionBody({ transcript: ["user: go"] })],
    ["scope.credential", actionBody({ scope: { flowId: "f", repo: "r", credential: "x" } })],
    ["modelOutput", actionBody({ modelOutput: "I am confident this will help." })],
    ["preconditions.0.browserMeasurement", actionBody({ preconditions: [{ id: "a", source: "ledger:a", description: "A.", browserMeasurement: 12 }] })],
  ];
  for (const [field, body] of forbidden) {
    const validated = validateAutomationAction(body);
    assert.equal(validated.ok ? undefined : validated.code, "forbidden-field", field);
    assert.equal(validated.ok ? undefined : validated.field, field);
  }
  const secret = validateAutomationAction(actionBody({ summary: "Resize with Bearer abcdefghijklmnopqrst" }));
  assert.equal(secret.ok ? undefined : secret.code, "secret-value");
  const unbounded = validateAutomationAction(actionBody({ summary: "x".repeat(AUTOMATION_ACTION_MAX_TEXT_CHARS + 1) }));
  assert.equal(unbounded.ok ? undefined : unbounded.code, "missing-identity");
  const extra = validAction({ notes: "an unnamed field is dropped, not stored" });
  assert.equal("notes" in extra, false, "only contract fields survive validation");
  assert.equal(validateAutomationObservations([{ ...satisfied()[0]!, browserMeasurement: 3 }]), null);
  assert.equal(validateAutomationObservations([{ ...satisfied()[0]!, reason: "token: ghp_abcdefghijklmnopqrstuvwxyz" }]), null);

  const action = validAction();
  const admitted = executeAutomationAction({ action, observations: satisfied(), receipts: [], clock: CLOCK });
  const completed = completeAutomationAction({ action, receipts: [admitted.receipt], admissionReceiptId: admitted.receipt.receiptId, outcome: "succeeded", evidenceRef: "github:owner/repo#1", clock: CLOCK });
  const longRollback = rollbackAutomationAction({ action, receipts: [admitted.receipt, completed.receipt], reason: "r".repeat(5_000), evidenceRef: "e".repeat(5_000), clock: CLOCK });
  assert.ok(longRollback.receipt.reason.length <= AUTOMATION_ACTION_MAX_TEXT_CHARS + 1, "a receipt reason is bounded");
  assert.ok((longRollback.receipt.evidenceRef ?? "").length <= 161, "a receipt evidence reference is bounded");
  assert.equal(validateAutomationReceipt({ ...admitted.receipt, prompt: "leak" }), null, "a ledgered receipt carrying a forbidden field is dropped on read");
  assert.deepEqual(validateAutomationReceipt(admitted.receipt), admitted.receipt);

  const ledgerPath = fixtureLedger();
  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: actionBody({ prompt: "raw prompt" }) })).status, 400);
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: actionBody(), rawPrompt: "smuggled beside it" })).status, 400);
    assert.equal(existsSync(ledgerPath), false, "a redaction refusal never reaches the ledger");
    assert.equal((await post(base, "/v1/operator-agent/actions", { action: actionBody({ notes: "dropped" }) })).status, 201);
    assert.equal((await post(base, "/v1/operator-agent/actions/execute", { actionId: action.actionId, observations: satisfied(), apiKey: "k" })).status, 400);
    const read = await readActions(base);
    assert.equal(read.version, "automation-action-v1");
    assert.equal(findForbiddenAutomationField(read), undefined, "the public projection carries no forbidden field");
    assert.equal("notes" in read.actions[0]!.action, false);
  });
});
