import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateShadowMemory, type HostMemoryBudgetPolicy, type ShadowInputs } from "#src/lib/host-memory-shadow.js";

const WORKER = "implement" as const;
const policy: HostMemoryBudgetPolicy = {
  mode: "shadow", hostReserveMib: 1000, containerReserveMib: 500, swapInPagesPerSecMax: 100, psiSomeAvg10Max: 10,
  psiFullAvg10Max: 5, serveColdStartReserveMib: 2000, uncertaintyMarginMib: 300, daemonGrowthUnmeasuredMib: 400,
  daemonGrowthMinSamples: 5, staleReadingMs: 60_000,
};
const inputs = (memAvailableMib: number): ShadowInputs => ({
  memAvailable: { mib: memAvailableMib },
  swapIn: { pagesPerSec: 0 },
  psi: { someAvg10: 0, someAvg60: 0, fullAvg10: 0, fullAvg60: 0 },
  container: { currentMib: 1000, maxMib: 8000, highMib: 8000 },
  ledger: { state: "present", counts: { live: 0, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 } },
  entries: [],
  start: { reservationId: "r1", workerClass: WORKER, estimateMib: 1500 },
  daemonGrowth: [],
  serve: { scenario: "serve-steady", basis: "test" },
});

test("W1-T10317: hand_fix:src/lib/host-memory-shadow.ts is prevented, not retried", () => {
  const roomy = evaluateShadowMemory(inputs(20000), policy);
  assert.equal(roomy.numbers.hostClaimMib, 1500, "an unseen start is charged its whole estimate");
  assert.ok(roomy.reasons.every((r) => r !== "memory-available"), "ample headroom is never named memory-available");
  assert.ok(roomy.uncertainty.some((u) => u.kind === "start-unrecorded"), "an unrecorded start widens the margin");
  const tight = evaluateShadowMemory(inputs(1200), policy);
  assert.equal(tight.wouldAdmit, false);
  assert.ok(tight.reasons.includes("unrealized-reservations"));
  const unread = evaluateShadowMemory({ ...inputs(0), memAvailable: { unread: "no meminfo" } }, policy);
  assert.ok(unread.reasons.includes("uncertainty"), "unread headroom never shows a fit");
});
