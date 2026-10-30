import assert from "node:assert/strict";
import { appendFileSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as cohort from "#src/lib/benchmark-cohort.js";
import { benchmarkCohortCadence, runBenchmarkCohortPass,
  type BenchmarkCohortCadenceDeps } from "#src/lib/benchmark-cohort.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

function assignment(id: string): string {
  return JSON.stringify({ ts: "2026-10-16T06:00:00.000Z", step: "worker.assignment",
    worker_assignment: { id, selected: { provider: "cash", model: "gpt-5-nano" } } }) + "\n";
}

function fixture(t: TestContext) {
  const stateDir = ownedFixtureDir(t, "cohort-input-pace").dir;
  const live = join(stateDir, "ledger.ndjson");
  writeFileSync(live, assignment("boot"));
  let now = 1_000_000;
  let runs = 0;
  const clock = clockFromMillisFn(() => now);
  const hooks = benchmarkCohortCadence({ stateDir: () => stateDir, clock, run: async (dir) => {
    runs += 1;
    return runBenchmarkCohortPass(dir, { maxSources: 1, nowIso: clock.iso() });
  } });
  return { stateDir, live, hooks, clock, runs: () => runs, advance: (ms: number) => { now += ms; } };
}

function files(stateDir: string) {
  return readdirSync(stateDir).sort().map((name) => {
    const path = join(stateDir, name);
    const stat = statSync(path);
    return { name, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, bytes: readFileSync(path) };
  });
}

test("W1-T9912: live growth alone never makes a cohort pass due", async (t) => {
  const f = fixture(t);
  assert.equal(f.hooks.checkBenchmarkCohort(), true, "boot is the positive control");
  const boot = await f.hooks.runBenchmarkCohortPass();
  assert.equal(boot.pendingSources, 0);
  assert.equal(boot.snapshot.sourceRows.assignments, 1);
  const runsAtBoot = f.runs();
  for (let minute = 1; minute <= 120; minute += 1) {
    f.advance(60_000);
    appendFileSync(f.live, assignment(`tail-${minute}`));
    const before = files(f.stateDir);
    if (f.hooks.checkBenchmarkCohort()) await f.hooks.runBenchmarkCohortPass();
    else assert.deepEqual(files(f.stateDir), before, "a skipped check changes neither bytes nor metadata");
  }
  assert.equal(f.runs() - runsAtBoot, 0, "two hours of live growth runs ZERO daemon passes");

  const sealed = join(f.stateDir, "ledger.2026-10-16T08-00-00-000Z.ndjson");
  writeFileSync(sealed, assignment("sealed"));
  assert.equal(f.hooks.checkBenchmarkCohort(), true);
  assert.equal((await f.hooks.runBenchmarkCohortPass()).dueBecause, "sealed_sources");
  while (f.hooks.checkBenchmarkCohort()) await f.hooks.runBenchmarkCohortPass();
  const checkpoint = JSON.parse(readFileSync(join(f.stateDir, "benchmark-cohort-index.json"), "utf8"));
  assert.equal(checkpoint.lastGood.sourceRows.assignments, 122, "the pass folds both archive and live tail");
});

test("W1-T9912: rows leaving the live file make the next pass due", async (t) => {
  const f = fixture(t);
  const boot = await f.hooks.runBenchmarkCohortPass();
  const foldedBytes = boot.snapshot.liveWatermark!.prefixBytes;
  appendFileSync(f.live, assignment("tail"));
  assert.equal(f.hooks.checkBenchmarkCohort(), false);
  writeFileSync(f.live, assignment("boot"));
  assert.equal(statSync(f.live).size, foldedBytes);
  assert.equal(f.hooks.checkBenchmarkCohort(), false, "only shrinking below the folded prefix is due");
  writeFileSync(f.live, "");
  assert.equal(f.hooks.checkBenchmarkCohort(), true);
  const shrank = await f.hooks.runBenchmarkCohortPass();
  assert.equal(shrank.dueBecause, "live_shrank");
  assert.equal(f.hooks.checkBenchmarkCohort(), false);

  const oldInode = statSync(f.live).ino;
  renameSync(f.live, join(f.stateDir, "departing-live"));
  writeFileSync(f.live, "");
  assert.notEqual(statSync(f.live).ino, oldInode);
  assert.equal(f.hooks.checkBenchmarkCohort(), true);
  assert.equal((await f.hooks.runBenchmarkCohortPass()).dueBecause, "live_identity");
  assert.equal(f.hooks.checkBenchmarkCohort(), false);
});

test("W1-T9912: a failed pass waits its own measured cost before retrying", async (t) => {
  const f = fixture(t);
  let failing = true;
  let cost = 80;
  let runs = 0;
  const hooks = benchmarkCohortCadence({ stateDir: () => f.stateDir, clock: f.clock, run: async (dir) => {
    runs += 1;
    f.advance(cost);
    if (failing) throw new Error("projection failed");
    return runBenchmarkCohortPass(dir, { maxSources: 4, nowIso: f.clock.iso() });
  } });
  for (const [duration, multiplier] of [[80, 1], [130, 2], [50, 4]]) {
    cost = duration;
    assert.equal(hooks.checkBenchmarkCohort(), true);
    const before = runs;
    await assert.rejects(hooks.runBenchmarkCohortPass(), /projection failed/);
    writeFileSync(join(f.stateDir, "ledger.2026-10-16T08-00-00-000Z.ndjson"), assignment(`change-${runs}`));
    assert.equal(hooks.checkBenchmarkCohort(), false, "even a changed input must respect the failed pass's cost");
    f.advance(duration * multiplier - 1);
    assert.equal(hooks.checkBenchmarkCohort(), false);
    assert.equal(runs, before + 1);
    f.advance(1);
    assert.equal(hooks.checkBenchmarkCohort(), true, "the retry is due exactly at its measured wait");
  }
  failing = false;
  cost = 70;
  const success = await hooks.runBenchmarkCohortPass();
  assert.equal(success.dueBecause, "retry");
  assert.equal(success.passMs, 70);
  assert.equal(hooks.checkBenchmarkCohort(), false);

  writeFileSync(join(f.stateDir, "ledger.2026-10-16T09-00-00-000Z.ndjson"), assignment("after-success"));
  assert.equal(hooks.checkBenchmarkCohort(), true, "success leaves no delay on new input");
  failing = true;
  cost = 30;
  await assert.rejects(hooks.runBenchmarkCohortPass(), /projection failed/);
  f.advance(29);
  assert.equal(hooks.checkBenchmarkCohort(), false);
  f.advance(1);
  assert.equal(hooks.checkBenchmarkCohort(), true, "success reset the multiplier to one");
});

test("W1-T9912: the cohort cadence has no fixed interval", async (t) => {
  const hasIntervalDep: "intervalMs" extends keyof BenchmarkCohortCadenceDeps ? true : false = false;
  assert.equal(hasIntervalDep, false);
  assert.equal("BENCHMARK_COHORT_MIN_INTERVAL_MS" in cohort, false);
  const f = fixture(t);
  await f.hooks.runBenchmarkCohortPass();
  writeFileSync(join(f.stateDir, "ledger.2026-10-16T08-00-00-000Z.ndjson"), assignment("immediate"));
  assert.equal(f.hooks.checkBenchmarkCohort(), true, "a sealed source is due without advancing time");
  assert.equal((await f.hooks.runBenchmarkCohortPass()).dueBecause, "sealed_sources");
});

test("W1-T9912: partial passes drain the backlog without advancing the clock", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i += 1)
    writeFileSync(join(f.stateDir, `ledger.2026-10-16T08-0${i}-00-000Z.ndjson`), assignment(`sealed-${i}`));
  const started = f.clock.now();
  for (let pass = 0; pass < 4; pass += 1) {
    assert.equal(f.hooks.checkBenchmarkCohort(), true);
    const result = await f.hooks.runBenchmarkCohortPass();
    assert.equal(result.dueBecause, pass === 0 ? "boot" : "partial");
    assert.equal(result.pendingSources, 3 - pass);
    assert.equal(result.passMs, 0);
  }
  assert.equal(f.runs(), 4);
  assert.equal(f.clock.now(), started);
  assert.equal(f.hooks.checkBenchmarkCohort(), false);
});

test("W1-T9912: sealed source metadata changes and a new boot are due", async (t) => {
  const f = fixture(t);
  await f.hooks.runBenchmarkCohortPass();
  const sealed = join(f.stateDir, "ledger.2026-10-16T08-00-00-000Z.ndjson");
  writeFileSync(sealed, assignment("sealed"));
  while (f.hooks.checkBenchmarkCohort()) await f.hooks.runBenchmarkCohortPass();
  appendFileSync(sealed, assignment("sealed-later"));
  assert.equal(f.hooks.checkBenchmarkCohort(), true, "sealed sizes participate in the signature");
  assert.equal((await f.hooks.runBenchmarkCohortPass()).dueBecause, "sealed_sources");
  const mtime = statSync(sealed).mtime;
  utimesSync(sealed, mtime, new Date(mtime.getTime() + 1_000));
  assert.equal(f.hooks.checkBenchmarkCohort(), true, "sealed mtimes participate in the signature");
  await f.hooks.runBenchmarkCohortPass();
  assert.equal(f.hooks.checkBenchmarkCohort(), false);
  const rebooted = benchmarkCohortCadence({ stateDir: () => f.stateDir, clock: f.clock,
    run: (dir) => runBenchmarkCohortPass(dir) });
  assert.equal(rebooted.checkBenchmarkCohort(), true, "a checkpoint on disk never suppresses the boot pass");
  assert.equal((await rebooted.runBenchmarkCohortPass()).dueBecause, "boot");
});
