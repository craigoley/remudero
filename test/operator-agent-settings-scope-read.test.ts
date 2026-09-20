import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildOperatorAgentRoutes } from "../src/lib/operator-agent.js";

const READ_TOKEN = "operator-agent-read-token";
const WRITE_TOKEN = "operator-agent-write-token";

async function withService<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rmd-operator-agent-settings-scope-read-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildOperatorAgentRoutes({ ledgerPath }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function post(base: string, repository: string, settings: { enabled: boolean; confidenceThreshold: number }): Promise<Response> {
  return fetch(`${base}/v1/operator-agent/settings`, {
    method: "POST",
    headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ settings, scope: { kind: "repository", repository } }),
  });
}

test("multi-repository settings reads preserve the requested scope", async () => {
  await withService(async (base) => {
    await post(base, "owner/alpha", { enabled: false, confidenceThreshold: 0.95 });
    await post(base, "owner/beta", { enabled: true, confidenceThreshold: 0.98 });

    const response = await fetch(`${base}/v1/operator-agent/settings?repository=${encodeURIComponent("owner/alpha")}`, {
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      settings: { enabled: false, confidenceThreshold: 0.95 },
      source: "ledger",
      scope: { kind: "repository", repository: "owner/alpha" },
    });
  });
});

test("scoped settings reads do not select the first configured repository", async () => {
  await withService(async (base) => {
    await post(base, "owner/alpha", { enabled: false, confidenceThreshold: 0.95 });

    const response = await fetch(`${base}/v1/operator-agent/settings?repository=${encodeURIComponent("owner/beta")}`, {
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      settings: { enabled: true, confidenceThreshold: 0.9 },
      source: "default",
      scope: { kind: "repository", repository: "owner/beta" },
    });
  });
});
