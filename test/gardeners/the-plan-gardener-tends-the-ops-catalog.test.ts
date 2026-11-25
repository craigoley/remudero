// W1-T14642. The plan gardener read the public catalog only, so a queued ops task whose dependency was retired, or
// named an id no catalog holds, waited forever, and an ops edit had no way to land. These suites drive the real spec,
// the real inventory and the production seams over real git; the ops catalog is a fake GitHub api over a real checkout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { GardenLandOpts, GardenerDeps } from "#src/lib/gardener.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import {
  opsLandingInputs,
  orphanedHolds,
  planCandidates,
  planGardenSpec,
  planInventory,
  productionPlanGardenOps,
  type PlanGardenOps,
  type PlanOpsRead,
} from "#src/lib/plan-gardener.js";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";

const shardText = (id: string, o: { deps?: string[]; status?: string; retirement?: string; type?: string; needsInput?: true } = {}) => [
  `- id: ${id}`, `  title: "the task ${id}"`, "  repo: remudero", `  depends_on: [${(o.deps ?? []).join(", ")}]`, `  type: ${o.type ?? "implement"}`,
  `  status: ${o.status ?? "queued"}`, ...(o.retirement ? [`  retirement: ${o.retirement}`] : []),
  ...(o.needsInput ? ["  needs_input:", '    question: "which way?"', '    asked_at: "2026-11-24T00:00:00Z"'] : []), "  files: [src/lib/x.ts]",
  "  acceptance:", '    - claim: "c"', `      proof: 'grep: never-written-${id} in src/lib/x.ts'`, "",
].join("\n");

type Spec = Parameters<typeof shardText>[1];

/** A public checkout holding `tasks` as one shard each, committed so the inventory's git reads work. */
function publicWorld(tasks: Array<[string, Spec]>) {
  const repo = gitRepo({ kind: "w1-t14642-public" });
  const root = repo.dir;
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  for (const [id, o] of tasks) writeFileSync(join(root, "plan", "tasks.d", `${id}-x.yaml`), shardText(id, o));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "file the tasks");
  return root;
}

/** The ops catalog as one read leaves it: the strict loader refuses an id no catalog holds, so it is read as the ops reader does. */
function opsCatalog(tasks: Array<[string, Spec]>): PlanOpsRead {
  const shards = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const [id, o] of tasks) {
    const rel = `plan/tasks.d/${id}-x.yaml`;
    shards.set(id, rel);
    sources.set(rel, shardText(id, o));
  }
  const parsed = mergePlanBlobs([...sources].map(([rel, text]) => ({ label: rel.replace(/^plan\//, ""), text })), {}, { dependencyMode: "preserve-external" });
  return { outcome: "ok", tasks: parsed.tasks, shards, sources };
}

const queuedOps = (...tasks: Array<[string, Spec]>) => opsCatalog(tasks);

test("W1-T14642 criterion 1: the inventory holds the ops catalog's tasks beside the public ones", () => {
  const root = publicWorld([["W1-T1", {}]]);
  const inv = planInventory(root, join(root, "state"), queuedOps(["OPS-T1", {}], ["OPS-T2", { status: "merged" }]));
  assert.deepEqual(inv.all.map((t) => t.id), ["W1-T1", "OPS-T1", "OPS-T2"]);
  assert.deepEqual(inv.open.map((t) => t.id), ["W1-T1", "OPS-T1"]);
  assert.equal(inv.ops?.shards.get("OPS-T1"), "plan/tasks.d/OPS-T1-x.yaml");
  assert.equal(inv.shards.has("OPS-T1"), false, "an ops record is never a public shard");
});

test("W1-T14642 criterion 2: a queued ops task whose dependency is retired is retired, and lands through the ops landing only", () => {
  const root = publicWorld([["W1-T1", { status: "blocked", retirement: "retired" }]]);
  const opsRead = queuedOps(["OPS-T1", { deps: ["W1-T1"] }], ["OPS-T2", { deps: ["OPS-T1"] }]);
  const inv = planInventory(root, join(root, "state"), opsRead);
  const actions = planCandidates(inv, root);
  assert.deepEqual(actions.map((a) => [a.class, a.target, a.retirement]), [["retire", "OPS-T1", "retired"]]);
  const ops = opsLandingInputs(inv.ops!, actions);
  assert.equal(ops.inputs.length, 1);
  assert.equal(ops.inputs[0]!.relPath, "plan/tasks.d/OPS-T1-x.yaml");
  assert.match(ops.inputs[0]!.content, /^ {2}status: blocked\n {2}retirement: retired\n {2}# plan gardener: retire OPS-T1 — It depends on W1-T1, which will never be built\.$/m);
  assert.equal(ops.inputs[0]!.proof, "grep: plan gardener: retire OPS-T1 in plan/tasks.d/OPS-T1-x.yaml");
});

test("W1-T14642 criterion 2: a queued task that depends on an id neither catalog holds is retired", () => {
  const root = publicWorld([["W1-T1", {}], ["W1-T2", { deps: ["W1-T1"] }]]);
  const opsRead = queuedOps(["OPS-T1", { deps: ["W1-T1"] }], ["OPS-T2", { deps: ["W1-T1", "GONE-T9"] }], ["OPS-T3", { deps: ["OPS-T1"] }]);
  const actions = planCandidates(planInventory(root, join(root, "state"), opsRead), root);
  assert.deepEqual(actions.map((a) => [a.target, a.reason]), [["OPS-T2", "It depends on GONE-T9, which no catalog holds and no reservation covers."]]);
  // With no ops catalog configured the public plan is the whole plan, so an id it lacks is unknown there too.
  const publicOnly = planInventory(root, join(root, "state"));
  assert.equal(publicOnly.known?.has("OPS-T1"), false);
  assert.equal(publicOnly.known?.has("W1-T1"), true);
});

test("W1-T14642 criterion 2: an id a reservation holds is not unknown, and an unreadable reservation read makes none unknown", () => {
  const root = publicWorld([["W1-T1", {}]]);
  const opsRead = queuedOps(["OPS-T1", { deps: ["W1-T9"] }]);
  const stateDir = join(root, "state");
  assert.deepEqual(planCandidates(planInventory(root, stateDir, opsRead, new Set(["W1-T9"])), root), [], "reserved, not yet filed");
  assert.deepEqual(planCandidates(planInventory(root, stateDir, opsRead, new Set()), root).map((a) => a.target), ["OPS-T1"]);
  assert.deepEqual(planCandidates(planInventory(root, stateDir, opsRead, "unreadable"), root), []);
});

test("W1-T14642 criterion 2: the production reservation read lists every refs/rmd-id ref of origin and is unknown when origin cannot be read", async () => {
  const w = productionWorld({}, "acme/ops");
  const origin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t14642-origin-`));
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email, GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email } }).trim();
  run(origin, "init", "-q");
  run(origin, "commit", "-q", "--allow-empty", "-m", "x");
  const head = run(origin, "rev-parse", "HEAD");
  for (const id of ["W1-T9", "W1-T9B"]) run(origin, "update-ref", `refs/rmd-id/${id}`, head);
  run(w.repoRoot, "init", "-q");
  run(w.repoRoot, "remote", "add", "origin", origin);
  const rows: string[] = [];
  const seam = productionPlanGardenOps({ repoRoot: w.repoRoot, stateDir: w.stateDir, stateRoot: w.root, log: (s) => void rows.push(s) });
  assert.deepEqual([...(await seam.reservedIds!())!].sort(), ["W1-T9", "W1-T9B"]);
  run(w.repoRoot, "remote", "set-url", "origin", join(origin, "nowhere"));
  assert.equal(await seam.reservedIds!(), undefined);
  assert.deepEqual(rows, ["plan.reservations_unreadable"]);
});

test("W1-T14642 criterion 4: an unreadable ops catalog gardens the public catalog as before: no id is unknown, no ops record is touched", () => {
  const root = publicWorld([["W1-T1", {}]]);
  const unavailable = planInventory(root, join(root, "state"), { outcome: "unavailable", reason: "ops-unreadable" });
  assert.equal(unavailable.known, undefined);
  assert.deepEqual(planCandidates(unavailable, root), []);
  const recon = planInventory(root, join(root, "state"), queuedOps(["OPS-T1", { deps: ["GONE-T9"], type: "recon" }]));
  assert.deepEqual(planCandidates(recon, root), []);
});

test("W1-T14642 criterion 3: a blocked record with no retirement and no needs_input is an orphaned hold on the scorecard and never edited", () => {
  const root = publicWorld([["W1-T1", { status: "blocked" }], ["W1-T2", { status: "blocked", retirement: "closed" }], ["W1-T3", { status: "blocked", needsInput: true }]]);
  const inv = planInventory(root, join(root, "state"), queuedOps(["OPS-T1", { status: "blocked" }], ["OPS-T2", { status: "blocked", retirement: "retired" }], ["OPS-T3", { status: "blocked", needsInput: true }]));
  assert.deepEqual(orphanedHolds(inv), ["W1-T1", "OPS-T1"], "a retirement or a pending question is a hold with a way out");
  assert.deepEqual(planCandidates(inv, root), []);
  const spec = planGardenSpec({ stateDir: join(root, "state"), repoRoot: root, openWorkspace: () => { throw new Error("no workspace"); }, log: () => {} } as unknown as GardenerDeps);
  const card = spec.scorecard(inv, { actions: [], acting: [] } as never);
  assert.equal(card.orphanedHolds, 2);
  assert.deepEqual(card.orphanedHoldIds, ["W1-T1", "OPS-T1"]);
  assert.equal(card.opsTasks, 3);
});

test("W1-T14642 criterion 4: one landing never mixes catalogs: the public PR carries public paths and the ops landing ops paths", async () => {
  const root = publicWorld([["W1-T1", { status: "blocked", retirement: "retired" }], ["W1-T2", { deps: ["W1-T1"] }]]);
  const landed: Array<readonly { relPath: string; content: string }[]> = [];
  const seam: PlanGardenOps = { read: async () => queuedOps(["OPS-T1", { deps: ["W1-T1"] }]), land: (inputs) => void landed.push(inputs) };
  const deps = { stateDir: join(root, "state"), repoRoot: root, openWorkspace: () => { throw new Error("no workspace"); }, log: () => {} } as unknown as GardenerDeps;
  const spec = planGardenSpec(deps, seam);
  // A sync caller cannot await the read, so it sees the ops catalog as unreadable: no ops task is proposed.
  assert.deepEqual(spec.candidates(spec.inventory(), () => 0).map((a) => a.target), ["W1-T2"]);
  const inv = await spec.inventoryAsync!();
  const actions = spec.candidates(inv, () => 0);
  assert.deepEqual(actions.map((a) => a.target).sort(), ["OPS-T1", "W1-T2"]);
  const published = spec.apply({ root, land: () => undefined, dispose: () => {} }, { actions, acting: ["retire"] } as never, {}) as GardenLandOpts;
  assert.deepEqual(published.paths, ["plan/tasks.d/W1-T2-x.yaml"], "the public PR carries the public record only");
  assert.deepEqual(landed.map((l) => l.map((i) => i.relPath)), [["plan/tasks.d/OPS-T1-x.yaml"]]);
  assert.match(readFileSync(join(root, "plan/tasks.d/W1-T2-x.yaml"), "utf8"), /retirement: retired/);
  assert.equal(readFileSync(join(root, "plan/tasks.d/W1-T1-x.yaml"), "utf8").includes("plan gardener"), false);
});

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** A GET-only fake GitHub api serving `files` as the ops repository's plan folder at `commit`. */
function fakeOpsApi(repository: string, commit: string, files: Record<string, string>): OpsCatalogApi {
  const blobs = new Map<string, string>();
  const put = (s: string) => { const id = sha1(`blob ${Buffer.byteLength(s)}\0${s}`); blobs.set(id, s); return id; };
  const entry = (path: string, sha: string, type = "tree") => ({ path, sha, type, mode: type === "tree" ? "040000" : "100644" });
  const shardEntries = Object.entries(files).map(([name, s]) => entry(name, put(s), "blob"));
  const rootBlob = put("[]\n");
  const tree = sha1(`${commit}root`), plan = sha1(`${commit}plan`), shardTree = sha1(`${commit}shards`);
  const prefix = `repos/${repository}`;
  return async (path) => {
    if (path === prefix) return { id: 42, full_name: repository, default_branch: "main" };
    if (path === `${prefix}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${prefix}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${prefix}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [entry("plan", plan)] };
    if (path === `${prefix}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [entry("tasks.yaml", rootBlob, "blob"), entry("tasks.d", shardTree)] };
    if (path === `${prefix}/git/trees/${shardTree}`) return { sha: shardTree, truncated: false, tree: shardEntries };
    const sha = path.slice(`${prefix}/git/blobs/`.length), s = blobs.get(sha);
    assert.ok(path.startsWith(`${prefix}/git/blobs/`) && s !== undefined, `only recorded GET routes are permitted: ${path}`);
    return { sha, encoding: "base64", size: Buffer.byteLength(s), content: Buffer.from(s).toString("base64") };
  };
}

/** `<root>/state`, an empty public plan, and a real ops checkout at `<root>/repos/ops` holding `files` committed. */
function productionWorld(files: Record<string, string>, destination?: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t14642-prod-`));
  mkdirSync(join(root, "state"));
  const repoRoot = join(root, "public");
  mkdirSync(join(repoRoot, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repoRoot, "plan", "tasks.yaml"), "[]\n");
  const ops = join(root, "repos", "ops");
  mkdirSync(join(ops, "plan", "tasks.d"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(ops, "plan", "tasks.d", name), text);
  const git = (...args: string[]) => execFileSync("git", ["-C", ops, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email, GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email },
  }).trim();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "the ops catalog");
  if (destination !== undefined) writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify({ repository: destination, kinds: ["task"] }));
  return { root, repoRoot, stateDir: join(root, "state"), commit: git("rev-parse", "HEAD") };
}

test("W1-T14642 criterion 1: the production read pins the ops catalog, reads each record's bytes at the pin and is off without a destination", async () => {
  const files = { "OPS-T1-x.yaml": shardText("OPS-T1", { deps: ["GONE-T9"] }), "OPS-T2-x.yaml": shardText("OPS-T2") + shardText("OPS-T3") };
  const w = productionWorld(files, "acme/ops");
  const logs: string[] = [];
  const seam = productionPlanGardenOps({ repoRoot: w.repoRoot, stateDir: w.stateDir, stateRoot: w.root, log: (s) => void logs.push(s), api: fakeOpsApi("acme/ops", w.commit, files) });
  const read = await seam.read();
  assert.equal(read.outcome, "ok");
  if (read.outcome !== "ok") return;
  assert.deepEqual(read.tasks.map((t) => t.id).sort(), ["OPS-T1", "OPS-T2", "OPS-T3"]);
  assert.deepEqual([...read.shards.keys()], ["OPS-T1"], "a file holding two records is never edited");
  assert.equal(read.sources.get("plan/tasks.d/OPS-T1-x.yaml"), files["OPS-T1-x.yaml"]);
  const none = productionWorld(files);
  const off = await productionPlanGardenOps({ repoRoot: none.repoRoot, stateDir: none.stateDir, stateRoot: none.root, log: () => {} }).read();
  assert.deepEqual(off, { outcome: "off" });
  writeFileSync(join(none.stateDir, "plan-destination.json"), "not json");
  const unreadable = await productionPlanGardenOps({ repoRoot: none.repoRoot, stateDir: none.stateDir, stateRoot: none.root, log: () => {} }).read();
  assert.deepEqual(unreadable, { outcome: "unavailable", reason: "plan-destination-unreadable" });
});

test("W1-T14642 criterion 1: an ops catalog the api cannot serve is unavailable, never an empty catalog", async () => {
  const w = productionWorld({}, "acme/ops");
  const refusing: OpsCatalogApi = async () => { throw new Error("offline"); };
  const read = await productionPlanGardenOps({ repoRoot: w.repoRoot, stateDir: w.stateDir, stateRoot: w.root, log: () => {}, api: refusing }).read();
  assert.equal(read.outcome, "unavailable");
});

test("W1-T14642 criterion 1: the production ops landing goes to the plan destination's checkout and its outcome is logged", async () => {
  const w = productionWorld({}, "acme/ops");
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const calls: Array<{ root: string; paths: string[]; target: unknown; stateRoot: string }> = [];
  const seam = productionPlanGardenOps({
    repoRoot: w.repoRoot, stateDir: w.stateDir, stateRoot: w.root, log: (s, f) => void rows.push([s, f]),
    landTaskFiles: async (root, inputs, opts) => {
      calls.push({ root, paths: inputs.map((i) => i.relPath), target: opts.targetRepository, stateRoot: opts.stateRoot });
      return { prUrl: "https://github.com/acme/ops/pull/5", landed: inputs.map((i) => i.relPath), waiting: [], refused: [], setAside: [], pushed: true };
    },
  });
  seam.land([{ relPath: "plan/tasks.d/OPS-T1-x.yaml", content: "x", claim: "c", proof: "grep: x in plan/tasks.d/OPS-T1-x.yaml" }]);
  await seam.settled();
  assert.deepEqual(calls, [{ root: join(w.root, "repos", "ops"), paths: ["plan/tasks.d/OPS-T1-x.yaml"], target: { owner: "acme", repo: "ops" }, stateRoot: w.root }]);
  assert.deepEqual(rows.map(([s]) => s), ["plan.ops_landing"]);
  assert.equal(rows[0]![1]!.pr_url, "https://github.com/acme/ops/pull/5");
});

test("W1-T14642 criterion 2: a failed ops landing is logged and the pass's wait never throws; no destination lands nothing", async () => {
  const w = productionWorld({}, "acme/ops");
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const input = { relPath: "plan/tasks.d/OPS-T1-x.yaml", content: "x", claim: "c", proof: "grep: x in y" };
  const failing = productionPlanGardenOps({ repoRoot: w.repoRoot, stateDir: w.stateDir, stateRoot: w.root, log: (s, f) => void rows.push([s, f]), landTaskFiles: async () => { throw new Error("push refused"); } });
  failing.land([input]);
  await failing.settled();
  assert.deepEqual(rows.map(([s]) => s), ["plan.ops_landing_failed"]);
  assert.equal(rows[0]![1]!.error, "push refused");
  const none = productionWorld({});
  const skipped: string[] = [];
  const idle = productionPlanGardenOps({ repoRoot: none.repoRoot, stateDir: none.stateDir, stateRoot: none.root, log: (s) => void skipped.push(s), landTaskFiles: async () => { throw new Error("never called"); } });
  idle.land([input]);
  await idle.settled();
  assert.deepEqual(skipped, ["plan.ops_landing_skipped"]);
});
