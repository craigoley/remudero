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

test("scoped settings fallback preserves the selected scope and conservative defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-operator-agent-settings-scope-fallback-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildOperatorAgentRoutes({ ledgerPath }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/operator-agent/settings?repository=${encodeURIComponent("owner/missing")}`, {
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body.settings, { enabled: true, confidenceThreshold: 0.9 });
    assert.equal(body.source, "default");
    assert.deepEqual(body.scope, { kind: "repository", repository: "owner/missing" });
  } finally {
    server.close();
  }
});

test("malformed repository scope is refused before a settings read", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-operator-agent-settings-scope-invalid-read-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildOperatorAgentRoutes({ ledgerPath }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/operator-agent/settings?repository=${encodeURIComponent("")}`, {
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request", detail: "repository must identify a repository" });
  } finally {
    server.close();
  }
});

test("malformed repository scope is refused before a settings write", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-operator-agent-settings-scope-invalid-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildOperatorAgentRoutes({ ledgerPath }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/operator-agent/settings`, {
      method: "POST",
      headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ settings: { enabled: true, confidenceThreshold: 0.9 }, scope: { kind: "global", repository: "owner/repo" } }),
    });
    assert.equal(response.status, 400);
  } finally {
    server.close();
  }
});
