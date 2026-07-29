import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonCommand, ledgerPathFor } from "../src/run-task.js";
import { DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS } from "../src/lib/worker-home.js";
import type { DaemonSummary } from "../src/lib/daemon.js";

// ── W1-T170 boot sweep wiring: `daemonCommand` runs `sweepStaleWorkerHomes(workerHomeDir(config))` ──
// as part of its `daemonBoot` call, BEFORE handing off to `runDaemon` — the same boot rung already
// covers for worker-scratch/tmp (daemon.scratch_sweep/daemon.tmp_sweep). This pins that a stale,
// orphaned per-run worker-home dir sitting under config.root/worker-home-<id> at boot is actually
// reaped (not just implemented as a standalone pure function — worker-home-per-run.test.ts already
// covers the pure sweepStaleWorkerHomes/reapWorkerHome edge cases) and ledgered as
// `daemon.worker_home_sweep`. Drives the REAL daemonCommand past dry-run with an injected
// `runDaemon` stub that returns immediately (same seam as daemon-command-retro-wiring.test.ts), so
// the loop itself never spawns.

function fixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-daemon-worker-home-sweep-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  return { home, root, planPath };
}

test("daemonCommand boot sweep: reaps an OLD orphaned worker-home-<id> under config.root and ledgers daemon.worker_home_sweep", async () => {
  const { home, root, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const staleWorkerHome = join(root, "worker-home-orphan-from-a-dead-run");
  try {
    mkdirSync(staleWorkerHome, { recursive: true });
    const oldMtime = new Date(Date.now() - DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS * 2);
    utimesSync(staleWorkerHome, oldMtime, oldMtime);

    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (): Promise<DaemonSummary> => ({
        attempted: [],
        merged: [],
        stopReason: "stopped",
        costUsd: 0,
        ticks: 0,
      }),
    });
    assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");

    assert.equal(existsSync(staleWorkerHome), false, "the stale orphaned worker-home dir must be reaped at boot");

    const ledgerPath = ledgerPathFor({ root } as never);
    const lines = readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const sweepLine = lines.find((l) => l.step === "daemon.worker_home_sweep");
    assert.ok(sweepLine, "daemonCommand ledgers a daemon.worker_home_sweep line when it reaps at least one home");
    assert.equal(sweepLine!.removed, 1);
    assert.deepEqual(sweepLine!.sample, ["worker-home-orphan-from-a-dead-run"]);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
