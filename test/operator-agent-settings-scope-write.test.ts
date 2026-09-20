import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService } from "../src/lib/service.js";
import { buildOperatorAgentRoutes } from "../src/lib/operator-agent.js";

const READ_TOKEN = "operator-agent-read-token";
const WRITE_TOKEN = "operator-agent-write-token";

test("settings writes persist the operator-selected repository scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-operator-agent-settings-scope-write-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildOperatorAgentRoutes({ ledgerPath }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/operator-agent/settings`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        settings: { enabled: false, confidenceThreshold: 0.95 },
        scope: { kind: "repository", repository: "owner/selected" },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual({ ...body, updatedAt: undefined }, {
      settings: { enabled: false, confidenceThreshold: 0.95 },
      source: "ledger",
      scope: { kind: "repository", repository: "owner/selected" },
      updatedAt: undefined,
    });
    assert.equal(typeof body.updatedAt, "string");
    assert.equal(Number.isFinite(Date.parse(body.updatedAt as string)), true);

    const line = JSON.parse(readFileSync(ledgerPath, "utf8").trim()) as Record<string, unknown>;
    assert.deepEqual(line.scope, { kind: "repository", repository: "owner/selected" });
  } finally {
    server.close();
  }
});
