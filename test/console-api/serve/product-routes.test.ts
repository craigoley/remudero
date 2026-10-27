import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { buildProductRoutes } from "#src/lib/product-routes.js";
import { realProductResearchProvider } from "#src/lib/product-research.js";
import type { Config } from "#src/lib/config.js";
import { CLAUDE_BIN_ENV_OVERRIDE, createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs } from "#src/lib/worker.js";
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

function assembled(root: string, extra: Partial<ServeDeps> = {}, prefix = "/v1/products") {
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
  const routes = buildServeRoutes(deps).filter((route) => route.path === prefix || (prefix === "/v1/products" && route.path === "/v1/products/research"));
  assert.deepEqual(readdirSync(root, { recursive: true }), before, "assembling product routes creates no state");
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`).sort(),
    prefix === "/v1/products" ? ["GET /v1/products", "POST /v1/products", "POST /v1/products/research"]
      : [`${prefix.endsWith("-preview") ? "GET" : "POST"} ${prefix}`]);
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

test("W1-T10617: the assembled HTTP research route invokes the production worker adapter across a process boundary", async (t) => {
  const fixture = ownedFixtureDir(t, "research-worker-process").dir;
  const worker = join(fixture, "research-worker.cjs");
  const output = join(fixture, "worker-output.json");
  const settingsFile = join(fixture, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
  writeFileSync(worker, `
const { writeFileSync } = require('node:fs');
const input = JSON.parse(process.argv[2]);
if (!input.prompt.includes('Objective revision: 1') || input.tools.join(',') !== 'WebSearch') process.exit(2);
const contextLine = input.prompt.split('\\n').find(line => line.startsWith('Objective and source data: '));
const context = JSON.parse(contextLine.slice('Objective and source data: '.length));
if (!context.acceptedAnswers.some(answer => answer.questionId === 'q_audience' && answer.answer === 'commuters')) process.exit(3);
writeFileSync(process.argv[3], JSON.stringify({ summary: 'A source-backed skirmish needs zone boundaries.', questions: [{ text: 'Which park zones are in scope?' }] }));
`);
  let calls = 0;
  let toolchainReady = false;
  let queries = 0;
  const provider = realProductResearchProvider({
    mount: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1000, provider: "claude" },
    config: { root: fixture } as Config, cwd: fixture, settingsFile,
    spawn: (async (args) => {
      calls++;
      assert.equal(args.mountProvider, "claude");
      assert.equal(args.maxBudgetUsd, 1);
      assert.ok(args.signal, "the route's deadline reaches the worker transport");
      const queryFn = ((params: { options: { env: Record<string, string>; spawnClaudeCodeProcess?: (opts: unknown) => unknown } }) => {
        queries++;
        // Exercise spawnWorker's real contained child hook; only the SDK stream is a fixture.
        params.options.spawnClaudeCodeProcess?.({ command: process.execPath,
          args: [worker, JSON.stringify({ prompt: args.prompt, tools: args.tools }), output],
          env: params.options.env, signal: new AbortController().signal });
        return (async function* () {
          const deadline = Date.now() + 5_000;
          while (!existsSync(output) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
          assert.ok(existsSync(output), "the contained worker child produced its fixture output");
          yield { type: "result", subtype: "success", is_error: false, result: readFileSync(output, "utf8"),
            session_id: "research-process-fixture", total_cost_usd: 0.02, num_turns: 1 };
        })();
      }) as unknown as NonNullable<SpawnWorkerArgs["queryFn"]>;
      return spawnWorker({ ...args, queryFn,
        claudeExecutable: { cache: createClaudeExecutableCache(), deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" },
          home: fixture, exists: () => toolchainReady, which: () => undefined, canExecute: () => true, locations: [] } },
        keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }) },
      });
    }) as typeof import("#src/lib/worker.js").spawnWorker,
  });
  const app = await server(t, { mount: true, deps: { productResearchProvider: provider, productResearchBudgetUsd: 1 } });
  try {
    const saved = await request(app.url, "/v1/products", "alice", command);
    assert.ok(saved.body.receipt);
    const body = { version: "product-research-v1", requestId: "research-process-0001",
      productId: saved.body.receipt.productId, expectedObjectiveRevision: 1,
      answers: [{ questionId: "q_audience", answer: "commuters" }] };
    const post = async (session?: "alice", submitted = body) => fetch(`${app.url}/v1/products/research`, {
      method: "POST", headers: { authorization: "Bearer fixture-write", "content-type": "application/json", ...(session ? { "x-test-session": session } : { "x-rmd-actor": "clerk:alice" }) },
      body: JSON.stringify(submitted),
    });
    const refused = await post();
    assert.equal(refused.status, 403);
    assert.equal(calls, 0, "an unverified actor cannot start the transport");
    const invalid = await post("alice", { ...body, answers: [...body.answers, { questionId: "q_nonexistent", answer: "x" }] });
    assert.equal(invalid.status, 400);
    assert.deepEqual(violations(await invalid.json(), declaredBody("/v1/products/research", "POST", 400)), []);
    assert.equal(calls, 0, "an invalid first research request cannot start the real transport");
    assert.equal(existsSync(output), false, "question validation precedes the transport process boundary");
    const blocked = await post("alice");
    const blockedReply = await blocked.json() as { run: { id: string; outcome: string; failure?: string; summary?: string; spendUsd: number };
      replayed: boolean; accepted: { questionId: string; answer: string }[] };
    assert.equal(blocked.status, 200);
    assert.deepEqual(violations(blockedReply, declaredBody("/v1/products/research", "POST", 200)), []);
    assert.deepEqual([blockedReply.run.outcome, blockedReply.run.failure, blockedReply.run.summary, blockedReply.run.spendUsd],
      ["unavailable", undefined, undefined, 0], "a pre-invocation toolchain refusal remains recoverable");
    assert.equal(calls, 1);
    assert.equal(queries, 0, "the real toolchain preflight refuses before invoking the SDK");
    assert.equal(existsSync(output), false, "a blocked toolchain starts no research child");
    assert.deepEqual(blockedReply.accepted.map((item) => [item.questionId, item.answer]), [["q_audience", "commuters"]]);
    toolchainReady = true;
    const blockedReplay = await post("alice");
    const replayedBlock = await blockedReplay.json() as typeof blockedReply;
    assert.equal(blockedReplay.status, 200);
    assert.equal(replayedBlock.replayed, true);
    assert.deepEqual(replayedBlock.run, blockedReply.run, "restoring capability preserves the original unavailable receipt");
    assert.equal(calls, 1, "replaying a refused request never starts a worker");
    const resumedBody = { ...body, requestId: "research-process-0002", answers: [] };
    const response = await post("alice", resumedBody);
    const reply = await response.json() as { run: { id: string; outcome: string; provider: string; spendUsd: number }; replayed: boolean; accepted: { questionId: string; answer: string }[] };
    assert.equal(response.status, 200);
    assert.deepEqual(violations(reply, declaredBody("/v1/products/research", "POST", 200)), []);
    assert.deepEqual([reply.run.outcome, reply.run.provider, reply.run.spendUsd], ["completed", "claude:haiku", 0.02]);
    assert.deepEqual(reply.accepted.map((item) => [item.questionId, item.answer]), [["q_audience", "commuters"]]);
    assert.notEqual(reply.run.id, blockedReply.run.id);
    assert.equal(calls, 2, "a new request resumes the same objective after capability restoration");
    assert.equal(queries, 1);
    const receipts = () => readFileSync(join(fixture, "state", "ledger.ndjson"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { step: string; lane?: string; run_id: string; task_id: string;
        worker_assignment?: { id: string; requested: { model: string }; selected: { provider: string; model: string } };
        selection_assignment_id?: string; success?: boolean;
        benchmark_run?: { assignmentJoin?: { state: string; value?: boolean } } })
      .filter((row) => row.lane === "serve-product-research");
    const allRows = receipts();
    const blockedRows = allRows.filter((row) => row.run_id === blockedReply.run.id);
    assert.deepEqual(blockedRows.map((row) => row.step), ["worker.attempt"],
      "the pre-invocation refusal retains a terminal receipt without an execution assignment");
    assert.equal(blockedRows[0].success, false);
    const rows = allRows.filter((row) => row.run_id === reply.run.id);
    assert.deepEqual(rows.map((row) => row.step), ["worker.assignment", "worker.attempt"],
      "the real worker writes exactly one assignment and one terminal receipt");
    assert.ok(rows[0].worker_assignment?.id);
    assert.equal(rows[0].worker_assignment.selected.provider, "claude");
    assert.equal(rows[0].worker_assignment.requested.model, "haiku");
    assert.ok(rows[0].worker_assignment.selected.model);
    assert.equal(rows[1].selection_assignment_id, rows[0].worker_assignment.id);
    assert.deepEqual(rows[1].benchmark_run?.assignmentJoin, { state: "observed", value: true });
    assert.equal(rows[1].success, true);
    assert.ok(rows.every((row) => row.run_id === reply.run.id && row.task_id === "PRODUCT-RESEARCH"));
    const retry = await post("alice", resumedBody);
    assert.equal((await retry.json() as { replayed: boolean }).replayed, true);
    assert.equal(calls, 2, "a durable receipt does not start another worker");
    assert.deepEqual(receipts(), allRows, "replaying research never duplicates worker receipts");
  } finally { await app.close(); }
});

test("research with no admitted per-call budget is explicitly unavailable without a worker", async (t) => {
  const provider = realProductResearchProvider({
    mount: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1000, provider: "claude" },
    config: { root: "/unused" } as Config, cwd: "/unused", settingsFile: "/unused/settings.json",
    spawn: (async () => assert.fail("no budget must not start a worker")) as typeof import("#src/lib/worker.js").spawnWorker,
  });
  const app = await server(t, { mount: true, deps: { productResearchProvider: provider, productResearchBudgetUsd: 0 } });
  try {
    const saved = await request(app.url, "/v1/products", "alice", command);
    assert.ok(saved.body.receipt);
    const response = await fetch(`${app.url}/v1/products/research`, { method: "POST",
      headers: { "x-test-session": "alice", "content-type": "application/json" },
      body: JSON.stringify({ version: "product-research-v1", requestId: "research-zero-budget-0001",
        productId: saved.body.receipt.productId, expectedObjectiveRevision: 1 }) });
    const reply = await response.json() as { run: { outcome: string; summary?: string } };
    assert.equal(response.status, 200);
    assert.deepEqual(violations(reply, declaredBody("/v1/products/research", "POST", 200)), []);
    assert.equal(reply.run.outcome, "unavailable");
    assert.equal(reply.run.summary, undefined);
  } finally { await app.close(); }
});

const WRECKTERRA_ID = 1432832754;
const adopt = (productId: string, over: Record<string, unknown> = {}) => ({ version: "product-repository-v1", requestId: "route-adopt-000001",
  productId, expectedRevision: 1, expectedObjectiveRevision: 1,
  action: "adopt", owner: "craigoley", name: "wreckterra", visibility: "public", repositoryId: WRECKTERRA_ID, ...over });

test("W1-T10613: the served product repository operation matches the authenticated API contract", async (t) => {
  assert.notDeepEqual(violations("ab", { type: "string", minLength: 3 }), [], "the contract validator must enforce minLength");
  assert.notDeepEqual(violations("abcd", { type: "string", maxLength: 3 }), [], "the contract validator must enforce maxLength");
  assert.deepEqual(violations("a😀b", { type: "string", minLength: 3, maxLength: 3 }), [], "string lengths count Unicode code points");
  const shim = ghShim([{ when: "api repos/craigoley/wreckterra", stdout: JSON.stringify({ id: WRECKTERRA_ID, name: "wreckterra",
    owner: { login: "craigoley" }, private: false, default_branch: "main" }) }]);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const root = ownedFixtureDir(t, "product-repository-http").dir;
  const products = assembled(root);
  const mounted = assembled(root, {}, "/v1/products/repository");
  assert.equal(mounted[0]?.tier, "high", "creating a repository is a high-tier action");
  assert.equal(mounted[0]?.scope, "write");
  const instance = createService({ tokens: { read: "fixture-read", write: "fixture-write" }, operatorSession: identity, routes: [...products, ...mounted] });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
  const send = async (session: "alice" | "bob" | undefined, body: unknown, raw?: string) => {
    const result = await fetch(`${base}/v1/products/repository`, { method: "POST", headers: { authorization: "Bearer fixture-write",
      "content-type": "application/json", ...(session ? { "x-test-session": session } : {}) }, body: raw ?? JSON.stringify(body) });
    const reply = await result.json() as { version: string; error?: string; replayed?: boolean; receipt?: { outcome: string; repository: { id: number } } };
    assert.deepEqual(violations(reply, declaredBody("/v1/products/repository", "POST", result.status)), [],
      `the real repository response (${result.status}) must match its declared contract`);
    assert.match(result.headers.get("cache-control") ?? "", /no-store/);
    return { status: result.status, body: reply };
  };
  try {
    const saved = await request(base, "/v1/products", "alice", command);
    const productId = saved.body.receipt!.productId;
    assert.equal((await send(undefined, adopt(productId))).status, 403);
    const adopted = await send("alice", adopt(productId));
    assert.equal(adopted.status, 200);
    assert.equal(adopted.body.receipt?.outcome, "adopted");
    assert.equal(adopted.body.receipt?.repository.id, WRECKTERRA_ID);
    assert.equal(adopted.body.replayed, false);
    assert.equal((await send("alice", adopt(productId))).body.replayed, true);
    assert.ok(!shim.calls().some((call) => call.includes("-X POST")), "adoption makes no create call over the real transport");
    assert.equal((await send("bob", adopt(productId))).status, 404);
    assert.equal((await send("alice", adopt(productId, { requestId: "route-adopt-000002", repositoryId: 7 }))).status, 409);
    assert.equal((await send("alice", adopt(productId, { visibility: "private" }))).status, 409);
    assert.equal((await send("alice", adopt(productId, { owner: "someone" }))).status, 409);
    assert.equal((await send("alice", { ...adopt(productId), extra: true })).status, 400);
    assert.equal((await send("alice", undefined, "{broken")).status, 400);
    assert.equal((await send("alice", undefined, JSON.stringify({ padding: "x".repeat(5000) }))).status, 413);
  } finally { await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve())); }
});

test("W1-T10726: served preview matches the public product contract", async (t) => {
  const shim = ghShim([
    { when: "api repos/craigoley/wreckterra", stdout: JSON.stringify({ id: WRECKTERRA_ID, name: "wreckterra",
      owner: { login: "craigoley" }, private: false, default_branch: "main" }) },
    { when: "api repos/craigoley/fresh", stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: "api user/memberships/orgs/", stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: "api user", stdout: JSON.stringify({ login: "craigoley" }) },
  ]);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const root = ownedFixtureDir(t, "product-preview-http").dir;
  const products = assembled(root);
  const preview = assembled(root, {}, "/v1/products/repository-preview");
  assert.equal(preview[0]?.scope, "read", "a preview is a read");
  assert.equal(preview[0]?.sensitivity, "sensitive");
  const instance = createService({ tokens: { read: "fixture-read", write: "fixture-write" }, operatorSession: identity, routes: [...products, ...preview] });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
  const get = async (session: "alice" | "bob" | undefined, query: string) => {
    const result = await fetch(`${base}/v1/products/repository-preview${query}`, { headers: { authorization: "Bearer fixture-read",
      ...(session ? { "x-test-session": session } : {}) } });
    const reply = await result.json() as { version: string; error?: string; state?: string; reasons?: string[]; repository?: { id: number } | null; creation?: string };
    assert.deepEqual(violations(reply, declaredBody("/v1/products/repository-preview", "GET", result.status)), [],
      `the real preview response (${result.status}) must match its declared contract`);
    assert.match(result.headers.get("cache-control") ?? "", /no-store/);
    return { status: result.status, body: reply };
  };
  try {
    const saved = await request(base, "/v1/products", "alice", command);
    const id = saved.body.receipt!.productId;
    const q = (over: Record<string, string> = {}) => "?" + new URLSearchParams({ id, action: "adopt", owner: "craigoley", name: "wreckterra", ...over });
    const before = readdirSync(root, { recursive: true }).sort();
    assert.equal((await get(undefined, q())).status, 403);
    const ready = await get("alice", q({ expectedRevision: "1", expectedObjectiveRevision: "1" }));
    assert.equal(ready.status, 200);
    assert.equal(ready.body.state, "ready");
    assert.equal(ready.body.repository?.id, WRECKTERRA_ID);
    assert.equal(ready.body.creation, "user");
    const stale = await get("alice", q({ expectedRevision: "9" }));
    assert.equal(stale.body.state, "stale");
    const mismatch = await get("alice", q({ owner: "someone" }));
    assert.equal(mismatch.body.state, "conflict");
    assert.equal((await get("alice", q({ action: "create" }))).body.state, "conflict", "creating over an existing repository conflicts");
    assert.equal((await get("bob", q())).status, 404);
    assert.equal((await get("alice", "?id=" + id)).status, 400);
    assert.equal((await get("alice", q() + "&owner=other")).status, 400, "a duplicate key is refused");
    assert.equal((await get("alice", q() + "&extra=1")).status, 400);
    assert.equal((await get("alice", q({ action: "nope" }))).status, 400);
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before, "preview creates no product or journal state");
    assert.ok(!shim.calls().some((call) => call.includes("-X POST")), "preview makes no create call over the real transport");
  } finally { await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve())); }
});

const TEAM_ID = "team_oleyarcade";
const deploy = (productId: string, over: Record<string, unknown> = {}) => ({ version: "product-deployment-v1", requestId: "route-deploy-000001",
  productId, action: "create", teamId: TEAM_ID, projectName: "wreckterra", repository: { id: WRECKTERRA_ID, owner: "craigoley", name: "wreckterra" },
  expectedRevision: 2, expectedObjectiveRevision: 1, ...over });

test("W1-T10616: the served product deployment operation matches the authenticated API contract", async (t) => {
  const provider = new Map<string, unknown>();
  const posts: string[] = [];
  const vercel = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const name = /\/v9\/projects\/([^?]+)/.exec(req.url ?? "")?.[1];
      if (req.headers.authorization !== "Bearer tok_route" || !(req.url ?? "").includes(`teamId=${TEAM_ID}`)) { res.writeHead(403); res.end("{}"); return; }
      if (req.method === "POST") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name: string };
        posts.push(body.name);
        provider.set(body.name, { id: "prj_route", name: body.name, accountId: TEAM_ID, link: { type: "github", org: "craigoley", repo: "wreckterra", repoId: WRECKTERRA_ID } });
        res.writeHead(200); res.end("{}");
        return;
      }
      const found = name ? provider.get(name) : undefined;
      res.writeHead(found ? 200 : 404); res.end(JSON.stringify(found ?? {}));
    });
  });
  await new Promise<void>((resolve) => vercel.listen(0, "127.0.0.1", resolve));
  const saved = { token: process.env.VERCEL_TOKEN, team: process.env.VERCEL_TEAM_ID, url: process.env.VERCEL_API_URL };
  process.env.VERCEL_TOKEN = "tok_route";
  process.env.VERCEL_TEAM_ID = TEAM_ID;
  process.env.VERCEL_API_URL = `http://127.0.0.1:${(vercel.address() as AddressInfo).port}`;
  const root = ownedFixtureDir(t, "product-deployment-http").dir;
  const products = assembled(root);
  const mounted = assembled(root, {}, "/v1/products/deployment");
  assert.equal(mounted[0]?.scope, "write");
  assert.equal(mounted[0]?.tier, "middle", "binding a project is middle tier: it never deploys or spends");
  const instance = createService({ tokens: { read: "fixture-read", write: "fixture-write" }, operatorSession: identity, routes: [...products, ...mounted] });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
  t.after(async () => {
    for (const [key, value] of [["VERCEL_TOKEN", saved.token], ["VERCEL_TEAM_ID", saved.team], ["VERCEL_API_URL", saved.url]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve) => { vercel.close(() => resolve()); vercel.closeAllConnections(); });
  });
  const send = async (session: "alice" | "bob" | undefined, body: unknown, raw?: string) => {
    const result = await fetch(`${base}/v1/products/deployment`, { method: "POST", headers: { authorization: "Bearer fixture-write",
      "content-type": "application/json", ...(session ? { "x-test-session": session } : {}) }, body: raw ?? JSON.stringify(body) });
    const reply = await result.json() as { version: string; error?: string; replayed?: boolean;
      receipt?: { outcome: string; deployed: boolean; playable: boolean; project: { id: string } } };
    assert.deepEqual(violations(reply, declaredBody("/v1/products/deployment", "POST", result.status)), [],
      `the real deployment response (${result.status}) must match its declared contract`);
    assert.match(result.headers.get("cache-control") ?? "", /no-store/);
    return { status: result.status, body: reply };
  };
  const created = await request(base, "/v1/products", "alice", command);
  const productId = created.body.receipt!.productId;
  assert.equal((await send(undefined, deploy(productId))).status, 403, "a shared bearer is not a verified operator");
  assert.equal((await send("alice", deploy(productId))).body.error, "repository_required", "an unbound product cannot be bound to a project");
  const intents = new ProductIntentStore({ root });
  assert.ok(intents.transition("clerk:alice", { version: "product-intent-v1", requestId: "route-bind-0000001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1,
    repository: { provider: "github", id: WRECKTERRA_ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public", verifiedAt: "2026-10-26T00:00:00.000Z" } }).ok);
  const bound = await send("alice", deploy(productId));
  assert.equal(bound.status, 200);
  assert.equal(bound.body.receipt?.outcome, "created");
  assert.equal(bound.body.receipt?.project.id, "prj_route");
  assert.equal(bound.body.receipt?.deployed, false);
  assert.equal(bound.body.receipt?.playable, false);
  assert.equal(bound.body.replayed, false);
  assert.equal((await send("alice", deploy(productId))).body.replayed, true);
  assert.deepEqual(posts, ["wreckterra"], "the real default transport created exactly one project");
  assert.equal((await send("bob", deploy(productId))).status, 404);
  assert.equal((await send("alice", deploy(productId, { requestId: "route-deploy-000002", teamId: "team_other" }))).status, 409);
  assert.equal((await send("alice", deploy(productId, { requestId: "route-deploy-000003", repository: { id: 7, owner: "craigoley", name: "wreckterra" } }))).status, 409);
  assert.equal((await send("alice", deploy(productId, { projectName: "second" }))).status, 409);
  assert.equal((await send("alice", { ...deploy(productId), extra: true })).status, 400);
  assert.equal((await send("alice", undefined, "{broken")).status, 400);
  assert.equal((await send("alice", undefined, JSON.stringify({ padding: "x".repeat(5000) }))).status, 413);
  delete process.env.VERCEL_TOKEN;
  assert.equal((await send("alice", deploy(productId, { requestId: "route-deploy-000004" }))).status, 503, "a missing server-held credential fails explicitly");
});
