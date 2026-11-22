// W1-T14368: the ops catalog reader refused any catalog past 500 shards or 8 MiB as malformed, and the ops catalog grows
// about 55 shards a day, so ops dispatch was days from stopping. Past those backstops the bounds are now derived: the
// snapshot's measured heap cost against the heap the daemon has left, the blob reads a refresh needs against the GitHub
// budget, and a jump against the catalog's measured growth since the last accepted snapshot. Inside the backstops a
// catalog reads exactly as before.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fixedClock, type Clock } from "#src/lib/clock.js";
import { HEAP_LIMIT_EXIT_FRACTION } from "#src/lib/daemon-memory-policy.js";
import {
  OPS_CATALOG_BASELINE_BYTES, OPS_CATALOG_BASELINE_SHARDS, OPS_CATALOG_MEASURED_DAILY_GROWTH,
  OPS_SNAPSHOT_HEAP_BYTES_PER_CATALOG_BYTE, acceptOfferedOpsCatalogBlobs, createOpsCatalogShadowSource, keptOpsCatalogBlobsForChild,
  opsCatalogBoundRefusal, opsCatalogGrowthFile, opsCatalogHeapByteBound, readOpsCatalogSnapshotAsync,
  type OpsCatalogApi, type OpsCatalogBoundsIo, type OpsCatalogSnapshot,
} from "#src/lib/ops-catalog-source.js";
import { PreviewUnknown, catalog, judgeOpsCopy } from "#src/lib/plan-task-migration.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const REPO = "acme-private/ops-growth";
const REPO_ID = 4242;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 22, 6, 0, 0);
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

/** A clock a test moves by setting `at`. */
const clock = (at: number): Clock & { at: number } => {
  const c = { at, now: () => c.at, date: () => new Date(c.at), iso: () => new Date(c.at).toISOString() };
  return c;
};
const said = (snap: { outcome: string; refusalStage?: string }) => `${snap.outcome}${snap.refusalStage ? ` at ${snap.refusalStage}` : ""}`;
const view = (snap: OpsCatalogSnapshot) => ({ outcome: snap.outcome, refusalStage: snap.refusalStage, counts: snap.counts, bound: snap.bound,
  tasks: snap.plan?.tasks.map((t) => t.id), binding: snap.binding });

test("W1-T14368 criterion 1: a catalog of 600 shards and 3 MB, grown at the measured daily rate since the last accepted snapshot, reads ok and dispatches", async () => {
  const before = { mono: MONO, shards: shards(0, 600 - OPS_CATALOG_MEASURED_DAILY_GROWTH.shards, 5_000) };
  const after = { mono: MONO, shards: { ...before.shards, ...shards(600 - OPS_CATALOG_MEASURED_DAILY_GROWTH.shards, OPS_CATALOG_MEASURED_DAILY_GROWTH.shards, 5_000) } };
  assert.equal(Object.keys(after.shards).length, 600);
  assert.ok(bytesOf(after) >= 3_000_000 && bytesOf(after) < OPS_CATALOG_BASELINE_BYTES, "3 MB, inside the old byte backstop");
  assert.ok(bytesOf(after) - bytesOf(before) <= OPS_CATALOG_MEASURED_DAILY_GROWTH.bytes, "the day's bytes are within the measured growth too");

  // The one-shot read every CLI and run child takes, with the live heap and GitHub budget readings.
  const t = clock(T0);
  const r = remote(before);
  assert.equal((await readOpsCatalogSnapshotAsync(target, r.api, { bounds: { clock: t } })).outcome, "ok");
  r.move(after);
  t.at = T0 + DAY;
  const snap = await readOpsCatalogSnapshotAsync(target, r.api, { bounds: { clock: t } });
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
  const d = clock(T0);
  const feed = remote(before);
  const source = createOpsCatalogShadowSource(target, feed.api, { bounds: { clock: d } });
  assert.equal((await source.refresh()).outcome, "ok");
  feed.move(after);
  d.at = T0 + DAY;
  const input = await source.refresh();
  assert.equal(input.outcome, "ok", `the dispatch source read ${said(input)}`);
  assert.equal(input.plan?.tasks.length, 600);
  assert.ok(input.plan?.byId.has("OPS-T599"), "the newest shard's task is dispatchable");
  assert.equal(feed.blobGets() - (600 - OPS_CATALOG_MEASURED_DAILY_GROWTH.shards + 1), OPS_CATALOG_MEASURED_DAILY_GROWTH.shards,
    "the refresh after the move fetched only the new shards' blobs");
});

test("W1-T14368 criterion 2: a runaway jump from the last accepted snapshot is refused with a named reason and both numbers, and heals as the catalog's own measured growth allows", async () => {
  const daily = OPS_CATALOG_MEASURED_DAILY_GROWTH;
  const base = { mono: MONO, shards: shards(0, 482, 5_000) };
  const t = clock(T0);
  const io: OpsCatalogBoundsIo = { clock: t };
  const r = remote(base);
  assert.equal((await readOpsCatalogSnapshotAsync(target, r.api, { bounds: io })).outcome, "ok");

  // Shards: 218 more an hour later, where one day's measured growth allows 118. Refused before any new blob is fetched.
  const runaway = { mono: MONO, shards: { ...base.shards, ...shards(482, 218, 5_000) } };
  r.move(runaway);
  r.reset();
  t.at = T0 + 3_600_000;
  const jumped = await readOpsCatalogSnapshotAsync(target, r.api, { bounds: io });
  assert.equal(jumped.outcome, "malformed", said(jumped));
  assert.equal(jumped.refusalStage, "shard_tree");
  assert.deepEqual(jumped.bound, { reason: "shard_growth", observed: 218, allowed: daily.shards }, "the refusal names the jump and the growth allowed");
  assert.equal(jumped.plan, undefined);
  assert.equal(r.blobGets(), 0, "refused whole, before a blob of the runaway is fetched");

  // The dispatch source says the same: stale after its earlier success, with the bound attached for its row.
  const s = remote(base);
  const source = createOpsCatalogShadowSource(target, s.api, { bounds: io });
  t.at = T0;
  assert.equal((await source.refresh()).outcome, "ok");
  s.move(runaway);
  t.at = T0 + 3_600_000;
  const stale = await source.refresh();
  assert.equal(stale.outcome, "stale");
  assert.equal(stale.plan, undefined);
  assert.deepEqual(stale.bound, { reason: "shard_growth", observed: 218, allowed: daily.shards });
  assert.deepEqual(Object.keys(stale).sort(), ["outcome", "refusalStage"], "the bound is a non-enumerable diagnostic");

  // Bytes: 38 new shards (within the shard growth) carrying 760,000 bytes, where a day's measured growth is 633,709.
  const b = remote(base);
  t.at = T0;
  assert.equal((await readOpsCatalogSnapshotAsync(target, b.api, { bounds: io })).outcome, "ok");
  b.move({ mono: MONO, shards: { ...base.shards, ...shards(482, 38, 20_000) } });
  t.at = T0 + 3_600_000;
  const heavy = await readOpsCatalogSnapshotAsync(target, b.api, { bounds: io });
  assert.equal(heavy.outcome, "malformed", said(heavy));
  assert.equal(heavy.refusalStage, "blob_verification");
  assert.deepEqual(heavy.bound, { reason: "byte_growth", observed: 38 * 20_000, allowed: daily.bytes });

  // The refusal heals as time passes: two UTC days after the accepted snapshot, 218 shards is two days' growth.
  t.at = T0 + 2 * DAY;
  const healed = await readOpsCatalogSnapshotAsync(target, r.api, { bounds: io });
  assert.equal(healed.outcome, "ok", said(healed));
  assert.equal(healed.counts.shards, 700);

  // A catalog that keeps growing faster than the fallback teaches the reader its rate: 150 a day for two days in a row.
  const g = remote(base);
  const day = (n: number) => T0 + n * DAY;
  t.at = day(0);
  assert.equal((await readOpsCatalogSnapshotAsync(target, g.api, { bounds: io })).outcome, "ok");
  g.move({ mono: MONO, shards: { ...base.shards, ...shards(482, 150, 1_000) } });
  t.at = day(1);
  assert.deepEqual((await readOpsCatalogSnapshotAsync(target, g.api, { bounds: io })).bound, { reason: "shard_growth", observed: 150, allowed: daily.shards },
    "one fast day is refused");
  g.move({ mono: MONO, shards: { ...base.shards, ...shards(482, 300, 1_000) } });
  t.at = day(2);
  const learned = await readOpsCatalogSnapshotAsync(target, g.api, { bounds: io });
  assert.equal(learned.outcome, "ok", `a second day at 150 read ${said(learned)}`);

  // One jump teaches nothing: a single day of +1,000 stays refused the next day.
  const j = remote(base);
  t.at = day(0);
  assert.equal((await readOpsCatalogSnapshotAsync(target, j.api, { bounds: io })).outcome, "ok");
  j.move({ mono: MONO, shards: { ...base.shards, ...shards(482, 1_000, 600) } });
  t.at = day(1);
  assert.equal((await readOpsCatalogSnapshotAsync(target, j.api, { bounds: io })).bound?.reason, "shard_growth");
  j.move({ mono: MONO, shards: { ...base.shards, ...shards(482, 1_010, 600) } });
  t.at = day(2);
  assert.deepEqual((await readOpsCatalogSnapshotAsync(target, j.api, { bounds: io })).bound,
    { reason: "shard_growth", observed: 1_010, allowed: 2 * daily.shards });
});

test("W1-T14368 criterion 2: the last accepted snapshot survives a restart through the state dir", async () => {
  const state = fs.mkdtempSync(join(tmpdir(), "rmd-ops-growth-"));
  try {
    const t = clock(T0);
    const io: OpsCatalogBoundsIo = { clock: t };
    const base = { mono: MONO, shards: shards(0, 482, 1_000) };
    const first = remote(base);
    assert.equal((await readOpsCatalogSnapshotAsync(target, first.api, { stateDir: state, bounds: io })).outcome, "ok");
    const file = opsCatalogGrowthFile(state, REPO_ID);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the record is owner-only");
    assert.ok(!/OPS-T|remudero|title/.test(fs.readFileSync(file, "utf8")), "it holds counts and times, no record text");
    // A new process: a fresh api with no memory of the first read.
    const restarted = remote({ mono: MONO, shards: { ...base.shards, ...shards(482, 300, 1_000) } });
    t.at = T0 + 60_000;
    const snap = await readOpsCatalogSnapshotAsync(target, restarted.api, { stateDir: state, bounds: io });
    assert.deepEqual(snap.bound, { reason: "shard_growth", observed: 300, allowed: OPS_CATALOG_MEASURED_DAILY_GROWTH.shards });
    // A damaged record is no record: the read answers from the bounds that need none, and the next ok read rewrites it.
    fs.writeFileSync(file, "{not json");
    const fresh = remote({ mono: MONO, shards: shards(0, 600, 1_000) });
    assert.equal((await readOpsCatalogSnapshotAsync(target, fresh.api, { stateDir: state, bounds: io })).outcome, "ok");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).latest.shards, 600);
    for (const damaged of ['{"days":"x"}', '{"days":[],"latest":{"at":-1,"shards":1,"bytes":1}}', JSON.stringify({ days: [{ day: 1, shards: 1.5 }] }), " ".repeat(20_000)]) {
      fs.writeFileSync(file, damaged);
      assert.equal((await readOpsCatalogSnapshotAsync(target, remote({ mono: MONO, shards: shards(0, 900, 300) }).api, { stateDir: state, bounds: io })).outcome, "ok", damaged.slice(0, 40));
    }
    // A record that cannot be written leaves no temporary file and changes nothing the read answers.
    fs.rmSync(join(state, "cache", "ops-catalog-growth"), { recursive: true, force: true });
    fs.writeFileSync(join(state, "cache", "ops-catalog-growth"), "a file where the directory goes");
    assert.equal((await readOpsCatalogSnapshotAsync(target, remote(base).api, { stateDir: state, bounds: io })).outcome, "ok");
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("W1-T14368 criterion 3: the byte bound is the measured heap cost against the heap left, and blob reads are counted against the GitHub budget; neither is a literal", async () => {
  // Past the byte baseline: 40 shards of 250,000 bytes, 10 MB.
  const big = { mono: MONO, shards: shards(0, 40, 250_000) };
  const bytes = bytesOf(big);
  assert.ok(bytes > OPS_CATALOG_BASELINE_BYTES);
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
  assert.ok(opsCatalogHeapByteBound() > OPS_CATALOG_BASELINE_BYTES);
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
  const reference = { at: T0, shards: 600, bytes: 3_000_000 };
  assert.equal(opsCatalogBoundRefusal({ shards: 601, bytes: 3_005_000 }, reference, { clock: fixedClock(T0) }), undefined);
  assert.deepEqual(opsCatalogBoundRefusal({ shards: 900, bytes: 3_005_000 }, reference, { clock: fixedClock(T0) }),
    { reason: "shard_growth", observed: 300, allowed: OPS_CATALOG_MEASURED_DAILY_GROWTH.shards });
  assert.deepEqual(opsCatalogBoundRefusal({ shards: 40, bytes: bytes }, undefined, { heap: () => heapFor(9 * 1024 * 1024) }),
    { reason: "heap_bytes", observed: bytes, allowed: opsCatalogHeapByteBound(heapFor(9 * 1024 * 1024)) });
  assert.equal(opsCatalogBoundRefusal({ shards: 40, bytes }, undefined), undefined, "the live heap and clock are the defaults");
  assert.equal(opsCatalogBoundRefusal({ shards: OPS_CATALOG_BASELINE_SHARDS, bytes: OPS_CATALOG_BASELINE_BYTES }, undefined,
    { heap: () => ({ used_heap_size: 1, heap_size_limit: 1 }) }), undefined, "inside the baseline nothing is judged");
});

test("W1-T14368 criterion 4: invariant:a-catalog-within-todays-bounds-reads-as-today — at most 500 shards and 8 MiB reads exactly as origin/main, whatever the derived bounds would say", async () => {
  // The hostile readings: no heap left, no GitHub budget, and a reference the catalog jumped far past a moment ago.
  const hostile: OpsCatalogBoundsIo = { clock: fixedClock(T0), heap: () => ({ used_heap_size: 1, heap_size_limit: 1 }), blobReadAllowance: () => 0 };
  // 500 shards and exactly 8 MiB: both backstops at their edge.
  const per = 16_777;
  const edge = { mono: `[]\n#${"m".repeat(OPS_CATALOG_BASELINE_BYTES - OPS_CATALOG_BASELINE_SHARDS * per - 5)}\n`, shards: shards(0, OPS_CATALOG_BASELINE_SHARDS, per) };
  assert.equal(bytesOf(edge), OPS_CATALOG_BASELINE_BYTES);
  const small = { mono: MONO, shards: shards(0, 10, 300) };
  const catalogs: Array<[string, { mono: string; shards: Record<string, string> }]> = [["edge", edge], ["small", small]];
  for (const [label, catalog] of catalogs) {
    const plain = remote(catalog);
    const today = await readOpsCatalogSnapshotAsync(target, plain.api);
    // Jumped from 10 shards to this one an instant ago, under the hostile readings.
    const judged = remote(small);
    assert.equal((await readOpsCatalogSnapshotAsync(target, judged.api, { bounds: hostile })).outcome, "ok");
    judged.move(catalog);
    judged.reset();
    const snap = await readOpsCatalogSnapshotAsync(target, judged.api, { bounds: hostile });
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
  const cold = await readOpsCatalogSnapshotAsync(target, remote(edge).api, { bounds: hostile });
  assert.deepEqual(cold.counts, { treeEntries: 1 + 2 + 500, shards: 500, bytes: OPS_CATALOG_BASELINE_BYTES, passes: 1, fetchedObjects: [505], cachedObjects: 0 });
  // A refusal inside the baseline keeps origin/main's outcome and stage: a malformed shard.
  const bad = remote({ mono: MONO, shards: { ...small.shards, "x.yaml": "- id: B\n" } });
  const malformed = await readOpsCatalogSnapshotAsync(target, bad.api, { bounds: hostile });
  assert.deepEqual([malformed.outcome, malformed.refusalStage, malformed.bound], ["malformed", "strict_parse", undefined]);

  // Positive control: the same hostile readings do refuse one shard and one byte past the baseline.
  const shardPast = { mono: MONO, shards: shards(0, OPS_CATALOG_BASELINE_SHARDS + 1, 300) };
  const s = await readOpsCatalogSnapshotAsync(target, remote(shardPast).api, { bounds: hostile });
  assert.equal(s.bound?.reason, "blob_read_budget", `one shard past: ${said(s)}`);
  const bytePast = { mono: `${edge.mono.slice(0, -1)}m\n`, shards: edge.shards };
  assert.equal(bytesOf(bytePast), OPS_CATALOG_BASELINE_BYTES + 1);
  const b = await readOpsCatalogSnapshotAsync(target, remote(bytePast).api, { bounds: hostile });
  assert.deepEqual(b.bound, { reason: "heap_bytes", observed: OPS_CATALOG_BASELINE_BYTES + 1, allowed: 0 }, `one byte past: ${said(b)}`);
});

test("W1-T14368 criterion 3: plan-task-migration judges the ops catalog its copy would produce with the same bounds", async (t) => {
  // A real ops checkout of 500 shards: on origin/main the read itself is the bound, so a 501st shard could be copied in
  // and stop the reader; now the copy's catalog is what is judged.
  const ops = gitRepo({ scope: t, kind: "ops-catalog-copy" });
  const files: Record<string, string> = { "plan/tasks.yaml": MONO };
  for (const [name, text] of Object.entries(shards(0, OPS_CATALOG_BASELINE_SHARDS, 300))) files[`plan/tasks.d/${name}`] = text;
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
  assert.equal(reason(() => judgeOpsCopy(read.size!, original, publicCommit, { heap: () => ({ used_heap_size: 2 ** 40, heap_size_limit: 2 ** 40 }) })), undefined,
    "the heap judges only bytes past the byte baseline");
  const heavy = { ...read.size!, bytes: OPS_CATALOG_BASELINE_BYTES };
  assert.equal(reason(() => judgeOpsCopy(heavy, original, publicCommit, { heap: () => ({ used_heap_size: 2 ** 40, heap_size_limit: 2 ** 40 }) })),
    "catalog_incompatible", "a copy past the heap the reader has left is refused before it lands");
  assert.equal(reason(() => judgeOpsCopy({ ...read.size!, treeEntries: 9_999, shardDir: false }, original, publicCommit)), "catalog_incompatible",
    "the copy's own tree entries count");
  assert.equal(reason(() => judgeOpsCopy(read.size!, shard("W1-T9", 256 * 1024), publicCommit)), "catalog_incompatible", "and its own blob");
  assert.equal((await catalog(ops.dir, commit)).size, undefined, "the public read carries no ops size");
});
