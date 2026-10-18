import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { benchmarkCohortCadence, runBenchmarkCohortPass, type BenchmarkCohortCadence,
  type BenchmarkCohortPassResult } from "#src/lib/benchmark-cohort.js";
import { clockFromMillisFn } from "#src/lib/clock.js";

const MINUTE = 60_000;

function assignment(id: string): string {
  return JSON.stringify({ ts: "2026-10-16T06:00:00.000Z", step: "worker.assignment",
    worker_assignment: { id, selected: { provider: "cash", model: "gpt-5-nano" } } }) + "\n";
}

function fixture(): { home: string; stateDir: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-cohort-pace-"));
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.ndjson"), assignment("a0"));
  return { home, stateDir };
}

/** One daemon tick: the loop asks `check`, and only a due pass runs (daemon.ts awaits it detached). */
async function tick(hooks: BenchmarkCohortCadence): Promise<void> {
  if (hooks.checkBenchmarkCohort()) await hooks.runBenchmarkCohortPass();
}

test("W1-T8876: the benchmark cohort runs only when its inputs changed", async () => {
  const { home, stateDir } = fixture();
  let now = 1_000_000;
  let runs = 0;
  const hooks = benchmarkCohortCadence({ stateDir: () => stateDir, clock: clockFromMillisFn(() => now),
    run: (dir) => { runs += 1; return runBenchmarkCohortPass(dir, { maxSources: 4 }); } });
  try {
    for (let elapsed = 0; elapsed <= 10 * MINUTE; elapsed += 30_000) { now = 1_000_000 + elapsed; await tick(hooks); }
    assert.equal(runs, 1, "ten minutes of unchanged inputs at the daemon's 30 s cadence runs the pass once, not 20 times");

    now += 15 * MINUTE;
    await tick(hooks);
    assert.equal(runs, 1, "past the 15-minute floor, unchanged inputs still skip the pass");

    const checkpoint = join(stateDir, "benchmark-cohort-v1.json");
    const before = { bytes: readFileSync(checkpoint, "utf8"), mtimeMs: statSync(checkpoint).mtimeMs };
    const again = await hooks.runBenchmarkCohortPass();
    assert.equal(again.state, "complete");
    assert.equal(readFileSync(checkpoint, "utf8"), before.bytes, "an unchanged result leaves the checkpoint's bytes alone");
    assert.equal(statSync(checkpoint).mtimeMs, before.mtimeMs, "an unchanged result does not rewrite the checkpoint");
    runs = 1;

    appendFileSync(join(stateDir, "ledger.ndjson"), assignment("a1"));
    await tick(hooks);
    assert.equal(runs, 2, "a grown live ledger is a changed input, and the floor has passed");

    appendFileSync(join(stateDir, "ledger.ndjson"), assignment("a2"));
    now += 14 * MINUTE;
    await tick(hooks);
    assert.equal(runs, 2, "a changed input still waits out the 15-minute floor");
    now += MINUTE;
    await tick(hooks);
    assert.equal(runs, 3);

    writeFileSync(join(stateDir, "ledger.2026-10-16T06-30-00-000Z.ndjson"), assignment("r0"));
    now += 15 * MINUTE;
    await tick(hooks);
    assert.equal(runs, 4, "a new rotation is a changed input");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T8876: an unfinished cohort pass is retried at the floor even when its inputs are unchanged", async () => {
  const { home, stateDir } = fixture();
  let now = 5_000_000;
  const outcomes: Array<"partial" | "throw" | "complete"> = ["partial", "throw", "complete"];
  let runs = 0;
  const hooks = benchmarkCohortCadence({ stateDir: () => stateDir, clock: clockFromMillisFn(() => now), run: async () => {
    runs += 1;
    const outcome = outcomes.shift();
    if (outcome === "throw") throw new Error("checkpoint unreadable");
    return { state: outcome, pendingSources: outcome === "partial" ? 2 : 0 } as BenchmarkCohortPassResult;
  } });
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      assert.equal(hooks.checkBenchmarkCohort(), true, `pass ${pass} is due: the last one left work unfinished`);
      await hooks.runBenchmarkCohortPass().catch(() => undefined);
      now += 15 * MINUTE;
    }
    assert.equal(runs, 3);
    assert.equal(hooks.checkBenchmarkCohort(), false, "a finished pass over unchanged inputs is not repeated");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T8876: an unreadable ledger directory never pins the cohort as unchanged", async () => {
  const { home, stateDir } = fixture();
  let now = 9_000_000;
  let runs = 0;
  const hooks = benchmarkCohortCadence({ stateDir: () => stateDir, clock: clockFromMillisFn(() => now),
    run: async () => { runs += 1; return { state: "complete", pendingSources: 0 } as BenchmarkCohortPassResult; } });
  try {
    rmSync(stateDir, { recursive: true, force: true });
    assert.equal(hooks.checkBenchmarkCohort(), true);
    await hooks.runBenchmarkCohortPass();
    now += 15 * MINUTE;
    assert.equal(hooks.checkBenchmarkCohort(), true, "with no readable inputs there is no signature to match, so the pass runs");
    assert.equal(runs, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
