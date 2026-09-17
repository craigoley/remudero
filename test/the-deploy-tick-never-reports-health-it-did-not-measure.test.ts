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
import { test } from "node:test";

import { decideDeployTrigger, runDeployCycle, type DeployDeps, type IdleProbe } from "../src/lib/deployer.js";

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
