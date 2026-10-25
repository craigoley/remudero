import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildProductRoutes } from "#src/lib/product-routes.js";
import { buildServeRoutes, type ServeDeps } from "#src/lib/serve.js";
import { createService, type IdentityProvider } from "#src/lib/service.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { declaredBody, violations } from "#test/helpers/openapi-strict.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const command = { version: "product-intent-v1", requestId: "route-create-00001", expectedRevision: 0,
  brief: { name: "Wreckterra", idea: "private original mobile combat idea", portfolio: "OleyArcade",
    objective: "Play a solo Central Park skirmish", constraints: ["mobile first"],
    decisions: [{ key: "players", value: "solo first", provenance: { kind: "operator", reference: "approved brief" } }],
    research: [{ label: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright" }],
    requestedRepository: { owner: "craigoley", name: "wreckterra" },
    resourceEnvelope: { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true },
  } };
const identity: IdentityProvider = {
  name: "fixture-verified-session", grant: () => undefined, readSensitivity: "sensitive",
  authorize(req) {
    const session = req.headers["x-test-session"];
    if (session !== "alice" && session !== "bob") return undefined;
    return { scopes: new Set(["read", "write"]), tier: "middle", actor: `clerk:${session}` };
  },
};

function assembled(root: string) {
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const ledgerPath = join(root, "state/ledger.ndjson");
  const planPath = join(root, "plan/tasks.yaml");
  writeFileSync(ledgerPath, "");
  writeFileSync(planPath, "[]\n");
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(),
      ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath, issues: { close: () => {} }, fleetControlRoot: root, questionsRoot: root,
    tokens: { read: "fixture-read", write: "fixture-write" },
  };
  const before = readdirSync(root, { recursive: true });
  const routes = buildServeRoutes(deps).filter((route) => route.path === "/v1/products");
  assert.deepEqual(readdirSync(root, { recursive: true }), before, "assembling product routes creates no state");
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`).sort(), ["GET /v1/products", "POST /v1/products"]);
  return routes;
}

async function server(t: TestContext, options: { mount?: boolean; missingRoot?: boolean; enforcement?: boolean } = {}) {
  const root = ownedFixtureDir(t, "product-http").dir;
  const log: unknown[] = [];
  const routes = options.mount ? assembled(root) : buildProductRoutes({ root: options.missingRoot ? undefined : root });
  const instance = createService({ tokens: { read: "fixture-read", write: "fixture-write" }, operatorSession: identity,
    routes, enforceWriteTiers: options.enforcement, enforceReadSensitivity: options.enforcement,
    log: (step, extra) => { log.push({ step, extra }); } });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
  return { url, log, async close() { await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve())); } };
}

interface Reply { version: string; error?: string; receipt?: { productId: string; revision: number }; product?: { brief: { idea: string } }; products?: unknown[] }
async function request(base: string, path: string, session?: "alice" | "bob", body?: unknown) {
  const result = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer fixture-write", ...(session ? { "x-test-session": session } : { "x-rmd-actor": "clerk:alice" }),
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const reply = await result.json() as Reply;
  const method = body === undefined ? "GET" : "POST";
  assert.deepEqual(violations(reply, declaredBody("/v1/products", method, result.status)), [],
    "the real product HTTP response must match its declared contract");
  return { status: result.status, cache: result.headers.get("cache-control"), body: reply };
}

test("W1-T10612: product routes require verified operator identity and are mounted by serve", async (t) => {
  const app = await server(t, { mount: true });
  try {
    assert.equal((await request(app.url, "/v1/products")).status, 403);
    assert.equal((await request(app.url, "/v1/products", undefined, command)).status, 403);
    const saved = await request(app.url, "/v1/products", "alice", command);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.version, "product-intent-v1");
    assert.ok(saved.body.receipt);
    const path = `/v1/products?id=${saved.body.receipt.productId}`;
    const own = await request(app.url, path, "alice");
    assert.equal(own.status, 200);
    assert.equal(own.body.product?.brief.idea, command.brief.idea);
    assert.match(own.cache ?? "", /no-store/);
    assert.equal((await request(app.url, path, "bob")).status, 404);
    assert.equal((await request(app.url, "/v1/products", "alice")).body.products?.length, 1);
    assert.deepEqual((await request(app.url, "/v1/products", "bob")).body.products, []);
    const receipt = await request(app.url, `/v1/products?requestId=${command.requestId}`, "alice");
    assert.deepEqual(receipt.body.receipt, saved.body.receipt);
    assert.ok(!JSON.stringify(app.log).includes(command.brief.idea), "service diagnostics never log source idea text");
  } finally { await app.close(); }
});

test("product HTTP validation rejects authority fields, malformed JSON and over-budget requests", async (t) => {
  const app = await server(t);
  try {
    assert.equal((await request(app.url, "/v1/products", "alice", { ...command, owner: "clerk:bob" })).status, 400);
    assert.equal((await request(app.url, "/v1/products?owner=clerk:bob", "alice")).status, 400);
    assert.equal((await request(app.url, "/v1/products", "alice", { ...command, brief: { idea: "x".repeat(70_000) } })).status, 413);
    const invalid = await fetch(app.url + "/v1/products", { method: "POST", headers: { "x-test-session": "alice", "content-type": "application/json" }, body: "{broken" });
    assert.equal(invalid.status, 400);
    assert.equal((await request(app.url, "/v1/products", "alice")).body.products?.length, 0);
  } finally { await app.close(); }
});

test("a missing product state root returns unavailable rather than a fabricated empty collection", async (t) => {
  const app = await server(t, { missingRoot: true });
  try {
    const result = await request(app.url, "/v1/products", "alice");
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "unavailable");
    assert.equal(result.body.products, undefined);
  } finally { await app.close(); }
});

test("production tier and sensitivity enforcement keep bearer credentials below private product access", async (t) => {
  const app = await server(t, { enforcement: true });
  try {
    assert.equal((await request(app.url, "/v1/products", undefined, command)).status, 403);
    assert.equal((await request(app.url, "/v1/products")).status, 403);
    assert.equal((await request(app.url, "/v1/products", "alice", command)).status, 200);
    assert.equal((await request(app.url, "/v1/products", "alice")).status, 200);
  } finally { await app.close(); }
});
