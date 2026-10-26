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

function assembled(root: string, extra: Partial<ServeDeps> = {}) {
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
    ...extra,
  };
  const before = readdirSync(root, { recursive: true });
  const routes = buildServeRoutes(deps).filter((route) => route.path === "/v1/products" || route.path === "/v1/products/research");
  assert.deepEqual(readdirSync(root, { recursive: true }), before, "assembling product routes creates no state");
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`).sort(), ["GET /v1/products", "POST /v1/products", "POST /v1/products/research"]);
  return routes;
}

async function server(t: TestContext, options: { mount?: boolean; missingRoot?: boolean; enforcement?: boolean; deps?: Partial<ServeDeps> } = {}) {
  const root = ownedFixtureDir(t, "product-http").dir;
  const log: unknown[] = [];
  const routes = options.mount ? assembled(root, options.deps) : buildProductRoutes({ root: options.missingRoot ? undefined : root });
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

test("W1-T10617: the served product research operation matches the authenticated API contract", async (t) => {
  const inputs: unknown[] = [];
  const productResearchProvider = { id: "fixture-research", async research(input: unknown) {
    inputs.push(input);
    return { summary: "Public map data covers Central Park.", spendUsd: 0, questions: [{ text: "Which zones are in scope?" }] };
  } };
  const app = await server(t, { mount: true });
  try {
    const saved = await request(app.url, "/v1/products", "alice", command);
    assert.ok(saved.body.receipt);
    const productId = saved.body.receipt.productId;
    const post = async (session: "alice" | "bob" | undefined, body: unknown, raw?: string) => {
      const result = await fetch(app.url + "/v1/products/research", { method: "POST",
        headers: { authorization: "Bearer fixture-write", ...(session ? { "x-test-session": session } : { "x-rmd-actor": "clerk:alice" }), "content-type": "application/json" },
        body: raw ?? JSON.stringify(body) });
      const reply = await result.json() as { error?: string; run?: { outcome: string; provider: string; executionAuthority: string; sources: unknown[] }; open?: { id: string }[]; accepted?: { questionId: string }[]; replayed?: boolean };
      assert.deepEqual(violations(reply, declaredBody("/v1/products/research", "POST", result.status)), [],
        "the real research HTTP response must match its declared contract");
      return { status: result.status, cache: result.headers.get("cache-control"), body: reply };
    };
    const body = { version: "product-research-v1", requestId: "research-http-0001", productId, expectedObjectiveRevision: 1,
      answers: [{ questionId: "q_audience", answer: "commuters" }] };
    assert.equal((await post(undefined, body)).status, 403, "an actor header or shared bearer is not a verified operator");
    const first = await post("alice", body);
    assert.equal(first.status, 200);
    assert.match(first.cache ?? "", /no-store/);
    assert.deepEqual([first.body.run?.outcome, first.body.run?.provider, first.body.run?.executionAuthority], ["unavailable", null, "none"],
      "the served default carries no configured provider, so it is unavailable rather than fabricated");
    assert.deepEqual(first.body.accepted?.map((item) => item.questionId), ["q_audience"]);
    assert.equal(first.body.run?.sources.length, 1);
    assert.equal(inputs.length, 0, "an unavailable run never reaches a provider");
    const replay = await post("alice", body);
    assert.deepEqual([replay.status, replay.body.replayed], [200, true]);
    assert.equal((await post("alice", { ...body, answers: [] })).status, 409);
    assert.equal((await post("alice", { ...body, requestId: "research-http-0002", expectedObjectiveRevision: 2 })).status, 409);
    assert.equal((await post("bob", { ...body, requestId: "research-http-0003" })).status, 404);
    assert.equal((await post("alice", { ...body, requestId: "research-http-0004", owner: "clerk:bob" })).status, 400);
    assert.equal((await post("alice", body, "{broken")).status, 400);
    assert.equal((await post("alice", { ...body, requestId: "research-http-0005", answers: [{ questionId: "q_audience", answer: "x".repeat(70_000) }] })).status, 413);
    const stored = await request(app.url, `/v1/products?id=${productId}`, "alice");
    assert.equal(stored.status, 200);
    assert.ok(!JSON.stringify(app.log).includes(command.brief.idea), "service diagnostics never log source idea text");
  } finally { await app.close(); }

  const configured = await server(t, { mount: true, deps: { productResearchProvider, productResearchBudgetUsd: 1 } });
  try {
    const saved = await request(configured.url, "/v1/products", "alice", command);
    assert.ok(saved.body.receipt);
    const result = await fetch(configured.url + "/v1/products/research", { method: "POST",
      headers: { "x-test-session": "alice", "content-type": "application/json" },
      body: JSON.stringify({ version: "product-research-v1", requestId: "research-http-0006", productId: saved.body.receipt.productId, expectedObjectiveRevision: 1 }) });
    const reply = await result.json() as { run: { outcome: string; provider: string } };
    assert.deepEqual(violations(reply, declaredBody("/v1/products/research", "POST", result.status)), []);
    assert.deepEqual([result.status, reply.run.outcome, reply.run.provider], [200, "completed", "fixture-research"]);
    assert.equal(inputs.length, 1);
  } finally { await configured.close(); }
});
