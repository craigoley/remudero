import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildProductRoutes } from "#src/lib/product-routes.js";
import { buildServeRoutes, type ServeDeps } from "#src/lib/serve.js";
import { createService, operatorSessionIdentityProvider, OPERATOR_SESSION_HEADER, type IdentityProvider } from "#src/lib/service.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { declaredBody, violations } from "#test/helpers/openapi-strict.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { productResearchServeDeps, serveCommand, DEFAULT_BUDGET_USD } from "#src/run-task.js";
import { loadMounts } from "#src/lib/mounts.js";
import { withLiveSpawnAllowed } from "#src/lib/spawn-guard.js";
import type { ProductResearchView } from "#src/lib/product-research.js";
import { productStatePaths } from "#src/lib/product-intent-store.js";
import { parseDocument } from "yaml";

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

async function server(t: TestContext, options: { root?: string; operatorSession?: IdentityProvider; mount?: boolean; missingRoot?: boolean; enforcement?: boolean; deps?: Partial<ServeDeps> } = {}) {
  const root = options.root ?? ownedFixtureDir(t, "product-http").dir;
  const log: unknown[] = [];
  const routes = options.mount ? assembled(root, options.deps) : buildProductRoutes({ root: options.missingRoot ? undefined : root });
  const instance = createService({ tokens: { read: "fixture-read", write: "fixture-write" }, operatorSession: options.operatorSession ?? identity,
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

function productionResearchFixture(t: TestContext) {
  const root = ownedFixtureDir(t, "product-transport").dir;
  mkdirSync(join(root, ".remudero"));
  const mounts = parseDocument(readFileSync(join(REPO_ROOT, ".remudero/mounts.yaml"), "utf8"));
  mounts.setIn(["synthesis", "triage", "provider"], "codex");
  writeFileSync(join(root, ".remudero/mounts.yaml"), String(mounts));
  const bin = join(root, "research-worker.cjs");
  const capture = join(root, "child.json");
  const response = join(root, "response.json");
  writeFileSync(response, JSON.stringify({ summary: "Fixture evidence: https://www.openstreetmap.org/copyright",
    spendUsd: 9999, questions: [{ text: "Which park zones are in scope?" }] }));
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2),
    prompt, home: process.env.HOME, tmp: process.env.TMPDIR }));
  const text = fs.readFileSync(${JSON.stringify(response)}, 'utf8');
  for (const event of [{ type: 'thread.started', thread_id: 'research-fixture' },
    { type: 'turn.started' }, { type: 'item.completed', item: { type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }]) {
    process.stdout.write(JSON.stringify(event) + '\\n');
  }
});
`, { mode: 0o700 });
  const config = { root, installRoot: REPO_ROOT, claudeBin: "/unused/claude",
    workerProviders: { enabled: ["codex" as const], codexBin: bin, codexModel: "gpt-6.1-sol", codexHome: join(root, "codex-home") } };
  const diagnostics: unknown[] = [];
  const deps = productResearchServeDeps(config, root, { log: (step, detail) => diagnostics.push({ step, detail }) });
  assert.ok(deps.productResearchProvider, JSON.stringify(diagnostics));
  assert.equal(deps.productResearchBudgetUsd, DEFAULT_BUDGET_USD);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "research-key", kty: "RSA" };
  const issuer = "https://research-identity.example";
  const origin = "https://research-console.example";
  const operatorSession = operatorSessionIdentityProvider({ issuer, allowedOrigins: [origin], operatorUserIds: ["alice", "bob"],
    keys: { key: async (kid) => kid === jwk.kid ? jwk : undefined } });
  const headers = (session?: string) => {
    const seconds = Math.floor(Date.now() / 1000);
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = `${b64({ alg: "RS256", kid: jwk.kid })}.${b64({ iss: issuer, azp: origin,
      sub: session, iat: seconds, exp: seconds + 60 })}`;
    return { authorization: "Bearer fixture-write", "content-type": "application/json",
      ...(session ? { [OPERATOR_SESSION_HEADER]: `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}` }
        : { "x-rmd-actor": "operator:alice" }) };
  };
  return { root, capture, response, config, deps, operatorSession, headers, jwk,
    operatorIdentity: { issuer, allowedOrigins: [origin], operatorUserIds: ["alice", "bob"] } };
}

async function productionServe(t: TestContext, fixture: ReturnType<typeof productionResearchFixture>) {
  const keys = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [fixture.jwk] })); });
  await new Promise<void>((resolve) => keys.listen(0, "127.0.0.1", resolve));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  mkdirSync(join(fixture.root, ".config", "remudero"), { recursive: true });
  writeFileSync(join(fixture.root, ".config", "remudero", "config.json"), JSON.stringify({ ...fixture.config,
    serve: { operatorIdentity: { ...fixture.operatorIdentity,
      jwksUrl: `http://127.0.0.1:${(keys.address() as AddressInfo).port}/jwks` } } }));
  const previousHome = process.env.HOME;
  const signals = new Map((["SIGINT", "SIGTERM"] as const).map((signal) => [signal, new Set(process.listeners(signal))]));
  process.env.HOME = fixture.root;
  let listening!: () => void;
  const ready = new Promise<void>((resolve) => { listening = resolve; });
  const output = t.mock.method(console, "log", (...parts: unknown[]) => { if (parts.join(" ").includes("listening on")) listening(); });
  const running = serveCommand(["--host", "127.0.0.1", "--port", String(port)], {
    branch: () => "main", buildBatchedGithub: () => fakeGitHub(), loadBoardPlan: () => ({ tasks: [], byId: new Map() }),
    buildInitialBoardSnapshot: () => {}, loadMounts: () => loadMounts(join(fixture.root, ".remudero/mounts.yaml")),
  });
  const close = async () => {
    try {
      process.emit("SIGTERM");
      assert.equal(await running, 0);
    } finally {
      output.mock.restore();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      for (const [signal, original] of signals) for (const listener of process.listeners(signal)) {
        if (!original.has(listener)) process.removeListener(signal, listener);
      }
      await new Promise<void>((resolve) => keys.close(() => resolve()));
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // BACKSTOP: a broken boot must fail this disposable HTTP fixture rather than hold the test process.
    await Promise.race([ready, running.then((code) => { throw new Error(`serve exited before bind: ${code}`); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("serve did not bind")), 10_000); })]);
    const tokens = JSON.parse(readFileSync(join(fixture.root, "state/service-tokens.json"), "utf8"));
    return { url: `http://127.0.0.1:${port}`, close,
      headers: (session?: string) => ({ ...fixture.headers(session), authorization: `Bearer ${tokens.write}` }) };
  } catch (error) { await close(); throw error; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

test("W1-T10617: the served product route invokes the production capability through a real transport process", async (t) => {
  const fixture = productionResearchFixture(t);
  const app = await productionServe(t, fixture);
  try {
    const created = await fetch(app.url + "/v1/products", { method: "POST", headers: app.headers("alice"), body: JSON.stringify(command) });
    assert.equal(created.status, 200);
    const saved = await created.json() as Reply;
    assert.ok(saved.receipt);
    const body = { version: "product-research-v1", requestId: "real-transport-0001",
      productId: saved.receipt.productId, expectedObjectiveRevision: 1,
      answers: [{ questionId: "q_audience", answer: "commuters" }] };
    const post = async (session?: string) => {
      const result = await fetch(app.url + "/v1/products/research", { method: "POST",
        headers: app.headers(session), body: JSON.stringify(body) });
      const reply = await result.json() as ProductResearchView;
      assert.deepEqual(violations(reply, declaredBody("/v1/products/research", "POST", result.status)), []);
      return { status: result.status, reply };
    };
    assert.equal((await post()).status, 403);
    assert.equal(existsSync(fixture.capture), false, "client-claimed identity cannot invoke the executable");
    assert.equal((await post("bob")).status, 404);
    assert.equal(existsSync(fixture.capture), false, "another verified actor cannot research Alice's product");
    const result = await withLiveSpawnAllowed(() => post("alice"));
    assert.equal(result.status, 200);
    assert.equal(result.reply.run?.outcome, "completed");
    assert.equal(result.reply.run?.provider, "triage:sonnet");
    assert.equal(result.reply.run?.budgetUsd, DEFAULT_BUDGET_USD);
    assert.equal(result.reply.run?.spendUsd, 0, "model-authored spending is replaced by the worker receipt");
    assert.equal(result.reply.run?.summary, "Fixture evidence: https://www.openstreetmap.org/copyright");
    assert.deepEqual(result.reply.run?.sources, command.brief.research.map((source) => ({ ...source, disposition: "data" })));
    const child = JSON.parse(readFileSync(fixture.capture, "utf8"));
    assert.notEqual(child.pid, process.pid, "the default transport crossed an actual process boundary");
    assert.equal(child.argv[child.argv.indexOf("--sandbox") + 1], "read-only");
    assert.ok(child.argv.includes("gpt-6.1-sol"));
    assert.ok(child.prompt.includes(JSON.stringify({ objective: command.brief.objective, objectiveRevision: 1,
      sources: command.brief.research })));
    assert.match(child.prompt, /<untrusted_external_data source="feedback-entry"/);
    assert.notEqual(child.home, process.env.HOME);
    assert.equal(existsSync(child.home), false, "the worker home is reaped after the process settles");
    assert.equal(existsSync(child.tmp), false, "the transport's private temp directory is reaped");
    const ledger = readFileSync(join(fixture.root, "state/ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(ledger.some((row) => row.step === "worker.assignment" && row.lane === "product-research"));
    assert.ok(ledger.some((row) => row.step === "worker.attempt" && row.success === true));
    const paths = productStatePaths(fixture.root, "operator:alice");
    const stored = JSON.parse(readFileSync(join(paths.directory, "research", `${paths.ownerKey}.json`), "utf8"));
    assert.equal(Object.keys(stored.receipts).length, 1);
    assert.deepEqual(stored.products[body.productId].runs, [result.reply.run]);
    assert.deepEqual(result.reply.accepted.map((answer) => answer.questionId), ["q_audience"]);
    const replay = await post("alice");
    assert.equal(replay.reply.replayed, true);
    assert.ok(!replay.reply.open.some((question) => question.id === "q_audience"));
    assert.deepEqual(JSON.parse(readFileSync(fixture.capture, "utf8")), child, "replay never spawns a second process");
  } finally { await app.close(); }
});

test("product research production resolution is unavailable and malformed transport output fails durably", async (t) => {
  const fixture = productionResearchFixture(t);
  const unavailable = productResearchServeDeps(fixture.config, join(fixture.root, "missing"), { log: () => {} });
  assert.equal(unavailable.productResearchProvider, undefined);
  const app = await server(t, { root: fixture.root, operatorSession: fixture.operatorSession, mount: true, deps: fixture.deps });
  try {
    writeFileSync(fixture.response, "not a research report");
    const created = await fetch(app.url + "/v1/products", { method: "POST", headers: fixture.headers("alice"), body: JSON.stringify(command) });
    const saved = await created.json() as Reply;
    assert.ok(saved.receipt);
    const result = await withLiveSpawnAllowed(() => fetch(app.url + "/v1/products/research", { method: "POST",
      headers: fixture.headers("alice"),
      body: JSON.stringify({ version: "product-research-v1", requestId: "real-transport-0002",
        productId: saved.receipt!.productId, expectedObjectiveRevision: 1 }) }));
    const reply = await result.json() as ProductResearchView;
    assert.deepEqual(violations(reply, declaredBody("/v1/products/research", "POST", result.status)), []);
    assert.deepEqual([reply.run?.outcome, reply.run?.failure, reply.run?.summary], ["failed", "provider_error", undefined]);
    fixture.config.workerProviders.codexBin = join(fixture.root, "missing-worker");
    const another = await fetch(app.url + "/v1/products", { method: "POST", headers: fixture.headers("alice"),
      body: JSON.stringify({ ...command, requestId: "missing-transport-product-0001" }) });
    const createdAgain = await another.json() as Reply;
    assert.ok(createdAgain.receipt);
    const unavailable = await withLiveSpawnAllowed(() => fetch(app.url + "/v1/products/research", { method: "POST",
      headers: fixture.headers("alice"), body: JSON.stringify({ version: "product-research-v1", requestId: "missing-transport-0001",
        productId: createdAgain.receipt!.productId, expectedObjectiveRevision: 1 }) }));
    const unavailableBody = await unavailable.json() as ProductResearchView;
    assert.deepEqual(violations(unavailableBody, declaredBody("/v1/products/research", "POST", unavailable.status)), []);
    assert.deepEqual([unavailableBody.run?.outcome, unavailableBody.run?.summary], ["unavailable", undefined]);
  } finally { await app.close(); }
});
