/**
 * W1-T7744 — A DISPATCHED BUILD'S GIT AND CENSUS CALLS RUN OFF THE DAEMON LOOP.
 *
 * The daemon runs each build in its own process (`runOne` -> `runTask`), so every synchronous child in a build is a
 * loop stall: on 2026-10-10 `hostWorktreeGit` held the loop 36 times (worst 77.3 s), the affected-suite listing
 * 14.9 s, the census check 5.9 s, the filing read 5.1 s and the pre-push gate 3.0 s. These tests drive the awaited
 * forms for real — real git, real children — while the read plane's own sync-spawn telemetry watches the process,
 * or while every synchronous child_process primitive THROWS (the `syncBuiltinESMExports` swap the read plane uses).
 *
 * FIXTURES ONLY: every repository, hook and script below is under this suite's own mkdtemp root.
 */
import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { affectedSelectionOrFullAsync, readAffectedListings, readAffectedListingsAsync } from "#src/lib/affected-suites.js";
import { gitPushRunBranchAsync, PushFailedError } from "#src/lib/git-push.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { startReadPlaneTelemetry } from "#src/lib/read-plane.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { worktreeAdd } from "#src/lib/worker.js";
import { pinnedConfigValue, pinnedConfigValueAsync, pinWorktreeGit } from "#src/lib/worktree-git.js";
import {
  checkFixCensusSnapshot,
  checkFixCensusSnapshotAsync,
  coveragePrecheck,
  prefetchedDispatchFilingReader,
  type DispatchFilingSnapshot,
  readDispatchFilingSnapshot,
  readDispatchFilingSnapshotAsync,
  spawnCensusChild,
  type CoverageRunResult,
} from "#src/run-task.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

const SYNC_PRIMITIVES = ["execFileSync", "spawnSync", "execSync"] as const;

/** Run `body` while every synchronous child_process primitive THROWS, then restore them. Fixtures are built before
 *  and checked after the trap: only the code under test runs inside it. */
async function withSyncSpawnsTrapped<T>(body: () => Promise<T>): Promise<T> {
  const cp = childProcess as unknown as Record<string, unknown>;
  const originals = SYNC_PRIMITIVES.map((name) => [name, cp[name]] as const);
  for (const name of SYNC_PRIMITIVES) {
    cp[name] = () => {
      throw new Error(`synchronous ${name} reached while the event loop was being served`);
    };
  }
  syncBuiltinESMExports();
  try {
    return await body();
  } finally {
    for (const [name, original] of originals) cp[name] = original;
    syncBuiltinESMExports();
  }
}

let root: string;
let harnessHooks: string;
let counter = 0;
const savedHooksDir = process.env.RMD_HARNESS_HOOKS_DIR;

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

before(() => {
  root = makeTempDir("w1t7744");
  harnessHooks = join(root, "harness-hooks");
  mkdirSync(harnessHooks);
  process.env.RMD_HARNESS_HOOKS_DIR = harnessHooks;
});

after(() => {
  if (savedHooksDir === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
  else process.env.RMD_HARNESS_HOOKS_DIR = savedHooksDir;
  rmSync(root, { recursive: true, force: true });
});

/** A run worktree cut by the real `worktreeAdd` (so its pinned config enables the harness gate) carrying one
 *  committed change to src/feature.ts and the suite that imports it. */
function lane(): { wt: string; remote: string; branch: string } {
  const n = ++counter;
  const remote = gitRepo({ bare: true, kind: `w1t7744-remote-${n}` }).dir;
  const seed = gitRepo({ kind: `w1t7744-seed-${n}` });
  seed.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  seed.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "README.md");
  seed.git("commit", "-q", "-m", "chore: seed");
  seed.addRemote("origin", remote);
  seed.git("push", "-q", "origin", "main");
  const wt = join(root, `wt-${n}`);
  const branch = `run-w1t7744-${n}-1`;
  worktreeAdd(seed.dir, wt, branch, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  mkdirSync(join(wt, "src"));
  mkdirSync(join(wt, "test"));
  writeFileSync(join(wt, "src", "feature.ts"), "export const feature = 1;\n");
  writeFileSync(join(wt, "test", "feature.test.ts"), 'import { feature } from "../src/feature.js";\nvoid feature;\n');
  spawnSync("git", ["-C", wt, "add", "src", "test"]);
  spawnSync("git", ["-C", wt, "-c", "core.hooksPath=/dev/null", "-c", `user.email=${GIT_REPO_FIXTURE_IDENTITY.email}`, "-c",
    `user.name=${GIT_REPO_FIXTURE_IDENTITY.name}`, "commit", "-q", "-m", "feat: a feature"]);
  return { wt, remote, branch };
}

/** A directory whose `git` sleeps `ms` before running the real git: every git call a build makes BLOCKS. */
function blockingGit(ms: number): string {
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  assert.ok(realGit, "control: git is on PATH");
  const dir = join(root, `blocking-git-${++counter}`);
  mkdirSync(dir);
  script(join(dir, "git"), `sleep ${ms / 1000}\nexec "${realGit}" "$@"`);
  return dir;
}

test("W1-T7744: a dispatched build that blocks in worktree git adds no sync spawn time to the daemon process", async () => {
  const { wt, remote, branch } = lane();
  const gateRan = join(root, "gate-ran");
  script(join(harnessHooks, "pre-push"), `cat >/dev/null\ntouch "${gateRan}"\nexit 0`);
  const shim = blockingGit(300);
  const coverageRuns: string[][] = [];
  const savedPath = process.env.PATH;
  // The daemon's own sampler: it wraps execFileSync/execSync/spawnSync and sums the time each one held the process.
  const telemetry = startReadPlaneTelemetry();
  let ticks = 0;
  const interval = setInterval(() => void ticks++, 20);
  try {
    telemetry.sample(); // open a fresh window: fixture setup above is not the build's
    process.env.PATH = `${shim}:${savedPath ?? ""}`;
    // The build's pre-push stage, on its default seams: the changed-file read, the affected-suite selection (the
    // tracked-file listing and the diff-class listing child), then the run-branch push through the harness's pre-push gate.
    const precheck = await coveragePrecheck(wt, {
      manifest: () => ({ thresholdMs: 30_000, files: { "test/feature.test.ts": 1 } }),
      run: async (_w, suites): Promise<CoverageRunResult> => {
        coverageRuns.push(suites);
        return { status: 0, output: "diff-coverage: OK\n", timedOut: false };
      },
    });
    await withLiveWritesAllowed(() => gitPushRunBranchAsync(wt, { stdio: "ignore" }));
    process.env.PATH = savedPath;
    const window = telemetry.sample();

    assert.equal(precheck.outcome, "covered", JSON.stringify(precheck));
    assert.ok(coverageRuns.length === 1 && coverageRuns[0]!.includes("test/feature.test.ts"),
      `the precheck read the worktree's change and selected the suite that imports it: ${JSON.stringify(coverageRuns)}`);
    assert.ok(existsSync(gateRan), "the harness's pre-push gate ran before the push");
    const pushed = spawnSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).stdout.trim();
    assert.equal(pushed, spawnSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), "the run branch landed");
    assert.equal(window.sync_spawn_ms, 0,
      `the build held the daemon process in a synchronous child for ${window.sync_spawn_ms} ms: ${JSON.stringify(window.sync_spawn_top)}`);
    assert.ok(ticks >= 5, `the event loop kept turning while every git call blocked for 300 ms (ticks=${ticks})`);
  } finally {
    process.env.PATH = savedPath;
    clearInterval(interval);
    telemetry.stop();
    rmSync(join(harnessHooks, "pre-push"), { force: true });
  }
});

/** A stand-in census-precheck.mjs that refuses with one offered baseline row, as the real script prints it. */
const REFUSING_PRECHECK = [
  "process.stdout.write('census-precheck: this branch grows 1 census count(s) CI will refuse:\\n' +",
  "  '  comment-load: src/feature.ts grows 3 -> 4, or record {\"file\":\"src/feature.ts\"} in scripts/comment-load-baseline.json\\n');",
  "process.exit(1);",
].join("\n");

test("W1-T7744: checkFixCensusSnapshotAsync returns the census refusal with sync spawns trapped", async () => {
  const fake = join(root, "census-precheck.mjs");
  writeFileSync(fake, REFUSING_PRECHECK);
  const snapshot = join(root, "snapshot.json");
  writeFileSync(snapshot, "{}");
  const wt = join(root, "census-tree");
  mkdirSync(wt, { recursive: true });
  // Both forms run the SAME child: the harness's script argv with the stand-in in place of the script path.
  const seen: Array<{ args: string[]; env: unknown }> = [];
  const redirect = (args: string[]) => [fake, ...args.slice(1)];
  const syncLog: Array<[string, unknown]> = [];
  const expected = checkFixCensusSnapshot(wt, snapshot, (s, e) => syncLog.push([s, e]),
    ((file: string, args: string[], options: childProcess.SpawnSyncOptionsWithStringEncoding) =>
      spawnSync(file, args.includes("--snapshot-budget") ? args : redirect(args), options)) as typeof spawnSync);
  const asyncLog: Array<[string, unknown]> = [];
  const actual = await withSyncSpawnsTrapped(() => checkFixCensusSnapshotAsync(wt, snapshot, (s, e) => asyncLog.push([s, e]),
    (file, args, options) => {
      if (args.includes("--snapshot-budget")) return spawnCensusChild(file, args, options);
      seen.push({ args, env: (options.env as NodeJS.ProcessEnv | undefined)?.RMD_CENSUS_SNAPSHOT });
      return spawnCensusChild(file, redirect(args), options);
    }));

  assert.ok(actual?.refusal, `the awaited check refused: ${JSON.stringify(actual)}`);
  assert.deepEqual(actual!.refusal!.censuses, ["comment-load"]);
  assert.deepEqual(actual!.refusal!.offeredBaselines, ["scripts/comment-load-baseline.json"]);
  assert.deepEqual(actual, expected, "the awaited check returns the sync form's refusal");
  assert.deepEqual(asyncLog, syncLog, "and ledgers the same fix.census_check row");
  assert.equal(seen.length, 1, "a refused precheck runs no reach-ratchet child");
  assert.deepEqual(seen[0]!.args.slice(1), ["--root", wt]);
  assert.equal(seen[0]!.env, snapshot, "the child reads the snapshot the harness wrote");
  assert.equal(await checkFixCensusSnapshotAsync(wt, undefined, () => assert.fail("no snapshot, no check")), undefined);
});

test("W1-T7744: readAffectedListingsAsync returns the diff-class listing with sync spawns trapped", async () => {
  const repo = process.cwd();
  // A src change (the census listing) and a non-code change (the plan-reading listing too).
  const changed = ["src/lib/affected-suites.ts", "plan/policy.yaml"];
  const expected = readAffectedListings(repo, changed);
  const actual = await withSyncSpawnsTrapped(() => readAffectedListingsAsync(repo, changed));
  assert.ok(expected.length > 0, "control: diff-class lists suites for these paths");
  assert.deepEqual(actual, expected, "the awaited listing equals the sync listing");
  await assert.rejects(() => withSyncSpawnsTrapped(() => readAffectedListingsAsync(join(root, "no-such-tree"), changed)), /ENOENT/,
    "an unreadable tree still throws, never an empty listing");
  const unread = await affectedSelectionOrFullAsync(changed, async () => { throw new Error("listing child exited 1"); });
  assert.equal(unread.fullRun, true, "a rejected read is a named FULL run, never a narrower guess");
  assert.match(unread.reasons[0]!, /could not read its input — listing child exited 1/);
});

test("W1-T7744: the gate's awaited hooksPath read answers as the sync read does", async () => {
  const { wt } = lane();
  const plain = gitRepo({ kind: "w1t7744-plain" });
  try {
    const pinned = pinWorktreeGit(wt);
    const unpinned = pinWorktreeGit(plain.dir);
    const set = pinnedConfigValue(pinned, "core.hooksPath");
    assert.ok(set, "control: a cut run worktree enables the harness gate");
    assert.equal(await withSyncSpawnsTrapped(() => pinnedConfigValueAsync(pinned, "core.hooksPath")), set);
    assert.equal(pinnedConfigValue(unpinned, "core.hooksPath"), undefined, "control: a plain clone sets no hooksPath");
    assert.equal(await withSyncSpawnsTrapped(() => pinnedConfigValueAsync(unpinned, "core.hooksPath")), undefined);
    // An unreadable config is git's exit 128, not "unset": both forms throw rather than answer.
    writeFileSync(join(plain.dir, ".git", "config"), "[core\n");
    assert.throws(() => pinnedConfigValue(unpinned, "core.hooksPath"), /bad config/);
    await assert.rejects(() => withSyncSpawnsTrapped(() => pinnedConfigValueAsync(unpinned, "core.hooksPath")), /bad config/);
  } finally {
    plain.cleanup();
  }
});

test("W1-T7744: the async run-branch push refuses a failing pre-push gate with sync spawns trapped", async () => {
  const { wt, remote, branch } = lane();
  script(join(harnessHooks, "pre-push"), "cat >/dev/null\necho 'gate: refused by the fixture' >&2\nexit 7");
  try {
    const refusal = await withSyncSpawnsTrapped(() =>
      withLiveWritesAllowed(() => gitPushRunBranchAsync(wt, { stdio: "ignore" })).then(
        () => assert.fail("a failing gate must refuse the push"),
        (error: unknown) => error,
      ));
    assert.ok(refusal instanceof PushFailedError, `a gate refusal, not a trapped sync spawn: ${String(refusal)}`);
    assert.match(refusal.message, /pre-push gate .* refused this push \(exit 7\); nothing was pushed/);
    assert.match(refusal.message, /gate: refused by the fixture/);
    const pushed = spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" });
    assert.notEqual(pushed.status, 0, "nothing reached the remote");
  } finally {
    rmSync(join(harnessHooks, "pre-push"), { force: true });
  }
});

test("W1-T7744: readDispatchFilingSnapshotAsync returns the filing snapshot with sync spawns trapped", async () => {
  const repo = gitRepo({ kind: "w1t7744-filing" });
  try {
    mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
    const planPath = join(repo.dir, "plan", "tasks.yaml");
    writeFileSync(planPath, "- id: W1-T1\n  title: first task\n");
    repo.git("add", ".");
    repo.git("commit", "-q", "-m", "file first task");
    const firstFiled = Number(repo.git("show", "-s", "--format=%ct").trim()) * 1000;
    writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T2.yaml"), "- id: W1-T2\n  title: second task\n");
    repo.git("add", ".");
    repo.git("commit", "-q", "-m", "file second task");
    const secondFiled = Number(repo.git("show", "-s", "--format=%ct").trim()) * 1000;

    // The awaited read runs FIRST, so it reads the whole history itself rather than the sync form's cache.
    const actual = await withSyncSpawnsTrapped(() => readDispatchFilingSnapshotAsync(planPath));
    assert.equal(actual.kind, "ready", JSON.stringify(actual));
    assert.equal(actual.kind === "ready" && actual.snapshot.planTreeSha, repo.git("rev-parse", "HEAD:plan").trim());
    assert.deepEqual(actual.kind === "ready" && [...actual.snapshot.filedAtByTaskId], [["W1-T1", firstFiled], ["W1-T2", secondFiled]]);
    assert.deepEqual(readDispatchFilingSnapshot(planPath), actual, "the sync form returns the same snapshot");

    const missing = await withSyncSpawnsTrapped(() => readDispatchFilingSnapshotAsync(join(root, "no-such-plan", "tasks.yaml")));
    assert.equal(missing.kind, "refused");
    assert.match(missing.kind === "refused" ? missing.reasons[0]! : "", /^filing-history-unreadable:/);
  } finally {
    repo.cleanup();
  }
});

test("W1-T7744: dispatch selection reads the filing snapshot its reader last awaited", async () => {
  const answers: DispatchFilingSnapshot[] = [
    { kind: "ready", snapshot: { planTreeSha: "a".repeat(40), filedAtByTaskId: new Map([["W1-T1", 1_000]]) } },
    { kind: "ready", snapshot: { planTreeSha: "b".repeat(40), filedAtByTaskId: new Map([["W1-T1", 1_000], ["W1-T2", 2_000]]) } },
  ];
  const reads: string[] = [];
  const reader = prefetchedDispatchFilingReader(async (planPath) => {
    reads.push(planPath);
    return answers[Math.min(reads.length - 1, answers.length - 1)]!;
  });
  assert.deepEqual(reader("/plan/tasks.yaml"), { kind: "refused", reasons: ["filing-history-pending"] },
    "an unprimed reader names the pending read rather than blocking on it");
  const first = await reader.refresh("/plan/tasks.yaml");
  assert.equal(first, answers[0], "the in-flight read is joined, not repeated");
  assert.equal(reads.length, 1);
  assert.equal(reader("/plan/tasks.yaml"), answers[0], "selection reads the awaited answer");
  await reader.refresh("/plan/tasks.yaml"); // the read the selection above started
  assert.equal(reader("/plan/tasks.yaml"), answers[1], "a moved plan is seen by the next selection");
  await reader.refresh("/plan/tasks.yaml");
  assert.equal(reads.length, 3);

  // An injected read that REJECTS is answered `refused`, and its in-flight slot is freed for the next read.
  let failNext = true;
  const flaky = prefetchedDispatchFilingReader(async () => {
    if (failNext) { failNext = false; throw new Error("git exited 128"); }
    return answers[0]!;
  });
  assert.deepEqual(await flaky.refresh("/plan/tasks.yaml"),
    { kind: "refused", reasons: ["filing-history-unreadable:Error: git exited 128"] });
  assert.deepEqual(flaky("/plan/tasks.yaml"), { kind: "refused", reasons: ["filing-history-unreadable:Error: git exited 128"] },
    "selection reads the refusal, not a pending slot that never clears");
  assert.equal(await flaky.refresh("/plan/tasks.yaml"), answers[0], "the next read runs and its answer is seen");
});
