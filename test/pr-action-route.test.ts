import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingPrActions } from "../src/lib/fleet-control.js";
import { buildPrActionRoute } from "../src/lib/panel-actions.js";
import { createConfirmNonceStore, makeConfirmNonceRoute } from "../src/lib/service.js";

// The request-path harness lives beside this route-level test rather than in a shared fixture: the
// proof must continue to exercise the real high-tier confirmation contract, not a lower-tier mock.
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService, type IdentityProvider } from "../src/lib/service.js";

const OPERATOR_HEADER = "x-test-operator";
const HIGH_OPERATOR: IdentityProvider = {
  name: "test-high-operator",
  grant: (req) => req.headers[OPERATOR_HEADER] === "present" ? new Set(["read", "write"]) : undefined,
  writeTier: "high",
};

test("malformed confirmed PR actions fail closed before they become durable daemon work", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-pr-action-route-"));
  const nonces = createConfirmNonceStore();
  const server = createService({
    tokens: { read: "unused-read", write: "unused-write" },
    providers: [HIGH_OPERATOR],
    routes: [{ ...makeConfirmNonceRoute(nonces), tier: "low" }, buildPrActionRoute({ root, ledgerPath: join(root, "state", "ledger.ndjson") })],
    enforceWriteTiers: true,
    confirmNonces: nonces,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { "content-type": "application/json", [OPERATOR_HEADER]: "present" };
  try {
    for (const body of [{}, { action: "restart", prNumber: 259 }, { action: "fix", prNumber: 0 }, { action: "fix", prNumber: 2.5 }, { action: "review", prNumber: 259, extra: true }]) {
      const payload = JSON.stringify(body);
      const confirmation = await fetch(`${base}/v1/confirm`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "POST", path: "/v1/pr-actions", payload }),
      });
      assert.equal(confirmation.status, 200);
      const { nonce } = await confirmation.json() as { nonce: string };
      const response = await fetch(`${base}/v1/pr-actions`, { method: "POST", headers: { ...headers, "x-confirm-nonce": nonce }, body: payload });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(pendingPrActions(root), [], "no malformed request can be read by the daemon as work");
  } finally {
    server.close();
  }
});
