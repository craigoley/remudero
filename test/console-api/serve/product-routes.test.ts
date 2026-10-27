import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ghShim } from "#test/helpers/gh-shim.js";
import { stringify } from "yaml";
import { productCasePlanText } from "#src/lib/product-case.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { buildProductRoutes } from "#src/lib/product-routes.js";
import { realProductResearchProvider } from "#src/lib/product-research.js";
import type { Config } from "#src/lib/config.js";
import { CLAUDE_BIN_ENV_OVERRIDE, createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { clearOpenWeightAbsence, spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import { buildServeRoutes, type ServeDeps } from "#src/lib/serve.js";
import { createService, type IdentityProvider } from "#src/lib/service.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { declaredBody, violations, SPEC } from "#test/helpers/openapi-strict.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const command = { version: "product-intent-v1", requestId: "route-create-00001", expectedRevision: 0,
  brief: { name: "Wreckterra", idea: "private original mobile combat idea", portfolio: "OleyArcade",
    objective: "Play a solo Central Park skirmish", constraints: ["mobile first"],
    decisions: [{ key: "players", value: "solo first", provenance: { kind: "operator" as const, reference: "approved brief" } }],
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

function assembled(root: string, prefix = "/v1/products", extra: Partial<ServeDeps> = {}) {
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
    tokens: { read: "fixture-read", write: "fixture-write" }, ...extra,
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
  const routes = options.mount ? assembled(root, "/v1/products", options.deps) : buildProductRoutes({ root: options.missingRoot ? undefined : root });
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
  const config = { root: fixture, workerProviders: { enabled: [] } } as unknown as Config;
  const provider = realProductResearchProvider({
    mount: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 1000, provider: "claude" },
    config, cwd: fixture, settingsFile,
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
      ["unavailable", undefined, undefined, 0], "a disabled configured provider remains recoverable");
    assert.equal(calls, 1);
    assert.equal(queries, 0, "the real provider admission refuses before invoking the SDK");
    assert.equal(existsSync(output), false, "a disabled provider starts no research child");
    assert.deepEqual(blockedReply.accepted.map((item) => [item.questionId, item.answer]), [["q_audience", "commuters"]]);
    config.workerProviders!.enabled = ["claude"];
    const blockedReplay = await post("alice");
    const replayedBlock = await blockedReplay.json() as typeof blockedReply;
    assert.equal(blockedReplay.status, 200);
    assert.equal(replayedBlock.replayed, true);
    assert.deepEqual(replayedBlock.run, blockedReply.run, "restoring capability preserves the original unavailable receipt");
    assert.equal(calls, 1, "replaying a refused request never starts a worker");
    const toolchainBody = { ...body, requestId: "research-process-toolchain", answers: [] };
    const toolchainBlocked = await post("alice", toolchainBody);
    const toolchainReply = await toolchainBlocked.json() as typeof blockedReply;
    assert.equal(toolchainBlocked.status, 200);
    assert.deepEqual(violations(toolchainReply, declaredBody("/v1/products/research", "POST", 200)), []);
    assert.deepEqual([toolchainReply.run.outcome, toolchainReply.run.failure, toolchainReply.run.summary],
      ["unavailable", undefined, undefined], "an enabled provider with an absent toolchain is also unavailable");
    assert.equal(calls, 2);
    assert.equal(queries, 0);
    assert.equal(existsSync(output), false);
    toolchainReady = true;
    const resumedBody = { ...body, requestId: "research-process-0002", answers: [] };
    const response = await post("alice", resumedBody);
    const reply = await response.json() as { run: { id: string; outcome: string; provider: string; spendUsd: number }; replayed: boolean; accepted: { questionId: string; answer: string }[] };
    assert.equal(response.status, 200);
    assert.deepEqual(violations(reply, declaredBody("/v1/products/research", "POST", 200)), []);
    assert.deepEqual([reply.run.outcome, reply.run.provider, reply.run.spendUsd], ["completed", "claude:haiku", 0.02]);
    assert.deepEqual(reply.accepted.map((item) => [item.questionId, item.answer]), [["q_audience", "commuters"]]);
    assert.notEqual(reply.run.id, blockedReply.run.id);
    assert.equal(calls, 3, "a new request resumes the same objective after capability restoration");
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
    assert.deepEqual(allRows.filter((row) => row.run_id === toolchainReply.run.id).map((row) => [row.step, row.success]),
      [["worker.attempt", false]], "the toolchain refusal is ledgered without an execution assignment");
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
    assert.equal(calls, 3, "a durable receipt does not start another worker");
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

interface ResearchReply { run: { id: string; outcome: string; failure?: string; summary?: string; spendUsd: number }; replayed: boolean }
const CASH_DEPLOYMENT = "gpt-oss-120b";
const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/** W1-T10617: a complete cash worker result that did NO work; each case overrides only what its refusal or work sets. */
function zeroWorkResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return { provider: "cash", model: CASH_DEPLOYMENT, servedModel: null, text: "", blocks: [], isError: true, apiError: false,
    subtype: "openweight_error", stderr: "", costUsd: 0, budgetReservedUsd: 0, budgetSettledUsd: 0, budgetRefused: false,
    sessionId: "", numTurns: 1, tokens: NO_TOKENS, permissionDenials: [], childEnvKeys: [], effort: "low", modelUsage: {},
    compactionEvents: [], compactionFailures: [], compactionConfigured: false, qualitySuspect: false, ...over };
}

/** Serve research through the real adapter on a cash mount; `post` sends one research request for a saved product. */
async function researchRoute(t: TestContext, config: Config, spawn: (args: SpawnWorkerArgs) => Promise<WorkerResult>) {
  const provider = realProductResearchProvider({
    mount: { model: "haiku", effort: "low", maxTurns: 1, contextBudget: 1000, provider: "cash" },
    config, cwd: config.root, settingsFile: join(config.root, "settings.json"), spawn: spawn as typeof spawnWorker,
  });
  const app = await server(t, { mount: true, deps: { productResearchProvider: provider, productResearchBudgetUsd: 1 } });
  const saved = await request(app.url, "/v1/products", "alice", command);
  assert.ok(saved.body.receipt);
  const productId = saved.body.receipt.productId;
  const post = async (requestId: string): Promise<ResearchReply> => {
    const response = await fetch(`${app.url}/v1/products/research`, { method: "POST",
      headers: { "x-test-session": "alice", "content-type": "application/json" },
      body: JSON.stringify({ version: "product-research-v1", requestId, productId, expectedObjectiveRevision: 1 }) });
    const reply = await response.json() as ResearchReply;
    assert.equal(response.status, 200);
    assert.deepEqual(violations(reply, declaredBody("/v1/products/research", "POST", 200)), []);
    return reply;
  };
  return { post, close: () => app.close() };
}

/** A real cash spawn whose transport is a fixture; HOME is the fixture so no developer credential is read. */
async function realCashRefusal(config: Config, args: SpawnWorkerArgs, fetchImpl: typeof fetch): Promise<WorkerResult> {
  const savedHome = process.env.HOME;
  process.env.HOME = config.root;
  try {
    return await spawnWorker({ ...args, routingTrial: { id: "research-refusal", arm: "cash", reason: "fixture", models: [CASH_DEPLOYMENT] },
      providerRouting: { spawnOpenWeight: async (cashArgs, cfg, selection) => spawnOpenWeightWorker({
        ...cashArgs, env: { RMD_OPENWEIGHT_API_KEY: "fixture-only-not-a-credential" }, fetchImpl }, cfg, selection) } });
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
}

function cashConfig(t: TestContext, capUsd: number, cashWebSearch = true): Config {
  const root = ownedFixtureDir(t, "research-refusal").dir;
  writeFileSync(join(root, "settings.json"), JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
  return { root, workerHomeRoot: join(root, "worker-homes"), claudeBin: "/unused", dailyCapUsd: { normal: capUsd, squeezed: capUsd },
    workerProviders: { enabled: ["cash"], cashEndpoint: "https://fixture.invalid/", cashWebSearch } } as Config;
}

const zeroWorkReceipt = (result: WorkerResult) => [result.isError, result.budgetSettledUsd, result.costUsd, result.tokens,
  result.servedModel, result.sessionId, result.text, result.blocks];
const ZERO_WORK = [true, 0, 0, NO_TOKENS, null, "", "", []];

test("W1-T10617: a zero-work worker budget refusal is unavailable and resumable, not a provider failure", async (t) => {
  // A cap too small for the first reservation: the real cash adapter refuses before any request is sent.
  const config = cashConfig(t, 0.000000001);
  let calls = 0, transported = 0;
  let refusal: WorkerResult | undefined;
  const app = await researchRoute(t, config, async (args) => {
    calls++;
    if (calls > 1) return zeroWorkResult({ isError: false, subtype: "success", sessionId: "resumed-session", servedModel: CASH_DEPLOYMENT,
      costUsd: 0.01, budgetReservedUsd: 0.02, budgetSettledUsd: 0.01, tokens: { ...NO_TOKENS, input: 900, output: 40 },
      text: JSON.stringify({ summary: "Research resumed once the allowance reset." }) });
    refusal = await realCashRefusal(config, args, async () => {
      transported++;
      throw new Error("a refused first reservation must never reach the transport");
    });
    return refusal;
  });
  try {
    const refused = await app.post("research-budget-0001");
    assert.ok(refusal, "the real worker produced the refusal");
    assert.deepEqual([refusal.budgetRefused, refusal.budgetReservedUsd], [true, 0], refusal.stderr);
    assert.deepEqual(zeroWorkReceipt(refusal), ZERO_WORK, "the complete zero-work receipt");
    assert.equal(transported, 0);
    assert.deepEqual([refused.run.outcome, refused.run.failure, refused.run.summary, refused.run.spendUsd],
      ["unavailable", undefined, undefined, 0], "a refusal before any work is not a provider failure");
    const replay = await app.post("research-budget-0001");
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.run, refused.run, "the original unavailable receipt is replayed");
    assert.equal(calls, 1, "replaying the refused request starts no worker");
    const resumed = await app.post("research-budget-0002");
    assert.deepEqual([resumed.run.outcome, resumed.run.spendUsd], ["completed", 0.01], "a new request resumes the same objective");
    assert.notEqual(resumed.run.id, refused.run.id);
    assert.equal(calls, 2);
  } finally { await app.close(); }
});

test("W1-T10617: a cash deployment absent before any work is unavailable", async (t) => {
  const config = cashConfig(t, 100);
  // The adapter remembers an absent deployment process-wide; forget it so no later test inherits it.
  t.after(clearOpenWeightAbsence);
  let transported = 0;
  let absent: WorkerResult | undefined;
  const app = await researchRoute(t, config, async (args) => {
    absent = await realCashRefusal(config, args, async () => { transported++; return new Response("{}", { status: 404 }); });
    return absent;
  });
  try {
    const reply = await app.post("research-absent-0001");
    assert.ok(absent, "the real worker produced the refusal");
    assert.equal(absent.openWeightDeploymentAbsent, CASH_DEPLOYMENT, absent.stderr);
    assert.ok((absent.budgetReservedUsd ?? 0) > 0, "the request was reserved before it was sent");
    assert.deepEqual(zeroWorkReceipt(absent), ZERO_WORK, "a definite 404 settles to zero and returns no work");
    assert.equal(transported, 1);
    assert.deepEqual([reply.run.outcome, reply.run.failure, reply.run.spendUsd], ["unavailable", undefined, 0]);
  } finally { await app.close(); }
});

test("W1-T10617: a cash route that cannot serve the declared WebSearch tool is unavailable", async (t) => {
  // Without brokered search consent the real cash adapter refuses the declared tool before reserving anything.
  const config = cashConfig(t, 100, false);
  let transported = 0;
  let refusal: WorkerResult | undefined;
  const app = await researchRoute(t, config, async (args) => {
    refusal = await realCashRefusal(config, args, async () => { transported++; throw new Error("an undeclarable tool must never reach the transport"); });
    return refusal;
  });
  try {
    const reply = await app.post("research-tool-0001");
    assert.ok(refusal, "the real worker produced the refusal");
    assert.match(refusal.stderr, /does not implement declared tool\(s\): WebSearch/);
    assert.deepEqual([refusal.budgetRefused, refusal.budgetReservedUsd, refusal.usageRefusal, refusal.openWeightDeploymentAbsent],
      [false, 0, undefined, undefined], "this refusal sets no refusal flag");
    assert.deepEqual(zeroWorkReceipt(refusal), ZERO_WORK, "the complete zero-work receipt");
    assert.equal(transported, 0);
    assert.deepEqual([reply.run.outcome, reply.run.failure, reply.run.spendUsd], ["unavailable", undefined, 0]);
  } finally { await app.close(); }
});

test("W1-T10617: a zero-work account usage refusal is unavailable", async (t) => {
  const app = await researchRoute(t, cashConfig(t, 100), async () => zeroWorkResult({ provider: "codex", subtype: "error_codex",
    budgetReservedUsd: undefined, budgetSettledUsd: undefined, budgetRefused: undefined, usageRefusal: { matched: "usage limit" } }));
  try {
    const reply = await app.post("research-usage-0001");
    assert.deepEqual([reply.run.outcome, reply.run.failure, reply.run.spendUsd], ["unavailable", undefined, 0]);
  } finally { await app.close(); }
});

test("W1-T10617: a refusal or error after provider work stays a provider failure", async (t) => {
  const worked = { sessionId: "provider-session", servedModel: CASH_DEPLOYMENT, costUsd: 0.01, tokens: { ...NO_TOKENS, input: 900, output: 40 } };
  const claude = { provider: "claude" as const, budgetReservedUsd: undefined, budgetSettledUsd: undefined, budgetRefused: undefined };
  const cases: [string, WorkerResult][] = [
    ["a budget refusal on a later turn after a paid request",
      zeroWorkResult({ ...worked, budgetRefused: true, budgetReservedUsd: 0.02, budgetSettledUsd: 0.01, numTurns: 2 })],
    ["a budget refusal after an earlier reservation", zeroWorkResult({ budgetRefused: true, budgetReservedUsd: 0.02 })],
    ["an error whose reservation stayed charged", zeroWorkResult({ budgetReservedUsd: 0.02, budgetSettledUsd: 0.02, costUsd: 0.02 })],
    ["a deployment absent after an earlier request stayed charged",
      zeroWorkResult({ openWeightDeploymentAbsent: CASH_DEPLOYMENT, budgetReservedUsd: 0.04, budgetSettledUsd: 0.02 })],
    ["a usage refusal carrying the session and its refusal text",
      zeroWorkResult({ ...claude, usageRefusal: { matched: "session limit" }, sessionId: "sdk-session", text: "You've hit your session limit" })],
    ["a usage refusal carrying cost", zeroWorkResult({ ...claude, ...worked, usageRefusal: { matched: "usage limit" } })],
    ["a safeguard refusal of a received request",
      zeroWorkResult({ ...claude, safeguardRefusal: { category: null, retried: false, originalModel: "haiku" } })],
    // Each remaining field of the zero-work receipt, alone, is evidence of work.
    ["an error that reported cost", zeroWorkResult({ costUsd: 0.01 })],
    ...(["input", "output", "cacheRead", "cacheCreation"] as const).map((field): [string, WorkerResult] =>
      [`an error that used ${field} tokens`, zeroWorkResult({ tokens: { ...NO_TOKENS, [field]: 1 } })]),
    ["an error that served a model", zeroWorkResult({ servedModel: CASH_DEPLOYMENT })],
    ["an error that opened a session", zeroWorkResult({ sessionId: "provider-session" })],
    ["an error with result text", zeroWorkResult({ text: "partial" })],
    ["an error with output blocks", zeroWorkResult({ blocks: ["partial"] })],
    ["an ordinary error after work", zeroWorkResult({ ...worked, text: "partial", blocks: ["partial"] })],
    ["a non-error result with no output", zeroWorkResult({ isError: false, subtype: "success" })],
  ];
  for (const [name, result] of cases) {
    const app = await researchRoute(t, cashConfig(t, 100), async () => result);
    try {
      const reply = await app.post("research-control-0001");
      assert.deepEqual([reply.run.outcome, reply.run.failure, reply.run.spendUsd], ["failed", "provider_error", 0], name);
    } finally { await app.close(); }
  }
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
  const mounted = assembled(root, "/v1/products/repository");
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
  const preview = assembled(root, "/v1/products/repository-preview");
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

test("W1-T10615: the served product build operation matches the authenticated API contract", async (t) => {
  const HEAD = "c".repeat(40);
  const shim = ghShim([
    { when: "commits/main", stdout: JSON.stringify({ sha: HEAD }) },
    { when: `contents?ref=${HEAD}`, stdout: JSON.stringify([{ name: "src" }, { name: "README.md" }]) },
    { when: "contents/plan/tasks.d?ref=main", stdout: JSON.stringify([{ name: "W9-T1-first.yaml" }]) },
    { when: "contents/plan/tasks.d/W9-T1-first.yaml", stdout: "PLACEHOLDER" },
    { when: "matching-refs/rmd-dispatch/W9-T1", stdout: JSON.stringify([{ ref: "refs/rmd-dispatch/W9-T1", object: { sha: "1".repeat(40) } }]) },
    { when: "matching-refs/heads/run-W9-T1-", stdout: JSON.stringify([{ ref: "refs/heads/run-W9-T1-17", object: { sha: "2".repeat(40) } }]) },
    { when: "search/issues", stdout: JSON.stringify({ total_count: 0 }) },
    { when: "api repos/craigoley/wreckterra", stdout: JSON.stringify({ id: WRECKTERRA_ID, name: "wreckterra",
      owner: { login: "craigoley" }, private: false, default_branch: "main" }) },
  ]);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const root = ownedFixtureDir(t, "product-build-http").dir;
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(join(root, ".remudero", "managed-repos.json"), JSON.stringify({ repos: ["craigoley/wreckterra"] }));
  // The repo-tracked instance registry names Wreckterra's own daemon; its config root is mounted under the state base.
  const registry = join(root, ".remudero", "daemon-instances.yaml");
  const daemonState = join(root, "instances", "wreckterra", "state");
  mkdirSync(daemonState, { recursive: true });
  writeFileSync(registry, "instances:\n  core:\n    github_repo: craigoley/remudero\n");
  const store = new ProductIntentStore({ root });
  const saved = store.write("clerk:alice", command);
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  assert.ok(store.transition("clerk:alice", { version: "product-intent-v1", requestId: "route-build-seed-01", id: productId, expectedRevision: 1, expectedObjectiveRevision: 1,
    repository: { provider: "github", id: WRECKTERRA_ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public", verifiedAt: "2026-10-26T00:00:00.000Z" },
    stageEvidence: [{ id: "plan-approved-1", stage: "plan", outcome: "succeeded", objectiveRevision: 1, observedAt: "2026-10-26T00:00:01.000Z", references: [] }] }).ok);
  const shard = `- id: W9-T1\n  origin: product-plan#${productId}/plan-approved-1\n  status: queued\n  budget_usd: 10\n`;
  shim.addRoute({ when: "contents/plan/tasks.d/W9-T1-first.yaml", stdout: shard });
  const products = assembled(root);
  const mounted = assembled(root, "/v1/products/build", { instances: { stateBase: join(root, "instances") } });
  assert.equal(mounted[0]?.tier, "high", "starting a build is a high-tier action");
  assert.equal(mounted[0]?.scope, "write");
  const instance = createService({ tokens: { read: "fixture-read", write: "fixture-write" }, operatorSession: identity, routes: [...products, ...mounted] });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
  const build = { version: "product-build-v1", requestId: "route-build-000001", productId, planEvidenceId: "plan-approved-1", taskId: "W9-T1",
    expectedRevision: 2, expectedObjectiveRevision: 1 };
  const send = async (session: "alice" | "bob" | undefined, body: unknown, raw?: string) => {
    const result = await fetch(`${base}/v1/products/build`, { method: "POST", headers: { authorization: "Bearer fixture-write",
      "content-type": "application/json", ...(session ? { "x-test-session": session } : {}) }, body: raw ?? JSON.stringify(body) });
    const reply = await result.json() as { version: string; error?: string; replayed?: boolean; receipt?: { outcome: string; evidence: unknown[] } };
    assert.deepEqual(violations(reply, declaredBody("/v1/products/build", "POST", result.status)), [],
      `the real build response (${result.status}) must match its declared contract`);
    assert.match(result.headers.get("cache-control") ?? "", /no-store/);
    return { status: result.status, body: reply };
  };
  try {
    assert.equal((await send(undefined, build)).status, 403);
    assert.equal((await send("alice", { ...build, extra: true })).status, 400);
    assert.equal((await send("alice", undefined, "{broken")).status, 400);
    assert.equal((await send("alice", undefined, JSON.stringify({ padding: "x".repeat(5000) }))).status, 413);
    assert.equal((await send("bob", build)).status, 404);
    assert.equal((await send("alice", { ...build, planEvidenceId: "unapproved" })).status, 409);
    assert.equal(shim.calls().length, 1, "only the unapproved plan reached the transport, and only for the repository identity read");
    // No live daemon instance drives the target yet: there is nowhere the kick could be delivered.
    const undriven = await send("alice", build);
    assert.equal(undriven.status, 409);
    assert.equal(undriven.body.error, "target_daemon_missing");
    writeFileSync(registry, "instances:\n  core:\n    github_repo: craigoley/remudero\n  wreckterra:\n    github_repo: craigoley/wreckterra\n");
    // The task is already claimed by another lane, so the assembled operation refuses it explicitly.
    const claimed = await send("alice", build);
    assert.equal(claimed.status, 409);
    assert.equal(claimed.body.error, "task_claimed");
    assert.ok(!existsSync(join(daemonState, "KICK_REQUESTED-wreckterra:W9-T1")), "a refused start writes no marker");
    // Free the claim: the real default target and kick now start the build, recorded as queued.
    shim.addRoute({ when: "matching-refs/rmd-dispatch/W9-T1", stdout: JSON.stringify([]) });
    const started = await send("alice", { ...build, requestId: "route-build-000002" });
    assert.equal(started.status, 200);
    assert.equal(started.body.receipt?.outcome, "queued");
    assert.equal(started.body.replayed, false);
    assert.ok(existsSync(join(daemonState, "KICK_REQUESTED-wreckterra:W9-T1")), "the repo-scoped kick marker sits under Wreckterra's own daemon root");
    assert.ok(!existsSync(join(root, "state", "KICK_REQUESTED-wreckterra:W9-T1")), "the core root, which no Wreckterra daemon reads, gets none");
    assert.ok(!shim.calls().some((call) => call.includes("-X POST")), "starting a build makes no provider write");
    // A worker's fresh claim and run branch appear, but Wreckterra's own daemon ledger shows no run: admitted, never running.
    shim.addRoute({ when: "matching-refs/rmd-dispatch/W9-T1", stdout: JSON.stringify([{ ref: "refs/rmd-dispatch/W9-T1", object: { sha: "1".repeat(40) } }]) });
    const replayed = await send("alice", { ...build, requestId: "route-build-000002" });
    assert.equal(replayed.body.replayed, true);
    assert.equal(replayed.body.receipt?.outcome, "admitted");
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
  const mounted = assembled(root, "/v1/products/deployment");
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


test("W1-T10618: the served product case operation matches the authenticated API contract", async (t) => {
  const head = "d".repeat(40);
  const shim = ghShim([
    { when: "commits/main", stdout: JSON.stringify({ sha: head }) },
    { when: `contents?ref=${head}`, stdout: JSON.stringify([{ name: "src" }]) },
    { when: "contents/plan/tasks.d?", stdout: JSON.stringify([{ name: "W9-T1-prototype.yaml" }]) },
    { when: "matching-refs/", stdout: "[]" },
    { when: "search/issues", stdout: '{"total_count":0}' },
    { when: "pulls/7/reviews", stdout: JSON.stringify([{ state: "APPROVED", commit_id: head, user: { login: "reviewer" } }]) },
    { when: "pulls/7/files", stdout: JSON.stringify([{ filename: "plan/tasks.d/W9-T1-prototype.yaml" }]) },
    { when: "pulls/7", stdout: JSON.stringify({ number: 7, merged_at: "2026-10-26T00:00:00Z", merge_commit_sha: head, head: { sha: head },
      base: { ref: "main", repo: { id: WRECKTERRA_ID } } }) },
    { when: "api repos/craigoley/wreckterra", stdout: JSON.stringify({ id: WRECKTERRA_ID, name: "wreckterra",
      owner: { login: "craigoley" }, private: false, default_branch: "main" }) },
  ]);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; rmSync(shim.dir, { recursive: true, force: true }); });
  const root = ownedFixtureDir(t, "product-case-http").dir;
  const stateBase = join(root, "instances");
  const products = assembled(root);
  const mounted = assembled(root, "/v1/products/case", { instances: { stateBase } });
  assert.equal(mounted[0]?.tier, "high");
  assert.equal(mounted[0]?.scope, "write");
  mkdirSync(join(root, ".remudero"), { recursive: true });
  mkdirSync(join(stateBase, "wreckterra/state"), { recursive: true });
  writeFileSync(join(root, ".remudero/managed-repos.json"), JSON.stringify({ repos: ["craigoley/wreckterra"] }));
  writeFileSync(join(root, ".remudero/daemon-instances.yaml"), "instances:\n  core:\n    github_repo: craigoley/remudero\n  wreckterra:\n    github_repo: craigoley/wreckterra\n");
  const app = createService({ tokens: { read: "fixture-read", write: "fixture-write" }, operatorSession: identity, routes: [...products, ...mounted] });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const send = async (session: "alice" | "bob" | undefined, body: unknown, raw?: string) => {
    const response = await fetch(`${base}/v1/products/case`, { method: "POST", headers: { authorization: "Bearer fixture-write",
      "content-type": "application/json", ...(session ? { "x-test-session": session } : { "x-rmd-actor": "clerk:alice" }) },
      body: raw ?? JSON.stringify(body) });
    const reply = await response.json() as { error?: string; productId: string; replayed: boolean; revision: number;
      build?: { outcome: string }; evidence: { deploy: unknown[]; mobile: unknown[] } };
    assert.deepEqual(violations(reply, declaredBody("/v1/products/case", "POST", response.status)), []);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    return { status: response.status, body: reply };
  };
  const imported = { version: "product-case-v1", action: "import", command };
  assert.deepEqual(violations(imported, SPEC.components.schemas.ProductCaseCommand!), []);
  assert.equal((await send(undefined, imported)).status, 403);
  assert.equal((await send("alice", { ...imported, verified: true })).status, 400);
  assert.equal((await send("alice", undefined, "{broken")).status, 400);
  assert.equal((await send("alice", undefined, JSON.stringify({ padding: "x".repeat(70_000) }))).status, 413);
  const saved = await send("alice", imported);
  assert.equal(saved.status, 200);
  const productId = saved.body.productId;
  assert.equal((await send("alice", imported)).body.replayed, true);
  const adoption = { version: "product-case-v1", action: "adopt", command: adopt(productId) };
  assert.deepEqual(violations(adoption, SPEC.components.schemas.ProductCaseCommand!), []);
  assert.equal((await send("bob", adoption)).status, 404);
  assert.equal((await send("alice", adoption)).status, 200);
  const planEvidenceId = "case-http-plan-v1";
  const planning = { version: "product-case-v1", action: "plan", command: { requestId: "case-http-plan-01", productId,
    expectedRevision: 2, expectedObjectiveRevision: 1, taskId: "W9-T1", planEvidenceId, pullRequest: 7 } };
  assert.deepEqual(violations(planning, SPEC.components.schemas.ProductCaseCommand!), []);
  const shard = stringify([{ id: "W9-T1", origin: `product-plan#${productId}/${planEvidenceId}`, status: "queued", budget_usd: 10,
    design: productCasePlanText(command.brief) }]);
  shim.addRoute({ when: "contents/plan/tasks.d/W9-T1-prototype.yaml", stdout: shard });
  assert.equal((await send("alice", planning)).status, 200);
  assert.equal((await send("alice", planning)).body.replayed, true);
  const build = { version: "product-case-v1", action: "build", command: { version: "product-build-v1", requestId: "case-http-build01", productId,
    expectedRevision: 3, expectedObjectiveRevision: 1, taskId: "W9-T1", planEvidenceId } };
  assert.deepEqual(violations(build, SPEC.components.schemas.ProductCaseCommand!), []);
  assert.equal((await send("alice", { ...build, command: { ...build.command, expectedRevision: 99 } })).status, 409);
  const started = await send("alice", build);
  assert.equal(started.status, 200);
  assert.equal(started.body.productId, productId);
  assert.equal(started.body.build?.outcome, "queued");
  assert.deepEqual(started.body.evidence.deploy, []);
  assert.deepEqual(started.body.evidence.mobile, []);
  assert.equal((await send("alice", build)).body.replayed, true);
  assert.ok(existsSync(join(stateBase, "wreckterra/state/KICK_REQUESTED-wreckterra:W9-T1")));
  assert.ok(!shim.calls().some((call) => call.includes("-X POST")));
});

test("W1-T10619: the served product evaluation operation matches the authenticated API contract", async (t) => {
  const root = ownedFixtureDir(t, "product-evaluation-http").dir;
  const products = assembled(root);
  const mounted = assembled(root, "/v1/products/evaluation");
  assert.equal(mounted[0]?.scope, "write");
  assert.equal(mounted[0]?.tier, "middle", "recording a proposal is middle tier: it never builds, spends or deploys");
  const instance = createService({ tokens: { read: "fixture-read", write: "fixture-write" }, operatorSession: identity, routes: [...products, ...mounted] });
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve())));
  const send = async (session: "alice" | "bob" | undefined, body: unknown, raw?: string) => {
    const result = await fetch(`${base}/v1/products/evaluation`, { method: "POST", headers: { authorization: "Bearer fixture-write",
      "content-type": "application/json", ...(session ? { "x-test-session": session } : {}) }, body: raw ?? JSON.stringify(body) });
    const reply = await result.json() as { version: string; error?: string; replayed?: boolean;
      receipt?: { verdict: string; autoDeploy: boolean; deployed: boolean; executionAuthority: string; coverage: Record<string, string> } };
    assert.deepEqual(violations(reply, declaredBody("/v1/products/evaluation", "POST", result.status)), [],
      `the real evaluation response (${result.status}) must match its declared contract`);
    assert.match(result.headers.get("cache-control") ?? "", /no-store/);
    return { status: result.status, body: reply };
  };
  const created = await request(base, "/v1/products", "alice", command);
  const productId = created.body.receipt!.productId;
  const versions = { objectiveVersion: "objective-1", evaluatorVersion: "evaluator-1" };
  const evaluation = (over: Record<string, unknown> = {}) => ({ version: "product-evaluation-v1", requestId: "route-eval-0000001", productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, objective: versions, baseline: versions, candidate: versions,
    holdouts: [{ kind: "geography", id: "central-park", baseline: 0.5, candidate: 0.6 }, { kind: "device", id: "phone-small", baseline: 0.7, candidate: 0.7 }],
    evidence: [{ channel: "replay", reference: "https://example.com/replays/1" }],
    proposal: { summary: "tighten the skirmish pacing", pullRequests: 1, costUsd: 5 }, ...over });
  assert.equal((await send(undefined, evaluation())).status, 403, "a shared bearer is not a verified operator");
  const recorded = await send("alice", evaluation());
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.receipt?.verdict, "reviewable");
  assert.equal(recorded.body.receipt?.executionAuthority, "none");
  assert.equal(recorded.body.receipt?.autoDeploy, false);
  assert.equal(recorded.body.receipt?.deployed, false);
  assert.equal(recorded.body.replayed, false);
  assert.equal((await send("alice", evaluation())).body.replayed, true);
  assert.ok(existsSync(join(root, "state/products/v1/evaluations")), "the proposal is durable under the fleet root");
  assert.equal((await send("bob", evaluation({ requestId: "route-eval-0000002" }))).status, 404);
  const unknown = await send("alice", evaluation({ requestId: "route-eval-0000003", expectedRevision: 2,
    holdouts: [{ kind: "geography", id: "central-park", baseline: 0.5, candidate: null }] }));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.receipt?.verdict, "unknown");
  assert.deepEqual(unknown.body.receipt?.coverage, { geography: "unknown", device: "unknown" });
  const changed = await send("alice", evaluation({ requestId: "route-eval-0000004", expectedRevision: 3, candidate: { ...versions, evaluatorVersion: "evaluator-2" } }));
  assert.deepEqual([changed.status, changed.body.error], [409, "objective_changed"]);
  const failed = await send("alice", evaluation({ requestId: "route-eval-0000005", expectedRevision: 4,
    holdouts: [{ kind: "device", id: "phone-small", baseline: 0.7, candidate: 0.2 }] }));
  assert.deepEqual([failed.status, failed.body.error], [409, "holdout_failed"]);
  assert.equal((await send("alice", evaluation({ requestId: "route-eval-0000006", expectedRevision: 5, proposal: { summary: "x", pullRequests: 1, costUsd: 31 } }))).body.error, "budget_exceeded");
  assert.equal((await send("alice", evaluation({ expectedRevision: 5, proposal: { summary: "other", pullRequests: 1, costUsd: 5 } }))).status, 409);
  assert.equal((await send("alice", evaluation({ requestId: "route-eval-0000007", expectedRevision: 1 }))).body.error, "stale_revision");
  assert.equal((await send("alice", { ...evaluation({ requestId: "route-eval-0000008" }), autoDeploy: true })).status, 400);
  assert.equal((await send("alice", undefined, "{broken")).status, 400);
  assert.equal((await send("alice", undefined, JSON.stringify({ padding: "x".repeat(17_000) }))).status, 413);
});
