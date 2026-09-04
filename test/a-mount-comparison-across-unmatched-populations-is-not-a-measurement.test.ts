// test/a-mount-comparison-across-unmatched-populations-is-not-a-measurement.test.ts
//
// W1-T2574 — THE SWEEP AGGREGATES BY TASK CLASS AND EVERY RUN OF A CLASS RODE THE SAME MOUNT, SO
// IT CAN NEVER SAY WHAT A DIFFERENT MOUNT WOULD HAVE DONE. W1-T2560's per-`task_class` census
// (test/mount-headroom-sweep.test.ts) is correct for what it answers, but a corpus with no
// variation on the variable of interest supports no counterfactual. A second provider
// (W1-T2572/W1-T2573) supplies that variation, but ONLY WITHIN a (type, risk, class) cell —
// across cells, provider/mount choice tracks POLICY (high-risk work rides a higher mount on
// purpose), so a naive cross-cell aggregate reports difficulty talking, not model.
//
// This suite proves scripts/mount-headroom-sweep.mjs's `computeArmSweep`/`compareArms`:
//   1. key arms by (provider, served_model, effort) WITHIN a (type, risk, class) cell, never
//      across cells;
//   2. REFUSE — loudly, naming the cell — a comparison between two arms that do not share one;
//   3. every arm reports its own `n`;
//   4. every arm carries its pass / blocked_ci / re-dispatch split beside its cost;
//   5. an arm whose cost advantage disappears once re-dispatches are charged to it is reported
//      as such;
//   6. the corpus's newest timestamp is printed beside every comparison.
//
// WHAT IS REAL HERE: every function under test is imported straight from the script itself (a
// dynamic import — this repo's own established pattern for `scripts/**`, which sits outside
// tsconfig's `include`; see test/mount-headroom-sweep.test.ts's identical comment) — no seam, no
// mock, no shadow copy of the reduction logic.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "mount-headroom-sweep.mjs");
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  buildMountHeadroomSweep: (
    stateDir: string,
    fsDeps?: unknown,
  ) => {
    corpus: { newestTs: string | undefined };
    cells: Array<{
      cellKey: string;
      type: string;
      risk: string;
      taskClass: string;
      arms: Array<{
        cellKey: string;
        armKey: string;
        provider: string;
        servedModel: string;
        effort: string;
        n: number;
        totalRuns: number;
        settledRuns: number;
        costP50: number | null;
        costP90: number | null;
        costMax: number | null;
        outcomes: { passing: number; blockedCi: number; redispatched: number };
        totalSettledCostUsd: number;
        distinctSettledTasks: number;
        costPerCompletedTaskUsd: number | null;
        newestTs: string | undefined;
      }>;
      comparisons: Array<{
        cellKey: string;
        armKeyA: string;
        armKeyB: string;
        nA: number;
        nB: number;
        cheaperByCostP50: string | null;
        cheaperByCostPerCompletedTask: string | null;
        advantageHoldsUnderRedispatch: boolean | null;
        note: string;
        newestTs: string | undefined;
      }>;
    }>;
  };
  computeArmSweep: (runs: unknown[], armFields: Map<string, unknown>, newestTs: string | undefined) => unknown[];
  compareArms: (armA: Record<string, unknown>, armB: Record<string, unknown>) => Record<string, unknown>;
  armFieldsByRunId: (records: unknown[]) => Map<string, { provider: string; servedModel: string; effort: string }>;
  cellKeyOf: (run: { type: string; risk?: string; taskClass?: string }) => string;
  armKeyOf: (fields: { provider: string; servedModel: string; effort: string }) => string;
  renderMountHeadroomReport: (report: unknown) => string;
  MountHeadroomSweepError: new (message: string) => Error;
};
const {
  buildMountHeadroomSweep,
  computeArmSweep,
  compareArms,
  armFieldsByRunId,
  cellKeyOf,
  armKeyOf,
  renderMountHeadroomReport,
  MountHeadroomSweepError,
} = mod;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mount-comparison-unmatched-"));
}

function writeLive(dir: string, lines: string[]): void {
  writeFileSync(join(dir, "ledger.ndjson"), `${lines.join("\n")}\n`);
}

/** One run's `run.start` + `implement.done` (carrying provider/served_model/effort, W1-T2572)
 *  + `verdict` ndjson lines. */
function runLines(opts: {
  runId: string;
  taskId: string;
  type?: string;
  risk?: string;
  taskClass: string;
  provider?: string;
  servedModel?: string | null;
  effort?: string;
  turns: number;
  costUsd: number;
  verdict: string;
  ts: string;
}): string {
  const start = JSON.stringify({
    ts: opts.ts,
    run_id: opts.runId,
    task_id: opts.taskId,
    step: "run.start",
    type: opts.type ?? "implement",
    risk: opts.risk ?? "medium",
    task_class: opts.taskClass,
  });
  const done: Record<string, unknown> = {
    ts: opts.ts,
    run_id: opts.runId,
    task_id: opts.taskId,
    step: "implement.done",
    num_turns: opts.turns,
    effort: opts.effort ?? "medium",
  };
  if (opts.provider !== undefined) done.provider = opts.provider;
  done.served_model = opts.servedModel === undefined ? "claude-sonnet-4-5-20250929" : opts.servedModel;
  const verdict = JSON.stringify({
    ts: opts.ts,
    run_id: opts.runId,
    task_id: opts.taskId,
    step: "verdict",
    verdict: opts.verdict,
    cost_usd: opts.costUsd,
  });
  return [start, JSON.stringify(done), verdict].join("\n");
}

// ── ACCEPTANCE 1: arms are keyed by (provider, served_model, effort) WITHIN a (type, risk,
// class) cell, never across cells ───────────────────────────────────────────────────────────────

test("buildMountHeadroomSweep: two providers serving the SAME cell split into two arms; the SAME provider in a DIFFERENT cell is a separate cell entirely", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      runLines({
        runId: "R1",
        taskId: "T1",
        type: "implement",
        risk: "medium",
        taskClass: "src",
        provider: "claude",
        servedModel: "claude-sonnet-4-5-20250929",
        effort: "medium",
        turns: 10,
        costUsd: 1,
        verdict: "merged",
        ts: "2026-08-01T00:00:00.000Z",
      }),
      runLines({
        runId: "R2",
        taskId: "T2",
        type: "implement",
        risk: "medium",
        taskClass: "src",
        provider: "codex",
        servedModel: "gpt-5-codex",
        effort: "medium",
        turns: 12,
        costUsd: 0.6,
        verdict: "merged",
        ts: "2026-08-01T01:00:00.000Z",
      }),
      // Same provider/model/effort as R1, but a DIFFERENT (type, risk, class) cell (risk:high) —
      // must land in its OWN cell, never folded into the medium-risk src cell above.
      runLines({
        runId: "R3",
        taskId: "T3",
        type: "implement",
        risk: "high",
        taskClass: "src",
        provider: "claude",
        servedModel: "claude-sonnet-4-5-20250929",
        effort: "medium",
        turns: 10,
        costUsd: 1,
        verdict: "merged",
        ts: "2026-08-01T02:00:00.000Z",
      }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    assert.equal(report.cells.length, 2, "risk:medium and risk:high are separate cells even with the same class");

    const mediumCell = report.cells.find((c) => c.cellKey === cellKeyOf({ type: "implement", risk: "medium", taskClass: "src" }));
    assert.ok(mediumCell, "the medium-risk src cell exists");
    assert.equal(mediumCell!.arms.length, 2, "claude and codex split into two arms WITHIN the same cell");
    const armKeys = mediumCell!.arms.map((a) => a.armKey).sort();
    assert.deepEqual(
      armKeys,
      [
        armKeyOf({ provider: "claude", servedModel: "claude-sonnet-4-5-20250929", effort: "medium" }),
        armKeyOf({ provider: "codex", servedModel: "gpt-5-codex", effort: "medium" }),
      ].sort(),
    );

    const highCell = report.cells.find((c) => c.cellKey === cellKeyOf({ type: "implement", risk: "high", taskClass: "src" }));
    assert.ok(highCell, "the high-risk src cell exists, separately");
    assert.equal(highCell!.arms.length, 1, "R3 is alone in its own cell — never merged with R1's medium-risk arm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("armKeyOf/cellKeyOf: distinct axes produce distinct keys, and the same inputs are stable", () => {
  const cellA = cellKeyOf({ type: "implement", risk: "medium", taskClass: "src" });
  const cellB = cellKeyOf({ type: "implement", risk: "high", taskClass: "src" });
  assert.notEqual(cellA, cellB);
  assert.equal(cellA, cellKeyOf({ type: "implement", risk: "medium", taskClass: "src" }));

  const armA = armKeyOf({ provider: "claude", servedModel: "sonnet", effort: "medium" });
  const armB = armKeyOf({ provider: "codex", servedModel: "sonnet", effort: "medium" });
  assert.notEqual(armA, armB);
});

// ── ACCEPTANCE 2: two arms that do not share a cell are REFUSED, with the cell named ───────────

test("compareArms: two arms from DIFFERENT cells are REFUSED, naming both cells, never silently compared", () => {
  const armA = {
    cellKey: "implement::medium::src",
    armKey: "claude::sonnet::medium",
    n: 5,
    costP50: 1,
    costPerCompletedTaskUsd: 1,
  };
  const armB = {
    cellKey: "implement::high::src",
    armKey: "claude::sonnet::medium",
    n: 5,
    costP50: 3,
    costPerCompletedTaskUsd: 3,
  };
  assert.throws(
    () => compareArms(armA, armB),
    (e: unknown) =>
      e instanceof MountHeadroomSweepError &&
      /REFUSED/.test((e as Error).message) &&
      (e as Error).message.includes("implement::medium::src") &&
      (e as Error).message.includes("implement::high::src"),
  );
});

test("compareArms: two arms from the SAME cell compare cleanly — no refusal", () => {
  const armA = { cellKey: "implement::medium::src", armKey: "claude::sonnet::medium", n: 5, costP50: 1, costPerCompletedTaskUsd: 1 };
  const armB = { cellKey: "implement::medium::src", armKey: "codex::gpt5::medium", n: 4, costP50: 2, costPerCompletedTaskUsd: 2 };
  const cmp = compareArms(armA, armB);
  assert.equal(cmp.cellKey, "implement::medium::src");
  assert.equal(cmp.cheaperByCostP50, "claude::sonnet::medium");
});

test("buildMountHeadroomSweep: a cell holding a SINGLE arm carries no comparisons at all — nothing to refuse or report", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      runLines({
        runId: "R1",
        taskId: "T1",
        taskClass: "src",
        provider: "claude",
        servedModel: "claude-sonnet-4-5-20250929",
        turns: 5,
        costUsd: 1,
        verdict: "merged",
        ts: "2026-08-01T00:00:00.000Z",
      }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    assert.equal(report.cells.length, 1);
    assert.equal(report.cells[0].arms.length, 1);
    assert.deepEqual(report.cells[0].comparisons, [], "a single-arm cell has nothing to compare");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 3: every arm reports its own n ───────────────────────────────────────────────────

test("buildMountHeadroomSweep: each arm carries its own settled-run count as n", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      runLines({ runId: "R1", taskId: "T1", taskClass: "src", provider: "claude", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
      runLines({ runId: "R2", taskId: "T2", taskClass: "src", provider: "claude", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T01:00:00.000Z" }),
      runLines({ runId: "R3", taskId: "T3", taskClass: "src", provider: "claude", turns: 5, costUsd: 1, verdict: "incomplete", ts: "2026-08-01T02:00:00.000Z" }),
      runLines({ runId: "R4", taskId: "T4", taskClass: "src", provider: "codex", servedModel: "gpt-5-codex", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T03:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    const cell = report.cells[0];
    const claudeArm = cell.arms.find((a) => a.provider === "claude")!;
    const codexArm = cell.arms.find((a) => a.provider === "codex")!;
    assert.equal(claudeArm.n, 2, "n counts SETTLED runs only — the incomplete R3 is excluded");
    assert.equal(claudeArm.totalRuns, 3, "totalRuns still names the in-flight run, distinctly from n");
    assert.equal(codexArm.n, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 4: each arm carries its pass / blocked_ci / re-dispatch split beside its cost ───

test("buildMountHeadroomSweep: an arm's outcomes (passing/blockedCi/redispatched) ride beside its own cost figures", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      // T1: clean merge on claude.
      runLines({ runId: "R1", taskId: "T1", taskClass: "src", provider: "claude", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
      // T2: first attempt on claude blocked_ci, second attempt (re-dispatch) also claude, merged.
      runLines({ runId: "R2a", taskId: "T2", taskClass: "src", provider: "claude", turns: 5, costUsd: 1, verdict: "blocked_ci", ts: "2026-08-01T01:00:00.000Z" }),
      runLines({ runId: "R2b", taskId: "T2", taskClass: "src", provider: "claude", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T02:00:00.000Z" }),
      // T3: one codex run, merged.
      runLines({ runId: "R3", taskId: "T3", taskClass: "src", provider: "codex", servedModel: "gpt-5-codex", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T03:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    const cell = report.cells[0];
    const claudeArm = cell.arms.find((a) => a.provider === "claude")!;
    const codexArm = cell.arms.find((a) => a.provider === "codex")!;
    assert.deepEqual(claudeArm.outcomes, { passing: 2, blockedCi: 1, redispatched: 1 });
    assert.ok(typeof claudeArm.costP50 === "number", "the outcome split sits beside real cost figures, not instead of them");
    assert.deepEqual(codexArm.outcomes, { passing: 1, blockedCi: 0, redispatched: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 5: an arm whose cost advantage disappears once re-dispatches are charged to it
// is reported as such ───────────────────────────────────────────────────────────────────────────

test("compareArms: an arm that looks cheaper per settled run but needs a re-dispatch loses its advantage once charged per completed task", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      // claude: ONE clean run at $1 — cheap on both metrics.
      runLines({ runId: "C1", taskId: "TC1", taskClass: "src", provider: "claude", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
      // codex: TWO runs of $0.50 each for the SAME task (a re-dispatch) — $0.50 p50 looks
      // cheaper per run than claude's $1, but $1.00 total for the one completed task ties
      // claude, and a THIRD codex example below actually exceeds it.
      runLines({ runId: "X1a", taskId: "TX1", taskClass: "src", provider: "codex", servedModel: "gpt-5-codex", turns: 5, costUsd: 0.5, verdict: "blocked_ci", ts: "2026-08-01T01:00:00.000Z" }),
      runLines({ runId: "X1b", taskId: "TX1", taskClass: "src", provider: "codex", servedModel: "gpt-5-codex", turns: 5, costUsd: 0.7, verdict: "merged", ts: "2026-08-01T02:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    const cell = report.cells[0];
    const claudeArm = cell.arms.find((a) => a.provider === "claude")!;
    const codexArm = cell.arms.find((a) => a.provider === "codex")!;
    // Naive per-run figure: codex's two $0.50/$0.70 runs give it a p50 BELOW claude's flat $1.
    assert.ok((codexArm.costP50 as number) < (claudeArm.costP50 as number), "codex looks cheaper per settled run");
    // Charged figure: codex's ONE completed task cost $1.20 total (0.5 + 0.7), MORE than
    // claude's $1.00 for its one completed task — the advantage reverses once charged.
    assert.equal(codexArm.costPerCompletedTaskUsd, 1.2);
    assert.equal(claudeArm.costPerCompletedTaskUsd, 1);
    assert.ok(
      (codexArm.costPerCompletedTaskUsd as number) > (claudeArm.costPerCompletedTaskUsd as number),
      "codex's per-completed-task cost is HIGHER once its own re-dispatch is charged to it",
    );

    const cmp = cell.comparisons.find(
      (c) => [c.armKeyA, c.armKeyB].includes(claudeArm.armKey) && [c.armKeyA, c.armKeyB].includes(codexArm.armKey),
    )!;
    assert.equal(cmp.cheaperByCostP50, codexArm.armKey, "codex looked cheaper by the naive per-run metric");
    assert.equal(cmp.cheaperByCostPerCompletedTask, claudeArm.armKey, "claude is actually cheaper once re-dispatch is charged");
    assert.equal(cmp.advantageHoldsUnderRedispatch, false, "codex's apparent advantage does NOT hold");
    assert.match(cmp.note, new RegExp(`${codexArm.armKey}.*disappears|advantage disappears`), "the note names the reversal, not merely a number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compareArms: an arm cheaper on BOTH metrics reports its advantage as holding", () => {
  const armA = { cellKey: "implement::medium::src", armKey: "claude::sonnet::medium", n: 5, costP50: 1, costPerCompletedTaskUsd: 1 };
  const armB = { cellKey: "implement::medium::src", armKey: "codex::gpt5::medium", n: 5, costP50: 3, costPerCompletedTaskUsd: 3 };
  const cmp = compareArms(armA, armB);
  assert.equal(cmp.cheaperByCostP50, armA.armKey);
  assert.equal(cmp.cheaperByCostPerCompletedTask, armA.armKey);
  assert.equal(cmp.advantageHoldsUnderRedispatch, true);
  assert.match(cmp.note as string, /holds/);
});

// ── ACCEPTANCE 6: the corpus's newest timestamp is printed beside every comparison ──────────────

test("buildMountHeadroomSweep: every arm AND every comparison carries the corpus's own newestTs", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      runLines({ runId: "R1", taskId: "T1", taskClass: "src", provider: "claude", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
      runLines({ runId: "R2", taskId: "T2", taskClass: "src", provider: "codex", servedModel: "gpt-5-codex", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-09-01T12:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    assert.equal(report.corpus.newestTs, "2026-09-01T12:00:00.000Z");
    const cell = report.cells[0];
    for (const arm of cell.arms) {
      assert.equal(arm.newestTs, report.corpus.newestTs, "every arm carries the corpus's own newest ts, not a per-arm one");
    }
    assert.equal(cell.comparisons.length, 1);
    assert.equal(cell.comparisons[0].newestTs, report.corpus.newestTs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderMountHeadroomReport: the rendered text prints the newest row seen beside each comparison line", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      runLines({ runId: "R1", taskId: "T1", taskClass: "src", provider: "claude", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
      runLines({ runId: "R2", taskId: "T2", taskClass: "src", provider: "codex", servedModel: "gpt-5-codex", turns: 5, costUsd: 2, verdict: "merged", ts: "2026-09-02T00:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    const text = renderMountHeadroomReport(report);
    assert.match(text, /compare .* vs .*: .*\(newest row seen: 2026-09-02T00:00:00\.000Z\)/);
    assert.match(text, /cells \(type x risk x class\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── SUPPORTING: armFieldsByRunId reads provider/served_model/effort honestly, including the
// "checked, unreportable" vs "predates this field" distinction W1-T2572 established ─────────────

test("armFieldsByRunId: an explicit served_model:null (a checked, unreportable provider call) reads as \"unreported\", never \"unknown\"", () => {
  const records = [
    { run_id: "R1", step: "implement.done", provider: "codex", served_model: null, effort: "medium" },
  ];
  const fields = armFieldsByRunId(records);
  assert.equal(fields.get("R1")!.servedModel, "unreported");
});

test("armFieldsByRunId: a line predating W1-T2572 (no served_model key at all) reads as \"unknown\", distinctly from an explicit null", () => {
  const records = [{ run_id: "R1", step: "implement.done", num_turns: 5 }];
  const fields = armFieldsByRunId(records);
  assert.equal(fields.get("R1")!.servedModel, "unknown");
  assert.equal(fields.get("R1")!.provider, "unknown");
  assert.equal(fields.get("R1")!.effort, "unknown");
});

test("computeArmSweep: a run whose run_id has no arm fields at all falls back to the fully-unknown arm, never throws", () => {
  const runs = [
    { runId: "R1", taskId: "T1", type: "implement", risk: "medium", taskClass: "src", startTs: "2026-08-01T00:00:00.000Z", verdict: "merged", costUsd: 1, numTurns: 5 },
  ];
  const cells = computeArmSweep(runs, new Map(), undefined) as Array<{ arms: Array<{ armKey: string; provider: string }> }>;
  assert.equal(cells.length, 1);
  assert.equal(cells[0].arms.length, 1);
  assert.equal(cells[0].arms[0].provider, "unknown");
});

test("armFieldsByRunId: a non-object row (malformed JSON that still parses, e.g. a bare number) is skipped, never thrown on", () => {
  const records = [5, null, "not an object", { run_id: "R1", step: "implement.done", provider: "claude", served_model: "sonnet", effort: "medium" }];
  const fields = armFieldsByRunId(records);
  assert.equal(fields.size, 1, "only the one real record is read");
  assert.equal(fields.get("R1")!.provider, "claude");
});

test("armFieldsByRunId: the implementation worker wins over an earlier recon worker", () => {
  const records = [
    { run_id: "R1", step: "recon.done", provider: "claude", served_model: "claude-sonnet-5", effort: "medium" },
    { run_id: "R1", step: "implement.done", provider: "claude", served_model: "claude-haiku-4-5-20251001", effort: "medium" },
  ];
  const fields = armFieldsByRunId(records);
  assert.deepEqual(fields.get("R1"), {
    provider: "claude",
    servedModel: "claude-haiku-4-5-20251001",
    effort: "medium",
  });
});

test("armFieldsByRunId: the implementation worker also wins over a later recon worker", () => {
  const records = [
    { run_id: "R1", step: "implement.done", provider: "claude", served_model: "claude-haiku-4-5-20251001", effort: "medium" },
    { run_id: "R1", step: "recon.done", provider: "claude", served_model: "claude-sonnet-5", effort: "medium" },
  ];
  const fields = armFieldsByRunId(records);
  assert.deepEqual(fields.get("R1"), {
    provider: "claude",
    servedModel: "claude-haiku-4-5-20251001",
    effort: "medium",
  });
});

test("armFieldsByRunId: recon remains the honest fallback for a recon-only run", () => {
  const records = [
    { run_id: "R1", step: "recon.done", provider: "claude", served_model: "claude-sonnet-5", effort: "medium" },
  ];
  const fields = armFieldsByRunId(records);
  assert.equal(fields.get("R1")!.servedModel, "claude-sonnet-5");
});

test("armFieldsByRunId: the FIRST implementation line wins over a later implementation resume", () => {
  const records = [
    { run_id: "R1", step: "implement.done", provider: "claude", served_model: "claude-sonnet-4-5-20250929", effort: "medium" },
    { run_id: "R1", step: "implement.resumed", provider: "codex", served_model: "gpt-5-codex", effort: "high" },
  ];
  const fields = armFieldsByRunId(records);
  assert.equal(fields.get("R1")!.provider, "claude", "the first line's provider wins over the resume's");
});

// ── SUPPORTING: compareArms's remaining note branches (tie / missing data) ─────────────────────

test("compareArms: missing cost data on one arm reports 'insufficient data', never a guessed cheaper arm", () => {
  const armA = { cellKey: "implement::medium::src", armKey: "claude::sonnet::medium", n: 1, costP50: null, costPerCompletedTaskUsd: null };
  const armB = { cellKey: "implement::medium::src", armKey: "codex::gpt5::medium", n: 1, costP50: 2, costPerCompletedTaskUsd: 2 };
  const cmp = compareArms(armA, armB);
  assert.equal(cmp.cheaperByCostP50, null);
  assert.equal(cmp.cheaperByCostPerCompletedTask, null);
  assert.equal(cmp.advantageHoldsUnderRedispatch, null);
  assert.match(cmp.note as string, /insufficient/);
});

test("compareArms: a genuine tie on both metrics also reports 'insufficient data' rather than fabricating a winner", () => {
  const armA = { cellKey: "implement::medium::src", armKey: "claude::sonnet::medium", n: 3, costP50: 1, costPerCompletedTaskUsd: 1 };
  const armB = { cellKey: "implement::medium::src", armKey: "codex::gpt5::medium", n: 3, costP50: 1, costPerCompletedTaskUsd: 1 };
  const cmp = compareArms(armA, armB);
  assert.equal(cmp.cheaperByCostP50, null, "a tie names no cheaper arm");
  assert.equal(cmp.cheaperByCostPerCompletedTask, null);
});

// ── SUPPORTING: renderMountHeadroomReport's single-arm-cell branch (no comparison line at all) ──

test("renderMountHeadroomReport: a cell with only one arm renders as 'no within-cell comparison is possible', never a fabricated comparison", () => {
  const dir = tmpDir();
  try {
    writeLive(dir, [
      runLines({ runId: "R1", taskId: "T1", taskClass: "src", provider: "claude", turns: 5, costUsd: 1, verdict: "merged", ts: "2026-08-01T00:00:00.000Z" }),
    ]);
    const report = buildMountHeadroomSweep(dir);
    const text = renderMountHeadroomReport(report);
    assert.match(text, /only 1 arm\(s\) in this cell — no within-cell comparison is possible/);
    assert.doesNotMatch(text, /^\s*compare /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
