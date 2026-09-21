import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import {
  CONTEXT_ITEM_STEP,
  readGovernedContext,
  type ContextItem,
} from "../src/lib/operator-agent.js";

const NOW = Date.parse("2026-09-21T00:00:00.000Z");

function item(overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    version: "context-item-v1",
    contextId: "ctx:filter:active",
    source: "operator-note:filtering",
    principal: "operator:alice",
    purpose: "plan-work",
    sensitivity: "low",
    authorityRef: "consent:alice:plan",
    observedAt: new Date(NOW).toISOString(),
    freshness: "fresh",
    retention: { policy: "short", expiresAt: "2026-09-22T00:00:00.000Z" },
    visibility: "private",
    derivationLinks: [],
    revocation: { state: "active" },
    content: "A private planning preference.",
    ...overrides,
  };
}

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-context-filtering-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return join(root, "state", "ledger.ndjson");
}

test("unit test: governed context excludes stale and purpose-mismatched memory and distinguishes stale from absent", () => {
  const ledgerPath = setup();
  const active = item();
  const stale = item({ contextId: "ctx:filter:stale", retention: { policy: "expired", expiresAt: "2026-09-20T00:00:00.000Z" } });
  const otherPurpose = item({ contextId: "ctx:filter:other-purpose", purpose: "draft-email" });
  for (const context of [active, stale, otherPurpose]) {
    appendLedger(ledgerPath, { run_id: "context-test", task_id: context.contextId, step: CONTEXT_ITEM_STEP, context });
  }

  const allowed = readGovernedContext({ ledgerPath, now: () => NOW }, { purpose: "plan-work", authorityRef: "consent:alice:plan", now: NOW });
  assert.deepEqual(allowed.items.map((entry) => entry.contextId), [active.contextId]);
  assert.deepEqual(allowed.stale, [stale.contextId]);
  assert.equal(allowed.absent, false);

  const wrongPurpose = readGovernedContext({ ledgerPath, now: () => NOW }, { purpose: "missing-purpose", authorityRef: "consent:alice:plan", now: NOW });
  assert.deepEqual(wrongPurpose.items, []);
  assert.deepEqual(wrongPurpose.stale, []);
  assert.equal(wrongPurpose.absent, true);
});

test("unit test: revocation is a planning and action preflight exclusion", () => {
  const ledgerPath = setup();
  const context = item();
  appendLedger(ledgerPath, { run_id: "context-test", task_id: context.contextId, step: CONTEXT_ITEM_STEP, context });
  appendLedger(ledgerPath, {
    run_id: "context-test",
    task_id: context.contextId,
    step: "panel.context_revoked",
    context_id: context.contextId,
    at: new Date(NOW).toISOString(),
    authority_ref: context.authorityRef,
    receipt: {
      receiptId: "ctxr-filter",
      contextId: context.contextId,
      operation: "revoke",
      at: new Date(NOW).toISOString(),
      authorityRef: context.authorityRef,
      affectedDerivations: 0,
    },
  });

  const result = readGovernedContext({ ledgerPath, now: () => NOW }, { purpose: context.purpose, authorityRef: context.authorityRef, now: NOW });
  assert.deepEqual(result.items, []);
  assert.equal(result.absent, false, "revoked is unavailable, not absent");
});
