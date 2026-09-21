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

const READ = "context-controls-inventory-read";
const WRITE = "context-controls-inventory-write";
const NOW = "2026-09-21T00:00:00.000Z";

function item(overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    version: "context-item-v1",
    contextId: "ctx:inventory:alice",
    source: "operator-note:timezone",
    principal: "operator:alice",
    purpose: "schedule-follow-up",
    sensitivity: "moderate",
    authorityRef: "consent:alice:schedule",
    observedAt: NOW,
    freshness: "fresh",
    retention: { policy: "operator-configured", expiresAt: "2026-10-21T00:00:00.000Z" },
    visibility: "private",
    derivationLinks: [],
    revocation: { state: "active" },
    content: "The operator prefers UTC reminders — bearer-token-looking-string-must-never-appear-here",
    ...overrides,
  };
}

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-context-controls-inventory-"));
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

test("unit test: context-controls inventory is scoped to one principal, names bounded metadata, and never returns raw content", async () => {
  const ledgerPath = setup();
  const alice = item();
  const bob = item({ contextId: "ctx:inventory:bob", principal: "operator:bob", authorityRef: "consent:bob:schedule" });
  for (const context of [alice, bob]) {
    appendLedger(ledgerPath, { run_id: "context-controls-inventory", task_id: context.contextId, step: CONTEXT_ITEM_STEP, context });
  }

  await withService(ledgerPath, async (base) => {
    const noPrincipal = await fetch(`${base}/v1/context-controls/inventory`, { headers: { authorization: `Bearer ${READ}` } });
    assert.equal(noPrincipal.status, 400);

    const res = await fetch(`${base}/v1/context-controls/inventory?principal=${encodeURIComponent(alice.principal)}`, {
      headers: { authorization: `Bearer ${READ}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>>; count: number; absent: boolean; asOf: string };
    assert.equal(body.count, 1);
    assert.equal(body.absent, false);
    assert.deepEqual(body.items.map((entry) => entry.contextId), [alice.contextId]);

    const entry = body.items[0] ?? {};
    for (const field of [
      "source",
      "principal",
      "purpose",
      "sensitivity",
      "authorityRef",
      "observedAt",
      "freshness",
      "retention",
      "visibility",
      "derivationLinks",
      "revocation",
      "availability",
    ]) {
      assert.ok(field in entry, `inventory item must name ${field}`);
    }
    assert.equal("content" in entry, false, "self-service inventory must not expose raw private content");
    assert.equal(JSON.stringify(body).includes(alice.content), false);

    // Bob's context is never returned when Alice is the requested principal — cross-principal
    // leakage would defeat the entire self-service scope.
    assert.equal(body.items.some((it) => it.contextId === bob.contextId), false);

    const forBob = await fetch(`${base}/v1/context-controls/inventory?principal=${encodeURIComponent(bob.principal)}`, {
      headers: { authorization: `Bearer ${READ}` },
    });
    const bobBody = (await forBob.json()) as { items: Array<Record<string, unknown>> };
    assert.deepEqual(bobBody.items.map((entry2) => entry2.contextId), [bob.contextId]);

    const absent = await fetch(`${base}/v1/context-controls/inventory?principal=${encodeURIComponent("operator:nobody")}`, {
      headers: { authorization: `Bearer ${READ}` },
    });
    const absentBody = (await absent.json()) as { items: unknown[]; absent: boolean };
    assert.deepEqual(absentBody.items, []);
    assert.equal(absentBody.absent, true);
  });
});
