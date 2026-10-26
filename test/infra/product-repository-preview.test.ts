import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  ghProductRepositoryProvider, inspectProductRepository, type ProductRepositoryPreview,
  type ProductRepositoryProvider, type ProviderCapability, type ProviderRead, type ProviderRepository,
} from "#src/lib/product-repository.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const WRECKTERRA_ID = 1432832754;
const actor = "clerk:alice";
const found: ProviderRepository = { id: WRECKTERRA_ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" };

/** Records every provider call; a mutation is a call to create, which preview must never make. */
class FakeProvider implements ProductRepositoryProvider {
  calls: string[] = [];
  repo: ProviderRepository | undefined;
  reads: ProviderRead | undefined;
  capabilityResult: ProviderCapability = "user";
  throwOnRead = false;
  throwOnCapability = false;
  async read(owner: string, name: string): Promise<ProviderRead> {
    this.calls.push(`read ${owner}/${name}`);
    if (this.throwOnRead) throw new Error("transport down");
    if (this.reads) return this.reads;
    return this.repo ? { state: "found", repository: this.repo } : { state: "absent" };
  }
  async capability(owner: string): Promise<ProviderCapability> {
    this.calls.push(`capability ${owner}`);
    if (this.throwOnCapability) throw new Error("capability transport down");
    return this.capabilityResult;
  }
  async create(): Promise<void> { this.calls.push("create"); }
  mutations() { return this.calls.filter((call) => call === "create"); }
}

/** Every file under root with its bytes' digest, so "nothing written" is a byte-for-byte claim. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const path = join(root, entry);
    if (statSync(path).isFile()) out[entry] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return out;
}

function fixture(t: TestContext, requested: { owner: string; name: string } | undefined = { owner: "craigoley", name: "wreckterra" }) {
  const root = ownedFixtureDir(t, "product-repository-preview").dir;
  const store = new ProductIntentStore({ root });
  const saved = store.write(actor, { version: "product-intent-v1", requestId: "preview-product-0001", expectedRevision: 0,
    brief: { idea: "private idea", name: "Wreckterra", ...(requested ? { requestedRepository: requested } : {}) } });
  assert.ok(saved.ok);
  const id = saved.value.receipt.productId;
  const query = (over: Record<string, unknown> = {}) => ({ id, action: "adopt", owner: "craigoley", name: "wreckterra", ...over });
  const inspect = async (provider: ProductRepositoryProvider, over: Record<string, unknown> = {}) => {
    const result = await inspectProductRepository({ store: new ProductIntentStore({ root }), provider }, actor, query(over));
    assert.ok(result.ok, `expected an observation, got ${result.ok ? "" : result.code}`);
    return result.value;
  };
  return { root, store, id, query, inspect };
}

test("W1-T10726: preview observes the exact repository without mutation", async (t) => {
  const f = fixture(t);
  const provider = new FakeProvider();
  provider.repo = found;
  const before = snapshot(f.root);

  const adopt = await f.inspect(provider);
  assert.equal(adopt.state, "ready");
  assert.deepEqual(adopt.reasons, []);
  assert.deepEqual(adopt.repository, { provider: "github", id: WRECKTERRA_ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public" });
  assert.equal(adopt.revision, 1);
  assert.equal(adopt.objectiveRevision, 1);
  assert.equal(adopt.action, "adopt");
  assert.match(adopt.observedAt, /^\d{4}-\d\d-\d\dT/);

  // Adoption stays ready when creation capability alone is denied or unknowable.
  for (const capability of ["denied", "unknown"] as const) {
    provider.capabilityResult = capability;
    const again = await f.inspect(provider);
    assert.equal(again.state, "ready", `adoption is independent of creation capability ${capability}`);
    assert.equal(again.creation, capability);
  }

  // Adoption is ready only for the exact repository: a different canonical owner or name never is.
  provider.capabilityResult = "user";
  for (const returned of [{ owner: "someone-else" }, { name: "other-repo" }]) {
    provider.repo = { ...found, ...returned };
    const drifted = await f.inspect(provider);
    assert.deepEqual([drifted.state, drifted.reasons], ["conflict", ["requested_repository_mismatch"]]);
  }

  // Creation is ready only for an absent target with available capability, in both namespace scopes.
  provider.repo = undefined;
  for (const capability of ["user", "org"] as const) {
    provider.capabilityResult = capability;
    const create = await f.inspect(provider, { action: "create" });
    assert.equal(create.state, "ready");
    assert.deepEqual(create.reasons, ["repository_absent"]);
    assert.equal(create.creation, capability);
    assert.equal(create.repository, null);
  }

  // A fresh service instance observes the same product, and a bound product is never a create candidate.
  assert.deepEqual(snapshot(f.root), before, "success paths leave every product and journal byte unchanged");
  assert.deepEqual(provider.mutations(), [], "preview never calls create");
  assert.ok(provider.calls.every((call) => call.startsWith("read ") || call.startsWith("capability ")));
});

test("W1-T10726: unavailable and conflicting metadata never reads ready", async (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const ready = (preview: ProductRepositoryPreview) => preview.state === "ready";

  const unreadable = new FakeProvider();
  unreadable.reads = { state: "unreadable" };
  for (const action of ["adopt", "create"]) {
    const preview = await f.inspect(unreadable, { action });
    assert.equal(preview.state, "unavailable");
    assert.deepEqual(preview.reasons, ["provider_unreadable"]);
    assert.equal(preview.repository, null);
    assert.equal(preview.creation, "not_checked");
  }
  const throwing = new FakeProvider();
  throwing.throwOnRead = true;
  assert.equal((await f.inspect(throwing)).state, "unavailable", "a throwing read is unreadable, not absent");

  const absent = new FakeProvider();
  const missing = await f.inspect(absent);
  assert.equal(missing.state, "absent");
  assert.deepEqual(missing.reasons, ["repository_absent"]);
  assert.ok(!ready(missing), "adopting a missing repository is never ready");

  absent.capabilityResult = "denied";
  const denied = await f.inspect(absent, { action: "create" });
  assert.equal(denied.state, "denied");
  assert.deepEqual(denied.reasons, ["repository_absent", "creation_denied"]);
  absent.capabilityResult = "unknown";
  const unknown = await f.inspect(absent, { action: "create" });
  assert.equal(unknown.state, "unavailable");
  assert.deepEqual(unknown.reasons, ["repository_absent", "creation_unknown"]);
  absent.throwOnCapability = true;
  assert.equal((await f.inspect(absent, { action: "create" })).creation, "unknown", "a throwing capability read is unknown, not denied");

  const existing = new FakeProvider();
  existing.repo = found;
  const exists = await f.inspect(existing, { action: "create" });
  assert.equal(exists.state, "conflict");
  assert.deepEqual(exists.reasons, ["repository_exists"]);
  assert.equal(exists.repository?.id, WRECKTERRA_ID, "the conflicting repository identity is shown, not hidden");

  // Valid metadata for a different canonical repository is not the exact target: the returned owner and
  // name are each compared independently, and creation capability never rescues the mismatch.
  for (const capability of ["user", "denied", "unknown"] as const) {
    for (const returned of [{ owner: "someone-else" }, { name: "other-repo" }, { owner: "someone-else", name: "other-repo" }]) {
      const drifted = new FakeProvider();
      drifted.capabilityResult = capability;
      drifted.repo = { ...found, ...returned };
      const mismatch = await f.inspect(drifted);
      assert.equal(mismatch.state, "conflict", `returned ${JSON.stringify(returned)} with capability ${capability}`);
      assert.deepEqual(mismatch.reasons, ["requested_repository_mismatch"]);
      assert.ok(!ready(mismatch));
      assert.equal(mismatch.repository?.id, WRECKTERRA_ID, "the repository the provider actually returned is shown");
      assert.equal(mismatch.repository?.owner, returned.owner ?? found.owner);
      assert.equal(mismatch.repository?.name, returned.name ?? found.name);
      assert.deepEqual(drifted.mutations(), []);
    }
  }
  // Canonical casing differences are the same repository, not a mismatch.
  const recased = new FakeProvider();
  recased.repo = { ...found, owner: "CraigOley", name: "WreckTerra" };
  assert.equal((await f.inspect(recased)).state, "ready", "owner and name compare case-insensitively");

  // A different owner or name than the product requested is a conflict decided before any provider read.
  const untouched = new FakeProvider();
  untouched.repo = found;
  for (const over of [{ owner: "someone" }, { name: "other" }]) {
    const mismatch = await f.inspect(untouched, over);
    assert.equal(mismatch.state, "conflict");
    assert.deepEqual(mismatch.reasons, ["requested_repository_mismatch"]);
  }
  const stale = await f.inspect(untouched, { expectedRevision: 2 });
  assert.equal(stale.state, "stale");
  assert.equal((await f.inspect(untouched, { expectedObjectiveRevision: 9 })).state, "stale");
  assert.deepEqual(untouched.calls, [], "stale and mismatched requests spend no provider read");

  for (const bad of [{ action: "delete" }, { id: "nope" }, { owner: "" }, { name: ".." }, { extra: "1" }, { expectedRevision: "0" }]) {
    const result = await inspectProductRepository({ store: f.store, provider: untouched }, actor, f.query(bad));
    assert.deepEqual([result.ok, result.code], [false, "invalid_input"]);
  }
  assert.equal((await inspectProductRepository({ store: f.store, provider: untouched }, "  ", f.query())).code, "invalid_identity");
  assert.equal((await inspectProductRepository({ store: f.store, provider: untouched }, "clerk:bob", f.query())).code, "not_found");
  assert.deepEqual(snapshot(f.root), before, "failure paths leave every product and journal byte unchanged");
  assert.deepEqual(untouched.mutations().concat(existing.mutations(), absent.mutations()), []);
});

test("W1-T10726: a bound product is never a fresh create candidate and adoption must match its binding", async (t) => {
  const f = fixture(t);
  const bound = f.store.transition(actor, { version: "product-intent-v1", requestId: "preview-bind-000001", id: f.id,
    expectedRevision: 1, expectedObjectiveRevision: 1,
    repository: { provider: "github", id: WRECKTERRA_ID, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "public", verifiedAt: "2026-10-25T00:00:00.000Z" } });
  assert.ok(bound.ok);
  const provider = new FakeProvider();
  provider.repo = found;
  const create = await f.inspect(provider, { action: "create" });
  assert.deepEqual([create.state, create.reasons], ["conflict", ["product_already_bound"]]);
  assert.deepEqual(provider.calls, [], "a bound product spends no provider read on a create preview");
  assert.equal((await f.inspect(provider)).state, "ready", "the bound repository itself is still adoptable");
  provider.repo = { ...found, id: 7 };
  const other = await f.inspect(provider);
  assert.deepEqual([other.state, other.reasons], ["conflict", ["bound_repository_mismatch"]]);
  assert.equal(provider.mutations().length, 0);
});

test("W1-T10726: the real default transport reads through a controlled gh and keeps failures distinct", async (t) => {
  const shim = ghShim([
    { when: "api repos/craigoley/wreckterra", stdout: JSON.stringify({ id: WRECKTERRA_ID, name: "wreckterra", owner: { login: "craigoley" }, private: false, default_branch: "main" }) },
    { when: "api repos/craigoley/fresh", stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: "api repos/craigoley/broken", stderr: "gh: Server Error (HTTP 500)", exit: 1 },
    { when: "api repos/craigoley/garbled", stdout: "{\"id\":\"x\"}" },
    { when: "api user", stdout: JSON.stringify({ login: "craigoley" }) },
  ]);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const f = fixture(t);
  const before = snapshot(f.root);
  const provider = ghProductRepositoryProvider();
  const adopt = await f.inspect(provider);
  assert.equal(adopt.state, "ready");
  assert.equal(adopt.repository?.id, WRECKTERRA_ID);
  assert.equal(adopt.creation, "user");

  const missing = fixture(t, { owner: "craigoley", name: "fresh" });
  const create = await missing.inspect(provider, { action: "create", name: "fresh" });
  assert.deepEqual([create.state, create.creation], ["ready", "user"]);
  const broken = fixture(t, { owner: "craigoley", name: "broken" });
  assert.equal((await broken.inspect(provider, { name: "broken" })).state, "unavailable", "an HTTP 500 is unreadable, never absent");
  const garbled = fixture(t, { owner: "craigoley", name: "garbled" });
  assert.equal((await garbled.inspect(provider, { name: "garbled" })).state, "unavailable", "unparseable metadata is unreadable");
  assert.ok(!shim.calls().some((call) => call.includes("-X POST")), "the real transport makes no mutating call");
  assert.deepEqual(snapshot(f.root), before);

  // A fresh service over a viewer that cannot be read reports an unknown capability, never a denial.
  shim.addRoute({ when: "api user", stderr: "gh: Bad credentials (HTTP 401)", exit: 1 });
  assert.equal((await missing.inspect(ghProductRepositoryProvider(), { action: "create", name: "fresh" })).state, "unavailable");
});
