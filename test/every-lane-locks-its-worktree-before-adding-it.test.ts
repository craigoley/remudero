// test/every-lane-locks-its-worktree-before-adding-it.test.ts — W1-T5356: W1-T5280 wrote the implement
// lane's run lock before its add, but approve, approve-batch, `addLaneWorktree` (retro/triage/plan) and
// `createDaemonLaneWorktree` still added first and locked after. `pruneStaleRuns` protects a lockless
// `run-*` worktree only for `pruneGraceMs` after its mtime, and an approve runs in its OWN pid, so a
// prune in another process could reach an add slower than the grace and force-remove it.
//
// THE MID-ADD PRUNE IS A REAL ONE, IN A REAL OTHER PROCESS. The managed checkout carries a
// `post-checkout` hook, which `git worktree add` runs once the new worktree is registered and checked
// out but before the add returns. The hook spawns `node`, which calls the real `pruneStaleRuns` with its
// clock ten minutes past the directory's mtime (past the grace, the only thing guarding a lockless
// path) and records what it saw. The run lock names THIS test process's pid, which is alive.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import * as runTaskModule from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TASK_SRC = join(REPO_ROOT, "src", "run-task.ts");
type Row = Record<string, unknown>;
type Log = (step: string, extra?: Record<string, unknown>) => void;

/** What the other process's prune saw, written by the hook. */
interface MidAdd {
  registered: string[];
  lockPresent: boolean;
  summary: { worktrees: string[]; skipped: string[] };
}

/** The hook's node half: one prune, recorded once, from a process that is not the test's. */
const PRUNE_SCRIPT = `
import { execFileSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
const [repoDir, worktreesRoot, workerUrl, out] = process.argv.slice(2);
if (!existsSync(out)) {
  const { pruneStaleRuns, DEFAULT_PRUNE_GRACE_MS } = await import(workerUrl);
  const registered = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\\n")
    .filter((line) => line.startsWith("worktree ") && line.includes(worktreesRoot + "/run-"))
    .map((line) => line.slice("worktree ".length));
  const lockPresent = registered.length === 1 && existsSync(registered[0] + ".lock");
  const aged = registered.length === 1 ? statSync(registered[0]).mtimeMs + 10 * 60_000 : 0;
  const summary = pruneStaleRuns(repoDir, worktreesRoot, { graceMs: DEFAULT_PRUNE_GRACE_MS, now: () => aged });
  writeFileSync(out, JSON.stringify({ registered, lockPresent, summary }));
}
`;

const sq = (s: string): string => `'${s.replaceAll("'", `'"'"'`)}'`;

/** Install the post-checkout hook on `repoDir`. `exit` is the hook's status: 1 fails the add after the
 *  worktree exists, so a test can watch a failed add's lock handling. */
function installMidAddPrune(repoDir: string, worktreesRoot: string, scratch: string, exit = 0): string {
  const out = join(scratch, "mid-add.json");
  const script = join(scratch, "mid-add-prune.mjs");
  writeFileSync(script, PRUNE_SCRIPT);
  const hooks = join(scratch, "hooks");
  mkdirSync(hooks, { recursive: true });
  const tsx = import.meta.resolve("tsx");
  const worker = new URL("../src/lib/worker.ts", import.meta.url).href;
  writeFileSync(
    join(hooks, "post-checkout"),
    [
      "#!/bin/sh",
      `env -u NODE_TEST_CONTEXT -u NODE_OPTIONS node --import ${sq(tsx)} ${sq(script)} ${sq(repoDir)} ${sq(worktreesRoot)} ${sq(worker)} ${sq(out)} >> ${sq(join(scratch, "hook.log"))} 2>&1`,
      `exit ${exit}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  execFileSync("git", ["-C", repoDir, "config", "core.hooksPath", hooks]);
  return out;
}

function readMidAdd(out: string, scratch: string): MidAdd {
  const log = join(scratch, "hook.log");
  assert.ok(existsSync(out), `the mid-add prune fired; hook log: ${existsSync(log) ? readFileSync(log, "utf8") : "(none)"}`);
  return JSON.parse(readFileSync(out, "utf8")) as MidAdd;
}

function assertSkippedMidAdd(mid: MidAdd): void {
  assert.equal(mid.registered.length, 1, `exactly the lane's worktree is registered mid-add: ${JSON.stringify(mid.registered)}`);
  assert.equal(mid.lockPresent, true, "the run lock is on disk while the add is still in flight");
  assert.deepEqual(mid.summary.worktrees, [], "the other process's prune removed nothing");
  assert.ok(mid.summary.skipped.includes(mid.registered[0]!), "the prune names the in-flight worktree as live");
}

const runLocks = (worktreesRoot: string): string[] =>
  existsSync(worktreesRoot) ? readdirSync(worktreesRoot).filter((name) => name.endsWith(".lock")) : [];

/** A bare origin with one commit, and a managed checkout of it at `<root>/repos/<repo>`. */
function managedFixture(kind: string, seed: (dir: string) => void = () => {}) {
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  const seedRepo = gitRepo({ kind: `${kind}-seed` });
  seed(seedRepo.dir);
  seedRepo.git("add", "-A");
  seedRepo.git("commit", "--quiet", "--allow-empty", "-m", "chore: seed");
  seedRepo.addRemote("origin", origin.dir);
  seedRepo.git("push", "--quiet", "origin", "main");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-root-`));
  const remoteUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
  const repoDir = join(root, "repos", remoteUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2]!);
  mkdirSync(dirname(repoDir), { recursive: true });
  execFileSync("git", ["clone", "--quiet", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email]);
  const scratch = join(root, "scratch");
  mkdirSync(scratch);
  return { root, repoDir, scratch, worktreesRoot: join(root, "worktrees") };
}

function recordingLog(): { log: Log; rows: Row[] } {
  const rows: Row[] = [];
  return { log: (step, extra = {}) => void rows.push({ step, ...extra }), rows };
}

/** The two non-approve lanes, read off the module namespace. */
type LaneAdd = (repoDir: string, worktreesRoot: string, runId: string, log: Log) => { branch: string; worktreePath: string };
const LANES: Array<[string, LaneAdd]> = [
  ["addLaneWorktree", runTaskModule.addLaneWorktree],
  ["createDaemonLaneWorktree", runTaskModule.createDaemonLaneWorktree],
];

for (const [name, laneAdd] of LANES) {
  test(`W1-T5356: a prune from another process during ${name}'s add skips the path, and the add completes locked`, () => {
    const fx = managedFixture("t5356-lane");
    const out = installMidAddPrune(fx.repoDir, fx.worktreesRoot, fx.scratch);
    const { log, rows } = recordingLog();
    const { worktreePath } = laneAdd(fx.repoDir, fx.worktreesRoot, "W1-T5356-1", log);
    assertSkippedMidAdd(readMidAdd(out, fx.scratch));
    assert.equal(rows.find((row) => row.step === "worktree.add_failed"), undefined, "the add was not cut out from under itself");
    assert.ok(existsSync(join(worktreePath, ".git")), "the worktree survived its add");
    const lock = JSON.parse(readFileSync(`${worktreePath}.lock`, "utf8")) as Row;
    assert.equal(lock.pid, process.pid, "the lane still holds its run lock after the add");
    assert.equal(lock.run_id, "W1-T5356-1");
  });

  test(`W1-T5356: a failed ${name} add leaves no run lock behind, and the failure still reaches the caller`, () => {
    const fx = managedFixture("t5356-lane-fail");
    const out = installMidAddPrune(fx.repoDir, fx.worktreesRoot, fx.scratch, 1);
    const { log, rows } = recordingLog();
    assert.throws(() => laneAdd(fx.repoDir, fx.worktreesRoot, "W1-T5356-2", log));
    assert.equal(readMidAdd(out, fx.scratch).lockPresent, true, "the lock was written before the add that failed");
    assert.ok(rows.find((row) => row.step === "worktree.add_failed"), "the lane still ledgers its failed add");
    assert.deepEqual(runLocks(fx.worktreesRoot), [], "the liveness token written for the add does not outlive it");
  });
}

const OWN_PR_URL = "https://github.com/craigoley/remudero/pull/5356";

/** `rmd approve <ids>` through the REAL gateway (one id: the single lane; two: the batch lane), offline:
 *  a fixture origin, a `gh` shim, and READY drafted proposals. What happens after the add is not under
 *  test; the hook's record is. */
async function driveRealApprove(ids: string[]): Promise<{ mid: MidAdd; worktreesRoot: string }> {
  const fx = managedFixture(`t5356-approve-${ids.length}`, (dir) => {
    mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(
      join(dir, "plan", "tasks.yaml"),
      "- id: W1-T4\n  title: \"a seed task\"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n",
    );
    writeFileSync(join(dir, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture\n");
  });
  const out = installMidAddPrune(fx.repoDir, fx.worktreesRoot, fx.scratch);
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5356-home-`));
  const config = { claudeBin: "/usr/bin/true", root: fx.root, installRoot: REPO_ROOT };
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify(config));
  mkdirSync(join(fx.root, "state"), { recursive: true });
  writeFileSync(
    join(fx.root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: ids.map((id) => ({ id, summary: `ratify ${id}`, evidenceAnchors: [] })) }),
  );
  const drafts: Record<string, Row> = {};
  ids.forEach((id, i) => {
    drafts[id] = {
      proposalId: id,
      fragmentYaml: `- id: NEW-1\n  title: ${["a quiet zebra crossing", "an amber lantern shelf"][i]}\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n  files: [src/lib/example-${i}.ts]\n`,
      stampLine: `- ${id} (plan) — RATIFIED -> NEW-1.`,
      anchorFingerprint: "",
    };
  });
  writeFileSync(join(fx.root, "state", "inbox-drafts.json"), JSON.stringify(drafts));
  const shim = ghShim(
    [
      { when: "--method POST", stdout: JSON.stringify({ html_url: OWN_PR_URL, number: 5356 }) },
      { when: "headRefName", stdout: JSON.stringify({ headRefName: "main" }) },
      { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }) },
      { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
      { when: "pulls?", stdout: "[]" },
    ],
    { kind: "t5356-gh" },
  );
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    process.env.HOME = home;
    process.env.PATH = `${shim.dir}:${savedPath}`;
    await withLiveWritesAllowed(() => runTaskModule.approveCommand(ids, { config: config as never })).catch(() => undefined);
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
  }
  return { mid: readMidAdd(out, fx.scratch), worktreesRoot: fx.worktreesRoot };
}

test("W1-T5356: a prune from another process during an approve gateway's add skips the path", async () => {
  const { mid, worktreesRoot } = await driveRealApprove(["P-T5356-ONE"]);
  assertSkippedMidAdd(mid);
  assert.match(mid.registered[0]!, /\/run-APPROVE-P-T5356-ONE-/, "the add the prune met is the approve lane's own");
  assert.deepEqual(runLocks(worktreesRoot), [], "the approve run drops its lock on the way out");
});

test("W1-T5356: a prune from another process during an approve-batch gateway's add skips the path", async () => {
  const { mid } = await driveRealApprove(["P-T5356-A", "P-T5356-B"]);
  assertSkippedMidAdd(mid);
  assert.match(mid.registered[0]!, /\/run-APPROVE-BATCH-/, "the add the prune met is the batch lane's own");
});

/** A top-level function's text in run-task.ts, from its signature to the next top-level `}`. */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} is still in src/run-task.ts`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end);
}

test("W1-T5356: no approve gateway or run-* lane calls worktreeAdd bare — each adds through the lock-first helper", () => {
  const src = readFileSync(RUN_TASK_SRC, "utf8");
  const bareAdd = /(?<![.\w])worktreeAdd\(/;
  // Assembled, so this file declares no builder-shaped names for the fixture-copy census to count.
  for (const [kind, name] of [
    ["async function", "approveCommand"],
    ["async function", "approveBatchCommand"],
    ["function", "addLaneWorktree"],
    ["function", "createDaemonLaneWorktree"],
  ]) {
    const signature = `${kind} ${name}(`;
    const body = functionBody(src, signature);
    assert.doesNotMatch(body, bareAdd, `${signature} adds a worktree before locking it`);
    assert.match(body, /addLockedRunWorktree\(/, `${signature} routes its add through addLockedRunWorktree`);
  }
});
