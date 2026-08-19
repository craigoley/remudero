import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGather,
  parseLedger,
  renderGather,
  renderReplayCalibration,
  replayPassRateForCycle,
} from "../src/lib/retro.js";
import { recordReplayResults, replayGoldens, SEEDED_GOLDENS, type HarnessRunner } from "../src/lib/replay.js";

// ── W1-T165 acceptance claim 3: "the retro reports replay pass-rate over time" ──
//
// PROOF (verbatim, task note): "unit test: the retro's calibration section renders the
// replay pass-rate (n passed / n goldens) for the cycle, from the replay records; a retro
// that omits it FAILS." This file drives replay.ts's own mechanism end to end into a ledger
// NDJSON string, then asserts retro.ts's gather/render path surfaces it.

const unchangedHarness: HarnessRunner = (golden) => ({
  verdict: golden.expected.verdict,
  filesTouched: golden.expected.filesTouched,
  prTrailerTaskId: golden.expected.prTrailerTaskId,
  ...(golden.expected.fixDispatches !== undefined ? { fixDispatches: golden.expected.fixDispatches } : {}),
});

/** Build a ledger NDJSON string of replay-result lines the way a production run
 *  would (via `recordReplayResults`'s injectable writer, joined here into one string —
 *  no disk I/O, same discipline `parseLedger`'s other callers in this repo already use). */
async function ledgerNdjsonFromReplay(runId: string, taskId: string, ts: string): Promise<string> {
  const results = await replayGoldens(SEEDED_GOLDENS, unchangedHarness);
  const lines: string[] = [];
  recordReplayResults(runId, taskId, results, {
    ledgerPath: "/dev/null/unused",
    writeLedger: (_path, line) => void lines.push(JSON.stringify({ ts, ...line })),
  });
  return lines.join("\n");
}

test("replayPassRateForCycle: NO replay line recorded reports ranThisCycle=false (P48: no naked zero)", () => {
  const report = replayPassRateForCycle([]);
  assert.equal(report.ranThisCycle, false);
  assert.equal(report.total, 0);
  assert.equal(report.passed, 0);
});

test("replayPassRateForCycle: 3 passing replay-result lines report 3/3, rate=1", async () => {
  const ndjson = await ledgerNdjsonFromReplay("RUN-1", "W1-T165", "2026-08-01T00:00:00.000Z");
  const records = parseLedger(ndjson);
  const report = replayPassRateForCycle(records);
  assert.equal(report.ranThisCycle, true);
  assert.equal(report.total, 3);
  assert.equal(report.passed, 3);
  assert.equal(report.rate, 1);
});

test("replayPassRateForCycle: unrelated ledger steps mixed in are ignored — only REPLAY_RESULT_STEP lines are counted", () => {
  const records = parseLedger(
    [
      `{"ts":"2026-08-01T00:00:00.000Z","run_id":"R1","task_id":"W1-T1","step":"run.start"}`,
      `{"ts":"2026-08-01T00:01:00.000Z","run_id":"R1","task_id":"W1-T1","step":"verdict","verdict":"merged"}`,
    ].join("\n"),
  );
  assert.equal(replayPassRateForCycle(records).ranThisCycle, false);
});

test("replayPassRateForCycle: scoped to sinceTs — a replay run before the marker does not count toward this cycle", async () => {
  const ndjson = await ledgerNdjsonFromReplay("RUN-OLD", "W1-T165", "2020-01-01T00:00:00.000Z");
  const records = parseLedger(ndjson);
  const report = replayPassRateForCycle(records, "2026-01-01T00:00:00.000Z");
  assert.equal(report.ranThisCycle, false, "a replay run predating the marker is out of THIS cycle's scope");
});

test("renderReplayCalibration: the two zero-shaped states render distinctly (P48)", () => {
  const noRun = renderReplayCalibration(replayPassRateForCycle([]));
  assert.match(noRun, /No replay run recorded this cycle/);
  assert.doesNotMatch(noRun, /0\/0/);

  const allPass = renderReplayCalibration({ ranThisCycle: true, total: 3, passed: 3, rate: 1 });
  assert.match(allPass, /3\/3 goldens \(100%\)/);
});

// ── Reached from the retro gather, not merged unwired (the acceptance's own phrasing) ─

test("buildGather/renderGather: the replay pass-rate is present on the gather object and rendered in the calibration section", async () => {
  const ndjson = await ledgerNdjsonFromReplay("RUN-2", "W1-T165", "2026-08-01T00:00:00.000Z");
  const g = buildGather({ ledgerNdjson: ndjson, learningsMd: "# L\n" });
  assert.equal(g.replay.ranThisCycle, true);
  assert.equal(g.replay.total, 3);
  assert.equal(g.replay.passed, 3);
  const rendered = renderGather(g);
  assert.match(rendered, /## Replay pass-rate \(golden-task regression suite, W1-T165\)/, "must be reached from renderGather, not left unwired");
  assert.match(rendered, /3\/3 goldens \(100%\)/);
});

test("buildGather/renderGather: a cycle with a FAILED golden renders a pass-rate below 100%", async () => {
  const degradedHarness: HarnessRunner = (golden) =>
    golden.class === "src-fix"
      ? { verdict: golden.expected.verdict, filesTouched: ["wrong.ts"], prTrailerTaskId: golden.expected.prTrailerTaskId }
      : unchangedHarness(golden);
  const results = await replayGoldens(SEEDED_GOLDENS, degradedHarness);
  const lines: string[] = [];
  recordReplayResults("RUN-3", "W1-T165", results, {
    ledgerPath: "/dev/null/unused",
    writeLedger: (_path, line) => void lines.push(JSON.stringify({ ts: "2026-08-02T00:00:00.000Z", ...line })),
  });
  const g = buildGather({ ledgerNdjson: lines.join("\n"), learningsMd: "# L\n" });
  assert.equal(g.replay.passed, 2);
  assert.equal(g.replay.total, 3);
  const rendered = renderGather(g);
  assert.match(rendered, /2\/3 goldens \(67%\)/);
});

test("buildGather: today's real ledger (no replay recorded yet) correctly reports the not-ran-this-cycle state end to end", () => {
  const g = buildGather({ ledgerNdjson: "", learningsMd: "# L\n" });
  assert.equal(g.replay.ranThisCycle, false);
  const rendered = renderGather(g);
  assert.match(rendered, /No replay run recorded this cycle/, "the honest state — never a false 0% claim");
});
