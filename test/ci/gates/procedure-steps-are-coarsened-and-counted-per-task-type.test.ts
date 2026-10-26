import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildProcedureCensus,
  normalizeProcedureStep,
  procedureStepsForRun,
  renderProcedureCensus,
} from "#src/lib/procedure-census.js";
import { gatherRuns, type LedgerRecord } from "#src/lib/retro.js";

// The procedure census reads each worker tool call's `tool_signature`, coarsened so one file is not one step, and
// reports per task type which steps CLEAN merged runs (zero fix rounds) repeat against REPAIRED ones. Every timestamp
// below is a fixture time; nothing here compares against today's clock.

/** One step of a fixture run: a signature string, or a row that carries only `tool_name` (every row before 2026-10-13). */
type FixtureStep = string | { bare: string };

const at = (day: number, second: number): string => new Date(Date.UTC(2026, 9, day, 0, 0, second)).toISOString();

/** The ledger rows of one run: `run.start`, a `worker.activity` tool-executing row per step, its fix rounds, a verdict. */
function runRows(
  runId: string,
  type: string,
  day: number,
  steps: readonly FixtureStep[],
  opts: { verdict?: string; fixes?: number; fixRunId?: string } = {},
): LedgerRecord[] {
  const taskId = `W1-T${runId}`;
  let second = 0;
  const rows: LedgerRecord[] = [{ ts: at(day, second++), run_id: runId, task_id: taskId, step: "run.start", type }];
  for (const step of steps) {
    const signature = typeof step === "string" ? step : undefined;
    const toolName = typeof step === "string" ? step.split(":")[0]! : step.bare;
    rows.push({ ts: at(day, second++), run_id: runId, task_id: taskId, step: "worker.activity", event_kind: "tool-executing",
      tool_name: toolName, ...(signature === undefined ? {} : { tool_signature: signature }) });
  }
  for (let i = 0; i < (opts.fixes ?? 0); i++) {
    rows.push({ ts: at(day, second++), run_id: opts.fixRunId ?? runId, task_id: taskId, step: "fix.dispatch", strike: i + 1 });
  }
  rows.push({ ts: at(day, second++), run_id: runId, task_id: taskId, step: "verdict", verdict: opts.verdict ?? "merged" });
  return rows;
}

// IMPLEMENT: five clean runs and two repaired ones. Normalized, every clean run reads CLAUDE.md and edits a
// src/lib/*.ts file; four read a coverage-traps doctrine page (two different pages, one step once coarsened); C5's
// Glob row carries no signature and falls back to its tool name. R2's fix round rides the sweep's own run id and is
// attributed to R2 by task id, as the retro attributes it. F1 failed, so it counts nowhere — not even in the control.
// DIAGNOSE: one clean run and no repaired run.
const RECORDS: LedgerRecord[] = [
  ...runRows("C1", "implement", 1, ["Read:CLAUDE.md", "Read:doctrine/coverage-traps/delete-the-fix.md", "Edit:src/lib/review.ts", "Bash:npm test"]),
  ...runRows("C2", "implement", 2, ["Read:CLAUDE.md", "Read:doctrine/coverage-traps/same-tree-name-the-sha.md", "Edit:src/lib/deep/er/f.ts", "Bash:npm test"]),
  ...runRows("C3", "implement", 3, ["Read:CLAUDE.md", "Read:doctrine/coverage-traps/delete-the-fix.md", "Edit:src/lib/review.ts", "Grep"]),
  ...runRows("C4", "implement", 4, ["Read:CLAUDE.md", "Read:doctrine/coverage-traps/delete-the-fix.md", "Read:CLAUDE.md", "Edit:src/lib/x.ts", "Grep"]),
  ...runRows("C5", "implement", 5, ["Read:CLAUDE.md", { bare: "Glob" }, "Edit:src/lib/review.ts", "Bash:npm test"]),
  ...runRows("R1", "implement", 6, ["Edit:src/lib/review.ts", "Bash:npm test", "Grep"], { fixes: 1 }),
  ...runRows("R2", "implement", 7, ["Read:CLAUDE.md", "Edit:src/lib/review.ts", "Grep"], { fixes: 2, fixRunId: "DAEMON-1" }),
  ...runRows("F1", "implement", 8, ["Read:CLAUDE.md", "Write:src/lib/new.ts"], { verdict: "failed" }),
  ...runRows("D1", "diagnose", 9, ["Read:plan/policy.yaml", "Bash:git log"]),
];

const WINDOW = { sinceTs: "2026-10-01T00:00:00.000Z", untilTs: "2026-10-15T00:00:00.000Z" };

test("normalizeProcedureStep keeps a top-level path, <outside> and . verbatim", () => {
  assert.equal(normalizeProcedureStep("Read:CLAUDE.md"), "Read:CLAUDE.md");
  assert.equal(normalizeProcedureStep("Read:package.json"), "Read:package.json");
  assert.equal(normalizeProcedureStep("Read:<outside>"), "Read:<outside>");
  assert.equal(normalizeProcedureStep("Edit:<outside>"), "Edit:<outside>");
  assert.equal(normalizeProcedureStep("Glob:."), "Glob:.");
  assert.equal(normalizeProcedureStep("Read:."), "Read:.");
});

test("normalizeProcedureStep coarsens a nested path to two directories and the file's full extension", () => {
  assert.equal(normalizeProcedureStep("Read:src/lib/review.ts"), "Read:src/lib/*.ts");
  assert.equal(normalizeProcedureStep("Edit:test/ci/x.test.ts"), "Edit:test/ci/*.test.ts");
  assert.equal(normalizeProcedureStep("Read:doctrine/coverage-traps/delete-the-fix.md"), "Read:doctrine/coverage-traps/*.md");
  assert.equal(normalizeProcedureStep("Read:src/lib/deep/er/f.ts"), "Read:src/lib/*.ts");
  assert.equal(normalizeProcedureStep("Read:plan/policy.yaml"), "Read:plan/*.yaml");
});

test("normalizeProcedureStep keeps * alone for a basename with no dot", () => {
  assert.equal(normalizeProcedureStep("Read:bin/rmd"), "Read:bin/*");
  assert.equal(normalizeProcedureStep("Read:deploy/mac/launch/run"), "Read:deploy/mac/*");
});

test("normalizeProcedureStep passes Bash signatures and bare tool names through unchanged", () => {
  assert.equal(normalizeProcedureStep("Bash:git status"), "Bash:git status");
  assert.equal(normalizeProcedureStep("Bash:node --test test/ci/x.test.ts"), "Bash:node --test test/ci/x.test.ts");
  assert.equal(normalizeProcedureStep("Grep"), "Grep");
  assert.equal(normalizeProcedureStep("TodoWrite"), "TodoWrite");
  assert.equal(normalizeProcedureStep("mcp__github__get_me"), "mcp__github__get_me");
});

test("procedureStepsForRun reads one run's tool calls in ledger order, first occurrence only, coarsened", () => {
  assert.deepEqual(procedureStepsForRun(RECORDS, "C4"),
    ["Read:CLAUDE.md", "Read:doctrine/coverage-traps/*.md", "Edit:src/lib/*.ts", "Grep"]);
  assert.deepEqual(procedureStepsForRun(RECORDS, "D1"), ["Read:plan/*.yaml", "Bash:git log"]);
  assert.deepEqual(procedureStepsForRun(RECORDS, "no-such-run"), []);
});

test("procedureStepsForRun falls back to tool_name when a row carries no tool_signature", () => {
  assert.deepEqual(procedureStepsForRun(RECORDS, "C5"), ["Read:CLAUDE.md", "Glob", "Edit:src/lib/*.ts", "Bash:npm test"]);
  const rows: LedgerRecord[] = [
    { run_id: "X", step: "worker.activity", event_kind: "tool-executing", tool_name: "Read", tool_signature: "" },
    { run_id: "X", step: "worker.activity", event_kind: "tool-completed", tool_name: "Edit", tool_signature: "Edit:src/a.ts" },
    { run_id: "X", step: "worker.activity", event_kind: "tool-executing", tool_signature: 7 },
    { run_id: "X", step: "worker.state", event_kind: "tool-executing", tool_name: "Write" },
    { run_id: "X", step: "worker.activity", event_kind: "tool-executing", tool_name: "Bash", tool_signature: "Bash:git diff" },
  ];
  // An empty signature falls back to the name; a completed event, a wrong step and a row with neither are not steps.
  assert.deepEqual(procedureStepsForRun(rows, "X"), ["Read", "Bash:git diff"]);
});

test("buildProcedureCensus splits each task type into clean and repaired merged runs", () => {
  const census = buildProcedureCensus(gatherRuns(RECORDS), RECORDS);
  assert.equal(census.mergedRuns, 8);
  assert.deepEqual(census.taskTypes.map((t) => [t.taskType, t.cleanRuns, t.repairedRuns]), [["diagnose", 1, 0], ["implement", 5, 2]]);
});

test("buildProcedureCensus names the steps at least 80% of five or more clean runs took as universal", () => {
  const implement = buildProcedureCensus(gatherRuns(RECORDS), RECORDS).taskTypes.find((t) => t.taskType === "implement")!;
  assert.deepEqual(implement.universal, ["Edit:src/lib/*.ts", "Read:CLAUDE.md", "Read:doctrine/coverage-traps/*.md"]);
});

test("buildProcedureCensus reports each clean step's clean share, repaired share and lift", () => {
  const implement = buildProcedureCensus(gatherRuns(RECORDS), RECORDS).taskTypes.find((t) => t.taskType === "implement")!;
  assert.deepEqual(implement.steps, [
    { step: "Edit:src/lib/*.ts", cleanShare: 1, repairedShare: 1, lift: 0 },
    { step: "Read:CLAUDE.md", cleanShare: 1, repairedShare: 0.5, lift: 0.5 },
    { step: "Read:doctrine/coverage-traps/*.md", cleanShare: 0.8, repairedShare: 0, lift: 0.8 },
    { step: "Bash:npm test", cleanShare: 0.6, repairedShare: 0.5, lift: 0.1 },
    { step: "Grep", cleanShare: 0.4, repairedShare: 1, lift: -0.6 },
    { step: "Glob", cleanShare: 0.2, repairedShare: 0, lift: 0.2 },
  ]);
});

test("buildProcedureCensus leaves repairedShare and lift null for a task type with no repaired run", () => {
  const diagnose = buildProcedureCensus(gatherRuns(RECORDS), RECORDS).taskTypes.find((t) => t.taskType === "diagnose")!;
  assert.deepEqual(diagnose.steps, [
    { step: "Bash:git log", cleanShare: 1, repairedShare: null, lift: null },
    { step: "Read:plan/*.yaml", cleanShare: 1, repairedShare: null, lift: null },
  ]);
  // One clean run is below the floor of five, so nothing is universal however often it repeats.
  assert.deepEqual(diagnose.universal, []);
});

test("buildProcedureCensus takes the universal share and clean-run floor from opts", () => {
  const census = buildProcedureCensus(gatherRuns(RECORDS), RECORDS, { universalMinShare: 1, universalMinCleanRuns: 1 });
  assert.deepEqual(census.thresholds, { universalMinShare: 1, universalMinCleanRuns: 1, sequenceMinShare: 0.5 });
  assert.deepEqual(census.taskTypes.map((t) => [t.taskType, t.universal]), [
    ["diagnose", ["Bash:git log", "Read:plan/*.yaml"]],
    ["implement", ["Edit:src/lib/*.ts", "Read:CLAUDE.md"]],
  ]);
});

test("buildProcedureCensus keeps the contiguous 2- and 3-step sequences at least half the clean runs share", () => {
  const census = buildProcedureCensus(gatherRuns(RECORDS), RECORDS);
  const implement = census.taskTypes.find((t) => t.taskType === "implement")!;
  assert.deepEqual(implement.sequences, [
    { steps: ["Read:CLAUDE.md", "Read:doctrine/coverage-traps/*.md", "Edit:src/lib/*.ts"], share: 0.8 },
    { steps: ["Read:CLAUDE.md", "Read:doctrine/coverage-traps/*.md"], share: 0.8 },
    { steps: ["Read:doctrine/coverage-traps/*.md", "Edit:src/lib/*.ts"], share: 0.8 },
    { steps: ["Edit:src/lib/*.ts", "Bash:npm test"], share: 0.6 },
  ]);
  const diagnose = census.taskTypes.find((t) => t.taskType === "diagnose")!;
  assert.deepEqual(diagnose.sequences, [{ steps: ["Read:plan/*.yaml", "Bash:git log"], share: 1 }]);
});

test("buildProcedureCensus keeps at most ten sequences, by share then length then name", () => {
  // Two clean runs each take the same 12 distinct steps in order: 11 pairs and 10 triples, all at share 1.
  const steps = Array.from({ length: 12 }, (_, i) => `Bash:step-${String(i).padStart(2, "0")}`);
  const rows = Array.from({ length: 2 }, (_, i) => runRows(`S${i}`, "review", 10 + i, steps)).flat();
  const review = buildProcedureCensus(gatherRuns(rows), rows).taskTypes[0]!;
  assert.equal(review.sequences.length, 10);
  assert.ok(review.sequences.every((s) => s.steps.length === 3 && s.share === 1), "the triples outrank the pairs at equal share");
  assert.deepEqual(review.sequences[0]!.steps, ["Bash:step-00", "Bash:step-01", "Bash:step-02"]);
});

test("the signature-coverage control counts every tool-call row of the merged runs and how many carry a signature", () => {
  const census = buildProcedureCensus(gatherRuns(RECORDS), RECORDS);
  // C1-C3 and C5 four rows each, C4 five, R1 and R2 three each, D1 two: 29 rows; C5's Glob row lacks a signature.
  // F1 failed, so its two rows are not counted.
  assert.deepEqual(census.signatureCoverage, { toolRows: 29, withSignature: 28 });
});

test("renderProcedureCensus prints the window and the signature-coverage control before any task type", () => {
  const text = renderProcedureCensus(buildProcedureCensus(gatherRuns(RECORDS), RECORDS), WINDOW);
  assert.match(text, /Window: 2026-10-01T00:00:00\.000Z to 2026-10-15T00:00:00\.000Z\. Merged runs: 8\./);
  assert.ok(text.includes("- 28 of 29 tool-call rows carry a tool_signature (97%)."), text);
  assert.ok(!text.includes("WARNING"), text);
  const control = text.indexOf("## Signature coverage (control)");
  assert.ok(control >= 0 && control < text.indexOf("## diagnose") && text.indexOf("## diagnose") < text.indexOf("## implement"), text);
});

test("renderProcedureCensus lists each type's run counts, universal steps, positive lifts and sequences", () => {
  const text = renderProcedureCensus(buildProcedureCensus(gatherRuns(RECORDS), RECORDS), WINDOW);
  const implement = text.slice(text.indexOf("## implement"));
  for (const line of [
    "- Clean runs (zero fix rounds): 5. Repaired runs: 2.",
    "- `Read:doctrine/coverage-traps/*.md`",
    "- `Read:doctrine/coverage-traps/*.md`: +0.80 (clean 80%, repaired 0%)",
    "- `Read:CLAUDE.md`: +0.50 (clean 100%, repaired 50%)",
    "- `Glob`: +0.20 (clean 20%, repaired 0%)",
    "- `Bash:npm test`: +0.10 (clean 60%, repaired 50%)",
    "- `Read:CLAUDE.md` → `Read:doctrine/coverage-traps/*.md` → `Edit:src/lib/*.ts`: 80%",
    "- `Edit:src/lib/*.ts` → `Bash:npm test`: 60%",
  ]) assert.ok(implement.includes(line), `missing ${JSON.stringify(line)} in:\n${implement}`);
  // Highest lift first; a zero or negative lift is not listed.
  assert.ok(implement.indexOf("+0.80") < implement.indexOf("+0.50") && implement.indexOf("+0.20") < implement.indexOf("+0.10"));
  assert.ok(!implement.includes("`Grep`:") && !implement.includes("`Edit:src/lib/*.ts`: +"), implement);
  const diagnose = text.slice(text.indexOf("## diagnose"), text.indexOf("## implement"));
  assert.ok(diagnose.includes("- none: 1 clean run(s) is below the floor of 5."), diagnose);
  assert.ok(diagnose.includes("- none: no repaired run to compare against."), diagnose);
});

test("renderProcedureCensus says none when no step is universal, lifted or shared as a sequence", () => {
  // Five clean runs, one distinct step each; one repaired run took all five, so every lift is negative.
  const letters = ["A", "B", "C", "D", "E"];
  const rows = [
    ...letters.flatMap((l, i) => runRows(`N${l}`, "review", 20 + i, [`Bash:${l.toLowerCase()}`])),
    ...runRows("NR", "review", 26, letters.map((l) => `Bash:${l.toLowerCase()}`), { fixes: 1 }),
  ];
  const census = buildProcedureCensus(gatherRuns(rows), rows);
  const review = census.taskTypes[0]!;
  assert.deepEqual([review.cleanRuns, review.repairedRuns, review.universal, review.sequences], [5, 1, [], []]);
  const text = renderProcedureCensus(census, WINDOW);
  assert.ok(text.includes("Universal steps (in at least 80% of clean runs, from 5 clean runs):\n- none."), text);
  assert.ok(text.includes("- none: no step is more common in clean runs than in repaired ones."), text);
  assert.ok(text.includes("Top sequences (contiguous, in at least 50% of clean runs):\n- none."), text);
});

test("a census over rows with no tool_signature reads bare tool names and the render warns that signatures are missing", () => {
  const rows = [
    ...runRows("U1", "implement", 1, [{ bare: "Read" }, { bare: "Edit" }]),
    ...runRows("U2", "implement", 2, [{ bare: "Read" }, { bare: "Bash" }]),
  ];
  const census = buildProcedureCensus(gatherRuns(rows), rows);
  assert.deepEqual(census.signatureCoverage, { toolRows: 4, withSignature: 0 });
  assert.deepEqual(census.taskTypes[0]!.steps.map((s) => s.step), ["Read", "Bash", "Edit"]);
  const text = renderProcedureCensus(census, WINDOW);
  assert.ok(text.includes("- 0 of 4 tool-call rows carry a tool_signature (0%)."), text);
  assert.ok(text.includes("- WARNING: no tool-call row in this window carries a tool_signature"), text);
  assert.ok(text.indexOf("WARNING") < text.indexOf("## implement"), "the warning comes before any task type");
});

test("a census with no merged run and no tool-call row still prints the control and its warning", () => {
  const rows = runRows("Z1", "implement", 1, ["Read:CLAUDE.md"], { verdict: "failed" });
  const census = buildProcedureCensus(gatherRuns(rows), rows);
  assert.deepEqual([census.mergedRuns, census.signatureCoverage, census.taskTypes], [0, { toolRows: 0, withSignature: 0 }, []]);
  const text = renderProcedureCensus(census, WINDOW);
  assert.ok(text.includes("- 0 of 0 tool-call rows carry a tool_signature."), text);
  assert.ok(text.includes("- WARNING: no tool-call row in this window carries a tool_signature"), text);
});
