import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, fstatSync, fsyncSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  ProductDeploymentService, vercelConfigFromEnv, vercelDeploymentProvider, VercelDenied,
  type ProductDeploymentProvider, type VercelConfig, type VercelProject, type VercelRead,
} from "#src/lib/product-deployment.js";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const actor = "clerk:alice";
const TEAM = "team_oleyarcade";
const REPO = { id: 1432832754, owner: "craigoley", name: "wreckterra" };
const config: VercelConfig = { token: "tok_secret_value", teamId: TEAM, baseUrl: "https://api.vercel.example" };

/** A stateful provider double: provider state survives a lost response, as Vercel's does. */
class FakeVercel implements ProductDeploymentProvider {
  projects = new Map<string, VercelProject>();
  calls: string[] = [];
  configured: VercelConfig | undefined = config;
  loseResponse = false;
  refuseCreate = false;
  readsDown = false;
  linkRepoId = REPO.id;
  linkRepo = REPO.name;
  accountId = TEAM;
  nextId = 1;
  config() { return this.configured; }
  async read(_config: VercelConfig, name: string): Promise<VercelRead> {
    this.calls.push(`read ${name}`);
    if (this.readsDown) return { state: "unreadable" };
    const found = this.projects.get(name);
    return found ? { state: "found", project: found } : { state: "absent" };
  }
  async create(_config: VercelConfig, spec: { name: string; repository: { owner: string; name: string } }): Promise<void> {
    this.calls.push(`create ${spec.name}`);
    if (this.refuseCreate) throw new VercelDenied("refused");
    this.projects.set(spec.name, { id: `prj_${this.nextId++}`, name: spec.name, accountId: this.accountId,
      link: { type: "github", org: spec.repository.owner, repo: this.linkRepo, repoId: this.linkRepoId } });
    if (this.loseResponse) throw new Error("socket hang up after provider success");
  }
  creates() { return this.calls.filter((call) => call.startsWith("create ")); }
}

function fixture(t: TestContext, options: { bind?: boolean } = {}) {
  const root = ownedFixtureDir(t, "product-deployment").dir;
  const intents = new ProductIntentStore({ root });
  const saved = intents.write(actor, { version: "product-intent-v1", requestId: "deploy-product-00001", expectedRevision: 0,
    brief: { idea: "private idea", name: "Wreckterra", requestedRepository: { owner: REPO.owner, name: REPO.name } } });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  if (options.bind !== false) {
    const bound = intents.transition(actor, { version: "product-intent-v1", requestId: "deploy-bind-0000001", id: productId,
      expectedRevision: 1, expectedObjectiveRevision: 1,
      repository: { provider: "github", id: REPO.id, owner: REPO.owner, name: REPO.name, defaultBranch: "main", visibility: "public", verifiedAt: "2026-10-26T00:00:00.000Z" } });
    assert.ok(bound.ok);
  }
  const command = (over: Record<string, unknown> = {}) => {
    const current = intents.read(actor, productId); assert.ok(current.ok);
    return { version: "product-deployment-v1", requestId: "deploy-request-000001", productId, action: "create", teamId: TEAM,
      projectName: "wreckterra", repository: REPO, expectedRevision: current.value.revision,
      expectedObjectiveRevision: current.value.objectiveRevision, ...over };
  };
  const dir = join(root, "state/products/v1/deployments");
  const journalFiles = () => existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".json")) : [];
  return { root, productId, command, dir, journalFiles, intents,
    service: (provider: ProductDeploymentProvider, extra: object = {}) => new ProductDeploymentService({ root, provider, ...extra }) };
}

/** Recreates a file with an exact mode; the refusal under test is a stat-mode policy, the same at every uid. */
function replaceWithMode(file: string, body: string, mode: number): void {
  const mask = process.umask(0);
  try { unlinkSync(file); writeFileSync(file, body, { mode }); }
  finally { process.umask(mask); }
}

test("W1-T10616: deployment binding rejects a different repository or team", async (t) => {
  const f = fixture(t), provider = new FakeVercel();
  // A different repository (ID, owner or name) than the one the product is verified to be bound to.
  assert.deepEqual(await f.service(provider).execute(actor, f.command({ repository: { ...REPO, id: REPO.id + 1 } })), { ok: false, code: "repository_mismatch" });
  assert.deepEqual(await f.service(provider).execute(actor, f.command({ repository: { ...REPO, owner: "someone" } })), { ok: false, code: "repository_mismatch" });
  assert.deepEqual(await f.service(provider).execute(actor, f.command({ repository: { ...REPO, name: "other" } })), { ok: false, code: "repository_mismatch" });
  // A different team than the server-configured one.
  assert.deepEqual(await f.service(provider).execute(actor, f.command({ teamId: "team_other" })), { ok: false, code: "team_mismatch" });
  assert.deepEqual(provider.calls, [], "a refused binding makes no provider call");
  assert.deepEqual(f.journalFiles(), [], "a refused binding writes nothing");
  // A product with no verified GitHub repository cannot be bound at all.
  const unbound = fixture(t, { bind: false });
  assert.deepEqual(await unbound.service(provider).execute(actor, unbound.command()), { ok: false, code: "repository_required" });
  assert.deepEqual(provider.calls, []);
  // Read-back identity: an existing project linked to another repository or owned by another team is never adopted.
  provider.projects.set("wreckterra", { id: "prj_9", name: "wreckterra", accountId: TEAM, link: { type: "github", org: REPO.owner, repo: REPO.name, repoId: REPO.id + 5 } });
  const adopt = (over: Record<string, unknown> = {}) => f.command({ action: "adopt", projectId: "prj_9", ...over });
  assert.deepEqual(await f.service(provider).execute(actor, adopt()), { ok: false, code: "repository_mismatch" });
  provider.projects.set("wreckterra", { id: "prj_9", name: "wreckterra", accountId: "team_foreign", link: { type: "github", org: REPO.owner, repo: REPO.name, repoId: REPO.id } });
  assert.deepEqual(await f.service(provider).execute(actor, adopt({ requestId: "deploy-request-000002" })), { ok: false, code: "team_mismatch" });
  provider.projects.set("wreckterra", { id: "prj_9", name: "wreckterra", accountId: TEAM });
  assert.deepEqual(await f.service(provider).execute(actor, adopt({ requestId: "deploy-request-000003" })), { ok: false, code: "repository_mismatch" });
  provider.projects.set("wreckterra", { id: "prj_8", name: "wreckterra", accountId: TEAM, link: { type: "github", org: REPO.owner, repo: REPO.name, repoId: REPO.id } });
  assert.deepEqual(await f.service(provider).execute(actor, adopt({ requestId: "deploy-request-000004" })), { ok: false, code: "project_conflict" });
  assert.deepEqual(provider.creates(), []);
  assert.deepEqual(f.journalFiles(), [], "no identity mismatch is ever recorded");
  // The same project with the matching identity is adopted with zero create calls.
  provider.projects.set("wreckterra", { id: "prj_9", name: "wreckterra", accountId: TEAM, link: { type: "github", org: "CraigOley", repo: "Wreckterra", repoId: REPO.id } });
  const adopted = await f.service(provider).execute(actor, adopt({ requestId: "deploy-request-000005" }));
  assert.ok(adopted.ok);
  assert.equal(adopted.value.receipt.outcome, "adopted");
  assert.equal(adopted.value.receipt.project.id, "prj_9");
  assert.deepEqual(provider.creates(), []);
  // A missing or unreadable credential refuses before any read.
  provider.configured = undefined;
  assert.deepEqual(await f.service(provider).execute(actor, f.command({ requestId: "deploy-request-000006" })), { ok: false, code: "not_configured" });
});

test("W1-T10616: a lost project response resumes the same provider project", async (t) => {
  const f = fixture(t), provider = new FakeVercel();
  // Vercel created the project, the response was lost, and the read-back is also down.
  provider.loseResponse = true;
  const create = provider.create.bind(provider);
  provider.create = async (c, spec) => { try { await create(c, spec); } finally { provider.readsDown = true; } };
  assert.deepEqual(await f.service(provider).execute(actor, f.command()), { ok: false, code: "outcome_unknown" });
  assert.equal(provider.projects.size, 1);
  const journal = readFileSync(join(f.dir, f.journalFiles()[0]!), "utf8");
  assert.match(journal, /"phase":"intent"/, "the intent was durable before the lost create call");
  // Concurrent duplicate retries after a restart resume the SAME provider project; one create, ever.
  provider.readsDown = false;
  const results = await Promise.all([1, 2, 3].map(() => f.service(provider).execute(actor, f.command())));
  for (const result of results) assert.ok(result.ok);
  assert.equal(provider.creates().length, 1);
  assert.equal(provider.projects.size, 1);
  assert.equal(new Set(results.map((result) => result.ok ? result.value.receipt.project.id : "")).size, 1);
  assert.equal(results.filter((result) => result.ok && !result.value.replayed).length, 1);
  // A same-process lost response with a readable provider reconciles at once, with no second create.
  const second = fixture(t), other = new FakeVercel();
  other.loseResponse = true;
  const reconciled = await second.service(other).execute(actor, second.command());
  assert.ok(reconciled.ok);
  assert.equal(other.creates().length, 1);
  // A 404 that lags a journaled POST is never answered with another POST.
  const lag = fixture(t), lagging = new FakeVercel();
  lagging.create = async (_c, spec) => { lagging.calls.push(`create ${spec.name}`); throw new Error("unknown response; read-back may lag"); };
  assert.deepEqual(await lag.service(lagging).execute(actor, lag.command()), { ok: false, code: "outcome_unknown" });
  assert.deepEqual(await lag.service(lagging).execute(actor, lag.command()), { ok: false, code: "outcome_unknown" });
  assert.equal(lagging.creates().length, 1);
  // A second request while an intent is unresolved cannot start another operation.
  assert.deepEqual(await lag.service(lagging).execute(actor, lag.command({ requestId: "deploy-request-000009" })), { ok: false, code: "outcome_unknown" });
  assert.equal(lagging.creates().length, 1);
});

test("W1-T10616: project creation never marks a product deployed or playable", async (t) => {
  const f = fixture(t), provider = new FakeVercel();
  const before = f.intents.read(actor, f.productId); assert.ok(before.ok);
  const created = await f.service(provider).execute(actor, f.command());
  assert.ok(created.ok);
  const { receipt } = created.value;
  assert.equal(receipt.outcome, "created");
  assert.equal(receipt.deployed, false);
  assert.equal(receipt.playable, false);
  assert.deepEqual(receipt.evidence, { sourceSha: null, deployment: "none", servedRoute: "unverified", physicalDevice: "unverified" });
  assert.deepEqual(receipt.project.repository, REPO);
  assert.equal(receipt.project.teamId, TEAM);
  assert.ok(!JSON.stringify(receipt).includes(config.token), "the credential never reaches a receipt");
  const journal = readFileSync(join(f.dir, f.journalFiles()[0]!), "utf8");
  assert.ok(!journal.includes(config.token), "the credential never reaches the journal");
  assert.match(receipt.project.id, /^prj_/);
  const after = f.intents.read(actor, f.productId); assert.ok(after.ok);
  assert.deepEqual(after.value, before.value, "binding a project leaves the product record untouched");
  assert.ok(!after.value.stageEvidence.some((entry) => entry.stage === "deploy"), "no deploy evidence is recorded");
  assert.deepEqual(provider.calls, ["read wreckterra", "create wreckterra", "read wreckterra"]);
  const again = await f.service(provider).execute(actor, f.command());
  assert.ok(again.ok);
  assert.equal(again.value.replayed, true);
  assert.deepEqual(again.value.receipt, receipt);
});

test("product deployment refuses unsafe commands, other operators and an existing unowned project", async (t) => {
  const f = fixture(t), provider = new FakeVercel();
  const service = f.service(provider);
  for (const bad of [undefined, {}, { ...f.command(), extra: true }, f.command({ action: "adopt" }), f.command({ projectId: "prj_1" }), f.command({ projectName: "Bad Name" })]) {
    assert.deepEqual(await service.execute(actor, bad), { ok: false, code: "invalid_input" });
  }
  assert.deepEqual(await service.execute("", f.command()), { ok: false, code: "invalid_identity" });
  assert.deepEqual(await service.execute("clerk:bob", f.command()), { ok: false, code: "not_found" });
  assert.deepEqual(await f.service(provider, { root: undefined }).execute(actor, f.command()), { ok: false, code: "unavailable" });
  assert.deepEqual(provider.calls, []);
  // A project that already exists is never claimed by a create without our own durable intent.
  provider.projects.set("wreckterra", { id: "prj_3", name: "wreckterra", accountId: TEAM, link: { type: "github", org: REPO.owner, repo: REPO.name, repoId: REPO.id } });
  assert.deepEqual(await service.execute(actor, f.command()), { ok: false, code: "project_conflict" });
  assert.deepEqual(provider.creates(), []);
  assert.deepEqual(await service.execute(actor, f.command({ action: "adopt", projectId: "prj_3", projectName: "missing" })), { ok: false, code: "project_not_found" });
  provider.readsDown = true;
  assert.deepEqual(await service.execute(actor, f.command({ requestId: "deploy-request-000002" })), { ok: false, code: "provider_unreadable" });
  provider.readsDown = false;
  // Stale scope refuses before any provider call.
  provider.calls = [];
  assert.deepEqual(await service.execute(actor, f.command({ requestId: "deploy-request-000003", expectedRevision: 99 })), { ok: false, code: "stale_revision" });
  assert.deepEqual(provider.calls, []);
});

test("product deployment denial retires the intent and a bound product refuses a second project", async (t) => {
  const f = fixture(t), provider = new FakeVercel();
  provider.refuseCreate = true;
  assert.deepEqual(await f.service(provider).execute(actor, f.command()), { ok: false, code: "creation_denied" });
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, f.journalFiles()[0]!), "utf8")).operations, {}, "a refusal leaves no record");
  provider.refuseCreate = false;
  assert.ok((await f.service(provider).execute(actor, f.command())).ok);
  assert.deepEqual(await f.service(provider).execute(actor, f.command({ requestId: "deploy-request-000002", projectName: "second" })), { ok: false, code: "project_conflict" });
  assert.deepEqual(await f.service(provider).execute(actor, f.command({ projectName: "second" })), { ok: false, code: "idempotency_conflict" });
  assert.equal(provider.creates().length, 2, "one refused create and one accepted create; never a repeat after acceptance");
});

test("product deployment readback refuses a created project that is not ours", async (t) => {
  const f = fixture(t), provider = new FakeVercel();
  provider.linkRepoId = 7;
  assert.deepEqual(await f.service(provider).execute(actor, f.command()), { ok: false, code: "repository_mismatch" });
  assert.match(readFileSync(join(f.dir, f.journalFiles()[0]!), "utf8"), /"phase":"intent"/, "the intent survives for reconciliation");
});

test("product deployment fails closed on a corrupt, shared or unwritable journal", async (t) => {
  const f = fixture(t), provider = new FakeVercel();
  assert.ok((await f.service(provider).execute(actor, f.command())).ok);
  const file = join(f.dir, f.journalFiles()[0]!);
  const good = readFileSync(file, "utf8");
  writeFileSync(file, "{not json", { mode: 0o600 });
  assert.deepEqual(await f.service(provider).execute(actor, f.command()), { ok: false, code: "corrupt" });
  writeFileSync(file, JSON.stringify({ version: "product-deployment-v1", ownerKey: "0".repeat(64), operations: {} }), { mode: 0o600 });
  assert.deepEqual(await f.service(provider).execute(actor, f.command()), { ok: false, code: "corrupt" });
  replaceWithMode(file, good, 0o644);
  assert.deepEqual(await f.service(provider).execute(actor, f.command()), { ok: false, code: "unavailable" });
  replaceWithMode(file, good, 0o600);
  assert.ok((await f.service(provider).execute(actor, f.command())).ok);
  // A directory that others can read is never trusted.
  chmodSync(f.dir, 0o755);
  assert.deepEqual(await f.service(provider).execute(actor, f.command()), { ok: false, code: "unavailable" });
  chmodSync(f.dir, 0o700);
  // A failed durability barrier is unavailable and leaves no staged file behind.
  const other = fixture(t);
  const failing = other.service(new FakeVercel(), { sync: () => { throw new Error("fsync failed"); } });
  assert.deepEqual(await failing.execute(actor, other.command()), { ok: false, code: "unavailable" });
  assert.deepEqual(existsSync(other.dir) ? readdirSync(other.dir).filter((name) => name.endsWith(".pending")) : [], []);
  // The root must be a real absolute directory.
  mkdirSync(join(f.root, "elsewhere"), { recursive: true });
  assert.deepEqual(await new ProductDeploymentService({ root: "relative/path", provider, store: f.intents }).execute(actor, f.command()), { ok: false, code: "unavailable" });
});

test("product deployment reports a held lock and a journal write that fails on either side of the rename", async (t) => {
  const f = fixture(t), provider = new FakeVercel();
  assert.ok((await f.service(provider).execute(actor, f.command())).ok);
  const ownerKey = createHash("sha256").update(actor).digest("hex");
  const held = acquireInflightLock(join(f.dir, "locks"), ownerKey, { run_id: "held-by-another-request" });
  try { assert.deepEqual(await f.service(provider).execute(actor, f.command({ requestId: "deploy-request-000002" })), { ok: false, code: "busy" }); }
  finally { held.release(); }
  // A stage that cannot be flushed is discarded and nothing is renamed over the journal.
  const staged = fixture(t);
  const flushFails = staged.service(new FakeVercel(), { sync: (fd: number) => {
    if (fstatSync(fd).isFile()) { for (const name of readdirSync(staged.dir)) if (name.endsWith(".pending")) unlinkSync(join(staged.dir, name)); throw new Error("flush failed"); }
    fsyncSync(fd);
  } });
  assert.deepEqual(await flushFails.execute(actor, staged.command()), { ok: false, code: "unavailable" });
  assert.deepEqual(staged.journalFiles(), [], "no journal exists after a failed stage");
  // Once the rename happened, a failed directory flush is unknowable, never reported as a clean failure.
  const renamed = fixture(t);
  const dirFails = renamed.service(new FakeVercel(), { sync: (fd: number) => {
    if (fstatSync(fd).isDirectory() && renamed.journalFiles().length > 0) throw new Error("directory flush failed");
    fsyncSync(fd);
  } });
  assert.deepEqual(await dirFails.execute(actor, renamed.command()), { ok: false, code: "outcome_unknown" });
});

test("product deployment config accepts only a credentialed https or loopback origin", () => {
  const base = { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: TEAM };
  assert.deepEqual(vercelConfigFromEnv(base), { token: "tok", teamId: TEAM, baseUrl: "https://api.vercel.com" });
  assert.equal(vercelConfigFromEnv({ ...base, VERCEL_API_URL: "http://127.0.0.1:9/" })?.baseUrl, "http://127.0.0.1:9");
  assert.equal(vercelConfigFromEnv({}), undefined);
  assert.equal(vercelConfigFromEnv({ VERCEL_TOKEN: "tok" }), undefined);
  assert.equal(vercelConfigFromEnv({ VERCEL_TEAM_ID: TEAM }), undefined);
  assert.equal(vercelConfigFromEnv({ ...base, VERCEL_TEAM_ID: "bad id!" }), undefined);
  assert.equal(vercelConfigFromEnv({ ...base, VERCEL_API_URL: "http://evil.example" }), undefined, "a token is never sent in clear text to a remote origin");
  assert.equal(vercelConfigFromEnv({ ...base, VERCEL_API_URL: "https://user:pw@api.vercel.com" }), undefined);
  assert.equal(vercelConfigFromEnv({ ...base, VERCEL_API_URL: "not a url" }), undefined);
});

interface Seen { method: string; url: string; auth: string | undefined; body: string }
async function stub(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { seen, env: { VERCEL_TOKEN: "tok_live", VERCEL_TEAM_ID: TEAM, VERCEL_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } };
}

test("the default Vercel transport reads, creates and refuses over real HTTP", async (t) => {
  const project = { id: "prj_http", name: "wreckterra", accountId: TEAM, link: { type: "github", org: REPO.owner, repo: REPO.name, repoId: String(REPO.id) }, extra: true };
  const live = await stub(t, (req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
    if (req.method === "POST") { reply(req.url?.startsWith("/v10/projects") ? 200 : 500, {}); return; }
    if (req.url?.startsWith("/v9/projects/wreckterra")) reply(200, project);
    else if (req.url?.startsWith("/v9/projects/gone")) reply(404, {});
    else if (req.url?.startsWith("/v9/projects/malformed")) reply(200, "not json");
    else if (req.url?.startsWith("/v9/projects/shapeless")) reply(200, { id: 5 });
    else reply(500, {});
  });
  const provider = vercelDeploymentProvider(live.env);
  const resolved = provider.config(); assert.ok(resolved);
  const found = await provider.read(resolved, "wreckterra");
  assert.deepEqual(found, { state: "found", project: { id: "prj_http", name: "wreckterra", accountId: TEAM,
    link: { type: "github", org: REPO.owner, repo: REPO.name, repoId: REPO.id } } });
  assert.deepEqual(await provider.read(resolved, "gone"), { state: "absent" });
  assert.deepEqual(await provider.read(resolved, "malformed"), { state: "unreadable" });
  assert.deepEqual(await provider.read(resolved, "shapeless"), { state: "unreadable" });
  assert.deepEqual(await provider.read(resolved, "boom"), { state: "unreadable" });
  await provider.create(resolved, { name: "wreckterra", repository: REPO });
  const post = live.seen.find((entry) => entry.method === "POST"); assert.ok(post);
  assert.equal(post.auth, "Bearer tok_live");
  assert.ok(post.url.includes(`teamId=${TEAM}`), "every call is scoped to the configured team");
  assert.deepEqual(JSON.parse(post.body), { name: "wreckterra", gitRepository: { type: "github", repo: "craigoley/wreckterra" } });
  assert.ok(live.seen.every((entry) => entry.auth === "Bearer tok_live"));
  // An unreachable origin is an unreadable provider, never an absent project.
  const down = vercelDeploymentProvider({ VERCEL_TOKEN: "t", VERCEL_TEAM_ID: TEAM, VERCEL_API_URL: "http://127.0.0.1:1" });
  const unreachable = down.config(); assert.ok(unreachable);
  assert.deepEqual(await down.read(unreachable, "wreckterra"), { state: "unreadable" });
});

test("the default Vercel transport maps a refused or failed creation without leaking the token", async (t) => {
  let status = 403;
  const live = await stub(t, (_req, res) => { res.writeHead(status); res.end("{}"); });
  const provider = vercelDeploymentProvider(live.env);
  const resolved = provider.config(); assert.ok(resolved);
  await assert.rejects(provider.create(resolved, { name: "x", repository: REPO }), VercelDenied);
  status = 401;
  await assert.rejects(provider.create(resolved, { name: "x", repository: REPO }), VercelDenied);
  status = 500;
  await assert.rejects(provider.create(resolved, { name: "x", repository: REPO }), (error: Error) => error.message.includes("HTTP 500") && !error.message.includes("tok_live"));
});

test("the default Vercel transport drives the service end to end from a restart", async (t) => {
  const f = fixture(t);
  const store = new Map<string, unknown>();
  const live = await stub(t, (req, res, seen) => {
    const name = /\/v9\/projects\/([^?]+)/.exec(seen.url)?.[1];
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      const body = JSON.parse(seen.body) as { name: string; gitRepository: { repo: string } };
      store.set(body.name, { id: "prj_live", name: body.name, accountId: TEAM, link: { type: "github", org: "craigoley", repo: "wreckterra", repoId: REPO.id } });
      res.destroy(); // the response is lost after the provider succeeded
      return;
    }
    const found = name ? store.get(name) : undefined;
    res.writeHead(found ? 200 : 404); res.end(JSON.stringify(found ?? {}));
  });
  const service = new ProductDeploymentService({ root: f.root, env: live.env });
  const result = await service.execute(actor, f.command());
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.receipt.project.id, "prj_live");
  assert.equal(live.seen.filter((entry) => entry.method === "POST").length, 1);
});
