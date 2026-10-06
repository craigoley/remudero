// test/the-deploy-health-window-fits-a-measured-boot.test.ts
//
// W1-T5722 — THE DEPLOY HEALTH WINDOW FITS A MEASURED BOOT. `realDeployDeps` waited 45 s for a
// `daemon.boot` row, but a boot writes `daemon.paths` first (before plan sync) and a recycle's own
// PAUSE can hold it in `daemon.boot_held` (one boot measured ~75 s late). 8 of 15 kickstarts were
// declared `deploy.unhealthy_rollback` at ~46 s, at least 3 of them on images that then booted.
//
// The fake ledger here is a REAL on-disk NDJSON file that the injected `sleep` APPENDS to as the
// simulated clock passes each row's offset — so a row exists only once its instant has elapsed,
// exactly as the live ledger behaves, and `waitBootHealth` cannot see a future row early.

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BOOT_IN_PROGRESS_WINDOW_MS,
  assessBootHealth,
  realDeployDeps,
  runDeployCycle,
  type DeployDeps,
  type HealthInputs,
} from "../src/lib/deployer.js";

const SINCE = Date.parse("2026-10-04T12:00:00.000Z");

interface Simulated {
  health: HealthInputs;
  /** Simulated ms elapsed when the verdict was returned. */
  elapsedMs: number;
}

/** Run the REAL `waitBootHealth` (default 45 s window, 3 s poll) against a ledger whose rows
 *  appear at the given offsets after the kickstart instant. */
function simulate(rows: Array<{ atMs: number; step: string }>): Simulated {
  const root = mkdtempSync(join(tmpdir(), "rmd-health-window-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const ledger = join(root, "state", "ledger.ndjson");
    // A boot from BEFORE the kickstart, and an old progress row: neither may count.
    writeFileSync(
      ledger,
      [
        JSON.stringify({ ts: new Date(SINCE - 5_000).toISOString(), run_id: "DAEMON-0", task_id: "DAEMON", step: "daemon.paths" }),
        JSON.stringify({ ts: new Date(SINCE - 1_000).toISOString(), run_id: "DAEMON-0", task_id: "DAEMON", step: "daemon.boot" }),
        "",
      ].join("\n"),
    );
    let clock = 0;
    const pending = [...rows].sort((a, b) => a.atMs - b.atMs);
    const sleep = (ms: number): void => {
      clock += ms;
      while (pending.length > 0 && pending[0].atMs <= clock) {
        const r = pending.shift()!;
        appendFileSync(
          ledger,
          JSON.stringify({ ts: new Date(SINCE + r.atMs).toISOString(), run_id: "DAEMON-1", task_id: "DAEMON", step: r.step }) + "\n",
        );
      }
    };
    const deps = realDeployDeps({
      installPath: "/inst",
      stateRoot: root,
      daemonLabel: "d",
      serveLabel: "s",
      servePort: 4317,
      uid: 1,
      ledgerPath: ledger,
      log: () => {},
      execFile: () => "",
      sleep,
    });
    const health = deps.waitBootHealth(SINCE);
    return { health, elapsedMs: clock };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("with a fake ledger, a daemon.paths row at 20 s and daemon.boot at 120 s reads healthy, a daemon.boot_held row extends the wait the same way, and no row within 45 s still reads unhealthy", () => {
  // The backstop is a named constant of at least 180 s.
  assert.ok(BOOT_IN_PROGRESS_WINDOW_MS >= 180_000, `backstop ${BOOT_IN_PROGRESS_WINDOW_MS}`);

  // (1) daemon.paths at 20 s, daemon.boot at 120 s ⇒ healthy, and the verdict names both rows.
  const paths = simulate([
    { atMs: 20_000, step: "daemon.paths" },
    { atMs: 120_000, step: "daemon.boot" },
  ]);
  assert.equal(assessBootHealth(paths.health).healthy, true, JSON.stringify(paths.health));
  assert.deepEqual(paths.health, { bootObserved: true, crashCount: 0, rowsSeen: ["daemon.paths", "daemon.boot"] });
  assert.ok(paths.elapsedMs > 45_000 && paths.elapsedMs < BOOT_IN_PROGRESS_WINDOW_MS, `returned at ${paths.elapsedMs}`);

  // (2) daemon.boot_held extends the wait the same way.
  const held = simulate([
    { atMs: 20_000, step: "daemon.boot_held" },
    { atMs: 120_000, step: "daemon.boot" },
  ]);
  assert.equal(assessBootHealth(held.health).healthy, true, JSON.stringify(held.health));
  assert.deepEqual(held.health, { bootObserved: true, crashCount: 0, rowsSeen: ["daemon.boot_held", "daemon.boot"] });

  // (3) No row at all within 45 s ⇒ unhealthy at 45 s, exactly as before — not extended.
  const none = simulate([{ atMs: 120_000, step: "daemon.boot" }]);
  assert.equal(assessBootHealth(none.health).healthy, false, JSON.stringify(none.health));
  assert.deepEqual(none.health, { bootObserved: false, crashCount: 0, rowsSeen: [] });
  assert.equal(none.elapsedMs, 45_000);

  // (4) A boot in progress that never boots is still bounded by the backstop.
  const stuck = simulate([{ atMs: 20_000, step: "daemon.paths" }]);
  assert.equal(assessBootHealth(stuck.health).healthy, false);
  assert.deepEqual(stuck.health.rowsSeen, ["daemon.paths"]);
  assert.equal(stuck.elapsedMs, BOOT_IN_PROGRESS_WINDOW_MS);
});

/** Minimal deps for one cycle: behind ⇒ pull ⇒ kickstart ⇒ the supplied health verdict. */
function cycleDeps(health: HealthInputs, logged: Array<Record<string, unknown>>): DeployDeps {
  return {
    log: (step, data) => logged.push({ step, ...(data ?? {}) }),
    now: () => 1000,
    fetch: () => {},
    installHead: () => "a".repeat(40),
    runningHead: () => "a".repeat(40),
    originMain: () => "b".repeat(40),
    markerPresent: () => false,
    autoMode: () => true,
    lastFailedHead: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    pullFf: () => {},
    resetHard: () => {},
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => {},
    waitBootHealth: () => health,
    alert: () => {},
    clearMarker: () => {},
    kickstartConsole: () => {},
    consolePid: () => 4242,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
  };
}

test("the health verdict row records which boot rows it saw", () => {
  const ok: Array<Record<string, unknown>> = [];
  runDeployCycle(cycleDeps({ bootObserved: true, crashCount: 0, rowsSeen: ["daemon.paths", "daemon.boot_held", "daemon.boot"] }, ok));
  const okRow = ok.find((r) => r.step === "deploy.ok");
  assert.ok(okRow, JSON.stringify(ok));
  assert.deepEqual(okRow.observed_rows, ["daemon.paths", "daemon.boot_held", "daemon.boot"]);

  const bad: Array<Record<string, unknown>> = [];
  runDeployCycle(cycleDeps({ bootObserved: false, crashCount: 0, rowsSeen: ["daemon.paths"] }, bad));
  const badRow = bad.find((r) => r.step === "deploy.unhealthy_rollback");
  assert.ok(badRow, JSON.stringify(bad));
  assert.deepEqual(badRow.observed_rows, ["daemon.paths"]);
});
