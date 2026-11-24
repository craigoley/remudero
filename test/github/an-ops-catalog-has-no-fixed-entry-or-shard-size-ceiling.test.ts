// W1-T14638 invariant only-real-limits-refuse: the ops catalog reader, the run-child offer, the last-good record and the
// catalog mover refuse no catalog for its count of tree entries or the byte size of one shard. Only GitHub's own truncated
// flag, the blob SHA and UTF-8 checks, and the derived heap and blob-read-budget bounds refuse a read; the mover keeps
// its 48 MiB git-buffer bound. Each test below names the acceptance criterion it proves ("W1-T14638 criterion N").
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { HEAP_LIMIT_EXIT_FRACTION } from "#src/lib/daemon-memory-policy.js";
import * as source from "#src/lib/ops-catalog-source.js";
import * as migration from "#src/lib/plan-task-migration.js";
import {
  OPS_SNAPSHOT_HEAP_BYTES_PER_CATALOG_BYTE, acceptOfferedOpsCatalogBlobs, keptOpsCatalogBlobsForChild, opsCatalogHeapByteBound,
  readLastGoodOpsCatalogSnapshot, readOpsCatalogSnapshotAsync, type OpsCatalogApi,
} from "#src/lib/ops-catalog-source.js";
import { PreviewUnknown, catalog, judgeOpsBatch, judgeOpsCopy } from "#src/lib/plan-task-migration.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const REPO = "acme-private/ops-no-ceiling";
const target = { repository: REPO };
/** The fixed ceilings this task removed: 256 KiB per blob and 10,000 tree entries. Fixtures sit past both. */
const OLD_BLOB_CEILING = 256 * 1024;
const OLD_ENTRY_CEILING = 10_000;
const PAST_BLOB_CEILING = 1024 * 1024;
const PAST_ENTRY_CEILING = 20_000;
const sha1 = (b: Buffer | string): string => createHash("sha1").update(b).digest("hex");
const blobSha = (text: string): string => sha1(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(text)}\0`), Buffer.from(text)]));
const taskYaml = (id: string): string =>
  `- id: ${id}\n  title: "t ${id}"\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [src/a.ts]\n  rationale: r\n`;
const roomy = { heap: () => ({ used_heap_size: 0, heap_size_limit: 2 ** 40 }), blobReadAllowance: () => 1_000_000 };
/** A heap reading whose derived byte bound is about `bytes`: the reading the reader's heap bound is judged on. */
const heapFor = (bytes: number) => {
  const reading = { used_heap_size: 0, heap_size_limit: Math.ceil(bytes * OPS_SNAPSHOT_HEAP_BYTES_PER_CATALOG_BYTE / HEAP_LIMIT_EXIT_FRACTION) };
  return () => reading;
};

type TreeName = "root" | "plan" | "dir";
interface Hooks {
  rootExtra?: number;
  /** Non-YAML entries in the shard dir: counted as tree entries, never read as shards. */
  dirExtra?: number;
  truncated?: { tree: TreeName; value: unknown };
  blobBody?: (sha: string) => Record<string, unknown> | undefined;
}

/** A GET-only fake of the git data API: a monolith plus shards, optionally padded with unrelated tree entries. */
function remote(monolith: string, shards: Record<string, string>, hooks: Hooks = {}): OpsCatalogApi {
  const blobs = new Map<string, string>();
  const put = (t: string): string => { const s = blobSha(t); blobs.set(s, t); return s; };
  const ids = { commit: sha1("commit"), root: sha1("root"), plan: sha1("plan"), dir: sha1("dir") };
  const entry = (path: string, type: string, mode: string, s: string) => ({ path, type, mode, sha: s });
  const monoSha = put(monolith);
  const shardEntries = Object.entries(shards).map(([n, t]) => entry(n, "blob", "100644", put(t)));
  const rootFiller = Array.from({ length: hooks.rootExtra ?? 0 }, (_, i) => entry(`f${i}`, "blob", "100644", sha1(String(i))));
  const dirFiller = Array.from({ length: hooks.dirExtra ?? 0 }, (_, i) => entry(`note-${i}.txt`, "blob", "100644", sha1(`n${i}`)));
  const flag = (tree: TreeName): Record<string, unknown> =>
    hooks.truncated?.tree === tree ? (hooks.truncated.value === undefined ? {} : { truncated: hooks.truncated.value }) : { truncated: false };
  return async (path) => {
    if (path === `repos/${REPO}`) return { id: 7, full_name: REPO, default_branch: "main" };
    if (path === `repos/${REPO}/git/ref/heads/main`) return { object: { type: "commit", sha: ids.commit } };
    if (path === `repos/${REPO}/git/commits/${ids.commit}`) return { sha: ids.commit, tree: { sha: ids.root } };
    if (path === `repos/${REPO}/git/trees/${ids.root}`) {
      return { sha: ids.root, ...flag("root"), tree: [entry("plan", "tree", "040000", ids.plan), ...rootFiller] };
    }
    if (path === `repos/${REPO}/git/trees/${ids.plan}`) {
      return { sha: ids.plan, ...flag("plan"), tree: [entry("tasks.yaml", "blob", "100644", monoSha), entry("tasks.d", "tree", "040000", ids.dir)] };
    }
    if (path === `repos/${REPO}/git/trees/${ids.dir}`) return { sha: ids.dir, ...flag("dir"), tree: [...shardEntries, ...dirFiller] };
    const m = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
    if (m && blobs.has(m[1]!)) {
      const t = blobs.get(m[1]!)!;
      const honest = { sha: m[1], encoding: "base64", size: Buffer.byteLength(t), content: Buffer.from(t).toString("base64") };
      return hooks.blobBody?.(m[1]!) ?? honest;
    }
    throw new Error(`unexpected GET ${path}`);
  };
}

/** 10,001 distinct valid shards, one task each: a shard dir past the old 10,000-entry ceiling on its own. */
const MANY = OLD_ENTRY_CEILING + 1;
let many: Record<string, string> | undefined;
const manyShards = (): Record<string, string> =>
  (many ??= Object.fromEntries(Array.from({ length: MANY }, (_, i) => [`s${String(i).padStart(5, "0")}.yaml`, taskYaml(`S${i}`)])));

/** A real git repository holding `files` in one commit: the input the mover's own catalog() reads. */
function gitCatalog(t: TestContext, files: Record<string, string>): { dir: string; commit: string } {
  const repo = gitRepo({ scope: t, seedCommit: false, kind: "ops-no-ceiling-git" });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
    writeFileSync(join(repo.dir, rel), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "chore: seed");
  return { dir: repo.dir, commit: repo.git("rev-parse", "HEAD") };
}

const moverReason = (fn: () => void): string | undefined => {
  try { fn(); return undefined; } catch (error) { assert.ok(error instanceof PreviewUnknown); return error.reason; }
};

test("W1-T14638 criterion 1: trees of 10,001 or more entries in total read ok with every shard in the plan", async () => {
  // Neither tree alone passes 10,000 entries; together the root, plan and shard trees do.
  const spread = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), { "b.yaml": taskYaml("B") }, { rootExtra: 5_000, dirExtra: 5_000 }), { bounds: roomy });
  assert.equal(spread.outcome, "ok", `${spread.outcome} at ${spread.refusalStage}`);
  assert.ok(spread.counts.treeEntries > OLD_ENTRY_CEILING, `${spread.counts.treeEntries} entries were counted, none refused`);
  assert.deepEqual(Object.keys(spread.binding!.shardBlobs), ["b.yaml"], "non-YAML entries are counted, never read as shards");
  assert.deepEqual(spread.plan?.tasks.map((task) => task.id).sort(), ["A", "B"]);

  // The root tree alone, far past it.
  const wideRoot = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), { "b.yaml": taskYaml("B") }, { rootExtra: PAST_ENTRY_CEILING }), { bounds: roomy });
  assert.equal(wideRoot.outcome, "ok", `${wideRoot.outcome} at ${wideRoot.refusalStage}`);
  assert.ok(wideRoot.counts.treeEntries > PAST_ENTRY_CEILING);
  assert.equal(wideRoot.plan?.tasks.length, 2);
});

test("W1-T14638 criterion 1: a shard dir alone of more than 10,000 distinct shards reads ok with every shard in the plan", async () => {
  const shards = manyShards();
  const snap = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), shards), { bounds: roomy });
  assert.equal(snap.outcome, "ok", `${snap.outcome} at ${snap.refusalStage}`);
  assert.equal(snap.counts.shards, MANY);
  assert.ok(snap.counts.treeEntries > OLD_ENTRY_CEILING);
  assert.equal(Object.keys(snap.binding!.shardBlobs).length, MANY, "every shard is bound");
  assert.equal(snap.plan?.tasks.length, MANY + 1, "every shard's task is in the plan, with the monolith's");
  assert.ok(snap.plan?.byId.has("S0") && snap.plan.byId.has(`S${MANY - 1}`), "the first and the last shard were both parsed");
  // The derived blob-read budget still judges the same catalog: one GET fewer than it needs is refused before any.
  const short = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), shards), { bounds: { ...roomy, blobReadAllowance: () => MANY } });
  assert.equal(short.outcome, "unreadable");
  assert.deepEqual(short.bound, { reason: "blob_read_budget", observed: MANY + 1, allowed: MANY });
});

test("W1-T14638 criterion 2: one shard past 256 KiB reads ok with that shard parsed, fetched or from the blob cache", async (t) => {
  const big = `# ${"x".repeat(PAST_BLOB_CEILING)}\n${taskYaml("B")}`;
  assert.ok(Buffer.byteLength(big) > OLD_BLOB_CEILING);
  const stateDir = ownedFixtureDir(t, "ops-no-ceiling-state").dir;
  const fetched = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), { "b.yaml": big }), { stateDir, bounds: roomy });
  assert.equal(fetched.outcome, "ok", `${fetched.outcome} at ${fetched.refusalStage}`);
  assert.ok(fetched.counts.bytes > PAST_BLOB_CEILING);
  assert.equal(fetched.binding?.shardBlobs["b.yaml"], blobSha(big));
  assert.equal(fetched.plan?.byId.get("B")?.title, "t B", "the large shard's own task was parsed");

  // A fresh process reading the same commit with no blob GET answers from the state-dir cache file, size unjudged.
  const offline = remote(taskYaml("A"), { "b.yaml": big }, { blobBody: () => { throw new Error("no blob GET in this read"); } });
  const filed = await readOpsCatalogSnapshotAsync(target, offline, { stateDir, bounds: roomy });
  assert.equal(filed.outcome, "ok", `${filed.outcome} at ${filed.refusalStage}`);
  assert.equal(filed.plan?.byId.get("B")?.title, "t B");
  const lastGood = await readLastGoodOpsCatalogSnapshot(target, offline, { stateDir, bounds: roomy });
  assert.equal(lastGood.outcome, "ok", JSON.stringify(lastGood));
  if (lastGood.outcome === "ok") {
    assert.ok(lastGood.counts.bytes > PAST_BLOB_CEILING);
    assert.equal(lastGood.plan?.byId.get("B")?.title, "t B");
  }

  // Only the heap reading judges the shard's size: a reading that holds it admits it, one that cannot refuses it.
  assert.ok(opsCatalogHeapByteBound(heapFor(4 * PAST_BLOB_CEILING)()) > Buffer.byteLength(big));
  assert.ok(opsCatalogHeapByteBound(heapFor(PAST_BLOB_CEILING / 2)()) < Buffer.byteLength(big));
  const held = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), { "b.yaml": big }), { bounds: { ...roomy, heap: heapFor(4 * PAST_BLOB_CEILING) } });
  assert.equal(held.outcome, "ok", `${held.outcome} at ${held.refusalStage}`);
  const tight = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), { "b.yaml": big }), { bounds: { ...roomy, heap: heapFor(PAST_BLOB_CEILING / 2) } });
  assert.equal(tight.outcome, "malformed");
  assert.equal(tight.bound?.reason, "heap_bytes");
  assert.equal(tight.plan, undefined);
});

test("W1-T14638 criterion 3: an offer and a last-good record naming more than 10,000 blobs are accepted and served", async (t) => {
  const shards = manyShards();
  const stateDir = ownedFixtureDir(t, "ops-no-ceiling-state").dir;
  const parent = remote(taskYaml("A"), shards);
  const read = await readOpsCatalogSnapshotAsync(target, parent, { stateDir, bounds: roomy });
  assert.equal(read.outcome, "ok", `${read.outcome} at ${read.refusalStage}`);

  // The parent's offer names every blob, header included; the child keeps all of them and GETs none.
  const payload = keptOpsCatalogBlobsForChild(`S${MANY - 1}`, parent);
  assert.ok(payload, "an offer of more than 10,000 blobs is made");
  let blobGets = 0;
  const base = remote(taskYaml("A"), shards);
  const child: OpsCatalogApi = async (path) => {
    if (path.includes("/git/blobs/")) blobGets++;
    return base(path);
  };
  assert.deepEqual(acceptOfferedOpsCatalogBlobs(payload, child), { offered: MANY + 1, kept: MANY + 1, refused: 0 });
  const served = await readOpsCatalogSnapshotAsync(target, child, { bounds: roomy });
  assert.equal(served.outcome, "ok", `${served.outcome} at ${served.refusalStage}`);
  assert.equal(served.plan?.tasks.length, MANY + 1);
  assert.equal(blobGets, 0, "every blob came from the offer");
  // Positive control: one flipped byte in the last offered blob is refused by its SHA-1 check, the rest are kept.
  const tampered = Buffer.from(payload);
  const flipped = tampered.length - 2;
  tampered[flipped] = tampered[flipped]! ^ 0x01;
  assert.deepEqual(acceptOfferedOpsCatalogBlobs(tampered, remote(taskYaml("A"), shards)), { offered: MANY + 1, kept: MANY, refused: 1 });

  // The record the ok read kept names every shard and is served whole.
  const lastGood = await readLastGoodOpsCatalogSnapshot(target, child, { stateDir, bounds: roomy });
  assert.equal(lastGood.outcome, "ok", JSON.stringify(lastGood));
  if (lastGood.outcome === "ok") {
    assert.equal(lastGood.counts.shards, MANY);
    assert.equal(Object.keys(lastGood.binding!.shardBlobs).length, MANY);
    assert.equal(lastGood.plan?.tasks.length, MANY + 1);
  }
  // Positive control: the same record under a heap reading with no room left is judged by that reading alone.
  const noHeap = await readLastGoodOpsCatalogSnapshot(target, child, { stateDir, bounds: { heap: () => ({ used_heap_size: 1, heap_size_limit: 1 }) } });
  assert.deepEqual(noHeap, { outcome: "none", reason: "record_malformed" });
});

test("W1-T14638 criterion 3: the mover reads and copies past 10,000 entries and 256 KiB, judged by the derived bounds only", async (t) => {
  // The mover's own git reader over a catalog whose shard dir alone holds more than 10,000 shards.
  const files: Record<string, string> = { "plan/tasks.yaml": "[]\n", "plan/tasks.d/W1-T9.yaml": taskYaml("W1-T9") };
  for (let i = 0; i < MANY; i++) files[`plan/tasks.d/empty-${String(i).padStart(5, "0")}.yaml`] = "[]\n";
  const repo = gitCatalog(t, files);
  const read = await catalog(repo.dir, repo.commit, true);
  assert.equal(read.size?.shards, MANY + 1);
  assert.ok((read.size?.treeEntries ?? 0) > OLD_ENTRY_CEILING, `${read.size?.treeEntries} tree entries`);
  assert.ok(read.originals.has("W1-T9"));

  const publicCommit = "c".repeat(40);
  const record = `# ${"x".repeat(PAST_BLOB_CEILING)}\n${taskYaml("W1-T9")}`;
  assert.ok(Buffer.byteLength(record) > OLD_BLOB_CEILING);
  const size = read.size!;
  assert.equal(moverReason(() => judgeOpsCopy(size, record, publicCommit, roomy)), undefined, "a copied record past 256 KiB is admitted");
  assert.equal(moverReason(() => judgeOpsCopy({ ...size, treeEntries: PAST_ENTRY_CEILING }, taskYaml("W1-T9"), publicCommit, roomy)), undefined);
  assert.equal(moverReason(() => judgeOpsCopy({ ...size, shardDir: false }, taskYaml("W1-T9"), publicCommit, roomy)), undefined);
  const batch = Array.from({ length: MANY }, (_, i) => taskYaml(`W1-T${100_000 + i}`));
  assert.equal(moverReason(() => judgeOpsBatch(size, batch, publicCommit, roomy)), undefined, "a batch of more than 10,000 copies is admitted");

  // The derived heap bound is the only judge: the produced catalog at the bound is admitted, one byte past it refused.
  const heap = heapFor(64 * PAST_BLOB_CEILING);
  const allowed = opsCatalogHeapByteBound(heap());
  const copyBytes = Buffer.byteLength(record) + Buffer.byteLength(`  moved_from: remudero@${publicCommit}\n`);
  const atBound = { ...size, bytes: allowed - copyBytes };
  assert.equal(moverReason(() => judgeOpsCopy(atBound, record, publicCommit, { heap })), undefined);
  assert.equal(moverReason(() => judgeOpsCopy({ ...atBound, bytes: atBound.bytes + 1 }, record, publicCommit, { heap })), "catalog_incompatible");
});

test("W1-T14638 criterion 4: no exported constant names a fixed tree-entry or per-shard byte ceiling", () => {
  for (const [label, ns] of [["ops-catalog-source", source], ["plan-task-migration", migration]] as const) {
    const names = Object.keys(ns).filter((name) => /MAX_(TREE|ENTR|BLOB|SHARD)/.test(name));
    assert.deepEqual(names, [], `${label} exports no fixed entry or shard size ceiling`);
  }
  assert.ok(Object.keys(source).includes("OPS_CATALOG_MAX_OFFER_BYTES"), "positive control: the namespace lists real exports");
});

test("W1-T14638 criterion 4: a tree GitHub answers with truncated not false refuses, at every tree of the read", async () => {
  const shards = { "b.yaml": taskYaml("B") };
  const control = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), shards), { bounds: roomy });
  assert.equal(control.outcome, "ok", "positive control: the same catalog with truncated false reads ok");
  for (const tree of ["root", "plan", "dir"] as const) {
    for (const value of [true, undefined, "false", 0, null]) {
      const snap = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), shards, { truncated: { tree, value } }), { bounds: roomy });
      assert.equal(snap.outcome, "malformed", `${tree} tree with truncated ${JSON.stringify(value)}`);
      assert.equal(snap.plan, undefined);
    }
  }
});

test("W1-T14638 criterion 4: a blob whose SHA-1 or UTF-8 fails still refuses the read", async () => {
  const mono = taskYaml("A");
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

test("W1-T14638 criterion 4: the heap and blob-read-budget bounds still refuse a read of any size", async () => {
  const noHeap = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), { "b.yaml": taskYaml("B") }), { bounds: { ...roomy, heap: () => ({ used_heap_size: 1, heap_size_limit: 1 }) } });
  assert.equal(noHeap.outcome, "malformed");
  assert.equal(noHeap.bound?.reason, "heap_bytes");
  const noBudget = await readOpsCatalogSnapshotAsync(target, remote(taskYaml("A"), { "b.yaml": taskYaml("B") }), { bounds: { ...roomy, blobReadAllowance: () => 1 } });
  assert.equal(noBudget.outcome, "unreadable");
  assert.deepEqual(noBudget.bound, { reason: "blob_read_budget", observed: 2, allowed: 1 });
});

test("W1-T14638 criterion 4: the mover's 48 MiB git-buffer bound still refuses its catalog read", async (t) => {
  const small = gitCatalog(t, { "plan/tasks.yaml": `# ${"x".repeat(PAST_BLOB_CEILING)}\n[]\n`, "plan/tasks.d/W1-T9.yaml": taskYaml("W1-T9") });
  const read = await catalog(small.dir, small.commit, true);
  assert.ok(read.originals.has("W1-T9"), "positive control: a one-MiB monolith under the git-buffer bound is read");
  const huge = gitCatalog(t, { "plan/tasks.yaml": `# ${"x".repeat(49 * 1024 * 1024)}\n[]\n`, "plan/tasks.d/W1-T9.yaml": taskYaml("W1-T9") });
  await assert.rejects(catalog(huge.dir, huge.commit, true),
    (error: unknown) => error instanceof PreviewUnknown && error.reason === "catalog_unreadable");
});
