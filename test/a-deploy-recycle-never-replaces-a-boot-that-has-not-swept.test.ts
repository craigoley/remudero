import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BOOT_SETTLING_BACKSTOP_MS,
  daemonIsIdle,
  deployLedgerPath,
  realDeployDeps,
  runDeployCycle,
  type DeployDeps,
  type IdleProbe,
} from "../src/lib/deployer.js";

/** A real probe over a temp state root whose ledger holds `rows`; pgrep reports a TRUE zero. */
function probeWith(rows: string[], run: (probe: () => IdleProbe) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rmd-boot-settling-"));
  try {
    const ledger = deployLedgerPath(root);
    mkdirSync(dirname(ledger), { recursive: true });
    mkdirSync(join(root, "state", "inflight"), { recursive: true });
    mkdirSync(join(root, "worktrees"), { recursive: true });
    writeFileSync(ledger, rows.join("\n") + "\n");
    const deps = realDeployDeps({
      installPath: "/inst",
      stateRoot: root,
      daemonLabel: "d",
      serveLabel: "s",
      servePort: 4317,
      uid: 1,
      ledgerPath: ledger,
      log: () => {},
      execFile: (cmd: string): string => {
        if (cmd === "pgrep") throw Object.assign(new Error("exit 1: no matches"), { status: 1 });
        return "";
      },
      sleep: () => {},
      healthWindowMs: 6,
      healthPollMs: 3,
    });
    run(() => deps.probeIdle());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const boot = (ms: number): string => JSON.stringify({ ts: ago(ms), step: "daemon.boot", head_sha: "abc1234" });
const sweep = (ms: number): string => JSON.stringify({ ts: ago(ms), step: "sweep.pass" });

/** Minimal deploy deps: behind origin, a marker present, probe supplied by the caller. */
function cycleDeps(probe: () => IdleProbe): { deps: DeployDeps; calls: string[]; logs: Array<{ step: string; data?: Record<string, unknown> }> } {
  const calls: string[] = [];
  const logs: Array<{ step: string; data?: Record<string, unknown> }> = [];
  let head = "old";
  const deps: DeployDeps = {
    kickstartConsole: () => {},
    consolePid: () => 1,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
    log: (step, data) => logs.push({ step, data }),
    now: () => 1000,
    deferredSince: () => undefined,
    setDeferredSince: () => {},
    clearDeferredSince: () => {},
    fetch: () => {},
    installHead: () => head,
    runningHead: () => head,
    originMain: () => "new",
    markerPresent: () => true,
    autoMode: () => false,
    lastFailedHead: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    discardLocal: () => {},
    pullFf: () => {
      calls.push("pullFf");
      head = "new";
    },
    resetHard: () => {},
    probeIdle: probe,
    kickstart: () => calls.push("kickstart"),
    waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }),
    alert: () => {},
    clearMarker: () => {},
  };
  return { deps, calls, logs };
}

test("a boot 3 min old with no sweep.pass since is not idle and the kickstart defers naming boot-settling", () => {
  probeWith([boot(3 * 60_000)], (probe) => {
    const p = probe();
    assert.equal(p.workers, 0);
    assert.equal(p.bootSettling, true);
    assert.equal(daemonIsIdle(p), false);

    const { deps, calls, logs } = cycleDeps(probe);
    const out = runDeployCycle(deps);
    assert.equal(out.deployed, false);
    assert.ok(!calls.includes("pullFf") && !calls.includes("kickstart"), "a settling boot is never recycled");
    const row = logs.find((l) => l.step === "deploy.not_idle");
    assert.ok(row, "deploy.not_idle logged");
    assert.equal(row.data?.boot_settling, true);
    assert.ok((row.data?.blockers as string[]).includes("boot-settling"));
  });
});

test("the same probe after a sweep.pass since the boot is idle and the deploy proceeds", () => {
  probeWith([boot(3 * 60_000), sweep(60_000)], (probe) => {
    const p = probe();
    assert.equal(p.bootSettling, undefined);
    assert.equal(daemonIsIdle(p), true);
    const { deps, calls } = cycleDeps(probe);
    assert.equal(runDeployCycle(deps).deployed, true);
    assert.ok(calls.includes("kickstart"));
  });
});

test("a sweep.pass from BEFORE the latest boot does not settle it", () => {
  probeWith([boot(30 * 60_000), sweep(25 * 60_000), boot(2 * 60_000)], (probe) => {
    assert.equal(probe().bootSettling, true);
  });
});

test("a settling boot past the backstop bound proceeds", () => {
  probeWith([boot(BOOT_SETTLING_BACKSTOP_MS + 60_000)], (probe) => {
    const p = probe();
    assert.equal(p.bootSettling, undefined);
    assert.equal(daemonIsIdle(p), true);
    const { deps, calls } = cycleDeps(probe);
    assert.equal(runDeployCycle(deps).deployed, true);
    assert.ok(calls.includes("kickstart"));
  });
});

test("an unreadable ledger degrades to not-idle, never to a quiet boot", () => {
  // The ledger path is a DIRECTORY: readFileSync fails with EISDIR, which is not ENOENT.
  const root = mkdtempSync(join(tmpdir(), "rmd-boot-settling-"));
  try {
    const ledger = deployLedgerPath(root);
    mkdirSync(ledger, { recursive: true });
    mkdirSync(join(root, "state", "inflight"), { recursive: true });
    mkdirSync(join(root, "worktrees"), { recursive: true });
    const deps = realDeployDeps({
      installPath: "/inst",
      stateRoot: root,
      daemonLabel: "d",
      serveLabel: "s",
      servePort: 4317,
      uid: 1,
      ledgerPath: ledger,
      log: () => {},
      execFile: (cmd: string): string => {
        if (cmd === "pgrep") throw Object.assign(new Error("exit 1"), { status: 1 });
        return "";
      },
      sleep: () => {},
      healthWindowMs: 6,
      healthPollMs: 3,
    });
    const p = deps.probeIdle();
    assert.deepEqual(p.unreadable, ["bootSettling"]);
    assert.equal(daemonIsIdle(p), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
