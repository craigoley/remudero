// P53 (MASTER-PLAN Retro proposals): `implement` read `model` on 18 of 202 rows for three cycles
// running. The mechanism is a KEY PLACEMENT, not a missing emission: the lane is bucketed on the
// `verdict` step (COMPARISON_LANE_STEPS), and no `verdict` writer in src/run-task.ts carries a
// `model` key — the model rides `implement.done` (via workerLedgerFields) and `run.start`'s nested
// `mount.model`. Joining the row to its run re-attributes the historical corpus with no writer change.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  architectLaneShare,
  renderArchitectLaneShare,
  runModelAttribution,
  runModelIndex,
  UNATTRIBUTED_MODEL,
  type LedgerRecord,
} from "../src/lib/retro.js";

function records(...rows: Record<string, unknown>[]): LedgerRecord[] {
  return rows.map((r) => r as LedgerRecord);
}

const IMPLEMENT_DONE_RUN = "W1-T2620-1788370000000";
const START_ONLY_RUN = "W1-T2621-1788370100000";
const BARE_RUN = "W1-T2622-1788370200000";
const OWN_KEY_RUN = "W1-T2623-1788370300000";

const CORPUS = records(
  // The real shape: run.start nests the model under mount, implement.done carries it flat, verdict has none.
  { run_id: IMPLEMENT_DONE_RUN, task_id: "W1-T2620", step: "run.start", ts: "2026-09-02T12:00:00.000Z", type: "implement", mount: { model: "opus", effort: "high" } },
  { run_id: IMPLEMENT_DONE_RUN, task_id: "W1-T2620", step: "implement.done", ts: "2026-09-02T12:20:00.000Z", model: "sonnet", served_model: "claude-sonnet-5", num_turns: 12 },
  { run_id: IMPLEMENT_DONE_RUN, task_id: "W1-T2620", step: "verdict", ts: "2026-09-02T13:00:00.000Z", verdict: "blocked_ci", cost_usd: 11.615 },
  // A rotated run: implement.done sheared off (not in any retention set), run.start survives.
  { run_id: START_ONLY_RUN, task_id: "W1-T2621", step: "run.start", ts: "2026-09-02T12:05:00.000Z", type: "implement", mount: { model: "sonnet", effort: "medium" } },
  { run_id: START_ONLY_RUN, task_id: "W1-T2621", step: "verdict", ts: "2026-09-02T13:05:00.000Z", verdict: "merged", cost_usd: 4.0 },
  // A run with nothing to join to — pre-W1-T6 history — stays unattributed.
  { run_id: BARE_RUN, task_id: "W1-T2622", step: "run.start", ts: "2026-09-02T12:10:00.000Z", type: "implement" },
  { run_id: BARE_RUN, task_id: "W1-T2622", step: "verdict", ts: "2026-09-02T13:10:00.000Z", verdict: "merged", cost_usd: 3.0 },
  // A row that carries its own key keeps it, whatever its run says.
  { run_id: OWN_KEY_RUN, task_id: "W1-T2623", step: "run.start", ts: "2026-09-02T12:15:00.000Z", type: "implement", mount: { model: "opus" } },
  { run_id: OWN_KEY_RUN, task_id: "W1-T2623", step: "verdict", ts: "2026-09-02T13:15:00.000Z", verdict: "merged", cost_usd: 2.0, model: "haiku" },
  // An Architect lane row without a model and without a run to join: unattributed, unchanged.
  { run_id: "TRIAGE-9", task_id: "TRIAGE-9", step: "triage.synthesized", ts: "2026-09-02T14:00:00.000Z", cost_usd: 1.0 },
);

// W1-T3080: extends the join order to prefer a SERVED model over a merely-RESOLVED one, and a
// `verdict` row's own keys (now written by run-task.ts's `terminalVerdictFields`) over
// `implement.done`'s. Priority, highest first: verdict.served_model > verdict.model >
// implement.done.served_model > implement.done.model > run.start.mount.model.
test("runModelIndex prefers implement.done.served_model over its own sibling implement.done.model, and run.start.mount.model is the last-resort fallback", () => {
  const idx = runModelIndex(CORPUS);
  assert.equal(
    idx.get(IMPLEMENT_DONE_RUN),
    "claude-sonnet-5",
    "served_model (the model that actually served the call) wins over model (sonnet) and over run.start's opus",
  );
  assert.equal(idx.get(START_ONLY_RUN), "sonnet", "run.start.mount.model is the fallback when neither implement.done nor verdict carries a model");
  assert.equal(idx.get(BARE_RUN), undefined, "a run.start with no mount yields nothing — never a guess");
  assert.equal(idx.get("TRIAGE-9"), undefined);
});

test("runModelAttribution reports WHICH source supplied the model, not only the model itself", () => {
  const attribution = runModelAttribution(CORPUS);
  assert.deepEqual(attribution.get(IMPLEMENT_DONE_RUN), { model: "claude-sonnet-5", source: "implement.done.served_model" });
  assert.deepEqual(attribution.get(START_ONLY_RUN), { model: "sonnet", source: "run.start.mount.model" });
  assert.deepEqual(attribution.get(OWN_KEY_RUN), { model: "haiku", source: "verdict.model" }, "OWN_KEY_RUN's verdict row carries its own model key");
  assert.equal(attribution.get(BARE_RUN), undefined);
});

test("a model-less verdict row is attributed through its run — preferring the served model — the attribution is counted as via-run, and a bare run stays unattributed", () => {
  const implement = architectLaneShare(CORPUS).comparisonLanes.find((l) => l.lane === "implement")!;
  assert.equal(implement.rows, 4);
  assert.deepEqual(implement.models, [
    { model: "claude-sonnet-5", rows: 1, viaRun: 1 },
    { model: "haiku", rows: 1 },
    { model: "sonnet", rows: 1, viaRun: 1 },
    { model: UNATTRIBUTED_MODEL, rows: 1 },
  ]);
});

test("FALSIFIER: the same corpus with the run rows stripped reads 3 of 4 unattributed — the join is what does the work", () => {
  const verdictOnly = CORPUS.filter((r) => r.step === "verdict" || r.step === "triage.synthesized");
  const implement = architectLaneShare(verdictOnly).comparisonLanes.find((l) => l.lane === "implement")!;
  assert.deepEqual(implement.models, [
    { model: "haiku", rows: 1 },
    { model: UNATTRIBUTED_MODEL, rows: 3 },
  ]);
});

test("a row that carries its own model key is never overridden by its run, and Architect lanes are untouched by the join", () => {
  const report = architectLaneShare(CORPUS);
  const implement = report.comparisonLanes.find((l) => l.lane === "implement")!;
  assert.ok(implement.models.some((m) => m.model === "haiku" && m.viaRun === undefined), "OWN_KEY_RUN keeps haiku, not its run.start opus");
  const triage = report.architectLanes.find((l) => l.lane === "triage")!;
  assert.deepEqual(triage.models, [{ model: UNATTRIBUTED_MODEL, rows: 1 }]);
});

test("the rendered table says how many rows were attributed via the run join and redefines unattributed to include the run's rows", () => {
  const rendered = renderArchitectLaneShare(architectLaneShare(CORPUS));
  assert.match(rendered, /claude-sonnet-5×1 \(1 via run join\)/, "IMPLEMENT_DONE_RUN's served model, joined from implement.done");
  assert.match(rendered, /sonnet×1 \(1 via run join\)/, "START_ONLY_RUN's mount model, joined from run.start");
  assert.match(rendered, /unattributed = no `model` key on the row OR its run's `implement.done`\/`run.start.mount`/);
  assert.match(rendered, /haiku×1(?! \()/, "a row attributed by its own key carries no via-run suffix");
});
