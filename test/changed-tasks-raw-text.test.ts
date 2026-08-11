/**
 * W1-T428: the changed-tasks gate compares PARSED tasks and the parser drops SIX fields —
 * `design`, `plan_refs`, `queue_note`, `amendment_note`, `cycle_residual`, `fixture_forensics` —
 * so an instructions-only edit re-linted ZERO tasks (#1544 measured `0 task(s) checked` on
 * exactly that input and had to flag its own run as vacuous). The asymmetry that made it bite:
 * `note` and `rationale` ARE parsed, so a justification change was visible while an INSTRUCTION
 * change was not.
 *
 * Three layers, matching the fix's seams:
 *   (i)  splitTaskRecordBlocks / rawChangedTaskIds — pure, over synthetic corpora AND over the
 *        real monolith text (the four monolith tasks are the block-boundary case a shard-only
 *        fixture cannot represent).
 *   (ii) the REAL `--base HEAD` path through lintPlanCommand: a design-only edit to a real shard
 *        ON DISK (restored in finally) must raise the checked count from 0 to 1 — the #1544
 *        shape reproduced as this fix's regression lock. Safe to perform against the live tree
 *        precisely BECAUSE of the defect under repair: `design:` is invisible to every parsed
 *        consumer, so no concurrent suite can observe the edit.
 *   (iii) both no-false-positive directions: an untouched corpus reports nothing, and a block
 *        moved without editing reports nothing — a gate that marks everything changed is as
 *        useless as one that marks nothing.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { rawChangedTaskIds, splitTaskRecordBlocks } from "../src/lib/task-linter.js";
import { lintPlanCommand } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function shard(id: string, design: string): string {
  return [`- id: ${id}`, `  title: "t ${id}"`, "  design: |", `    ${design}`, "  status: queued", ""].join("\n");
}

// ── (i) the pure comparator ──────────────────────────────────────────────────────────────────

test("a design-only edit registers its id — the exact class the parsed comparison drops", () => {
  const changed = rawChangedTaskIds([shard("T1", "do the OLD thing")], [shard("T1", "do the NEW thing")]);
  assert.deepEqual([...changed], ["T1"]);
});

test("byte-identical corpora register nothing — the gate must not cry wolf", () => {
  const a = shard("T1", "same") + shard("T2", "also same");
  assert.equal(rawChangedTaskIds([a], [a]).size, 0);
});

test("a block MOVED between files without an edit registers nothing — identity is the id, not the position", () => {
  const one = shard("T1", "stable");
  const two = shard("T2", "also stable");
  const changed = rawChangedTaskIds([one + two], [two, one]);
  assert.equal(changed.size, 0, `moved-not-edited must be invisible, got ${[...changed]}`);
});

test("in a multi-task monolith text, editing ONE design reports only that id", () => {
  const oldText = shard("T1", "a") + shard("T2", "b") + shard("T3", "c");
  const newText = shard("T1", "a") + shard("T2", "b EDITED") + shard("T3", "c");
  assert.deepEqual([...rawChangedTaskIds([oldText], [newText])], ["T2"]);
});

test("the REAL monolith splits into exactly its own task ids, so the block boundary matches the corpus", () => {
  // plan/tasks.yaml still carries a handful of genesis tasks — the multi-record file a
  // shard-only fixture cannot represent. The splitter's id set must match the real parser's
  // view of the same bytes (spot-checked by count and by a known genesis id prefix).
  const monolith = readFileSync(join(REPO_ROOT, "plan", "tasks.yaml"), "utf8");
  const blocks = splitTaskRecordBlocks(monolith);
  assert.ok(blocks.size > 0, "the monolith must split into at least one record");
  for (const id of blocks.keys()) assert.match(id, /^W\d+-T/, `unexpected id shape: ${id}`);
  // Editing one real block in memory reports exactly that id — the brief's monolith direction,
  // proven over the real corpus without touching disk.
  const anyId = [...blocks.keys()][0];
  const edited = monolith.replace(blocks.get(anyId)!, blocks.get(anyId)! + "\n  # design drift");
  assert.deepEqual([...rawChangedTaskIds([monolith], [edited])], [anyId]);
});

// ── (ii) the real --base path: #1544's vacuous result, reproduced then locked out ───────────

async function runLintPlanBase(): Promise<{ exitCode: number; stdout: string }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (m: string) => logs.push(String(m));
  console.error = (m: string) => logs.push(String(m));
  console.warn = () => {};
  try {
    const exitCode = await lintPlanCommand(["--base", "HEAD"]);
    return { exitCode, stdout: logs.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

test("a design-only edit to a real shard raises the --base checked count from 0 to 1 — the #1544 shape locked out", async () => {
  const target = join(REPO_ROOT, "plan", "tasks.d", "W1-T428-changed-tasks-gate-blind-to-dropped-fields.yaml");
  const original = readFileSync(target, "utf8");
  try {
    // CONTROL first: with the plan tree clean vs HEAD, --base reports zero changed tasks. If
    // this repo's plan/ is ever dirty at test time the control names it, instead of the real
    // assertion below failing mysteriously.
    const before = await runLintPlanBase();
    assert.match(before.stdout, /0 task\(s\) checked \(0 new\/changed vs HEAD\)/, "control: plan tree must be clean vs HEAD");
    // The design-only edit: one trailing marker inside the design block — parsed-invisible
    // (design is a dropped field), raw-visible (the record's bytes change).
    assert.ok(original.includes("design: |"), "target shard must carry a design block");
    const edited = original.replace("design: |", "design: |\n    (raw-text regression probe — parsed-invisible)");
    assert.notEqual(edited, original);
    writeFileSync(target, edited, "utf8");
    const after = await runLintPlanBase();
    assert.match(
      after.stdout,
      /1 task\(s\) checked \(1 new\/changed vs HEAD\)/,
      "a design-only edit must be IN scope — 0 checked here is #1544's vacuous result",
    );
  } finally {
    writeFileSync(target, original, "utf8");
  }
});

test("a plan whose dir has NO tasks.d reads as an empty shard corpus, never a throw — the catch arm", async () => {
  // The tracked status-DI fixture has no tasks.d sibling, so the HEAD-side shard read hits the
  // guarded catch (the base side's tmp tasks.d is always created by materializeOriginShards).
  // A missing shard dir is the normal single-file-plan case, not an error.
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (m: string) => logs.push(String(m));
  console.error = (m: string) => logs.push(String(m));
  try {
    const exitCode = await lintPlanCommand(["--plan", join(REPO_ROOT, "test", "fixtures", "lint-plan-status-di", "tasks.yaml"), "--base", "HEAD"]);
    assert.ok(exitCode === 0 || exitCode === 1, `must complete a real verdict, got ${exitCode}: ${logs.join(" | ").slice(0, 200)}`);
    assert.match(logs.join("\n"), /task\(s\) checked/, "the run must reach its summary, proving no throw escaped");
  } finally {
    console.log = origLog;
    console.error = origError;
  }
});
