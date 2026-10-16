// W1-T9092 (ADR 0007 B.1/B.2) — THE DAEMON IS STALE ONLY WHEN CODE ITS OWN PROCESS LOADS CHANGED. The prefix list in
// `advanceIsMaterial` called every src/ change material; the closure of the process's entry is the measured version.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";
import {
  daemonClosureGit, daemonProcessClosure, daemonProcessEntry, withDaemonClosure, type ClosureGit,
} from "../src/lib/daemon-closure.js";
import { daemonFreshnessFromService, type ServiceFreshness } from "../src/lib/self-sync.js";
import { runDaemon, type DaemonFreshness } from "../src/lib/daemon.js";
import { FRESHNESS_DECISION_STEP } from "../src/lib/deploy-judge.js";
import { loadPlan } from "../src/lib/plan.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/entry.ts";

/** A tree whose entry imports one module; `src/lib/unloaded.ts` is imported by nothing. */
function seedTree(): GitRepo {
  const tree = gitRepo({ kind: "w1-t9092" });
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(tree.dir, path)), { recursive: true });
    writeFileSync(join(tree.dir, path), text);
  };
  put(ENTRY, `import { loaded } from "./lib/loaded.js";\nexport const run = () => loaded();\n`);
  put("src/lib/loaded.ts", [
    `import { readFileSync } from "node:fs";`,
    `import { join } from "node:path";`,
    `export const loaded = (root = ".") => readFileSync(join(root, "openapi", "daemon.yaml"), "utf8");`,
    "",
  ].join("\n"));
  put("src/lib/unloaded.ts", "export const unloaded = 1;\n");
  put("openapi/daemon.yaml", "openapi: 3.1.0\n");
  put("openapi/unread.yaml", "openapi: 3.1.0\n");
  put("docs/guide.md", "# guide\n");
  put("package.json", "{}\n");
  // A unique tree, so no two fixtures share a sha (and with it a memoized closure).
  put("README.md", `${process.pid} ${Math.random()}\n`);
  tree.git("add", ".");
  tree.git("commit", "--quiet", "-m", "seed");
  return tree;
}

function advance(tree: GitRepo, path: string): { oldSha: string; newSha: string } {
  const oldSha = tree.git("rev-parse", "HEAD");
  writeFileSync(join(tree.dir, path), `// changed\n${Date.now()}\n`, { flag: "a" });
  tree.git("commit", "--quiet", "-am", `change ${path}`);
  return { oldSha, newSha: tree.git("rev-parse", "HEAD") };
}

const behind = (shas: { oldSha: string; newSha: string }, changedPaths: string[]): ServiceFreshness =>
  ({ status: "assessed", dirty: false, behind: { ...shas, changedPaths } });

/** `entry: null` is a process whose entry is no path in the repository. */
async function judged(tree: GitRepo, path: string, gitText: ClosureGit = daemonClosureGit(tree.dir), entry: string | null = ENTRY) {
  const shas = advance(tree, path);
  const svc = await withDaemonClosure(behind(shas, [path]), (sha) => daemonProcessClosure(gitText, sha, entry ?? undefined));
  return daemonFreshnessFromService(svc);
}

/** Drive the real daemon loop on one freshness reading and return its ledger rows. */
async function daemonRows(freshness: DaemonFreshness): Promise<Array<{ step: string; data: Record<string, unknown> }>> {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9092-state-`));
  writeFileSync(join(stateDir, "tasks.yaml"), "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  const logs: Array<{ step: string; data: Record<string, unknown> }> = [];
  let ticks = 0;
  try {
    await runDaemon(loadPlan(join(stateDir, "tasks.yaml")), {
      refreshMerged: () => () => true,
      runOne: async (id) => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }),
      sleep: async () => {},
      log: (step, data = {}) => logs.push({ step, data }),
      checkFreshness: () => freshness,
      checkStop: () => (++ticks >= 3 ? (requestStop(stateDir, "test done"), stopDetail(stateDir)) : undefined),
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
  return logs;
}

test("W1-T9092: a change outside the daemon closure starts no staleness clock", async () => {
  const tree = seedTree();
  // The prefix list alone calls this advance material: the src/ module no closure module imports.
  const outside = await judged(tree, "src/lib/unloaded.ts");
  assert.equal(outside.stale, false, "a module the process never loads is no reason to replace it");
  assert.deepEqual(!outside.stale && outside.notStale, {
    arm: "immaterial", oldSha: tree.git("rev-parse", "HEAD~1"), newSha: tree.git("rev-parse", "HEAD"),
    basis: "closure", outsideClosure: 1,
  });
  const rows = await daemonRows(outside);
  assert.equal(rows.filter((row) => row.step === FRESHNESS_DECISION_STEP).length, 0, "no decision: the clock never started");
  const notStale = rows.find((row) => row.step === "daemon.freshness_not_stale");
  assert.equal(notStale?.data.arm, "immaterial");
  assert.equal(notStale?.data.basis, "closure");
  assert.equal(notStale?.data.outside_closure, 1);

  // The control: a module the entry imports is material, and the same loop scores it.
  const inside = await judged(tree, "src/lib/loaded.ts");
  assert.equal(inside.stale, true, "a closure module still restarts the daemon");
  const insideRows = await daemonRows(inside);
  assert.ok(insideRows.some((row) => row.step === FRESHNESS_DECISION_STEP), "a material advance reaches the decision");
  tree.cleanup();
});

test("W1-T9092: a data file a closure module reads is material", async () => {
  const tree = seedTree();
  // openapi/ is outside the prefix list; src/lib/loaded.ts reads this file at runtime.
  const read = await judged(tree, "openapi/daemon.yaml");
  assert.equal(read.stale, true, "a data file the closure reads changes what the process does");
  const unread = await judged(tree, "openapi/unread.yaml");
  assert.equal(unread.stale, false);
  assert.equal(!unread.stale && unread.notStale?.arm, "immaterial");
  // The root files decide how the closure resolves, whatever it imports.
  assert.equal((await judged(tree, "package.json")).stale, true);
  tree.cleanup();
});

test("W1-T9092: an unreadable closure is material", async () => {
  const tree = seedTree();
  const failing: ClosureGit = async () => { throw new Error("git grep died"); };
  // The module no closure module imports is material again once the closure cannot be read.
  const unread = await judged(tree, "src/lib/unloaded.ts", failing);
  assert.equal(unread.stale, true, "an unread closure fails toward restarting");
  // An entry that is not a path in the tree is unreadable too.
  assert.equal((await judged(tree, "src/lib/unloaded.ts", daemonClosureGit(tree.dir), "src/gone.ts")).stale, true);
  assert.equal((await judged(tree, "src/lib/unloaded.ts", daemonClosureGit(tree.dir), null)).stale, true);
  // Unreadable falls back to the prefix list rather than restarting for advances today's daemon already ignores,
  // and says why on the ledger row.
  const docs = await judged(tree, "docs/guide.md", failing);
  assert.equal(docs.stale, false);
  assert.equal(!docs.stale && docs.notStale?.arm, "immaterial");
  assert.equal(!docs.stale && docs.notStale?.arm === "immaterial" && docs.notStale.basis, "prefix");
  assert.match(String(!docs.stale && docs.notStale?.arm === "immaterial" && docs.notStale.closureUnreadable), /git grep died/);
  const rows = await daemonRows(docs);
  assert.match(String(rows.find((row) => row.step === "daemon.freshness_not_stale")?.data.closure_unreadable), /git grep died/);
  tree.cleanup();
});

test("W1-T9092: the closure is memoized per sha and entry, and a failed read is retried", async () => {
  const tree = seedTree();
  const sha = tree.git("rev-parse", "HEAD");
  const real = daemonClosureGit(tree.dir);
  let calls = 0;
  const counting: ClosureGit = async (args) => { calls += 1; return real(args); };
  const first = await daemonProcessClosure(counting, sha, ENTRY);
  assert.equal(first.status, "read");
  assert.deepEqual(first.status === "read" && [...first.paths].sort(),
    ["openapi/daemon.yaml", "package.json", "src/entry.ts", "src/lib/loaded.ts"]);
  const readCalls = calls;
  assert.ok(readCalls > 0);
  assert.equal(await daemonProcessClosure(counting, sha, ENTRY), first, "the same (sha, entry) is read once");
  assert.equal(calls, readCalls);

  let failures = 0;
  const flaky: ClosureGit = async (args) => {
    if (failures === 0) {
      failures += 1;
      throw new Error("transient");
    }
    return real(args);
  };
  const leaf = "src/lib/unloaded.ts"; // an entry with no edge line of its own is a leaf
  assert.equal((await daemonProcessClosure(flaky, sha, leaf)).status, "unreadable");
  const retried = await daemonProcessClosure(flaky, sha, leaf);
  assert.deepEqual(retried.status === "read" && [...retried.paths].sort(), ["package.json", "src/lib/unloaded.ts"]);
  tree.cleanup();
});

test("W1-T9092: a tree with no edge line is read, and a grep that fails is unreadable", async () => {
  const tree = gitRepo({ kind: "w1-t9092-bare-tree" });
  mkdirSync(join(tree.dir, "src"), { recursive: true });
  writeFileSync(join(tree.dir, "src", "only.ts"), `export const only = "${process.pid} ${Math.random()}";\n`);
  tree.git("add", ".");
  tree.git("commit", "--quiet", "-m", "seed");
  const sha = tree.git("rev-parse", "HEAD");
  const real = daemonClosureGit(tree.dir);
  // git grep exits 1 when nothing matches: no edges, not an unreadable tree.
  const read = await daemonProcessClosure(real, sha, "src/only.ts");
  assert.deepEqual(read.status === "read" && [...read.paths], ["src/only.ts"]);
  const grepDies: ClosureGit = async (args) => {
    if (args[0] === "grep") throw Object.assign(new Error("fatal: bad object"), { code: 128 });
    return real(args);
  };
  const failed = await daemonProcessClosure(grepDies, `${sha}`, "src/other.ts");
  assert.equal(failed.status, "unreadable", "an entry the tree lacks is unreadable before git grep runs");
  writeFileSync(join(tree.dir, "src", "other.ts"), "export const other = 2;\n");
  tree.git("add", ".");
  tree.git("commit", "--quiet", "-m", "other");
  const next = tree.git("rev-parse", "HEAD");
  const died = await daemonProcessClosure(grepDies, next, "src/other.ts");
  assert.equal(died.status, "unreadable");
  assert.match(died.status === "unreadable" ? died.reason : "", /bad object/);
  tree.cleanup();
});

test("W1-T9092: the process entry is its argv[1] relative to the repository", () => {
  const tree = seedTree();
  const link = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9092-link-`));
  symlinkSync(tree.dir, join(link, "tree"));
  assert.equal(daemonProcessEntry(join(link, "tree"), join(tree.dir, ENTRY)), ENTRY, "a symlinked root resolves");
  assert.equal(daemonProcessEntry(tree.dir, join(link, "elsewhere.ts")), undefined, "a missing file is no entry");
  assert.equal(daemonProcessEntry(tree.dir, link), undefined, "a path outside the repository is no entry");
  assert.equal(daemonProcessEntry(tree.dir, tree.dir), undefined);
  assert.equal(daemonProcessEntry(tree.dir, undefined), undefined);
  rmSync(link, { recursive: true, force: true });
  tree.cleanup();
});

test("W1-T9092: the closure contains every metafile input", async () => {
  // The oracle: esbuild bundles the daemon's real entry and lists each module it loads. The closure, read from HEAD
  // by git alone, must hold all of them, or a change to a loaded module would read as immaterial.
  const entry = "src/run-task.ts";
  const esbuild = createRequire(join(ROOT, "package.json"))("esbuild") as {
    build(options: Record<string, unknown>): Promise<{ metafile: { inputs: Record<string, unknown> } }>;
  };
  const built = await esbuild.build({
    entryPoints: [entry], absWorkingDir: ROOT, bundle: true, platform: "node", format: "esm", packages: "external",
    write: false, metafile: true, logLevel: "silent",
  });
  const inputs = Object.keys(built.metafile.inputs);
  assert.ok(inputs.includes(entry) && inputs.length > 100, `the oracle must list the entry's graph, got ${inputs.length} inputs`);
  const closure = await daemonProcessClosure(daemonClosureGit(ROOT), "HEAD", entry);
  assert.equal(closure.status, "read", closure.status === "unreadable" ? closure.reason : "");
  const missing = inputs.filter((input) => closure.status === "read" && !closure.paths.has(input));
  assert.deepEqual(missing, [], "every module esbuild bundles is in the closure");
});
