import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildContextControlsRoutes } from "../src/lib/context-controls.js";
import { CONTEXT_ITEM_STEP, type ContextItem } from "../src/lib/operator-agent.js";
import { appendLedger } from "../src/lib/ledger.js";

const READ = "context-controls-derivation-read";
const WRITE = "context-controls-derivation-write";
const NOW = "2026-09-21T00:00:00.000Z";

function context(contextId: string, derivationLinks: string[] = []): ContextItem {
  return {
    version: "context-item-v1",
    contextId,
    source: "assistant-summary:thread-1",
    principal: "operator:alice",
    purpose: "plan-work",
    sensitivity: "moderate",
    authorityRef: "consent:alice:plan",
    observedAt: NOW,
    freshness: "fresh",
    retention: { policy: "short", expiresAt: "2026-09-22T00:00:00.000Z" },
    visibility: "private",
    derivationLinks,
    revocation: { state: "active" },
    content: `private content for ${contextId}`,
  };
}

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-context-controls-derivation-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return join(root, "state", "ledger.ndjson");
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

test("unit test: forgetting a source through context-controls makes its derived summary unavailable", async () => {
  const ledgerPath = setup();
  const source = context("ctx:controls-derivation:source");
  const summary = context("ctx:controls-derivation:summary", [source.contextId]);
  for (const item of [source, summary]) {
    appendLedger(ledgerPath, { run_id: "context-controls-derivation", task_id: item.contextId, step: CONTEXT_ITEM_STEP, context: item });
  }

  await withService(ledgerPath, async (base) => {
    const before = await fetch(`${base}/v1/context-controls/inventory?principal=${encodeURIComponent(source.principal)}`, {
      headers: { authorization: `Bearer ${READ}` },
    });
    const beforeBody = (await before.json()) as { items: Array<Record<string, unknown>> };
    assert.equal(beforeBody.items.find((it) => it.contextId === summary.contextId)?.availability, "available");

    const forget = await post(base, "/v1/context-controls/forget", { contextId: source.contextId, authorityRef: source.authorityRef });
    assert.equal(forget.status, 200);
    const forgetBody = (await forget.json()) as { receipt: { affectedDerivations: number } };
    assert.equal(forgetBody.receipt.affectedDerivations, 1);

    const after = await fetch(`${base}/v1/context-controls/inventory?principal=${encodeURIComponent(source.principal)}`, {
      headers: { authorization: `Bearer ${READ}` },
    });
    const afterBody = (await after.json()) as { items: Array<Record<string, unknown>> };
    assert.equal(afterBody.items.find((it) => it.contextId === source.contextId)?.availability, "deleted");
    assert.equal(afterBody.items.find((it) => it.contextId === summary.contextId)?.availability, "unavailable");
  });
});

test("unit test: revoking a source through context-controls makes its derived summary unavailable", async () => {
  const ledgerPath = setup();
  const source = context("ctx:controls-derivation:revoke-source");
  const summary = context("ctx:controls-derivation:revoke-summary", [source.contextId]);
  for (const item of [source, summary]) {
    appendLedger(ledgerPath, { run_id: "context-controls-derivation-revoke", task_id: item.contextId, step: CONTEXT_ITEM_STEP, context: item });
  }

  await withService(ledgerPath, async (base) => {
    const revoke = await post(base, "/v1/context-controls/revoke", { contextId: source.contextId, authorityRef: source.authorityRef });
    assert.equal(revoke.status, 200);

    const after = await fetch(`${base}/v1/context-controls/inventory?principal=${encodeURIComponent(source.principal)}`, {
      headers: { authorization: `Bearer ${READ}` },
    });
    const afterBody = (await after.json()) as { items: Array<Record<string, unknown>> };
    assert.equal(afterBody.items.find((it) => it.contextId === source.contextId)?.availability, "revoked");
    assert.equal(afterBody.items.find((it) => it.contextId === summary.contextId)?.availability, "unavailable");

    // The derived item's own export coverage is now incomplete — see
    // test/context-controls-export.test.ts for the export-side proof of the same falsifier.
  });
});
