import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ghPrCreateFillCommandAsync, runTask } from "#src/run-task.js";
import { buildIntoStore, childEntryStoreRoot } from "#src/lib/child-entry-store.js";
import { planPrPreflight, planPrPreflightAsync } from "#src/lib/plan-pr-emitter.js";
import { checkProofLaunchArgv, defaultProofRunner } from "#src/lib/pr-open.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/check-proof-main.ts";
type Row = Record<string, unknown>;
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const ledger = (root: string): Row[] => {
  const path = join(root, "state/ledger.ndjson");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Row) : [];
};
const record = () => {
  const rows: Row[] = [];
  return { rows, log: (step: string, extra?: Row) => { rows.push({ step, ...extra }); } };
};

/** Real build script and esbuild, with small entries whose actual launch reports its Node argv. */
function populate(tree: string): void {
  mkdirSync(join(tree, "scripts"), { recursive: true });
  mkdirSync(join(tree, "src"), { recursive: true });
  copyFileSync(join(REPO, "scripts/build-child-entries.mjs"), join(tree, "scripts/build-child-entries.mjs"));
  for (const name of ["package.json", "package-lock.json"]) copyFileSync(join(REPO, name), join(tree, name));
  writeFileSync(join(tree, ENTRY), 'console.log(JSON.stringify({ marker: "W1-T9374-BUNDLE", execArgv: process.execArgv, args: process.argv.slice(2) }));\n');
  writeFileSync(join(tree, "src/run-task.ts"), 'export const fixture = "run-task";\n');
  writeFileSync(join(tree, "src/run-child-main.ts"), 'export const fixture = "run-child";\n');
}
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-store-fill-tree-"));
  populate(root);
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}
function fresh(from: string): string {
  const root = tree();
  assert.equal(readFileSync(join(root, ENTRY), "utf8"), readFileSync(join(from, ENTRY), "utf8"));
  assert.equal(existsSync(join(root, "dist")), false);
  return root;
}
const remove = (...dirs: string[]) => dirs.forEach(d => rmSync(d, { recursive: true, force: true }));

const body = "Acceptance:\n- the fixture proof executes | grep: W1-T9374-BUNDLE in src/check-proof-main.ts\n";
const quietChecks = {
  lintPlan: () => ({ status: 0, output: "fixture lint" }),
  taskIdExistence: () => ({ status: 0, output: "fixture task ids" }),
  shardCensus: () => ({ status: 0, output: "fixture census" }),
};

const quietChecksAsync = {
  lintPlan: async () => quietChecks.lintPlan(),
  taskIdExistence: async () => quietChecks.taskIdExistence(),
  shardCensus: async () => quietChecks.shardCensus(),
};

test("W1-T9374: an unborrowed managed checkout still fills the store from the run worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-store-fill-run-"));
  const origin = gitRepo({ bare: true, kind: "store-fill-origin" });
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "-q", origin.dir, seed], { stdio: "pipe" });
  git(seed, "config", "user.name", "store-fill-fixture");
  git(seed, "config", "user.email", "store-fill@example.invalid");
  writeFileSync(join(seed, ".gitignore"), "node_modules/\ndist/\n");
  for (const name of ["package.json", "package-lock.json"]) copyFileSync(join(REPO, name), join(seed, name));
  git(seed, "add", "-A"); git(seed, "commit", "-qm", "old managed source"); git(seed, "push", "-q", "origin", "main");
  const managed = join(root, "repos/remudero");
  mkdirSync(dirname(managed), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, managed], { stdio: "pipe" });
  git(managed, "config", "user.name", "store-fill-fixture"); git(managed, "config", "user.email", "store-fill@example.invalid");
  populate(seed);
  git(seed, "add", "-A"); git(seed, "commit", "-qm", "fresh main build source"); git(seed, "push", "-q", "origin", "main");
  assert.equal(existsSync(join(managed, "node_modules")), false, "the managed tree has no borrowed install");
  assert.equal(existsSync(join(managed, "scripts/build-child-entries.mjs")), false, "the managed tree still carries the older source");
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, '- id: T-STORE-FILL\n  title: fixture store fill\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  files: [src/check-proof-main.ts]\n  origin: test\n  status: queued\n');
  let spawnSeen = false;
  let dispatchError: unknown;
  try {
    await withLiveWritesAllowed(() => runTask("T-STORE-FILL", {
      skipGitSync: true, planPath,
      config: { root, installRoot: REPO, claudeBin: "/bin/true" },
      github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
      claimReserver: { mintAnchor: () => "store-fill-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
      containmentExec: async token => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
      isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
      spawn: async () => {
        spawnSeen = true;
        if (ledger(root).some(r => r.step === "child_entry.store_build_requested")) {
          const until = Date.now() + 30_000;
          while (!ledger(root).some(r => r.step === "child_entry.store_built" || r.step === "child_entry.store_build_failed") && Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
        throw new Error("fixture stops before any provider work");
      },
    }));
  } catch (error) {
    dispatchError = error;
  }
  try {
    const rows = ledger(root);
    const request = rows.find(r => r.step === "child_entry.store_build_requested" && r.checkout_kind === "unborrowed");
    assert.ok(request, `unborrowed run requested a build; error=${String(dispatchError)}; rows=${JSON.stringify(rows.filter(r => /worktree|store|refresh/.test(String(r.step))))}`);
    assert.equal(request.source, "run-worktree");
    assert.notEqual(request.tree, managed);
    assert.ok(rows.some(r => r.step === "worktree.add"), "the real add and install borrowing completed");
    assert.ok(rows.some(r => r.step === "child_entry.store_built"), `real child build completed: ${JSON.stringify(rows.filter(r => /store/.test(String(r.step))))}`);
    assert.ok(existsSync(childEntryStoreRoot(root)), "the instance store was populated");
    assert.equal(spawnSeen, true, "the fixture worker reached the run boundary");
    assert.equal(existsSync(join(managed, "dist")), false, "the old managed tree was not written");
  } finally { origin.cleanup(); remove(root); }
});

test("W1-T9374: every store build outcome is ledgered", async () => {
  const main = tree(), store = mkdtempSync(join(tmpdir(), "rmd-store-fill-root-"));
  const absent = mkdtempSync(join(tmpdir(), "rmd-store-fill-absent-")), failed = tree();
  const r = record();
  try {
    assert.equal((await buildIntoStore(main, { storeRoot: store, log: r.log })).kind, "built");
    assert.equal((await buildIntoStore(main, { storeRoot: store, log: r.log })).kind, "present");
    assert.equal((await buildIntoStore(absent, { storeRoot: store, log: r.log })).kind, "skipped");
    writeFileSync(join(failed, "scripts/build-child-entries.mjs"), 'throw new Error("fixture build failure");\n');
    assert.equal((await buildIntoStore(failed, { storeRoot: store, log: r.log })).kind, "failed");
    for (const step of ["child_entry.store_built", "child_entry.store_present", "child_entry.store_build_skipped", "child_entry.store_build_failed"]) {
      const row = r.rows.find(r => r.step === step);
      assert.ok(row, `${step} was recorded`);
      assert.equal(typeof row.reason, "string", `${step} names its outcome reason`);
    }
  } finally { remove(main, store, absent, failed); }
});

test("W1-T9374: the check-proof callers ledger the store answer and launch kind", async () => {
  const main = tree(), store = mkdtempSync(join(tmpdir(), "rmd-store-fill-callers-"));
  const planTree = fresh(main), prTree = fresh(main), missTree = fresh(main);
  try {
    assert.equal((await buildIntoStore(main, { storeRoot: store })).kind, "built");
    const plan = record();
    assert.equal(planPrPreflight({ cwd: planTree, title: "chore(plan): fixture", body }, { ...quietChecks, log: plan.log, storeRoot: store }).ok, true);
    assert.ok(plan.rows.some(r => r.step === "child_entry.store_hit"));
    assert.ok(plan.rows.some(r => r.step === "plan_pr.check_proof_child" && r.kind === "bundle" && r.reason === "store-hit"));
    const pr = record();
    const argv = checkProofLaunchArgv("fixture-proof", "fixture-base", prTree, [], { root: store, log: pr.log });
    const run = spawnSync(process.execPath, argv, { cwd: prTree, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).marker, "W1-T9374-BUNDLE");
    assert.ok(pr.rows.some(r => r.step === "child_entry.store_hit"));
    assert.ok(pr.rows.some(r => r.step === "pr_open.check_proof_child" && r.kind === "bundle" && r.reason === "store-hit"));
    const miss = record();
    writeFileSync(join(missTree, "src/changed.ts"), "export const changed = true;\n");
    checkProofLaunchArgv("fixture-proof", "fixture-base", missTree, [], { root: store, log: miss.log });
    assert.ok(miss.rows.some(r => r.step === "child_entry.store_miss" && r.reason === "no-stored-build"));
    assert.ok(miss.rows.some(r => r.step === "pr_open.check_proof_child" && r.kind === "tsx"));
  } finally { remove(main, store, planTree, prTree, missTree); }
});

test("W1-T9374: a filled store makes a fresh preflight tree launch the bundle", async () => {
  const main = tree(), store = mkdtempSync(join(tmpdir(), "rmd-store-fill-preflight-")), preflight = fresh(main), pr = fresh(main);
  try {
    assert.equal((await buildIntoStore(main, { storeRoot: store })).kind, "built");
    const log = record();
    const answer = await planPrPreflightAsync({ cwd: preflight, title: "chore(plan): fixture", body }, { ...quietChecksAsync, log: log.log, storeRoot: store });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.ok(log.rows.some(r => r.step === "plan_pr.check_proof_child" && r.kind === "bundle"));
    const proof = defaultProofRunner("fixture-proof", "fixture-base", pr, undefined, process.execPath, pr, { root: store, log: log.log });
    assert.equal(proof.status, 0, proof.stderr);
    const ran = JSON.parse(String(proof.stdout));
    assert.equal(ran.marker, "W1-T9374-BUNDLE");
    assert.deepEqual(ran.execArgv, [], "actual child used plain Node with no tsx loader");
    assert.deepEqual(ran.args, ["fixture-proof", "--base", "fixture-base"]);
  } finally { remove(main, store, preflight, pr); }
});


test("W1-T9374: the PR opener forwards its lane log to the default proof runner", async () => {
  const origin = gitRepo({ bare: true, kind: "store-fill-proof-origin" });
  const root = mkdtempSync(join(tmpdir(), "rmd-store-fill-proof-"));
  try {
    execFileSync("git", ["clone", "-q", origin.dir, root], { stdio: "pipe" });
    git(root, "config", "user.name", "store-fill-fixture");
    git(root, "config", "user.email", "store-fill@example.invalid");
    mkdirSync(join(root, "plan")); mkdirSync(join(root, "src"));
    writeFileSync(join(root, "plan/tasks.yaml"), '- id: W1-T99997\n  title: fixture proof logger\n  repo: remudero\n  type: implement\n  verify: auto\n  status: queued\n  files: [src/marker.ts]\n  acceptance:\n    - claim: the marker is added\n      proof: "grep: STORE-FILL-HEAD-MARKER in src/marker.ts"\n');
    writeFileSync(join(root, "src/marker.ts"), "export const before = true;\n");
    git(root, "add", "-A"); git(root, "commit", "-qm", "chore(plan): file fixture"); git(root, "push", "-q", "origin", "main");
    writeFileSync(join(root, "src/marker.ts"), "export const marker = 'STORE-FILL-HEAD-MARKER';\n");
    git(root, "commit", "-qam", "feat(core): add fixture marker");
    const r = record();
    const emptyStore = join(root, "empty-store");
    mkdirSync(emptyStore);
    const command = await withLiveWritesAllowed(() => ghPrCreateFillCommandAsync(root, "craigoley", "remudero", "run-W1-T99997-1700000000000", undefined, undefined, false, { root: emptyStore, log: r.log }));
    assert.equal(command.command, "gh", "the guarded builder returns argv, without creating a real PR");
    assert.ok(r.rows.some(row => row.step === "child_entry.store_miss"), JSON.stringify(r.rows));
    assert.ok(r.rows.some(row => row.step === "pr_open.check_proof_child" && row.kind === "tsx"), JSON.stringify(r.rows));
  } finally { origin.cleanup(); remove(root); }
});
