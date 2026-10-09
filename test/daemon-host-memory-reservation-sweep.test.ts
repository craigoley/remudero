// W1-T7093: prove host-memory tree reconciliation is connected to the recurring daemon heartbeat.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { daemonCommand } from "./helpers/run-task-daemon.js";
import { readMemoryLedger } from "../src/lib/host-memory-ledger.js";
import { TEST_SLOT_DIR_ENV, TEST_SLOT_PARENT_ENV } from "../src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { appendGitConfigEnv } from "./setup/no-live-remote.js";

const PLAN_YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function planFixture(): { dir: string; plan: Plan } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-memory-tick-plan-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, PLAN_YAML);
  return { dir, plan: loadPlan(path) };
}

test("W1-T7093 tick: each daemon.alive heartbeat runs the best-effort reservation sweep", async () => {
  const fixture = planFixture();
  const rows: string[] = [];
  let releases: (() => void) | undefined;
  const runGate = new Promise<void>((resolve) => { releases = resolve; });
  let sweepCalls = 0;
  let sleeps = 0;
  try {
    const result = await runDaemon(fixture.plan, {
      refreshMerged: () => () => false,
      runOne: async () => {
        await runGate;
        return { taskId: "A", runId: "A-run", merged: true, costUsd: 0, verdict: "merged" };
      },
      sweepLight: async () => {},
      sweepHostMemoryReservations: () => {
        sweepCalls++;
        throw new Error("ledger unavailable");
      },
      sleep: async () => {
        sleeps++;
        if (rows.filter((step) => step === "daemon.alive").length >= 3 || sleeps >= 10) releases?.();
      },
      log: (step) => rows.push(step),
    } satisfies DaemonDeps, { max: 1 });

    assert.equal(result.stopReason, "max_reached");
    const heartbeats = rows.filter((step) => step === "daemon.alive").length;
    const failures = rows.filter((step) => step === "daemon.host_memory_reservation_sweep.error").length;
    assert.ok(heartbeats >= 3, `expected >=3 heartbeats; saw ${heartbeats}`);
    assert.equal(sweepCalls, heartbeats, "the real tick invokes one reservation sweep for each heartbeat");
    assert.equal(failures, sweepCalls, "a sweep error is logged once per tick and does not stop the daemon");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("W1-T7093 wiring: daemonCommand connects the production tick to the shared reservation ledger", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-memory-tick-home-`));
  const slot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-memory-tick-slot-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");

  const gitConfigIndex = Number(process.env.GIT_CONFIG_COUNT ?? "0");
  const envKeys = ["HOME", TEST_SLOT_DIR_ENV, TEST_SLOT_PARENT_ENV, "GIT_CONFIG_COUNT",
    `GIT_CONFIG_KEY_${gitConfigIndex}`, `GIT_CONFIG_VALUE_${gitConfigIndex}`] as const;
  const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env[TEST_SLOT_DIR_ENV] = slot;
  delete process.env[TEST_SLOT_PARENT_ENV];
  // The proof sandbox masks the checkout's git config. Give composition its own fixture origin.
  appendGitConfigEnv("remote.origin.url", "https://github.com/fixture/memory-ledger.git");
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps) => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.equal(typeof captured?.sweepHostMemoryReservations, "function", "the real daemon composition root supplies the recurring sweep");
    captured!.sweepHostMemoryReservations!();

    const reading = readMemoryLedger({ root });
    assert.equal(reading?.state, "present", "the callback uses the production ledger and creates/reads its sentinel");
    assert.equal(reading?.scope, "host", "the configured shared test-slot location is reported host-wide");
    assert.equal(reading?.entries.length, 0);
    assert.ok(readdirSync(join(slot, "host-memory")).length > 0);
  } finally {
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(slot, { recursive: true, force: true });
  }
});
