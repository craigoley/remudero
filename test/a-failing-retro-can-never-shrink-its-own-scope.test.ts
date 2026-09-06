// W1-T2875: `state/last-retro.json` advanced only when a retro SUCCEEDED, so a retro that died left
// `sinceTs` frozen and the next pass re-scoped over a window that had only grown. MEASURED
// 2026-09-05: the marker sat at 2026-09-03T02:24:39Z for two days while scope climbed 63 -> 68 and
// six consecutive attempts aborted at V8's heap limit (exit 134); five of those spent docker's
// on-failure:5 budget and the fleet sat dead for three hours.
//
// TWO ROUTES INTO THE RATCHET, AND THEY NEED DIFFERENT REMEDIES:
//   (a) an OOM abort kills the process without unwinding, so NO in-process hook can advance the
//       marker. Only bounding the window itself survives that — RETRO_MAX_RUNS_PER_PASS.
//   (b) a catchable terminal failure (the plan-only guard returning 1) used to return with the
//       marker untouched. That arm is fixed by advancing above the guard, to the CONSUMED cursor.
//
// These tests pin the bound and the cursor. The cursor is what makes the bound safe: a capped pass
// consumes the OLDEST runs and reports how far it got, so the remainder is deferred, never dropped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRO_MAX_RUNS_PER_PASS, buildGather, loadMarker } from "../src/lib/retro.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** N run.start lines, one per day, ascending — the order `gatherRuns` itself sorts into. */
function ledger(n: number, startDay = 1): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, startDay + i)).toISOString();
    lines.push(JSON.stringify({ ts: d, step: "run.start", run_id: `R${i}`, task_id: `W1-T${i}` }));
  }
  return lines.join("\n");
}

const BASE = { learningsMd: "", learningsAtMarker: 0 };

test("W1-T2875: a failing retro advances the marker", () => {
  // The marker records `gather.consumedThroughTs`, not `now()`. That is the whole mechanism: a pass
  // states how far it actually got, and `run-task.ts` writes exactly that — above the plan-only
  // guard, so a guard failure still advances.
  const g = buildGather({ ...BASE, ledgerNdjson: ledger(5), maxRunsPerPass: 3 });
  assert.equal(g.totalRuns, 3, "the cap bounds what one pass consumes");
  assert.equal(g.runsDeferred, 2, "and reports what it left behind rather than dropping it");
  assert.equal(g.consumedThroughTs, "2026-01-03T00:00:00.000Z", "the cursor is the newest run CONSUMED");

  // FALSIFIER: the cursor must not be the end of the WINDOW, or a capped pass would skip the
  // deferred runs entirely — silent data loss dressed up as progress.
  assert.notEqual(g.consumedThroughTs, "2026-01-05T00:00:00.000Z");
});

test("W1-T2875: consecutive failures do not grow the scope", () => {
  // THE RATCHET, REPRODUCED. Attempt 1 dies (an OOM: nothing advances, the marker is untouched),
  // and meanwhile more runs accrue. Before the cap, attempt 2 scoped strictly MORE than attempt 1
  // and so failed sooner; that is what made the failure permanent.
  const attempt1 = buildGather({ ...BASE, ledgerNdjson: ledger(50) });
  const attempt2 = buildGather({ ...BASE, ledgerNdjson: ledger(60) }); // ten more runs arrived
  assert.ok(
    attempt2.totalRuns <= attempt1.totalRuns,
    `a second attempt must never scope more than the first (got ${attempt2.totalRuns} vs ${attempt1.totalRuns})`,
  );
  assert.equal(attempt1.totalRuns, RETRO_MAX_RUNS_PER_PASS, "both are pinned at the cap");
  assert.equal(attempt2.totalRuns, RETRO_MAX_RUNS_PER_PASS);
  assert.ok(attempt2.runsDeferred > attempt1.runsDeferred, "the backlog is visible, not hidden");

  // AND THE BACKLOG STILL DRAINS. Advancing to the cursor lets the next pass take the next batch —
  // a bound that never made progress would be a worse defect than the one it replaced.
  const next = buildGather({ ...BASE, ledgerNdjson: ledger(60), sinceTs: attempt2.consumedThroughTs });
  assert.ok(next.totalRuns > 0, "the pass after a capped one consumes the deferred remainder");
  assert.ok(
    next.consumedThroughTs! > attempt2.consumedThroughTs!,
    "and the cursor moves strictly forward, so the window cannot stall",
  );
});

test("W1-T2875: a corrupt marker still fails closed", () => {
  // UNCHANGED BEHAVIOUR, ASSERTED SO THIS TASK CANNOT ERODE IT. A corrupt-but-present marker must
  // never collapse into "no marker": that reading replays the whole already-consumed window, which
  // is the very thing the cursor above exists to prevent.
  const dir = mkdtempSync(join(tmpdir(), "rmd-retro-marker-"));
  try {
    const p = join(dir, "last-retro.json");
    writeFileSync(p, "{ this is not json");
    assert.throws(() => loadMarker(p), /not parseable JSON/i, "a torn marker throws rather than reading as absent");

    // Control: an ABSENT marker is the legitimate first-ever-retro signal and must stay undefined.
    assert.equal(loadMarker(join(dir, "nope.json")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
