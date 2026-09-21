import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger, rotateLedger } from "../src/lib/ledger.js";
import { CONTEXT_ITEM_STEP, CONTEXT_REVOKED_STEP, readContextInventory, readGovernedContext, type ContextItem } from "../src/lib/operator-agent.js";

const NOW = Date.parse("2026-09-21T00:00:00.000Z");

test("unit test: restart and ledger reindex do not restore revoked context", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-context-restart-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const context: ContextItem = {
    version: "context-item-v1",
    contextId: "ctx:restart:revoked",
    source: "operator-note:restart",
    principal: "operator:alice",
    purpose: "plan-work",
    sensitivity: "high",
    authorityRef: "consent:alice:plan",
    observedAt: new Date(NOW).toISOString(),
    freshness: "fresh",
    retention: { policy: "short", expiresAt: "2026-09-22T00:00:00.000Z" },
    visibility: "private",
    derivationLinks: [],
    revocation: { state: "active" },
    content: "revoked memory must not return after restart",
  };
  appendLedger(ledgerPath, { run_id: "context-restart", task_id: context.contextId, step: CONTEXT_ITEM_STEP, context });
  appendLedger(ledgerPath, {
    run_id: "context-restart",
    task_id: context.contextId,
    step: CONTEXT_REVOKED_STEP,
    context_id: context.contextId,
    authority_ref: context.authorityRef,
    at: new Date(NOW).toISOString(),
    receipt: {
      receiptId: "ctxr-restart",
      contextId: context.contextId,
      operation: "revoke",
      at: new Date(NOW).toISOString(),
      authorityRef: context.authorityRef,
      affectedDerivations: 0,
    },
  });
  for (let index = 0; index < 250; index++) {
    appendLedger(ledgerPath, { run_id: `noise-${index}`, task_id: "noise", step: "context-test.noise", detail: "x".repeat(80) });
  }
  const rotated = rotateLedger(ledgerPath, { ceilingBytes: 2_000 });
  assert.equal(rotated.rotated, true);
  assert.ok(readdirSync(join(root, "state")).some((name) => name.includes("ledger.") && (name.endsWith(".ndjson") || name.endsWith(".ndjson.gz"))));

  const freshProcessRead = readGovernedContext({ ledgerPath, now: () => NOW }, { purpose: context.purpose, authorityRef: context.authorityRef, now: NOW });
  assert.deepEqual(freshProcessRead.items, []);
  assert.equal(freshProcessRead.absent, false);
  assert.equal(readContextInventory({ ledgerPath, now: () => NOW })[0]?.availability, "revoked");
});
