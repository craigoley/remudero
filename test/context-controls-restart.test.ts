import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger, rotateLedger } from "../src/lib/ledger.js";
import { CONTEXT_ITEM_STEP, CONTEXT_DELETED_STEP, type ContextItem } from "../src/lib/operator-agent.js";
import { exportGovernedContext, readContextControlsInventory } from "../src/lib/context-controls.js";

const NOW = Date.parse("2026-09-21T00:00:00.000Z");

test("unit test: restart and ledger reindex do not resurrect context forgotten through context-controls", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-context-controls-restart-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");

  const context: ContextItem = {
    version: "context-item-v1",
    contextId: "ctx:controls-restart:forgotten",
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
    content: "forgotten memory must not return after restart",
  };
  appendLedger(ledgerPath, { run_id: "context-controls-restart", task_id: context.contextId, step: CONTEXT_ITEM_STEP, context });
  appendLedger(ledgerPath, {
    run_id: "context-controls-restart",
    task_id: context.contextId,
    step: CONTEXT_DELETED_STEP,
    context_id: context.contextId,
    authority_ref: context.authorityRef,
    at: new Date(NOW).toISOString(),
    receipt: {
      receiptId: "ctxr-controls-restart",
      contextId: context.contextId,
      operation: "delete",
      at: new Date(NOW).toISOString(),
      authorityRef: context.authorityRef,
      affectedDerivations: 0,
    },
  });
  // Force a real rotation — the same mechanism a restarted daemon's ledger reindex goes through.
  for (let index = 0; index < 250; index++) {
    appendLedger(ledgerPath, { run_id: `noise-${index}`, task_id: "noise", step: "context-controls-test.noise", detail: "x".repeat(80) });
  }
  const rotated = rotateLedger(ledgerPath, { ceilingBytes: 2_000 });
  assert.equal(rotated.rotated, true);
  assert.ok(readdirSync(join(root, "state")).some((name) => name.includes("ledger.") && (name.endsWith(".ndjson") || name.endsWith(".ndjson.gz"))));

  // A FRESH read after the rotation — exactly what a restarted daemon reindexing the ledger union
  // would compute — must still show the item deleted, never silently restored.
  const deps = { ledgerPath, now: () => NOW };
  const inventory = readContextControlsInventory(deps, { principal: context.principal });
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0]?.availability, "deleted");

  // Export must refuse — never resurrect the deleted item as "completed" — after the restart.
  const exported = exportGovernedContext(deps, { principal: context.principal, purpose: context.purpose, authorityRef: context.authorityRef });
  assert.equal(exported.status, "refused");
  assert.notEqual(exported.status, "completed");
  assert.equal((exported as { reason: string }).reason, "incomplete_coverage");
});
