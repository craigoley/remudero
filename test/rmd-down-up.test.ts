/**
 * test/rmd-down-up.test.ts — W1-T169: `rmd down` / `rmd up`, the operator lifecycle verbs.
 *
 * Its own file (not appended to test/run-task.test.ts), matching the sibling lifecycle test
 * files (test/serve-plist.test.ts's own header explains why: a coverage-load-bearing file
 * must never share a process with the crash-prone one).
 *
 * Every assertion is over a PURE function or an injected fake — no real launchctl, no real
 * lsof, no real network, no live daemon/serve. Both `downCommand`/`upCommand` take every OS
 * effect as an injectable dependency for exactly this reason.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import {
  defaultPlanLifecycleCounts,
  defaultStopServeByPort,
  downCommand,
  liveInflightRuns,
  loadLaunchdService,
  queryLaunchdService,
  runRecoverability,
  unloadLaunchdService,
  upCommand,
  waitForPortRelease,
  type DownDeps,
  type LiveInflightRun,
  type PlanLifecycleCountsIo,
  type UpDeps,
} from "../src/run-task.js";

function cfg(over: Partial<Config> = {}): Config {
  return { claudeBin: "/bin/true", root: "/nonexistent-down-up-root", ...over } as Config;
}

const noopSleep = async () => {};

// ── queryLaunchdService / loadLaunchdService / unloadLaunchdService — the launchctl seam ────

test("queryLaunchdService: a bootstrapped label with a running pid reports loaded + the pid", () => {
  const calls: Array<[string, string[]]> = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    return "com.remudero.daemon = {\n\tactive count = 1\n\tpid = 61234\n\tpath = /x\n}";
  };
  const state = queryLaunchdService("com.remudero.daemon", 501, exec);
  assert.deepEqual(state, { loaded: true, pid: 61234 });
  assert.deepEqual(calls, [["launchctl", ["print", "gui/501/com.remudero.daemon"]]]);
});

test("queryLaunchdService: loaded but not yet running (no pid line) reports loaded with a null pid", () => {
  const exec = () => "com.remudero.daemon = {\n\tstate = waiting\n}";
  const state = queryLaunchdService("com.remudero.daemon", 501, exec);
  assert.deepEqual(state, { loaded: true, pid: null });
});

test("queryLaunchdService: a non-bootstrapped label (launchctl exits non-zero) reports NOT loaded, never throws", () => {
  const exec = (): string => {
    throw new Error("Could not find service \"com.remudero.daemon\" in domain for gui/501");
  };
  const state = queryLaunchdService("com.remudero.daemon", 501, exec);
  assert.deepEqual(state, { loaded: false, pid: null });
});

test("loadLaunchdService: bootstraps the GUI domain with the plist path", () => {
  const calls: Array<[string, string[]]> = [];
  loadLaunchdService("/h/Library/LaunchAgents/com.remudero.daemon.plist", 501, (cmd, args) => {
    calls.push([cmd, args]);
    return "";
  });
  assert.deepEqual(calls, [["launchctl", ["bootstrap", "gui/501", "/h/Library/LaunchAgents/com.remudero.daemon.plist"]]]);
});

test("queryLaunchdService: with NO exec override at all, the real launchctl subprocess seam is used — an absent binary/label still reports NOT loaded, never throws", () => {
  // Exercises defaultLifecycleExec's own real execFileSync call (never stubbed here) — a
  // synthetic, never-bootstrapped label is safe on any host: macOS's real launchctl exits
  // non-zero for an unknown service, and a CI runner with no launchctl binary at all throws
  // ENOENT instead. Either way queryLaunchdService's own catch turns it into `loaded: false`,
  // so this is deterministic and side-effect-free on both platforms.
  const state = queryLaunchdService(`com.remudero.rmd-down-up-test-nonexistent-${Date.now()}`, 501);
  assert.deepEqual(state, { loaded: false, pid: null });
});

test("unloadLaunchdService: boots the service out BY LABEL, not by plist path", () => {
  const calls: Array<[string, string[]]> = [];
  unloadLaunchdService("com.remudero.daemon", 501, (cmd, args) => {
    calls.push([cmd, args]);
    return "";
  });
  assert.deepEqual(calls, [["launchctl", ["bootout", "gui/501/com.remudero.daemon"]]]);
});

// ── defaultStopServeByPort — never an argv/pattern kill ──────────────────────────────────────

test("defaultStopServeByPort: SIGTERMs every pid lsof names as LISTENing on the port", () => {
  const killed: Array<[number, string]> = [];
  const originalKill = process.kill;
  process.kill = ((pid: number, sig?: string | number) => {
    killed.push([pid, String(sig)]);
    return true;
  }) as typeof process.kill;
  try {
    defaultStopServeByPort(4317, (cmd, args) => {
      assert.equal(cmd, "lsof");
      assert.deepEqual(args, ["-ti", ":4317", "-sTCP:LISTEN"]);
      return "6001\n6002\n";
    });
    assert.deepEqual(killed, [
      [6001, "SIGTERM"],
      [6002, "SIGTERM"],
    ]);
  } finally {
    process.kill = originalKill;
  }
});

test("defaultStopServeByPort: nothing listening (lsof exits non-zero) kills nothing, never throws", () => {
  assert.doesNotThrow(() => {
    defaultStopServeByPort(4317, () => {
      throw new Error("exit 1");
    });
  });
});

// ── waitForPortRelease — the reap-wait ────────────────────────────────────────────────────────

test("waitForPortRelease: resolves true as soon as every host stops listening", async () => {
  let calls = 0;
  const isListening = async () => {
    calls++;
    return calls < 3; // listening for the first two polls, released on the third
  };
  const sleeps: number[] = [];
  const released = await waitForPortRelease(["127.0.0.1"], 4317, isListening, {
    attempts: 10,
    delayMs: 1,
    sleep: async (ms) => void sleeps.push(ms),
  });
  assert.equal(released, true);
  assert.equal(sleeps.length, 2, "slept between the two still-listening polls, not after the released one");
});

test("waitForPortRelease: gives up after `attempts` and resolves false — never hangs forever", async () => {
  const released = await waitForPortRelease(["127.0.0.1"], 4317, async () => true, {
    attempts: 3,
    delayMs: 0,
    sleep: noopSleep,
  });
  assert.equal(released, false);
});

// ── liveInflightRuns — the in-flight signal (inflight-lock.ts) ───────────────────────────────

function withInflightLockFile(dir: string, taskId: string, info: { pid: number; run_id: string }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}.lock`), JSON.stringify({ ...info, host: "h", startedAt: "2026-07-30T00:00:00.000Z" }));
}

test("liveInflightRuns: a lock whose pid is alive is reported live", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inflight-"));
  withInflightLockFile(dir, "W1-T1", { pid: 999, run_id: "W1-T1-1690000000000" });
  const live = liveInflightRuns(dir, (pid) => pid === 999);
  assert.deepEqual(live, [{ taskId: "W1-T1", runId: "W1-T1-1690000000000", pid: 999 }]);
});

test("liveInflightRuns: a lock whose pid is dead is stale debris, not reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inflight-"));
  withInflightLockFile(dir, "W1-T1", { pid: 999, run_id: "W1-T1-1690000000000" });
  const live = liveInflightRuns(dir, () => false);
  assert.deepEqual(live, []);
});

test("liveInflightRuns: an absent inflight directory reports no live runs, never throws", () => {
  assert.deepEqual(liveInflightRuns(join(tmpdir(), "rmd-inflight-never-created-" + Date.now())), []);
});

// ── runRecoverability — has-PR vs pre-PR, straight from the ledger ───────────────────────────

test("runRecoverability: a pr.opened line for this run_id is has-pr (the sweep recovers it)", () => {
  const lines = [
    { run_id: "W1-T1-1", task_id: "W1-T1", step: "run.start" },
    { run_id: "W1-T1-1", task_id: "W1-T1", step: "pr.opened", pr_url: "https://x/1" },
  ];
  assert.equal(runRecoverability(lines, "W1-T1-1"), "has-pr");
});

test("runRecoverability: no pr.opened line for this run_id is pre-pr (it re-dispatches)", () => {
  const lines = [{ run_id: "W1-T1-1", task_id: "W1-T1", step: "run.start" }];
  assert.equal(runRecoverability(lines, "W1-T1-1"), "pre-pr");
});

// ── defaultPlanLifecycleCounts — the REAL default, over an injected io bundle (never a live
// plan/gh read) ───────────────────────────────────────────────────────────────────────────

function fakeProjection(rows: Array<{ prState?: string; needsHuman?: boolean }>): Map<string, unknown> {
  const m = new Map<string, unknown>();
  rows.forEach((r, i) => m.set(`T${i}`, r));
  return m;
}

test("defaultPlanLifecycleCounts: sums open-PR / needs-human counts from the injected projection — no real plan/gh read", () => {
  const io: PlanLifecycleCountsIo = {
    loadPlan: () => ({ tasks: [] }) as never,
    resolveOwnerRepo: () => ({ owner: "acme", repo: "widgets" }),
    projectPlan: () =>
      fakeProjection([{ prState: "OPEN" }, { prState: "OPEN", needsHuman: true }, { prState: "MERGED" }, { needsHuman: true }]) as never,
    ghGateway: () => ({}) as never,
  };
  const counts = defaultPlanLifecycleCounts(cfg(), io);
  assert.deepEqual(counts, { openPr: 2, needsHuman: 2 });
});

test("defaultPlanLifecycleCounts: any io step throwing (plan/gh unreachable) degrades to null, never throws — matches board.ts's github_unreachable direction", () => {
  const counts = defaultPlanLifecycleCounts(cfg(), {
    loadPlan: () => {
      throw new Error("ENOENT: plan/tasks.yaml");
    },
  });
  assert.equal(counts, null);
});

// ── downCommand ────────────────────────────────────────────────────────────────────────────

function downDeps(over: Partial<DownDeps> = {}): { out: string[]; err: string[]; deps: DownDeps } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: DownDeps = {
    loadConfig: () => cfg(),
    queryDaemon: () => ({ loaded: false, pid: null }),
    unloadDaemon: () => assert.fail("unloadDaemon must not be called"),
    isPortListening: async () => false,
    stopServeByPort: () => assert.fail("stopServeByPort must not be called"),
    liveInflightRuns: () => [],
    planLifecycleCounts: () => ({ openPr: 3, needsHuman: 1 }),
    sleep: noopSleep,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { out, err, deps };
}

test("down: already down (daemon unloaded, port free) is a no-op — honest report, zero side effects", async () => {
  const { out, deps } = downDeps();
  const rc = await downCommand([], deps);
  assert.equal(rc, 0);
  const text = out.join("\n");
  assert.match(text, /daemon service:\s+already down/);
  assert.match(text, /serve \(:\d+\):\s+already down/);
  assert.match(text, /in-flight:\s+none/);
  assert.match(text, /safe to restart:\s+yes/);
});

test("down: unloads the daemon and stops serve BY PORT, leaving no listener behind (reap-wait confirms release)", async () => {
  let listening = true;
  let unloaded = false;
  let stoppedHosts: string[] = [];
  const { out, deps } = downDeps({
    queryDaemon: () => ({ loaded: true, pid: 555 }),
    unloadDaemon: () => {
      unloaded = true;
    },
    isPortListening: async () => listening,
    stopServeByPort: (h) => {
      stoppedHosts.push(h);
      listening = false; // the stop is what releases the port, observed on the next poll
    },
  });
  const rc = await downCommand(["--host", "127.0.0.1"], deps);
  assert.equal(rc, 0, "no listener remains on the serve port");
  assert.equal(unloaded, true);
  assert.deepEqual(stoppedHosts, ["127.0.0.1"]);
  const text = out.join("\n");
  assert.match(text, /daemon service:\s+unloaded/);
  assert.match(text, /stopped — port released/);
  assert.match(text, /safe to restart:\s+yes/);
});

test("down: a port that never releases after the reap-wait is reported unsafe, exit 1", async () => {
  const { out, deps } = downDeps({
    queryDaemon: () => ({ loaded: false, pid: null }),
    isPortListening: async () => true,
    stopServeByPort: () => {},
    reapAttempts: 2,
    reapDelayMs: 0,
  });
  const rc = await downCommand([], deps);
  assert.equal(rc, 1);
  assert.match(out.join("\n"), /STILL HELD after the reap-wait/);
  assert.match(out.join("\n"), /safe to restart:\s+NO/);
});

test("down: an in-flight run that does not clear within the safe-boundary wait is REPORTED with its run id + has-PR recoverability, and the daemon still unloads", async () => {
  const run: LiveInflightRun = { taskId: "W1-T7", runId: "W1-T7-1690000000000", pid: 4242 };
  let unloaded = false;
  const { out, deps } = downDeps({
    queryDaemon: () => ({ loaded: true, pid: 1 }),
    unloadDaemon: () => {
      unloaded = true;
    },
    liveInflightRuns: () => [run],
    readLedgerLines: () => [{ run_id: run.runId, task_id: run.taskId, step: "pr.opened", pr_url: "https://x/9" }],
    safeBoundaryAttempts: 2,
    safeBoundaryDelayMs: 0,
  });
  const rc = await downCommand([], deps);
  assert.equal(rc, 0);
  assert.equal(unloaded, true, "wind-down proceeds even though the run never reached a safe boundary");
  const text = out.join("\n");
  assert.match(text, /W1-T7/);
  assert.match(text, /W1-T7-1690000000000/);
  assert.match(text, /has a PR: the sweep recovers it next start/);
});

test("down: pre-PR in-flight run is reported as re-dispatching, not sweep-recoverable", async () => {
  const run: LiveInflightRun = { taskId: "W1-T8", runId: "W1-T8-1690000000001", pid: 4243 };
  const { out, deps } = downDeps({
    queryDaemon: () => ({ loaded: true, pid: 1 }),
    unloadDaemon: () => {},
    liveInflightRuns: () => [run],
    readLedgerLines: () => [],
    safeBoundaryAttempts: 1,
    safeBoundaryDelayMs: 0,
  });
  await downCommand([], deps);
  assert.match(out.join("\n"), /pre-PR: it re-dispatches next start/);
});

test("down: an in-flight run that clears WITHIN the safe-boundary wait is reported as none — a clean shutdown", async () => {
  let polls = 0;
  const { out, deps } = downDeps({
    queryDaemon: () => ({ loaded: true, pid: 1 }),
    unloadDaemon: () => {},
    liveInflightRuns: () => {
      polls++;
      return polls === 1 ? [{ taskId: "W1-T9", runId: "W1-T9-1", pid: 1 }] : [];
    },
    safeBoundaryAttempts: 5,
    safeBoundaryDelayMs: 0,
  });
  await downCommand([], deps);
  assert.match(out.join("\n"), /in-flight:\s+none/);
});

test("down: unknown argument refuses with exit 2, spawning nothing", async () => {
  const { deps } = downDeps();
  const rc = await downCommand(["--bogus"], deps);
  assert.equal(rc, 2);
});

test("down: an invalid --port value is refused via the port/host resolution catch, exit 2, nothing touched", async () => {
  const { err, deps } = downDeps();
  const rc = await downCommand(["--port", "notanumber"], deps);
  assert.equal(rc, 2);
  assert.match(err.join("\n"), /rmd down —.*--port must be an integer/);
});

// ── upCommand ──────────────────────────────────────────────────────────────────────────────

function upDeps(over: Partial<UpDeps> = {}): { out: string[]; err: string[]; order: string[]; deps: UpDeps } {
  const out: string[] = [];
  const err: string[] = [];
  const order: string[] = [];
  // Self-consistent defaults: "loaded"/"listening" reflect whether the load call already
  // happened THIS invocation, so every test gets a realistic not-up -> up transition for free,
  // and a test overriding `queryDaemon`/`isPortListening` to pre-seed "already up" can assert
  // the load functions are NEVER reached (idempotency) by overriding those too.
  let daemonPid = 0;
  let serveStarted = false;
  const deps: UpDeps = {
    loadConfig: () => cfg(),
    ensureInstallFresh: () => {
      order.push("install-freshness");
      return false;
    },
    currentBranch: () => "main",
    queryDaemon: () => ({ loaded: daemonPid > 0, pid: daemonPid || null }),
    daemonPlistExists: () => true,
    loadDaemonService: () => {
      order.push("load-daemon");
      daemonPid = 61234;
    },
    isPortListening: async () => serveStarted,
    servePlistExists: () => true,
    loadServeService: () => {
      order.push("load-serve");
      serveStarted = true;
    },
    liveInflightRuns: () => [],
    planLifecycleCounts: () => ({ openPr: 0, needsHuman: 0 }),
    consoleUrlCommand: async (_rest, _config, d) => {
      d?.out?.(`    console:     http://127.0.0.1:4317/?token=synthetic`);
      return 0;
    },
    sleep: noopSleep,
    bootPollAttempts: 1,
    bootPollDelayMs: 0,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { out, err, order, deps };
}

test("up: install-freshness runs FIRST — before the daemon or serve is ever loaded", async () => {
  const { order, deps } = upDeps();
  const rc = await upCommand([], deps);
  assert.equal(rc, 0);
  assert.deepEqual(order, ["install-freshness", "load-daemon", "load-serve"]);
});

test("up: REFUSES an off-main checkout without an override — nothing is loaded", async () => {
  const { order, err, deps } = upDeps({ currentBranch: () => "feature/risky" });
  const rc = await upCommand([], deps);
  assert.equal(rc, 1);
  assert.deepEqual(order, ["install-freshness"], "install-freshness still ran; nothing past the refusal did");
  assert.match(err.join("\n"), /REFUSING to resume.*feature\/risky/s);
});

test("up: an explicit --allow-off-main override proceeds past the refusal", async () => {
  const { order, deps } = upDeps({ currentBranch: () => "feature/risky" });
  const rc = await upCommand(["--allow-off-main"], deps);
  assert.equal(rc, 0);
  assert.ok(order.includes("load-daemon"));
});

test("up: a branch that cannot be determined (null) is never treated as off-main", async () => {
  const { deps } = upDeps({ currentBranch: () => null });
  const rc = await upCommand([], deps);
  assert.equal(rc, 0);
});

test("up: already up (daemon loaded, serve listening) verifies + reports — never a double start", async () => {
  const { out, order, deps } = upDeps({
    queryDaemon: () => ({ loaded: true, pid: 61234 }),
    loadDaemonService: () => assert.fail("loadDaemonService must not be called when already up"),
    isPortListening: async () => true,
    loadServeService: () => assert.fail("loadServeService must not be called when already up"),
  });
  const rc = await upCommand([], deps);
  assert.equal(rc, 0);
  assert.deepEqual(order, ["install-freshness"]);
  const text = out.join("\n");
  assert.match(text, /daemon:\s+running \(already up\) \(pid 61234\)/);
  assert.match(text, /serve \(:\d+\):\s+listening \(already up\)/);
});

test("up: the resume report includes the console URL WITH its token", async () => {
  const { out, deps } = upDeps();
  const rc = await upCommand([], deps);
  assert.equal(rc, 0);
  const consoleLine = out.find((l) => l.includes("console:"));
  assert.ok(consoleLine, "a console: line must be printed in the resume report");
  assert.match(consoleLine!, /token=/);
});

test("up: a daemon plist that was never generated is reported as not installed, never a crash", async () => {
  const { out, deps } = upDeps({ daemonPlistExists: () => false, queryDaemon: () => ({ loaded: false, pid: null }) });
  const rc = await upCommand([], deps);
  assert.equal(rc, 0, "serve still came up fine — the daemon simply was never installed");
  assert.match(out.join("\n"), /not installed/);
});

test("up: unknown argument refuses with exit 2", async () => {
  const { deps } = upDeps();
  const rc = await upCommand(["--bogus"], deps);
  assert.equal(rc, 2);
});

test("up: an invalid --port value is refused via the port/host resolution catch, exit 2 — after install-freshness, before anything loads", async () => {
  const { order, err, deps } = upDeps();
  const rc = await upCommand(["--port", "notanumber"], deps);
  assert.equal(rc, 2);
  assert.deepEqual(order, ["install-freshness"], "install-freshness already ran by this point; nothing past it did");
  assert.match(err.join("\n"), /rmd up —.*--port must be an integer/);
});

test("up: serve fails to come up despite a plist being present is reported FAILED, exit 1", async () => {
  const { out, deps } = upDeps({ isPortListening: async () => false });
  const rc = await upCommand([], deps);
  assert.equal(rc, 1);
  assert.match(out.join("\n"), /serve \(:\d+\):\s+FAILED to come up — check state\/logs\/serve\.err\.log/);
});
