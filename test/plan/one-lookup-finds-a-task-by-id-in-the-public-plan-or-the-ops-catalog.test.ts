import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { mergePlanBlobs, type Task } from "#src/lib/plan.js";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import type { ReviewCommandDeps } from "#src/cli/commands/review.js";

const ID = "W1-T900000", REPOSITORY = "fixture-private/ops";
const yaml = (id = ID) => `- id: ${id}\n  title: Private lookup fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  priority: 0\n  risk: high\n  budget_usd: 0.5\n  files: [src/fixture.ts]\n  design: Private canonical design\n  acceptance:\n    - claim: canonical private criterion\n      proof: "grep: lookup-fixture in src/fixture.ts"\n`;
const task = (id = ID): Task => mergePlanBlobs([{ label: "fixture.yaml", text: yaml(id) }]).byId.get(id)!;
function fixture(t: TestContext, text = yaml()) {
  const root = mkdtempSync(join(tmpdir(), "rmd-catalog-lookup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  writeFileSync(join(stateDir, "plan-destination.json"), JSON.stringify({ repository: REPOSITORY, kinds: [] }));
  const hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(text), tree = hash(commit + "root"), plan = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`), calls: string[] = [];
  const api: OpsCatalogApi = async path => {
    calls.push(path); const base = `repos/${REPOSITORY}`;
    if (path === base) return { id: 42, full_name: REPOSITORY, default_branch: "main" };
    if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
    assert.equal(path, `${base}/git/blobs/${blob}`, "only pinned read-only fixture routes may run");
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
  };
  return { root, stateDir, api, calls };
}
async function lookup() { return import("#src/lib/task-lookup.js"); }

test("W1-T12207 criterion 1: public wins without a private read; a named empty-kind destination uses the real pinned ops reader", async t => {
  const fx = fixture(t), { findTaskInCatalogs } = await lookup();
  const publicTask = task();
  const first = await findTaskInCatalogs(ID, { readPublic: () => publicTask, stateDir: fx.stateDir, api: fx.api });
  assert.equal(first.outcome, "found"); assert.equal(first.catalog, "public"); assert.equal(first.task, publicTask); assert.deepEqual(fx.calls, []);
  const second = await findTaskInCatalogs(ID, { readPublic: () => undefined, stateDir: fx.stateDir, api: fx.api });
  assert.equal(second.outcome, "found"); assert.equal(second.catalog, "ops"); assert.equal(second.task?.id, ID);
  assert.equal(second.task?.files[0], "src/fixture.ts"); assert.ok(fx.calls.length > 4); assert.equal(fx.calls.filter(p => p.endsWith("/git/ref/heads/main")).length, 2);
});

test("W1-T12207 criterion 2: the real review command receives the private canonical criteria files risk budget and narrative before body fallback", async t => {
  const fx = fixture(t); const { reviewCommand } = await import("#src/run-task.js");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  let reviewed: Record<string, unknown> | undefined;
  const deps: ReviewCommandDeps = {
    loadConfig: () => ({ root: fx.root }) as never,
    resolveOwnerRepo: () => ({ owner: "fixture", repo: "remudero" }),
    fetchView: () => ({ body: `Remudero-Task: ${ID}\n\n## Acceptance\n- wrong body criterion | grep: wrong in src/wrong.ts`, html_url: "https://github.com/fixture/remudero/pull/42", number: 42, head: { ref: `run-${ID}-1`, sha: head }, updated_at: new Date().toISOString() }),
    fetchHead: () => {},
    taskLookup: { api: fx.api },
    postReviewPending: async () => ({ posted: true }) as never,
    materialize: () => ({ worktreePath: undefined, failure: { errorClass: "fixture", message: "no real worker" } }) as never,
    runReview: (async args => { reviewed = args.task; throw Error("fixture captured canonical task"); }) as never,
    postStatus: (() => { throw Error("forbidden public status"); }) as never,
  };
  await assert.rejects(() => reviewCommand("42", [], deps), /fixture captured canonical task/);
  assert.equal(reviewed?.id, ID); assert.deepEqual(reviewed?.files, ["src/fixture.ts"]); assert.equal(reviewed?.risk, "high"); assert.equal(reviewed?.budget_usd, 0.5);
  assert.equal((reviewed?.acceptance as Array<{ claim: string }>)[0]?.claim, "canonical private criterion"); assert.equal(reviewed?.design, "Private canonical design");
});

test("W1-T12207 criterion 3: fix and sweep scope checks use the private task files and preserve outside-path evidence", async t => {
  const fx = fixture(t); const { catalogTaskScope } = await import("#src/lib/sweep.js");
  const scope = await catalogTaskScope(ID, ["src/fixture.ts", "src/outside.ts"], { readPublic: () => undefined, stateDir: fx.stateDir, api: fx.api });
  assert.equal(scope.outcome, "found"); assert.deepEqual(scope.outside, ["src/outside.ts"]); assert.deepEqual(scope.task?.files, ["src/fixture.ts"]);
  const { fixCatalogTask } = await import("#src/cli/commands/fix.js");
  const found = await fixCatalogTask(ID, { tasks: [], byId: new Map() }, { stateDir: fx.stateDir, api: fx.api });
  assert.equal(found.outcome, "found"); assert.deepEqual(found.task?.files, ["src/fixture.ts"]);
});

test("W1-T12207 criterion 4: the claim command accepts a private task but passes only the public root to its ordinary reserver", async t => {
  const fx = fixture(t); const { claimCommandWithCatalogs } = await import("#src/run-task.js");
  const roots: string[] = [], attempted: string[] = [];
  const result = await claimCommandWithCatalogs([ID], { stateDir: fx.stateDir, isPlanned: () => false, taskLookup: { api: fx.api }, reserverFor: root => { roots.push(root); return { mintAnchor: () => "a".repeat(40), attempt: id => { attempted.push(id); return "created"; }, holder: () => undefined, drop: () => false }; } });
  assert.equal(result, 0); assert.deepEqual(attempted, [ID]); assert.deepEqual(roots, [REPO_ROOT]);
});

test("W1-T12207 criterion 5: unreadable public destination or ops evidence never becomes an absent task or a body fallback", async t => {
  const fx = fixture(t), { findTaskInCatalogs } = await lookup();
  const readPublic = () => undefined;
  const bad = await findTaskInCatalogs(ID, { readPublic, stateDir: fx.stateDir, api: async () => { throw Error("PRIVATE_BYTES_SENTINEL"); } });
  assert.equal(bad.outcome, "unreadable"); assert.equal(bad.task, undefined); assert.ok(!JSON.stringify(bad).includes("PRIVATE_BYTES_SENTINEL"));
  writeFileSync(join(fx.stateDir, "plan-destination.json"), "invalid private bytes");
  assert.equal((await findTaskInCatalogs(ID, { readPublic, stateDir: fx.stateDir, api: fx.api })).outcome, "unreadable");
  assert.equal((await findTaskInCatalogs(ID, { readPublic: () => { throw Error("public unreadable"); }, stateDir: fx.stateDir, api: fx.api })).outcome, "unreadable");
  assert.deepEqual(fx.calls, []);
});

test("W1-T12207 criterion 6: an absent host file preserves public results and never reads a private catalog", async t => {
  const fx = fixture(t), { findTaskInCatalogs } = await lookup(); rmSync(join(fx.stateDir, "plan-destination.json"));
  let reads = 0; const deps = { readPublic: () => { reads++; return undefined; }, stateDir: fx.stateDir, api: fx.api };
  assert.equal((await findTaskInCatalogs(ID, deps)).outcome, "absent"); assert.equal(reads, 1); assert.deepEqual(fx.calls, []);
});
