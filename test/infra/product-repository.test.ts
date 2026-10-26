import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, fstatSync, fsyncSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  ghProductRepositoryProvider, ProductRepositoryService, ProviderDenied,
  type ProductRepositoryProvider, type ProviderRead, type ProviderRepository,
} from "#src/lib/product-repository.js";
import { ProductIntentStore, productStatePaths } from "#src/lib/product-intent-store.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const WRECKTERRA_ID = 1432832754;
const actor = "clerk:alice";

/** A stateful provider double: real provider state survives a lost response, as GitHub's does. */
class FakeProvider implements ProductRepositoryProvider {
  repos = new Map<string, ProviderRepository>();
  calls: string[] = [];
  nextId = 900;
  capabilityResult: "user" | "org" | "denied" | "unknown" = "user";
  loseResponse = false;
  refuseCreate = false;
  readsDown = false;
  async read(owner: string, name: string): Promise<ProviderRead> {
    this.calls.push(`read ${owner}/${name}`);
    if (this.readsDown) return { state: "unreadable" };
    const found = this.repos.get(`${owner}/${name}`.toLowerCase());
    return found ? { state: "found", repository: found } : { state: "absent" };
  }
  async capability(owner: string) { this.calls.push(`capability ${owner}`); return this.capabilityResult; }
  async create(spec: { owner: string; name: string; visibility: "public" | "private" }): Promise<void> {
    this.calls.push(`create ${spec.owner}/${spec.name}`);
    if (this.refuseCreate) throw new ProviderDenied("refused");
    this.repos.set(`${spec.owner}/${spec.name}`.toLowerCase(), { id: this.nextId++, owner: spec.owner, name: spec.name, defaultBranch: "main", visibility: spec.visibility });
    if (this.loseResponse) { this.readsDown = false; throw new Error("socket hang up after provider success"); }
  }
  creates() { return this.calls.filter((call) => call.startsWith("create ")); }
}

function fixture(t: TestContext) {
  const root = ownedFixtureDir(t, "product-repository").dir;
  const intents = new ProductIntentStore({ root });
  const saved = intents.write(actor, { version: "product-intent-v1", requestId: "repo-product-000001", expectedRevision: 0,
    brief: { idea: "private idea", name: "Wreckterra", requestedRepository: { owner: "craigoley", name: "wreckterra" } } });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  const command = (over: Record<string, unknown> = {}) => {
    const current = intents.read(actor, productId); assert.ok(current.ok);
    return { version: "product-repository-v1", requestId: "repo-request-0000001", productId,
      expectedRevision: current.value.revision, expectedObjectiveRevision: current.value.objectiveRevision,
      action: "create", owner: "craigoley", name: "wreckterra", visibility: "public", ...over };
  };
  const journalFiles = () => existsSync(join(root, "state/products/v1/repositories"))
    ? readdirSync(join(root, "state/products/v1/repositories")).filter((file) => file.endsWith(".json")) : [];
  return { root, productId, command, journalFiles, service: (provider: ProductRepositoryProvider, extra: object = {}) => new ProductRepositoryService({ root, provider, ...extra }) };
}

function replaceJournalMode(file: string, mode: number): void {
  const body = readFileSync(file, "utf8"), mask = process.umask(0);
  try { unlinkSync(file); writeFileSync(file, body, { mode }); }
  finally { process.umask(mask); }
}

test("W1-T10613: adopting Wreckterra never creates a repository", async (t) => {
  const f = fixture(t);
  const provider = new FakeProvider();
  provider.repos.set("craigoley/wreckterra", { id: WRECKTERRA_ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" });
  const adopt = f.command({ action: "adopt", repositoryId: WRECKTERRA_ID });
  const first = await f.service(provider).execute(actor, adopt);
  assert.ok(first.ok);
  assert.equal(first.value.receipt.outcome, "adopted");
  assert.equal(first.value.receipt.repository.id, WRECKTERRA_ID);
  assert.equal(first.value.receipt.repository.visibility, "public");
  assert.equal(first.value.replayed, false);
  // A fresh service (restart) replays the same receipt and still never creates or probes creation capability.
  const again = await f.service(provider).execute(actor, adopt);
  assert.ok(again.ok);
  assert.equal(again.value.replayed, true);
  assert.deepEqual(again.value.receipt, first.value.receipt);
  assert.deepEqual(provider.creates(), []);
  assert.ok(!provider.calls.some((call) => call.startsWith("capability")));
  // A different repository ID for the same name is a conflict, never an adoption.
  const wrongId = await f.service(provider).execute(actor, f.command({ requestId: "repo-request-0000002", action: "adopt", repositoryId: WRECKTERRA_ID + 1 }));
  assert.deepEqual(wrongId, { ok: false, code: "repository_conflict" });
  assert.deepEqual(provider.creates(), []);
});

test("product repository adoption reaches the canonical product identity and stage evidence", async (t) => {
  const f = fixture(t);
  const provider = new FakeProvider();
  provider.repos.set("craigoley/wreckterra", { id: WRECKTERRA_ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" });
  const result = await f.service(provider).execute(actor, f.command({ action: "adopt", repositoryId: WRECKTERRA_ID }));
  assert.ok(result.ok);
  const saved = new ProductIntentStore({ root: f.root }).read(actor, f.productId);
  assert.ok(saved.ok);
  assert.deepEqual(saved.value.repository, result.value.receipt.repository);
  assert.equal(saved.value.stageEvidence.filter((entry) => entry.stage === "repository" && entry.outcome === "succeeded" && entry.objectiveRevision === saved.value.objectiveRevision).length, 1);
  assert.equal(saved.value.executionAuthority, "none");
  assert.deepEqual(provider.creates(), []);
});

test("a journaled unknown create is never submitted again when reconciliation reads absent", async (t) => {
  const f = fixture(t);
  const provider = new FakeProvider();
  provider.create = async (spec) => { provider.calls.push(`create ${spec.owner}/${spec.name}`); throw Error("unknown response; read-back may lag"); };
  const request = f.command();
  assert.deepEqual(await f.service(provider).execute(actor, request), { ok: false, code: "outcome_unknown" });
  assert.equal(provider.creates().length, 1);
  assert.deepEqual(await f.service(provider).execute(actor, request), { ok: false, code: "outcome_unknown" });
  assert.equal(provider.creates().length, 1, "a 404 does not prove that the earlier POST was never accepted");
});

test("repository adoption refuses stale product scope before any provider call", async (t) => {
  const f = fixture(t), provider = new FakeProvider();
  const request = f.command({ action: "adopt", repositoryId: WRECKTERRA_ID });
  const store = new ProductIntentStore({ root: f.root });
  const product = store.read(actor, f.productId); assert.ok(product.ok);
  assert.ok(store.write(actor, { version: "product-intent-v1", requestId: "changed-objective-0001", id: f.productId,
    expectedRevision: product.value.revision, brief: { ...product.value.brief, idea: "A changed objective" } }).ok);
  assert.deepEqual(await f.service(provider).execute(actor, request), { ok: false, code: "stale_revision" });
  assert.deepEqual(provider.calls, []);
  assert.deepEqual(f.journalFiles(), []);
});

test("repository adoption replays the canonical durability barrier after an unknown acknowledgement", async (t) => {
  const f = fixture(t), provider = new FakeProvider();
  provider.repos.set("craigoley/wreckterra", { id: WRECKTERRA_ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" });
  const state = productStatePaths(f.root, actor).state;
  const broken = new ProductIntentStore({ root: f.root, sync: (fd) => {
    if (fstatSync(fd).isDirectory() && JSON.parse(readFileSync(state, "utf8")).products[f.productId].stageEvidence.length > 0) throw Error("canonical directory sync failed");
    fsyncSync(fd);
  } });
  const request = f.command({ action: "adopt", repositoryId: WRECKTERRA_ID });
  const service = f.service(provider, { store: broken });
  assert.deepEqual(await service.execute(actor, request), { ok: false, code: "outcome_unknown" });
  assert.deepEqual(await service.execute(actor, request), { ok: false, code: "outcome_unknown" });
  const healed = await f.service(provider).execute(actor, request); assert.ok(healed.ok);
  assert.equal(healed.value.replayed, true);
  const product = new ProductIntentStore({ root: f.root }).read(actor, f.productId); assert.ok(product.ok);
  assert.equal(product.value.repository?.id, WRECKTERRA_ID);
  assert.equal(product.value.stageEvidence.length, 1);
  assert.deepEqual(provider.creates(), []);
});

test("W1-T10613: a lost creation response reconciles one repository after restart", async (t) => {
  const f = fixture(t);
  const provider = new FakeProvider();
  provider.loseResponse = true;
  // The provider created the repository, the response was lost, and the read-back is also down.
  const originalCreate = provider.create.bind(provider);
  provider.create = async (spec) => { try { await originalCreate(spec); } finally { provider.readsDown = true; } };
  const lost = await f.service(provider).execute(actor, f.command());
  assert.deepEqual(lost, { ok: false, code: "outcome_unknown" });
  assert.equal(provider.repos.size, 1);
  const journal = readFileSync(join(f.root, "state/products/v1/repositories", f.journalFiles()[0]!), "utf8");
  assert.match(journal, /"phase":"intent"/, "the intent was durable before the lost create call");
  // Concurrent duplicate retries after a restart: provider is readable again; exactly one repository, one create ever.
  provider.readsDown = false;
  const results = await Promise.all([f.service(provider).execute(actor, f.command()), f.service(provider).execute(actor, f.command()), f.service(provider).execute(actor, f.command())]);
  for (const result of results) assert.ok(result.ok);
  assert.equal(provider.creates().length, 1);
  assert.equal(provider.repos.size, 1);
  const ids = new Set(results.map((result) => result.ok ? result.value.receipt.repository.id : 0));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((result) => result.ok && !result.value.replayed).length, 1);
  assert.ok(results.every((result) => result.ok && result.value.receipt.outcome === "created"));
  // A same-process lost response with a readable provider reconciles immediately without a second create.
  const second = fixture(t);
  const other = new FakeProvider();
  other.loseResponse = true;
  const reconciled = await second.service(other).execute(actor, second.command());
  assert.ok(reconciled.ok);
  assert.equal(other.creates().length, 1);
});

test("W1-T10613: denied or conflicting repository ownership writes nothing", async (t) => {
  const f = fixture(t);
  const provider = new FakeProvider();
  provider.capabilityResult = "denied";
  assert.deepEqual(await f.service(provider).execute(actor, f.command()), { ok: false, code: "creation_denied" });
  assert.deepEqual(f.journalFiles(), [], "a denied organization creation leaves no journal");
  assert.deepEqual(provider.creates(), []);
  // Provider-side refusal after the capability check retires the intent: nothing was created, nothing is recorded.
  provider.capabilityResult = "org";
  provider.refuseCreate = true;
  assert.deepEqual(await f.service(provider).execute(actor, f.command()), { ok: false, code: "creation_denied" });
  const journal = JSON.parse(readFileSync(join(f.root, "state/products/v1/repositories", f.journalFiles()[0]!), "utf8"));
  assert.deepEqual(journal.operations, {});
  provider.refuseCreate = false;
  // An existing repository is never claimed by a create, and a brief naming another repository is refused.
  provider.calls = [];
  provider.repos.set("craigoley/wreckterra", { id: 5, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" });
  assert.deepEqual(await f.service(provider).execute(actor, f.command()), { ok: false, code: "repository_conflict" });
  assert.deepEqual(await f.service(provider).execute(actor, f.command({ requestId: "repo-request-0000003", name: "other-name" })), { ok: false, code: "repository_conflict" });
  assert.deepEqual(await f.service(provider).execute(actor, f.command({ requestId: "repo-request-0000004", action: "adopt", repositoryId: 5, visibility: "private" })), { ok: false, code: "repository_conflict" });
  assert.deepEqual(provider.creates(), []);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(f.root, "state/products/v1/repositories", f.journalFiles()[0]!), "utf8")).operations), []);
  // Another operator neither sees the product nor writes a journal.
  const other = fixture(t);
  assert.deepEqual(await other.service(provider).execute("clerk:bob", other.command()), { ok: false, code: "not_found" });
  assert.deepEqual(other.journalFiles(), []);
});

test("product repository refuses malformed commands, mixed actions, identity gaps and unreadable providers", async (t) => {
  const f = fixture(t);
  const provider = new FakeProvider();
  const service = f.service(provider);
  assert.deepEqual(await service.execute("", f.command()), { ok: false, code: "invalid_identity" });
  for (const bad of [f.command({ repositoryId: 3 }), f.command({ action: "adopt" }), f.command({ owner: "-x" }), f.command({ extra: 1 }), f.command({ visibility: "internal" }), "text", null]) {
    assert.deepEqual(await service.execute(actor, bad), { ok: false, code: "invalid_input" });
  }
  assert.deepEqual(await service.execute(actor, f.command({ productId: "prd_" + "0".repeat(32) })), { ok: false, code: "not_found" });
  provider.readsDown = true;
  assert.deepEqual(await service.execute(actor, f.command()), { ok: false, code: "provider_unreadable" });
  provider.readsDown = false;
  provider.capabilityResult = "unknown";
  assert.deepEqual(await service.execute(actor, f.command()), { ok: false, code: "provider_unreadable" });
  assert.deepEqual(provider.creates(), []);
  assert.deepEqual(await new ProductRepositoryService({ provider }).execute(actor, f.command()), { ok: false, code: "unavailable" });
  provider.capabilityResult = "user";
  provider.refuseCreate = false;
  const done = await service.execute(actor, f.command());
  assert.ok(done.ok);
  // Same request id with a changed command conflicts; a second operation on a bound product elsewhere conflicts.
  assert.deepEqual(await service.execute(actor, f.command({ visibility: "private" })), { ok: false, code: "idempotency_conflict" });
  assert.deepEqual(await service.execute(actor, f.command({ requestId: "repo-request-0000009", name: "wreckterra2" })), { ok: false, code: "repository_conflict" });
});

test("product repository journal durability: sync failures, corruption and unsafe modes are explicit", async (t) => {
  const f = fixture(t);
  const provider = new FakeProvider();
  let failing = false;
  let budget = Infinity;
  const sync = (fd: number) => { if (failing || --budget < 0) throw new Error("fsync failed"); void fd; };
  const service = f.service(provider, { sync });
  const adopted = new FakeProvider();
  adopted.repos.set("craigoley/wreckterra", { id: 7, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" });
  failing = true;
  assert.deepEqual(await f.service(adopted, { sync }).execute(actor, f.command({ action: "adopt", repositoryId: 7 })), { ok: false, code: "unavailable" });
  failing = false;
  const receipt = await f.service(adopted, { sync }).execute(actor, f.command({ action: "adopt", repositoryId: 7 }));
  assert.ok(receipt.ok);
  budget = 4; // the four ancestry syncs pass; the replay's own directory requalification fails
  const replay = await f.service(adopted, { sync }).execute(actor, f.command({ action: "adopt", repositoryId: 7 }));
  assert.deepEqual(replay, { ok: false, code: "outcome_unknown" }, "a replay is requalified by a directory fsync");
  budget = Infinity;
  assert.ok(service);
  const file = join(f.root, "state/products/v1/repositories", f.journalFiles()[0]!);
  replaceJournalMode(file, 0o644);
  assert.deepEqual(await f.service(adopted).execute(actor, f.command({ action: "adopt", repositoryId: 7 })), { ok: false, code: "unavailable" });
  replaceJournalMode(file, 0o600);
  writeFileSync(file, "{not json");
  assert.deepEqual(await f.service(adopted).execute(actor, f.command({ action: "adopt", repositoryId: 7 })), { ok: false, code: "corrupt" });
  writeFileSync(file, JSON.stringify({ version: "product-repository-v1", ownerKey: "0".repeat(64), operations: {} }));
  assert.deepEqual(await f.service(adopted).execute(actor, f.command({ action: "adopt", repositoryId: 7 })), { ok: false, code: "corrupt" });
});

test("the default gh provider reads, probes capability and creates through the real transport", async (t) => {
  const shim = ghShim([
    { when: "api repos/craigoley/missing", stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: "api repos/craigoley/forbidden", stderr: "gh: Forbidden (HTTP 403)", exit: 1 },
    { when: "api repos/craigoley/garbled", stdout: "{nope" },
    { when: "api repos/craigoley/wreckterra", stdout: JSON.stringify({ id: WRECKTERRA_ID, name: "wreckterra", owner: { login: "craigoley" }, private: false, default_branch: "main" }) },
    { when: "api repos/craigoley/hidden", stdout: JSON.stringify({ id: 3, name: "hidden", owner: { login: "craigoley" }, private: true, default_branch: "dev" }) },
    { when: "api user/memberships/orgs/acme", stdout: JSON.stringify({ state: "active" }) },
    { when: "api user/memberships/orgs/pending-org", stdout: JSON.stringify({ state: "pending" }) },
    { when: "api user/memberships/orgs/nope", stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: "api user/memberships/orgs/flaky", stderr: "gh: Bad Gateway (HTTP 502)", exit: 1 },
    { when: "api -X POST orgs/denied/repos", stderr: "gh: Forbidden (HTTP 403)", exit: 1 },
    { when: "api -X POST orgs/broken/repos", stderr: "gh: boom (HTTP 500)", exit: 1 },
    { when: "api user", stdout: JSON.stringify({ login: "craigoley" }) },
  ]);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const provider = ghProductRepositoryProvider();
  const found = await provider.read("craigoley", "wreckterra");
  assert.deepEqual(found, { state: "found", repository: { id: WRECKTERRA_ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" } });
  assert.deepEqual(await provider.read("craigoley", "hidden"), { state: "found", repository: { id: 3, owner: "craigoley", name: "hidden", defaultBranch: "dev", visibility: "private" } });
  assert.deepEqual(await provider.read("craigoley", "missing"), { state: "absent" });
  assert.deepEqual(await provider.read("craigoley", "forbidden"), { state: "unreadable" });
  assert.deepEqual(await provider.read("craigoley", "garbled"), { state: "unreadable" });
  assert.equal(await provider.capability("CraigOley"), "user");
  assert.equal(await provider.capability("acme"), "org");
  assert.equal(await provider.capability("pending-org"), "denied");
  assert.equal(await provider.capability("nope"), "denied");
  assert.equal(await provider.capability("flaky"), "unknown");
  await provider.create({ owner: "craigoley", name: "fresh", visibility: "private", scope: "user" });
  assert.ok(shim.calls().some((call) => call.includes("api -X POST user/repos -f name=fresh -F private=true")));
  await assert.rejects(provider.create({ owner: "denied", name: "x", visibility: "public", scope: "org" }), ProviderDenied);
  await assert.rejects(provider.create({ owner: "broken", name: "x", visibility: "public", scope: "org" }), (error) => !(error instanceof ProviderDenied));
});

test("the default gh provider reports an unknown capability when the viewer cannot be read", async (t) => {
  const shim = ghShim([{ when: "api user", stdout: "{nope" }]);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  assert.equal(await ghProductRepositoryProvider().capability("craigoley"), "unknown");
});

test("product repository commit failures are classified: before the rename unavailable, after it outcome_unknown then recovered", async (t) => {
  const f = fixture(t);
  const provider = new FakeProvider();
  provider.repos.set("craigoley/wreckterra", { id: 7, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" });
  let budget = Infinity;
  const sync = () => { if (--budget < 0) throw new Error("fsync failed"); };
  const adopt = f.command({ action: "adopt", repositoryId: 7 });
  budget = 4; // four ancestry syncs pass; the journal file's own sync fails before the rename
  assert.deepEqual(await f.service(provider, { sync }).execute(actor, adopt), { ok: false, code: "unavailable" });
  assert.ok(!readdirSync(join(f.root, "state/products/v1/repositories")).some((file) => file.endsWith(".pending")), "the failed temporary is removed");
  assert.deepEqual(f.journalFiles(), []);
  budget = 5; // the file sync passes and the rename lands; the directory sync after it fails
  assert.deepEqual(await f.service(provider, { sync }).execute(actor, adopt), { ok: false, code: "outcome_unknown" });
  budget = Infinity;
  const recovered = await f.service(provider, { sync }).execute(actor, adopt);
  assert.ok(recovered.ok);
  assert.equal(recovered.value.replayed, true, "the committed journal answers the identical retry without another provider write");
  assert.deepEqual(provider.creates(), []);
});

test("product repository serializes per operator: a live lock is busy and an unusable lock directory is unavailable", async (t) => {
  const f = fixture(t);
  const provider = new FakeProvider();
  const service = f.service(provider);
  const directory = join(f.root, "state/products/v1/repositories");
  assert.deepEqual(await service.execute(actor, f.command({ action: "adopt", repositoryId: 7 })), { ok: false, code: "repository_not_found" });
  const locks = join(directory, "locks");
  const lockFile = join(locks, `${createHash("sha256").update(actor).digest("hex")}.lock`);
  mkdirSync(locks, { recursive: true });
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, run_id: "held", host: "h", startedAt: new Date().toISOString() }));
  assert.deepEqual(await service.execute(actor, f.command({ action: "adopt", repositoryId: 7 })), { ok: false, code: "busy" });
  rmSync(locks, { recursive: true });
  writeFileSync(locks, "not a directory");
  assert.deepEqual(await service.execute(actor, f.command({ action: "adopt", repositoryId: 7 })), { ok: false, code: "unavailable" });
});
