// W1-T14368: the ops catalog reader refused any catalog past 500 shards or 8 MiB as malformed, and the ops catalog grows
// about 55 shards a day, so ops dispatch was days from stopping. The bounds are now derived, and judge every read
// whatever its size: the snapshot's measured heap cost against the heap the daemon has left, and the blob reads a
// refresh needs against the GitHub budget. W1-T14563: the catalog's size and growth are not bounded (operator ruling,
// 2026-11-23): a catalog that grows by any number of shards or bytes in a day reads ok within those two bounds.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
// Load the existing analytics side of the daemon's import cycle first.
import "#src/lib/live-analytics-snapshot-cache.js";
import { OPS_CATALOG_REFRESHED_STEP, opsCatalogShadowFeed } from "#src/cli/commands/daemon.js";
import { HEAP_LIMIT_EXIT_FRACTION } from "#src/lib/daemon-memory-policy.js";
import {
  OPS_SNAPSHOT_HEAP_BYTES_PER_CATALOG_BYTE, acceptOfferedOpsCatalogBlobs, createOpsCatalogShadowSource, keptOpsCatalogBlobsForChild,
  opsCatalogBoundReasons, opsCatalogBoundRefusal, opsCatalogHeapByteBound, readOpsCatalogSnapshotAsync,
  type OpsCatalogApi, type OpsCatalogBoundsIo, type OpsCatalogSnapshot,
} from "#src/lib/ops-catalog-source.js";
import { PreviewUnknown, catalog, judgeOpsCopy } from "#src/lib/plan-task-migration.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const REPO = "acme-private/ops-growth";
const REPO_ID = 4242;
/** W1-T11768's removed fixed backstops: 500 shards and 8 MiB. A catalog's sizes in these tests are set against them. */
const OLD_SHARDS = 500;
const OLD_BYTES = 8 * 1024 * 1024;
/** The shards the catalog gained in its largest measured day (2026-11-17); a day's growth in criterion 1. */
const GROWN = 118;
const target = { repository: REPO };
const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const blobSha = (text: string): string => sha1(`blob ${Buffer.byteLength(text)}\0${text}`);

/** One task record padded with a comment to exactly `bytes` bytes. */
function shard(id: string, bytes: number): string {
  const head = `- id: ${id}\n  title: "t ${id}"\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [src/a.ts]\n  rationale: r\n# `;
  const text = `${head}${"x".repeat(bytes - Buffer.byteLength(head) - 1)}\n`;
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
}
const MONO = "[]\n";
function shards(from: number, n: number, bytes: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`OPS-T${from + i}.yaml`, shard(`OPS-T${from + i}`, bytes)]));
}
const bytesOf = (c: { mono: string; shards: Record<string, string> }): number =>
  Object.values(c.shards).reduce((sum, t) => sum + Buffer.byteLength(t), Buffer.byteLength(c.mono));

/** A recording GET-only fake of the git data API whose branch can be moved to a new catalog. */
function remote(initial: { mono: string; shards: Record<string, string> }) {
  const blobs = new Map<string, string>();
  const calls: string[] = [];
  let version = 0;
  let current = initial;
  const put = (t: string): string => { const s = blobSha(t); blobs.set(s, t); return s; };
  const ids = () => ({ commit: sha1(`commit-${version}`), root: sha1(`root-${version}`), plan: sha1(`plan-${version}`), dir: sha1(`dir-${version}`) });
  const entry = (path: string, type: string, mode: string, s: string) => ({ path, type, mode, sha: s });
  const api: OpsCatalogApi = async (path) => {
    calls.push(path);
    const v = ids();
    if (path === `repos/${REPO}`) return { id: REPO_ID, full_name: REPO, default_branch: "main" };
    if (path === `repos/${REPO}/git/ref/heads/main`) return { object: { type: "commit", sha: v.commit } };
    if (path === `repos/${REPO}/git/commits/${v.commit}`) return { sha: v.commit, tree: { sha: v.root } };
    if (path === `repos/${REPO}/git/trees/${v.root}`) return { sha: v.root, truncated: false, tree: [entry("plan", "tree", "040000", v.plan)] };
    if (path === `repos/${REPO}/git/trees/${v.plan}`) {
      return { sha: v.plan, truncated: false, tree: [entry("tasks.yaml", "blob", "100644", put(current.mono)), entry("tasks.d", "tree", "040000", v.dir)] };
    }
    if (path === `repos/${REPO}/git/trees/${v.dir}`) {
      return { sha: v.dir, truncated: false, tree: Object.entries(current.shards).map(([n, t]) => entry(n, "blob", "100644", put(t))) };
    }
    const m = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
    if (m && blobs.has(m[1]!)) {
      const t = blobs.get(m[1]!)!;
      return { sha: m[1], encoding: "base64", size: Buffer.byteLength(t), content: Buffer.from(t).toString("base64") };
    }
    throw new Error(`unexpected GET ${path}`);
  };
  return {
    api, calls,
    move(next: { mono: string; shards: Record<string, string> }) { current = next; version++; },
    blobGets: () => calls.filter((p) => p.includes("/git/blobs/")).length,
    reset: () => { calls.length = 0; },
  };
}

/** Readings well inside the heap and blob-budget bounds, so only growth could refuse. */
const roomy: OpsCatalogBoundsIo = { heap: () => ({ used_heap_size: 0, heap_size_limit: 2 ** 40 }), blobReadAllowance: () => 100_000 };
const said = (snap: { outcome: string; refusalStage?: string }) => `${snap.outcome}${snap.refusalStage ? ` at ${snap.refusalStage}` : ""}`;
const view = (snap: OpsCatalogSnapshot) => ({ outcome: snap.outcome, refusalStage: snap.refusalStage, counts: snap.counts, bound: snap.bound,
  tasks: snap.plan?.tasks.map((t) => t.id), binding: snap.binding });

test("W1-T14368 criterion 1: a catalog of 600 shards and 3 MB, grown a day's worth since the last accepted snapshot, reads ok and dispatches", async () => {
  const before = { mono: MONO, shards: shards(0, 600 - GROWN, 5_000) };
  const after = { mono: MONO, shards: { ...before.shards, ...shards(600 - GROWN, GROWN, 5_000) } };
  assert.equal(Object.keys(after.shards).length, 600);
  assert.ok(bytesOf(after) >= 3_000_000 && bytesOf(after) < OLD_BYTES, "3 MB, inside the old byte backstop");

  // The one-shot read every CLI and run child takes, with the live heap and GitHub budget readings.
  const r = remote(before);
  assert.equal((await readOpsCatalogSnapshotAsync(target, r.api)).outcome, "ok");
  r.move(after);
  const snap = await readOpsCatalogSnapshotAsync(target, r.api);
  assert.equal(snap.outcome, "ok", `a 600-shard catalog read ${said(snap)}; origin/main refuses it malformed at shard_tree (OPS_CATALOG_MAX_SHARDS)`);
  assert.equal(snap.counts.shards, 600);
  assert.equal(snap.counts.bytes, bytesOf(after));
  assert.equal(snap.plan?.tasks.length, 600);
  assert.equal(snap.bound, undefined);
  // A run child for the newest task is offered all 601 verified blobs, and keeps them.
  const offer = keptOpsCatalogBlobsForChild("OPS-T599", r.api);
  assert.ok(offer, "a catalog past 500 shards is still offered to its run child");
  assert.deepEqual(acceptOfferedOpsCatalogBlobs(offer, remote(after).api), { offered: 601, kept: 601, refused: 0 });

  // The dispatch feed's source: its refresh after the branch moved is the ok evidence ops dispatch selects from.
  const feed = remote(before);
  const source = createOpsCatalogShadowSource(target, feed.api);
  assert.equal((await source.refresh()).outcome, "ok");
  feed.move(after);
  const input = await source.refresh();
  assert.equal(input.outcome, "ok", `the dispatch source read ${said(input)}`);
  assert.equal(input.plan?.tasks.length, 600);
  assert.ok(input.plan?.byId.has("OPS-T599"), "the newest shard's task is dispatchable");
  assert.equal(feed.blobGets() - (600 - GROWN + 1), GROWN, "the refresh after the move fetched only the new shards' blobs");
});

test("W1-T14563: a catalog that grew by any amount reads ok and dispatches", async () => {
  const base = { mono: MONO, shards: shards(0, 482, 5_000) };
  const r = remote(base);
  assert.equal((await readOpsCatalogSnapshotAsync(target, r.api, { bounds: roomy })).outcome, "ok");

  // Shards: 218 more a moment later, past the 118 the removed bound allowed in a day.
  r.move({ mono: MONO, shards: { ...base.shards, ...shards(482, 218, 5_000) } });
  const jumped = await readOpsCatalogSnapshotAsync(target, r.api, { bounds: roomy });
  assert.equal(jumped.outcome, "ok", `a 218-shard jump read ${said(jumped)}`);
  assert.equal(jumped.bound, undefined);
  assert.equal(jumped.counts.shards, 700);

  // Bytes: 760,000 more in 38 shards, past the 633,709 the removed bound allowed in a day.
  const b = remote(base);
  assert.equal((await readOpsCatalogSnapshotAsync(target, b.api, { bounds: roomy })).outcome, "ok");
  b.move({ mono: MONO, shards: { ...base.shards, ...shards(482, 38, 20_000) } });
  const heavy = await readOpsCatalogSnapshotAsync(target, b.api, { bounds: roomy });
  assert.equal(heavy.outcome, "ok", `a 760,000-byte jump read ${said(heavy)}`);
  assert.equal(heavy.bound, undefined);

  // Any amount, again and again: +1,000 shards, then +2,000 more, each read ok at once.
  const j = remote(base);
  assert.equal((await readOpsCatalogSnapshotAsync(target, j.api, { bounds: roomy })).outcome, "ok");
  for (const n of [1_000, 3_000]) {
    j.move({ mono: MONO, shards: { ...base.shards, ...shards(482, n, 600) } });
    const grown = await readOpsCatalogSnapshotAsync(target, j.api, { bounds: roomy });
    assert.equal(grown.outcome, "ok", `${n} new shards read ${said(grown)}`);
    assert.equal(grown.counts.shards, 482 + n);
  }

  // The dispatch source stays ok, never stale, across the jump.
  const s = remote(base);
  const source = createOpsCatalogShadowSource(target, s.api, { bounds: roomy });
  assert.equal((await source.refresh()).outcome, "ok");
  s.move({ mono: MONO, shards: { ...base.shards, ...shards(482, 1_000, 600) } });
  const refreshed = await source.refresh();
  assert.equal(refreshed.outcome, "ok", `the dispatch source read ${said(refreshed)}`);
  assert.equal(refreshed.bound, undefined);
  assert.ok(refreshed.plan?.byId.has("OPS-T1481"), "the newest shard's task is dispatchable");

  // A restart with a state dir keeps no growth record, and its read after a jump is ok.
  const state = fs.mkdtempSync(join(tmpdir(), "rmd-ops-growth-"));
  try {
    assert.equal((await readOpsCatalogSnapshotAsync(target, remote(base).api, { stateDir: state, bounds: roomy })).outcome, "ok");
    assert.equal(fs.existsSync(join(state, "cache", "ops-catalog-growth")), false, "no growth record is written");
    const restarted = remote({ mono: MONO, shards: { ...base.shards, ...shards(482, 300, 1_000) } });
    assert.equal((await readOpsCatalogSnapshotAsync(target, restarted.api, { stateDir: state, bounds: roomy })).outcome, "ok");
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }

  // The judge a migration copy uses admits any jump too.
  assert.equal(opsCatalogBoundRefusal({ shards: 9_000, bytes: OLD_BYTES - 1 }, roomy), undefined);
  assert.equal(opsCatalogBoundRefusal({ shards: 9_000, bytes: OLD_BYTES * 4 }, roomy), undefined);
});

test("W1-T14563: a catalog that grew by any amount still meets the heap and blob-budget refusals", async () => {
  const base = { mono: MONO, shards: shards(0, 482, 1_000) };
  // Heap: a jump with no heap left is refused heap_bytes, whole.
  const h = remote(base);
  assert.equal((await readOpsCatalogSnapshotAsync(target, h.api, { bounds: roomy })).outcome, "ok");
  h.move({ mono: MONO, shards: { ...base.shards, ...shards(482, 40, 250_000) } });
  const noHeap: OpsCatalogBoundsIo = { ...roomy, heap: () => ({ used_heap_size: 1, heap_size_limit: 1 }) };
  const heap = await readOpsCatalogSnapshotAsync(target, h.api, { bounds: noHeap });
  assert.equal(heap.outcome, "malformed", said(heap));
  assert.equal(heap.refusalStage, "blob_verification");
  assert.equal(heap.bound?.reason, "heap_bytes");
  assert.equal(heap.bound?.allowed, 0);
  assert.ok(heap.bound!.observed > 0, "refused at the first byte past the heap left");
  assert.equal(heap.plan, undefined);
  assert.deepEqual(opsCatalogBoundRefusal({ shards: 522, bytes: OLD_BYTES + 1 }, noHeap),
    { reason: "heap_bytes", observed: OLD_BYTES + 1, allowed: 0 });

  // Blob budget: a jump whose blob reads exceed the allowance is refused before a GET.
  const g = remote(base);
  assert.equal((await readOpsCatalogSnapshotAsync(target, g.api, { bounds: roomy })).outcome, "ok");
  g.move({ mono: MONO, shards: { ...base.shards, ...shards(482, 300, 1_000) } });
  g.reset();
  const budget = await readOpsCatalogSnapshotAsync(target, g.api, { bounds: { ...roomy, blobReadAllowance: () => 10 } });
  assert.equal(budget.outcome, "unreadable", said(budget));
  assert.equal(budget.refusalStage, "shard_tree");
  assert.deepEqual(budget.bound, { reason: "blob_read_budget", observed: 300, allowed: 10 });
  assert.equal(g.blobGets(), 0, "nothing was spent on a read the budget cannot finish");
});

test("W1-T14368 criterion 3: the byte bound is the measured heap cost against the heap left, and blob reads are counted against the GitHub budget; neither is a literal", async () => {
  // Past the byte baseline: 40 shards of 250,000 bytes, 10 MB.
  const big = { mono: MONO, shards: shards(0, 40, 250_000) };
  const bytes = bytesOf(big);
  assert.ok(bytes > OLD_BYTES);
  const heapFor = (boundBytes: number) => ({ used_heap_size: 200_000_000,
    heap_size_limit: Math.ceil((boundBytes * OPS_SNAPSHOT_HEAP_BYTES_PER_CATALOG_BYTE + 200_000_000) / HEAP_LIMIT_EXIT_FRACTION) });
  for (const boundBytes of [bytes + 1_000, 12 * 1024 * 1024, 64 * 1024 * 1024]) {
    const heap = heapFor(boundBytes);
    assert.ok(Math.abs(opsCatalogHeapByteBound(heap) - boundBytes) <= 1, "bound = (exit share of the limit - used) / measured cost per byte");
    const snap = await readOpsCatalogSnapshotAsync(target, remote(big).api, { bounds: { heap: () => heap } });
    assert.equal(snap.outcome, "ok", `with room for ${boundBytes} bytes: ${said(snap)}`);
  }
  for (const boundBytes of [9 * 1024 * 1024, bytes - 1]) {
    const heap = heapFor(boundBytes);
    const allowed = opsCatalogHeapByteBound(heap);
    const snap = await readOpsCatalogSnapshotAsync(target, remote(big).api, { bounds: { heap: () => heap } });
    assert.equal(snap.outcome, "malformed", said(snap));
    assert.equal(snap.refusalStage, "blob_verification");
    assert.equal(snap.bound?.reason, "heap_bytes");
    assert.equal(snap.bound?.allowed, allowed, "the bound moves with the heap reading");
    assert.ok(snap.bound!.observed > allowed && snap.bound!.observed <= bytes, "refused at the first byte past it, whole");
  }
  // The live reading: this process's own heap leaves room far past the baseline.
  assert.ok(opsCatalogHeapByteBound() > OLD_BYTES);
  assert.equal(opsCatalogHeapByteBound({ used_heap_size: 10, heap_size_limit: 10 }), 0, "no headroom, no bytes past the baseline");

  // Blob reads: 600 shards need 601 blob GETs cold. The budget's allowance, not a literal, decides.
  const many = { mono: MONO, shards: shards(0, 600, 300) };
  const cold = remote(many);
  const refused = await readOpsCatalogSnapshotAsync(target, cold.api, { bounds: { blobReadAllowance: () => 100 } });
  assert.equal(refused.outcome, "unreadable", said(refused));
  assert.equal(refused.refusalStage, "shard_tree");
  assert.deepEqual(refused.bound, { reason: "blob_read_budget", observed: 601, allowed: 100 });
  assert.equal(cold.blobGets(), 0, "nothing was spent on a read the budget cannot finish");
  assert.equal((await readOpsCatalogSnapshotAsync(target, cold.api, { bounds: { blobReadAllowance: () => 601 } })).outcome, "ok");
  // A warm read needs only what changed: one new shard is one blob GET, within an allowance of one.
  cold.move({ mono: MONO, shards: { ...many.shards, ...shards(600, 1, 300) } });
  cold.reset();
  const warm = await readOpsCatalogSnapshotAsync(target, cold.api, { bounds: { blobReadAllowance: () => 1 } });
  assert.equal(warm.outcome, "ok", said(warm));
  assert.equal(cold.blobGets(), 1);
  assert.equal((await readOpsCatalogSnapshotAsync(target, remote(many).api, { bounds: { blobReadAllowance: () => undefined } })).outcome, "ok",
    "a budget with no reading sets no allowance; each GET still meets the transport's own admission");

  // The judge the migration uses for its copy is the same bounds.
  assert.equal(opsCatalogBoundRefusal({ shards: 601, bytes: 3_005_000 }), undefined);
  assert.equal(opsCatalogBoundRefusal({ shards: 900, bytes: 3_005_000 }), undefined, "any shard growth is admitted");
  assert.deepEqual(opsCatalogBoundRefusal({ shards: 40, bytes: bytes }, { heap: () => heapFor(9 * 1024 * 1024) }),
    { reason: "heap_bytes", observed: bytes, allowed: opsCatalogHeapByteBound(heapFor(9 * 1024 * 1024)) });
  assert.equal(opsCatalogBoundRefusal({ shards: 40, bytes }), undefined, "the live heap is the default");
  assert.deepEqual(opsCatalogBoundRefusal({ shards: 10, bytes: 3_000 }, { heap: () => ({ used_heap_size: 1, heap_size_limit: 1 }) }),
    { reason: "heap_bytes", observed: 3_000, allowed: 0 }, "a small catalog is judged too");
});

test("W1-T14368 criterion 4: a catalog of at most 500 shards and 8 MiB reads as origin/main did when the bounds admit it", async () => {
  // 500 shards and exactly 8 MiB: both removed backstops at their edge.
  const per = 16_777;
  const edge = { mono: `[]\n#${"m".repeat(OLD_BYTES - OLD_SHARDS * per - 5)}\n`, shards: shards(0, OLD_SHARDS, per) };
  assert.equal(bytesOf(edge), OLD_BYTES);
  const small = { mono: MONO, shards: shards(0, 10, 300) };
  const catalogs: Array<[string, { mono: string; shards: Record<string, string> }]> = [["edge", edge], ["small", small]];
  for (const [label, catalog] of catalogs) {
    const plain = remote(catalog);
    const today = await readOpsCatalogSnapshotAsync(target, plain.api);
    // Jumped from 10 shards to this one an instant ago.
    const judged = remote(small);
    assert.equal((await readOpsCatalogSnapshotAsync(target, judged.api, { bounds: roomy })).outcome, "ok");
    judged.move(catalog);
    judged.reset();
    const snap = await readOpsCatalogSnapshotAsync(target, judged.api, { bounds: roomy });
    assert.equal(snap.outcome, "ok", `${label}: ${said(snap)}`);
    assert.equal(snap.bound, undefined);
    assert.deepEqual({ ...view(snap), binding: undefined, counts: { ...snap.counts, fetchedObjects: undefined, cachedObjects: undefined } },
      { ...view(today), binding: undefined, counts: { ...today.counts, fetchedObjects: undefined, cachedObjects: undefined } }, label);
    assert.deepEqual(snap.binding?.shardBlobs, today.binding?.shardBlobs, `${label}: the same blobs`);
    assert.equal(snap.counts.shards, Object.keys(catalog.shards).length);
    assert.equal(snap.counts.bytes, bytesOf(catalog));
    // The blobs a run child is offered are the same bytes.
    assert.deepEqual(keptOpsCatalogBlobsForChild(`OPS-T${Object.keys(catalog.shards).length - 1}`, judged.api),
      keptOpsCatalogBlobsForChild(`OPS-T${Object.keys(catalog.shards).length - 1}`, plain.api), `${label}: the same offer`);
  }
  // origin/main's own counts for the edge catalog, read cold: 1 commit + 3 trees + 501 blobs fetched, 3 trees of entries.
  const cold = await readOpsCatalogSnapshotAsync(target, remote(edge).api, { bounds: roomy });
  assert.deepEqual(cold.counts, { treeEntries: 1 + 2 + 500, shards: 500, bytes: OLD_BYTES, passes: 1, fetchedObjects: [505], cachedObjects: 0 });
  // A content refusal keeps origin/main's outcome and stage: a malformed shard.
  const bad = remote({ mono: MONO, shards: { ...small.shards, "x.yaml": "- id: B\n" } });
  const malformed = await readOpsCatalogSnapshotAsync(target, bad.api, { bounds: roomy });
  assert.deepEqual([malformed.outcome, malformed.refusalStage, malformed.bound], ["malformed", "strict_parse", undefined]);
});

test("ops catalog growth is unbounded: a small catalog still gets the heap and blob checks", async () => {
  // Ten shards, far under the removed 500-shard and 8 MiB backstops: both derived bounds judge it all the same.
  const small = { mono: MONO, shards: shards(0, 10, 300) };
  assert.equal((await readOpsCatalogSnapshotAsync(target, remote(small).api, { bounds: roomy })).outcome, "ok", "positive control");
  const noHeap = await readOpsCatalogSnapshotAsync(target, remote(small).api, { bounds: { ...roomy, heap: () => ({ used_heap_size: 1, heap_size_limit: 1 }) } });
  assert.equal(noHeap.outcome, "malformed", said(noHeap));
  assert.equal(noHeap.refusalStage, "blob_verification");
  assert.equal(noHeap.bound?.reason, "heap_bytes");
  assert.equal(noHeap.bound?.allowed, 0);
  const cold = remote(small);
  const unpaid = await readOpsCatalogSnapshotAsync(target, cold.api, { bounds: { ...roomy, blobReadAllowance: () => 2 } });
  assert.equal(unpaid.outcome, "unreadable", said(unpaid));
  assert.equal(unpaid.refusalStage, "shard_tree");
  assert.deepEqual(unpaid.bound, { reason: "blob_read_budget", observed: 11, allowed: 2 });
  assert.equal(cold.blobGets(), 0, "refused before a blob is fetched");
  assert.deepEqual(opsCatalogBoundRefusal({ shards: 10, bytes: bytesOf(small) }, { heap: () => ({ used_heap_size: 1, heap_size_limit: 1 }) }),
    { reason: "heap_bytes", observed: bytesOf(small), allowed: 0 }, "the copy judge checks a small catalog too");
});

test("W1-T14563: no growth reason, record or alert remains", async (t) => {
  // No growth reason: OPS_CATALOG_BOUND_REASONS holds the heap and the blob budget, and nothing else.
  assert.deepEqual([...opsCatalogBoundReasons()], ["heap_bytes", "blob_read_budget"]);

  // No growth record: an ok read with a state dir, after a jump, writes none.
  const state = fs.mkdtempSync(join(tmpdir(), "rmd-ops-growth-"));
  try {
    const base = { mono: MONO, shards: shards(0, 482, 1_000) };
    const r = remote(base);
    assert.equal((await readOpsCatalogSnapshotAsync(target, r.api, { stateDir: state, bounds: roomy })).outcome, "ok");
    r.move({ mono: MONO, shards: { ...base.shards, ...shards(482, 300, 1_000) } });
    const snap = await readOpsCatalogSnapshotAsync(target, r.api, { stateDir: state, bounds: roomy });
    assert.equal(snap.outcome, "ok", said(snap));
    assert.ok(fs.existsSync(join(state, "cache")), "positive control: the read wrote its blob cache under the state dir");
    assert.equal(fs.existsSync(join(state, "cache", "ops-catalog-growth")), false, "no growth record is written");
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }

  // No growth alert: the daemon's feed over a catalog that jumps writes only its refresh rows, each ok, none of growth.
  const rows: Array<{ step: string; data: Record<string, unknown> }> = [];
  const f = remote({ mono: MONO, shards: shards(0, 482, 1_000) });
  const feed = opsCatalogShadowFeed(createOpsCatalogShadowSource(target, f.api, { bounds: roomy }), undefined,
    { log: (step, data) => rows.push({ step, data }) });
  t.after(() => feed.stop());
  const refreshed = async (): Promise<void> => {
    const before = rows.length;
    feed.current();
    for (let i = 0; i < 400 && rows.length === before; i++) await delay(5);
    assert.equal(rows.length, before + 1, "one completed refresh writes exactly one row");
  };
  await refreshed();
  f.move({ mono: MONO, shards: { ...shards(0, 482, 1_000), ...shards(482, 1_000, 600) } });
  await refreshed();
  assert.deepEqual(rows.map((row) => [row.step, row.data.outcome, row.data.bound]),
    [[OPS_CATALOG_REFRESHED_STEP, "ok", null], [OPS_CATALOG_REFRESHED_STEP, "ok", null]]);
  assert.equal(rows[1]!.data.shards, 1_482, "positive control: the second row read the jumped catalog");
  assert.equal(/growth/i.test(JSON.stringify(rows)), false, "no row names growth");
});

test("W1-T14368 criterion 3: plan-task-migration judges the ops catalog its copy would produce with the same bounds", async (t) => {
  // A real ops checkout of 500 shards: on origin/main the read itself is the bound, so a 501st shard could be copied in
  // and stop the reader; now the copy's catalog is what is judged.
  const ops = gitRepo({ scope: t, kind: "ops-catalog-copy" });
  const files: Record<string, string> = { "plan/tasks.yaml": MONO };
  for (const [name, text] of Object.entries(shards(0, OLD_SHARDS, 300))) files[`plan/tasks.d/${name}`] = text;
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(ops.dir, rel)), { recursive: true });
    fs.writeFileSync(join(ops.dir, rel), text);
  }
  ops.git("add", "-A");
  ops.git("commit", "--quiet", "-m", "seed");
  const commit = ops.git("rev-parse", "HEAD");
  const read = await catalog(ops.dir, commit, true);
  assert.deepEqual(read.size, { shards: 500, bytes: bytesOf({ mono: MONO, shards: shards(0, 500, 300) }), treeEntries: 1 + 2 + 500, shardDir: true });
  const original = shard("W1-T9", 400);
  const publicCommit = "c".repeat(40);
  assert.doesNotThrow(() => judgeOpsCopy(read.size!, original, publicCommit), "a 501st shard copied in is within the reader's bounds");
  const reason = (fn: () => void): string | undefined => {
    try { fn(); return undefined; } catch (error) { assert.ok(error instanceof PreviewUnknown); return error.reason; }
  };
  assert.equal(reason(() => judgeOpsCopy(read.size!, original, publicCommit, { heap: () => ({ used_heap_size: 2 ** 40, heap_size_limit: 2 ** 40 }) })),
    "catalog_incompatible", "the heap judges a copy of any size");
  const heavy = { ...read.size!, bytes: OLD_BYTES };
  assert.equal(reason(() => judgeOpsCopy(heavy, original, publicCommit, { heap: () => ({ used_heap_size: 2 ** 40, heap_size_limit: 2 ** 40 }) })),
    "catalog_incompatible", "a copy past the heap the reader has left is refused before it lands");
  // W1-T14638: no count of tree entries and no one shard's size refuses a copy.
  assert.equal(reason(() => judgeOpsCopy({ ...read.size!, treeEntries: 9_999, shardDir: false }, original, publicCommit)), undefined,
    "the copy's own tree entries are not counted against a ceiling");
  assert.equal(reason(() => judgeOpsCopy(read.size!, shard("W1-T9", 256 * 1024), publicCommit)), undefined, "and its own blob is not bounded by a fixed size");
  assert.equal((await catalog(ops.dir, commit)).size, undefined, "the public read carries no ops size");
});
