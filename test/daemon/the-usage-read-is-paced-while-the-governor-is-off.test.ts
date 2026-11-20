import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "#src/lib/daemon.js";
import { requestStop, stopDetail } from "#src/lib/fleet-control.js";
import type { UsageSnapshot } from "#src/lib/headroom.js";
import { loadPlan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

// W1-T13837: with the headroom governor off, the reading only feeds a telemetry row, yet each tick ran
// `claude -p /usage` (about 12 CPU s and 340 MB on the Azure host). The tick now reads at most once per
// HEADROOM_SAMPLE_MAX_AGE_MS while the governor is off; an armed governor still reads on every tick.

const UNDER: UsageSnapshot = {
  billingMode: "subscription",
  session: { percentUsed: 3, resetsAt: "2026-11-19T20:00:00.000Z" },
  weekly: [{ label: "all models", percentUsed: 10, resetsAt: "2026-11-22T05:00:00.000Z" }],
};
const TICK_MS = 60_000;
const SLEEPS = 11;

function planWithNothingRunnable() {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}usage-paced-plan-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, [
    "- id: A", "  title: a", "  repo: remudero", "  type: implement", "  depends_on: []",
    "  acceptance:", "    - claim: a", "      proof: unit test", "  verify: auto", "  status: done", "",
  ].join("\n"));
  return loadPlan(path);
}

async function readsOver(headroomEnabled: boolean): Promise<{ reads: number[]; beats: number }> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}usage-paced-`));
  const start = Date.parse("2026-11-19T13:00:00.000Z");
  let nowMs = start;
  let sleeps = 0;
  const reads: number[] = [];
  let beats = 0;
  await runDaemon(planWithNothingRunnable(), {
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => () => true,
    runOne: async () => { throw new Error("nothing is runnable"); },
    readUsage: () => { reads.push(nowMs - start); return UNDER; },
    now: () => new Date(nowMs),
    checkStop: () => stopDetail(root),
    sleep: async () => {
      sleeps++;
      nowMs += TICK_MS;
      if (sleeps >= SLEEPS) requestStop(root, "test done");
    },
    log: (step) => { if (step === "daemon.headroom") beats++; },
  }, { headroomEnabled });
  return { reads, beats };
}

test("W1-T13837 criterion 1: with the governor off, usage reads occur at minutes 0, 5, and 10", async () => {
  const { reads, beats } = await readsOver(false);
  assert.deepEqual(reads, [0, 300_000, 600_000]);
  assert.equal(beats, reads.length, "each read still writes its telemetry row");
});

test("W1-T13837 criterion 2: invariant:armed-reads-every-tick — an armed governor reads usage on every tick", async () => {
  const { reads } = await readsOver(true);
  assert.ok(reads.length >= SLEEPS, `every tick reads (saw ${reads.length} for ${SLEEPS} sleeps)`);
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i] - reads[i - 1] <= TICK_MS);
});
