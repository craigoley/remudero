import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildOperatorAgentRoutes, type ContextItem } from "../src/lib/operator-agent.js";

const READ = "context-receipts-read";
const WRITE = "context-receipts-write";
const NOW = "2026-09-21T00:00:00.000Z";

function fixture(): { ledgerPath: string; context: ContextItem } {
  const root = mkdtempSync(join(tmpdir(), "rmd-context-receipts-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return {
    ledgerPath: join(root, "state", "ledger.ndjson"),
    context: {
      version: "context-item-v1",
      contextId: "ctx:receipt:private-note",
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

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${WRITE}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("unit test: revoke and delete produce bounded receipts without returning raw private content", async () => {
  const { ledgerPath, context } = fixture();
  await withService(ledgerPath, async (base) => {
    const registered = await post(base, "/v1/operator-agent/context", { context });
    assert.equal(registered.status, 201);
    assert.equal(JSON.stringify(await registered.json()).includes(context.content), false);

    const revoke = await post(base, "/v1/operator-agent/context/revoke", { contextId: context.contextId, authorityRef: context.authorityRef, reason: "operator withdrew consent" });
    assert.equal(revoke.status, 200);
    const revokeBody = (await revoke.json()) as { receipt: Record<string, unknown> };
    assert.deepEqual(Object.keys(revokeBody.receipt).sort(), ["affectedDerivations", "at", "authorityRef", "contextId", "operation", "receiptId"].sort());
    assert.equal(JSON.stringify(revokeBody).includes(context.content), false);

    const deleted = await post(base, "/v1/operator-agent/context/delete", { contextId: context.contextId, authorityRef: context.authorityRef });
    assert.equal(deleted.status, 200);
    const deleteBody = (await deleted.json()) as { receipt: { operation: string } };
    assert.equal(deleteBody.receipt.operation, "delete");
    assert.equal(JSON.stringify(deleteBody).includes(context.content), false);

    const repeated = await post(base, "/v1/operator-agent/context/delete", { contextId: context.contextId, authorityRef: context.authorityRef });
    assert.equal(repeated.status, 200);
    assert.equal(JSON.stringify(await repeated.json()).includes(context.content), false);
  });
});
