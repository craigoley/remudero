import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARCHITECT_LANE_STEPS } from "../src/lib/retro.js";
import { SYNTHESIS_ROLES } from "../src/lib/mounts.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "mount-headroom-sweep.mjs");

/**
 * test/the-headroom-sweep-cannot-see-the-synthesis-rungs.test.ts — W1-T2668.
 *
 * W1-T2559 split retro, triage and inbox_draft into their own `synthesis:` mounts and stepped
 * triage down to `low` on a measured volume argument; retro and inbox_draft stayed at
 * claude-opus-5/high because NOTHING measured them. W1-T2560 then built the instrument whose own
 * header says its purpose is that "sonnet would do here" becomes a measurement instead of an
 * opinion — and it groups by `task_class` over `gatherRuns`, which needs a `run.start` and sums
 * turns from implement/recon done-steps. A synthesis rung is not a task run: no `task_class`, so
 * it landed in "unknown" or nowhere. The one verb built to price these rows could not see them,
 * and `.remudero/mounts.yaml`'s own "$827 across 219 invocations" came from a hand query nothing
 * re-derives.
 */

// `scripts/**` is outside tsconfig's `include`, so a runtime import — the same route
// test/a-census-suite-is-unreachable-from-the-symbols-a-diff-changes.test.ts takes.
const { computeSynthesisSweep, computeClassSweep, renderMountHeadroomReport } = (await import(
  pathToFileURL(SCRIPT).href
)) as {
  computeSynthesisSweep: (records: unknown[]) => Array<Record<string, unknown>>;
  computeClassSweep: (runs: unknown[]) => Array<Record<string, unknown>>;
  renderMountHeadroomReport: (report: unknown) => string;
};

/** A terminal row for one synthesis invocation. */
function row(step: string, runId: string, over: Record<string, unknown> = {}) {
  return { step, run_id: runId, num_turns: 10, cost_usd: 1, ...over };
}

// ── criterion 1: their own rows, never folded into unknown ────────────────────────────────────

test("W1-T2668 (acceptance 1): the three synthesis rungs report as their OWN rows, not folded into unknown", () => {
  const records = [
    row("retro.synthesized", "RETRO-1", { num_turns: 40, cost_usd: 8 }),
    row("triage.synthesized", "TRIAGE-1", { num_turns: 12, cost_usd: 2 }),
    row("inbox.draft_synthesized", "INBOX-1", { num_turns: 20, cost_usd: 4 }),
  ];
  const sweep = computeSynthesisSweep(records);
  assert.deepEqual(sweep.map((r) => r.rung), [...SYNTHESIS_ROLES], "one row per rung, in the mounts table's own order");
  for (const r of sweep) assert.equal(r.invocations, 1);

  // AND THE CONTRAST THAT IS THE FINDING: the per-task_class grouping cannot see them at all.
  // `gatherRuns` would yield no run for these records (no run.start), so nothing reaches
  // computeClassSweep — and even given a run, a rung carries no task_class and lands in "unknown".
  const classes = computeClassSweep([{ runId: "RETRO-1", taskClass: undefined, numTurns: 40, costUsd: 8, verdict: "merged", taskId: undefined }]);
  assert.equal(classes[0].taskClass, "unknown", "this is where a synthesis rung used to land — one bucket, no rung named");
});

test("W1-T2668: the population and the step names are NOT new lists — both come from the modules that already own them", () => {
  // A second copy of either would drift silently. The rungs are SYNTHESIS_ROLES (what loadMounts
  // validates the `synthesis:` block against); the steps are ARCHITECT_LANE_STEPS (retro.ts's ONE
  // map identifying these lanes by the single ledger step each writes).
  const sweep = computeSynthesisSweep([]);
  assert.deepEqual(sweep.map((r) => r.rung), [...SYNTHESIS_ROLES]);
  for (const r of sweep) {
    assert.equal(r.step, ARCHITECT_LANE_STEPS[r.rung as string], `${r.rung} must be read from the step retro.ts already names`);
  }
  // The control that makes that a measurement: the map really distinguishes the rungs, and
  // inbox_draft's step is NOT derivable from its name — a rule-based guess would have got it wrong.
  assert.equal(ARCHITECT_LANE_STEPS.inbox_draft, "inbox.draft_synthesized");
  assert.notEqual(ARCHITECT_LANE_STEPS.inbox_draft, "inbox_draft.synthesized");
});

// ── criterion 2: percentiles, never a mean ────────────────────────────────────────────────────

test("W1-T2668 (acceptance 2): each rung's row carries turn and cost PERCENTILES, never a mean", () => {
  // Nine cheap invocations and one $40 outlier. A mean would read ~4.5; p50 must not move.
  const records = [
    ...Array.from({ length: 9 }, (_, i) => row("retro.synthesized", `RETRO-${i}`, { num_turns: 10, cost_usd: 1 })),
    row("retro.synthesized", "RETRO-OUTLIER", { num_turns: 400, cost_usd: 40 }),
  ];
  const retro = computeSynthesisSweep(records).find((r) => r.rung === "retro")!;
  assert.equal(retro.invocations, 10);
  assert.equal(retro.costP50, 1, "the outlier moves a mean and must not move p50");
  assert.equal(retro.turnsP50, 10);
  assert.equal(retro.costMax, 40, "and the outlier is still VISIBLE, as max");
  assert.equal(retro.turnsMax, 400);
  assert.ok((retro.costP90 as number) >= 1, "p90 is reported too");
  for (const key of Object.keys(retro)) {
    assert.doesNotMatch(key, /mean|avg|average/i, `no mean-shaped field may exist (found ${key})`);
  }
});

// ── criterion 3: the divisor is NAMED, not silently reused ────────────────────────────────────

test("W1-T2668 (acceptance 3): a rung with no completed-task divisor names its PER-INVOCATION basis rather than reusing the task divisor", () => {
  const retro = computeSynthesisSweep([
    row("retro.synthesized", "RETRO-1", { cost_usd: 3 }),
    row("retro.synthesized", "RETRO-2", { cost_usd: 5 }),
  ]).find((r) => r.rung === "retro")!;
  assert.equal(retro.costPerInvocationUsd, 4, "total 8 over 2 invocations");
  assert.ok(!("costPerCompletedTaskUsd" in retro), "must NOT carry the per-task field — these rungs complete no task");
  // And the rendered report says so in words, where an operator reads it.
  const text = renderMountHeadroomReport({
    corpus: { stateDir: "/x", formsOpened: ["live"], archiveCount: 0, liveFileRead: true, unread: [], rawRowsWithRunId: 2, distinctRunCount: 1, rowToRunRatio: 2, newestTs: "2026-09-05T00:00:00Z" },
    classes: [],
    cells: [],
    synthesis: computeSynthesisSweep([row("retro.synthesized", "RETRO-1", { cost_usd: 3 })]),
  });
  assert.match(text, /\$\/INVOCATION/, "the column is named per invocation");
  assert.match(text, /these rungs complete no task and carry no task_id/, "and says WHY it is not the per-task divisor");

  // An UNMEASURED rung reads as unmeasured, never as free.
  const triage = computeSynthesisSweep([]).find((r) => r.rung === "triage")!;
  assert.equal(triage.invocations, 0);
  assert.equal(triage.costPerInvocationUsd, null, "null, never 0 — an unmeasured rung must not render as a free one");
});

test("W1-T2668: invocations are deduped by run_id, and a row with no run_id is DROPPED and counted, never silently folded", () => {
  const retro = computeSynthesisSweep([
    row("retro.synthesized", "RETRO-1", { cost_usd: 3 }),
    row("retro.synthesized", "RETRO-1", { cost_usd: 3 }), // a rotation overlap / resumed lane
    { step: "retro.synthesized", cost_usd: 99 }, // no run_id at all
  ]).find((r) => r.rung === "retro")!;
  assert.equal(retro.invocations, 1, "the duplicate terminal line is ONE invocation, or the percentiles describe the ledger's shape");
  assert.equal(retro.totalCostUsd, 3, "and it is not double-counted");
  assert.equal(retro.rowsWithoutRunId, 1, "the undedupable row is COUNTED, so a corpus full of them is visible");
});

test("W1-T2668: cost falls back to total_cost_usd, the same precedence every other row in this report uses", () => {
  const retro = computeSynthesisSweep([row("retro.synthesized", "RETRO-1", { cost_usd: undefined, total_cost_usd: 7 })]).find((r) => r.rung === "retro")!;
  assert.equal(retro.totalCostUsd, 7);
});

// ── criterion 4: the existing rows and controls are unchanged ─────────────────────────────────

test("W1-T2668 (acceptance 4): the per-task_class rows and the corpus controls are UNCHANGED", () => {
  const runs = [
    { runId: "R1", taskClass: "src", numTurns: 10, costUsd: 2, verdict: "merged", taskId: "W1-T1" },
    { runId: "R2", taskClass: "src", numTurns: 30, costUsd: 6, verdict: "merged", taskId: "W1-T2" },
  ];
  const classes = computeClassSweep(runs);
  assert.equal(classes.length, 1);
  assert.equal(classes[0].taskClass, "src");
  assert.equal(classes[0].costPerCompletedTaskUsd, 4, "still per COMPLETED TASK — untouched by this task");
  assert.ok("outcomes" in classes[0], "and it still carries its outcome split");

  const text = renderMountHeadroomReport({
    corpus: { stateDir: "/x", formsOpened: ["gz", "plain", "live"], archiveCount: 3, liveFileRead: true, unread: [], rawRowsWithRunId: 100, distinctRunCount: 10, rowToRunRatio: 10, newestTs: "2026-09-05T00:00:00Z" },
    classes,
    cells: [],
    synthesis: computeSynthesisSweep([]),
  });
  // Every control this script carries is still printed BESIDE the tables.
  assert.match(text, /forms opened: gz, plain, live/, "all three rotation forms still reported");
  assert.match(text, /row:run ratio 10x/, "the raw-to-run ratio control survives");
  assert.match(text, /newest row seen: 2026-09-05/, "and the corpus window");
  assert.match(text, /\$\/completed task/, "the per-task column is still there");
});

// ── criterion 5: it reports; it rules on nothing ──────────────────────────────────────────────

test("W1-T2668 (acceptance 5): the script still recommends no model and changes no mount", () => {
  const text = renderMountHeadroomReport({
    corpus: { stateDir: "/x", formsOpened: ["live"], archiveCount: 0, liveFileRead: true, unread: [], rawRowsWithRunId: 1, distinctRunCount: 1, rowToRunRatio: 1, newestTs: "2026-09-05T00:00:00Z" },
    classes: [],
    cells: [],
    synthesis: computeSynthesisSweep([row("retro.synthesized", "RETRO-1")]),
  });
  assert.match(text, /recommends no model and changes no mount/, "the synthesis table says so where it is read");
  assert.doesNotMatch(text, /\bswitch to\b|\brecommend(ed|s)? (claude|sonnet|haiku|opus)/i, "and names no model as a recommendation");

  // The stronger half, over the SOURCE: this task's addition writes nothing and spawns nothing.
  const src = readFileSync(SCRIPT, "utf8");
  const added = src.slice(src.indexOf("W1-T2668"));
  assert.doesNotMatch(added, /writeFileSync|appendFileSync|spawnSync|execFileSync|mkdirSync/, "the addition is a pure read-and-reduce");
});
