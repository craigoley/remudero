// W1-T14557 (operator ruling 2026-11-23, "alert plus exempt moves"): from 21:11Z on 2026-11-23 every ops catalog refresh
// answered stale (shard_growth observed 122 allowed 118), which held all ops dispatch and the catalog mover until the
// day's anchor aged out. A growth past the learned daily allowance is now accepted: the read becomes the latest snapshot,
// the daemon writes one ops_catalog.growth_exceeded row and opens one escalation per UTC day, the mover's copies (they
// carry moved_from) are not growth, and only the heap-byte and blob-read-budget bounds still refuse a snapshot.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Load the existing analytics side of the daemon's import cycle first.
import "#src/lib/live-analytics-snapshot-cache.js";
import {
  OPS_CATALOG_GROWTH_EXCEEDED_STEP, OPS_CATALOG_REFRESHED_STEP, opsCatalogGrowthEscalation, opsCatalogGrowthRaiser, opsCatalogShadowFeed,
} from "#src/cli/commands/daemon.js";
import { fixedClock, type Clock } from "#src/lib/clock.js";
import type { Escalation } from "#src/lib/escalate.js";
import { HEAP_LIMIT_EXIT_FRACTION } from "#src/lib/daemon-memory-policy.js";
import {
  OPS_CATALOG_BASELINE_BYTES, OPS_CATALOG_MEASURED_DAILY_GROWTH, OPS_SNAPSHOT_HEAP_BYTES_PER_CATALOG_BYTE,
  createOpsCatalogShadowSource, opsCatalogBoundRefusal, opsCatalogGrowthFile, opsCatalogHeapByteBound, readOpsCatalogSnapshotAsync,
  type OpsCatalogApi, type OpsCatalogBoundsIo, type OpsCatalogGrowthExceeded, type OpsCatalogShadowInput,
} from "#src/lib/ops-catalog-source.js";
import { PreviewUnknown, judgeOpsBatch, judgeOpsCopy, type OpsCatalogSize } from "#src/lib/plan-task-migration.js";

const REPO = "acme-private/ops-outgrown";
const REPO_ID = 5150;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 23, 0, 3, 57);
const target = { repository: REPO };
const DAILY = OPS_CATALOG_MEASURED_DAILY_GROWTH;
const PUBLIC_COMMIT = "a".repeat(40);
const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const blobSha = (text: string): string => sha1(`blob ${Buffer.byteLength(text)}\0${text}`);
const PRIVATE = "PRIVATE_TITLE_SENTINEL";

/** One task record padded with a comment to exactly `bytes` bytes; `moved` adds the mover's moved_from line after its id. */
function record(id: string, bytes: number, moved = false): string {
  const head = `- id: ${id}\n${moved ? `  moved_from: remudero@${PUBLIC_COMMIT}\n` : ""}  title: "${PRIVATE} ${id}"\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [src/a.ts]\n  rationale: r\n# `;
  const text = `${head}${"x".repeat(bytes - Buffer.byteLength(head) - 1)}\n`;
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
}
const MONO = "[]\n";
type Catalog = { mono: string; shards: Record<string, string> };
function shards(from: number, n: number, bytes: number, moved = false): Record<string, string> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`OPS-T${from + i}.yaml`, record(`OPS-T${from + i}`, bytes, moved)]));
}
const grown = (base: Catalog, more: Record<string, string>): Catalog => ({ mono: base.mono, shards: { ...base.shards, ...more } });

/** A recording GET-only fake of the git data API whose branch can be moved to a new catalog. */
function opsApi(initial: Catalog) {
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
    api,
    move(next: Catalog) { current = next; version++; },
    blobGets: () => calls.filter((p) => p.includes("/git/blobs/")).length,
    reset: () => { calls.length = 0; },
  };
}

/** A clock a test moves by setting `at`. */
const clock = (at: number): Clock & { at: number } => {
  const c = { at, now: () => c.at, date: () => new Date(c.at), iso: () => new Date(c.at).toISOString() };
  return c;
};

type Row = { step: string; data: Record<string, unknown> };
/** The daemon's feed over `source`: its rows, the escalations it raised, and a refresh that waits for it to settle. */
function feedOver(source: { refresh(): Promise<OpsCatalogShadowInput> }) {
  const rows: Row[] = [];
  const raised: OpsCatalogGrowthExceeded[] = [];
  let settle: (() => void) | undefined;
  const feed = opsCatalogShadowFeed(source, undefined, {
    log: (step, data) => rows.push({ step, data }),
    onGrowthExceeded: (growth) => raised.push(growth),
    onSettled: () => settle?.(),
  });
  const refresh = async (): Promise<OpsCatalogShadowInput> => {
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    feed.current();
    await settled;
    return feed.forDispatch()!;
  };
  const growthRows = () => rows.filter((r) => r.step === OPS_CATALOG_GROWTH_EXCEEDED_STEP).map((r) => r.data);
  return { rows, raised, refresh, feed, growthRows };
}

test("W1-T14557 criterion 1: a shard tree grown past the learned daily allowance from the day's anchor is accepted as ok, becomes the latest snapshot, dispatches, and writes one ops_catalog.growth_exceeded row naming observed and allowed", async (t) => {
  const state = fs.mkdtempSync(join(tmpdir(), "rmd-ops-outgrown-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const time = clock(T0);
  const io: OpsCatalogBoundsIo = { clock: time };
  // The 2026-11-23 shape: the day's anchor, then 122 more shards where the day allows 118.
  const base: Catalog = { mono: MONO, shards: shards(0, 482, 1_000) };
  const fx = opsApi(base);
  const { refresh, feed, rows, raised, growthRows } = feedOver(createOpsCatalogShadowSource(target, fx.api, { stateDir: state, bounds: io }));
  t.after(() => feed.stop());
  const anchor = await refresh();
  assert.equal(anchor.outcome, "ok");
  assert.equal(anchor.growthExceeded, undefined, "the anchor itself is no growth");

  fx.move(grown(base, shards(482, 122, 1_000)));
  time.at = T0 + 21 * 3_600_000;
  const outgrown = await refresh();
  assert.equal(outgrown.outcome, "ok", "THE CLAIM: the outgrown catalog is accepted, not stale");
  assert.equal(outgrown.plan?.tasks.length, 604, "the dispatch read holds every task of the outgrown catalog");
  assert.equal(outgrown.counts?.shards, 604);
  assert.deepEqual(outgrown.growthExceeded, { reason: "shard_growth", observed: 122, allowed: DAILY.shards, day: "2026-11-23", alert: true });
  assert.equal(outgrown.bound, undefined, "no bound refused it");
  const refreshRow = rows.filter((r) => r.step === OPS_CATALOG_REFRESHED_STEP).at(-1)!.data;
  assert.deepEqual([refreshRow.outcome, refreshRow.refusal_stage, refreshRow.bound, refreshRow.shards], ["ok", null, null, 604]);
  assert.deepEqual(growthRows(), [{ reason: "shard_growth", observed: 122, allowed: DAILY.shards, day: "2026-11-23" }],
    "THE CLAIM: one growth row naming observed and allowed");
  assert.equal(raised.length, 1, "and its escalation");
  assert.ok(!rows.some((r) => JSON.stringify(r.data).includes(PRIVATE)), "no row quotes a private record");
  assert.equal(JSON.parse(fs.readFileSync(opsCatalogGrowthFile(state, REPO_ID), "utf8")).latest.shards, 604, "it is the latest accepted snapshot");

  // The reader answers the same without the feed, and the byte growth is reported the same way.
  const direct = opsApi(base);
  time.at = T0;
  assert.equal((await readOpsCatalogSnapshotAsync(target, direct.api, { bounds: io })).outcome, "ok");
  direct.move(grown(base, shards(482, 38, 20_000)));
  time.at = T0 + 3_600_000;
  const heavy = await readOpsCatalogSnapshotAsync(target, direct.api, { bounds: io });
  assert.equal(heavy.outcome, "ok");
  assert.deepEqual(heavy.growthExceeded, { reason: "byte_growth", observed: 38 * 20_000, allowed: DAILY.bytes, day: "2026-11-23", alert: true });
  assert.deepEqual(Object.keys(heavy).sort(), ["counts", "identityDigest", "outcome"], "the growth is a non-enumerable diagnostic");
});

test("W1-T14557 criterion 2: the growth row and its escalation are written once per UTC day however many refreshes exceed the allowance, and a later day that exceeds it again writes its own", async (t) => {
  const state = fs.mkdtempSync(join(tmpdir(), "rmd-ops-outgrown-day-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const time = clock(T0);
  const io: OpsCatalogBoundsIo = { clock: time };
  const base: Catalog = { mono: MONO, shards: shards(0, 482, 1_000) };
  const fx = opsApi(base);
  const { refresh, feed, raised, growthRows } = feedOver(createOpsCatalogShadowSource(target, fx.api, { stateDir: state, bounds: io }));
  t.after(() => feed.stop());
  assert.equal((await refresh()).outcome, "ok");

  // Day one: three full reads past the allowance and two revalidations of the last.
  let total = 482;
  for (const [i, more] of [122, 10, 30].entries()) {
    fx.move(grown(base, shards(482, total - 482 + more, 1_000)));
    total += more;
    time.at = T0 + (i + 1) * 3_600_000;
    const input = await refresh();
    assert.equal(input.outcome, "ok");
    assert.equal(input.growthExceeded?.alert, i === 0, `read ${i + 1} of the day: ${JSON.stringify(input.growthExceeded)}`);
    assert.equal(input.growthExceeded?.observed, total - 482, "each read still reports its growth from the day's anchor");
  }
  for (let i = 0; i < 2; i++) assert.equal((await refresh()).growthExceeded, undefined, "a revalidation reports nothing");
  // A restarted daemon (a fresh api with no memory) reads the same day's record from the state dir.
  const restarted = opsApi(grown(base, shards(482, total - 482 + 5, 1_000)));
  total += 5;
  const again = await readOpsCatalogSnapshotAsync(target, restarted.api, { stateDir: state, bounds: io });
  assert.equal(again.outcome, "ok");
  assert.equal(again.growthExceeded?.alert, false, "the day already alerted, across a restart");
  assert.deepEqual(growthRows().map((r) => r.day), ["2026-11-23"], "THE CLAIM: one row for the day");
  assert.equal(raised.length, 1, "THE CLAIM: one escalation for the day");
  assert.equal(JSON.parse(fs.readFileSync(opsCatalogGrowthFile(state, REPO_ID), "utf8")).alertedDay, Math.floor(T0 / DAY));

  // The next UTC day grows past its allowance again: its own row and escalation.
  fx.move(grown(base, shards(482, total - 482 + 130, 1_000)));
  time.at = T0 + DAY + 3_600_000;
  const nextDay = await refresh();
  assert.equal(nextDay.outcome, "ok");
  assert.equal(nextDay.growthExceeded?.alert, true);
  assert.deepEqual(growthRows().map((r) => r.day), ["2026-11-23", "2026-11-24"], "THE CLAIM: a later day writes its own row");
  assert.deepEqual(raised.map((g) => g.day), ["2026-11-23", "2026-11-24"], "and opens its own escalation");

  // The escalation names the day in its summary, so a day dedupes to one issue, and carries numbers only.
  const [first, second] = raised.map(opsCatalogGrowthEscalation);
  assert.notEqual(first!.summary, second!.summary);
  assert.match(first!.summary, /2026-11-23/);
  assert.match(first!.detail, /grew 122 shards where its learned daily allowance is 118/);
  assert.ok(first!.options.some((o) => o.label === first!.recommendation));
  assert.ok(!JSON.stringify(first).includes(PRIVATE) && !JSON.stringify(first).includes(REPO), "no private text or repository name");
  assert.match(opsCatalogGrowthEscalation({ reason: "byte_growth", observed: 9, allowed: 1, day: "2026-11-25", alert: true }).detail, /grew 9 bytes/);

  // The daemon raises each through its escalation seam, off the loop; a raise that fails is absorbed (the row is the alert).
  const opened: Escalation[] = [];
  opsCatalogGrowthRaiser(async (e) => { opened.push(e); })(raised[0]!);
  opsCatalogGrowthRaiser(async () => { throw new Error("issues unreachable"); })(raised[1]!);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened.map((e) => e.summary), [first!.summary]);

  // A growth row that cannot be written changes nothing the refresh produced.
  const quiet = opsApi(base);
  const quietTime = clock(T0);
  let settled: (() => void) | undefined;
  const unwritable = opsCatalogShadowFeed(createOpsCatalogShadowSource(target, quiet.api, { bounds: { clock: quietTime } }), undefined, {
    log: (step) => { if (step === OPS_CATALOG_GROWTH_EXCEEDED_STEP) throw new Error("ledger full"); },
    onSettled: () => settled?.(),
  });
  t.after(() => unwritable.stop());
  const settle = async () => { const done = new Promise<void>((resolve) => { settled = resolve; }); unwritable.current(); await done; };
  await settle();
  quiet.move(grown(base, shards(482, 122, 1_000)));
  quietTime.at = T0 + 3_600_000;
  await settle();
  assert.equal(unwritable.forDispatch()?.outcome, "ok");
  assert.equal(unwritable.forDispatch()?.growthExceeded?.alert, true);
});

test("W1-T14557 criterion 3: shards whose record carries a moved_from line do not count toward the growth judged, in the reader and in judgeOpsBatch/judgeOpsCopy", async () => {
  const time = clock(T0);
  const io: OpsCatalogBoundsIo = { clock: time };
  const base: Catalog = { mono: MONO, shards: shards(0, 482, 1_000) };

  // The reader: a mover batch of 200 copies in an hour is no growth at all.
  const moves = opsApi(base);
  assert.equal((await readOpsCatalogSnapshotAsync(target, moves.api, { bounds: io })).outcome, "ok");
  moves.move(grown(base, shards(482, 200, 1_000, true)));
  time.at = T0 + 3_600_000;
  const copied = await readOpsCatalogSnapshotAsync(target, moves.api, { bounds: io });
  assert.equal(copied.outcome, "ok");
  assert.equal(copied.counts.shards, 682);
  assert.equal(copied.growthExceeded, undefined, "THE CLAIM: a move batch never trips the alert");
  // Moves beside filings: only the filings count, from an anchor that held moves too.
  moves.move(grown(base, { ...shards(482, 200, 1_000, true), ...shards(682, 50, 1_000, true), ...shards(732, 119, 1_000) }));
  time.at = T0 + 2 * 3_600_000;
  assert.deepEqual((await readOpsCatalogSnapshotAsync(target, moves.api, { bounds: io })).growthExceeded,
    { reason: "shard_growth", observed: 119, allowed: DAILY.shards, day: "2026-11-23", alert: true }, "the 119 filings, not the 50 moves");
  // Control: the same 200 records without moved_from are growth.
  const filed = opsApi(base);
  time.at = T0;
  assert.equal((await readOpsCatalogSnapshotAsync(target, filed.api, { bounds: io })).outcome, "ok");
  filed.move(grown(base, shards(482, 200, 1_000)));
  time.at = T0 + 3_600_000;
  assert.equal((await readOpsCatalogSnapshotAsync(target, filed.api, { bounds: io })).growthExceeded?.observed, 200, "positive control");

  // The mover's own judge: a batch past a catalog measured as not growing at all is admitted and reports no growth.
  const size: OpsCatalogSize = { shards: 600, bytes: 600_000, treeEntries: 603, shardDir: true };
  const batch = Array.from({ length: 32 }, (_, i) => record(`W1-T${i + 1}`, 900));
  const still: OpsCatalogBoundsIo = { clock: fixedClock(T0), dailyGrowth: () => ({ shards: 0, bytes: 0 }) };
  assert.equal(judgeOpsBatch(size, batch, PUBLIC_COMMIT, still), undefined, "THE CLAIM: the batch's own copies are not growth");
  assert.equal(judgeOpsCopy(size, batch[0]!, PUBLIC_COMMIT, still), undefined, "nor a single copy");
  const copyBytes = batch.reduce((sum, text) => sum + Buffer.byteLength(text) + Buffer.byteLength(`  moved_from: remudero@${PUBLIC_COMMIT}\n`), 0);
  assert.equal(opsCatalogBoundRefusal({ shards: 632, bytes: 600_000 + copyBytes }, { at: T0, ...size }, still)?.reason, "shard_growth",
    "positive control: the pure judge still reports the same catalog as growth when its copies are counted");
  // Filings since the day began are still reported, without the batch's own: 200, not 232; and nothing is refused.
  const filedToday = { ...size, dayStart: { at: T0 - 3_600_000, shards: 400, bytes: 400_000 } };
  assert.deepEqual(judgeOpsBatch(filedToday, batch, PUBLIC_COMMIT, still), { reason: "shard_growth", observed: 200, allowed: 0 });
});

test("W1-T14557 criterion 4: invariant:memory-bounds-still-refuse — a snapshot over the heap-byte bound or the blob-read budget is still refused exactly as on origin/main", async (t) => {
  // Heap: 40 shards of 250,000 bytes, 10 MB, past the byte baseline, with room for 9 MiB.
  const big: Catalog = { mono: MONO, shards: shards(0, 40, 250_000) };
  const heapFor = (boundBytes: number) => ({ used_heap_size: 200_000_000,
    heap_size_limit: Math.ceil((boundBytes * OPS_SNAPSHOT_HEAP_BYTES_PER_CATALOG_BYTE + 200_000_000) / HEAP_LIMIT_EXIT_FRACTION) });
  const heap = heapFor(9 * 1024 * 1024);
  const allowed = opsCatalogHeapByteBound(heap);
  const refused = await readOpsCatalogSnapshotAsync(target, opsApi(big).api, { bounds: { heap: () => heap } });
  assert.equal(refused.outcome, "malformed");
  assert.equal(refused.refusalStage, "blob_verification");
  assert.equal(refused.bound?.reason, "heap_bytes");
  assert.equal(refused.bound?.allowed, allowed);
  assert.equal(refused.plan, undefined);

  // A heap refusal on a catalog that also outgrew its day: still refused, stale to the feed, and no growth alert.
  const time = clock(T0);
  const small: Catalog = { mono: MONO, shards: shards(0, 482, 1_000) };
  const fx = opsApi(small);
  const { refresh, feed, growthRows, raised } = feedOver(createOpsCatalogShadowSource(target, fx.api, { bounds: { clock: time, heap: () => heap } }));
  t.after(() => feed.stop());
  assert.equal((await refresh()).outcome, "ok");
  fx.move(grown(small, shards(482, 130, 70_000)));
  time.at = T0 + 3_600_000;
  const stale = await refresh();
  assert.equal(stale.outcome, "stale");
  assert.equal(stale.bound?.reason, "heap_bytes");
  assert.deepEqual([growthRows(), raised], [[], []], "a refused read alerts nothing");

  // Blob budget: 600 shards cold need 601 GETs and the budget allows 100; refused before a blob is fetched.
  const many: Catalog = { mono: MONO, shards: shards(0, 600, 300) };
  const cold = opsApi(many);
  const budget = await readOpsCatalogSnapshotAsync(target, cold.api, { bounds: { blobReadAllowance: () => 100 } });
  assert.equal(budget.outcome, "unreadable");
  assert.equal(budget.refusalStage, "shard_tree");
  assert.deepEqual(budget.bound, { reason: "blob_read_budget", observed: 601, allowed: 100 });
  assert.equal(cold.blobGets(), 0);
  // A budget refusal of an outgrown catalog leaves the day unalerted: the next accepted read is the day's alert.
  const outgrown = opsApi(small);
  const day: OpsCatalogBoundsIo = { clock: clock(T0) };
  assert.equal((await readOpsCatalogSnapshotAsync(target, outgrown.api, { bounds: day })).outcome, "ok");
  outgrown.move(grown(small, shards(482, 122, 1_000)));
  outgrown.reset();
  const short = await readOpsCatalogSnapshotAsync(target, outgrown.api, { bounds: { ...day, blobReadAllowance: () => 50 } });
  assert.deepEqual([short.outcome, short.bound], ["unreadable", { reason: "blob_read_budget", observed: 122, allowed: 50 }]);
  assert.equal(outgrown.blobGets(), 0);
  assert.equal((await readOpsCatalogSnapshotAsync(target, outgrown.api, { bounds: day })).growthExceeded?.alert, true);

  // The mover's judge: a copy past the heap the reader has left is still refused before it lands.
  const heavy: OpsCatalogSize = { shards: 600, bytes: OPS_CATALOG_BASELINE_BYTES, treeEntries: 603, shardDir: true };
  assert.throws(() => judgeOpsCopy(heavy, record("W1-T9", 400), PUBLIC_COMMIT, { heap: () => ({ used_heap_size: 2 ** 40, heap_size_limit: 2 ** 40 }) }),
    (error: unknown) => error instanceof PreviewUnknown && error.reason === "catalog_incompatible");
});
