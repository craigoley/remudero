// W1-T14374: W1-T14368 made the ops catalog reader's shard and byte bounds derived and returns a refusal's
// {reason, observed, allowed}, but the dispatch.ops_catalog_refreshed row dropped both, so a refusal's numbers never
// reached the ledger. The row now carries the snapshot's shard and byte counts and, for a bound refusal, the bound.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
// Load the existing analytics side of the daemon's import cycle first.
import "#src/lib/live-analytics-snapshot-cache.js";
import { OPS_CATALOG_REFRESHED_STEP, opsCatalogShadowFeed } from "#src/cli/commands/daemon.js";
import {
  OPS_CATALOG_BASELINE_SHARDS, createOpsCatalogShadowSource, readOpsCatalogSnapshotAsync,
  type OpsCatalogApi, type OpsCatalogBoundsIo, type OpsCatalogShadowInput,
} from "#src/lib/ops-catalog-source.js";

type Row = { step: string; data: Record<string, unknown> };
const REPO = "acme-private/ops-row";
const target = { repository: REPO };
const MONO = "[]\n";
const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const blobSha = (text: string): string => sha1(`blob ${Buffer.byteLength(text)}\0${text}`);
const PRIVATE = "PRIVATE_TITLE_SENTINEL";
const OLD_FIELDS = ["duration_ms", "http_status_class", "kind", "outcome", "refusal_stage"];
const NEW_FIELDS = ["bound", "bytes", "shards"];

function shard(id: string): string {
  return `- id: ${id}\n  title: "${PRIVATE} ${id}"\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [src/a.ts]\n  rationale: r\n`;
}
function shards(n: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`OPS-T${i}.yaml`, shard(`OPS-T${i}`)]));
}

/** A GET-only fake of the git data API over one catalog. */
function remote(files: Record<string, string>): { api: OpsCatalogApi; fail(on: boolean): void } {
  const blobs = new Map<string, string>();
  let failing = false;
  const put = (t: string): string => { const s = blobSha(t); blobs.set(s, t); return s; };
  const [commit, root, plan, dir] = ["commit", "root", "plan", "dir"].map((n) => sha1(`row-${n}`)) as [string, string, string, string];
  const entry = (path: string, type: string, mode: string, sha: string) => ({ path, type, mode, sha });
  const api: OpsCatalogApi = async (path) => {
    if (failing) throw new Error(`transport down ${REPO} ${PRIVATE}`);
    if (path === `repos/${REPO}`) return { id: 7, full_name: REPO, default_branch: "main" };
    if (path === `repos/${REPO}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `repos/${REPO}/git/commits/${commit}`) return { sha: commit, tree: { sha: root } };
    if (path === `repos/${REPO}/git/trees/${root}`) return { sha: root, truncated: false, tree: [entry("plan", "tree", "040000", plan)] };
    if (path === `repos/${REPO}/git/trees/${plan}`) {
      return { sha: plan, truncated: false, tree: [entry("tasks.yaml", "blob", "100644", put(MONO)), entry("tasks.d", "tree", "040000", dir)] };
    }
    if (path === `repos/${REPO}/git/trees/${dir}`) {
      return { sha: dir, truncated: false, tree: Object.entries(files).map(([n, t]) => entry(n, "blob", "100644", put(t))) };
    }
    const m = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
    if (m && blobs.has(m[1]!)) {
      const t = blobs.get(m[1]!)!;
      return { sha: m[1], encoding: "base64", size: Buffer.byteLength(t), content: Buffer.from(t).toString("base64") };
    }
    throw new Error(`unexpected GET ${path}`);
  };
  return { api, fail: (on) => { failing = on; } };
}

/** One feed over `source`, its rows, and a refresh that waits for its own row. */
function feedOver(source: { refresh(): Promise<OpsCatalogShadowInput> }) {
  const rows: Row[] = [];
  const feed = opsCatalogShadowFeed(source, undefined, { log: (step, data) => rows.push({ step, data }) });
  const refresh = async (): Promise<Row> => {
    const before = rows.length;
    feed.current();
    for (let i = 0; i < 400 && rows.length === before; i++) await delay(5);
    assert.equal(rows.length, before + 1, "one completed refresh writes exactly one row");
    return rows[rows.length - 1]!;
  };
  return { rows, refresh, feed };
}

const ok = (data: Record<string, unknown>) => ({ ...data, duration_ms: 0 });
const BUDGET: OpsCatalogBoundsIo = { blobReadAllowance: () => 100 };

test("W1-T14374 criterion 1: an ok refresh row carries shards and bytes, and a bound refusal carries bound with reason, observed and allowed", async (t) => {
  const small = shards(3);
  const counts = (await readOpsCatalogSnapshotAsync(target, remote(small).api)).counts;
  assert.equal(counts.shards, 3);
  assert.ok(counts.bytes > 0);

  const fx = remote(small);
  const { refresh, feed } = feedOver(createOpsCatalogShadowSource(target, fx.api));
  t.after(() => feed.stop());
  const full = await refresh();
  assert.equal(full.step, OPS_CATALOG_REFRESHED_STEP);
  assert.deepEqual([full.data.shards, full.data.bytes, full.data.bound], [3, counts.bytes, null]);
  // A revalidation carries the counts of the snapshot it revalidated.
  const again = await refresh();
  assert.deepEqual([again.data.kind, again.data.shards, again.data.bytes], ["revalidate", 3, counts.bytes]);

  // A refusal by a derived bound: 600 shards need 601 blob GETs and the budget allows 100.
  const many = shards(OPS_CATALOG_BASELINE_SHARDS + 100);
  const direct = await readOpsCatalogSnapshotAsync(target, remote(many).api, { bounds: BUDGET });
  assert.deepEqual(direct.bound, { reason: "blob_read_budget", observed: 601, allowed: 100 });
  const refused = feedOver(createOpsCatalogShadowSource(target, remote(many).api, { bounds: BUDGET }));
  t.after(() => refused.feed.stop());
  const row = await refused.refresh();
  assert.equal(row.data.outcome, "unreadable");
  assert.deepEqual(row.data.bound, { reason: "blob_read_budget", observed: 601, allowed: 100 });
  assert.deepEqual([row.data.shards, row.data.bytes], [direct.counts.shards, direct.counts.bytes]);
  assert.equal(row.data.shards, OPS_CATALOG_BASELINE_SHARDS + 100);

  // A refusal that no bound made carries counts it never learned as null, and no bound.
  fx.fail(true);
  const down = await refresh();
  assert.equal(down.data.bound, null);
});

test("W1-T14374 criterion 2: no field names or quotes private content, counts and the bound's numbers only", async (t) => {
  const fx = remote(shards(3));
  const { rows, refresh, feed } = feedOver(createOpsCatalogShadowSource(target, fx.api));
  t.after(() => feed.stop());
  await refresh();
  fx.fail(true);
  // W1-T14564: the kept snapshot answers this failed refresh, so its row adds the refusal and the snapshot's age.
  const served = await refresh();
  assert.deepEqual([served.data.refusal, typeof served.data.snapshot_age_ms], ["stale", "number"]);
  const refused = feedOver(createOpsCatalogShadowSource(target, remote(shards(OPS_CATALOG_BASELINE_SHARDS + 100)).api, { bounds: BUDGET }));
  t.after(() => refused.feed.stop());
  await refused.refresh();
  // A source whose bound carries a content field still writes only the bound's own three numbers and its closed reason.
  const stub: OpsCatalogShadowInput = { outcome: "unreadable", refusalStage: "shard_tree" };
  Object.defineProperties(stub, {
    bound: { value: { reason: "heap_bytes", observed: 9, allowed: 8, detail: PRIVATE } },
    counts: { value: { shards: 4, bytes: 5, sample: PRIVATE } },
  });
  const forged = feedOver({ refresh: () => Promise.resolve(stub) });
  t.after(() => forged.feed.stop());
  const forgedRow = await forged.refresh();
  assert.deepEqual(forgedRow.data.bound, { reason: "heap_bytes", observed: 9, allowed: 8 });
  assert.deepEqual([forgedRow.data.shards, forgedRow.data.bytes], [4, 5]);

  const all = [...rows, ...refused.rows, ...forged.rows];
  const text = JSON.stringify(all);
  for (const sentinel of [PRIVATE, REPO, "OPS-T0"]) assert.equal(text.includes(sentinel), false, `no row carries ${sentinel}`);
  for (const row of all) {
    const servedFields = row === served ? ["refusal", "snapshot_age_ms"] : [];
    assert.deepEqual(Object.keys(row.data).sort(), [...OLD_FIELDS, ...NEW_FIELDS, ...servedFields].sort());
    for (const key of ["shards", "bytes"]) assert.ok(row.data[key] === null || Number.isInteger(row.data[key]), `${key} is a count or null`);
    const bound = row.data.bound as Record<string, unknown> | null;
    if (bound !== null) {
      assert.deepEqual(Object.keys(bound).sort(), ["allowed", "observed", "reason"]);
      assert.ok(Number.isFinite(bound.observed) && Number.isFinite(bound.allowed));
    }
  }
});

test("W1-T14374 criterion 3: invariant:a-refresh-rows-existing-fields-are-unchanged — every field the row carries on origin/main keeps its name and value", async (t) => {
  const fx = remote(shards(3));
  const { refresh, feed } = feedOver(createOpsCatalogShadowSource(target, fx.api));
  t.after(() => feed.stop());
  const old = (row: Row) => ok(Object.fromEntries(OLD_FIELDS.map((k) => [k, row.data[k]])));
  assert.deepEqual(old(await refresh()), { outcome: "ok", refusal_stage: null, duration_ms: 0, kind: "full", http_status_class: null });
  assert.deepEqual(old(await refresh()), { outcome: "ok", refusal_stage: null, duration_ms: 0, kind: "revalidate", http_status_class: null });
  fx.fail(true);
  const down = await refresh();
  assert.deepEqual(old(down), { outcome: "stale", refusal_stage: "branch_ref", duration_ms: 0, kind: "revalidate", http_status_class: null });
  const refused = feedOver(createOpsCatalogShadowSource(target, remote(shards(OPS_CATALOG_BASELINE_SHARDS + 100)).api, { bounds: BUDGET }));
  t.after(() => refused.feed.stop());
  assert.deepEqual(old(await refused.refresh()),
    { outcome: "unreadable", refusal_stage: "shard_tree", duration_ms: 0, kind: "full", http_status_class: null });
  const rejecting = feedOver({ refresh: () => Promise.reject(new Error(PRIVATE)) });
  t.after(() => rejecting.feed.stop());
  const rejected = await rejecting.refresh();
  assert.deepEqual(old(rejected), { outcome: "unreadable", refusal_stage: "source_refresh", duration_ms: 0, kind: null, http_status_class: null });
  assert.deepEqual([rejected.data.shards, rejected.data.bytes, rejected.data.bound], [null, null, null]);
});
