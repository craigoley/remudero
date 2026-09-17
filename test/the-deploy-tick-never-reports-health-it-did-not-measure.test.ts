/**
 * W1-T3694 — MEASURED 2026-09-16 on the Azure host. Every deploy tick in the window recorded
 * the same line:
 *
 *   deploy.skip  reason="up-to-date (install HEAD == origin/main; daemon liveness not observed)"
 *
 * while the daemon was behind origin/main and its reviewer was refusing to post verdicts
 * (`review.skipped_stale_reviewer_code`, six pull requests, over an hour). The operator
 * fast-forwarded the daemon's tree BY HAND THREE TIMES in one afternoon; each time reviews
 * resumed within seconds.
 *
 * THIS IS NOT A REQUEST TO UNDO W1-T3245: the watchdog tick (`imageDriftOnly`) still declines to
 * restart on mount staleness alone — that stays the daemon's own freshness check's job. What was
 * wrong was REPORTING "up-to-date" while declining to look: the tick never observed liveness (no
 * caller supplied `daemonAlive` — FACT 1) and deliberately discarded `runningStale` it had
 * already computed (FACT 2) — and the skip line said "up-to-date" through both.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decideDeployTrigger, runDeployCycle, type DeployDeps, type IdleProbe } from "../src/lib/deployer.js";
import { main } from "../src/run-task.js";
import { SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";

// ── claim 1: an unobserved liveness tick does not report up-to-date ─────────────────────────

test("an unobserved-liveness tick does not report up-to-date, so an unmeasured quantity is never rendered healthy", () => {
  // daemonAlive omitted ⇒ undefined ⇒ never observed. Checkout and daemon boot sha both match, so
  // the OLD code took this straight into the "up-to-date" branch.
  const d = decideDeployTrigger({
    markerPresent: false,
    autoMode: true,
    installHead: "same",
    originMain: "same",
    runningHead: "same",
  });
  assert.equal(d.deploy, false, "an unobserved daemon must not be restarted on no evidence either");
  assert.doesNotMatch(d.reason, /up-to-date/, "unmeasured liveness must never be reported healthy");
  assert.match(d.reason, /liveness not observed/, "the reason names what it could not measure");
  assert.equal(d.satisfied, undefined, "an unobserved fleet never consumes an operator's request");
});

test("an OBSERVED-alive, fully current tick still reports up-to-date — the one case it is true", () => {
  const d = decideDeployTrigger({
    markerPresent: false,
    autoMode: true,
    installHead: "same",
    originMain: "same",
    runningHead: "same",
    daemonAlive: true,
  });
  assert.equal(d.deploy, false);
  assert.match(d.reason, /up-to-date/, "checkout AND liveness were both actually measured here");
  assert.equal(d.satisfied, true);
});

// ── claim 2: an ignored runningStale is named in the skip reason ────────────────────────────

test("the watchdog tick names an ignored runningStale instead of omitting it", () => {
  // imageDriftOnly discards `behind`/`runningStale` from `restartReasons` by design (W1-T3245) —
  // but the running daemon really is on old code here, and the tick must say so.
  const d = decideDeployTrigger({
    markerPresent: false,
    autoMode: true,
    installHead: "current",
    originMain: "current",
    runningHead: "stale-boot-sha",
    daemonAlive: true, // observed ALIVE — still not "up-to-date": it is running old code
    imageDriftOnly: true,
  });
  assert.equal(d.deploy, false, "the tick still declines to restart on mount staleness alone");
  assert.doesNotMatch(d.reason, /up-to-date/, "a daemon known to be on stale code is not up-to-date");
  assert.match(d.reason, /running stale code/, "the ignored runningStale is named, not folded away");
  assert.match(d.reason, /stale-boot-sha/, "the actual running sha is named, not just the fact");
  assert.equal(d.satisfied, undefined, "a request must not be consumed while the daemon runs old code");
});

test("the watchdog tick names an ignored-but-UNRECORDED runningStale distinctly from a named sha", () => {
  // `runningHead` omitted ⇒ undefined ⇒ `sameCommit` reads it as NOT matching (fail-eager, this
  // module's own header) — so `runningStaleIgnoredByTick` is still true, but there is no sha to
  // name, and the reason text must say so rather than interpolating "undefined".
  const d = decideDeployTrigger({
    markerPresent: false,
    autoMode: true,
    installHead: "current",
    originMain: "current",
    // runningHead intentionally omitted
    daemonAlive: true,
    imageDriftOnly: true,
  });
  assert.equal(d.deploy, false);
  assert.doesNotMatch(d.reason, /up-to-date/, "an unrecorded running head is not up-to-date either");
  assert.doesNotMatch(d.reason, /undefined/, "never interpolate the literal string \"undefined\" into an operator-facing reason");
  assert.match(d.reason, /running head not recorded/, "the reason names WHY no sha could be named");
  assert.match(d.reason, /mount staleness cannot be ruled out/, "and that the tick still declines to act on it either way");
  assert.equal(d.satisfied, undefined);
  assert.equal(d.blocker, undefined, "no sha to name means no blocker DATA either — the reason's prose carries this one alone");
});

test("the SAME inputs outside the watchdog tick's imageDriftOnly reading restart instead of skip", () => {
  // W1-T3240/pre-existing: the full reading (rmd deploy) acts on runningStale directly — this
  // pins that this task changed REPORTING under imageDriftOnly, never the full reading's action.
  const d = decideDeployTrigger({
    markerPresent: false,
    autoMode: true,
    installHead: "current",
    originMain: "current",
    runningHead: "stale-boot-sha",
    daemonAlive: true,
  });
  assert.equal(d.deploy, true, "the full reading restarts on runningStale — unchanged by this task");
});

// ── claim 4: the tick still does not restart on runningStale alone ──────────────────────────

test("W1-T3245's separation is preserved: the tick never restarts on runningStale by itself", () => {
  for (const daemonAlive of [true, false, undefined] as const) {
    const d = decideDeployTrigger({
      markerPresent: false,
      autoMode: true,
      installHead: "current",
      originMain: "current",
      runningHead: "stale-boot-sha",
      daemonAlive,
      stopPresent: daemonAlive === false ? true : false, // never trip the SEPARATE liveness-restart arm
      imageDriftOnly: true,
    });
    assert.equal(d.deploy, false, `imageDriftOnly must decline to restart on runningStale alone (daemonAlive=${daemonAlive})`);
  }
  // Image drift is a DIFFERENT event, and the tick's own business: it must still act on it even
  // while runningStale is present and ignored — the two questions stay independent.
  const imageDrifted = decideDeployTrigger({
    markerPresent: false,
    autoMode: true,
    installHead: "current",
    originMain: "current",
    runningHead: "stale-boot-sha",
    daemonAlive: true,
    imageDriftOnly: true,
    imageBakedCommitsBehind: 1,
  });
  assert.equal(imageDrifted.deploy, true, "image drift still fires the tick's own recycle, unaffected by runningStale");
});

// ── claim 5: a stale-running daemon renders as a blocker naming both shas ───────────────────

test("a stale-running daemon the tick declines to act on renders as a blocker naming both shas", () => {
  const d = decideDeployTrigger({
    markerPresent: false,
    autoMode: true,
    installHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    originMain: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    runningHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    daemonAlive: true,
    imageDriftOnly: true,
  });
  assert.equal(d.deploy, false);
  assert.ok(d.blocker, "the standing state must be named as DATA, not only in reason's prose");
  assert.equal(d.blocker!.kind, "stale_running_daemon");
  assert.equal(d.blocker!.runningHead, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(d.blocker!.originMain, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.match(d.blocker!.note, /W1-T3245/, "the blocker names why the tick did not act, not just that it didn't");
});

test("no blocker when the daemon is genuinely current — a healthy fleet renders no row", () => {
  const d = decideDeployTrigger({
    markerPresent: false,
    autoMode: true,
    installHead: "same",
    originMain: "same",
    runningHead: "same",
    daemonAlive: true,
    imageDriftOnly: true,
  });
  assert.equal(d.blocker, undefined);
});

test("no blocker outside the watchdog tick's imageDriftOnly reading — the full reading just restarts instead", () => {
  const d = decideDeployTrigger({
    markerPresent: false,
    autoMode: true,
    installHead: "current",
    originMain: "current",
    runningHead: "stale-boot-sha",
    daemonAlive: true,
  });
  assert.equal(d.deploy, true);
  assert.equal(d.blocker, undefined, "a state the tick is actually ACTING on is not a standing blocker");
});

test("runDeployCycle carries the blocker through to its result and the ledger row — legible without a ledger tail", () => {
  const logs: Array<{ step: string; data?: Record<string, unknown> }> = [];
  const deps: DeployDeps = {
    log: (step, data) => logs.push({ step, data }),
    now: () => 1000,
    fetch: () => {},
    installHead: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    originMain: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    markerPresent: () => false,
    autoMode: () => true,
    lastFailedHead: () => undefined,
    daemonAlive: () => true,
    stopPresent: () => false,
    runningHead: () => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    dirtyFiles: () => [],
    incomingFiles: () => [],
    pullFf: () => {},
    resetHard: () => {},
    probeIdle: (): IdleProbe => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => {},
    waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }),
    alert: () => {},
    clearMarker: () => {},
    kickstartConsole: () => {},
    consolePid: () => 1,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
  };

  const result = runDeployCycle(deps, { imageDriftOnly: true });
  assert.equal(result.deployed, false);
  assert.ok(result.blocker, "the result itself names the blocker — a caller need not re-parse reason");
  assert.equal(result.blocker!.runningHead, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(result.blocker!.originMain, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  const skipRow = logs.find((l) => l.step === "deploy.skip");
  assert.ok(skipRow, "the skip is still ledgered");
  assert.deepEqual(skipRow!.data?.blocker, result.blocker, "the ledger row and the return value never disagree");
});

// ── claim 6: `rmd deploy-run` itself — the CLI entry, not just decideDeployTrigger's pure
// function — wires a REAL daemonAlive producer and prints the blocker line ─────────────────
//
// Every test above drives `decideDeployTrigger`/`runDeployCycle` directly with injected
// `DeployDeps`. Nothing yet drove `deployRunCommand` (run-task.ts) itself, which is the one
// place FACT 1 actually lived: no caller anywhere in src/ ever supplied `daemonAlive`. This
// exercises the REAL wiring end to end — a real git install root, the real `queryLaunchdServiceSensed`
// / `queryProcessServiceSensed` sensor chain, and the real stdout the operator reads.

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** A real bare origin + a clone on `main`, HEAD == origin/main — "healthy" per
 *  `inspectInstallRoot`, the same real-git discipline test/install-root.test.ts's own
 *  `buildOrigin`/`cloneFrom` use (not imported from there — that file is outside this task's
 *  declared scope, so this is a small local duplicate, not a shared helper). */
function healthyInstallRoot(dir: string): { installDir: string; headSha: string } {
  const originDir = join(dir, "origin.git");
  const seedDir = join(dir, "seed");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", originDir]);
  execFileSync("git", ["init", "--quiet", "-b", "main", seedDir]);
  git(seedDir, ["config", "user.email", "t@example.invalid"]);
  git(seedDir, ["config", "user.name", "Test"]);
  git(seedDir, ["remote", "add", "origin", originDir]);
  writeFileSync(join(seedDir, "marker.txt"), "v1\n");
  git(seedDir, ["add", "."]);
  git(seedDir, ["commit", "--quiet", "-m", "v1"]);
  git(seedDir, ["push", "--quiet", "origin", "main"]);

  const installDir = join(dir, "install");
  execFileSync("git", ["clone", "--quiet", originDir, installDir]);
  const headSha = git(installDir, ["rev-parse", "HEAD"]);
  return { installDir, headSha };
}

class ProcessExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** Mirrors test/w1-t143-diff-coverage.test.ts's own callMain(): process.exit mocked to throw
 *  (never a real exit), console silenced but recorded. */
async function callMain(t: import("node:test").TestContext, argv: string[]): Promise<{ code: number | undefined; logs: string[] }> {
  const logs: string[] = [];
  const exitMock = ((code?: number): never => {
    throw new ProcessExitCalled(code);
  }) as typeof process.exit;
  t.mock.method(process, "exit", exitMock);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  t.mock.method(console, "warn", () => {});

  const originalArgv = process.argv;
  process.argv = argv;
  const originalGuardEnv = process.env[SELF_SYNC_GUARD_ENV];
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  try {
    let caught: unknown;
    await main().catch((e) => { caught = e; });
    assert.ok(caught instanceof ProcessExitCalled, `main() must reach process.exit, not some other throw: ${String(caught)}`);
    return { code: (caught as ProcessExitCalled).code, logs };
  } finally {
    process.argv = originalArgv;
    if (originalGuardEnv === undefined) delete process.env[SELF_SYNC_GUARD_ENV];
    else process.env[SELF_SYNC_GUARD_ENV] = originalGuardEnv;
  }
}

test("`rmd deploy-run --image-drift-only`, against a real install root, reaches the real daemonAlive producer and prints the blocker line", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t3694-deployrun-"));
  const { installDir, headSha } = healthyInstallRoot(dir);
  const home = join(dir, "home");
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/bin/true", root, installRoot: installDir }),
  );
  // A STOP marker present sidesteps the SEPARATE "daemon not running, no STOP set" restart arm
  // (decideDeployTrigger's own first branch) — this test's claim is about the BLOCKER branch,
  // not that unrelated one, and a real (un-faked) daemonAlive() reads false with no daemon
  // process actually running under this test.
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "STOP"), "");
  // A stale `daemon.boot` line — the running daemon's own last-recorded sha, deliberately NOT
  // `headSha`, so runningHead != installHead == originMain: the checkout is current but the
  // daemon is not, exactly the standing state W1-T3694 exists to surface as a blocker.
  const staleSha = "b".repeat(40);
  writeFileSync(join(root, "state", "ledger.ndjson"), `{"step":"daemon.boot","head_sha":"${staleSha}"}\n`);

  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { code, logs } = await callMain(t, ["node", "run-task.js", "deploy-run", "--image-drift-only"]);
    assert.equal(code, 0, "a skip (never a dirty-tree-conflict/rollback) exits 0");
    const blockerLine = logs.find((l) => l.includes("BLOCKER:"));
    assert.ok(blockerLine, `expected a BLOCKER line in stdout, saw:\n${logs.join("\n")}`);
    assert.match(blockerLine!, new RegExp(staleSha), "the blocker names the actual running sha");
    assert.match(blockerLine!, new RegExp(headSha), "the blocker names the actual origin/main sha");
  } finally {
    process.env.HOME = oldHome;
  }
});
