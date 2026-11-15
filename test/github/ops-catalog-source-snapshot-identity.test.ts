import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  OPS_CATALOG_MAX_BLOB_BYTES, readOpsCatalogSnapshotAsync, createOpsCatalogShadowSource, type OpsCatalogApi,
} from "#src/lib/ops-catalog-source.js";

const REPO = "acme-private/ops-secret-slug";
const sha1 = (b: Buffer | string): string => createHash("sha1").update(b).digest("hex");
const blobSha = (text: string): string => sha1(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(text)}\0`), Buffer.from(text)]));
const taskYaml = (id: string, title = "PRIVATE_TITLE_SENTINEL"): string =>
  `- id: ${id}\n  title: "${title}"\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [private/PRIVATE_PATH_SENTINEL]\n  rationale: PRIVATE_BODY_SENTINEL\n`;

interface Catalog {
  monolith?: string; shards?: Record<string, string>; noPlanDir?: boolean;
  repositoryId?: number; commit?: string; branch?: string; shardTreeSha?: string;
}
interface Fx { api: OpsCatalogApi; calls: string[]; commit: string; serve(text: string, asSha: string): void }

/** A recording GET-only fake of the git data API for one repository. */
function fixture(c: Catalog, hooks: { fail?: (path: string) => unknown; moveRefAfterBlobs?: boolean } = {}): Fx {
  const shards = c.shards ?? {};
  const blobs = new Map<string, string>();
  const put = (t: string): string => { const s = blobSha(t); blobs.set(s, t); return s; };
  const monolith = c.monolith === undefined ? undefined : put(c.monolith);
  const shardShas = Object.entries(shards).map(([n, t]) => [n, put(t)] as const);
  const shardTree = c.shardTreeSha ?? sha1("tasks.d");
  const planTree = sha1("plan");
  const rootTree = sha1("root");
  const commit = c.commit ?? sha1("commit-1");
  const branch = c.branch ?? "main";
  let blobReads = 0;
  let served: { text: string; asSha: string } | undefined;
  const calls: string[] = [];
  const entry = (path: string, type: string, mode: string, s: string) => ({ path, type, mode, sha: s });
  const api: OpsCatalogApi = async (path) => {
    calls.push(path);
    const injected = hooks.fail?.(path);
    if (injected !== undefined) { if (injected instanceof Error) throw injected; return injected; }
    if (path === `repos/${REPO}`) return { id: c.repositoryId ?? 42, full_name: REPO, default_branch: branch };
    if (path === `repos/${REPO}/git/ref/heads/${encodeURIComponent(branch)}`) return { object: { type: "commit", sha: hooks.moveRefAfterBlobs && blobReads > 0 ? sha1("commit-2") : commit } };
    if (path === `repos/${REPO}/git/commits/${commit}`) return { sha: commit, tree: { sha: rootTree } };
    if (path === `repos/${REPO}/git/trees/${rootTree}`) {
      return { sha: rootTree, truncated: false, tree: c.noPlanDir ? [] : [entry("plan", "tree", "040000", planTree)] };
    }
    if (path === `repos/${REPO}/git/trees/${planTree}`) {
      return { sha: planTree, truncated: false, tree: [
        ...(monolith ? [entry("tasks.yaml", "blob", "100644", monolith)] : []),
        ...(c.shards ? [entry("tasks.d", "tree", "040000", shardTree)] : []),
      ] };
    }
    if (path === `repos/${REPO}/git/trees/${shardTree}`) {
      return { sha: shardTree, truncated: false, tree: shardShas.map(([n, s]) => entry(n, "blob", "100644", s)) };
    }
    const m = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
    if (m) {
      blobReads++;
      const text = served && served.asSha === m[1] ? served.text : blobs.get(m[1]);
      if (text === undefined) throw new Error(`HTTP 404 ${path} PRIVATE_BODY_SENTINEL`);
      return { sha: m[1], encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
    }
    throw new Error(`unexpected GET ${path}`);
  };
  return { api, calls, commit, serve(text, asSha) { served = { text, asSha }; } };
}

test("W1-T11768 criterion 1: a readable catalog yields one frozen plan bound to its identity tuple", async () => {
  const fx = fixture({ monolith: taskYaml("OPS-T1"), shards: { "a.yaml": taskYaml("OPS-T2", "second"), "b.yaml": taskYaml("OPS-T3", "third") } });
  const snap = await readOpsCatalogSnapshotAsync({ repository: REPO }, fx.api);
  assert.equal(snap.outcome, "ok");
  assert.deepEqual(snap.plan?.tasks.map((t) => t.id), ["OPS-T1", "OPS-T2", "OPS-T3"]);
  assert.throws(() => (snap.plan!.tasks as unknown[]).push({}), "the plan is frozen");
  const b = snap.binding!;
  assert.equal(b.repositoryId, 42);
  assert.equal(b.ref, "refs/heads/main");
  assert.equal(b.commit, fx.commit);
  assert.equal(b.tasksYamlBlob, blobSha(taskYaml("OPS-T1")));
  assert.equal(b.shardTreeSha, sha1("tasks.d"));
  assert.deepEqual(b.shardBlobs, { "a.yaml": blobSha(taskYaml("OPS-T2", "second")), "b.yaml": blobSha(taskYaml("OPS-T3", "third")) });
  assert.equal(snap.identityDigest, createHash("sha256").update(JSON.stringify([
    42, "refs/heads/main", fx.commit, b.tasksYamlBlob, b.shardTreeSha, Object.entries(b.shardBlobs),
  ])).digest("hex"));
  const bytes = [taskYaml("OPS-T1"), taskYaml("OPS-T2", "second"), taskYaml("OPS-T3", "third")].reduce((n, t) => n + Buffer.byteLength(t), 0);
  assert.deepEqual(snap.counts, { treeEntries: 5, shards: 2, bytes });
  const refReads = fx.calls.map((c, i) => c.includes("/git/ref/heads/") ? i : -1).filter((i) => i >= 0);
  const blobReads = fx.calls.map((c, i) => c.includes("/git/blobs/") ? i : -1).filter((i) => i >= 0);
  assert.equal(refReads.length, 2, "the ref is read before and after the blobs");
  assert.ok(refReads[1] > Math.max(...blobReads), "the re-read follows every blob read");
});

test("W1-T11768 criterion 1: a catalog with no shard directory is one monolith plan", async () => {
  const fx = fixture({ monolith: taskYaml("OPS-T1") });
  const snap = await readOpsCatalogSnapshotAsync({ repository: REPO }, fx.api);
  assert.equal(snap.outcome, "ok");
  assert.equal(snap.binding?.shardTreeSha, "");
  assert.deepEqual(snap.binding?.shardBlobs, {});
});

test("W1-T11768 criterion 1: a ref that moves after the blob reads adopts nothing", async () => {
  const fx = fixture({ monolith: taskYaml("OPS-T1") }, { moveRefAfterBlobs: true });
  const snap = await readOpsCatalogSnapshotAsync({ repository: REPO }, fx.api);
  assert.equal(snap.outcome, "ref_moved");
  assert.equal(snap.plan, undefined);
  assert.equal(snap.binding, undefined);
});

test("W1-T11768 criterion 1: bytes altered under the original blob sha are refused", async () => {
  const fx = fixture({ monolith: taskYaml("OPS-T1") });
  fx.serve(taskYaml("OPS-T1", "altered title"), blobSha(taskYaml("OPS-T1")));
  const snap = await readOpsCatalogSnapshotAsync({ repository: REPO }, fx.api);
  assert.equal(snap.outcome, "malformed");
  assert.equal(snap.plan, undefined);
});

test("W1-T11768 criterion 1: a max-size blob with GitHub-wrapped base64 remains readable", async () => {
  const prefix = `${taskYaml("OPS-BOUNDARY")}# `;
  const text = `${prefix}${"x".repeat(OPS_CATALOG_MAX_BLOB_BYTES - Buffer.byteLength(prefix) - 1)}\n`;
  assert.equal(Buffer.byteLength(text), OPS_CATALOG_MAX_BLOB_BYTES);
  const fx = fixture({ monolith: text });
  const wrappedApi: OpsCatalogApi = async (path) => {
    const response = await fx.api(path);
    if (!path.includes("/git/blobs/")) return response;
    const blob = response as { content: string };
    return { ...blob, content: blob.content.match(/.{1,60}/g)!.join("\n") };
  };
  const snap = await readOpsCatalogSnapshotAsync({ repository: REPO }, wrappedApi);
  assert.equal(snap.outcome, "ok");
  assert.deepEqual(snap.plan?.tasks.map((t) => t.id), ["OPS-BOUNDARY"]);
  assert.equal(snap.counts.bytes, OPS_CATALOG_MAX_BLOB_BYTES);
});

test("W1-T11768 criterion 1: the same catalog binds the same digest and a different one differs", async () => {
  const a = await readOpsCatalogSnapshotAsync({ repository: REPO }, fixture({ monolith: taskYaml("OPS-T1") }).api);
  const b = await readOpsCatalogSnapshotAsync({ repository: REPO }, fixture({ monolith: taskYaml("OPS-T1") }).api);
  const c = await readOpsCatalogSnapshotAsync({ repository: REPO }, fixture({ monolith: taskYaml("OPS-T9") }).api);
  assert.equal(a.identityDigest, b.identityDigest);
  assert.equal(a.plan, b.plan, "the dedicated revision store reuses the verified Plan");
  assert.notEqual(a.identityDigest, c.identityDigest);
  assert.notEqual(a.plan, c.plan);
});

test("W1-T11768 criterion 1: every bound identity participates in the revision store key", async () => {
  const catalog = { monolith: taskYaml("OPS-T1"), shards: { "private-shard.yaml": taskYaml("OPS-T2") } };
  const read = (changes: Partial<Catalog> = {}) => readOpsCatalogSnapshotAsync(
    { repository: REPO }, fixture({ ...catalog, ...changes }).api,
  );
  const original = await read();
  const variations: Partial<Catalog>[] = [
    { repositoryId: 43 }, { branch: "private/default" }, { commit: sha1("commit-2") },
    { monolith: taskYaml("OPS-T3") }, { shardTreeSha: sha1("another tree") },
    { shards: { "renamed.yaml": taskYaml("OPS-T2") } },
    { shards: { "private-shard.yaml": taskYaml("OPS-T4") } },
  ];
  for (const changes of variations) {
    const changed = await read(changes);
    assert.equal(changed.outcome, "ok");
    assert.notEqual(changed.identityDigest, original.identityDigest);
    assert.notEqual(changed.plan, original.plan, "different identities never reuse the original Plan");
  }
  const again = await read();
  assert.equal(again.plan, original.plan, "a still-held revision survives intervening adoptions");
  assert.equal(Object.isFrozen(original.plan), true);
  assert.equal(Object.isFrozen(original.plan!.tasks[0]), true);
  assert.throws(() => original.plan!.byId.set("injected", original.plan!.tasks[0]));
});

test("W1-T11768 criterion 1: the shadow source reports ok with the commit and digest", async () => {
  const fx = fixture({ monolith: taskYaml("OPS-T1") });
  const source = createOpsCatalogShadowSource({ repository: REPO }, fx.api);
  const input = await source.refresh();
  assert.equal(input.outcome, "ok");
  assert.equal(input.opsCommit, fx.commit);
  assert.match(input.identityDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(input.plan?.tasks.length, 1);
  assert.equal((await source.refresh()).plan, input.plan, "the source owns a dedicated retained revision store");
});
