// W1-T14638 invariant only-real-limits-refuse: the ops catalog reader, the run-child offer, the last-good record and the
// catalog mover refuse no catalog for its count of tree entries or the byte size of one shard. Only GitHub's own truncated
// flag, the blob SHA and UTF-8 checks, and the derived heap and blob-read-budget bounds refuse a read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as source from "#src/lib/ops-catalog-source.js";
import * as migration from "#src/lib/plan-task-migration.js";
import { readOpsCatalogSnapshotAsync, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { PreviewUnknown, judgeOpsCopy } from "#src/lib/plan-task-migration.js";

const REPO = "acme-private/ops-no-ceiling";
const target = { repository: REPO };
/** The fixed ceilings this task removed: 256 KiB per blob and a few thousand tree entries. Fixtures sit far past both. */
const PAST_BLOB_CEILING = 1024 * 1024;
const PAST_ENTRY_CEILING = 20_000;
const sha1 = (b: Buffer | string): string => createHash("sha1").update(b).digest("hex");
const blobSha = (text: string): string => sha1(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(text)}\0`), Buffer.from(text)]));
const taskYaml = (id: string): string =>
  `- id: ${id}\n  title: "t ${id}"\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [src/a.ts]\n  rationale: r\n`;
const roomy = { heap: () => ({ used_heap_size: 0, heap_size_limit: 2 ** 40 }), blobReadAllowance: () => 1_000_000 };

interface Hooks { rootExtra?: number; truncated?: boolean; blobBody?: (sha: string) => Record<string, unknown> | undefined }

/** A GET-only fake of the git data API: a monolith plus shards, optionally padded with unrelated root-tree entries. */
function remote(monolith: string, shards: Record<string, string>, hooks: Hooks = {}): OpsCatalogApi {
  const blobs = new Map<string, string>();
  const put = (t: string): string => { const s = blobSha(t); blobs.set(s, t); return s; };
  const ids = { commit: sha1("commit"), root: sha1("root"), plan: sha1("plan"), dir: sha1("dir") };
  const entry = (path: string, type: string, mode: string, s: string) => ({ path, type, mode, sha: s });
  const monoSha = put(monolith);
  const shardEntries = Object.entries(shards).map(([n, t]) => entry(n, "blob", "100644", put(t)));
  const filler = Array.from({ length: hooks.rootExtra ?? 0 }, (_, i) => entry(`f${i}`, "blob", "100644", sha1(String(i))));
  return async (path) => {
    if (path === `repos/${REPO}`) return { id: 7, full_name: REPO, default_branch: "main" };
    if (path === `repos/${REPO}/git/ref/heads/main`) return { object: { type: "commit", sha: ids.commit } };
    if (path === `repos/${REPO}/git/commits/${ids.commit}`) return { sha: ids.commit, tree: { sha: ids.root } };
    if (path === `repos/${REPO}/git/trees/${ids.root}`) {
      return { sha: ids.root, truncated: hooks.truncated ?? false, tree: [entry("plan", "tree", "040000", ids.plan), ...filler] };
    }
    if (path === `repos/${REPO}/git/trees/${ids.plan}`) {
      return { sha: ids.plan, truncated: false, tree: [entry("tasks.yaml", "blob", "100644", monoSha), entry("tasks.d", "tree", "040000", ids.dir)] };
    }
    if (path === `repos/${REPO}/git/trees/${ids.dir}`) return { sha: ids.dir, truncated: false, tree: shardEntries };
    const m = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
    if (m && blobs.has(m[1]!)) {
      const t = blobs.get(m[1]!)!;
      const honest = { sha: m[1], encoding: "base64", size: Buffer.byteLength(t), content: Buffer.from(t).toString("base64") };
      return hooks.blobBody?.(m[1]!) ?? honest;
    }
    throw new Error(`unexpected GET ${path}`);
  };
}

test("no exported constant names a fixed tree-entry or per-shard byte ceiling", () => {
  for (const [label, ns] of [["ops-catalog-source", source], ["plan-task-migration", migration]] as const) {
    const names = Object.keys(ns).filter((name) => /MAX_(TREE_ENTRIES|BLOB_BYTES|SHARDS|ENTRIES)/.test(name));
    assert.deepEqual(names, [], `${label} exports no fixed entry or shard size ceiling`);
  }
  assert.ok(Object.keys(source).includes("OPS_CATALOG_MAX_OFFER_BYTES"), "positive control: the namespace lists real exports");
});

test("a root tree of tens of thousands of entries still reads ok", async () => {
  const snap = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), { "b.yaml": taskYaml("B") }, { rootExtra: PAST_ENTRY_CEILING }), { bounds: roomy });
  assert.equal(snap.outcome, "ok", `${snap.outcome} at ${snap.refusalStage}`);
  assert.ok(snap.counts.treeEntries > PAST_ENTRY_CEILING, "every entry was counted, none refused");
  assert.equal(snap.plan?.tasks.length, 2);
});

test("one shard of a megabyte, past any fixed per-blob size, still reads ok", async () => {
  const big = `# ${"x".repeat(PAST_BLOB_CEILING)}\n${taskYaml("B")}`;
  const snap = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), { "b.yaml": big }), { bounds: roomy });
  assert.equal(snap.outcome, "ok", `${snap.outcome} at ${snap.refusalStage}`);
  assert.ok(snap.counts.bytes > PAST_BLOB_CEILING);
  assert.equal(snap.plan?.tasks.length, 2);
});

test("GitHub's truncated flag, a wrong blob SHA and non-UTF-8 bytes still refuse", async () => {
  const mono = taskYaml("A");
  const truncated = await readOpsCatalogSnapshotAsync(target, remote(mono, {}, { truncated: true }), { bounds: roomy });
  assert.equal(truncated.outcome, "malformed");
  assert.equal(truncated.plan, undefined);

  const lying = await readOpsCatalogSnapshotAsync(target, remote(mono, {}, { blobBody: () => {
    const other = `${mono}# tampered\n`;
    return { sha: blobSha(mono), encoding: "base64", size: Buffer.byteLength(other), content: Buffer.from(other).toString("base64") };
  } }), { bounds: roomy });
  assert.equal(lying.outcome, "malformed");
  assert.equal(lying.plan, undefined);

  const bad = Buffer.from([0xff, 0xfe, 0xfd]);
  const api = remote(mono, {});
  const badSha = sha1(Buffer.concat([Buffer.from("blob 3\0"), bad]));
  const swapped: OpsCatalogApi = async (path) => {
    if (path.endsWith(`/git/trees/${sha1("plan")}`)) return { sha: sha1("plan"), truncated: false, tree: [{ path: "tasks.yaml", type: "blob", mode: "100644", sha: badSha }] };
    if (path.endsWith(`/git/blobs/${badSha}`)) return { sha: badSha, encoding: "base64", size: 3, content: bad.toString("base64") };
    return api(path);
  };
  const notUtf8 = await readOpsCatalogSnapshotAsync(target, swapped, { bounds: roomy });
  assert.equal(notUtf8.outcome, "malformed");
  assert.equal(notUtf8.plan, undefined);
});

test("the heap and blob-read-budget bounds still refuse a read of any size", async () => {
  const api = remote(taskYaml("A"), { "b.yaml": taskYaml("B") });
  const noHeap = await readOpsCatalogSnapshotAsync(target, api, { bounds: { ...roomy, heap: () => ({ used_heap_size: 1, heap_size_limit: 1 }) } });
  assert.equal(noHeap.outcome, "malformed");
  assert.equal(noHeap.bound?.reason, "heap_bytes");
  const noBudget = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), { "b.yaml": taskYaml("B") }), { bounds: { ...roomy, blobReadAllowance: () => 1 } });
  assert.equal(noBudget.outcome, "unreadable");
  assert.deepEqual(noBudget.bound, { reason: "blob_read_budget", observed: 2, allowed: 1 });
});

test("the mover refuses a copy for neither tree entries nor one shard's bytes, and still for the heap", () => {
  const size = { shards: 3, bytes: 1_000, treeEntries: PAST_ENTRY_CEILING, shardDir: true };
  const publicCommit = "c".repeat(40);
  const reason = (fn: () => void): string | undefined => {
    try { fn(); return undefined; } catch (error) { assert.ok(error instanceof PreviewUnknown); return error.reason; }
  };
  assert.equal(reason(() => judgeOpsCopy(size, `# ${"x".repeat(PAST_BLOB_CEILING)}\n${taskYaml("W1-T9")}`, publicCommit)), undefined);
  assert.equal(reason(() => judgeOpsCopy({ ...size, shardDir: false }, taskYaml("W1-T9"), publicCommit)), undefined);
  assert.equal(reason(() => judgeOpsCopy(size, taskYaml("W1-T9"), publicCommit, { heap: () => ({ used_heap_size: 2 ** 40, heap_size_limit: 2 ** 40 }) })),
    "catalog_incompatible", "positive control: the derived heap bound still refuses");
});
