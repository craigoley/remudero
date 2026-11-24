import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { HostMemoryReading, ReadingEntry } from "#src/lib/host-memory-ledger.js";
import { appendLedger } from "#src/lib/ledger.js";
import { RUN_CHILD_SCHEMA } from "#src/lib/run-child-contract.js";
import * as childReservation from "#src/lib/run-child-reservation.js";
import { readLedgerLines } from "#src/lib/status.js";
import {
  buildFixDispatchEnvelope, createSweepFixAdmissionController, fixAdmissionLockPath, fixDispatchMemoryCause,
  productionFixAdmissionResidents, runFixDispatchChild, type OpenPrView,
} from "#src/lib/sweep.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const floorMib = 3_072;
const estimateMib = 5_864;
const typicalMib = 1_628;
const pr: OpenPrView = {
  prNumber: 13105, prUrl: "https://github.com/acme/widget/pull/13105", taskId: "W1-T13105", headSha: "13105cafe",
  reviewState: "failure", checksState: "green", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: "2026-11-19T20:30:00Z", autoMergeArmed: false,
};
const spec = {
  schema: RUN_CHILD_SCHEMA, taskId: "W1-T13105", runId: "work-fix-dispatch-W1-T13105",
  instance: "test", engine: { sourceHash: "test", sha: "test" }, planSnapshotPath: "unused",
  reservationId: "this-fix-child", options: {},
};

function hostedFix(t: TestContext, headroomMib: number, otherFix = false) {
  const { dir } = ownedFixtureDir(t, "fix-child-refused");
  const ledgerPath = join(dir, "ledger.ndjson");
  const files = new Map<string, string>();
  const reserve = (id: string, pid: number): ReadingEntry => {
    const path = join(dir, `${id}.json`);
    files.set(path, JSON.stringify({ roots: [{ pid, start: "proc:12" }], tree: [] }));
    files.set(`/proc/${pid}/stat`, `${pid} (node) S 1 ${Array(17).fill("0").join(" ")} 12 0`);
    files.set(`/proc/${pid}/status`, "VmRSS:\t665600 kB\nVmSwap:\t0 kB\n");
    return {
      id, path, owner: "test", workerClass: "fix", status: "owned", estimateMib,
      estimateSource: { kind: "default-unmeasured" }, ageMs: 15_000, sinceVerifiedMs: 0, walkComplete: true,
    };
  };
  const entries = [reserve(spec.reservationId, 42)];
  if (otherFix) entries.push(reserve("another-fix-child", 43));
  const reading: HostMemoryReading = {
    state: "present", scope: "local", dir, entries, reservedMib: entries.length * estimateMib,
    counts: { live: entries.length, uncertain: 0, incompleteWalk: 0, localScope: entries.length, unreadable: 0 },
  };
  const log = (step: string, fields?: Record<string, unknown>) => {
    appendLedger(ledgerPath, { run_id: spec.runId, task_id: spec.taskId, step, ...fields });
  };
  const owner = { run_id: "sweep-parent", pid: process.pid, host: hostname(), startedAt: pr.lastActivityAt };
  const lock = fixAdmissionLockPath(dir, pr);
  writeFileSync(lock, JSON.stringify(owner));
  const envelope = buildFixDispatchEnvelope(pr, { unmetCriteria: [] }, {
    fixKey: `${pr.taskId}@${pr.headSha}`, decidedAtMs: 1, fixAdmissionLockDir: dir, fixAdmissionOwner: owner,
  });
  const dispatched: string[] = [];
  const run = () => childReservation.withRunChildReservation(spec, () => runFixDispatchChild({ envelope }, {
    readLivePr: async () => ({ state: "OPEN", headSha: pr.headSha }),
    readTask: () => ({ found: true, merged: false, retired: false }),
    hold: () => undefined,
    log,
    claimFixAdmission: (view) => {
      assert.equal(childReservation.currentRunChildReservationId(), spec.reservationId);
      return createSweepFixAdmissionController({
        surface: "full", queueDepth: 1, hostWorkerBudget: 8, activeWorkers: 5, reviewReservations: 0, log,
        readPressure: () => ({ availableMib: floorMib + headroomMib, floorMib }),
        readEstimate: () => ({ estimateMib, samples: 10 }),
        readTypical: () => ({ estimateMib: typicalMib, samples: 10 }),
        readResidents: () => productionFixAdmissionResidents(dir, () => reading, (path) => {
          const text = files.get(path);
          assert.ok(text, `unexpected residency read ${path}`);
          return text;
        }, () => ({ estimateMib: typicalMib, samples: 10 }), () => ({ factor: 1, samples: 10 }), () => true),
      }).claim(view);
    },
    dispatcher: () => ({ dispatchFix: async (view) => { dispatched.push(view.headSha); } }),
  }));
  return { run, dispatched, lock, rows: () => readLedgerLines(ledgerPath) };
}

test("W1-T13105: sweep.fix.child_refused no longer recurs", async (t) => {
  const child = hostedFix(t, 4_481);
  await child.run();
  assert.deepEqual(child.dispatched, [pr.headSha]);
  assert.ok(child.rows().some((row) => row.step === "sweep.fix_capacity" && row.admission_rung === "typical"));
  assert.equal(child.rows().filter((row) => row.step === "sweep.fix.child_refused").length, 0);
  assert.ok(existsSync(child.lock), "the parent still holds admission until settlement");
});

test("W1-T13105: the symptom is still recorded when its failure occurs", async (t) => {
  for (const [headroom, otherFix] of [[typicalMib - 1, false], [4_481, true]] as const) {
    const child = hostedFix(t, headroom, otherFix);
    const prefix = "fix dispatch refused: ";
    await assert.rejects(child.run(), (error: Error) => {
      assert.ok(fixDispatchMemoryCause(error.message), error.message);
      const refusal = child.rows().filter((row) => row.step === "sweep.fix.child_refused");
      assert.equal(refusal.length, 1);
      assert.equal(refusal[0]?.pr_number, pr.prNumber);
      assert.equal(refusal[0]?.head_sha, pr.headSha);
      assert.equal(refusal[0]?.reason, error.message.slice(prefix.length));
      return true;
    });
    assert.deepEqual(child.dispatched, []);
    assert.ok(existsSync(child.lock), "the parent still holds admission until settlement");
  }
});
