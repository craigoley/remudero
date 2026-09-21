import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildOperatorAgentRoutes, type ContextItem } from "../src/lib/operator-agent.js";

const READ = "context-shape-read";
const WRITE = "context-shape-write";
const NOW = "2026-09-21T00:00:00.000Z";

function fixture(): { ledgerPath: string; context: ContextItem } {
  const root = mkdtempSync(join(tmpdir(), "rmd-context-shape-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return {
    ledgerPath: join(root, "state", "ledger.ndjson"),
    context: {
      version: "context-item-v1",
      contextId: "ctx:operator:timezone",
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
      content: "The operator prefers UTC reminders.",
    },
  };
}

async function withService<T>(ledgerPath: string, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({
    tokens: { read: READ, write: WRITE },
    routes: buildOperatorAgentRoutes({ ledgerPath, now: () => Date.parse(NOW) }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("unit test: every retained context item carries provenance, purpose, authority, freshness, retention, sensitivity, and visibility", async () => {
  const { ledgerPath, context } = fixture();
  await withService(ledgerPath, async (base) => {
    const response = await fetch(`${base}/v1/operator-agent/context`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" },
      body: JSON.stringify({ context }),
    });
    assert.equal(response.status, 201);
    const registered = (await response.json()) as { context: Record<string, unknown> };
    assert.equal("content" in registered.context, false);

    const inventoryResponse = await fetch(`${base}/v1/operator-agent/context`, { headers: { authorization: `Bearer ${READ}` } });
    assert.equal(inventoryResponse.status, 200);
    const inventory = (await inventoryResponse.json()) as { items: Array<Record<string, unknown>> };
    const item = inventory.items[0];
    assert.equal(item?.version, "context-item-v1");
    for (const field of ["source", "principal", "purpose", "sensitivity", "authorityRef", "observedAt", "freshness", "retention", "visibility", "derivationLinks", "revocation"]) {
      assert.ok(field in (item ?? {}), `inventory must name ${field}`);
    }
    assert.equal("content" in (item ?? {}), false, "browser inventory must not expose private content");
  });
});
