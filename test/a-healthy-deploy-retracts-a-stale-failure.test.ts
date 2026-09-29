import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deployFailedAlertPath,
  deployLastFailedPath,
  realDeployDeps,
  runDeployCycle,
  type DeployDeps,
} from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// MEASURED 2026-09-29: core, console and site each held a state/DEPLOY_FAILED written days before
// their newest `deploy.ok` (site: a 09-27 health-check rollback, then deploy.ok on 09-29), because
// the healthy branch consumed only the operator marker and nothing else ever unlinked the latch.

function cycleDeps(healthy: boolean, calls: string[]): DeployDeps {
  return {
    log: () => {},
    now: () => Date.parse("2026-09-29T13:00:00Z"),
    fetch: () => {},
    installHead: () => "old",
    runningHead: () => "old",
    originMain: () => "new",
    markerPresent: () => true,
    autoMode: () => false,
    lastFailedHead: () => "older-failed-head",
    dirtyFiles: () => [],
    incomingFiles: () => [],
    discardLocal: () => {},
    pullFf: () => {},
    resetHard: () => {},
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => {},
    restartBackends: () => [{ name: "recycle-container", probe: () => true, describe: () => "recycle-container", restart: () => {} }],
    waitBootHealth: () => ({ bootObserved: healthy, crashCount: 0 }),
    alert: () => calls.push("alert"),
    clearMarker: () => {},
    clearFailure: () => calls.push("clearFailure"),
    kickstartConsole: () => {},
    consolePid: () => 1,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
    deferredSince: () => undefined,
    setDeferredSince: () => {},
    clearDeferredSince: () => {},
  } as unknown as DeployDeps;
}

test("a healthy deploy retracts the recorded failure", () => {
  const calls: string[] = [];
  const out = runDeployCycle(cycleDeps(true, calls));
  assert.equal(out.deployed, true, out.reason);
  assert.deepEqual(calls, ["clearFailure"]);
});

test("a rolled-back deploy records its failure and never retracts it", () => {
  const calls: string[] = [];
  const out = runDeployCycle(cycleDeps(false, calls));
  assert.equal(out.deployed, false, out.reason);
  assert.ok(calls.includes("alert"), calls.join(","));
  assert.ok(!calls.includes("clearFailure"), calls.join(","));
});

test("the shipped clearFailure removes both failure files and tolerates their absence", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}deploy-failed-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(deployFailedAlertPath(root), JSON.stringify({ kind: "health-check-rollback", failedHead: "a696fc7" }));
  writeFileSync(deployLastFailedPath(root), "a696fc7");
  const deps = realDeployDeps({
    installPath: root,
    stateRoot: root,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 4317,
    uid: 501,
    ledgerPath: join(root, "ledger.ndjson"),
    log: () => {},
    sleep: () => {},
  });
  assert.equal(deps.lastFailedHead(), "a696fc7");
  deps.clearFailure!();
  assert.equal(existsSync(deployFailedAlertPath(root)), false);
  assert.equal(existsSync(deployLastFailedPath(root)), false);
  assert.equal(deps.lastFailedHead(), undefined);
  deps.clearFailure!();
});
