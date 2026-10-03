/**
 * W1-T5347 — IMPLEMENT DISPATCH HOLDS ON LOW HOST MEMORY.
 *
 * W1-T1038 built `memoryGovernorGateFor` (run-task.ts) and tested it in isolation, but neither
 * implement dispatch call site — `drainCommand`'s `DrainDeps`, `daemonCommand`'s `DaemonDeps` —
 * carried `checkMemoryGovernor`, and `sweep.memoryFloorMib` shipped at 0. So nothing deferred a new
 * implement run while `MemAvailable` fell to its observed 2,080 MiB minimum (10-01/02).
 *
 * THESE TESTS DRIVE THE REAL COMMANDS, capturing the deps each hands its loop through the existing
 * `deps.runDrain` / `deps.runDaemon` seams (the same discipline test/cost-governor.test.ts uses for
 * W1-T317), and inject only the `MemAvailable` READING — never the gate, never the floor.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainCommand, daemonCommand, memoryGovernorGateFor } from "../src/run-task.js";
import { checkDispatchGovernors, governorDeferPayload } from "../src/lib/dispatch-governor.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { loadDefaultPolicy } from "../src/lib/policy.js";
import { readLedgerLines, type GitHub } from "../src/lib/status.js";
import type { DrainDeps, DrainSummary } from "../src/lib/drain.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import type { Config } from "../src/lib/config.js";

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const FLOOR = DEFAULT_SWEEP_POLICY.memoryFloorMib;

function emptyPlanPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-mem-hold-plan-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return planPath;
}

async function captureDrainDeps(root: string, readAvailableMemoryMib: () => number): Promise<DrainDeps> {
  let captured: DrainDeps | undefined;
  const code = await drainCommand([], {
    config: { claudeBin: "/bin/true", root } as Config,
    planPath: emptyPlanPath(),
    skipGitSync: true,
    githubFactory: () => OFFLINE_GITHUB,
    notifyChannel: { send: () => true } as never,
    readAvailableMemoryMib,
    runDrain: async (_plan, deps): Promise<DrainSummary> => {
      captured = deps;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" };
    },
  });
  assert.equal(code, 0);
  assert.ok(captured, "runDrain was reached and its DrainDeps captured");
  return captured;
}

async function withDaemonDeps(
  readAvailableMemoryMib: () => number,
  body: (deps: DaemonDeps, ledgerPath: string) => void,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "rmd-mem-hold-daemon-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const now = new Date();
  utimesSync(home, now, now); // see test/cost-governor.test.ts's daemonFixtureHome for why
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      readAvailableMemoryMib,
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
    body(captured, join(root, "state", "ledger.ndjson"));
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function memoryRows(ledgerPath: string, step: string): Record<string, unknown>[] {
  return readLedgerLines(ledgerPath).filter((l) => l.step === step) as Record<string, unknown>[];
}

test("W1-T5347: the shipped policy floor is non-zero and DEFAULT_SWEEP_POLICY carries it", () => {
  const shipped = loadDefaultPolicy().values.sweep.memoryFloorMib;
  assert.ok(shipped > 0, `sweep.memoryFloorMib must ship non-zero (got ${shipped}) — at 0 the gate can never defer`);
  assert.equal(FLOOR, shipped, "DEFAULT_SWEEP_POLICY must carry the plan/policy.yaml floor");
});

test("W1-T5347: drainCommand's implement dispatch defers below the floor and ledgers the observed and floor MiB", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-mem-hold-drain-"));
  try {
    const deps = await captureDrainDeps(root, () => 1000);
    assert.equal(typeof deps.checkMemoryGovernor, "function", "drainCommand must wire checkMemoryGovernor");
    // ONLY the memory dep: the real cost/queue gates read GitHub, which this test must not.
    const verdict = checkDispatchGovernors({ checkMemoryGovernor: deps.checkMemoryGovernor }, undefined);
    assert.equal(verdict?.kind, "memory", "1,000 MiB available is below the shipped floor — the run must be deferred");
    assert.deepEqual(governorDeferPayload(verdict!), { observed_available_mib: 1000, memory_floor_mib: FLOOR });
    const rows = memoryRows(join(root, "state", "ledger.ndjson"), "dispatch_memory_observed");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.observed_available_mib, 1000);
    assert.equal(rows[0]!.memory_floor_mib, FLOOR);
    assert.equal(rows[0]!.deferred, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5347: drainCommand admits at or above the floor and still ledgers the reading", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-mem-hold-drain-"));
  try {
    for (const reading of [FLOOR, FLOOR + 4096]) {
      const deps = await captureDrainDeps(root, () => reading);
      assert.equal(checkDispatchGovernors({ checkMemoryGovernor: deps.checkMemoryGovernor }, undefined), undefined);
    }
    const rows = memoryRows(join(root, "state", "ledger.ndjson"), "dispatch_memory_observed");
    assert.deepEqual(
      rows.map((r) => [r.observed_available_mib, r.deferred]),
      [
        [FLOOR, false],
        [FLOOR + 4096, false],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5347: daemonCommand's implement dispatch defers below the floor and admits at it", async () => {
  let reading = 1000;
  await withDaemonDeps(
    () => reading,
    (deps, ledgerPath) => {
      assert.equal(typeof deps.checkMemoryGovernor, "function", "daemonCommand must wire checkMemoryGovernor");
      const held = checkDispatchGovernors({ checkMemoryGovernor: deps.checkMemoryGovernor }, undefined);
      assert.equal(held?.kind, "memory");
      assert.deepEqual(governorDeferPayload(held!), { observed_available_mib: 1000, memory_floor_mib: FLOOR });
      reading = FLOOR;
      assert.equal(checkDispatchGovernors({ checkMemoryGovernor: deps.checkMemoryGovernor }, undefined), undefined);
      const rows = memoryRows(ledgerPath, "dispatch_memory_observed");
      assert.deepEqual(
        rows.map((r) => [r.observed_available_mib, r.memory_floor_mib, r.deferred]),
        [
          [1000, FLOOR, true],
          [FLOOR, FLOOR, false],
        ],
      );
    },
  );
});

test("W1-T5347: an unreadable meminfo admits, after a bounded retry, and is ledgered rather than silent", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-mem-hold-drain-"));
  try {
    let reads = 0;
    const deps = await captureDrainDeps(root, () => {
      reads++;
      throw new Error("/proc/meminfo: EIO");
    });
    const verdict = checkDispatchGovernors({ checkMemoryGovernor: deps.checkMemoryGovernor }, undefined);
    assert.equal(verdict, undefined, "an unreadable reading admits — it never wedges dispatch");
    assert.equal(reads, 3, "the read is retried a bounded number of times, never forever");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    assert.equal(memoryRows(ledgerPath, "dispatch_memory_observed").length, 0, "no reading was taken — none is invented");
    const unreadable = memoryRows(ledgerPath, "dispatch_memory_unreadable");
    assert.equal(unreadable.length, 1, "the unknown reading is ledgered, never a silent admit");
    assert.equal(unreadable[0]!.attempts, 3);
    assert.equal(unreadable[0]!.memory_floor_mib, FLOOR);
    assert.match(String(unreadable[0]!.error), /EIO/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5347: a transient read failure recovered by the retry is an ordinary reading", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-mem-hold-gate-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    let reads = 0;
    const gate = memoryGovernorGateFor(ledgerPath, "RUN-T", { ...DEFAULT_SWEEP_POLICY, memoryFloorMib: 3072 }, () => {
      reads++;
      if (reads === 1) throw new Error("transient");
      return 1500;
    });
    const result = gate();
    assert.equal(result?.deferred, true);
    assert.equal(reads, 2);
    assert.equal(memoryRows(ledgerPath, "dispatch_memory_unreadable").length, 0);
    assert.equal(memoryRows(ledgerPath, "dispatch_memory_observed").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
