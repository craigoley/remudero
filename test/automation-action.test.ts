import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildAutomationActionRoutes, type AutomationAction } from "../src/lib/automation-action.js";

const READ_TOKEN = "automation-read-token";
const WRITE_TOKEN = "automation-write-token";
const NOW = Date.parse("2026-09-20T12:00:00.000Z");

function action(overrides: Partial<AutomationAction> = {}): AutomationAction {
  return {
    version: "automation-action-v1",
    actionId: "flow:repo:worker-pool",
    flowId: "flow:worker-pool",
    scope: { repository: "owner/repo", instance: "prod" },
    risk: "medium",
    preconditions: [{ name: "queue-pressure", state: "satisfied", observedAt: new Date(NOW - 30_000).toISOString() }],
    requiredFreshnessMs: 60_000,
    observedAt: new Date(NOW - 30_000).toISOString(),
    idempotencyKey: "proposal-1",
    expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
    dryRunSupported: true,
    approvalRequired: false,
    rollback: { actionId: "flow:repo:worker-pool:rollback", plan: "restore the previous worker pool size", reason: "queue latency regressed" },
    ...overrides,
  };
}

async function withService<T>(ledgerPath: string, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildAutomationActionRoutes({ ledgerPath, now: () => NOW }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function post(base: string, path: string, token: string | undefined, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("automation action refuses incomplete scope freshness approval or rollback metadata", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-automation-action-")), "ledger.ndjson");
  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/automation/actions", undefined, { action: action() })).status, 401);
    assert.equal((await post(base, "/v1/automation/actions", READ_TOKEN, { action: action() })).status, 403);
    const missingScope = { ...action(), scope: {} };
    assert.equal((await post(base, "/v1/automation/actions", WRITE_TOKEN, { action: missingScope })).status, 400);
    const missingFreshness = { ...action(), requiredFreshnessMs: 0 };
    assert.equal((await post(base, "/v1/automation/actions", WRITE_TOKEN, { action: missingFreshness })).status, 400);
    const missingRollback = { ...action(), rollback: undefined };
    assert.equal((await post(base, "/v1/automation/actions", WRITE_TOKEN, { action: missingRollback })).status, 400);
  });
});

test("automation action preserves explicit preflight refusal states", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-automation-action-")), "ledger.ndjson");
  await withService(ledgerPath, async (base) => {
    const absent = await post(base, "/v1/automation/actions/preflight", READ_TOKEN, { actionId: "missing" });
    assert.deepEqual(await absent.json(), { version: "automation-action-v1", actionId: "missing", preflight: { state: "unknown", source: "unavailable", reason: "ledger-unavailable", freshness: "unavailable" } });

    const stale = action({ actionId: "stale", observedAt: new Date(NOW - 120_000).toISOString() });
    const unknown = action({ actionId: "unknown", preconditions: [{ name: "daemon", state: "unknown", observedAt: new Date(NOW - 1_000).toISOString() }] });
    const refused = action({ actionId: "refused", preconditions: [{ name: "approval", state: "missing", observedAt: new Date(NOW - 1_000).toISOString() }] });
    const expired = action({ actionId: "expired", expiresAt: new Date(NOW - 1).toISOString() });
    for (const item of [stale, unknown, refused, expired]) assert.equal((await post(base, "/v1/automation/actions", WRITE_TOKEN, { action: item })).status, 201);
    for (const [actionId, state] of [["stale", "stale"], ["unknown", "unknown"], ["refused", "refused"], ["expired", "expired"]] as const) {
      const response = await post(base, "/v1/automation/actions/preflight", READ_TOKEN, { actionId });
      assert.equal((await response.json()).preflight.state, state);
    }
  });
});

test("automation action is idempotent and reuses its receipt", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-automation-action-")), "ledger.ndjson");
  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/automation/actions", WRITE_TOKEN, { action: action() })).status, 201);
    const first = await post(base, "/v1/automation/actions/decision", WRITE_TOKEN, { actionId: action().actionId, decision: "approve", idempotencyKey: "decision-1" });
    const firstBody = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstBody.receipt.status, "in-progress");
    const duplicate = await post(base, "/v1/automation/actions/decision", WRITE_TOKEN, { actionId: action().actionId, decision: "approve", idempotencyKey: "decision-1" });
    const duplicateBody = await duplicate.json();
    assert.equal(duplicate.status, 200);
    assert.equal(duplicateBody.existing, true);
    assert.equal(duplicateBody.receipt.receiptId, firstBody.receipt.receiptId);
    assert.equal(readFileSync(ledgerPath, "utf8").trim().split("\n").length, 2);
  });
});

test("automation action records execution and rollback as linked receipts", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-automation-action-")), "ledger.ndjson");
  await withService(ledgerPath, async (base) => {
    const item = action({ approvalRequired: true });
    assert.equal((await post(base, "/v1/automation/actions", WRITE_TOKEN, { action: item })).status, 201);
    const approved = await post(base, "/v1/automation/actions/decision", WRITE_TOKEN, { actionId: item.actionId, decision: "approve", idempotencyKey: "approval-1" });
    assert.equal(approved.status, 409);
    const refusal = await approved.json();
    assert.equal(refusal.receipt.status, "refused");

    const readyItem = action({ actionId: "ready", approvalRequired: false });
    assert.equal((await post(base, "/v1/automation/actions", WRITE_TOKEN, { action: readyItem })).status, 201);
    const execution = await post(base, "/v1/automation/actions/decision", WRITE_TOKEN, { actionId: readyItem.actionId, decision: "approve", idempotencyKey: "execution-1" });
    const executionBody = await execution.json();
    assert.equal(execution.status, 200);
    const rollback = await post(base, "/v1/automation/actions/decision", WRITE_TOKEN, { actionId: readyItem.actionId, decision: "rollback", idempotencyKey: "rollback-1", reason: "guardrail regressed" });
    const rollbackBody = await rollback.json();
    assert.equal(rollback.status, 200);
    assert.equal(rollbackBody.receipt.linkedReceiptId, executionBody.receipt.receiptId);
    assert.equal((await (await post(base, "/v1/automation/actions/preflight", READ_TOKEN, { actionId: readyItem.actionId })).json()).preflight.state, "in-progress");
  });
});

test("automation action redacts sensitive and unbounded fields", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-automation-action-")), "ledger.ndjson");
  await withService(ledgerPath, async (base) => {
    assert.equal((await post(base, "/v1/automation/actions", WRITE_TOKEN, { action: { ...action(), rawPrompt: "do this" } })).status, 400);
    assert.equal((await post(base, "/v1/automation/actions", WRITE_TOKEN, { action: { ...action(), measurement: 42 } })).status, 400);
    assert.equal((await post(base, "/v1/automation/actions", WRITE_TOKEN, { action: { ...action(), credential: "bearer secret" } })).status, 400);
    assert.equal((await post(base, "/v1/automation/actions/decision", WRITE_TOKEN, { actionId: action().actionId, decision: "approve", idempotencyKey: "safe", rawPrompt: "hidden" })).status, 400);
  });
});
