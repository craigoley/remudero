// @source-text-subject — W1-T2905's declared carve-out, for W1-T3726's wiring check.
//
// This assertion reads `src/run-task.ts` AS TEXT, which the source-text census refuses by default
// and for a good reason: such a test passes when the prose is right and the behaviour is wrong. The
// census offers exactly two remedies — assert on behaviour instead, or declare a file whose SUBJECT
// genuinely IS the source text. The first does not fit: the recon and diagnose dispatch sites build
// their spawn arguments INLINE inside `runTaskBody`, a single dispatch function with no exported
// seam short of actually spawning a worker process, so whether `cashDivertSpawnFields` reaches
// either call site is a fact about the source and nothing else. That is the second remedy's case
// precisely — the same shape test/the-destructive-credit-consumers-are-wired.test.ts already
// documents for an inline-constructed object with no injection seam.
//
// SPLIT OUT rather than left in test/a-blocked-auction-falls-back-to-cash.test.ts, for the same
// reason that file gives: the marker is FILE-LEVEL, and that file's other tests
// (cashCanServeToolSurface, cashFallbackRefusal, cashDivertToolsForLane, cashDivertSpawnFields) are
// genuinely behavioural — declaring the whole file "subject is source text" would blind the census
// to a real source-text read added there later.
//
// WHAT IS PINNED: W1-T3726 fixed the helper (`cashDivertToolsForLane`/`cashDivertSpawnFields`), and
// this test pins that BOTH call sites actually use it — the wiring, not just the helper's own
// answer, which is what let the original defect (only implement's spawn ever offered its cash
// surface) hide behind an already-correct DISPATCH_LANE_TOOL_BOUNDS table.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("W1-T3726: both read-only dispatch sites actually pass cashTools to the spawn", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  for (const lane of ["recon", "diagnose"]) {
    assert.ok(
      src.includes(`...cashDivertSpawnFields("${lane}")`),
      `the ${lane} dispatch must spread the divert fields, or the auction still judges its Claude surface`,
    );
  }
});
