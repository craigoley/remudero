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
import { mergePlanBlobs, loadPlanFromYaml } from "#src/lib/plan.js";
import { createPlanRevisionStore } from "#src/lib/plan-revision-store.js";

test("W1-T12185 criterion 4: opt-in is isolated from ordinary strict readers and revision stores", () => {
  const blobs = [{ label: "ops.yaml", text: task("OPS-T1", ["PUBLIC-T1"]) }];
  const revision = { key: "fixture", commit: "a".repeat(40), repoDir: "", relPath: "" };
  assert.throws(() => loadPlanFromYaml(blobs[0].text, "ordinary"), /unknown task/);
  assert.throws(() => mergePlanBlobs(blobs), /unknown task/);
  assert.throws(() => createPlanRevisionStore().adopt(revision, blobs), /unknown task/);
  assert.throws(() => createPlanRevisionStore({ strict: true }).adopt(revision, blobs), /unknown task/);
  const explicit = createPlanRevisionStore({ dependencyMode: "preserve-external" });
  const result = explicit.adopt(revision, blobs);
  assert.deepEqual(result.plan.byId.get("OPS-T1")!.depends_on, ["PUBLIC-T1"]);
  assert.equal(explicit.adopt(revision, blobs).plan, result.plan);
  assert.deepEqual(result.quarantined, []);
  assert.throws(() => createPlanRevisionStore({ strict: true }).adopt(revision, blobs), /unknown task/);
});
for (const value of ["null", "17", '"PUBLIC-T1"', '[null]', '[17]', '[" "]', '["bad/path"]']) {
  test(`W1-T12185 criterion 4: invalid dependency representation ${value} refuses without a partial plan`, async () => {
    const text = task("OPS-T1").replace('depends_on: []', `depends_on: ${value}`);
    const fx = catalog(text);
    const snap = await readOpsCatalogSnapshotAsync({ repository: REPO }, fx.api);
    assert.equal(snap.outcome, "malformed");
    assert.equal(snap.plan, undefined);
  });
}
test("W1-T12185 criterion 4: malformed and duplicate snapshots still refuse; stale never returns the previous plan", async () => {
  for (const fx of [catalog("not: [valid"), catalog(task("OPS-T1") + task("OPS-T1")), catalog(task("OPS-T1"), { "duplicate.yaml": task("OPS-T1") })]) {
    const snap = await readOpsCatalogSnapshotAsync({ repository: REPO }, fx.api);
    assert.ok(["malformed", "duplicate_task_id"].includes(snap.outcome));
    assert.equal(snap.plan, undefined);
  }
  const fx = catalog(task("OPS-T1", ["PUBLIC-T1"]));
  let fail = false;
  const source = createOpsCatalogShadowSource({ repository: REPO }, path => { if (fail) throw Error("PRIVATE_TITLE_SENTINEL"); return fx.api(path); });
  assert.equal((await source.refresh()).outcome, "ok");
  fail = true;
  const stale = await source.refresh();
  assert.equal(stale.outcome, "stale");
  assert.equal(stale.plan, undefined);
  assert.doesNotMatch(JSON.stringify(stale), /PRIVATE_TITLE_SENTINEL/);
});
