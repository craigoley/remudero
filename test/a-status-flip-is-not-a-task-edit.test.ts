/**
 * W1-T3274 — EVERY PLAN-RECONCILE PR IS STRUCTURALLY RED. `plan-reconcile --write` (lib/plan-
 * reconcile.ts) flips a shard's `status: queued` line to `status: merged` and touches nothing
 * else, but `lint-plan --base`'s changed-tasks scope (`changedTaskIds`/`rawChangedTaskIds`,
 * task-linter.ts) treats ANY record-text difference as an edit — so the one write that removes a
 * task from the OPEN population is also the write that drags it into the CHANGED population, and
 * the reconcile inherits every pre-existing violation on every shard it touches (MEASURED on
 * #4846: 26 status-only flips, 6 failing, 5 already failing on base).
 *
 * The fix, `statusFlipOnlyTaskIds` (task-linter.ts): a shard whose ENTIRE diff against the base is
 * the `status:` line's value, flipping to a closed/landed status, is CARVED out of `--base`'s
 * scope before the open-task rules ever see it — reported, never silently dropped.
 *
 * Two tiers, matching test/changed-tasks-raw-text.test.ts's own layering for the sibling raw-text
 * comparator:
 *   (i)  the pure comparator, `statusFlipOnlyTaskIds`, over synthetic corpora — every control the
 *        task's own design and falsifier name, with no git or filesystem involved.
 *   (ii) the REAL `--base HEAD` path through `lintPlanCommand`, over a committed fixture plan
 *        (test/fixtures/live-plan-writers/status-flip/) — each scenario transiently edits its own
 *        shard on disk and restores it in a `finally`, the same technique (i) and (ii) already
 *        use in test/changed-tasks-raw-text.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { statusFlipOnlyTaskIds, STATUS_LINE_RE } from "../src/lib/task-linter.js";
import { lintPlanCommand } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PLAN = join(REPO_ROOT, "test", "fixtures", "live-plan-writers", "status-flip", "tasks.yaml");
const FIXTURE_DIR = join(REPO_ROOT, "test", "fixtures", "live-plan-writers", "status-flip", "tasks.d");

function shard(id: string, status: string, extraLine = ""): string {
  const lines = [`- id: ${id}`, `  title: "t ${id}"`, "  repo: remudero", "  type: implement", `  status: ${status}`];
  if (extraLine) lines.push(extraLine);
  // ALWAYS a trailing blank line, regardless of `extraLine` — several tests concatenate multiple
  // `shard()` calls into one multi-record text, and splitTaskRecordBlocks/STATUS_LINE_RE both
  // need a real line boundary between one record's last field and the next record's `- id:`.
  return lines.join("\n") + "\n\n";
}

// ── (i) the pure comparator ──────────────────────────────────────────────────────────────────

test("a pure status flip to a closed status (queued -> merged) is carved", () => {
  const carved = statusFlipOnlyTaskIds([shard("T1", "queued")], [shard("T1", "merged")]);
  assert.deepEqual([...carved], ["T1"]);
});

test("queued -> blocked and queued -> done are carved too — any closed/landed target, not only merged", () => {
  assert.deepEqual([...statusFlipOnlyTaskIds([shard("T1", "queued")], [shard("T1", "blocked")])], ["T1"]);
  assert.deepEqual([...statusFlipOnlyTaskIds([shard("T1", "queued")], [shard("T1", "done")])], ["T1"]);
});

test("design point (ii): a flip riding alongside another field edit is NOT carved", () => {
  const oldText = shard("T1", "queued", '  title_extra: "a"');
  const newText = shard("T1", "merged", '  title_extra: "b"');
  assert.equal(statusFlipOnlyTaskIds([oldText], [newText]).size, 0, "a genuine edit riding the flip must keep the task in scope");
});

test("falsifier's second control: a flip to a still-OPEN status is NOT carved", () => {
  const carved = statusFlipOnlyTaskIds([shard("T1", "queued")], [shard("T1", "recon")]);
  assert.equal(carved.size, 0, "the carve is about LEAVING the open population, not the field moving");
});

test("a status flip FROM one closed status TO another closed status is carved — it's still leaving nothing new, but the byte-diff rule holds either way", () => {
  // blocked -> merged: both closed, still a pure single-field flip, still carved by this
  // function's own rule (the caller in run-task.ts is what additionally requires the task to
  // have been genuinely open before — this comparator only characterizes the DIFF).
  assert.deepEqual([...statusFlipOnlyTaskIds([shard("T1", "blocked")], [shard("T1", "merged")])], ["T1"]);
});

test("byte-identical corpora carve nothing — no diff, nothing to carve", () => {
  const text = shard("T1", "queued");
  assert.equal(statusFlipOnlyTaskIds([text], [text]).size, 0);
});

test("same status value on both sides, some OTHER field differing, is not a flip at all and is never carved", () => {
  const oldText = shard("T1", "queued", '  title_extra: "a"');
  const newText = shard("T1", "queued", '  title_extra: "b"');
  assert.equal(statusFlipOnlyTaskIds([oldText], [newText]).size, 0);
});

test("a changed record missing a top-level status line is never carved", () => {
  const oldText = shard("T1", "queued").replace(/^  status: queued\n/m, "");
  const newText = shard("T1", "merged");
  assert.equal(statusFlipOnlyTaskIds([oldText], [newText]).size, 0);
});

test("a task absent at the base (newly filed) is never carved", () => {
  const carved = statusFlipOnlyTaskIds([shard("T1", "queued")], [shard("T1", "queued"), shard("T2", "merged")]);
  assert.equal(carved.size, 0);
});

test("a task removed entirely (absent at head) is never carved", () => {
  const carved = statusFlipOnlyTaskIds([shard("T1", "queued"), shard("T2", "queued")], [shard("T1", "queued")]);
  assert.equal(carved.size, 0);
});

test("in a multi-task corpus, only the genuinely flipped id is carved", () => {
  const oldText = shard("T1", "queued") + shard("T2", "queued") + shard("T3", "queued", '  title_extra: "a"');
  const newText = shard("T1", "queued") + shard("T2", "merged") + shard("T3", "merged", '  title_extra: "b"');
  // T1 untouched, T2 a pure flip (carved), T3 flip + edit (stays a full changed task).
  assert.deepEqual([...statusFlipOnlyTaskIds([oldText], [newText])], ["T2"]);
});

// ── STATUS_LINE_RE's own arms (test/negative-reachability-ratchet.test.ts, W1-T2317) ───────────

test("STATUS_LINE_RE's healthy arm: a real top-level status field, captures the value", () => {
  const m = STATUS_LINE_RE.exec("  status: merged");
  assert.ok(m !== null, "a genuine top-level status: line must match");
  assert.equal(m?.[2], "merged");
});

test("STATUS_LINE_RE's unhealthy arm: a status: line nested inside a prose block never matches", () => {
  // Four-space indent — exactly the shape a `design: |` block's own body carries (see the
  // fixtures above) — must NOT be mistaken for the record's own top-level `status:` field.
  const m = STATUS_LINE_RE.exec("    status: queued");
  assert.ok(m === null, "a nested status: line (wrong indent) must never match");
});

// ── (ii) the real --base path, over a committed fixture plan ───────────────────────────────────

/** Mirrors test/changed-tasks-raw-text.test.ts's own `runLintPlanBase` helper. */
async function runLintPlanBase(): Promise<{ exitCode: number; stdout: string }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (m: string) => logs.push(String(m));
  console.error = (m: string) => logs.push(String(m));
  console.warn = () => {};
  try {
    const exitCode = await lintPlanCommand(["--plan", FIXTURE_PLAN, "--base", "HEAD"]);
    return { exitCode, stdout: logs.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

function editShard(fileName: string, mutate: (original: string) => string): { restore: () => void; edited: string } {
  const path = join(FIXTURE_DIR, fileName);
  const original = readFileSync(path, "utf8");
  const edited = mutate(original);
  assert.notEqual(edited, original, `${fileName}: the probe's mutation must actually change the file`);
  writeFileSync(path, edited, "utf8");
  return { restore: () => writeFileSync(path, original, "utf8"), edited };
}

test("control: the fixture plan is clean vs HEAD before any scenario mutates it", async () => {
  const { stdout } = await runLintPlanBase();
  assert.match(stdout, /0 task\(s\) checked \(0 new\/changed vs HEAD\)/, "control: the fixture tree must be clean vs HEAD");
});

test("scenario A: a PURE status flip (queued -> merged) is carved, reported, and never fails the run", async () => {
  const { restore } = editShard("STATUS-FLIP-A-pure-flip.yaml", (t) => t.replace(/^  status: queued$/m, "  status: merged"));
  try {
    const { exitCode, stdout } = await runLintPlanBase();
    // NOT linted against the open-task rules: `checked` stays 0 for this diff, even though the
    // shard's own baked-in proof-dialect violation would fail it instantly if it ever reached
    // `lintTask` — a regression to a no-op carve would flip this assertion, not merely leave a
    // feature unexercised.
    assert.match(stdout, /0 task\(s\) checked \(0 new\/changed vs HEAD\)/, "a pure status-flip-only shard must not enter the checked/changed count");
    assert.doesNotMatch(stdout, /✗ STATUS-FLIP-A/, "a carved shard's violations must never print — it never reached lintTask");
    // STILL REPORT, NEVER SILENTLY SKIP (design point (iv)) — the id itself DOES appear, in the
    // carve note asserted right below; only its VIOLATIONS are suppressed.
    assert.match(stdout, /1 status-flip-only, excluded from --base scope: STATUS-FLIP-A/, "the carve must be NAMED in the summary");
    assert.equal(exitCode, 0, "a carved-only diff must not fail the run");
  } finally {
    restore();
  }
});

test("scenario B: a status flip ALONGSIDE a real field edit is linted in full and fails on its own violation", async () => {
  const { restore } = editShard("STATUS-FLIP-B-flip-plus-edit.yaml", (t) =>
    t.replace(/^  status: queued$/m, "  status: merged").replace(
      '      proof: "unit test: test/a-status-flip-is-not-a-task-edit.test.ts"',
      '      proof: "the existing suite passes unchanged, verified by hand"',
    ),
  );
  try {
    const { exitCode, stdout } = await runLintPlanBase();
    assert.match(stdout, /1 task\(s\) checked \(1 new\/changed vs HEAD\)/, "a flip riding alongside a real edit must stay fully in scope");
    assert.doesNotMatch(stdout, /status-flip-only/, "a real edit must earn no carve at all — the whole point of design point (ii)");
    assert.match(stdout, /STATUS-FLIP-B: 1 violation/, "the shard's own (newly introduced) proof-dialect violation must surface");
    assert.equal(exitCode, 1, "a genuinely changed task that fails lint must still fail the run");
  } finally {
    restore();
  }
});

test("scenario C (falsifier's second control): a flip to a still-OPEN status is linted in full and fails on its own violation", async () => {
  const { restore } = editShard("STATUS-FLIP-C-open-flip.yaml", (t) => t.replace(/^  status: queued$/m, "  status: recon"));
  try {
    const { exitCode, stdout } = await runLintPlanBase();
    assert.match(stdout, /1 task\(s\) checked \(1 new\/changed vs HEAD\)/, "a flip to an OPEN status must stay fully in scope");
    assert.doesNotMatch(stdout, /status-flip-only/, "an open-status flip must earn no carve — leaving the population is what matters, not the field");
    assert.match(stdout, /STATUS-FLIP-C: 1 violation/, "the shard's own pre-existing violation must still surface");
    assert.equal(exitCode, 1, "an open-status flip that fails lint must still fail the run");
  } finally {
    restore();
  }
});

test("scenario D: `lint-plan` with no --base is untouched by any of this (design point (v))", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (m: string) => logs.push(String(m));
  console.error = (m: string) => logs.push(String(m));
  try {
    const exitCode = await lintPlanCommand(["--plan", FIXTURE_PLAN]);
    // Whole-plan mode scopes by open status, not by any base diff — STATUS-FLIP-A/B/C are all
    // `status: queued` (open) in the committed fixture and are checked exactly as before.
    assert.ok(exitCode === 0 || exitCode === 1, `must reach a real verdict, got ${exitCode}`);
    assert.doesNotMatch(logs.join("\n"), /status-flip-only/, "the whole-plan pass must never mention the --base-only carve");
  } finally {
    console.log = origLog;
    console.error = origError;
  }
});
