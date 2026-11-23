import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { runDaemon, type DaemonDeps, type DaemonFreshness } from "#src/lib/daemon.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

type Profile = { endMs: number; lagMs: unknown; step?: string };
type Reading = { elapsedMs: number; profiles: Profile[]; stale: boolean };

async function runWithProfiles(t: TestContext, readings: Reading[]) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const bootMs = Date.parse("2026-11-17T13:44:47Z");
  let nowMs = bootMs;
  let next = 0;
  let stopped = false;
  let profiles: Profile[] = [];
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const telemetry: DaemonDeps["readLoopTelemetry"] = Object.assign(
    () => ({ loop_delay_max_ms: 0, loop_delay_p99_ms: 0, sync_spawn_ms: 0 }),
    {
      observeLoopLag: (_reading: unknown, log: (step: string, fields: Record<string, unknown>, recoveredAtMs?: number) => void) => {
        for (const profile of profiles.splice(0)) {
          log(profile.step ?? "daemon.loop_stall_profile", { lag_ms: profile.lagMs }, bootMs + profile.endMs);
        }
      },
    },
  );
  let freshness: DaemonFreshness = { stale: false };
  const result = await runDaemon({ tasks: [], byId: new Map() }, {
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => () => false,
    runOne: async () => { assert.fail("an empty plan cannot dispatch"); },
    now: () => new Date(nowMs),
    sleep: async () => { stopped = next >= readings.length; },
    checkStop: () => stopped ? "finished fixture" : undefined,
    checkFreshness: () => {
      const reading = readings[next++];
      if (!reading) return freshness;
      nowMs = bootMs + reading.elapsedMs;
      profiles = reading.profiles.slice();
      t.mock.timers.tick(100);
      freshness = reading.stale
        ? { stale: true, oldSha: "boot", newSha: "head", changes: [{ sha: "head", files: ["src/lib/daemon.ts"] }] }
        : { stale: false };
      return freshness;
    },
    livenessPulse: true,
    readLoopTelemetry: telemetry,
    log: (step, fields = {}) => rows.push({ step, fields }),
  }, { pollIntervalMs: 100, freshnessScoreLimit: 6, freshnessMinLifetimeMs: 10_000 });
  return { result, rows };
}

const overlappingProfiles: Profile[] = [
  { endMs: 5_500, lagMs: 2_000 },
  { endMs: 2_000, lagMs: 3_000 },
  { endMs: 4_000, lagMs: 2_500 },
  { endMs: 6_000, lagMs: Number.NaN },
  { endMs: 6_000, lagMs: 6_000, step: "runtime.loop_stall_profile" },
];

test("W1-T13413 criterion 4: the daemon uses its own overlapping stall profiles only when code is stale", async (t) => {
  const { result, rows } = await runWithProfiles(t, [
    { elapsedMs: 0, profiles: [], stale: false },
    { elapsedMs: 6_000, profiles: overlappingProfiles, stale: true },
  ]);
  assert.equal(result.stopReason, "stale");
  for (const step of ["daemon.freshness_decision", "daemon.freshness_coalesced"]) {
    const row = rows.find((entry) => entry.step === step)?.fields;
    assert.ok(row, step);
    assert.equal(row.action, "restart");
    assert.equal(row.reason, "loop_stall");
    assert.equal(row.stall_ms, 5_500);
    assert.equal(row.stall_window_ms, 6_000);
    assert.equal(row.stall_pressure, 5);
    assert.equal(row.min_lifetime_ms, 10_000);
    assert.ok(Math.abs(Number(row.effective_min_lifetime_ms) - 10_000 / 12) < 1e-9);
  }
});

test("W1-T13413 criterion 4: a current checkout writes no freshness decision even with the same stalls", async (t) => {
  const { result, rows } = await runWithProfiles(t, [{ elapsedMs: 6_000, profiles: overlappingProfiles, stale: false }]);
  assert.equal(rows.filter(({ step }) => step === "daemon.loop_stall_profile").length, 4);
  assert.equal(rows.some(({ step }) => step === "daemon.freshness_decision" || step === "daemon.freshness_coalesced"), false);
  assert.equal(result.stopReason, "stopped");
});

test("W1-T13413 criterion 4: the stall window discards old profiles and clips partly overlapping ones", async (t) => {
  const { result, rows } = await runWithProfiles(t, [
    { elapsedMs: 6_000, profiles: overlappingProfiles, stale: false },
    { elapsedMs: 18_000, profiles: [{ endMs: 9_000, lagMs: 2_000 }], stale: true },
  ]);
  assert.equal(result.stopReason, "stale");
  const decision = rows.find(({ step }) => step === "daemon.freshness_decision")?.fields;
  assert.equal(decision?.stall_ms, 1_000);
  assert.equal(decision?.stall_window_ms, 10_000);
  assert.equal(decision?.stall_pressure, 0);
});
