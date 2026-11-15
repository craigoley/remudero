import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readOpsCatalogSnapshotAsync, createOpsCatalogShadowSource, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";

const REPO = "fixture-private/ops";
const hash = (s: string) => createHash("sha1").update(s).digest("hex");
const task = (id: string, deps: string[] = []) => `- id: ${id}\n  title: PRIVATE_TITLE_SENTINEL\n  repo: remudero\n  type: implement\n  priority: 0\n  depends_on: ${JSON.stringify(deps)}\n`;
function catalog(text: string, shards: Record<string, string> = {}) {
  const commit = hash(JSON.stringify([text, shards]));
  const tree = hash(commit + "root"), plan = hash(commit + "plan"), shardTree = hash(commit + "shards");
  const blobs = new Map<string, string>();
  const put = (s: string) => { const id = hash(`blob ${Buffer.byteLength(s)}\0${s}`); blobs.set(id, s); return id; };
  const entry = (path: string, sha: string, type = "tree") => ({ path, sha, type, mode: type === "tree" ? "040000" : "100644" });
  const shardEntries = Object.entries(shards).map(([name, s]) => entry(name, put(s), "blob"));
  const rootBlob = put(text), calls: string[] = [];
  const api: OpsCatalogApi = async path => {
    calls.push(path);
    const prefix = `repos/${REPO}`;
    if (path === prefix) return { id: 42, full_name: REPO, default_branch: "main" };
    if (path === `${prefix}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${prefix}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${prefix}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [entry("plan", plan)] };
    if (path === `${prefix}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [entry("tasks.yaml", rootBlob, "blob"), entry("tasks.d", shardTree)] };
    if (path === `${prefix}/git/trees/${shardTree}`) return { sha: shardTree, truncated: false, tree: shardEntries };
    const sha = path.slice(`${prefix}/git/blobs/`.length), s = blobs.get(sha);
    assert.ok(path.startsWith(`${prefix}/git/blobs/`) && s !== undefined, "only recorded GET routes are permitted");
    return { sha, encoding: "base64", size: Buffer.byteLength(s), content: Buffer.from(s).toString("base64") };
  };
  return { api, commit, calls };
}

test("W1-T12185 criterion 1: both real ops reader stores preserve a pinned public dependency", async () => {
  const fx = catalog(task("OPS-T1", ["PUBLIC-T1"]));
  const snap = await readOpsCatalogSnapshotAsync({ repository: REPO }, fx.api);
  assert.equal(snap.outcome, "ok");
  assert.deepEqual(snap.plan!.byId.get("OPS-T1")!.depends_on, ["PUBLIC-T1"]);
  assert.equal(snap.binding!.commit, fx.commit);
  assert.ok(Object.isFrozen(snap.plan));
  assert.equal(fx.calls.filter(p => p.endsWith("/git/ref/heads/main")).length, 2);
  const source = createOpsCatalogShadowSource({ repository: REPO }, fx.api);
  const first = await source.refresh();
  assert.equal(first.outcome, "ok");
  assert.equal(first.opsCommit, fx.commit);
  assert.deepEqual(first.plan!.byId.get("OPS-T1")!.depends_on, ["PUBLIC-T1"]);
  assert.equal((await source.refresh()).plan, first.plan, "one frozen plan is reused for one revision");
  assert.doesNotMatch(JSON.stringify(snap), /PRIVATE_TITLE_SENTINEL|PUBLIC-T1|fixture-private/);
});
test("W1-T12185 criterion 1 healthy control: local dependencies still resolve inside the ops catalog", async () => {
  const fx = catalog(task("OPS-T1"), { "next.yaml": task("OPS-T2", ["OPS-T1"]) });
  assert.equal((await readOpsCatalogSnapshotAsync({ repository: REPO }, fx.api)).outcome, "ok");
});
