import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pendingPrActions } from "../src/lib/fleet-control.js";
import { buildPrActionRoute } from "../src/lib/panel-actions.js";
import { createConfirmNonceStore, createService, makeConfirmNonceRoute, type IdentityProvider } from "../src/lib/service.js";

const OPERATOR_HEADER = "x-test-operator";
const HIGH_OPERATOR: IdentityProvider = {
  name: "test-high-operator",
  grant: (req) => req.headers[OPERATOR_HEADER] === "present" ? new Set(["read", "write"]) : undefined,
  writeTier: "high",
};

async function withPrActionService<T>(fn: (base: string, root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rmd-pr-action-request-"));
  const nonces = createConfirmNonceStore();
  const server = createService({
    tokens: { read: "unused-read", write: "unused-write" },
    providers: [HIGH_OPERATOR],
    routes: [{ ...makeConfirmNonceRoute(nonces), tier: "low" }, buildPrActionRoute({ root, ledgerPath: join(root, "state", "ledger.ndjson") })],
    enforceWriteTiers: true,
    confirmNonces: nonces,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, root);
  } finally {
    server.close();
  }
}

async function confirmedPost(base: string, path: string, body: unknown): Promise<Response> {
  const payload = JSON.stringify(body);
  const headers = { "content-type": "application/json", [OPERATOR_HEADER]: "present" };
  const confirmation = await fetch(`${base}/v1/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ method: "POST", path, payload }),
  });
  assert.equal(confirmation.status, 200, "the test must obtain a route-and-payload-bound confirmation before it can exercise the action");
  const { nonce } = await confirmation.json() as { nonce: string };
  return fetch(`${base}${path}`, { method: "POST", headers: { ...headers, "x-confirm-nonce": nonce }, body: payload });
}

test("confirmed PR actions record one durable request without starting a worker in the request process", async () => {
  await withPrActionService(async (base, root) => {
    const response = await confirmedPost(base, "/v1/pr-actions", { action: "fix", prNumber: 259 });
    assert.equal(response.status, 200);
    const receipt = await response.json() as { armed: boolean; action: string; prNumber: number; requestedAt: string };
    assert.equal(receipt.armed, true);
    assert.equal(receipt.action, "fix");
    assert.equal(receipt.prNumber, 259);
    assert.ok(Number.isFinite(Date.parse(receipt.requestedAt)));

    const pending = pendingPrActions(root);
    assert.equal(pending.length, 1, "the handler persists intent for the daemon's next normal poll");
    assert.deepEqual(pending[0] && { action: pending[0].action, prNumber: pending[0].prNumber }, { action: "fix", prNumber: 259 });
    assert.ok(Number.isFinite(Date.parse(pending[0]!.requestedAt)));
  });
});
