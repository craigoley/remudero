import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { watchSuccessorModels } from "#src/lib/model-availability.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

// The successor watch can still measure the cash catalog when a second account serves it.
test("W1-T10230: model.successor.refused no longer recurs", async (t) => {
  const { dir: root } = ownedFixtureDir(t, "scout-model-successor");
  const defaultEndpoint = "https://default.example.test/";
  const mappedEndpoint = "https://mapped.example.test/";
  const successor = "gpt-6.1-terra";
  const config: Config = {
    claudeBin: "/unused",
    root,
    workerProviders: {
      enabled: ["cash"],
      cashEndpoint: defaultEndpoint,
      cashDeploymentEndpoints: {
        [successor]: { endpoint: mappedEndpoint, keyEnv: "RMD_CASH_MAPPED_API_KEY" },
      },
    },
  };
  const fixtureKeys = {
    RMD_OPENWEIGHT_API_KEY: "fixture-default-key",
    RMD_CASH_MAPPED_API_KEY: "fixture-mapped-key",
  };
  for (const [name, value] of Object.entries(fixtureKeys)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }

  const requests: Array<{ url: string; key: string | null }> = [];
  let mappedAccountAvailable = true;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, key: new Headers(init?.headers).get("api-key") });
    if (url.startsWith(mappedEndpoint) && mappedAccountAvailable) {
      return Response.json({ data: [{ id: successor }] });
    }
    return new Response(null, { status: 503 });
  });
  const catalogPath = "openai/models?api-version=2024-10-21";
  const expectedRequests = [
    { url: defaultEndpoint + catalogPath, key: fixtureKeys.RMD_OPENWEIGHT_API_KEY },
    { url: mappedEndpoint + catalogPath, key: fixtureKeys.RMD_CASH_MAPPED_API_KEY },
  ];

  const rows: Array<{ step: string; [key: string]: unknown }> = [];
  const measure = () => watchSuccessorModels({
    config,
    routedModels: ["gpt-5.6-terra"],
    ledger: (row) => rows.push(row),
  });

  for (let tick = 0; tick < 2; tick++) {
    const reading = await measure();
    assert.equal(reading.status, "measured", reading.refusedReason);
    assert.deepEqual(reading.successors.map(({ model, state, sources }) => ({ model, state, sources })), [
      { model: successor, state: "ready", sources: ["cash"] },
    ]);
  }
  assert.deepEqual(requests, [...expectedRequests, ...expectedRequests]);
  assert.deepEqual(rows.map(({ step }) => step), [
    "model.successor.catalog_account_unreadable", "model.successor.read",
    "model.successor.catalog_account_unreadable", "model.successor.read",
  ]);
  assert.equal(rows[0]?.endpoint, defaultEndpoint);
  assert.match(String(rows[0]?.reason), /HTTP 503/);

  mappedAccountAvailable = false;
  rows.length = 0;
  requests.length = 0;
  const outage = await measure();
  assert.deepEqual(requests, expectedRequests);
  assert.equal(outage.status, "refused");
  assert.deepEqual(outage.successors, []);
  assert.deepEqual(rows.map(({ step }) => step), [
    "model.successor.catalog_account_unreadable", "model.successor.catalog_account_unreadable",
    "model.successor.refused",
  ]);
  assert.equal(rows[2]?.reason, outage.refusedReason);
  assert.match(outage.refusedReason ?? "", /HTTP 503.*HTTP 503/);
});
