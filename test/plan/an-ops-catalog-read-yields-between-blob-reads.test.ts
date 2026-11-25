/**
 * W1-T14876: a cached ops blob answers with no I/O wait, so a catalog pass over every cached blob file ran as one
 * synchronous chain of microtasks. On 2026-11-25 that held serve's event loop for 10 to 13 s at a time, and GitHub timed
 * webhook deliveries out at 10 s. The pass now gives the event loop one turn per blob read.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readOpsCatalogSnapshotAsync, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const REPO = "fixture-private/ops-catalog-yields";
const REPOSITORY_ID = 14876;
const SHARDS = 200;
const sha1 = (text: string | Buffer): string => createHash("sha1").update(text).digest("hex");
const taskYaml = (id: string): string =>
  `- id: ${id}\n  title: "${id} title"\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  files: [src/a.ts]\n`;

/** One ops repository with a monolith and `SHARDS` shard files; every GET answers as a microtask, like a warm cache. */
function remote() {
  const repo = `repos/${REPO}`;
  const objects = new Map<string, unknown>();
  const put = (text: string): string => {
    const bytes = Buffer.from(text);
    const sha = sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
    objects.set(`${repo}/git/blobs/${sha}`, { sha, encoding: "base64", size: bytes.length, content: bytes.toString("base64") });
    return sha;
  };
  const tree = (name: string, entries: Array<{ path: string; type: string; mode: string; sha: string }>): string => {
    const sha = sha1(`tree ${name}`);
    objects.set(`${repo}/git/trees/${sha}`, { sha, truncated: false, tree: entries });
    return sha;
  };
  const shards = Array.from({ length: SHARDS }, (_, i) => ({
    path: `s${String(i).padStart(4, "0")}.yaml`, type: "blob", mode: "100644", sha: put(taskYaml(`OPS-T${i + 2}`)),
  }));
  const plan = tree("plan", [
    { path: "tasks.yaml", type: "blob", mode: "100644", sha: put(taskYaml("OPS-T1")) },
    { path: "tasks.d", type: "tree", mode: "040000", sha: tree("tasks.d", shards) },
  ]);
  const root = tree("root", [{ path: "plan", type: "tree", mode: "040000", sha: plan }]);
  const commit = sha1("commit 1");
  objects.set(`${repo}/git/commits/${commit}`, { sha: commit, tree: { sha: root } });
  objects.set(repo, { id: REPOSITORY_ID, full_name: REPO, default_branch: "main" });
  objects.set(`${repo}/git/ref/heads/main`, { object: { type: "commit", sha: commit } });
  /** A fresh api, so the source's in-memory blob map starts empty and every blob is answered from its file. */
  return () => {
    const paths: string[] = [];
    const api: OpsCatalogApi = async (path) => {
      paths.push(path);
      if (!objects.has(path)) throw new Error(`HTTP 404 unexpected GET ${path}`);
      return objects.get(path);
    };
    return { api, blobGets: () => paths.filter((p) => p.includes("/git/blobs/")).length };
  };
}

function stateDir(t: TestContext): string {
  const root = fs.mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14876-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("W1-T14876 criterion 1: a catalog read over many cached blob files lets a timer run between blob reads", async (t) => {
  const state = stateDir(t);
  const instance = remote();
  const cold = instance();
  assert.equal((await readOpsCatalogSnapshotAsync({ repository: REPO }, cold.api, { stateDir: state })).outcome, "ok");
  assert.equal(cold.blobGets(), SHARDS + 1, "positive control: the cold read fetched and filed every blob");

  const warm = instance();
  let settled = false;
  const timerSawRead: boolean[] = [];
  const tick = setInterval(() => timerSawRead.push(settled), 0);
  try {
    const read = readOpsCatalogSnapshotAsync({ repository: REPO }, warm.api, { stateDir: state }).finally(() => {
      settled = true;
    });
    const snapshot = await read;
    assert.equal(snapshot.outcome, "ok");
  } finally {
    clearInterval(tick);
  }
  assert.equal(warm.blobGets(), 0, "every blob was answered from its file, with no GET to wait on");
  assert.ok(timerSawRead.includes(false), "a timer ran while the cached pass was still reading blobs");
});

test("W1-T14876 criterion 2: invariant:same-answer — a cached read still answers the same plan and counts as before", async (t) => {
  const state = stateDir(t);
  const instance = remote();
  const cold = await readOpsCatalogSnapshotAsync({ repository: REPO }, instance().api, { stateDir: state });
  const warm = await readOpsCatalogSnapshotAsync({ repository: REPO }, instance().api, { stateDir: state });
  assert.equal(warm.outcome, "ok");
  assert.deepEqual(warm.plan, cold.plan, "the cached read answers the plan the fetched read answered");
  assert.equal(warm.identityDigest, cold.identityDigest);
  assert.equal(warm.plan?.tasks.length, SHARDS + 1);
  assert.equal(warm.counts.shards, cold.counts.shards);
  assert.equal(warm.counts.bytes, cold.counts.bytes);
  assert.equal(warm.counts.passes, 1);
  assert.equal(warm.counts.cachedObjects, SHARDS + 1, "every blob counts as a cache hit");
  assert.deepEqual(cold.counts.fetchedObjects.length, 1);
  assert.ok(warm.counts.fetchedObjects[0]! < cold.counts.fetchedObjects[0]!, "the cached read fetched no blob");
});
