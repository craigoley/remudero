import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { FIXLANE_REPORT_FILE, fixLaneGardenSpec } from "#src/lib/fix-lane-gardener.js";
import { fixTranscriptsFromLedger, reflectOnTranscripts, splitHeldOut, validateFixTranscript } from "#src/lib/prompt-evolution.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.UTC(2026, 9, 18, 12);
const at = (offset = -1_000) => fixedClock(NOW + offset).iso();
const SHADOW = "prompt_evolution.shadow";
const SEED = "fix-lane-prompt-shadow-v1";
const round = (id: string, model?: string, reason = `refusal ${id}`, ts = at()): LedgerRecord[] => [
  { step: "fix.commit_refused", task_id: id, round_id: `round-${id}`, ts, reason, fix_outcome: "FIXED" },
  { step: "fix.done", task_id: id, round_id: `round-${id}`, ts, selected_model: model, fix_outcome: "FIXED" },
];

function fixture(t: TestContext, records: LedgerRecord[]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prompt-shadow-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan", "tasks.yaml"), records.filter(r => r.step === "fix.done" && r.selected_model).map(r =>
    `- id: ${r.task_id}\n  title: fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n`).join(""));
  const logs: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  const spec = fixLaneGardenSpec({
    repoRoot: root, stateDir: root, clock: fixedClock(NOW), log: (step, fields) => logs.push({ step, fields }),
    openWorkspace: () => { throw new Error("shadow must not open a workspace or run a worker"); },
  }, {
    owner: "acme", repo: "remudero", ledgerRecords: () => records, planState: () => ({ tasks: [] }),
    mintTaskId: () => { throw new Error("shadow must not file a task"); },
    interventions: () => ({ ok: true, interventions: [] }), prOutcomes: () => new Map(),
  });
  return { root, logs, spec, report: () => readFileSync(join(root, FIXLANE_REPORT_FILE), "utf8") };
}

test("W1-T9641: refused fix rounds become transcripts keyed by their worker model", () => {
  const a = round("A", "codex-model", "the worker changed nothing");
  const b = round("B", "claude-model", "outside declared files");
  const records = [a[1]!, ...b, a[0]!, ...round("C"), ...round("D", "  "),
    { step: "fix.commit_refused", task_id: "E", reason: "no round" },
    ...round("F", "m".repeat(81)),
    { ...a[0]!, round_id: "second-A", reason: "another refusal" },
    { ...a[1]!, round_id: "second-A" },
    { ...a[1]!, selected_model: undefined },
    { step: "fix.done", task_id: "G", round_id: "accepted", selected_model: "unused" }];
  const before = JSON.stringify(records);
  const result = fixTranscriptsFromLedger(records, id => id === "A" ? "fix" : undefined);
  assert.equal(result.unmodelled, 4);
  assert.deepEqual(result.transcripts.map(r => [r.taskId, r.model, r.taskShape, r.commitRefusedReason]), [
    ["B", "claude-model", "unknown", "outside declared files"],
    ["A", "codex-model", "fix", "the worker changed nothing"],
    ["A", "codex-model", "fix", "another refusal"],
  ]);
  for (const transcript of result.transcripts) {
    assert.deepEqual(validateFixTranscript(transcript), transcript);
    assert.match(transcript.excerpt, /FIXED/);
    assert.ok(transcript.excerpt.includes(transcript.commitRefusedReason!));
  }
  assert.equal(JSON.stringify(records), before);
  const long = fixTranscriptsFromLedger(round("long", "model", "x".repeat(4_000)), () => "implement").transcripts[0]!;
  assert.equal(long.commitRefusedReason!.length, 320);
  assert.ok(long.excerpt.length <= 320);
  assert.match(long.excerpt, /fix_outcome: FIXED/);
  assert.deepEqual(validateFixTranscript(long), long);
});

test("W1-T9641: sparse refusal rows retain completion identity and explicit unknowns", () => {
  const result = fixTranscriptsFromLedger([
    { step: "fix.commit_refused", round_id: "sparse" },
    { step: "fix.done", round_id: "sparse", task_id: "completion-task", selected_model: " model " },
    { step: "fix.done", selected_model: "unjoined-model" },
    { step: "fix.commit_refused", task_id: "no-round" },
  ], () => undefined);
  assert.equal(result.unmodelled, 1);
  assert.deepEqual(result.transcripts, [{
    taskId: "completion-task", model: "model", taskShape: "unknown",
    commitRefusedReason: "unstated refusal reason", excerpt: "unstated refusal reason\nfix_outcome: unstated",
  }]);
  const fromCompletion = fixTranscriptsFromLedger([
    { step: "fix.commit_refused", round_id: "outcome", reason: "refused" },
    { step: "fix.done", round_id: "outcome", selected_model: "model", fix_outcome: "FLAKE" },
  ], () => undefined).transcripts[0]!;
  assert.equal(fromCompletion.taskId, "unknown");
  assert.equal(fromCompletion.excerpt, "refused\nfix_outcome: FLAKE");
});

test("W1-T9641: the fix-lane report names the lessons its refused rounds would teach and installs none", async t => {
  const active = [...Array.from({ length: 12 }, (_, i) => round(`A${i}`, "codex-model")),
    ...Array.from({ length: 12 }, (_, i) => round(`B${i}`, "claude-model"))].flat();
  const records = [...active, ...round("unmodelled"), ...round("expired", "expired-model", "expired", at(-15 * 86_400_000)),
    ...round("future", "future-model", "future", at(1_000)),
    ...round("invalid-time", "invalid-model", "invalid", "invalid")];
  const f = fixture(t, records);
  const inv = await f.spec.inventoryAsync!();
  f.spec.scorecard(inv, { actions: [], acting: [] });
  const shadows = f.logs.filter(r => r.step === SHADOW);
  assert.equal(shadows.length, 2);
  const transcripts = fixTranscriptsFromLedger(active, () => "implement").transcripts;
  for (const model of ["codex-model", "claude-model"]) {
    const own = transcripts.filter(r => r.model === model);
    const { train, heldOut } = splitHeldOut(own, SEED);
    assert.ok(train.length > 0 && heldOut.length > 0, "control: both split halves are populated");
    const expected = reflectOnTranscripts(train).map(r => ({
      reason: r.reason, lesson: r.lesson.slice(0, 320), task_shapes: r.taskShapes, count: r.count,
    }));
    const fields = shadows.find(r => r.fields?.model === model)!.fields!;
    assert.deepEqual(fields, { model, transcripts: 12, unmodelled: 1, lessons: expected });
    assert.ok(expected.length > 0);
    for (const lesson of expected) assert.ok(f.report().includes(lesson.lesson));
    for (const transcript of heldOut) {
      assert.ok(!(fields.lessons as Array<{ reason: string }>).some(lesson => lesson.reason === transcript.commitRefusedReason));
    }
  }
  assert.match(f.report(), /Prompt lessons \(shadow — nothing installed\)/);
  assert.match(f.report(), /Unmodelled refused rounds: 1/);
  assert.deepEqual(readdirSync(f.root).sort(), [FIXLANE_REPORT_FILE, "plan"]);
  assert.deepEqual(readdirSync(join(f.root, "plan")), ["tasks.yaml"]);
  assert.ok(f.logs.every(r => r.step === SHADOW || r.step === "fixlane.report"));
});

test("W1-T9641: a failed shadow fold reports its error and preserves the gardener report", t => {
  const f = fixture(t, round("A", "model"));
  writeFileSync(join(f.root, "plan", "tasks.yaml"), "invalid: [");
  f.spec.scorecard(f.spec.inventory(), { actions: [], acting: [] });
  const shadows = f.logs.filter(r => r.step === SHADOW);
  assert.equal(shadows.length, 1);
  assert.equal(typeof shadows[0]!.fields!.error, "string");
  assert.match(String(shadows[0]!.fields!.error), /plan|YAML|parse/i);
  assert.equal(Object.hasOwn(shadows[0]!.fields!, "lessons"), false);
  assert.ok(f.logs.some(r => r.step === "fixlane.report"));
  assert.match(f.report(), /Prompt lessons \(shadow — nothing installed\)/);
  assert.ok(f.report().includes(String(shadows[0]!.fields!.error)));
});

test("W1-T9641: unmodelled-only and empty windows report their counts without pooling", t => {
  for (const records of [[], round("A")]) {
    const f = fixture(t, records);
    f.spec.scorecard(f.spec.inventory(), { actions: [], acting: [] });
    assert.deepEqual(f.logs.filter(r => r.step === SHADOW), []);
    assert.ok(f.report().includes(`Unmodelled refused rounds: ${records.length ? 1 : 0}`));
  }
});

test("W1-T9641: shadow lessons stay bounded for a large refusal window", t => {
  const f = fixture(t, Array.from({ length: 100 }, (_, i) => round(`T${i}`, "model", `${i}: ${"x".repeat(4_000)}`)).flat());
  f.spec.scorecard(f.spec.inventory(), { actions: [], acting: [] });
  const fields = f.logs.find(r => r.step === SHADOW)!.fields!;
  const lessons = fields.lessons as Array<{ reason: string; lesson: string }>;
  assert.equal(fields.transcripts, 100);
  assert.equal(lessons.length, 16);
  assert.ok(lessons.every(r => r.reason.length <= 320 && r.lesson.length <= 320));
});
