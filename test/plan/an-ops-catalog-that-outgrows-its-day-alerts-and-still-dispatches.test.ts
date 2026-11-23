// W1-T14557: on 2026-11-23 the ops catalog grew 122 shards in a day from ordinary filings, where its daily allowance was
// 118, and the reader refused every full read from then on: ops dispatch and the catalog move were held until the day
// rolled over. Growth past the allowance is now accepted and named once a UTC day; a record the catalog mover copied
// (it carries moved_from) is not growth; the heap-byte and blob-read-budget bounds still refuse.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import { OPS_CATALOG_GROWTH_EXCEEDED_STEP, opsCatalogShadowFeed } from "#src/cli/commands/daemon.js";
import {
  OPS_CATALOG_BASELINE_BYTES, OPS_CATALOG_MEASURED_DAILY_GROWTH, createOpsCatalogShadowSource, isMovedCopyShard,
  readOpsCatalogSnapshotAsync, type OpsCatalogApi, type OpsCatalogBoundsIo,
} from "#src/lib/ops-catalog-source.js";
import { PreviewUnknown, judgeOpsBatch } from "#src/lib/plan-task-migration.js";

const REPO = "acme-private/ops-outgrown";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 23, 1, 0, 0);
const target = { repository: REPO };
const PUBLIC_COMMIT = "c".repeat(40);
const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const blobSha = (text: string): string => sha1(`blob ${Buffer.byteLength(text)}\0${text}`);
const record = (id: string): string => `- id: ${id}\n  title: "t ${id}"\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [src/a.ts]\n`;
const moved = (id: string): string => record(id).replace(/\n/, `\n  moved_from: remudero@${PUBLIC_COMMIT}\n`);
type Catalog = Record<string, string>;
const filed = (from: number, n: number, make = record): Catalog =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`W1-T${from + i}.yaml`, make(`W1-T${from + i}`)]));

/** A GET-only fake of the git data API whose branch moves to a new shard set. */
function remote(initial: Catalog) {
  const blobs = new Map<string, string>();
  let version = 0;
  let current = initial;
  const put = (t: string): string => { const s = blobSha(t); blobs.set(s, t); return s; };
  const entry = (path: string, type: string, mode: string, s: string) => ({ path, type, mode, sha: s });
  const api: OpsCatalogApi = async (path) => {
    const v = { commit: sha1(`c${version}`), root: sha1(`r${version}`), plan: sha1(`p${version}`), dir: sha1(`d${version}`) };
    if (path === `repos/${REPO}`) return { id: 5150, full_name: REPO, default_branch: "main" };
    if (path === `repos/${REPO}/git/ref/heads/main`) return { object: { type: "commit", sha: v.commit } };
    if (path === `repos/${REPO}/git/commits/${v.commit}`) return { sha: v.commit, tree: { sha: v.root } };
    if (path === `repos/${REPO}/git/trees/${v.root}`) return { sha: v.root, truncated: false, tree: [entry("plan", "tree", "040000", v.plan)] };
    if (path === `repos/${REPO}/git/trees/${v.plan}`) {
      return { sha: v.plan, truncated: false, tree: [entry("tasks.yaml", "blob", "100644", put("[]\n")), entry("tasks.d", "tree", "040000", v.dir)] };
    }
    if (path === `repos/${REPO}/git/trees/${v.dir}`) {
      return { sha: v.dir, truncated: false, tree: Object.entries(current).map(([n, t]) => entry(n, "blob", "100644", put(t))) };
    }
    const m = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
    if (m && blobs.has(m[1]!)) {
      const t = blobs.get(m[1]!)!;
      return { sha: m[1], encoding: "base64", size: Buffer.byteLength(t), content: Buffer.from(t).toString("base64") };
    }
    throw new Error(`unexpected GET ${path}`);
  };
  return { api, move(next: Catalog) { current = next; version++; } };
}
const clock = (at: number): Clock & { at: number } => {
  const c = { at, now: () => c.at, date: () => new Date(c.at), iso: () => new Date(c.at).toISOString() };
  return c;
};

/** The daemon's dispatch feed over a real source, its rows captured; `refresh` settles one read. */
function feed(api: OpsCatalogApi, t: Clock, io: OpsCatalogBoundsIo = { clock: t }) {
  const rows: Array<{ step: string; data: Record<string, unknown> }> = [];
  let settled: () => void = () => {};
  const source = createOpsCatalogShadowSource(target, api, { bounds: io });
  const shadow = opsCatalogShadowFeed(source, t, {
    log: (step, data) => { rows.push({ step, data }); }, onSettled: () => settled(),
  });
  return {
    rows, shadow,
    // Settled after the feed's own bookkeeping turn, so the next refresh is not taken for one still in flight.
    refresh: () => new Promise<void>((resolve) => { settled = () => setImmediate(resolve); shadow.current(); }),
    exceeded: () => rows.filter((row) => row.step === OPS_CATALOG_GROWTH_EXCEEDED_STEP),
  };
}

test("W1-T14557 criterion 1: a shard tree that grew past its day's allowance is accepted for dispatch and writes one growth row naming observed and allowed", async () => {
  // The 2026-11-23 shape: 413 shards at the day's first accepted read, 535 later the same day.
  const t = clock(T0);
  const r = remote(filed(0, 413));
  const f = feed(r.api, t);
  await f.refresh();
  assert.equal(f.shadow.forDispatch()?.outcome, "ok");
  r.move(filed(0, 535));
  t.at = T0 + 20 * 3_600_000;
  await f.refresh();
  const input = f.shadow.forDispatch();
  assert.equal(input?.outcome, "ok", "THE CLAIM: on origin/main this read answers stale with bound shard_growth and dispatch is held");
  assert.equal(input?.plan?.tasks.length, 535, "the grown catalog is the one dispatch reads");
  assert.equal(input?.bound, undefined);
  assert.deepEqual(f.exceeded().map((row) => row.data),
    [{ reason: "shard_growth", observed: 122, allowed: OPS_CATALOG_MEASURED_DAILY_GROWTH.shards, shards: 535, bytes: input?.counts?.bytes }],
    "one row names the jump and the growth allowed");
  const refreshed = f.rows.filter((row) => row.step === "dispatch.ops_catalog_refreshed").map((row) => row.data.outcome);
  assert.deepEqual(refreshed, ["ok", "ok"], "the refresh row reads ok, not stale");
});

test("W1-T14557 criterion 2: the growth row is written once per UTC day however many refreshes exceed the allowance, and a later day writes its own", async () => {
  const t = clock(T0);
  const r = remote(filed(0, 413));
  const f = feed(r.api, t);
  await f.refresh();
  // Six more full reads the same day, each past the allowance: one row.
  for (let i = 1; i <= 6; i++) {
    r.move(filed(0, 532 + i));
    t.at = T0 + i * 3_600_000;
    await f.refresh();
    assert.equal(f.shadow.forDispatch()?.outcome, "ok");
  }
  assert.equal(f.exceeded().length, 1, "THE CLAIM: one row a day, not one per refresh");
  // A revalidation of an unchanged branch writes none either.
  await f.refresh();
  assert.equal(f.exceeded().length, 1);
  // The next UTC day grows past its own allowance from the day's first accepted read: it writes its own row.
  t.at = T0 + DAY;
  await f.refresh();
  r.move(filed(0, 538 + 130));
  t.at = T0 + DAY + 3_600_000;
  await f.refresh();
  assert.equal(f.exceeded().length, 2, "a later day that exceeds again writes its own");
  assert.equal(f.exceeded()[1]!.data.reason, "shard_growth");
});

test("W1-T14557 criterion 3: shards whose record carries a moved_from line do not count toward growth, in the reader and in judgeOpsBatch", async () => {
  assert.equal(isMovedCopyShard(moved("W1-T7")), true);
  assert.equal(isMovedCopyShard(record("W1-T7")), false, "a record without moved_from is growth");
  assert.equal(isMovedCopyShard(`${moved("W1-T7")}${record("W1-T8")}`), false, "a shard of two records is not one copy");
  assert.equal(isMovedCopyShard(record("W1-T7").replace("  repo:", `  moved_from: remudero@${PUBLIC_COMMIT}\n  repo:`)), false,
    "moved_from must follow the id line, where the mover writes it");
  // Reader: 413 filed, then 413 filed plus 300 moved copies the same day. Growth seen is 0, so no row and ok.
  const t = clock(T0);
  const r = remote(filed(0, 413));
  const f = feed(r.api, t);
  await f.refresh();
  r.move({ ...filed(0, 413), ...filed(5_000, 300, moved) });
  t.at = T0 + 3_600_000;
  await f.refresh();
  assert.equal(f.shadow.forDispatch()?.plan?.tasks.length, 713);
  assert.deepEqual(f.exceeded(), [], "THE CLAIM: a move batch never trips the growth row");
  // The same 300 shards filed as new work do count.
  const n = remote(filed(0, 413));
  const g = feed(n.api, clock(T0));
  await g.refresh();
  n.move({ ...filed(0, 413), ...filed(5_000, 300) });
  await g.refresh();
  assert.equal(g.exceeded()[0]?.data.observed, 300, "the falsifier: unmoved growth is still named");
  // judgeOpsBatch: a 300-record copy into a 600-shard catalog is never refused on growth.
  const size = { shards: 600, bytes: 300_000, treeEntries: 603, shardDir: true, dayStart: { at: T0, shards: 413, bytes: 200_000 } };
  const originals = Array.from({ length: 300 }, (_, i) => record(`W1-T${9_000 + i}`));
  assert.doesNotThrow(() => judgeOpsBatch(size, originals, PUBLIC_COMMIT, { clock: clock(T0 + 60_000) }),
    "the batch's own copies are not growth, so it does not refuse its own copy");
});

test("W1-T14557 criterion 4: invariant:memory-bounds-still-refuse — the heap-byte bound and the blob-read budget still refuse exactly as on origin/main", async () => {
  // Heap: a catalog past the byte baseline with no heap left is refused whole, at blob verification.
  const per = 40_000;
  const big = filed(0, 220, (id) => `${record(id)}# ${"x".repeat(per)}\n`);
  const heap = await readOpsCatalogSnapshotAsync(target, remote(big).api, { bounds: { heap: () => ({ used_heap_size: 1, heap_size_limit: 1 }) } });
  assert.equal(heap.outcome, "malformed");
  assert.equal(heap.refusalStage, "blob_verification");
  assert.equal(heap.bound?.reason, "heap_bytes");
  assert.ok(Object.values(big).reduce((s, x) => s + x.length, 0) > OPS_CATALOG_BASELINE_BYTES);
  // Blob budget: 600 shards cold with an allowance of 100 are refused before a blob is fetched.
  const budget = await readOpsCatalogSnapshotAsync(target, remote(filed(0, 600)).api, { bounds: { blobReadAllowance: () => 100 } });
  assert.equal(budget.outcome, "unreadable");
  assert.equal(budget.refusalStage, "shard_tree");
  assert.deepEqual(budget.bound, { reason: "blob_read_budget", observed: 601, allowed: 100 });
  // And judgeOpsBatch still refuses a copy past the heap the reader has left.
  const size = { shards: 600, bytes: OPS_CATALOG_BASELINE_BYTES, treeEntries: 603, shardDir: true };
  assert.throws(() => judgeOpsBatch(size, [record("W1-T9")], PUBLIC_COMMIT, { heap: () => ({ used_heap_size: 2 ** 40, heap_size_limit: 2 ** 40 }) }),
    (error: unknown) => error instanceof PreviewUnknown && error.reason === "catalog_incompatible");
});
