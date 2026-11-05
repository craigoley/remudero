import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  runRetroPrepublishPreflight,
  type RetroPrepublishCommandResult,
  type RetroPrepublishRunner,
} from "#src/lib/retro-preflight.js";
import { withTempDir } from "#src/lib/tmp.js";

const PASS = "# tests 1\n# pass 1\n# fail 0\n";
const FAIL = "not ok 1 - a plan test\n# tests 1\n# pass 0\n# fail 1\n";
const NOW = Date.parse("2026-11-04T13:24:00.000Z");

type Row = { step: string; extra: Record<string, unknown> };

async function preflight(
  slotDir: string,
  rows: Row[],
  run: RetroPrepublishRunner,
  repair: () => Promise<void> = async () => { throw new Error("no repair in this fixture"); },
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
      testSlot: {
        dir: slotDir,
        slots: 1,
        load: () => ({ cores: 8, load1: 0 }),
        memoryHeadroom: () => undefined,
        binaryExists: (path) => path === "/usr/bin/nice",
        log: () => {},
        pollMs: 5,
      },
    },
  });
}

/** Lists two suites, then answers the suite run with `suite()`, recording which rows existed when it spawned. */
function runner(rows: Row[], spawnedAfter: string[][], suite: () => RetroPrepublishCommandResult): RetroPrepublishRunner {
  return (_command, args) => {
    if (args.includes("--list-plan-reading-suites")) {
      return { status: 0, signal: null, stdout: "test/a.test.ts\ntest/b.test.ts\n", stderr: "" };
    }
    spawnedAfter.push(rows.map((r) => r.step));
    return suite();
  };
}

test("W1-T11326 criterion 1: the preflight ledgers retro.preflight_started with its pool before it spawns the suite run, and its passed row is unchanged", async () => {
  await withTempDir("retro-preflight-start", async (dir) => {
    const rows: Row[] = [];
    const spawnedAfter: string[][] = [];
    const result = await preflight(join(dir, "slots"), rows, runner(rows, spawnedAfter, () => ({ status: 0, signal: null, stdout: PASS, stderr: "" })));

    assert.equal(result.ok, true);
    assert.deepEqual(rows.map((r) => r.step), ["retro.preflight_started", "retro.preflight_passed"]);
    assert.deepEqual(spawnedAfter, [["retro.preflight_started"]], "the start row is written before the suite run spawns");
    const started = rows[0]!.extra;
    assert.equal(started.attempt, 1);
    assert.equal(started.suite_count, 2);
    assert.deepEqual(started.suites, ["test/a.test.ts", "test/b.test.ts"]);
    assert.equal(started.suite_selection, "broad");
    assert.equal(started.changed_path_count, null);
    assert.equal(started.started_at, new Date(NOW).toISOString());
    assert.equal(started.model, "test-model");
    assert.equal(started.session_id, "s-1");
    const passed = rows[1]!.extra;
    assert.equal(passed.attempt, 1);
    assert.equal(passed.outcome, "passed");
    assert.equal(passed.suite_count, 2);
  });
});

test("W1-T11326: a suite list that fails to enumerate spawns nothing and so ledgers no start row", async () => {
  await withTempDir("retro-preflight-start", async (dir) => {
    const rows: Row[] = [];
    const run: RetroPrepublishRunner = () => ({ status: 1, signal: null, stdout: "", stderr: "enumeration broke" });
    const result = await preflight(join(dir, "slots"), rows, run);

    assert.equal(result.ok, false);
    assert.equal(rows[0]?.step, "retro.preflight_failed");
    assert.equal(rows.some((r) => r.step === "retro.preflight_started"), false, "no suite run spawned, so no start row");
  });
});

test("W1-T11326: a repaired second attempt ledgers its own start row before its own suite run", async () => {
  await withTempDir("retro-preflight-start", async (dir) => {
    const rows: Row[] = [];
    const spawnedAfter: string[][] = [];
    let calls = 0;
    const suite = (): RetroPrepublishCommandResult => (++calls === 1
      ? { status: 1, signal: null, stdout: FAIL, stderr: "" }
      : { status: 0, signal: null, stdout: PASS, stderr: "" });
    const result = await preflight(join(dir, "slots"), rows, runner(rows, spawnedAfter, suite), async () => {});

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.deepEqual(rows.map((r) => r.step),
      ["retro.preflight_started", "retro.preflight_failed", "retro.preflight_started", "retro.preflight_passed"]);
    assert.deepEqual(rows.filter((r) => r.step === "retro.preflight_started").map((r) => r.extra.attempt), [1, 2]);
    assert.equal(spawnedAfter.length, 2);
    assert.equal(spawnedAfter[1]!.at(-1), "retro.preflight_started", "the second run spawns after its own start row");
  });
});
