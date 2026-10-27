import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
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
  const routes = buildServeRoutes(deps).filter((route) => route.path === prefix);
  assert.deepEqual(readdirSync(root, { recursive: true }), before, "assembling product routes creates no state");
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`).sort(),
    prefix === "/v1/products" ? ["GET /v1/products", "POST /v1/products"] : [`POST ${prefix}`]);
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
    // Free the claim: the real default target and kick now start the build, queued then observed running.
    shim.addRoute({ when: "matching-refs/rmd-dispatch/W9-T1", stdout: JSON.stringify([]) });
    const started = await send("alice", { ...build, requestId: "route-build-000002" });
    assert.equal(started.status, 200);
    assert.equal(started.body.receipt?.outcome, "queued");
    assert.equal(started.body.replayed, false);
    assert.ok(existsSync(join(daemonState, "KICK_REQUESTED-wreckterra:W9-T1")), "the repo-scoped kick marker sits under Wreckterra's own daemon root");
    assert.ok(!existsSync(join(root, "state", "KICK_REQUESTED-wreckterra:W9-T1")), "the core root, which no Wreckterra daemon reads, gets none");
    assert.ok(!shim.calls().some((call) => call.includes("-X POST")), "starting a build makes no provider write");
    assert.equal((await send("alice", { ...build, requestId: "route-build-000002" })).body.replayed, true);
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
