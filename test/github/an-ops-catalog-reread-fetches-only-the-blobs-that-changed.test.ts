import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import {
  OpsCatalogAuthMissingError, readOpsCatalogSnapshotAsync, type OpsCatalogApi, type OpsCatalogSnapshot,
} from "#src/lib/ops-catalog-source.js";

const REPO = "acme-private/ops-catalog";
const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const blobSha = (text: string): string => sha1(`blob ${Buffer.byteLength(text)}\0${text}`);
const taskYaml = (id: string, title = `title of ${id}`): string =>
  `- id: ${id}\n  title: "${title}"\n  repo: remudero\n  type: implement\n  verify: auto\n  files: [src/a.ts]\n  rationale: r\n`;

interface Catalog { monolith: string; shards: Record<string, string>; noPlanDir?: boolean }
type BlobAnswer = (blobSha: string, text: string) => unknown;

/** A recording GET-only fake of the git data API whose default branch can move between commits. */
function remote(first: Catalog, opts: { repository?: string; id?: number } = {}) {
  const repository = opts.repository ?? REPO;
  const repo = `repos/${repository}`;
  let id = opts.id ?? 42;
  const trees = new Map<string, unknown>();
  const commits = new Map<string, string>();
  const blobs = new Map<string, string>();
  const calls: string[] = [];
  const blobAnswers = new Map<string, BlobAnswer>();
  let fail: ((path: string) => Error | undefined) | undefined;
  let afterBlob: ((blobSha: string) => void) | undefined;
  let serial = 0;
  const tree = (entries: Array<{ path: string; type: string; mode: string; sha: string }>): string => {
    const s = sha1(`tree ${serial++} ${JSON.stringify(entries)}`);
    trees.set(s, { sha: s, truncated: false, tree: entries });
    return s;
  };
  const put = (text: string): string => { const s = blobSha(text); blobs.set(s, text); return s; };
  const commitOf = (c: Catalog): string => {
    const shardTree = tree(Object.entries(c.shards).map(([path, text]) => ({ path, type: "blob", mode: "100644", sha: put(text) })));
    const planTree = tree([
      { path: "tasks.yaml", type: "blob", mode: "100644", sha: put(c.monolith) },
      { path: "tasks.d", type: "tree", mode: "040000", sha: shardTree },
    ]);
    const root = tree(c.noPlanDir ? [] : [{ path: "plan", type: "tree", mode: "040000", sha: planTree }]);
    const commit = sha1(`commit ${serial++}`);
    commits.set(commit, root);
    return commit;
  };
  let head = commitOf(first);
  const api: OpsCatalogApi = async (path) => {
    calls.push(path);
    const injected = fail?.(path);
    if (injected) throw injected;
    if (path === repo) return { id, full_name: repository, default_branch: "main" };
    if (path === `${repo}/git/ref/heads/main`) return { object: { type: "commit", sha: head } };
    const commit = /\/git\/commits\/([a-f0-9]{40})$/.exec(path);
    if (commit && commits.has(commit[1])) return { sha: commit[1], tree: { sha: commits.get(commit[1]) } };
    const treeMatch = /\/git\/trees\/([a-f0-9]{40})$/.exec(path);
    if (treeMatch && trees.has(treeMatch[1])) return trees.get(treeMatch[1]);
    const blob = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
    if (blob && blobs.has(blob[1])) {
      const text = blobs.get(blob[1])!;
      const answer = blobAnswers.get(blob[1]);
      const body = answer ? answer(blob[1], text)
        : { sha: blob[1], encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
      afterBlob?.(blob[1]);
      return body;
    }
    throw new Error(`unexpected GET ${path}`);
  };
  return {
    api, calls, repository,
    target: { repository },
    move(c: Catalog): string { head = commitOf(c); return head; },
    setHead(commit: string): void { head = commit; },
    setId(next: number): void { id = next; },
    blobGets(): string[] { return calls.filter((p) => p.includes("/git/blobs/")).map((p) => p.slice(-40)); },
    reset(): void { calls.length = 0; },
    answerBlob(text: string, answer: BlobAnswer | undefined): void {
      if (answer) blobAnswers.set(blobSha(text), answer); else blobAnswers.delete(blobSha(text));
    },
    failWhen(f: typeof fail): void { fail = f; },
    onBlob(f: typeof afterBlob): void { afterBlob = f; },
    commitOf,
  };
}

const base = (): Catalog => ({
  monolith: taskYaml("OPS-T1"),
  shards: { "a.yaml": taskYaml("OPS-T2"), "b.yaml": taskYaml("OPS-T3"), "c.yaml": taskYaml("OPS-T4") },
});
const withShard = (c: Catalog, name: string, text: string): Catalog => ({ ...c, shards: { ...c.shards, [name]: text } });
const view = (snap: OpsCatalogSnapshot) => ({
  outcome: snap.outcome,
  refusalStage: snap.refusalStage,
  tasks: snap.plan?.tasks.map((t) => JSON.stringify(t)),
  binding: snap.binding,
  identityDigest: snap.identityDigest,
});
/** The same answers through a new api that has kept nothing. */
const cold = (r: ReturnType<typeof remote>): OpsCatalogApi => async (path) => r.api(path);

test("W1-T13673 criterion 1: a reread after a one-shard move sends one git/blobs GET, for the changed shard", async () => {
  const r = remote(base());
  const first = await readOpsCatalogSnapshotAsync(r.target, r.api);
  assert.equal(first.outcome, "ok");
  assert.equal(r.blobGets().length, 4, "positive control: the first read GETs every blob");
  const changed = taskYaml("OPS-T3", "the changed title");
  r.move(withShard(base(), "b.yaml", changed));
  r.reset();
  const second = await readOpsCatalogSnapshotAsync(r.target, r.api);
  assert.equal(second.outcome, "ok");
  assert.deepEqual(r.blobGets(), [blobSha(changed)], "only the changed shard's blob is read");
  assert.equal(second.plan?.byId.get("OPS-T3")?.title, "the changed title");
  assert.notEqual(second.identityDigest, first.identityDigest);
  assert.ok(r.calls.some((p) => p.includes("/git/trees/")) && r.calls.some((p) => p.includes("/git/commits/")),
    "trees and the commit are still read");
});

test("W1-T13673 criterion 2: a second read at the same commit sends no git/blobs GET and returns the same catalog", async () => {
  const r = remote(base());
  const first = await readOpsCatalogSnapshotAsync(r.target, r.api);
  r.reset();
  const second = await readOpsCatalogSnapshotAsync(r.target, r.api);
  assert.equal(second.outcome, "ok");
  assert.equal(r.blobGets().length, 0);
  assert.deepEqual(second.plan?.tasks.map((t) => JSON.stringify(t)), first.plan?.tasks.map((t) => JSON.stringify(t)));
  assert.deepEqual(second.binding, first.binding);
  assert.equal(second.identityDigest, first.identityDigest);
  assert.equal(second.counts.bytes, first.counts.bytes, "kept blobs still count toward the size bounds");
});

test("W1-T13673 criterion 3: a read with kept blobs returns what a cold read of the same answers returns", async () => {
  const r = remote(base());
  await readOpsCatalogSnapshotAsync(r.target, r.api);
  r.move(withShard(base(), "a.yaml", taskYaml("OPS-T2", "moved once")));
  await readOpsCatalogSnapshotAsync(r.target, r.api);
  r.move({ ...withShard(base(), "c.yaml", taskYaml("OPS-T4", "moved twice")), monolith: taskYaml("OPS-T1", "new monolith") });
  r.reset();
  const warm = await readOpsCatalogSnapshotAsync(r.target, r.api);
  assert.equal(r.blobGets().length, 3, "positive control: the warm read used kept blobs for b.yaml");
  const fresh = await readOpsCatalogSnapshotAsync(r.target, cold(r));
  assert.equal(warm.outcome, "ok");
  assert.deepEqual(view(warm), view(fresh));
  assert.equal(warm.plan?.byId.get("OPS-T4")?.title, "moved twice");
});

test("W1-T13673 criterion 4: a blob that fails a check is refused as before and is not kept", async () => {
  const bad: Array<[string, BlobAnswer]> = [
    ["wrong sha", (s, t) => ({ sha: sha1("other"), encoding: "base64", size: Buffer.byteLength(t), content: Buffer.from(t).toString("base64") })],
    ["wrong encoding", (s, t) => ({ sha: s, encoding: "utf-8", size: Buffer.byteLength(t), content: t })],
    ["bad base64", (s, t) => ({ sha: s, encoding: "base64", size: Buffer.byteLength(t), content: "!!!!" })],
    ["wrong size", (s, t) => ({ sha: s, encoding: "base64", size: Buffer.byteLength(t) + 1, content: Buffer.from(t).toString("base64") })],
    ["wrong bytes", (s, t) => ({ sha: s, encoding: "base64", size: Buffer.byteLength(t), content: Buffer.from(t.replace("r", "x")).toString("base64") })],
  ];
  for (const [label, answer] of bad) {
    const r = remote(base());
    await readOpsCatalogSnapshotAsync(r.target, r.api);
    const changed = taskYaml("OPS-T2", `changed for ${label}`);
    r.move(withShard(base(), "a.yaml", changed));
    r.answerBlob(changed, answer);
    const refused = await readOpsCatalogSnapshotAsync(r.target, r.api);
    const coldRefused = await readOpsCatalogSnapshotAsync(r.target, cold(r));
    assert.deepEqual(view(refused), view(coldRefused), `${label}: refused as a cold read refuses`);
    assert.equal(refused.outcome, "malformed", label);
    assert.equal(refused.refusalStage, "blob_verification", label);
    r.answerBlob(changed, undefined);
    r.reset();
    const next = await readOpsCatalogSnapshotAsync(r.target, r.api);
    assert.equal(next.outcome, "ok", label);
    assert.deepEqual(r.blobGets(), [blobSha(changed)], `${label}: the refused blob is read again`);
  }
});

test("W1-T13673 criterion 4: a kept blob serves only the same api and the same repository id", async () => {
  const a = remote(base(), { repository: "acme-private/ops-a", id: 101 });
  const b = remote(base(), { repository: "acme-private/ops-b", id: 202 });
  const both: OpsCatalogApi = (path) => (path.startsWith("repos/acme-private/ops-a/") || path === "repos/acme-private/ops-a"
    ? a.api(path) : b.api(path));
  assert.equal((await readOpsCatalogSnapshotAsync(a.target, both)).outcome, "ok");
  assert.equal(a.blobGets().length, 4);
  assert.equal((await readOpsCatalogSnapshotAsync(b.target, both)).outcome, "ok");
  assert.equal(b.blobGets().length, 4, "another repository with the same blob shas reads its own blobs");

  const r = remote(base(), { id: 7 });
  await readOpsCatalogSnapshotAsync(r.target, r.api);
  r.setId(8);
  r.reset();
  assert.equal((await readOpsCatalogSnapshotAsync(r.target, r.api)).outcome, "ok");
  assert.equal(r.blobGets().length, 4, "a new repository id behind the same name reads every blob again");

  r.reset();
  assert.equal((await readOpsCatalogSnapshotAsync(r.target, cold(r))).outcome, "ok");
  assert.equal(r.blobGets().length, 4, "another api keeps nothing of this api's blobs");
});

test("W1-T13673 criterion 4: no blob byte is written to a file", async (t) => {
  const r = remote(base());
  const writes: string[] = [];
  const forbid = (method: string) => () => { writes.push(method); throw new Error("filesystem mutation forbidden"); };
  for (const method of ["appendFile", "copyFile", "cp", "link", "mkdir", "mkdtemp", "open", "rename",
    "rm", "rmdir", "symlink", "truncate", "unlink", "write", "writeFile", "writev"] as const) {
    t.mock.method(fs, method, forbid(method));
    t.mock.method(fs, `${method}Sync`, forbid(`${method}Sync`));
  }
  for (const method of ["appendFile", "copyFile", "cp", "link", "mkdir", "mkdtemp", "open", "rename",
    "rm", "rmdir", "symlink", "truncate", "unlink", "writeFile"] as const) {
    t.mock.method(fs.promises, method, forbid(`promises.${method}`));
  }
  t.mock.method(fs, "createWriteStream", forbid("createWriteStream"));
  syncBuiltinESMExports();
  try {
    assert.throws(() => fs.writeFileSync("positive-control", "x"), /filesystem mutation forbidden/);
    writes.length = 0;
    assert.equal((await readOpsCatalogSnapshotAsync(r.target, r.api)).outcome, "ok");
    r.move(withShard(base(), "c.yaml", taskYaml("OPS-T4", "moved")));
    assert.equal((await readOpsCatalogSnapshotAsync(r.target, r.api)).outcome, "ok");
    assert.deepEqual(writes, [], "keeping and reusing blobs attempts no filesystem write");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("W1-T13673 criterion 5: every refusal and stage equals a cold read's, and a ref_moved read keeps what it verified", async () => {
  type Scenario = { label: string; outcome: string; stage: string; arrange(r: ReturnType<typeof remote>): void };
  const scenarios: Scenario[] = [
    { label: "auth_missing", outcome: "auth_missing", stage: "commit",
      arrange: (r) => r.failWhen((p) => (p.includes("/git/commits/") ? new OpsCatalogAuthMissingError() : undefined)) },
    { label: "unreadable", outcome: "unreadable", stage: "shard_tree",
      arrange: (r) => { let n = 0; r.failWhen((p) => (p.includes("/git/trees/") && ++n === 3 ? new Error("HTTP 502") : undefined)); } },
    { label: "malformed", outcome: "malformed", stage: "strict_parse",
      arrange: (r) => r.move(withShard(base(), "a.yaml", "- id: OPS-T2\n  title: [")) },
    { label: "source_absent", outcome: "source_absent", stage: "plan_tree",
      arrange: (r) => r.move({ ...base(), noPlanDir: true }) },
    { label: "duplicate_task_id", outcome: "duplicate_task_id", stage: "strict_parse",
      arrange: (r) => r.move(withShard(base(), "d.yaml", taskYaml("OPS-T2", "a second OPS-T2"))) },
    { label: "ref_moved", outcome: "ref_moved", stage: "final_ref",
      arrange: (r) => {
        const changed = taskYaml("OPS-T2", "ref moves under me");
        const later = r.commitOf(withShard(base(), "b.yaml", taskYaml("OPS-T3", "later")));
        r.move(withShard(base(), "a.yaml", changed));
        r.onBlob((s) => { if (s === blobSha(changed)) r.setHead(later); });
      } },
  ];
  for (const s of scenarios) {
    const warmRemote = remote(base());
    assert.equal((await readOpsCatalogSnapshotAsync(warmRemote.target, warmRemote.api)).outcome, "ok");
    s.arrange(warmRemote);
    const warm = await readOpsCatalogSnapshotAsync(warmRemote.target, warmRemote.api);
    const coldRemote = remote(base());
    s.arrange(coldRemote);
    const fresh = await readOpsCatalogSnapshotAsync(coldRemote.target, coldRemote.api);
    assert.equal(warm.outcome, s.outcome, s.label);
    assert.equal(warm.refusalStage, s.stage, s.label);
    assert.deepEqual(view(warm), view(fresh), `${s.label}: same as a read that kept nothing`);
  }

  const r = remote(base());
  await readOpsCatalogSnapshotAsync(r.target, r.api);
  const changedA = taskYaml("OPS-T2", "verified during a moved read");
  const changedB = taskYaml("OPS-T3", "the commit the ref moved to");
  const later = r.commitOf({ ...withShard(base(), "a.yaml", changedA), shards: { ...withShard(base(), "a.yaml", changedA).shards, "b.yaml": changedB } });
  r.move(withShard(base(), "a.yaml", changedA));
  r.onBlob((s) => { if (s === blobSha(changedA)) r.setHead(later); });
  assert.equal((await readOpsCatalogSnapshotAsync(r.target, r.api)).outcome, "ref_moved");
  r.onBlob(undefined);
  r.reset();
  const next = await readOpsCatalogSnapshotAsync(r.target, r.api);
  assert.equal(next.outcome, "ok");
  assert.deepEqual(r.blobGets(), [blobSha(changedB)], "the blob verified during the moved read is not read again");
});

test("W1-T13673 criterion 6: after an ok read the kept blobs are exactly the blobs its binding names", async () => {
  const r = remote(base());
  await readOpsCatalogSnapshotAsync(r.target, r.api);
  const changed = taskYaml("OPS-T2", "replaces a.yaml");
  r.move(withShard(base(), "a.yaml", changed));
  assert.equal((await readOpsCatalogSnapshotAsync(r.target, r.api)).outcome, "ok");
  r.move(base());
  r.reset();
  assert.equal((await readOpsCatalogSnapshotAsync(r.target, r.api)).outcome, "ok");
  assert.deepEqual(r.blobGets(), [blobSha(base().shards["a.yaml"])],
    "the earlier a.yaml blob was dropped; the blobs the binding still named were kept");
  r.move(withShard(base(), "a.yaml", changed));
  r.reset();
  assert.equal((await readOpsCatalogSnapshotAsync(r.target, r.api)).outcome, "ok");
  assert.deepEqual(r.blobGets(), [blobSha(changed)], "the blob the last binding did not name was dropped too");
});

test("W1-T13673 criterion 7: two reads with no api argument share one default api and the second reads no blob", async () => {
  const repository = "acme-c7/ops-catalog";
  const repo = `repos/${repository}`;
  const monolith = taskYaml("OPS-T71");
  const shard = taskYaml("OPS-T72");
  const blob = (text: string) => JSON.stringify({ sha: blobSha(text), encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") });
  const shardTree = sha1("c7 shard tree");
  const planTree = sha1("c7 plan tree");
  const rootTree = sha1("c7 root tree");
  const commit = sha1("c7 commit");
  const routes: GhShimRoute[] = [
    { when: `${repo}/git/blobs/${blobSha(monolith)}`, stdout: blob(monolith) },
    { when: `${repo}/git/blobs/${blobSha(shard)}`, stdout: blob(shard) },
    { when: `${repo}/git/trees/${shardTree}`, stdout: JSON.stringify({ sha: shardTree, truncated: false, tree: [{ path: "x.yaml", type: "blob", mode: "100644", sha: blobSha(shard) }] }) },
    { when: `${repo}/git/trees/${planTree}`, stdout: JSON.stringify({ sha: planTree, truncated: false, tree: [
      { path: "tasks.yaml", type: "blob", mode: "100644", sha: blobSha(monolith) },
      { path: "tasks.d", type: "tree", mode: "040000", sha: shardTree },
    ] }) },
    { when: `${repo}/git/trees/${rootTree}`, stdout: JSON.stringify({ sha: rootTree, truncated: false, tree: [{ path: "plan", type: "tree", mode: "040000", sha: planTree }] }) },
    { when: `${repo}/git/commits/${commit}`, stdout: JSON.stringify({ sha: commit, tree: { sha: rootTree } }) },
    { when: `${repo}/git/ref/heads/main`, stdout: JSON.stringify({ object: { type: "commit", sha: commit } }) },
    { when: repo, stdout: JSON.stringify({ id: 77, full_name: repository, default_branch: "main" }) },
  ];
  const shim = ghShim(routes);
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${priorPath}`;
    const blobCalls = () => shim.calls().filter((c) => c.includes("/git/blobs/")).length;
    const first = await readOpsCatalogSnapshotAsync({ repository });
    assert.equal(first.outcome, "ok");
    assert.equal(blobCalls(), 2, "positive control: the first read spawns gh for each blob");
    const before = shim.calls().length;
    const second = await readOpsCatalogSnapshotAsync({ repository });
    assert.equal(second.outcome, "ok");
    assert.equal(blobCalls(), 2, "the second read spawns no gh api .../git/blobs/...");
    assert.ok(shim.calls().length > before, "the ref, commit and trees are still read");
    assert.equal(second.identityDigest, first.identityDigest);
  } finally {
    process.env.PATH = priorPath;
    fs.rmSync(shim.dir, { recursive: true, force: true });
  }
});
