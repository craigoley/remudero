import assert from "node:assert/strict";
import { test } from "node:test";

import { createSweepFixAdmissionController, FIX_STARVATION_MS, type OpenPrView } from "#src/lib/sweep.js";

const pr = { prNumber: 13996 } as OpenPrView;

function controller(waitedMs: number) {
  const since = Date.now() - waitedMs;
  return createSweepFixAdmissionController({
    surface: "full",
    queueDepth: 1,
    hostWorkerBudget: 8,
    activeWorkers: 1,
    reviewReservations: 0,
    readReviewReservations: () => 0,
    readActiveWorkers: () => 1,
    readPressure: () => ({ availableMib: 3_072 + 1_908, floorMib: 3_072, binding: "host", tier: "fits" }),
    readEstimate: (c) => c === "fix" ? { estimateMib: 3_674, samples: 40 } : { estimateMib: 1_024, samples: 40 },
    readTypical: (c) => c === "fix" ? { estimateMib: 786, samples: 40 } : { estimateMib: 1_024, samples: 40 },
    readResidents: () => ({ review: [], fix: [900] }),
    reviewQueue: [],
    waitSinceMs: () => since,
  });
}

test("W1-T10596: flow-review-failed-n-unmet-criteria clears without a person", () => {
  const fresh = controller(60_000).claim(pr);
  assert.equal(fresh.admitted, false, "a recently queued repair still yields to a live fix tree");
  const starved = controller(FIX_STARVATION_MS + 60_000).claim(pr);
  assert.equal(starved.admitted, true, "a repair starved past the bound is admitted on the typical peak");
  const tooSmall = createSweepFixAdmissionController({
    surface: "full", queueDepth: 1, hostWorkerBudget: 8, activeWorkers: 1, reviewReservations: 0,
    readPressure: () => ({ availableMib: 3_072 + 500, floorMib: 3_072, binding: "host", tier: "fits" }),
    readEstimate: () => ({ estimateMib: 3_674, samples: 40 }),
    readTypical: () => ({ estimateMib: 786, samples: 40 }),
    readResidents: () => ({ review: [], fix: [900] }),
    reviewQueue: [], waitSinceMs: () => 0,
  }).claim(pr);
  assert.equal(tooSmall.admitted, false, "starvation never admits past the typical peak");
});
