// test/worker-containment.test.ts — W1-T117: worker process-tree containment.
//
// Every process this file touches is SPAWNED BY THE TEST ITSELF and reaped
// in-process (Rule 18 / plan/tasks.yaml W1-T117's own note): no operator, no
// real signal to a system daemon, no launchd. `process.kill(pid, 0)` throwing
// ESRCH is the observable proof a pid is gone; a `finally` block in every
// test kills every leader pgid it spawned as a cleanup backstop, independent
// of whatever the test body itself already tore down.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  buildContainedSpawnFn,
  defaultListCandidates,
  defaultReadMarkers,
  isPidAlive,
  killProcessGroup,
  listProcessGroupMembers,
  RUN_ID_ENV,
  spawnDetachedGroup,
  sweepOrphanWorkers,
  TASK_ID_ENV,
  teardownProcessGroup,
  withWorkerGroupTeardown,
  workerMarkerEnv,
  type ContainedProcess,
} from "../src/lib/worker-containment.js";

/**
 * Cleanup-backstop kill for a test's `finally` block, swallowing EVERY error
 * (not just the ESRCH `killProcessGroup` itself already tolerates) — by the
 * time a `finally` runs, the test body has usually already torn the group
 * down itself, and a long-dead pgid number can be RECYCLED by the OS to an
 * unrelated process this test has no permission to signal (EPERM), which
 * must never fail the test over its own redundant safety net.
 */
function safeKillGroup(pgid: number | undefined): void {
  if (pgid === undefined) return;
  try {
    killProcessGroup(pgid);
  } catch {
    // best-effort cleanup only — see doc above
  }
}

/** Wait until `pid` no longer answers `process.kill(pid, 0)` (ESRCH), bounded
 *  so a broken teardown fails the test instead of hanging it. */
async function waitUntilDead(pid: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (isPidAlive(pid)) {
    if (Date.now() - start > timeoutMs) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * The "worker fixture" the acceptance criteria describe: a leader process
 * spawned via `spawnDetachedGroup` (own process group/session) that ITSELF
 * backgrounds a long-sleep child via plain shell job control (`cmd &`,
 * non-interactive `sh -c` — no job control, so the child stays in the
 * LEADER's own process group). This is the incident's actual shape: a
 * `bash -c` background job spawned from a worker's shell snapshot.
 */
async function spawnWorkerFixtureWithBackgroundChild(
  env: Record<string, string | undefined> = { PATH: process.env.PATH },
): Promise<{ leader: ContainedProcess; childPid: number }> {
  const stderr: string[] = [];
  const leader = spawnDetachedGroup(
    { command: "/bin/sh", args: ["-c", "sleep 300 & echo $!"], env },
    (chunk) => stderr.push(chunk),
  );
  const childPid = await new Promise<number>((resolve, reject) => {
    let out = "";
    leader.process.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const m = out.match(/(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    leader.process.once("error", reject);
    setTimeout(() => reject(new Error("fixture: no child pid observed within 5s")), 5000);
  });
  return { leader, childPid };
}

// ── Criterion 1: no worker child survives run teardown, on any verdict path ─

test("teardownProcessGroup: a detached worker's backgrounded child is reaped on the SUCCESS path", async () => {
  const pidRef: { pid?: number } = {};
  let childPid = -1;
  try {
    const result = await withWorkerGroupTeardown(pidRef, async () => {
      const fixture = await spawnWorkerFixtureWithBackgroundChild();
      pidRef.pid = fixture.leader.pid;
      childPid = fixture.childPid;
      return "success-verdict";
    });
    assert.equal(result, "success-verdict");
    await waitUntilDead(childPid);
    assert.throws(() => process.kill(childPid, 0), /ESRCH/, "the backgrounded child must be gone after teardown");
    assert.deepEqual(
      listProcessGroupMembers(pidRef.pid!),
      [],
      "the survivor scan must return an empty list for the torn-down group",
    );
  } finally {
    safeKillGroup(pidRef.pid);
    if (childPid > 0) safeKillGroup(childPid);
  }
});

test("teardownProcessGroup: a detached worker's backgrounded child is reaped on the ERROR path (a thrown run() never skips teardown)", async () => {
  const pidRef: { pid?: number } = {};
  let childPid = -1;
  try {
    await assert.rejects(
      () =>
        withWorkerGroupTeardown(pidRef, async () => {
          const fixture = await spawnWorkerFixtureWithBackgroundChild();
          pidRef.pid = fixture.leader.pid;
          childPid = fixture.childPid;
          throw new Error("simulated worker error verdict");
        }),
      /simulated worker error verdict/,
    );
    await waitUntilDead(childPid);
    assert.throws(() => process.kill(childPid, 0), /ESRCH/, "the backgrounded child must be gone after teardown");
    assert.deepEqual(
      listProcessGroupMembers(pidRef.pid!),
      [],
      "the survivor scan must return an empty list for the torn-down group",
    );
  } finally {
    safeKillGroup(pidRef.pid);
    if (childPid > 0) safeKillGroup(childPid);
  }
});

test("withWorkerGroupTeardown: no pid ever recorded (an earlier guard threw first) is a correct no-op, never an error", async () => {
  let teardownCalls = 0;
  const pidRef: { pid?: number } = {};
  const result = await withWorkerGroupTeardown(
    pidRef,
    async () => "never spawned",
    () => {
      teardownCalls++;
    },
  );
  assert.equal(result, "never spawned");
  assert.equal(teardownCalls, 0, "teardown must never fire for a pid that was never recorded");
});

test("killProcessGroup / teardownProcessGroup: ESRCH (already-dead group) is swallowed, never thrown", () => {
  // A pid this high is never a real, live process group on any CI runner.
  const longDeadPgid = 999_999;
  assert.doesNotThrow(() => killProcessGroup(longDeadPgid));
  const { survivors } = teardownProcessGroup(longDeadPgid);
  assert.deepEqual(survivors, []);
});

test("spawnDetachedGroup: stderr is piped to the caller's own sink (the SDK does not wire it for a custom spawn)", async () => {
  const chunks: string[] = [];
  const { process: proc, pid } = spawnDetachedGroup(
    { command: "/bin/sh", args: ["-c", "echo boom 1>&2"], env: { PATH: process.env.PATH } },
    (chunk) => chunks.push(chunk),
  );
  await new Promise<void>((resolve) => proc.on("exit", () => resolve()));
  assert.ok(chunks.join("").includes("boom"), "the child's stderr must reach the injected onStderr sink");
  assert.equal(typeof pid, "number");
});

// ── Criteria 2 & 3: the orphan sweep — attribution, kill+ledger, blast radius

test("sweepOrphanWorkers: a marker-carrying stray from an ended run is killed and ledgered; a marker-less process is left alone, alive, and reported", async () => {
  const strayEnv = { ...process.env, [RUN_ID_ENV]: "run-ended-1", [TASK_ID_ENV]: "W1-T117" };
  const stray = spawnDetachedGroup({ command: "/bin/sh", args: ["-c", "sleep 300"], env: strayEnv });
  const unrelated = spawnDetachedGroup({ command: "/bin/sh", args: ["-c", "sleep 300"], env: { PATH: process.env.PATH } });
  try {
    const ledgerLines: Array<{ run_id: string; task_id: string; pid: number; cmdline: string }> = [];
    const report = sweepOrphanWorkers({
      listCandidates: () => [
        { pid: stray.pid, cmdline: "sleep 300 (stray)" },
        { pid: unrelated.pid, cmdline: "sleep 300 (unrelated)" },
      ],
      readMarkers: (pid) => (pid === stray.pid ? { runId: "run-ended-1", taskId: "W1-T117" } : undefined),
      isRunActive: () => false, // both candidates' runs (where attributable) are ENDED
      kill: (pid) => killProcessGroup(pid),
      ledger: (line) => ledgerLines.push(line),
    });

    assert.deepEqual(report.killed, [
      { pid: stray.pid, run_id: "run-ended-1", task_id: "W1-T117", cmdline: "sleep 300 (stray)" },
    ]);
    assert.deepEqual(report.leftAlone, [{ pid: unrelated.pid, reason: "unattributable" }]);
    assert.deepEqual(ledgerLines, [
      { run_id: "run-ended-1", task_id: "W1-T117", pid: stray.pid, cmdline: "sleep 300 (stray)" },
    ]);

    await waitUntilDead(stray.pid);
    assert.throws(() => process.kill(stray.pid, 0), /ESRCH/, "the attributed stray must be dead");
    assert.equal(isPidAlive(unrelated.pid), true, "the marker-less process must be left alive — never signalled on suspicion");
  } finally {
    safeKillGroup(stray.pid);
    safeKillGroup(unrelated.pid);
  }
});

test("sweepOrphanWorkers: an attributable process belonging to a STILL-ACTIVE run is left alone too (blast radius: never kill a live run's own process)", async () => {
  const activeEnv = { ...process.env, [RUN_ID_ENV]: "run-still-active", [TASK_ID_ENV]: "W1-T999" };
  const activeProc = spawnDetachedGroup({ command: "/bin/sh", args: ["-c", "sleep 300"], env: activeEnv });
  try {
    let killCalls = 0;
    const report = sweepOrphanWorkers({
      listCandidates: () => [{ pid: activeProc.pid, cmdline: "sleep 300 (active)" }],
      readMarkers: () => ({ runId: "run-still-active", taskId: "W1-T999" }),
      isRunActive: (runId) => runId === "run-still-active",
      kill: () => {
        killCalls++;
      },
      ledger: () => {
        throw new Error("must never ledger a run_active left-alone process");
      },
    });
    assert.deepEqual(report.killed, []);
    assert.deepEqual(report.leftAlone, [{ pid: activeProc.pid, reason: "run_active" }]);
    assert.equal(killCalls, 0);
    assert.equal(isPidAlive(activeProc.pid), true);
  } finally {
    safeKillGroup(activeProc.pid);
  }
});

// ── worker.ts wiring (spawnWorker cannot itself be unit-tested past its real
// query() call — every existing spawnWorker test throws before reaching it —
// so the marker-env merge and the spawnClaudeCodeProcess closure it installs
// are extracted and tested here directly, with no real SDK/binary involved) ─

test("workerMarkerEnv: both ids present -> both marker vars set; either absent -> omitted, never written as 'undefined'", () => {
  assert.deepEqual(workerMarkerEnv("run-1", "W1-T117"), { [RUN_ID_ENV]: "run-1", [TASK_ID_ENV]: "W1-T117" });
  assert.deepEqual(workerMarkerEnv(undefined, "W1-T117"), { [TASK_ID_ENV]: "W1-T117" });
  assert.deepEqual(workerMarkerEnv("run-1", undefined), { [RUN_ID_ENV]: "run-1" });
  assert.deepEqual(workerMarkerEnv(), {});
});

test("buildContainedSpawnFn: delegates to the injected spawnContained, records pid into pidRef, and routes stderr to the caller's sink — no real SDK/binary involved", () => {
  const fakeProcess = { marker: "fake-spawned-process" } as unknown as ContainedProcess["process"];
  const calls: Array<{ opts: unknown; onStderr?: (chunk: string) => void }> = [];
  const spawnContained = (opts: unknown, onStderr?: (chunk: string) => void) => {
    calls.push({ opts, onStderr });
    onStderr?.("stderr from the fake child");
    return { process: fakeProcess, pid: 4242 };
  };
  const stderrChunks: string[] = [];
  const pidRef: { pid?: number } = {};
  const spawnClaudeCodeProcess = buildContainedSpawnFn(spawnContained, (chunk) => stderrChunks.push(chunk), pidRef);

  const spawnOpts = { command: "claude", args: ["-p"], env: { PATH: "/usr/bin" } };
  const returned = spawnClaudeCodeProcess(spawnOpts);

  assert.equal(returned, fakeProcess, "the SDK-facing return value must be the injected spawn's own process handle");
  assert.equal(pidRef.pid, 4242, "the pid must be recorded for withWorkerGroupTeardown to tear down later");
  assert.deepEqual(stderrChunks, ["stderr from the fake child"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts, spawnOpts, "the SDK's own SpawnOptions must reach spawnContained UNCHANGED");
});

test("spawnDetachedGroup: a synchronous spawn failure (no pid ever assigned) fails loud rather than handing back an untracked handle", () => {
  assert.throws(
    () =>
      spawnDetachedGroup({
        command: "/bin/sh",
        args: ["-c", "true"],
        cwd: "/no/such/directory/at/all-w1-t117",
        env: { PATH: process.env.PATH },
      }),
    /has no pid/,
  );
});

// ── Real-world default deps (ps-based) — the CLI-layer wiring that plugs
// these into a live daemon is out of scope for this task (see the REPORT's
// Follow-ups); these prove the ps-parsing logic itself against REAL `ps`
// output, no injection.

test("defaultListCandidates: a real `ps` scan finds THIS test process's own pid with a non-empty cmdline", () => {
  const rows = defaultListCandidates();
  assert.ok(rows.length > 0, "a real ps scan on a live machine is never empty");
  const self = rows.find((r) => r.pid === process.pid);
  assert.ok(self, "this test process's own pid must appear in a real ps scan");
  assert.ok(self!.cmdline.length > 0);
});

test("defaultReadMarkers: a real child spawned WITH marker env vars is attributed; one spawned WITHOUT them is not", async () => {
  const marked = spawnDetachedGroup({
    command: "/bin/sh",
    args: ["-c", "sleep 300"],
    env: { ...process.env, [RUN_ID_ENV]: "run-real-1", [TASK_ID_ENV]: "W1-T117" },
  });
  const unmarked = spawnDetachedGroup({ command: "/bin/sh", args: ["-c", "sleep 300"], env: { PATH: process.env.PATH } });
  try {
    // `ps eww` needs a beat after spawn to reliably reflect a brand-new pid on some hosts.
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(defaultReadMarkers(marked.pid), { runId: "run-real-1", taskId: "W1-T117" });
    assert.equal(defaultReadMarkers(unmarked.pid), undefined);
  } finally {
    safeKillGroup(marked.pid);
    safeKillGroup(unmarked.pid);
  }
});

test("defaultReadMarkers: a pid that no longer exists yields undefined, never a guess", () => {
  assert.equal(defaultReadMarkers(999_999), undefined);
});

test("defaultListCandidates: a `ps` failure (no `ps` reachable on PATH) degrades to an empty list, never throws", () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.deepEqual(defaultListCandidates(), []);
  } finally {
    process.env.PATH = originalPath;
  }
});

// ── Supporting primitives ───────────────────────────────────────────────────

test("isPidAlive: true for a live pid, false (ESRCH) once it is gone", async () => {
  const proc = spawn("/bin/sh", ["-c", "sleep 300"], { env: { PATH: process.env.PATH } });
  assert.ok(proc.pid);
  try {
    assert.equal(isPidAlive(proc.pid!), true);
  } finally {
    proc.kill("SIGKILL");
    await new Promise<void>((resolve) => proc.on("exit", () => resolve()));
  }
  await waitUntilDead(proc.pid!);
  assert.equal(isPidAlive(proc.pid!), false);
});

test("listProcessGroupMembers: injected listFn is parsed for `pid=,pgid=` rows matching the target group", () => {
  const listFn = () => ["  111   222", "  333   444", " 555  222"].join("\n");
  assert.deepEqual(listProcessGroupMembers(222, listFn), [111, 555]);
});

test("listProcessGroupMembers: a ZOMBIE row is excluded — not a real survivor, just a parent's pending wait()", () => {
  // A SIGKILL'd group leader can transiently show up in `ps` as `Z` for a few
  // ms before this Node process's event loop gets a tick to reap it — that is
  // NOT a live process capable of doing anything, so it must never count.
  const listFn = () => ["111 222 Z+", "333 222 S"].join("\n");
  assert.deepEqual(listProcessGroupMembers(222, listFn), [333]);
});

test("listProcessGroupMembers: a listFn failure (e.g. no `ps` on this host) degrades to an empty list, never throws", () => {
  const listFn = () => {
    throw new Error("ps: command not found");
  };
  assert.deepEqual(listProcessGroupMembers(123, listFn), []);
});
