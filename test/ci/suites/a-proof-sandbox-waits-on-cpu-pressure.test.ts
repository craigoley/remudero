/**
 * W1-T15002 — A PROOF SANDBOX WAITS ON HOST CPU PRESSURE. Every concurrent review sized its own width from PSI, so the
 * host-wide total of bwrap proof sandboxes and `node --test` children outran the cores (2026-11-26: CPU some avg10 87%
 * on 8 cores, 14 sandboxes and 29 test children at once). A proof child now takes a host-wide lease, admitted while the
 * host's unstalled cores ({@link pressureWidth}) exceed the live leases, with no fixed count; unreadable PSI admits.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { asyncProofSpawnerWith, recordProofCpuWait } from "#src/lib/review.js";
import {
  acquireProofCpuAdmission, PROOF_CPU_ADMISSION_WAIT_STEP, readHostPressure, readProofCpuAdmission,
  type HostPressure, type ProofCpuAdmissionPorts,
} from "#src/lib/test-slot.js";

/** Ports over a private lease dir, a manual clock that each sleep advances, and a scripted pressure sequence. */
function ports(readings: Array<HostPressure | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-cpu-"));
  let nowMs = Date.now(); // lease mtimes are real, so the manual clock starts at real time
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let reads = 0, sleeps = 0;
  const value: ProofCpuAdmissionPorts = {
    dir, pidNs: "pid:[1]", isPidAlive: () => true,
    clock: clockFromMillisFn(() => nowMs),
    sleep: async (ms) => { sleeps++; nowMs += ms; },
    readPressure: () => readings[Math.min(reads++, readings.length - 1)],
    log: (step, fields) => rows.push({ step, fields }),
  };
  const holdOther = (pidNs = "pid:[2]") =>
    writeFileSync(join(dir, `other-${pidNs}.json`), JSON.stringify({ pid: 4242, pidNs, host: "peer" }));
  return { value, dir, rows, holdOther, sleeps: () => sleeps, reads: () => reads,
    leases: () => readdirSync(dir).length, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const stalled: HostPressure = { cores: 8, cpuStallPercent: 90, load1: 60 }; // one unstalled core
const freed: HostPressure = { cores: 8, cpuStallPercent: 70, load1: 30 };   // two unstalled cores

test("W1-T15002 criterion 1: a proof sandbox waits while CPU pressure leaves no free core and starts when one frees", async () => {
  const fixture = ports([stalled, stalled, stalled, freed]);
  try {
    fixture.holdOther(); // a live proof child in another container holds the one unstalled core
    assert.deepEqual(readProofCpuAdmission({ ...fixture.value, readPressure: () => stalled }),
      { admit: false, sample: stalled, inFlight: 1, width: 1 });
    const admission = await acquireProofCpuAdmission(fixture.value);
    assert.equal(fixture.sleeps(), 3, "three stalled readings wait; the fourth shows a free core and starts");
    assert.equal(fixture.leases(), 2, "the admitted child holds its own lease beside the peer's");
    admission.release();
    admission.release();
    assert.equal(fixture.leases(), 1, "release removes only its own lease, and twice is safe");

    // A peer lease whose holder died in this pid namespace frees its core at once; nothing waits on it.
    const reclaimed = ports([stalled]);
    reclaimed.holdOther("pid:[1]");
    reclaimed.value.isPidAlive = () => false;
    (await acquireProofCpuAdmission(reclaimed.value)).release();
    assert.equal(reclaimed.sleeps(), 0);
    assert.equal(reclaimed.leases(), 0);
    reclaimed.cleanup();

    // A lease nobody has beaten for three heartbeats is a holder that vanished elsewhere: it is not counted either.
    const silent = ports([stalled]);
    silent.holdOther();
    const old = new Date(Date.now() - 4 * 60_000);
    for (const name of readdirSync(silent.dir)) utimesSync(join(silent.dir, name), old, old);
    (await acquireProofCpuAdmission(silent.value)).release();
    assert.deepEqual([silent.sleeps(), silent.leases()], [0, 0]);
    silent.cleanup();

    // The review's spawner starts no child until the admission is granted, and releases it after the child exits.
    let grant!: () => void;
    let released = 0;
    const marker = join(fixture.dir, "child-ran");
    const spawner = asyncProofSpawnerWith(() => new Promise((resolve) => {
      grant = () => resolve({ release: () => { released++; } });
    }));
    const run = spawner(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`],
      fixture.dir, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(marker), false, "no child before admission");
    grant();
    await run.catch(() => {}); // a host whose sandbox cannot start still releases the admission
    assert.equal(released, 1);
  } finally {
    fixture.cleanup();
  }
});

test("W1-T15002 criterion 2: a CPU admission wait is ledgered with its reading", async () => {
  const fixture = ports([stalled, stalled, freed]);
  try {
    fixture.holdOther();
    (await acquireProofCpuAdmission({ ...fixture.value, pollMs: 1_500 })).release();
    assert.deepEqual(fixture.rows, [{ step: PROOF_CPU_ADMISSION_WAIT_STEP, fields: {
      cpu_stall_percent: 70, cores: 8, width: 2, in_flight: 1, wait_ms: 3_000 } }]);

    const prompt = ports([freed]);
    (await acquireProofCpuAdmission(prompt.value)).release();
    assert.deepEqual(prompt.rows, [], "an admission that never waited writes no row");
    prompt.cleanup();

    // The review lane's logger writes the row to the instance ledger under SWEEP.
    const home = mkdtempSync(join(tmpdir(), "rmd-proof-cpu-home-"));
    const saved = process.env.HOME;
    try {
      mkdirSync(join(home, ".config", "remudero"), { recursive: true });
      writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root: join(home, "instance") }));
      mkdirSync(join(home, "instance", "state"), { recursive: true });
      process.env.HOME = home;
      recordProofCpuWait(PROOF_CPU_ADMISSION_WAIT_STEP, fixture.rows[0]!.fields);
      const rows = readFileSync(join(home, "instance", "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(rows.map((row) => [row.step, row.task_id, row.wait_ms, row.in_flight]),
        [[PROOF_CPU_ADMISSION_WAIT_STEP, "SWEEP", 3_000, 1]]);
    } finally {
      process.env.HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fixture.cleanup();
  }
});

test("W1-T15002 criterion 3: an unreadable pressure file admits as today", async () => {
  const unreadable = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  // No PSI, and a load average far over the cores: the load fallback must not hold a proof child.
  const loadOnly = readHostPressure(unreadable, () => [999], () => 8);
  assert.deepEqual(loadOnly, { cores: 8, load1: 999 });
  for (const reading of [loadOnly, undefined]) {
    const fixture = ports([reading]);
    try {
      fixture.holdOther();
      fixture.holdOther("pid:[3]");
      const admission = await acquireProofCpuAdmission(fixture.value);
      assert.equal(fixture.sleeps(), 0, "no wait");
      assert.equal(fixture.leases(), 2, "no lease of its own, exactly as before");
      assert.deepEqual(fixture.rows, []);
      admission.release();
    } finally {
      fixture.cleanup();
    }
  }
});
