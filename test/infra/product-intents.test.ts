import assert from "node:assert/strict";
import { fsyncSync, fstatSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ProductIntentStore, productStatePaths } from "#src/lib/product-intent-store.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const ACTOR = "clerk:alice";
const brief = {
  name: "Wreckterra", idea: "An original mobile combat game in real locations", portfolio: "OleyArcade",
  objective: "Play a solo Central Park skirmish",
  decisions: [{ key: "players", value: "solo first", provenance: { kind: "operator", reference: "approved brief" } }],
  research: [{ label: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright" }],
  requestedRepository: { owner: "craigoley", name: "wreckterra" },
  resourceEnvelope: { budgetUsd: 30, maxConcurrentBuilds: 1, existingSetupOnly: true },
};
const create = { version: "product-intent-v1", requestId: "fixture-create-0001", expectedRevision: 0, brief };

test("W1-T10612: product brief survives restart and rejects another principal", (t) => {
  const root = ownedFixtureDir(t, "product-intent").dir;
  const saved = new ProductIntentStore({ root }).write(ACTOR, create);
  assert.ok(saved.ok);
  const restarted = new ProductIntentStore({ root });
  const read = restarted.read(ACTOR, saved.value.receipt.productId);
  assert.ok(read.ok);
  assert.deepEqual(read.value.brief, brief);
  assert.equal(read.value.revision, 1);
  assert.equal(read.value.objectiveRevision, 1);
  assert.equal(read.value.repository, null, "a requested repository is not a verified binding");
  assert.deepEqual(read.value.stageEvidence, []);
  assert.equal(restarted.read("clerk:bob", read.value.id).code, "not_found");
  const other = restarted.list("clerk:bob");
  assert.ok(other.ok);
  assert.deepEqual(other.value, []);
  assert.equal(statSync(productStatePaths(root, ACTOR).state).mode & 0o777, 0o600);
  const unsafe = productStatePaths(root, "../../outside");
  assert.ok(!relative(root, unsafe.state).startsWith(".."));
});

test("W1-T10612: product writes reject stale revisions and replay the same request once", (t) => {
  const root = ownedFixtureDir(t, "product-revisions").dir;
  const store = new ProductIntentStore({ root });
  const first = store.write(ACTOR, create);
  assert.ok(first.ok);
  const retry = new ProductIntentStore({ root }).write(ACTOR, create);
  assert.ok(retry.ok);
  assert.equal(retry.value.replayed, true);
  assert.deepEqual(retry.value.receipt, first.value.receipt);
  const update = { version: "product-intent-v1", id: first.value.receipt.productId, requestId: "fixture-update-0002", expectedRevision: 1,
    brief: { ...brief, objective: "Complete a Central Park combat match" } };
  const second = store.write(ACTOR, update);
  assert.ok(second.ok);
  assert.equal(second.value.receipt.revision, 2);
  assert.equal(store.write(ACTOR, { ...update, requestId: "fixture-stale-0003" }).code, "stale_revision");
  assert.equal(store.write(ACTOR, { ...create, brief: { ...brief, name: "Changed payload" } }).code, "idempotency_conflict");
  const olderRetry = store.write(ACTOR, create);
  assert.ok(olderRetry.ok);
  assert.deepEqual(olderRetry.value.receipt, first.value.receipt);
  const latest = store.read(ACTOR, update.id);
  assert.ok(latest.ok);
  assert.equal(latest.value.objectiveRevision, 2);
  assert.deepEqual(latest.value.history.map((item) => item.revision), [1, 2]);
  const listed = store.list(ACTOR);
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 1);
  assert.ok(!JSON.stringify(listed.value).includes(brief.idea), "list summaries do not return the source idea");
});

test("corrupt or unreadable product state cannot become an empty successful store", (t) => {
  const root = ownedFixtureDir(t, "product-corruption").dir;
  const store = new ProductIntentStore({ root });
  assert.ok(store.write(ACTOR, create).ok);
  const path = productStatePaths(root, ACTOR).state;
  writeFileSync(path, "{broken");
  assert.equal(store.list(ACTOR).code, "corrupt");
  assert.equal(store.write(ACTOR, create).code, "corrupt");
  writeFileSync(path, "{}");
  assert.equal(store.list(ACTOR).code, "corrupt");
  unlinkSync(path);
  const elsewhere = join(root, "elsewhere.json");
  writeFileSync(elsewhere, "secret outside the product state");
  symlinkSync(elsewhere, path);
  assert.equal(store.list(ACTOR).code, "unavailable");
  assert.equal(readFileSync(elsewhere, "utf8"), "secret outside the product state");
  assert.equal(new ProductIntentStore({}).list(ACTOR).code, "unavailable");
});

test("product writes refuse actor claims, forged evidence and oversized or invalid briefs", (t) => {
  const root = ownedFixtureDir(t, "product-validation").dir;
  const store = new ProductIntentStore({ root });
  assert.equal(store.write("", create).code, "invalid_identity");
  for (const command of [
    { ...create, owner: "clerk:bob" },
    { ...create, stageEvidence: [{ outcome: "succeeded" }] },
    { ...create, brief: { ...brief, idea: "x".repeat(70_000) } },
    { ...create, brief: { ...brief, requestedRepository: { owner: "../outside", name: "escape" } } },
    { ...create, brief: { ...brief, research: [{ label: "secret", url: "https://user:password@example.com/" }] } },
  ]) assert.equal(store.write(ACTOR, command).code, "invalid_input");
  const listed = store.list(ACTOR);
  assert.ok(listed.ok);
  assert.deepEqual(listed.value, []);
});

test("the product transaction owns a real exclusive lock and returns an explicit busy outcome", (t) => {
  const root = ownedFixtureDir(t, "product-lock").dir;
  const contender = new ProductIntentStore({ root });
  let busy: string | undefined;
  const writer = new ProductIntentStore({ root, sync(fd) {
    if (busy === undefined) busy = contender.write(ACTOR, { ...create, requestId: "fixture-contender-0002" }).code;
    fsyncSync(fd);
  } });
  assert.ok(writer.write(ACTOR, create).ok);
  assert.equal(busy, "busy");
  assert.ok(contender.write(ACTOR, { ...create, requestId: "fixture-after-lock-0003" }).ok);
});

test("a post-rename sync failure is unknown and reconciles through the durable request receipt", (t) => {
  const root = ownedFixtureDir(t, "product-unknown").dir;
  const interrupted = new ProductIntentStore({ root, sync(fd) {
    if (fstatSync(fd).isDirectory()) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
    fsyncSync(fd);
  } });
  assert.equal(interrupted.write(ACTOR, create).code, "outcome_unknown");
  const recovered = new ProductIntentStore({ root });
  const receipt = recovered.receipt(ACTOR, create.requestId);
  assert.ok(receipt.ok);
  const retry = recovered.write(ACTOR, create);
  assert.ok(retry.ok);
  assert.equal(retry.value.replayed, true);
  assert.deepEqual(retry.value.receipt, receipt.value);
  const listed = recovered.list(ACTOR);
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 1);
});

test("a pre-rename failure leaves the prior product revision intact", (t) => {
  const root = ownedFixtureDir(t, "product-uncommitted").dir;
  const normal = new ProductIntentStore({ root });
  const created = normal.write(ACTOR, create);
  assert.ok(created.ok);
  const failing = new ProductIntentStore({ root, sync() { throw new Error("file sync failed"); } });
  const update = { ...create, id: created.value.receipt.productId, requestId: "fixture-update-failed", expectedRevision: 1 };
  assert.equal(failing.write(ACTOR, update).code, "unavailable");
  assert.equal(normal.receipt(ACTOR, update.requestId).code, "not_found");
  const original = normal.read(ACTOR, update.id);
  assert.ok(original.ok);
  assert.equal(original.value.revision, 1);
});

test("bounded product and receipt capacity refuses new writes without losing old acknowledgments", (t) => {
  const root = ownedFixtureDir(t, "product-capacity").dir;
  const store = new ProductIntentStore({ root, limits: { maxProducts: 1, maxRequests: 2 } });
  const first = store.write(ACTOR, create);
  assert.ok(first.ok);
  assert.equal(store.write(ACTOR, { ...create, requestId: "fixture-over-product" }).code, "capacity");
  assert.ok(store.write(ACTOR, { ...create, id: first.value.receipt.productId, expectedRevision: 1, requestId: "fixture-update-0002" }).ok);
  assert.equal(store.write(ACTOR, { ...create, id: first.value.receipt.productId, expectedRevision: 2, requestId: "fixture-over-receipts" }).code, "capacity");
  assert.ok(store.write(ACTOR, create).ok, "an acknowledged request still replays at capacity");
});
