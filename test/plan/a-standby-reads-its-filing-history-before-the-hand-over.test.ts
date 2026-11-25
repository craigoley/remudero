// W1-T14860: a standby starts dispatch's filing read while it waits for the hand-over, and the promoted boot awaits that same
// read instead of starting one after the lock. On the 2026-11-25 17:36Z hand-over, filing_prefetch was 23.2 s of the
// 48.9 s takeover. Drives the REAL daemonCommand; only the daemon loop (runDaemon) is replaced.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { DaemonSummary } from "#src/lib/daemon.js";
import { standbyPromotePath, standbyReadyPath } from "#src/lib/daemon-standby.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const RUN_ID = "DAEMON-STANDBY-FILING-TEST";

function world(t: TestContext): { home: string; state: string; planPath: string } {
  const home = ownedFixtureDir(t, "standby-filing").dir;
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

/** Runs one boot with a recording filing reader; each read notes whether the hand-over had happened yet. */
async function boot(t: TestContext, asStandby: boolean) {
  const w = world(t);
  const reads: Array<{ planPath: string; afterHandOver: boolean }> = [];
  let readsAtLoop: number | undefined;
  // Set as the test writes the promote marker; the promoted standby consumes the marker, so its presence cannot say.
  let handedOver = false;
  const env = { HOME: process.env.HOME, REMUDERO_RUN_ID: process.env.REMUDERO_RUN_ID };
  const exitListeners = process.listeners("exit");
  process.env.HOME = w.home;
  process.env.REMUDERO_RUN_ID = RUN_ID;
  let code: number;
  try {
    const run = daemonCommand(["--allow-self-target", "--max", "0", ...(asStandby ? ["--standby"] : []), "--plan", w.planPath], {
      runDaemon: async () => { readsAtLoop = reads.length; return stopped; },
      filingPrefetch: {
        refresh: async (planPath: string) => {
          reads.push({ planPath, afterHandOver: handedOver });
          return { kind: "refused", reasons: ["test"] };
        },
      },
      ...(asStandby ? { standby: { pollMs: 5 } } : {}),
    } as never);
    if (asStandby) {
      await until(() => existsSync(standbyReadyPath(w.state, RUN_ID)), "the ready marker");
      handedOver = true;
      writeFileSync(standbyPromotePath(w.state, RUN_ID), "");
    }
    code = await run;
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const l of process.listeners("exit").filter((l) => !exitListeners.includes(l))) process.removeListener("exit", l);
  }
  assert.equal(code, 0);
  return { reads, readsAtLoop };
}

test("W1-T14860 a standby reads its filing history before the hand-over and not again after the lock", async (t) => {
  const { reads, readsAtLoop } = await boot(t, true);
  assert.equal(readsAtLoop, 1, `one filing read before the loop: ${JSON.stringify(reads)}`);
  assert.equal(reads[0]!.afterHandOver, false, "the read started while the standby waited for the hand-over");
});

test("W1-T14860 a boot with no standby still reads its filing history before the loop", async (t) => {
  const { reads, readsAtLoop } = await boot(t, false);
  assert.equal(readsAtLoop, 1, `the boot's one filing read precedes the loop: ${JSON.stringify(reads)}`);
});
