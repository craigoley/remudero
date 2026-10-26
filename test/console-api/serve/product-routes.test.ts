import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildProductRoutes } from "#src/lib/product-routes.js";
import { buildServeRoutes, type ServeDeps } from "#src/lib/serve.js";
import { createService, OPERATOR_SESSION_HEADER, type IdentityProvider } from "#src/lib/service.js";
import { resolveServeProductResearch, serveCommand, DEFAULT_BUDGET_USD } from "#src/run-task.js";
import { loadMounts } from "#src/lib/mounts.js";
import { withLiveSpawnAllowed } from "#src/lib/spawn-guard.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { declaredBody, violations } from "#test/helpers/openapi-strict.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

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

function assembledDeps(root: string, extra: Partial<ServeDeps> = {}): ServeDeps {
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const ledgerPath = join(root, "state/ledger.ndjson");
  const planPath = join(root, "plan/tasks.yaml");
  writeFileSync(ledgerPath, "");
  writeFileSync(planPath, "[]\n");
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: fakeGitHub(),
      ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath, issues: { close: () => {} }, fleetControlRoot: root, questionsRoot: root,
    tokens: { read: "fixture-read", write: "fixture-write" },
    ...extra,
  };
}

function assembled(root: string, extra: Partial<ServeDeps> = {}) {
  const deps = assembledDeps(root, extra);
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

test("W1-T10617: the served product route invokes the production capability through a contained process", async (t) => {
  const root = ownedFixtureDir(t, "product-transport-http").dir;
  const cwd = join(root, "checkout"), witness = join(root, "transport.json"), mode = join(root, "mode");
  mkdirSync(join(cwd, ".remudero"), { recursive: true });
  const mounts = readFileSync(join(REPO_ROOT, ".remudero/mounts.yaml"), "utf8")
    .replace(/triage:      \{[^\n]+/, "triage:      { model: sonnet, effort: low, max_turns: 2, context_budget: 180000, provider: codex }");
  writeFileSync(join(cwd, ".remudero/mounts.yaml"), mounts);
  const bin = join(root, "codex-fixture");
  writeFileSync(mode, "success");
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(witness)}, JSON.stringify({ prompt, pid: process.pid,
    argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME,
    apiKeyPresent: !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) }));
  const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8');
  if (mode === 'exit') process.exit(7);
  const text = mode === 'invalid' ? 'not json' : JSON.stringify({
    summary: 'Fixture source receipt: Central Park map attribution requires credit.',
    spendUsd: 99999, questions: [{ text: 'Which park zones are in scope?' }], provider: 'unapproved' });
  for (const event of [ { type: 'thread.started', thread_id: 'research-fixture' },
    { type: 'item.completed', item: { type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } } ]) {
    process.stdout.write(JSON.stringify(event) + '\\n');
  }
});
`, { mode: 0o700 });
  const config = { root, installRoot: REPO_ROOT, claudeBin: "/unused/claude",
    workerProviders: { enabled: ["codex" as const], codexBin: bin, codexModel: "gpt-6.1-sol", codexHome: join(root, "empty-auth") } };
  const diagnostics: unknown[] = [];
  const runtime = resolveServeProductResearch(config, cwd, (step, fields) => diagnostics.push({ step, ...fields }));
  assert.ok(runtime.productResearchProvider, JSON.stringify(diagnostics));
  assert.equal(runtime.productResearchBudgetUsd, DEFAULT_BUDGET_USD, "reuse triage's per-call ceiling");
  const origin = "https://product-console.example";
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "product", alg: "RS256", use: "sig" };
  const jwks = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>(resolve => jwks.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => jwks.close(error => error ? reject(error) : resolve())));
  const issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT", kid: "product" })}.${encode({
    iss: issuer, azp: origin, sub: "research-operator", iat: now, nbf: now, exp: now + 300, fva: [120, -1] })}`;
  const session = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), keys.privateKey).toString("base64url")}`;
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const home = join(root, "operator-home");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ ...config,
    serve: { host: "127.0.0.1", port, operatorIdentity: { issuer, allowedOrigins: [origin], operatorUserIds: ["research-operator"] } } }));
  const savedEnv = { HOME: process.env.HOME, RMD_SERVE_HOST: process.env.RMD_SERVE_HOST };
  process.env.HOME = home;
  process.env.RMD_SERVE_HOST = "127.0.0.1";
  t.after(() => { for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const priorSignals = new Map((["SIGINT", "SIGTERM"] as const).map(signal => [signal, new Set(process.listeners(signal))]));
  let ready!: () => void;
  const listening = new Promise<void>(resolve => { ready = resolve; });
  t.mock.method(console, "log", (...parts: unknown[]) => { if (parts.join(" ").includes("listening on")) ready(); });
  const running = serveCommand([], { branch: () => "main",
    loadMounts: () => loadMounts(join(cwd, ".remudero/mounts.yaml")),
    loadBoardPlan: () => ({ tasks: [], byId: new Map() }), buildInitialBoardSnapshot: () => {},
    buildBatchedGithub: () => fakeGitHub({ listMergedHeadBranches: () => [], listOpenHeadBranches: () => [] }),
  });
  const base = `http://127.0.0.1:${port}`;
  let writeToken: string;
  const post = async (path: string, body: unknown, token: string | undefined = session) => {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json",
      authorization: `Bearer ${writeToken}`, "x-rmd-actor": "operator:research-operator",
      ...(token ? { [OPERATOR_SESSION_HEADER]: token } : {}) }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.deepEqual(violations(value, declaredBody(path, "POST", response.status)), []);
    return { status: response.status, value };
  };
  try {
    await Promise.race([listening, running.then(code => { throw new Error(`serve exited before listening: ${code}`); })]);
    writeToken = JSON.parse(readFileSync(join(root, "state/service-tokens.json"), "utf8")).write;
    const saved = await post("/v1/products", command);
    assert.equal(saved.status, 200);
    const body = { version: "product-research-v1", requestId: "real-transport-0001",
      productId: saved.value.receipt.productId, expectedObjectiveRevision: 1 };
    assert.equal((await post("/v1/products/research", body, "")).status, 403);
    assert.equal((await post("/v1/products/research", body, session + "tampered")).status, 403);
    assert.equal(existsSync(witness), false, "unverified callers cannot start the real adapter");
    // The only executable admitted by this fixture is its private JSONL emitter; no provider call is injected.
    const run = await withLiveSpawnAllowed(() => post("/v1/products/research", body));
    assert.equal(run.status, 200);
    assert.deepEqual([run.value.run.outcome, run.value.run.provider, run.value.run.spendUsd], ["completed", "triage:sonnet", 0]);
    assert.match(run.value.run.summary, /Fixture source receipt/);
    assert.deepEqual(run.value.run.sources, [{ ...command.brief.research[0], disposition: "data" }]);
    const observed = JSON.parse(readFileSync(witness, "utf8"));
    assert.notEqual(observed.pid, process.pid, "research crossed the real transport process boundary");
    assert.throws(() => process.kill(observed.pid, 0), /ESRCH/, "the default transport reaped its child");
    assert.equal(observed.cwd, REPO_ROOT);
    assert.notEqual(observed.home, process.env.HOME);
    assert.equal(observed.apiKeyPresent, false);
    assert.ok(observed.argv.includes("read-only"), "the existing intake tools are narrowed to read-only research");
    assert.ok(observed.argv.includes("gpt-6.1-sol"));
    assert.ok(observed.prompt.includes(command.brief.objective));
    assert.ok(observed.prompt.includes(command.brief.research[0].url));
    assert.ok(observed.prompt.includes("UNTRUSTED EXTERNAL CONTENT"));
    const rows = readFileSync(join(root, "state/ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const assignment = rows.find(row => row.step === "worker.assignment" && row.run_id === run.value.run.id);
    const attempt = rows.find(row => row.step === "worker.attempt" && row.run_id === run.value.run.id);
    assert.equal(assignment.worker_assignment.selected.provider, "codex");
    assert.equal(attempt.selection_assignment_id, assignment.worker_assignment.id);
    assert.equal(attempt.success, true);
    assert.equal((await post("/v1/products/research", body)).value.replayed, true);
    assert.equal(readFileSync(witness, "utf8"), JSON.stringify(observed), "a replay starts no second transport");
    for (const [failureMode, failure] of [["invalid", "invalid_output"], ["exit", "provider_error"]]) {
      writeFileSync(mode, failureMode);
      const next = await post("/v1/products", { ...command, requestId: `create-${failureMode}-transport` });
      const result = await withLiveSpawnAllowed(() => post("/v1/products/research", {
        ...body, requestId: `research-${failureMode}-transport`, productId: next.value.receipt.productId }));
      assert.equal(result.status, 200);
      assert.equal(result.value.run.outcome, "failed");
      assert.equal(result.value.run.failure, failure);
      assert.equal(result.value.run.summary, undefined);
    }
  } finally {
    process.emit("SIGTERM");
    assert.equal(await running, 0);
    for (const [signal, before] of priorSignals) for (const listener of process.listeners(signal)) {
      if (!before.has(listener)) process.removeListener(signal, listener);
    }
  }
  assert.deepEqual(resolveServeProductResearch(config, join(root, "missing-checkout"), () => {}), {});
  assert.deepEqual(resolveServeProductResearch({ ...config, workerProviders: { enabled: ["claude"] } }, cwd, () => {}), {});
});
