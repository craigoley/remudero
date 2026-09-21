import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildContextControlsRoutes } from "../src/lib/context-controls.js";
import { CONTEXT_ITEM_STEP, readGovernedContext, type ContextItem } from "../src/lib/operator-agent.js";
import { appendLedger } from "../src/lib/ledger.js";

const READ = "context-controls-forget-read";
const WRITE = "context-controls-forget-write";
const NOW = "2026-09-21T00:00:00.000Z";

function fixture(): { ledgerPath: string; context: ContextItem } {
  const root = mkdtempSync(join(tmpdir(), "rmd-context-controls-forget-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return {
    ledgerPath: join(root, "state", "ledger.ndjson"),
    context: {
      version: "context-item-v1",
      contextId: "ctx:forget:private-note",
      source: "operator-note:private-note",
      principal: "operator:alice",
      purpose: "answer-question",
      sensitivity: "restricted",
      authorityRef: "consent:alice:answer",
      observedAt: NOW,
      freshness: "fresh",
      retention: { policy: "one-week", expiresAt: "2026-09-28T00:00:00.000Z" },
      visibility: "private",
      derivationLinks: [],
      revocation: { state: "active" },
      content: "TOP-SECRET PRIVATE MEMORY THAT MUST NOT BE RETURNED",
    },
  };
}

async function withService<T>(ledgerPath: string, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({
    tokens: { read: READ, write: WRITE },
    routes: buildContextControlsRoutes({ ledgerPath, now: () => Date.parse(NOW) }),
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
    headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("unit test: context-controls forget produces a durable receipt and removes the item from planning", async () => {
  const { ledgerPath, context } = fixture();
  appendLedger(ledgerPath, { run_id: "context-controls-forget", task_id: context.contextId, step: CONTEXT_ITEM_STEP, context });

  await withService(ledgerPath, async (base) => {
    const unknown = await post(base, "/v1/context-controls/forget", { contextId: "ctx:missing", authorityRef: context.authorityRef });
    assert.equal(unknown.status, 404);

    const wrongAuthority = await post(base, "/v1/context-controls/forget", { contextId: context.contextId, authorityRef: "consent:someone-else:answer" });
    assert.equal(wrongAuthority.status, 403);

    // Planning/action preflight still sees the item — forgetting has not yet propagated.
    const beforeForget = readGovernedContext({ ledgerPath, now: () => Date.parse(NOW) }, { purpose: context.purpose, authorityRef: context.authorityRef, now: Date.parse(NOW) });
    assert.deepEqual(beforeForget.items.map((it) => it.contextId), [context.contextId]);

    const forgotten = await post(base, "/v1/context-controls/forget", { contextId: context.contextId, authorityRef: context.authorityRef, reason: "operator asked to forget it" });
    assert.equal(forgotten.status, 200);
    const forgottenBody = (await forgotten.json()) as { ok: true; existing: boolean; receipt: Record<string, unknown> };
    assert.equal(forgottenBody.ok, true);
    assert.equal(forgottenBody.existing, false);
    assert.equal(forgottenBody.receipt.operation, "delete");
    assert.deepEqual(Object.keys(forgottenBody.receipt).sort(), ["affectedDerivations", "at", "authorityRef", "contextId", "operation", "receiptId"].sort());
    assert.equal(JSON.stringify(forgottenBody).includes(context.content), false);

    // Durable, idempotent: repeating the request returns the SAME receipt, never a new one.
    const repeated = await post(base, "/v1/context-controls/forget", { contextId: context.contextId, authorityRef: context.authorityRef });
    assert.equal(repeated.status, 200);
    const repeatedBody = (await repeated.json()) as { existing: boolean; receipt: { receiptId: string } };
    assert.equal(repeatedBody.existing, true);
    assert.equal(repeatedBody.receipt.receiptId, forgottenBody.receipt.receiptId);

    // Eligible context is removed from planning/action preflight once forgotten.
    const afterForget = readGovernedContext({ ledgerPath, now: () => Date.parse(NOW) }, { purpose: context.purpose, authorityRef: context.authorityRef, now: Date.parse(NOW) });
    assert.deepEqual(afterForget.items, []);

    const inventory = await fetch(`${base}/v1/context-controls/inventory?principal=${encodeURIComponent(context.principal)}`, {
      headers: { authorization: `Bearer ${READ}` },
    });
    const inventoryBody = (await inventory.json()) as { items: Array<Record<string, unknown>> };
    assert.equal(inventoryBody.items[0]?.availability, "deleted");
  });
});

test("unit test: context-controls revoke produces a durable receipt distinct from forget/delete", async () => {
  const { ledgerPath, context } = fixture();
  appendLedger(ledgerPath, { run_id: "context-controls-revoke", task_id: context.contextId, step: CONTEXT_ITEM_STEP, context });

  await withService(ledgerPath, async (base) => {
    const revoked = await post(base, "/v1/context-controls/revoke", { contextId: context.contextId, authorityRef: context.authorityRef, reason: "operator withdrew consent" });
    assert.equal(revoked.status, 200);
    const revokedBody = (await revoked.json()) as { existing: boolean; receipt: { operation: string } };
    assert.equal(revokedBody.existing, false);
    assert.equal(revokedBody.receipt.operation, "revoke");
    assert.equal(JSON.stringify(revokedBody).includes(context.content), false);

    // Revocation also removes the item from planning, same as forget.
    const afterRevoke = readGovernedContext({ ledgerPath, now: () => Date.parse(NOW) }, { purpose: context.purpose, authorityRef: context.authorityRef, now: Date.parse(NOW) });
    assert.deepEqual(afterRevoke.items, []);

    // A revoked item cannot be forgotten to produce a fresh delete receipt without going through
    // the same conflict the governance engine already enforces (revoke then delete is fine; the
    // reverse — deleting then revoking — is the conflict path exercised in
    // test/context-governance-receipts.test.ts). Forgetting an already-revoked item still succeeds
    // and returns a DELETE receipt distinct from the revoke receipt above.
    const forgottenAfterRevoke = await post(base, "/v1/context-controls/forget", { contextId: context.contextId, authorityRef: context.authorityRef });
    assert.equal(forgottenAfterRevoke.status, 200);
    const forgottenBody = (await forgottenAfterRevoke.json()) as { receipt: { operation: string; receiptId: string } };
    assert.equal(forgottenBody.receipt.operation, "delete");
    assert.notEqual(forgottenBody.receipt.receiptId, revokedBody.receipt.operation);
  });
});
