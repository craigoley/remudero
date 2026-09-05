// test/worker-containment.test.ts — W1-T117: worker process-tree containment.
//
// Every process this file touches is SPAWNED BY THE TEST ITSELF and reaped
// in-process (Rule 18 / plan/tasks.yaml W1-T117's own note): no operator, no
// real signal to a system daemon, no launchd. `process.kill(pid, 0)` throwing
// ESRCH is the observable proof a pid is gone; a `finally` block in every
// test kills every leader pgid it spawned as a cleanup backstop, independent
// of whatever the test body itself already tore down.
import assert from "node:assert/strict";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  WORKER_SCOPE_ENV,
  workerInstallationScope,
  workerMarkerEnv,
  type ContainedProcess,
} from "../src/lib/worker-containment.js";
import { daemonCommand, ledgerPathFor } from "../src/run-task.js";
import type { DaemonSummary } from "../src/lib/daemon.js";

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
 * W1-T459: wait for the CONDITION the attribution path actually reads — `ps eww` having published
 * `pid`'s marker ENV — instead of sleeping a fixed beat and hoping.
 *
 * WHY A POLL AND NOT A BIGGER NUMBER. The fixed 100 ms beat this replaces was a bet on host speed.
 * MEASURED on the mini (10 cores) by spawning a marked child and polling to first visibility: IDLE
 * median 2 ms / max 3 ms, but at load 58-86 median 48 ms, p90 117 ms, max 150 ms — 4 of 25 samples
 * past 100 ms. The beat does not fail because 100 is the wrong constant; it fails because a
 * constant cannot bound a quantity that moves with contention. A longer sleep only moves the cliff.
 *
 * THE CEILING IS 5000 ms, matching {@link waitUntilDead} directly above rather than inventing a
 * second convention — 33x the worst visibility measured under deliberate overload. BOTH failure
 * modes are real and named: too short reintroduces the flake, and too long makes a GENUINE
 * never-attributable process take the full ceiling before it reports. 5 s is chosen so the second
 * cost is paid only on a real defect, never on a slow host.
 *
 * IT THROWS ON THE CEILING, and that is load-bearing: a poll that gave up and let the caller
 * proceed would convert this file's regression locks into vacuous passes.
 */

/**
 * W1-T2350: SERIALISE THE TWO REAL, SYSTEM-WIDE ORPHAN SWEEPS ACROSS TEST FILES.
 *
 * THE DEFECT THIS CLOSES. `sweepOrphanWorkers`'s production `listCandidates` is
 * `defaultListCandidates` -- `ps -eo pid=,command=`, EVERY pid on the machine, not this
 * fixture's. Both this suite and its twin (test/daemon.test.ts <-> test/worker-containment.test.ts)
 * spawn a marker-carrying stray and then run the REAL `daemonCommand`, whose boot sweep kills
 * every marked pid whose runId is not active in ITS OWN `state/inflight` directory. The two
 * fixtures have different roots, so neither sweep can see that the other's stray belongs to a
 * live test. `node --test` runs FILES concurrently, so whichever sweep reaches the process table
 * first kills BOTH strays and ledgers both into ITS OWN ledger. The loser then finds its stray
 * already dead -- so `waitUntilDead` and the ESRCH assertion still PASS -- and no
 * `worker_orphan_killed` line in its own ledger: `actual: undefined, expected: true` at the
 * ledger assertion. That is the observed CI failure verbatim (run 33025181897 attempt 1,
 * test/daemon.test.ts:2261), and it is what `scripts/test-with-retry.mjs` was re-running the
 * whole instrumented suite to paper over.
 *
 * IT IS NOT A MARKER-VISIBILITY PROBLEM. `waitUntilMarkersVisible` never throws in these
 * failures -- if it had, the error would be its own message, not an assertion. MEASURED on this
 * host: each file's W1-T356 test passes 20/20 run alone, and the pair fails 10/10 run
 * concurrently, with no artificial load at all.
 *
 * WHY A LOCK AND NOT A FAKE PROCESS TABLE. "the REAL daemonCommand" is the point of both tests:
 * injecting a fake `listCandidates` would stop proving that the wired closure reads the real one,
 * which is the entire wiring claim. So both sweeps stay real and are merely kept from OVERLAPPING.
 *
 * SHAPE (W1-T1066: never pace, never sleep a fixed beat). A bounded wait on the CONDITION -- the
 * lock directory being free -- polled at the same 20 ms beat `waitUntilDead` and
 * `waitUntilMarkersVisible` already use, and it THROWS at its ceiling so a wedged lock fails
 * loudly instead of silently letting the caller run unserialised. `mkdirSync` is the atomic
 * primitive: it fails EEXIST rather than clobbering. A holder that died mid-test is reclaimed by
 * pid, so one SIGKILL cannot wedge every later run on a developer machine.
 */
const REAL_SWEEP_LOCK = join(tmpdir(), "rmd-real-orphan-sweep.lock");

async function withRealSweepLock<T>(fn: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(REAL_SWEEP_LOCK);
      writeFileSync(join(REAL_SWEEP_LOCK, "holder.pid"), String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A holder pid of 0 means the directory exists but its pid file is not written yet -- the
      // other process is mid-acquire. That is a LIVE holder, never a stale one, so it is waited
      // out rather than reclaimed.
      let holder = 0;
      try {
        holder = Number(readFileSync(join(REAL_SWEEP_LOCK, "holder.pid"), "utf8").trim()) || 0;
      } catch {
        holder = 0;
      }
      if (holder > 0 && !isPidAlive(holder)) {
        rmSync(REAL_SWEEP_LOCK, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `real-sweep lock ${REAL_SWEEP_LOCK} (holder pid ${holder || "unknown"}) never released within ${timeoutMs}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(REAL_SWEEP_LOCK, { recursive: true, force: true });
  }
}

async function waitUntilMarkersVisible(pid: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (defaultReadMarkers(pid) === undefined) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`ps eww never published marker env for pid ${pid} within ${timeoutMs}ms`);
    }
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
  // W1-T186 CI-log fix: `exit` fires as soon as the child process terminates,
  // which races the `stderr` stream's own `data`/`end` delivery — on a loaded
  // CI runner (observed on ubuntu-latest, not reproduced locally) the promise
  // can resolve before the piped "boom" chunk has arrived, asserting on a
  // still-empty buffer. `close` fires only after every stdio stream feeding
  // this child has itself emitted `end`/`close`, so by the time it fires the
  // `onStderr` sink is guaranteed to have already received every byte.
  // `SdkSpawnedProcess.on` (worker-containment.ts's return type) only types
  // 'exit'/'error' per the SDK's own SpawnedProcess interface — `close` is a
  // real ChildProcess event underneath (per that module's own doc comment,
  // "ChildProcess already satisfies this interface"), so this test reaches
  // it via the same underlying object, cast back to its real runtime type.
  await new Promise<void>((resolve) => (proc as unknown as ChildProcess).on("close", () => resolve()));
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

// ── Real-world default deps (ps-based) — these prove the ps-parsing logic
// itself against REAL `ps` output, no injection. The CLI-layer wiring that
// plugs these into a live daemon (W1-T356) is proven separately, below.

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
    // W1-T459: WAIT FOR THE CONDITION, not a duration — `ps eww` publishes a brand-new pid's env
    // in 2 ms idle but up to 150 ms under load, so the old fixed beat was a host-speed bet.
    await waitUntilMarkersVisible(marked.pid);
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

// ── W1-T356: the orphan sweep WIRED into the REAL daemonCommand ────────────
// `sweepOrphanWorkers` (above) and `defaultListCandidates`/`defaultReadMarkers` (above) each
// pass in isolation — that already held true while the real `daemonBoot` call site passed
// `undefined` for the whole feature (this task's own rationale: "the production default has
// never run"). This section drives the REAL `daemonCommand` end to end, injecting ONLY the
// existing `runDaemon` loop-stub seam (the same seam test/daemon-crashloop-wiring.test.ts
// uses for the crash-loop escalation wiring) — never a hand-built `OrphanSweepDeps` fixture —
// so a pass here proves the PRODUCTION DEFAULT (the module's own exported
// defaultListCandidates/defaultReadMarkers/killProcessGroup, composed in run-task.ts)
// actually kills a real stray, not that a fixture would have.
//
// THE FALSIFIER (design part v): restoring the boot slot's `undefined` makes the spawned
// stray process survive `daemonCommand` and leaves no `worker_orphan_killed` ledger line —
// this test fails loudly on that regression, by name.

function fixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-orphan-boot-wiring-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  return { home, root, planPath };
}

function ledgerLines(root: string): Array<Record<string, unknown>> {
  return readFileSync(ledgerPathFor({ root } as never), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("W1-T356 wiring: the REAL daemonCommand boots with the orphan sweep wired from the module's own exported defaults — a marker-carrying stray from an ended run is killed and ledgered (worker_orphan_killed), a marker-less process is left alone, alive, and reported (daemon.orphan_sweep)", async () => {
  await withRealSweepLock(async () => {
    const { home, root, planPath } = fixtureHome();
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const strayEnv = {
      ...process.env,
      [RUN_ID_ENV]: "run-ended-w1-t356",
      [TASK_ID_ENV]: "W1-T356-fixture",
      [WORKER_SCOPE_ENV]: workerInstallationScope(root),
    };
    const stray = spawnDetachedGroup({ command: "/bin/sh", args: ["-c", "sleep 300"], env: strayEnv });
    const unrelated = spawnDetachedGroup({ command: "/bin/sh", args: ["-c", "sleep 300"], env: { PATH: process.env.PATH } });
    try {
      // W1-T459: the boot sweep can only attribute this stray once `ps eww` publishes its marker
      // env, so wait for exactly that — same discipline as the direct defaultReadMarkers test above.
      // The UNRELATED process needs no wait: its assertion is that it SURVIVES, which holds whether
      // or not ps has caught up, so polling it would bound nothing.
      await waitUntilMarkersVisible(stray.pid);
      const loopStub = async (): Promise<DaemonSummary> => ({ attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 });
      const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], { runDaemon: loopStub });
      assert.equal(code, 0);

      await waitUntilDead(stray.pid);
      assert.throws(
        () => process.kill(stray.pid, 0),
        /ESRCH/,
        "the real daemonCommand's boot-time sweep (daemonBoot's own sweepOrphanWorkers param) must have killed the attributed stray",
      );
      assert.equal(isPidAlive(unrelated.pid), true, "a marker-less process must never be signalled, no matter how suspicious it looks");

      const lines = ledgerLines(root);
      const killedLine = lines.find((l) => l.step === "worker_orphan_killed" && l.pid === stray.pid);
      assert.ok(killedLine, "the real production ledger dep must record the kill");
      assert.equal(killedLine!.run_id, "run-ended-w1-t356");
      assert.equal(killedLine!.task_id, "W1-T356-fixture");

      const sweepLine = lines.find((l) => l.step === "daemon.orphan_sweep");
      assert.ok(sweepLine, "daemonBoot must log the sweep's own summary — the wired param reached it");
      assert.ok(Number(sweepLine!.killed) >= 1, "the summary count must reflect the real kill");
    } finally {
      safeKillGroup(stray.pid);
      safeKillGroup(unrelated.pid);
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── W1-T459: the beat is a CONDITION POLL, and it must stay one ───────────────────────────────
//
// The defect these replace was a fixed 100 ms sleep before reading `ps eww`. MEASURED on the mini
// (10 cores) by spawning a marked child and polling to first visibility: 2 ms idle, but 48 ms
// median and 150 ms max at load 58-86, with 4 of 25 samples past 100 ms. A bigger constant would
// pass today and fail on a slower host — so these tests pin the SHAPE, not a number.

test("waitUntilMarkersVisible returns as soon as ps publishes the markers — a condition poll, never a fixed beat", async () => {
  const env = { ...process.env, [RUN_ID_ENV]: "run-poll-shape", [TASK_ID_ENV]: "T-poll-shape" };
  const p = spawnDetachedGroup({ command: "/bin/sh", args: ["-c", "sleep 30"], env });
  try {
    const t0 = Date.now();
    await waitUntilMarkersVisible(p.pid);
    const elapsed = Date.now() - t0;
    assert.deepEqual(defaultReadMarkers(p.pid), { runId: "run-poll-shape", taskId: "T-poll-shape" });
    // THE DISCRIMINATOR AGAINST "just sleep longer": a fixed beat always costs its full duration.
    // This returns on the condition, so on an idle host it beats the 100 ms it replaced outright.
    assertWallClockBound(elapsed, 100, `a condition poll returns when the condition holds, not after a duration (took ${elapsed}ms)`);
  } finally {
    safeKillGroup(p.pid);
  }
});

test("waitUntilMarkersVisible THROWS at its ceiling when the markers never appear — a timeout can never read as a pass", async () => {
  // A live process with NO marker env: `defaultReadMarkers` returns undefined forever, which is
  // exactly the never-attributable shape. A poll that gave up quietly would turn every attribution
  // lock in this file into a vacuous pass, so the ceiling must throw.
  const p = spawnDetachedGroup({ command: "/bin/sh", args: ["-c", "sleep 30"], env: { PATH: process.env.PATH } });
  try {
    await assert.rejects(
      () => waitUntilMarkersVisible(p.pid, 200),
      /never published marker env/,
      "the ceiling must reject, never resolve",
    );
    assert.equal(defaultReadMarkers(p.pid), undefined, "and the process really is unattributable — the throw was not spurious");
  } finally {
    safeKillGroup(p.pid);
  }
});

// ── W1-T2350: the cross-file sweep lock is itself a bounded waiter, and must stay one ────────
//
// Same discipline as the W1-T459 pair above: pin the SHAPE, not a number. A lock that gave up
// quietly would let both real sweeps run concurrently again and re-open the exact flake it closes.

test("withRealSweepLock runs the body while holding the lock and releases it on the way out", async () => {
  assert.equal(existsSync(REAL_SWEEP_LOCK), false, "precondition: no lock is held before this test");
  let heldDuringBody = false;
  const got = await withRealSweepLock(async () => {
    heldDuringBody = existsSync(REAL_SWEEP_LOCK);
    return "body-ran";
  });
  assert.equal(got, "body-ran", "the body's value is returned to the caller");
  assert.equal(heldDuringBody, true, "the lock is HELD while the body runs — that is the whole point");
  assert.equal(existsSync(REAL_SWEEP_LOCK), false, "and released afterwards, so the twin file can proceed");
});

test("withRealSweepLock releases even when the body THROWS — a failing sweep test cannot wedge its twin", async () => {
  await assert.rejects(
    () => withRealSweepLock(async () => {
      throw new Error("body blew up");
    }),
    /body blew up/,
    "the body's own error propagates unchanged",
  );
  assert.equal(existsSync(REAL_SWEEP_LOCK), false, "the finally arm released the lock despite the throw");
});

test("withRealSweepLock THROWS at its ceiling rather than running a second real sweep unserialised", async () => {
  // A LIVE holder: this process itself. The reclaim arm must not fire, so the ceiling must.
  mkdirSync(REAL_SWEEP_LOCK);
  writeFileSync(join(REAL_SWEEP_LOCK, "holder.pid"), String(process.pid));
  try {
    await assert.rejects(
      () => withRealSweepLock(async () => "must not run", 100),
      /never released within 100ms/,
      "the ceiling must reject — a quiet give-up would run both sweeps at once again",
    );
  } finally {
    rmSync(REAL_SWEEP_LOCK, { recursive: true, force: true });
  }
});

test("withRealSweepLock reclaims a lock whose holder pid is DEAD — one SIGKILL cannot wedge every later run", async () => {
  const corpse = spawnDetachedGroup({ command: "/bin/sh", args: ["-c", "sleep 30"], env: { PATH: process.env.PATH } });
  safeKillGroup(corpse.pid);
  await waitUntilDead(corpse.pid);
  assert.equal(isPidAlive(corpse.pid), false, "precondition: the recorded holder really is gone");
  mkdirSync(REAL_SWEEP_LOCK);
  writeFileSync(join(REAL_SWEEP_LOCK, "holder.pid"), String(corpse.pid));
  let ran = false;
  try {
    await withRealSweepLock(async () => {
      ran = true;
    }, 2000);
  } finally {
    rmSync(REAL_SWEEP_LOCK, { recursive: true, force: true });
  }
  assert.equal(ran, true, "a dead holder is reclaimed rather than waited out to the ceiling");
});

test("neither declared-flake suite still sleeps a fixed beat before reading ps — the shape, asserted structurally", () => {
  for (const rel of ["worker-containment", "daemon"]) {
    const src = readFileSync(new URL(`./${rel}.test.ts`, import.meta.url), "utf8");
    // ASSEMBLED FROM PARTS ON PURPOSE: this test reads its own file, so a literal needle would
    // match the needle itself and the assertion would fail on a clean tree (it did, first run).
    const oldBeatComment = ["needs a beat", "after spawn"].join(" ");
    assert.ok(
      !src.includes(oldBeatComment),
      `${rel}.test.ts still carries the fixed-beat comment — the host-speed bet is back`,
    );
    // The only remaining bare setTimeouts must be POLL INTERVALS inside a bounded waiter, never a
    // pre-assertion sleep: every one is 20 ms and every waiter throws on its ceiling.
    const beats = [...src.matchAll(/setTimeout\(r, (\d+)\)/g)].map((m) => Number(m[1]));
    assert.ok(beats.length > 0, `${rel}.test.ts should still have poll intervals`);
    assert.deepEqual([...new Set(beats)], [20], `${rel}.test.ts has a non-poll-interval sleep: ${beats.join(",")}`);
  }
});
