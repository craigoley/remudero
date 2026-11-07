import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  runRetroPrepublishPreflight,
  type RetroPrepublishCommandResult,
  type RetroPrepublishRunner,
} from "#src/lib/retro-preflight.js";
import { startTestSlotHeartbeat, TEST_SLOT_HEARTBEAT_MS, type TestSlotHeartbeatHandle } from "#src/lib/test-slot.js";
import { withTempDir } from "#src/lib/tmp.js";

const PASS = "# tests 1\n# pass 1\n# fail 0\n";
const FAIL = "not ok 1 - a plan test\n# tests 1\n# pass 0\n# fail 1\n";
const NOW = Date.parse("2026-11-04T13:24:00.000Z");

type Row = { step: string; extra: Record<string, unknown> };
type StartHeartbeat = (handle: TestSlotHeartbeatHandle, log: (row: Record<string, unknown>) => void) => { stop(coveredWorkEnded: boolean): void };

async function preflight(
  slotDir: string,
  rows: Row[],
  run: RetroPrepublishRunner,
  repair: () => Promise<void> = async () => { throw new Error("no repair in this fixture"); },
  startHeartbeat?: StartHeartbeat,
) {
  return runRetroPrepublishPreflight({
    worktreePath: "/tmp/retro-worktree",
    provenance: { model: "test-model", effort: "test", sessionId: "s-1" },
    remotePrExisted: false,
    repair,
    regenerateHarnessArtifacts: async () => {},
    log: (step, extra) => rows.push({ step, extra }),
    deps: {
      run,
      now: () => NOW,
      changedFiles: async () => ({ unreadable: "fixture worktree has no git" }),
      tmpRoot: slotDir,
      testSlot: {
        dir: join(slotDir, "slots"),
        slots: 1,
        load: () => ({ cores: 8, load1: 0 }),
        memoryHeadroom: () => undefined,
        binaryExists: (path) => path === "/usr/bin/nice",
        log: () => {},
        pollMs: 5,
      },
      startHeartbeat,
    },
  });
}

function heartbeatOnFastCadence(withdrawn: unknown[]): StartHeartbeat {
  return (handle, log) => {
    const heartbeat = startTestSlotHeartbeat({ ...handle, intervalMs: 5 }, log);
    return {
      stop(coveredWorkEnded) {
        heartbeat.stop(coveredWorkEnded);
        const record = JSON.parse(readFileSync(handle.path, "utf8")) as { heartbeatIntervalMs?: number };
        withdrawn.push(record.heartbeatIntervalMs);
      },
    };
  };
}

function delayedRun(
  slotDir: string,
  suite: () => RetroPrepublishCommandResult,
  heartbeats: string[],
): RetroPrepublishRunner {
  let suiteRuns = 0;
  return async (_command, args) => {
    if (args.includes("--list-plan-reading-suites")) {
      return { status: 0, signal: null, stdout: "test/a.test.ts\n", stderr: "" };
    }
    suiteRuns++;
    const path = join(slotDir, "slots", "slot-1.json");
    const before = JSON.parse(readFileSync(path, "utf8")) as { heartbeatAt: string; heartbeatIntervalMs?: number };
    await new Promise((resolve) => setTimeout(resolve, 35));
    const during = JSON.parse(readFileSync(path, "utf8")) as { heartbeatAt: string; heartbeatIntervalMs?: number };
    assert.notEqual(during.heartbeatAt, before.heartbeatAt, "the heartbeat advances while the suite run holds the slot");
    assert.equal(during.heartbeatIntervalMs, 5, "the held slot publishes its heartbeat cadence");
    heartbeats.push(during.heartbeatAt);
    return suiteRuns === 1 ? suite() : { status: 0, signal: null, stdout: PASS, stderr: "" };
  };
}

test("W1-T11335: a retro suite run beats its held slot and withdraws the cadence before releasing it on every ending", async () => {
  await withTempDir("retro-slot-heartbeat", async (dir) => {
    const endings: Array<{ name: string; first: () => RetroPrepublishCommandResult; attempts: number }> = [
      { name: "pass", first: () => ({ status: 0, signal: null, stdout: PASS, stderr: "" }), attempts: 1 },
      { name: "failure", first: () => ({ status: 1, signal: null, stdout: FAIL, stderr: "" }), attempts: 2 },
      { name: "timeout", first: () => ({ status: null, signal: null, stdout: "", stderr: "", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }), attempts: 1 },
      { name: "spawn error", first: () => ({ status: null, signal: null, stdout: "", stderr: "", error: new Error("spawn failed") }), attempts: 1 },
    ];

    for (const ending of endings) {
      const caseDir = join(dir, ending.name.replaceAll(" ", "-"));
      const rows: Row[] = [];
      const heartbeats: string[] = [];
      const withdrawn: unknown[] = [];
      const run = delayedRun(caseDir, ending.first, heartbeats);
      const result = await preflight(caseDir, rows, run, async () => {}, heartbeatOnFastCadence(withdrawn));

      assert.equal(result.attempts, ending.attempts, ending.name);
      assert.equal(heartbeats.length, ending.attempts, `${ending.name}: every suite run beat while holding its slot`);
      assert.deepEqual(withdrawn, Array.from({ length: ending.attempts }, () => undefined), `${ending.name}: cadence was withdrawn before slot release`);
      assert.equal(existsSync(join(caseDir, "slots", "slot-1.json")), false, `${ending.name}: slot is released after heartbeat withdrawal`);
    }
  });
});

test("W1-T11335: the default heartbeat publishes its cadence during the held suite run", async () => {
  await withTempDir("retro-slot-default-heartbeat", async (dir) => {
    const rows: Row[] = [];
    let observed = false;
    const run: RetroPrepublishRunner = (_command, args) => {
      if (args.includes("--list-plan-reading-suites")) {
        return { status: 0, signal: null, stdout: "test/a.test.ts\n", stderr: "" };
      }
      const path = join(dir, "slots", "slot-1.json");
      const held = JSON.parse(readFileSync(path, "utf8")) as { heartbeatIntervalMs?: number; workIdentity?: string };
      assert.equal(held.heartbeatIntervalMs, TEST_SLOT_HEARTBEAT_MS);
      assert.equal(held.workIdentity, "reservation-marker-v1");
      observed = true;
      return { status: 0, signal: null, stdout: PASS, stderr: "" };
    };
    const result = await preflight(dir, rows, run);

    assert.equal(result.ok, true);
    assert.equal(observed, true);
    assert.equal(existsSync(join(dir, "slots", "slot-1.json")), false);
  });
});

test("W1-T11335: a heartbeat start refusal is diagnostic and does not block the suite run", async () => {
  await withTempDir("retro-slot-heartbeat-start-refused", async (dir) => {
    const rows: Row[] = [];
    let suiteRan = false;
    const run: RetroPrepublishRunner = (_command, args) => {
      if (args.includes("--list-plan-reading-suites")) {
        return { status: 0, signal: null, stdout: "test/a.test.ts\n", stderr: "" };
      }
      suiteRan = true;
      return { status: 0, signal: null, stdout: PASS, stderr: "" };
    };
    const result = await preflight(dir, rows, run, async () => {}, () => { throw new Error("initial heartbeat deferred"); });

    assert.equal(result.ok, true);
    assert.equal(suiteRan, true);
    assert.equal(rows.some((row) => row.step === "retro.preflight_slot_heartbeat" && row.extra.step === "test_slot.heartbeat_start_failed"), true);
  });
});
