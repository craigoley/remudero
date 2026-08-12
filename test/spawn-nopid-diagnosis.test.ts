import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTask } from "../src/run-task.js";
import { spawnDetachedGroup } from "../src/lib/worker-containment.js";
import { killProcessGroup } from "../src/lib/worker-containment.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { WorkerResult, spawnWorker } from "../src/lib/worker.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";

/**
 * W1-T442 — `spawnDetachedGroup` threw `child process has no pid` and DISCARDED the
 * error object that said why. TWO distinct events (three rows) on 2026-08-12, both
 * killing a dispatch before any worker started, and nothing on disk could say whether
 * the cause was ENOENT, EAGAIN or EMFILE.
 *
 * EVERY FAILURE HERE IS A REAL SPAWN FAILURE — a bad cwd, a non-executable file, a
 * vanished path — and never a stubbed `undefined` pid. A fabricated no-pid is
 * indistinguishable from the thing under test, which is the defect one level up.
 */

const SECRET = "sk-ant-oat01-FIXTURE-NEVER-LOGGED";

// ── DIRECTION 1: the SYNCHRONOUS half — what IS in hand at throw time ────────

test("a REAL no-pid spawn names the command, cwd and args it attempted, and NEVER the env", () => {
  let thrown: Error | undefined;
  try {
    spawnDetachedGroup({
      command: "/bin/sh",
      args: ["-c", "true"],
      cwd: "/no/such/directory/at/all-w1-t442",
      env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: SECRET },
    });
  } catch (e) {
    thrown = e as Error;
  }
  assert.ok(thrown, "a bad cwd is a REAL synchronous spawn failure and must still throw");
  assert.match(thrown!.message, /has no pid/, "the existing contract other suites assert on is unchanged");
  assert.match(thrown!.message, /command=\/bin\/sh/, "the command that failed must be named");
  assert.match(thrown!.message, /cwd=\/no\/such\/directory\/at\/all-w1-t442/, "the cwd must be named -- it is the cause here");
  assert.match(thrown!.message, /args=\[-c true\]/, "the args must be named");

  assert.equal(thrown!.message.includes(SECRET), false, "the env is the BILLING BOUNDARY and must never reach an error message");
  assert.equal(thrown!.message.includes("CLAUDE_CODE_OAUTH_TOKEN"), false, "not even the env VARIABLE NAMES belong on this message");
});

test("the live exists/executable probe separates a VANISHED command from one that is merely not executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "nopid-probe-"));
  const notExecutable = join(dir, "claude");
  writeFileSync(notExecutable, "#!/bin/sh\ntrue\n");
  chmodSync(notExecutable, 0o644); // present, but the OS will refuse to exec it

  let notExecMsg = "";
  try {
    spawnDetachedGroup({ command: notExecutable, args: [], env: { PATH: process.env.PATH } });
  } catch (e) {
    notExecMsg = (e as Error).message;
  }
  assert.match(notExecMsg, /exists=true/, "a file that IS on disk must report exists=true");
  assert.match(notExecMsg, /executable=false/, "and the OS's refusal to exec it must be visible as executable=false");

  let vanishedMsg = "";
  try {
    spawnDetachedGroup({ command: join(dir, "gone-forever"), args: [], env: { PATH: process.env.PATH } });
  } catch (e) {
    vanishedMsg = (e as Error).message;
  }
  assert.match(vanishedMsg, /exists=false/, "a path that no longer exists must report exists=false");

  // THE WHOLE POINT: these two failures are the same throw with the same message
  // PREFIX, and only this probe tells them apart. A stale per-process memo of a
  // swapped-out binary lands in the second shape; resource exhaustion in neither.
  assert.notEqual(notExecMsg, vanishedMsg, "the two causes must not produce an identical message");
});

test("a BARE command name reports unresolved rather than a misleading false -- a probe that could not look is not a probe that said no", () => {
  let msg = "";
  try {
    spawnDetachedGroup({
      command: "definitely-not-a-real-binary-w1-t442",
      args: [],
      env: { PATH: "/nonexistent-dir-w1-t442" },
    });
  } catch (e) {
    msg = (e as Error).message;
  }
  assert.match(msg, /exists=unresolved/, "PATH resolution belongs to the OS, so we must not claim the file is absent");
  assert.match(msg, /executable=unresolved/, "same for executability -- W1-T119: a failed read is not a read that said no");
});

// ── DIRECTION 2: the ASYNCHRONOUS half — the errno, and the guarantee ────────

test("the asynchronous error object reaches the sink with a REAL errno instead of being discarded", async () => {
  const seen: NodeJS.ErrnoException[] = [];
  try {
    spawnDetachedGroup(
      { command: "/bin/sh", args: ["-c", "true"], cwd: "/no/such/directory/at/all-w1-t442", env: { PATH: process.env.PATH } },
      undefined,
      (err) => seen.push(err),
    );
  } catch {
    /* the throw is expected and is the SYNCHRONOUS half, asserted above */
  }
  // The event fires on a LATER tick than the throw -- which is precisely why the
  // errno cannot ride on the thrown message, and why this is a callback rather
  // than a holder the caller reads after catching.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(seen.length, 1, "the handler that used to take no argument must now receive the error");
  assert.ok(seen[0].code, "a REAL errno code must be present -- this is the field the ledger never had");
  assert.equal(typeof seen[0].syscall, "string", "and the failing syscall alongside it");
});

test("a late error on a HEALTHY spawn still cannot become an uncaught exception, and neither can a throwing sink", async () => {
  const spawned = spawnDetachedGroup(
    { command: "/bin/sh", args: ["-c", "sleep 5"], env: { PATH: process.env.PATH } },
    undefined,
    () => {
      throw new Error("a sink that throws must never escape the listener");
    },
  );
  assert.equal(typeof spawned.pid, "number", "the healthy path must still hand back a real pid");

  // A process that spawned FINE can still emit 'error' later -- the guarantee has to
  // hold on the success path too, not only where the throw happens.
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => uncaught.push(e);
  process.on("uncaughtException", onUncaught);
  try {
    (spawned.process as unknown as NodeJS.EventEmitter).emit("error", Object.assign(new Error("late"), { code: "EPIPE" }));
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    process.off("uncaughtException", onUncaught);
    try {
      killProcessGroup(spawned.pid);
    } catch {
      /* already gone */
    }
  }
  assert.deepEqual(uncaught, [], "neither the late event nor the throwing sink may reach the process");
});

// ── DIRECTION 3: the errno reaches the LEDGER, through the REAL runTask ──────
//
// A callback invoked in a test proves nothing about wiring. This drives the ACTUAL
// dispatch path -- real worktree, real git, real preflights -- and asserts on the
// ledgered ROW, with the errno produced by a genuine failing spawn.

const FIXTURE_PLAN = [
  "- id: T-NOPID",
  "  title: no-pid spawn diagnosis probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

function gitFixture(root: string): void {
  const originGit = mkdtempSync(join(tmpdir(), "nopid-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "nopid-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "nopid-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "nopid-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "nopid-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "nopid-test"]);
}

function fakeGh(branch: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "nopid-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${branch}"}'; exit 0; fi`,
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"FAILURE\"}]}'; exit 0; fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

async function runFixture(
  t: import("node:test").TestContext,
  spawn: typeof spawnWorker,
): Promise<Array<Record<string, unknown>>> {
  const root = mkdtempSync(join(tmpdir(), "nopid-root-"));
  writeFileSync(join(root, "tasks.yaml"), FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);

  const FIXED_TS = 1785100000000;
  const fakeBinDir = fakeGh(`run-T-NOPID-${FIXED_TS}`);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  t.mock.method(Date, "now", () => FIXED_TS);

  const { withLiveWritesAllowed } = await import("../src/lib/live-write-guard.js");
  try {
    await withLiveWritesAllowed(() =>
      runTask("T-NOPID", {
        skipGitSync: true,
        planPath: join(root, "tasks.yaml"),
        config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );
  } catch {
    /* the run's own terminal outcome is not what this asserts -- the ROW is */
  } finally {
    process.env.PATH = savedPath;
  }
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("BEHAVIORAL: a REAL no-pid spawn inside the REAL runTask lands its errno on a worker.spawn_error ledger row", async (t) => {
  // The injected spawn stands in for the SDK, and then calls the REAL
  // spawnDetachedGroup with a REAL bad cwd, forwarding the sink runTask supplied.
  // Nothing about the failure is fabricated: the errno on the row is the OS's.
  const spawn = (async (spawnArgs: Parameters<typeof spawnWorker>[0]) => {
    try {
      spawnDetachedGroup(
        { command: "/bin/sh", args: ["-c", "true"], cwd: "/no/such/directory/at/all-w1-t442", env: { PATH: process.env.PATH } },
        undefined,
        spawnArgs.onSpawnError,
      );
    } catch (e) {
      await new Promise((r) => setTimeout(r, 120)); // let the async 'error' land
      throw e;
    }
    throw new Error("unreachable: the bad cwd must fail");
  }) as unknown as typeof spawnWorker;

  const ledger = await runFixture(t, spawn);
  const row = ledger.find((l) => l.step === "worker.spawn_error");
  assert.ok(row, "runTask must wire a sink by DEFAULT -- an unwired sink is the defect, restated");
  assert.ok(row!.code, "the row must carry the errno CODE the throw could never reach");
  assert.equal(typeof row!.syscall, "string", "and the failing syscall");
  assert.equal(row!.task_id, "T-NOPID", "attributed to the task whose dispatch it killed");
});

test("BEHAVIORAL: a HEALTHY dispatch emits NO spawn-error row -- this runs on every dispatch", async (t) => {
  const healthy = (async () =>
    ({
      sessionId: "s",
      costUsd: 0,
      numTurns: 1,
      text: "",
      blocks: [],
      stderr: "",
      subtype: "success",
      isError: false,
      apiError: false,
      permissionDenials: [],
      childEnvKeys: [],
      model: "default",
      effort: "default",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      modelUsage: {},
      compactionEvents: [],
      qualitySuspect: false,
    }) as WorkerResult) as unknown as typeof spawnWorker;

  const ledger = await runFixture(t, healthy);
  assert.equal(
    ledger.filter((l) => l.step === "worker.spawn_error").length,
    0,
    "a diagnostic that fires when nothing is wrong is noise, and this path runs per dispatch",
  );
});
