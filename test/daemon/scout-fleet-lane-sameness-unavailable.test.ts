import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clockFromMillisFn } from "#src/lib/clock.js";
import { readFleetLaneStore, triageFleetLaneAsync, writeClassificationSnapshot, type Sameness } from "#src/lib/fleet-lane.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

test("W1-T12428: fleet_lane.sameness_unavailable no longer recurs", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t12428-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const proposals = [
    "explain the worker timeout",
    "document how long the worker waits",
    "explain how jobs are ordered",
    "document job scheduling order",
  ].map((summary, i) => ({
    id: `followup:W1-T${i < 2 ? 6000 : 6001}-run:2026-11-12T05:0${i}:00.000Z:0`,
    summary,
    evidenceAnchors: [],
  }));
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals }));
  let now = Date.now();
  const clock = clockFromMillisFn(() => now);
  writeClassificationSnapshot(stateDir, proposals.map(({ id }) => ({ proposalId: id, state: "ready" })), clock);
  let affectedCalls = 0;
  let healthyCalls = 0;
  const deps = {
    stateDir, ledgerPath, clock, mergedLastDay: () => 0, approve: () => assert.fail("no filing room"),
    sameFinding: async (earlier: string): Promise<Sameness> => {
      if (earlier === proposals[2]!.summary) {
        healthyCalls++;
        return "same";
      }
      affectedCalls++;
      if (affectedCalls === 1) return "unavailable";
      if (affectedCalls === 2) throw new Error("judge still cannot answer for this pair");
      return "same";
    },
  };
  const unavailableRows = () => readFileSync(ledgerPath, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).filter((row) => row.step === "fleet_lane.sameness_unavailable");

  assert.deepEqual((await triageFleetLaneAsync(deps)).merged, [proposals[2]!.id], "the healthy pair still reaches the judge");
  assert.equal(affectedCalls, 1);
  assert.equal(healthyCalls, 1);
  assert.deepEqual(unavailableRows().map((row) => [row.earlier, row.task_id]), [[proposals[0]!.id, proposals[1]!.id]]);
  assert.deepEqual(Object.keys(readFleetLaneStore(stateDir)), [proposals[2]!.id]);

  now += 60_000;
  assert.deepEqual((await triageFleetLaneAsync(deps)).merged, []);
  assert.equal(affectedCalls, 1, "the next pass skips this pair during its cooldown");
  assert.equal(unavailableRows().length, 1);

  now += 4 * 60_000;
  assert.deepEqual((await triageFleetLaneAsync(deps)).merged, [], "a failed recovery probe makes no merge");
  assert.equal(affectedCalls, 2);
  assert.equal(unavailableRows().length, 2, "a real failed probe remains visible");
  now += 5 * 60_000;
  assert.deepEqual((await triageFleetLaneAsync(deps)).merged, []);
  assert.equal(affectedCalls, 2, "a rejected probe extends the cooldown");

  now += 5 * 60_000;
  assert.deepEqual((await triageFleetLaneAsync(deps)).merged, [proposals[0]!.id]);
  assert.equal(affectedCalls, 3, "an unanswered finding can be merged when the judge recovers");
  assert.equal(unavailableRows().length, 2);
});
