import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { CONTEXT_ITEM_STEP, readContextInventory, readGovernedContext, type ContextItem } from "../src/lib/operator-agent.js";

const NOW = Date.parse("2026-09-21T00:00:00.000Z");

function context(contextId: string, derivationLinks: string[] = []): ContextItem {
  return {
    version: "context-item-v1",
    contextId,
    source: "assistant-summary:thread-1",
    principal: "operator:alice",
    purpose: "plan-work",
    sensitivity: "moderate",
    authorityRef: "consent:alice:plan",
    observedAt: new Date(NOW).toISOString(),
    freshness: "fresh",
    retention: { policy: "short", expiresAt: "2026-09-22T00:00:00.000Z" },
    visibility: "private",
    derivationLinks,
    revocation: { state: "active" },
    content: `private content for ${contextId}`,
  };
}

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-context-derivation-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return join(root, "state", "ledger.ndjson");
}

test("unit test: derived context links to inputs and becomes unavailable after a required input is deleted", () => {
  const ledgerPath = setup();
  const source = context("ctx:source");
  const summary = context("ctx:summary", [source.contextId]);
  for (const item of [source, summary]) appendLedger(ledgerPath, { run_id: "context-derivation", task_id: item.contextId, step: CONTEXT_ITEM_STEP, context: item });

  const beforeDelete = readGovernedContext({ ledgerPath, now: () => NOW }, { purpose: "plan-work", authorityRef: source.authorityRef, now: NOW });
  assert.deepEqual(beforeDelete.items.map((item) => item.contextId), [source.contextId, summary.contextId]);
  assert.deepEqual(readContextInventory({ ledgerPath, now: () => NOW }).find((item) => item.contextId === summary.contextId)?.derivationLinks, [source.contextId]);

  appendLedger(ledgerPath, {
    run_id: "context-derivation",
    task_id: source.contextId,
    step: "panel.context_deleted",
    context_id: source.contextId,
    at: new Date(NOW).toISOString(),
    authority_ref: source.authorityRef,
    receipt: {
      receiptId: "ctxr-delete-source",
      contextId: source.contextId,
      operation: "delete",
      at: new Date(NOW).toISOString(),
      authorityRef: source.authorityRef,
      affectedDerivations: 1,
    },
  });

  const afterDelete = readContextInventory({ ledgerPath, now: () => NOW });
  assert.equal(afterDelete.find((item) => item.contextId === source.contextId)?.availability, "deleted");
  assert.equal(afterDelete.find((item) => item.contextId === summary.contextId)?.availability, "unavailable");
  assert.deepEqual(readGovernedContext({ ledgerPath, now: () => NOW }, { purpose: "plan-work", authorityRef: source.authorityRef, now: NOW }).items, []);
});
