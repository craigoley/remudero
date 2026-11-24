import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { opsCatalogShadowFeed, OPS_CATALOG_REFRESHED_STEP, OPS_DISPATCH_SOURCE_MAX_AGE_MS } from "#src/cli/commands/daemon.js";
import type { Clock } from "#src/lib/clock.js";
import { HEAP_LIMIT_EXIT_FRACTION } from "#src/lib/daemon-memory-policy.js";
import {
  OPS_SNAPSHOT_HEAP_BYTES_PER_CATALOG_BYTE, createOpsCatalogShadowSource, opsCatalogBlobCacheDir, opsCatalogHeapByteBound, opsCatalogLastGoodFile,
  readLastGoodOpsCatalogSnapshot, type OpsCatalogApi, type OpsCatalogLastGood,
} from "#src/lib/ops-catalog-source.js";
import type { Plan } from "#src/lib/plan.js";
import { findReleasePlanInCatalogs, findTaskInCatalogs, opsPlanForLookup } from "#src/lib/task-lookup.js";

// W1-T14564 (operator ruling 2026-11-23): an ops catalog read problem never stops core work. A refused read serves
// the last good snapshot, with its age; with no good snapshot the lookup stays unreadable, never an empty catalog.

const ID = "W1-T900000", OTHER = "W1-T900001", REPOSITORY = "fixture-private/ops", REPOSITORY_ID = 42;
const record = (id: string) => `- id: ${id}\n  title: Last good fixture ${id}\n  repo: remudero\n  depends_on: []\n  type: implement\n  risk: low\n  files: [src/fixture.ts]\n  acceptance:\n    - claim: last good criterion\n      proof: "grep: last-good-fixture in src/fixture.ts"\n`;
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const blobSha = (text: string) => sha1(`blob ${Buffer.byteLength(text)}\0${text}`);
const emptyPlan = (): Plan => ({ tasks: [], byId: new Map() });
const ACCEPTED_AT = Date.UTC(2026, 10, 23, 8, 0, 0);

interface Fixture {
  stateDir: string; api: OpsCatalogApi; calls: string[]; commit: string; clock: Clock & { at: number };
  refuse(): void; monolith: string; shard: string;
}

/** A pinned read-only ops repository (tasks.yaml plus one shard per id) that serves until refuse() is called. */
function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-last-good-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: REPOSITORY, kinds: [] }));
  const monolith = record(OTHER), shard = record(ID);
  const texts = new Map([[blobSha(monolith), monolith], [blobSha(shard), shard]]);
  const commit = sha1("commit"), rootTree = sha1("root"), planTree = sha1("plan"), shardTree = sha1("shards");
  const calls: string[] = [], base = `repos/${REPOSITORY}`;
  let refused = false;
  const api: OpsCatalogApi = async path => {
    calls.push(path);
    if (refused) throw new Error(`https://api.github.com/${path} secret body`);
    if (path === base) return { id: REPOSITORY_ID, full_name: REPOSITORY, default_branch: "main" };
    if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: rootTree } };
    if (path === `${base}/git/trees/${rootTree}`) return { sha: rootTree, truncated: false, tree: [{ path: "plan", sha: planTree, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${planTree}`) return { sha: planTree, truncated: false, tree: [
      { path: "tasks.yaml", sha: blobSha(monolith), type: "blob", mode: "100644" },
      { path: "tasks.d", sha: shardTree, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${shardTree}`) return { sha: shardTree, truncated: false,
      tree: [{ path: `${ID}-the-task.yaml`, sha: blobSha(shard), type: "blob", mode: "100644" }] };
    const blob = path.slice(`${base}/git/blobs/`.length), text = texts.get(blob);
    assert.ok(text !== undefined, "only pinned read-only fixture routes may run");
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  };
  const clock = { at: ACCEPTED_AT, now() { return this.at; }, date() { return new Date(this.at); }, iso() { return new Date(this.at).toISOString(); } };
  return { stateDir, api, calls, commit, clock, refuse: () => { refused = true; }, monolith, shard };
}
const sourcesOf = (fx: Fixture) => ({ byId: new Map(), stateDir: fx.stateDir, api: fx.api, opsRead: { stateDir: fx.stateDir, bounds: { clock: fx.clock } } });

test("W1-T14564: a refused ops read serves the last good snapshot", async t => {
  const fx = fixture(t);
  const fresh = await findTaskInCatalogs(ID, sourcesOf(fx));
  assert.equal(fresh.outcome, "found");
  assert.equal(fresh.outcome === "found" ? fresh.lastGood : "x", undefined, "an accepted read is not a fallback");
  const kept = opsCatalogLastGoodFile(fx.stateDir, REPOSITORY);
  assert.equal(statSync(kept).mode & 0o777, 0o600, "the kept binding is owner-only");

  fx.refuse();
  fx.clock.at = ACCEPTED_AT + 90_000;
  const served = await findTaskInCatalogs(ID, sourcesOf(fx));
  assert.equal(served.outcome, "found");
  assert.equal(served.catalog, "ops");
  assert.equal(served.task?.id, ID);
  assert.equal(served.task?.catalog, "ops");
  assert.deepEqual(served.task?.files, ["src/fixture.ts"]);
  assert.equal(served.outcome === "found" ? served.commit : undefined, fx.commit);
  assert.deepEqual(served.outcome === "found" ? served.lastGood : undefined, { refusal: "ops-unreadable", snapshotAgeMs: 90_000 },
    "the result names the refusal and the snapshot's age");
  assert.equal(JSON.stringify(served).includes("secret"), false, "no thrown text reaches the answer");
  // Dispatch composes from the lookup's whole plan: the last good snapshot carries every task it held.
  assert.deepEqual([...opsPlanForLookup(served)!.byId.keys()].sort(), [ID, OTHER]);
  const monolithHit = await findTaskInCatalogs(OTHER, sourcesOf(fx));
  assert.equal(monolithHit.outcome === "found" ? monolithHit.task.id : undefined, OTHER);
});

test("W1-T14564: a refused read with no snapshot is unreadable", async t => {
  const fx = fixture(t);
  fx.refuse();
  assert.deepEqual(await findTaskInCatalogs(ID, sourcesOf(fx)), { outcome: "unreadable", reason: "ops-unreadable" },
    "no kept binding is never an empty catalog");
  assert.deepEqual(await findTaskInCatalogs(ID, { byId: new Map(), stateDir: fx.stateDir, api: fx.api }),
    { outcome: "unreadable", reason: "ops-unreadable" }, "a read with no state dir keeps no snapshot");
  assert.deepEqual(await readLastGoodOpsCatalogSnapshot({ repository: REPOSITORY }, fx.api), { outcome: "none", reason: "no_state_dir" });

  const unkept = fixture(t);
  mkdirSync(join(unkept.stateDir, "cache"), { recursive: true });
  writeFileSync(join(unkept.stateDir, "cache", "ops-catalog-last-good"), "not a directory");
  assert.equal((await findTaskInCatalogs(ID, sourcesOf(unkept))).outcome, "found", "a binding that cannot be kept never fails the read");
  unkept.refuse();
  assert.deepEqual(await findTaskInCatalogs(ID, sourcesOf(unkept)), { outcome: "unreadable", reason: "ops-unreadable" });

  const filed = fixture(t);
  await findTaskInCatalogs(ID, sourcesOf(filed));
  filed.refuse();
  assert.deepEqual(await findTaskInCatalogs("W1-T999999", sourcesOf(filed)), { outcome: "unreadable", reason: "ops-unreadable" },
    "a miss in an old snapshot cannot prove a task filed since is absent");
  assert.deepEqual(await readLastGoodOpsCatalogSnapshot({ repository: "fixture-private/other" }, filed.api, { stateDir: filed.stateDir }),
    { outcome: "none", reason: "no_record" });
});

test("W1-T14564: a missing, mismatched or damaged kept file is no snapshot", async t => {
  const read = (fx: Fixture) => readLastGoodOpsCatalogSnapshot({ repository: REPOSITORY }, fx.api, { stateDir: fx.stateDir });
  const accepted = async () => { const fx = fixture(t); await findTaskInCatalogs(ID, sourcesOf(fx)); fx.refuse(); return fx; };
  const reason = (r: OpsCatalogLastGood) => r.outcome === "none" ? r.reason : "ok";

  const missing = await accepted();
  rmSync(join(opsCatalogBlobCacheDir(missing.stateDir, REPOSITORY_ID), blobSha(missing.shard)));
  assert.equal(reason(await read(missing)), "blob_missing");
  assert.deepEqual(await findTaskInCatalogs(ID, sourcesOf(missing)), { outcome: "unreadable", reason: "ops-unreadable" });

  const tampered = await accepted();
  const dir = opsCatalogBlobCacheDir(tampered.stateDir, REPOSITORY_ID);
  writeFileSync(join(dir, blobSha(tampered.shard)), tampered.shard.replace("Last good", "Tampered"));
  assert.equal(reason(await read(tampered)), "blob_missing", "bytes that miss their sha never answer");
  assert.equal(readdirSync(dir).includes(blobSha(tampered.shard)), false, "the mismatched file is removed");

  const damaged = await accepted();
  writeFileSync(opsCatalogLastGoodFile(damaged.stateDir, REPOSITORY), "{not json");
  assert.equal(reason(await read(damaged)), "record_malformed");
  writeFileSync(opsCatalogLastGoodFile(damaged.stateDir, REPOSITORY), JSON.stringify({ version: 2 }));
  assert.equal(reason(await read(damaged)), "record_malformed");

  const linked = await accepted();
  const file = opsCatalogLastGoodFile(linked.stateDir, REPOSITORY);
  writeFileSync(`${file}.real`, JSON.stringify({ version: 1 })); rmSync(file); symlinkSync(`${file}.real`, file);
  assert.equal(reason(await read(linked)), "no_record", "a linked record is never followed");
  rmSync(file); mkdirSync(file);
  assert.equal(reason(await read(linked)), "record_malformed", "a directory is not a record");

  const unparsable = await accepted();
  const bad = "- id: W1-T900000\n  title: no type\n  repo: remudero\n";
  writeFileSync(join(opsCatalogBlobCacheDir(unparsable.stateDir, REPOSITORY_ID), blobSha(bad)), bad);
  writeFileSync(opsCatalogLastGoodFile(unparsable.stateDir, REPOSITORY), JSON.stringify({ version: 1, repository: REPOSITORY, acceptedAt: ACCEPTED_AT,
    binding: { repositoryId: REPOSITORY_ID, ref: "refs/heads/main", commit: unparsable.commit, tasksYamlBlob: blobSha(bad), shardTreeSha: "", shardBlobs: {} } }));
  assert.equal(reason(await read(unparsable)), "parse");
  writeFileSync(opsCatalogLastGoodFile(unparsable.stateDir, REPOSITORY), JSON.stringify({ version: 1, repository: "fixture-private/else", acceptedAt: ACCEPTED_AT,
    binding: { repositoryId: REPOSITORY_ID, ref: "refs/heads/main", commit: unparsable.commit, tasksYamlBlob: blobSha(bad), shardTreeSha: "", shardBlobs: {} } }));
  assert.equal(reason(await read(unparsable)), "record_malformed", "a record for another repository never answers");
});

/** A heap reading whose derived bound is `bytes` catalog bytes. */
const heapAllowing = (bytes: number) => ({ used_heap_size: 0, heap_size_limit: Math.ceil((bytes + 1) * OPS_SNAPSHOT_HEAP_BYTES_PER_CATALOG_BYTE / HEAP_LIMIT_EXIT_FRACTION) });

test("W1-T14638: the last good record and its blobs are judged on the derived heap bound, never a fixed count or size", async t => {
  const reason = (r: OpsCatalogLastGood) => r.outcome === "none" ? r.reason : "ok";
  const accepted = async () => { const fx = fixture(t); await findTaskInCatalogs(ID, sourcesOf(fx)); fx.refuse(); return fx; };
  assert.ok(opsCatalogHeapByteBound(heapAllowing(300_000)) >= 300_000, "the helper's heap allows what the test asks of it");

  // A binding naming more shards than the old fixed entry ceiling is a record; its missing blobs, not its count, end it.
  const wide = await accepted();
  const names = Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`s${i}.yaml`, sha1(String(i))]));
  writeFileSync(opsCatalogLastGoodFile(wide.stateDir, REPOSITORY), JSON.stringify({ version: 1, repository: REPOSITORY, acceptedAt: ACCEPTED_AT,
    binding: { repositoryId: REPOSITORY_ID, ref: "refs/heads/main", commit: wide.commit, tasksYamlBlob: blobSha(wide.monolith), shardTreeSha: "", shardBlobs: names } }));
  assert.equal(reason(await readLastGoodOpsCatalogSnapshot({ repository: REPOSITORY }, wide.api, { stateDir: wide.stateDir })), "blob_missing");

  // A blob past the old 256 KiB per-blob ceiling is served; one past the heap bound is not loaded, and stays kept.
  const large = await accepted();
  const text = `${large.monolith}# ${"x".repeat(300 * 1024)}\n`;
  const dir = opsCatalogBlobCacheDir(large.stateDir, REPOSITORY_ID);
  writeFileSync(join(dir, blobSha(text)), text);
  writeFileSync(opsCatalogLastGoodFile(large.stateDir, REPOSITORY), JSON.stringify({ version: 1, repository: REPOSITORY, acceptedAt: ACCEPTED_AT,
    binding: { repositoryId: REPOSITORY_ID, ref: "refs/heads/main", commit: large.commit, tasksYamlBlob: blobSha(text), shardTreeSha: "", shardBlobs: {} } }));
  const read = (bounds?: { heap: () => { used_heap_size: number; heap_size_limit: number } }) =>
    readLastGoodOpsCatalogSnapshot({ repository: REPOSITORY }, large.api, { stateDir: large.stateDir, ...(bounds ? { bounds } : {}) });
  const served = await read({ heap: () => heapAllowing(1024 * 1024) });
  assert.equal(served.outcome, "ok");
  assert.equal(served.outcome === "ok" ? served.counts.bytes : 0, Buffer.byteLength(text));
  assert.equal(reason(await read({ heap: () => heapAllowing(100 * 1024) })), "blob_missing", "a blob the heap cannot hold is not loaded");
  assert.ok(readdirSync(dir).includes(blobSha(text)), "a valid blob the heap could not hold is kept");
  assert.equal(reason(await read({ heap: () => ({ used_heap_size: 2 ** 40, heap_size_limit: 2 ** 40 }) })), "record_malformed", "with no heap left even the record is not loaded");
});

test("W1-T14564: an ok ops read answers exactly as before", async t => {
  const fx = fixture(t);
  let lastGoodReads = 0;
  const readLastGood = async (): Promise<OpsCatalogLastGood> => { lastGoodReads++; return { outcome: "none", reason: "no_record" }; };
  const found = await findTaskInCatalogs(ID, { ...sourcesOf(fx), readLastGood });
  assert.equal(found.outcome, "found");
  assert.deepEqual(Object.keys(found).sort(), ["catalog", "commit", "outcome", "task"], "no lastGood key on an accepted read");
  assert.deepEqual(await findTaskInCatalogs("W1-T999999", { ...sourcesOf(fx), readLastGood }), { outcome: "absent" });
  assert.equal(lastGoodReads, 0, "an accepted read never opens the fallback");
  fx.refuse();
  assert.deepEqual(await findTaskInCatalogs(ID, { ...sourcesOf(fx), readLastGood }), { outcome: "unreadable", reason: "ops-unreadable" });
  assert.equal(lastGoodReads, 1, "the injected reader is the one a refusal opens");
});

test("W1-T14564: a release from the last good snapshot keeps the refusal", async t => {
  const fx = fixture(t);
  const sources = { stateDir: fx.stateDir, api: fx.api, opsRead: { stateDir: fx.stateDir } };
  assert.equal((await findReleasePlanInCatalogs(ID, emptyPlan(), sources)).outcome, "found", "an accepted read still releases");
  fx.refuse();
  assert.deepEqual(await findReleasePlanInCatalogs(ID, emptyPlan(), sources), { outcome: "unreadable", reason: "ops-unreadable" },
    "a release pins the record the tick hashes, never one from an old snapshot");
});

test("W1-T14564: dispatch serves the kept snapshot on a stale ops source", async t => {
  const fx = fixture(t);
  const rows: Array<{ step: string; data: Record<string, unknown> }> = [];
  const opts = { stateDir: fx.stateDir, bounds: { clock: fx.clock } };
  const feed = opsCatalogShadowFeed(createOpsCatalogShadowSource({ repository: REPOSITORY }, fx.api, opts), fx.clock,
    { log: (step, data) => rows.push({ step, data }) });
  t.after(() => feed.stop());
  const settle = async () => { const before = rows.length; feed.current(); for (let i = 0; i < 400 && rows.length === before; i++) await delay(5); };
  await settle();
  assert.equal(feed.forDispatch()?.outcome, "ok", "positive control: an accepted read dispatches");
  assert.equal(rows[0]?.data.refusal, undefined, "an accepted read's row has no refusal");

  fx.refuse();
  fx.clock.at += 30_000;
  await settle();
  const row = rows[rows.length - 1]!;
  assert.equal(row.step, OPS_CATALOG_REFRESHED_STEP, "the existing step carries it: no new ledger step");
  assert.deepEqual([row.data.outcome, row.data.refusal, row.data.snapshot_age_ms], ["stale", "stale", 30_000]);
  assert.equal(JSON.stringify(rows).includes("secret"), false, "no thrown text reaches a row");
  const served = feed.forDispatch();
  assert.equal(served?.outcome, "ok", "dispatch is served the kept snapshot instead of holding");
  assert.deepEqual([...served!.plan!.byId.keys()].sort(), [ID, OTHER]);
  assert.deepEqual(served?.lastGood?.refusal, "stale");

  // Past the 120 s bound the snapshot is still served; the bound holds only when there is no snapshot.
  fx.clock.at += OPS_DISPATCH_SOURCE_MAX_AGE_MS;
  const late = feed.forDispatch();
  assert.equal(late?.outcome, "ok");
  assert.ok((late?.lastGood?.snapshotAgeMs ?? 0) >= OPS_DISPATCH_SOURCE_MAX_AGE_MS);

  // A restarted daemon has no snapshot in memory: the state dir's kept one answers, aged from its acceptance.
  const restarted = await createOpsCatalogShadowSource({ repository: REPOSITORY }, fx.api, opts).refresh();
  assert.equal(restarted.outcome, "ok");
  assert.deepEqual([restarted.lastGood?.refusal, restarted.lastGood?.snapshotAgeMs], ["unreadable", fx.clock.at - ACCEPTED_AT]);

  // Never empty: a source that never accepted a snapshot still holds dispatch with its refusal.
  const cold = fixture(t);
  cold.refuse();
  const coldFeed = opsCatalogShadowFeed(createOpsCatalogShadowSource({ repository: REPOSITORY }, cold.api, { stateDir: cold.stateDir }), cold.clock);
  t.after(() => coldFeed.stop());
  coldFeed.current();
  for (let i = 0; i < 400 && coldFeed.current() === undefined; i++) await delay(5);
  assert.equal(coldFeed.forDispatch()?.outcome, "unreadable");
  assert.equal(coldFeed.forDispatch()?.plan, undefined);
});
