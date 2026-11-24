// W1-T14674: a promoted standby's daemon.boot_phases row names its warm reads, its wait for the hand-over, its lock wait
// and its post-lock checkout sync as their own parts, so the wait (the old daemon still working) never reads as wiring.
// Drives the REAL daemonCommand; only the daemon loop (runDaemon) is replaced, and it writes the first-tick row.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { DaemonDeps, DaemonSummary } from "#src/lib/daemon.js";
import { standbyPromotePath, standbyReadyPath } from "#src/lib/daemon-standby.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const RUN_ID = "DAEMON-STANDBY-PHASES-TEST";
const HOLD_MS = 400;

function world(t: TestContext): { home: string; state: string; planPath: string } {
  const home = ownedFixtureDir(t, "standby-phases").dir;
  const root = join(home, "Remudero");
  const state = join(root, "state");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return { home, state, planPath };
}

async function until(predicate: () => boolean, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const stopped: DaemonSummary = { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };

test("W1-T14674 a promoted standby's boot phases name its wait for the hand-over apart from wiring", async (t) => {
  const w = world(t);
  let phases: Record<string, unknown> | undefined;
  const env = { HOME: process.env.HOME, REMUDERO_RUN_ID: process.env.REMUDERO_RUN_ID };
  const exitListeners = process.listeners("exit");
  process.env.HOME = w.home;
  process.env.REMUDERO_RUN_ID = RUN_ID;
  let code: number;
  try {
    const run = daemonCommand(["--allow-self-target", "--max", "0", "--standby", "--plan", w.planPath], {
      runDaemon: async (_plan: unknown, wired: DaemonDeps) => {
        wired.bootPhases?.firstTick((step, extra) => { if (step === "daemon.boot_phases") phases = extra; });
        return stopped;
      },
      standby: { pollMs: 5 },
    } as never);
    await until(() => existsSync(standbyReadyPath(w.state, RUN_ID)), "the ready marker");
    await new Promise((r) => setTimeout(r, HOLD_MS));
    writeFileSync(standbyPromotePath(w.state, RUN_ID), "");
    code = await run;
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const l of process.listeners("exit").filter((l) => !exitListeners.includes(l))) process.removeListener("exit", l);
  }
  assert.equal(code, 0);
  assert.ok(phases, "the first tick wrote the boot phases");
  for (const part of ["standby_warm", "promote_wait", "lock_wait", "plan_sync"]) {
    assert.equal(typeof phases[`${part}_ms`], "number", `${part}_ms: ${JSON.stringify(phases)}`);
  }
  assert.ok((phases.promote_wait_ms as number) >= HOLD_MS, `the hold is the wait: ${JSON.stringify(phases)}`);
  assert.ok((phases.wiring_ms as number) < HOLD_MS, `wiring no longer holds the wait: ${JSON.stringify(phases)}`);
});
