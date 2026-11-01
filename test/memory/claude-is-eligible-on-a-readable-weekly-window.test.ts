import assert from "node:assert/strict";
import { test } from "node:test";

import { sdkUsageReadingCase, usageSnapshotFromSdk, type SdkUsageReading } from "#src/lib/headroom.js";
import { claudeCapacityFromUsageCase, providerEligibility, selectWorkerProvider } from "#src/lib/worker-provider.js";

/** The fleet account's real shape on 2026-11-01: a readable weekly window and an empty five-hour one. */
const weeklyOnly: SdkUsageReading = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: { utilization: 3, resets_at: "2026-11-08T04:59:59Z" },
    model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-11-08T05:00:00Z" }],
  },
};

test("W1-T11072 criterion 1: a reading with weekly windows and no five-hour window is routable on its weekly windows", () => {
  const reading = sdkUsageReadingCase(weeklyOnly);
  assert.equal(reading.kind, "weekly-only");
  assert.equal(usageSnapshotFromSdk(weeklyOnly), undefined, "the governor's snapshot still refuses a reading with no session window");
  const capacity = claudeCapacityFromUsageCase(reading, "fleet");
  assert.equal(capacity.readable, true);
  assert.deepEqual(capacity.windows, [
    { name: "weekly (all models)", usedPercent: 3, resetsAt: "2026-11-08T04:59:59Z" },
    { name: "weekly (Fable)", usedPercent: 0, resetsAt: "2026-11-08T05:00:00Z" },
  ]);
  assert.equal(capacity.accountLabel, "fleet");
  assert.match(String(capacity.detail), /weekly windows only/);
  assert.equal(providerEligibility(capacity, 5).eligible, true);
  assert.equal(selectWorkerProvider([capacity], 5, 0).provider, "claude");
});

test("W1-T11072 criterion 1: a weekly window at the reserve keeps Claude ineligible", () => {
  const spent = sdkUsageReadingCase({ ...weeklyOnly, rate_limits: { five_hour: null, seven_day: { utilization: 99 } } });
  const capacity = claudeCapacityFromUsageCase(spent);
  assert.equal(capacity.readable, true);
  assert.equal(providerEligibility(capacity, 5).eligible, false);
});

test("W1-T11072 criterion 1: a reading with a session window is unchanged", () => {
  const full: SdkUsageReading = { ...weeklyOnly, rate_limits: { ...weeklyOnly.rate_limits, five_hour: { utilization: 20 } } };
  const reading = sdkUsageReadingCase(full);
  assert.equal(reading.kind, "session");
  const capacity = claudeCapacityFromUsageCase(reading);
  assert.equal(capacity.windows[0]!.name, "session (5h)");
  assert.equal(capacity.windows[0]!.usedPercent, 20);
});

test("W1-T11072 criterion 1: every reading with no usable window stays unreadable and names its own case", () => {
  const cases: Array<[SdkUsageReading | undefined, string]> = [
    [undefined, "no-reading"],
    [{ rate_limits_available: false, rate_limits: weeklyOnly.rate_limits }, "rate-limits-unavailable"],
    [{ rate_limits_available: true, rate_limits: null }, "no-rate-limits"],
    [{ rate_limits_available: true, rate_limits: { five_hour: null, seven_day: null, model_scoped: [{ display_name: "", utilization: 4 }] } }, "no-usable-window"],
  ];
  for (const [input, kind] of cases) {
    const reading = sdkUsageReadingCase(input);
    assert.equal(reading.kind, kind);
    const capacity = claudeCapacityFromUsageCase(reading);
    assert.deepEqual([capacity.readable, capacity.windows, capacity.detail], [false, [], `capacity unreadable: ${kind}`]);
  }
});
