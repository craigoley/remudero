// W1-T14879: a standby started its filing read only after its rotation warm, whose synchronous reads took 108 s on the
// 2026-11-25 21:12Z hand-over; the active daemon yielded 3.9 s after the standby was ready, so 13.6 s of the 33.4 s
// takeover still waited on the read. Drives the REAL daemonCommand; only the daemon loop (runDaemon) is replaced.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { DaemonSummary } from "#src/lib/daemon.js";
import { standbyPromotePath, standbyReadyPath } from "#src/lib/daemon-standby.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const RUN_ID = "DAEMON-STANDBY-WARM-ORDER-TEST";

function world(t: TestContext): { home: string; state: string; planPath: string } {
  const home = ownedFixtureDir(t, "standby-warm-order").dir;
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

/** Runs one standby boot whose filing read and rotation warm each note when they ran. */
async function standbyBoot(t: TestContext, warmThrows = false) {
  const w = world(t);
  const order: string[] = [];
  let settled = false;
  const env = { HOME: process.env.HOME, REMUDERO_RUN_ID: process.env.REMUDERO_RUN_ID };
  const exitListeners = process.listeners("exit");
  process.env.HOME = w.home;
  process.env.REMUDERO_RUN_ID = RUN_ID;
  let code: number;
  try {
    const run = daemonCommand(["--allow-self-target", "--max", "0", "--standby", "--plan", w.planPath], {
      runDaemon: async () => { order.push(settled ? "loop:read_settled" : "loop:read_pending"); return stopped; },
      filingPrefetch: {
        refresh: async () => {
          order.push("filing_read_started");
          await new Promise((r) => setTimeout(r, 20));
          settled = true;
          return { kind: "refused", reasons: ["test"] };
        },
      },
      standbyWarm: () => { order.push(settled ? "warm:read_settled" : "warm:read_pending"); if (warmThrows) throw new Error("warm failed"); },
      standby: { pollMs: 5 },
    } as never);
    await until(() => existsSync(standbyReadyPath(w.state, RUN_ID)), "the ready marker");
    writeFileSync(standbyPromotePath(w.state, RUN_ID), "");
    code = await run;
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const l of process.listeners("exit").filter((l) => !exitListeners.includes(l))) process.removeListener("exit", l);
  }
  return { code, order };
}

test("W1-T14879 a standby starts its filing read before its rotation warm", async (t) => {
  const { code, order } = await standbyBoot(t);
  assert.equal(code, 0);
  assert.deepEqual(order, ["filing_read_started", "warm:read_pending", "loop:read_settled"],
    "the read is in flight while the warm runs, and settled before the loop");
});

test("W1-T14879 a standby whose rotation warm fails still boots with its one filing read", async (t) => {
  const { code, order } = await standbyBoot(t, true);
  assert.equal(code, 0, "a failed warm decides nothing");
  assert.equal(order.filter((step) => step === "filing_read_started").length, 1, `one filing read: ${JSON.stringify(order)}`);
  assert.equal(order.at(-1), "loop:read_settled", "the loop starts after the read settled");
});
