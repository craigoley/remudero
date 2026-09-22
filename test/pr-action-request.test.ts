import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearPrAction, pendingPrActions, prActionFilePath } from "../src/lib/fleet-control.js";
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

    // The daemon's own consumption path (lib/daemon.ts's finally clause), exercised directly
    // against the real function rather than the faked one daemon.test.ts injects: the marker
    // this route just wrote is the exact one `clearPrAction` must remove, at the exact path
    // `prActionFilePath` derives -- so a mismatch between the two would strand the request
    // forever instead of clearing it on the next poll.
    assert.ok(existsSync(prActionFilePath(root, "fix", 259)), "the marker file exists at the path the daemon will clear");
    assert.equal(clearPrAction(root, "fix", 259), true, "a real, present marker is removed");
    assert.equal(pendingPrActions(root).length, 0, "the daemon's next poll sees no stale duplicate work");
    assert.equal(clearPrAction(root, "fix", 259), false, "clearing an already-consumed marker is a safe no-op, not an error");
  });
});

test("prActionFilePath refuses to derive a path for an unsafe action or PR number", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-pr-action-request-path-"));
  assert.throws(() => prActionFilePath(root, "restart" as never, 259), /unsafe action/);
  assert.throws(() => prActionFilePath(root, "fix", 0), /unsafe PR number/);
  assert.throws(() => prActionFilePath(root, "fix", 2.5), /unsafe PR number/);
});
