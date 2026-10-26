import assert from "node:assert/strict";
import fs, { chmodSync, fsyncSync, fstatSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ProductIntentStore, productStatePaths } from "#src/lib/product-intent-store.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { declaredBody, violations } from "#test/helpers/openapi-strict.js";

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
  const original = readFileSync(path, "utf8");
  chmodSync(path, 0o644);
  assert.equal(store.list(ACTOR).code, "unavailable", "private product records refuse a publicly readable state file");
  chmodSync(path, 0o600);
  const wrongIdentity = JSON.parse(original);
  const key = Object.keys(wrongIdentity.products)[0]!;
  wrongIdentity.products[`prd_${"a".repeat(32)}`] = wrongIdentity.products[key];
  delete wrongIdentity.products[key];
  writeFileSync(path, JSON.stringify(wrongIdentity));
  assert.equal(store.list(ACTOR).code, "corrupt", "the keyed identity must match the stored product identity");
  const duplicate = JSON.parse(original);
  duplicate.receipts["f".repeat(64)] = Object.values(duplicate.receipts)[0];
  writeFileSync(path, JSON.stringify(duplicate));
  assert.equal(store.list(ACTOR).code, "corrupt", "one revision cannot have two committed command receipts");
  const overBudget = JSON.parse(original);
  const donor = Object.values(overBudget.products)[0] as Record<string, unknown>;
  overBudget.products = Object.fromEntries(Array.from({ length: 65 }, (_, index) => {
    const id = `prd_${index.toString(16).padStart(32, "0")}`;
    return [id, { ...donor, id }];
  }));
  writeFileSync(path, JSON.stringify(overBudget));
  assert.equal(store.list(ACTOR).code, "corrupt", "a structurally valid record cannot exceed the maintained collection quota");
  const changed = JSON.parse(original);
  Object.values(changed.products as Record<string, { brief: { idea: string } }>)[0]!.brief.idea = "Changed without a durable receipt";
  writeFileSync(path, JSON.stringify(changed));
  assert.equal(store.list(ACTOR).code, "corrupt", "valid JSON must agree with the committed record digest");
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

test("product state rejects invalid UTF-8 rather than decoding it as a different saved idea", (t) => {
  const root = ownedFixtureDir(t, "product-encoding").dir;
  const store = new ProductIntentStore({ root });
  assert.ok(store.write(ACTOR, { ...create, brief: { ...brief, idea: "replacement \uFFFD" } }).ok);
  const path = productStatePaths(root, ACTOR).state;
  const body = readFileSync(path);
  const offset = body.indexOf(Buffer.from("\uFFFD"));
  assert.ok(offset >= 0);
  writeFileSync(path, Buffer.concat([body.subarray(0, offset), Buffer.from([0xff]), body.subarray(offset + 3)]));
  assert.equal(store.list(ACTOR).code, "corrupt");
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

test("product replay and receipt lookup stay unknown until the renamed state directory syncs", (t) => {
  const root = ownedFixtureDir(t, "product-replay-durability").dir;
  let failedSyncs = 0;
  const interrupted = new ProductIntentStore({ root, sync(fd) {
    if (fstatSync(fd).isDirectory()) {
      failedSyncs++;
      throw Object.assign(new Error("directory sync remains unavailable"), { code: "EIO" });
    }
    fsyncSync(fd);
  } });
  assert.equal(interrupted.write(ACTOR, create).code, "outcome_unknown");
  const path = productStatePaths(root, ACTOR).state;
  const renamed = readFileSync(path);
  assert.equal(interrupted.write(ACTOR, create).code, "outcome_unknown");
  assert.equal(interrupted.receipt(ACTOR, create.requestId).code, "outcome_unknown");
  assert.equal(failedSyncs, 3, "both recovery paths retry the failed directory sync");
  let recoveredSyncs = 0;
  const recovered = new ProductIntentStore({ root, sync(fd) {
    assert.ok(fstatSync(fd).isDirectory(), "recovery syncs the existing directory without rewriting state");
    recoveredSyncs++;
    fsyncSync(fd);
  } });
  const receipt = recovered.receipt(ACTOR, create.requestId);
  assert.ok(receipt.ok);
  const replay = recovered.write(ACTOR, create);
  assert.ok(replay.ok);
  assert.equal(replay.value.replayed, true);
  assert.deepEqual(replay.value.receipt, receipt.value);
  assert.equal(recoveredSyncs, 2);
  assert.deepEqual(readFileSync(path), renamed, "recovery preserves the original product and receipt bytes");
  const product = recovered.read(ACTOR, receipt.value.productId);
  assert.ok(product.ok);
  assert.equal(product.value.revision, 1);
  assert.equal(product.value.history.length, 1);
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

test("post-rename close failure remains unknown and a failed cleanup preserves one bounded recovery artifact", (t) => {
  const root = ownedFixtureDir(t, "product-cleanup").dir;
  const close = fs.closeSync;
  t.mock.method(fs, "closeSync", (fd: number) => {
    const directory = fstatSync(fd).isDirectory();
    close(fd);
    if (directory && fs.existsSync(productStatePaths(root, ACTOR).state)) throw Object.assign(new Error("directory close failed"), { code: "EIO" });
  });
  syncBuiltinESMExports();
  try { assert.equal(new ProductIntentStore({ root }).write(ACTOR, create).code, "outcome_unknown"); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.ok(new ProductIntentStore({ root }).receipt(ACTOR, create.requestId).ok);
  const pending = productStatePaths(root, "clerk:bob").pending;
  const unlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (path: fs.PathLike) => {
    if (path === pending) throw Object.assign(new Error("owned pending cleanup failed"), { code: "EACCES" });
    unlink(path);
  });
  syncBuiltinESMExports();
  try {
    const failing = new ProductIntentStore({ root, sync() { throw new Error("file sync failed"); } });
    assert.equal(failing.write("clerk:bob", create).code, "unavailable");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const before = readFileSync(pending);
  assert.equal(new ProductIntentStore({ root }).write("clerk:bob", create).code, "recovery_required");
  assert.deepEqual(readFileSync(pending), before);
});

test("a first product acknowledgement syncs the new directory ancestry as well as the committed state", (t) => {
  const root = ownedFixtureDir(t, "product-directory-durability").dir;
  const directories = [root, join(root, "state"), join(root, "state/products"), join(root, "state/products/v1")];
  const synced: string[] = [];
  const fsync = fsyncSync;
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    const info = fstatSync(fd);
    if (info.isDirectory()) for (const directory of directories) {
      if (fs.existsSync(directory) && statSync(directory).ino === info.ino) synced.push(directory);
    }
    fsync(fd);
  });
  syncBuiltinESMExports();
  try { assert.ok(new ProductIntentStore({ root }).write(ACTOR, create).ok); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(synced, directories, "every new directory entry is durable before the saved acknowledgement");
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

const repository = { provider: "github", id: 4242, owner: "craigoley", name: "wreckterra", defaultBranch: "main", visibility: "private", verifiedAt: "2026-10-25T12:00:00.000Z" };
const evidence = (id: string, objectiveRevision = 1) => ({
  id, stage: "repository", outcome: "succeeded", objectiveRevision, observedAt: "2026-10-25T12:00:01.000Z",
  references: [{ label: "repository", url: "https://github.com/craigoley/wreckterra" }],
});
const transitionFor = (productId: string, extra: Record<string, unknown> = {}) => ({
  version: "product-intent-v1", requestId: "fixture-transition-0001", id: productId, expectedRevision: 1, expectedObjectiveRevision: 1,
  repository, stageEvidence: [evidence("repo-adopted")], ...extra,
});

test("W1-T10657: trusted product facts survive restart in the canonical record", (t) => {
  const root = ownedFixtureDir(t, "product-facts").dir;
  const created = new ProductIntentStore({ root }).write(ACTOR, create);
  assert.ok(created.ok);
  const id = created.value.receipt.productId;
  const moved = new ProductIntentStore({ root }).transition(ACTOR, transitionFor(id));
  assert.ok(moved.ok);
  assert.equal(moved.value.replayed, false);
  assert.equal(moved.value.receipt.revision, 2);
  assert.equal(moved.value.receipt.objectiveRevision, 1);
  const restarted = new ProductIntentStore({ root }).read(ACTOR, id);
  assert.ok(restarted.ok);
  assert.deepEqual(restarted.value.repository, repository);
  assert.deepEqual(restarted.value.stageEvidence, [evidence("repo-adopted")]);
  assert.deepEqual(restarted.value.brief, brief);
  assert.equal(restarted.value.executionAuthority, "none");
  assert.deepEqual(restarted.value.history.map((item) => item.revision), [1, 2]);
  assert.equal(statSync(productStatePaths(root, ACTOR).state).mode & 0o777, 0o600);
  const research = new ProductIntentStore({ root }).transition(ACTOR, {
    version: "product-intent-v1", requestId: "fixture-transition-0002", id, expectedRevision: 2, expectedObjectiveRevision: 1,
    stageEvidence: [{ ...evidence("research-done"), stage: "research" }],
  });
  assert.ok(research.ok, "evidence alone needs no repository");
  const after = new ProductIntentStore({ root }).read(ACTOR, id);
  assert.ok(after.ok);
  assert.deepEqual(after.value.repository, repository);
  assert.deepEqual(after.value.stageEvidence.map((item) => item.id), ["repo-adopted", "research-done"]);
});

test("W1-T10657: browser brief writes cannot forge verified product facts", (t) => {
  const root = ownedFixtureDir(t, "product-forgery").dir;
  const store = new ProductIntentStore({ root });
  const created = store.write(ACTOR, create);
  assert.ok(created.ok);
  const id = created.value.receipt.productId;
  assert.equal(store.write(ACTOR, { ...create, requestId: "fixture-forge-0001", repository }).code, "invalid_input");
  assert.equal(store.write(ACTOR, { ...create, requestId: "fixture-forge-0002", id, expectedRevision: 1, stageEvidence: [evidence("forged")] }).code, "invalid_input");
  assert.equal(store.write(ACTOR, { ...create, requestId: "fixture-forge-0003", id, expectedRevision: 1, brief: { ...brief, repository, stageEvidence: [evidence("forged")] } }).code, "invalid_input");
  assert.equal(store.write(ACTOR, { ...create, requestId: "fixture-forge-0004", id, expectedRevision: 1, brief: { ...brief, executionAuthority: "runner" } }).code, "invalid_input");
  assert.equal(store.transition(ACTOR, { ...transitionFor(id), requestId: "fixture-forge-0005", executionAuthority: "runner" }).code, "invalid_input");
  assert.equal(store.transition(ACTOR, { version: "product-intent-v1", requestId: "fixture-forge-0006", id, expectedRevision: 1, expectedObjectiveRevision: 1 }).code, "invalid_input");
  assert.ok(store.transition(ACTOR, { ...transitionFor(id), requestId: "fixture-trusted-0008" }).ok);
  const edited = store.write(ACTOR, { ...create, requestId: "fixture-edit-0009", id, expectedRevision: 2, brief: { ...brief, name: "Renamed again" } });
  assert.ok(edited.ok);
  const read = store.read(ACTOR, id);
  assert.ok(read.ok);
  assert.deepEqual(read.value.repository, repository, "a brief edit carries trusted facts forward without altering them");
  assert.deepEqual(read.value.stageEvidence, [evidence("repo-adopted")]);
  assert.equal(read.value.executionAuthority, "none");
});

test("W1-T10657: product fact transitions refuse another actor and stale objective revisions", (t) => {
  const root = ownedFixtureDir(t, "product-transition-guards").dir;
  const store = new ProductIntentStore({ root });
  const created = store.write(ACTOR, create);
  assert.ok(created.ok);
  const id = created.value.receipt.productId;
  assert.equal(store.transition("clerk:bob", transitionFor(id)).code, "not_found");
  assert.equal(store.transition("", transitionFor(id)).code, "invalid_identity");
  const objective = store.write(ACTOR, { ...create, requestId: "fixture-objective-0002", id, expectedRevision: 1, brief: { ...brief, objective: "A new objective" } });
  assert.ok(objective.ok);
  assert.equal(objective.value.receipt.objectiveRevision, 2);
  assert.equal(store.transition(ACTOR, { ...transitionFor(id), expectedRevision: 2 }).code, "stale_revision", "evidence for objective 1 cannot land on objective 2");
  assert.equal(store.transition(ACTOR, { ...transitionFor(id), requestId: "fixture-stale-rev-0003" }).code, "stale_revision");
  assert.equal(store.transition(ACTOR, { ...transitionFor(id, { stageEvidence: [evidence("old-objective", 1)] }), requestId: "fixture-stale-ev-0004", expectedRevision: 2, expectedObjectiveRevision: 2 }).code, "invalid_input");
  assert.equal(store.transition(ACTOR, { ...transitionFor(id), requestId: "fixture-missing-0005", id: `prd_${"b".repeat(32)}` }).code, "not_found");
  const fresh = { ...transitionFor(id, { stageEvidence: [evidence("repo-adopted", 2)] }), requestId: "fixture-fresh-0006", expectedRevision: 2, expectedObjectiveRevision: 2 };
  assert.ok(store.transition(ACTOR, fresh).ok);
  const duplicate = { ...fresh, requestId: "fixture-duplicate-0007", expectedRevision: 3 };
  assert.equal(store.transition(ACTOR, duplicate).code, "invalid_input", "one evidence id is recorded once");
  assert.equal(store.transition(ACTOR, { ...duplicate, requestId: "fixture-rebind-0008", repository: { ...repository, id: 7 }, stageEvidence: [evidence("other", 2)] }).code, "invalid_input", "a bound repository cannot be silently rebound");
  const read = store.read(ACTOR, id);
  assert.ok(read.ok);
  assert.equal(read.value.revision, 3);
  assert.deepEqual(read.value.stageEvidence.map((item) => item.id), ["repo-adopted"]);
  assert.equal(new ProductIntentStore({ root }).read("clerk:bob", id).code, "not_found");
  const bulkRoot = ownedFixtureDir(t, "product-transition-capacity").dir;
  const bulk = new ProductIntentStore({ root: bulkRoot });
  const seeded = bulk.write(ACTOR, { ...create, brief: { idea: "x" } });
  assert.ok(seeded.ok);
  const bulkId = seeded.value.receipt.productId;
  const tiny = (name: string) => ({ ...evidence(name), references: [] });
  for (let batch = 0; batch < 8; batch++) {
    const fill = bulk.transition(ACTOR, { ...transitionFor(bulkId, { stageEvidence: Array.from({ length: 16 }, (_, index) => tiny(`b${batch}-${index}`)) }), requestId: `fixture-bulk-000${batch}`, expectedRevision: batch + 1 });
    assert.ok(fill.ok, `batch ${batch}`);
  }
  assert.equal(bulk.transition(ACTOR, { ...transitionFor(bulkId, { stageEvidence: [tiny("one-too-many")] }), requestId: "fixture-bulk-over", expectedRevision: 9 }).code, "capacity");
});

test("W1-T10657: trusted product transitions replay one durable revision after uncertain commit", (t) => {
  const root = ownedFixtureDir(t, "product-transition-replay").dir;
  const created = new ProductIntentStore({ root }).write(ACTOR, create);
  assert.ok(created.ok);
  const id = created.value.receipt.productId;
  const command = transitionFor(id);
  let failedSyncs = 0;
  const interrupted = new ProductIntentStore({ root, sync(fd) {
    if (fstatSync(fd).isDirectory()) {
      failedSyncs++;
      throw Object.assign(new Error("directory sync remains unavailable"), { code: "EIO" });
    }
    fsyncSync(fd);
  } });
  assert.equal(interrupted.transition(ACTOR, command).code, "outcome_unknown");
  const renamed = readFileSync(productStatePaths(root, ACTOR).state);
  assert.equal(interrupted.transition(ACTOR, command).code, "outcome_unknown", "replay stays unknown while the directory cannot sync");
  assert.equal(interrupted.receipt(ACTOR, command.requestId).code, "outcome_unknown");
  assert.equal(failedSyncs, 3);
  const recovered = new ProductIntentStore({ root });
  const receipt = recovered.receipt(ACTOR, command.requestId);
  assert.ok(receipt.ok);
  const replay = recovered.transition(ACTOR, command);
  assert.ok(replay.ok);
  assert.equal(replay.value.replayed, true);
  assert.deepEqual(replay.value.receipt, receipt.value);
  assert.deepEqual(readFileSync(productStatePaths(root, ACTOR).state), renamed, "replay writes no second revision");
  assert.equal(recovered.transition(ACTOR, { ...command, stageEvidence: [evidence("different")] }).code, "idempotency_conflict");
  assert.equal(recovered.write(ACTOR, { ...create, requestId: command.requestId }).code, "idempotency_conflict", "a brief cannot reuse a transition's request id");
  const read = recovered.read(ACTOR, id);
  assert.ok(read.ok);
  assert.equal(read.value.revision, 2);
  assert.equal(read.value.stageEvidence.length, 1);
  assert.deepEqual(read.value.history.map((item) => item.revision), [1, 2]);
});

test("W1-T10657: trusted facts keep public product history and receipts within the declared contract", (t) => {
  const root = ownedFixtureDir(t, "product-transition-contract").dir;
  const store = new ProductIntentStore({ root });
  const created = store.write(ACTOR, create);
  assert.ok(created.ok);
  const command = transitionFor(created.value.receipt.productId);
  const changed = store.transition(ACTOR, command);
  assert.ok(changed.ok);
  const restarted = new ProductIntentStore({ root });
  const product = restarted.read(ACTOR, command.id);
  const receipt = restarted.receipt(ACTOR, command.requestId);
  assert.ok(product.ok);
  assert.ok(receipt.ok);
  const response = declaredBody("/v1/products", "GET", 200);
  for (const [label, body] of [
    ["product history", { version: "product-intent-v1", product: product.value }],
    ["receipt lookup", { version: "product-intent-v1", receipt: receipt.value }],
  ] as const) {
    assert.deepEqual(violations(body, response), [], `${label} after a trusted transition must match the published GET contract`);
  }
});
