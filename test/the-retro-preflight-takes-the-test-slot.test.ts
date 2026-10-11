/**
 * W1-T6111: the retro preflight's multi-suite `node --test` ran at default priority and node's default
 * concurrency, outside the host-wide test slot. These tests drive `runRetroPrepublishPreflight` with a fixture
 * runner and a fixture slot directory and pin what the suite run is now spawned as, when the slot is held, and
 * what the attempt row says about it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  runRetroPrepublishPreflight,
  type RetroPrepublishCommandResult,
  type RetroPrepublishRunner,
} from "../src/lib/retro-preflight.js";
import { acquireTestSlotAsync, type TestSlotOptions } from "../src/lib/test-slot.js";

const PASS = "# tests 1\n# pass 1\n# fail 0\n";
const FAIL = "not ok 1 - a plan test\n# tests 1\n# pass 0\n# fail 1\n";

interface Fixture {
  dir: string;
  slot: Omit<TestSlotOptions, "sleep">;
  rows: Array<{ step: string; extra: Record<string, unknown> }>;
  suiteCalls: Array<{ command: string; args: string[]; heldDuringRun: string[] }>;
  cleanup: () => void;
}

function fixture(overrides: Omit<TestSlotOptions, "sleep"> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-slot-"));
  const dir = join(root, "slots");
  return {
    dir,
    slot: {
      dir,
      slots: 1,
      load: () => ({ cores: 8, load1: 0 }),
      memoryHeadroom: () => undefined,
      binaryExists: (path) => path === "/usr/bin/nice",
      log: () => {},
      pollMs: 5,
      ...overrides,
    },
    rows: [],
    suiteCalls: [],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const held = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((name) => /^slot-\d+\.json$/.test(name));
  } catch {
    return [];
  }
};

function runnerFor(fx: Fixture, suite: () => RetroPrepublishCommandResult | Promise<RetroPrepublishCommandResult>): RetroPrepublishRunner {
  return (command, args) => {
    if (args.includes("--list-plan-reading-suites")) return { status: 0, signal: null, stdout: "test/a.test.ts\n", stderr: "" };
    fx.suiteCalls.push({ command, args, heldDuringRun: held(fx.dir) });
    return suite();
  };
}

async function preflight(fx: Fixture, run: RetroPrepublishRunner) {
  return runRetroPrepublishPreflight({
    worktreePath: "/tmp/retro-worktree",
    provenance: { model: "test", effort: "test", sessionId: "test" },
    remotePrExisted: false,
    repair: async () => {
      throw new Error("no repair in this fixture");
    },
    regenerateHarnessArtifacts: async () => {},
    log: (step, extra) => fx.rows.push({ step, extra }),
    deps: { run, now: () => 0, testSlot: fx.slot },
  });
}

test("the retro preflight's suite run is spawned under nice with an explicit test concurrency", async () => {
  const fx = fixture();
  try {
    const result = await preflight(fx, runnerFor(fx, () => ({ status: 0, signal: null, stdout: PASS, stderr: "" })));
    assert.equal(result.ok, true);
    assert.equal(fx.suiteCalls.length, 1);
    const { command, args } = fx.suiteCalls[0]!;
    assert.equal(command, "/usr/bin/nice", "the suite run starts under the nice wrapper");
    assert.deepEqual(args.slice(0, 3), ["-n", "10", process.execPath]);
    assert.ok(args.includes("--test-concurrency=6"), `explicit concurrency from the slot: ${args.join(" ")}`);
    assert.equal(args.indexOf("--test-concurrency=6"), args.indexOf("--test") + 1, "the flag sits right after --test");
    assert.ok(args.includes("test/a.test.ts"), "the enumerated suites are still run");
    assert.ok(args.includes("scripts/test-with-retry.mjs"), "the retry wrapper is still the entry point");
  } finally {
    fx.cleanup();
  }
});

test("the retro preflight holds a host-wide test slot while the suite runs and releases it on a pass", async () => {
  const fx = fixture();
  try {
    await preflight(fx, runnerFor(fx, () => ({ status: 0, signal: null, stdout: PASS, stderr: "" })));
    assert.equal(fx.suiteCalls[0]!.heldDuringRun.length, 1, "a slot record exists while the suite runs");
    assert.deepEqual(held(fx.dir), [], "and is gone once the run has passed");
  } finally {
    fx.cleanup();
  }
});

test("the retro preflight releases the test slot when the run fails", async () => {
  const fx = fixture();
  try {
    const result = await preflight(fx, runnerFor(fx, () => ({ status: 1, signal: null, stdout: FAIL, stderr: "" })));
    assert.equal(result.ok, false);
    assert.equal(fx.suiteCalls[0]!.heldDuringRun.length, 1);
    assert.deepEqual(held(fx.dir), [], "a failing run frees the slot");
  } finally {
    fx.cleanup();
  }
});

test("the retro preflight releases the test slot when the run cannot spawn or times out", async () => {
  for (const error of [
    Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
  ]) {
    const fx = fixture();
    try {
      const result = await preflight(fx, runnerFor(fx, () => ({ status: null, signal: null, stdout: "", stderr: "", error })));
      assert.equal(result.ok, false);
      assert.deepEqual(held(fx.dir), [], `${error.message}: the slot is freed`);
    } finally {
      fx.cleanup();
    }
  }
});

test("the retro preflight releases the test slot when the runner itself throws", async () => {
  const fx = fixture();
  try {
    await assert.rejects(
      preflight(fx, runnerFor(fx, () => {
        throw new Error("runner exploded");
      })),
      /runner exploded/,
    );
    assert.deepEqual(held(fx.dir), [], "a throwing runner still frees the slot");
  } finally {
    fx.cleanup();
  }
});

test("the retro preflight records the acquired slot outcome on its attempt row", async () => {
  const fx = fixture();
  try {
    await preflight(fx, runnerFor(fx, () => ({ status: 0, signal: null, stdout: PASS, stderr: "" })));
    const row = fx.rows.find((r) => r.step === "retro.preflight_passed")!;
    assert.equal(row.extra.test_slot_outcome, "acquired");
    assert.equal(row.extra.test_slot_concurrency, 6);
    assert.equal(row.extra.test_slot_priority, "nice");
    assert.equal(typeof row.extra.test_slot_waited_ms, "number");
  } finally {
    fx.cleanup();
  }
});

test("the retro preflight records slot_unavailable on a failed attempt row when the slot directory cannot be made", async () => {
  const fx = fixture();
  try {
    const blocker = join(fx.dir, "..", "not-a-dir");
    writeFileSync(blocker, "x");
    fx.slot = { ...fx.slot, dir: join(blocker, "slots") };
    const result = await preflight(fx, runnerFor(fx, () => ({ status: 1, signal: null, stdout: FAIL, stderr: "" })));
    assert.equal(result.ok, false);
    const row = fx.rows.find((r) => r.step === "retro.preflight_failed")!;
    assert.equal(row.extra.test_slot_outcome, "slot_unavailable");
    assert.equal(fx.suiteCalls.length, 1, "uncoordinated is still a run");
  } finally {
    fx.cleanup();
  }
});

test("the retro preflight records wait_bound_exceeded when every slot stays held past the wait bound", async () => {
  const fx = fixture({ waitBoundMs: 30 });
  const holder = await acquireTestSlotAsync("someone-else", fx.slot);
  try {
    assert.equal(holder.outcome, "acquired");
    const result = await preflight(fx, runnerFor(fx, () => ({ status: 0, signal: null, stdout: PASS, stderr: "" })));
    assert.equal(result.ok, true, "the bound expires into a run, never a refusal");
    const row = fx.rows.find((r) => r.step === "retro.preflight_passed")!;
    assert.equal(row.extra.test_slot_outcome, "wait_bound_exceeded");
    assert.equal(held(fx.dir).length, 1, "the other holder's slot is untouched by our release");
  } finally {
    holder.release();
    fx.cleanup();
  }
});
