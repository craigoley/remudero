import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createOpsCatalogShadowSource, readOpsCatalogSnapshotAsync, type OpsCatalogApi, type OpsCatalogSnapshot,
} from "#src/lib/ops-catalog-source.js";

/**
 * Measured 2026-11-18: `rmd claim` of an ops task refused `ops-ref_moved` four times running, because a ~5 minute
 * object-by-object read of remudero-ops never finished inside the 2-4 minutes between fleet merges. Every object the
 * reader verifies is content-addressed, so on a moved branch it reads again at the new commit and reuses each tree
 * and blob it already verified.
 */

const REPO = "acme-private/ops-moving-slug";
const sha1 = (b: Buffer | string): string => createHash("sha1").update(b).digest("hex");
const blobSha = (text: string): string => sha1(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(text)}\0`), Buffer.from(text)]));
const taskYaml = (id: string, title = "PRIVATE_TITLE_SENTINEL"): string =>
  `- id: ${id}\n  title: "${title}"\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [private/PRIVATE_PATH_SENTINEL]\n  rationale: PRIVATE_BODY_SENTINEL\n`;

interface Rev { monolith: string; shards: Record<string, string> }
interface Fake {
  api: OpsCatalogApi;
  calls: string[];
  commits: string[];
  setHead(index: number): void;
  /** Serve `text` under `asSha`: bytes that no longer hash to the sha a tree names. */
  tamper(asSha: string, text: string): void;
}

/**
 * A recording GET-only fake of the git data API holding several commits of one branch. Trees and commits are named by
 * their content, so an unchanged directory keeps its sha across commits exactly as git's does.
 */
function gitData(revs: Rev[], hooks: { onBlobRead?: (count: number, fake: Fake) => void; fail?: (path: string) => Error | undefined } = {}): Fake {
  const trees = new Map<string, unknown[]>();
  const blobs = new Map<string, string>();
  const commitRoot = new Map<string, string>();
  const tampered = new Map<string, string>();
  const entry = (path: string, type: string, mode: string, s: string) => ({ path, type, mode, sha: s });
  const tree = (entries: unknown[]): string => { const s = sha1(`tree ${JSON.stringify(entries)}`); trees.set(s, entries); return s; };
  const blob = (text: string): string => { const s = blobSha(text); blobs.set(s, text); return s; };
  const commits = revs.map((rev) => {
    const shardTree = tree(Object.entries(rev.shards).map(([name, text]) => entry(name, "blob", "100644", blob(text))));
    const planTree = tree([entry("tasks.yaml", "blob", "100644", blob(rev.monolith)), entry("tasks.d", "tree", "040000", shardTree)]);
    const root = tree([entry("plan", "tree", "040000", planTree)]);
    const commit = sha1(`commit ${root}`);
    commitRoot.set(commit, root);
    return commit;
  });
  let head = 0;
  let blobReads = 0;
  const calls: string[] = [];
  const fake: Fake = {
    calls, commits,
    setHead: (index) => { head = index; },
    tamper: (asSha, text) => { tampered.set(asSha, text); },
    api: async (path) => {
      calls.push(path);
      const injected = hooks.fail?.(path);
      if (injected) throw injected;
      if (path === `repos/${REPO}`) return { id: 42, full_name: REPO, default_branch: "main" };
      if (path === `repos/${REPO}/git/ref/heads/main`) return { object: { type: "commit", sha: commits[head] } };
      const commit = /\/git\/commits\/([a-f0-9]{40})$/.exec(path);
      if (commit && commitRoot.has(commit[1])) return { sha: commit[1], tree: { sha: commitRoot.get(commit[1]) } };
      const listing = /\/git\/trees\/([a-f0-9]{40})$/.exec(path);
      if (listing && trees.has(listing[1])) return { sha: listing[1], truncated: false, tree: trees.get(listing[1]) };
      const object = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
      if (object && blobs.has(object[1])) {
        blobReads++;
        hooks.onBlobRead?.(blobReads, fake);
        const text = tampered.get(object[1]) ?? blobs.get(object[1])!;
        return { sha: object[1], encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
      }
      throw new Error(`unexpected GET ${path} PRIVATE_BODY_SENTINEL`);
    },
  };
  return fake;
}

const target = { repository: REPO };
const kind = (path: string): string => path === `repos/${REPO}` ? "repository"
  : (/\/git\/(ref|commits|trees|blobs)\//.exec(path)?.[1] ?? "other");
/** The calls after the n-th branch ref read (1-based): the start of the pass that ref read began. */
const afterRefRead = (calls: string[], n: number): string[] => {
  let seen = 0;
  const index = calls.findIndex((path) => kind(path) === "ref" && ++seen === n);
  assert.ok(index >= 0, `positive control: ref read ${n} happened`);
  return calls.slice(index + 1);
};
const bytesOf = (rev: Rev): number => [rev.monolith, ...Object.values(rev.shards)].reduce((n, t) => n + Buffer.byteLength(t), 0);
const oldCounts = (snap: OpsCatalogSnapshot) => ({ treeEntries: snap.counts.treeEntries, shards: snap.counts.shards, bytes: snap.counts.bytes });

const REV1: Rev = { monolith: taskYaml("OPS-T1"), shards: { "a.yaml": taskYaml("OPS-T2", "second"), "b.yaml": taskYaml("OPS-T3", "third") } };
const REV2: Rev = { ...REV1, shards: { ...REV1.shards, "c.yaml": taskYaml("OPS-T4", "an unrelated shard") } };

test("a ref that moves once mid-read answers ok at the new commit, and the second pass reads only the changed objects", async () => {
  const fake = gitData([REV1, REV2], { onBlobRead: (count, f) => { if (count === 1) f.setHead(1); } });
  const snap = await readOpsCatalogSnapshotAsync(target, fake.api);
  assert.equal(snap.outcome, "ok", "a moved branch is read again at its new commit, not refused");
  assert.equal(snap.binding?.commit, fake.commits[1], "the answer is the commit the branch names now");
  assert.deepEqual(snap.plan?.tasks.map((t) => t.id), ["OPS-T1", "OPS-T2", "OPS-T3", "OPS-T4"]);
  const secondPass = afterRefRead(fake.calls, 2);
  assert.deepEqual(secondPass.map(kind), ["commits", "trees", "trees", "trees", "blobs", "ref"],
    "the second pass reads the new commit, its three changed trees, the one new blob and the ref, nothing more");
  assert.equal(secondPass[4], `repos/${REPO}/git/blobs/${blobSha(REV2.shards["c.yaml"])}`);
  assert.equal(fake.calls.filter((path) => kind(path) === "repository").length, 1, "the repository identity is read once");
  assert.deepEqual({ passes: snap.counts.passes, fetchedObjects: snap.counts.fetchedObjects, cachedObjects: snap.counts.cachedObjects },
    { passes: 2, fetchedObjects: [7, 5], cachedObjects: 3 });
  const fresh = await readOpsCatalogSnapshotAsync(target, gitData([REV2]).api);
  assert.equal(fresh.outcome, "ok", "positive control: a quiet read of the new commit");
  assert.equal(snap.identityDigest, fresh.identityDigest, "the answer is bound to the new commit alone, never a mix of two");
  assert.deepEqual(snap.binding, fresh.binding);
  assert.deepEqual(oldCounts(snap), oldCounts(fresh), "the size counts describe the answered commit, cached objects included");
  assert.deepEqual(oldCounts(snap), { treeEntries: 6, shards: 3, bytes: bytesOf(REV2) });
});

test("a ref that keeps moving while each pass stays cheap is followed to the commit whose pass completes, with no fixed pass count", async () => {
  const revs: Rev[] = [REV1];
  for (let i = 0; i < 4; i++) {
    const last = revs[revs.length - 1];
    revs.push({ ...last, shards: { ...last.shards, [`n${i}.yaml`]: taskYaml(`OPS-N${i}`, `added ${i}`) } });
  }
  let head = 0;
  // One move per pass, three passes running: the branch moves at the first blob GET of each pass.
  const firstBlobOfPass = (f: Fake): boolean => kind(f.calls[f.calls.length - 2]) !== "blobs";
  const fake = gitData(revs, { onBlobRead: (_count, f) => { if (head < 3 && firstBlobOfPass(f)) f.setHead(++head); } });
  const snap = await readOpsCatalogSnapshotAsync(target, fake.api);
  assert.equal(snap.outcome, "ok");
  assert.equal(snap.binding?.commit, fake.commits[3]);
  assert.equal(snap.counts.passes, 4);
  assert.ok(snap.counts.fetchedObjects.slice(1).every((n) => n < snap.counts.fetchedObjects[0]), "each later pass reads less than the first");
});

test("a ref that moves on every pass with every object changed answers ref_moved (the cache is not converging)", async () => {
  const revs: Rev[] = Array.from({ length: 6 }, (_, i) => ({
    monolith: taskYaml("OPS-T1", `v${i}`), shards: { "a.yaml": taskYaml("OPS-T2", `v${i}`), "b.yaml": taskYaml("OPS-T3", `v${i}`) },
  }));
  let head = 0;
  const fake = gitData(revs, { onBlobRead: (count, f) => { if (count % 3 === 1) f.setHead(++head); } });
  const snap = await readOpsCatalogSnapshotAsync(target, fake.api);
  assert.equal(snap.outcome, "ref_moved");
  assert.equal(snap.refusalStage, "final_ref");
  assert.equal(snap.plan, undefined);
  assert.equal(snap.binding, undefined);
  assert.equal(snap.counts.passes, 2, "a second pass that reuses nothing stops the read");
  assert.deepEqual(snap.counts.fetchedObjects, [7, 7]);
  assert.equal(snap.counts.cachedObjects, 0);
  assert.ok(!fake.calls.includes(`repos/${REPO}/git/commits/${fake.commits[2]}`), "no third pass starts");
});

test("a quiet ref reads exactly what it read before the cache: one pass, the same GETs, the same counts", async () => {
  const fake = gitData([REV1]);
  const snap = await readOpsCatalogSnapshotAsync(target, fake.api);
  assert.equal(snap.outcome, "ok");
  assert.deepEqual(fake.calls.map(kind), ["repository", "ref", "commits", "trees", "trees", "trees", "blobs", "blobs", "blobs", "ref"]);
  assert.deepEqual(oldCounts(snap), { treeEntries: 5, shards: 2, bytes: bytesOf(REV1) });
  assert.deepEqual(snap.counts, { treeEntries: 5, shards: 2, bytes: bytesOf(REV1), passes: 1, fetchedObjects: [7], cachedObjects: 0 });
});

test("a moved ref whose new commit holds a malformed blob refuses malformed", async () => {
  const fake = gitData([REV1, REV2], { onBlobRead: (count, f) => { if (count === 1) f.setHead(1); } });
  fake.tamper(blobSha(REV2.shards["c.yaml"]), taskYaml("OPS-T4", "altered under its sha"));
  const snap = await readOpsCatalogSnapshotAsync(target, fake.api);
  assert.equal(snap.outcome, "malformed");
  assert.equal(snap.refusalStage, "blob_verification");
  assert.equal(snap.plan, undefined);
  assert.equal(snap.binding, undefined);
  assert.equal(snap.counts.passes, 2, "the refusal came from the second pass, at the new commit");
});

test("a later pass that cannot read the new commit answers ref_moved, the reason it needed the pass", async () => {
  const newCommit = gitData([REV1, REV2]).commits[1];
  const failing = gitData([REV1, REV2], {
    onBlobRead: (count, f) => { if (count === 1) f.setHead(1); },
    fail: (path) => path === `repos/${REPO}/git/commits/${newCommit}` ? new Error("HTTP 502 PRIVATE_BODY_SENTINEL") : undefined,
  });
  const snap = await readOpsCatalogSnapshotAsync(target, failing.api);
  assert.equal(snap.outcome, "ref_moved");
  assert.equal(snap.refusalStage, "final_ref");
  assert.equal(snap.counts.passes, 2);
  assert.ok(failing.calls.includes(`repos/${REPO}/git/commits/${newCommit}`), "positive control: the second pass ran");
  // An empty body for the new commit (a quiet `gh` fallback, say) never bound the pass to that commit.
  const empty = gitData([REV1, REV2], { onBlobRead: (count, f) => { if (count === 1) f.setHead(1); } });
  const emptyApi: OpsCatalogApi = async (path) => path === `repos/${REPO}/git/commits/${newCommit}` ? (empty.calls.push(path), {}) : empty.api(path);
  const unbound = await readOpsCatalogSnapshotAsync(target, emptyApi);
  assert.equal(unbound.outcome, "ref_moved", "a commit the pass could not read is not a defect in that commit's content");
  assert.equal(unbound.refusalStage, "final_ref");
  assert.equal(unbound.counts.passes, 2);
});

test("the shadow source keeps its verified objects between refreshes, so a moved branch rereads only what changed", async () => {
  const fake = gitData([REV1, REV2]);
  const source = createOpsCatalogShadowSource(target, fake.api);
  const first = await source.refresh();
  assert.equal(first.outcome, "ok");
  assert.equal(first.opsCommit, fake.commits[0]);
  const before = fake.calls.length;
  fake.setHead(1);
  const second = await source.refresh();
  assert.equal(second.outcome, "ok");
  assert.equal(second.opsCommit, fake.commits[1]);
  assert.deepEqual(second.plan?.tasks.map((t) => t.id), ["OPS-T1", "OPS-T2", "OPS-T3", "OPS-T4"]);
  const refresh = fake.calls.slice(before);
  assert.deepEqual(refresh.filter((path) => kind(path) === "blobs"), [`repos/${REPO}/git/blobs/${blobSha(REV2.shards["c.yaml"])}`],
    "only the new shard's blob is fetched; the kept ones come from the source's cache");
  assert.equal(refresh.filter((path) => kind(path) === "trees").length, 3);
  const third = fake.calls.length;
  assert.equal((await source.refresh()).plan, second.plan);
  assert.deepEqual(fake.calls.slice(third).map(kind), ["ref"], "a quiet branch still costs one ref GET");
});
