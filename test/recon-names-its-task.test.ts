import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderReconPrompt, workerVisibleRecordPath } from "../src/run-task.js";
import { taskRecordPath } from "../src/lib/plan.js";

/**
 * W1-T2632 — RECON IS NOW TOLD WHICH TASK IT IS RECONNING.
 *
 * Before this, `renderReconPrompt` took only a plan index and an operator-notes block — no task
 * id, no title, no record path — so a recon faithfully ran `git remote -v` / `git log` / `ls` and
 * reported repo state with zero task content, while the sibling read-only rung
 * `renderDiagnosePrompt` one screen away already emitted `TASK: ${task.id} — ${task.title}`.
 *
 * These are pure unit tests of `renderReconPrompt` plus the SAME `taskRecordPath` /
 * `workerVisibleRecordPath` pipeline the real call site now hoists above the recon spawn — never
 * a second, hand-rolled anchoring rule. `test/recon-mount-routing.test.ts` separately anchors the
 * real call site's argument list (repaired in the same diff as this file, per the task's own
 * design note (v)); this file only proves the RENDERED BEHAVIOUR.
 */

const TASK = { id: "W1-T9001", title: "a task recon is now told about" };

test("the recon prompt names the task it is reconning", () => {
  const prompt = renderReconPrompt("(plan index)", "", TASK, undefined);
  assert.match(
    prompt,
    /TASK: W1-T9001 — a task recon is now told about/,
    "the task id and title must both appear, together, the same shape renderDiagnosePrompt already uses",
  );
});

test("the recon prompt points at the task record path", () => {
  const prompt = renderReconPrompt("(plan index)", "", TASK, "plan/tasks.d/W1-T9001-fixture.yaml");
  assert.ok(
    prompt.includes("plan/tasks.d/W1-T9001-fixture.yaml"),
    "the resolved worker-visible record path must be named in the prompt",
  );
  assert.match(prompt, /READ IT FIRST|one `Read` away/, "the pointer must invite the worker to open it");
});

test("a sharded task record path is the shard not the monolith", () => {
  const dir = mktempPlanDir();
  try {
    const planPath = join(dir, "tasks.yaml");
    // The monolith carries an UNRELATED task; W1-T9002 lives only in the shard — exactly the
    // shape the task's own filing (this very task, W1-T2632) is filed under.
    writeFileSync(planPath, minimalTaskYaml("W1-T0001", "unrelated monolith task"));
    mkdirSync(join(dir, "tasks.d"), { recursive: true });
    writeFileSync(join(dir, "tasks.d", "W1-T9002-shard.yaml"), minimalTaskYaml("W1-T9002", "a sharded task"));

    const resolved = taskRecordPath(planPath, "W1-T9002");
    assert.equal(resolved, join(dir, "tasks.d", "W1-T9002-shard.yaml"), "taskRecordPath must resolve the shard file");

    const recordPath = workerVisibleRecordPath(planPath, resolved);
    assert.ok(
      recordPath?.endsWith(join("tasks.d", "W1-T9002-shard.yaml")),
      `the worker-visible record path must be the shard, got ${recordPath}`,
    );
    assert.ok(!recordPath?.endsWith("tasks.yaml"), "the worker-visible record path must never be the monolith");

    const prompt = renderReconPrompt("", "", { id: "W1-T9002", title: "a sharded task" }, recordPath);
    assert.ok(prompt.includes("tasks.d"), "the rendered prompt must name the shard, under tasks.d");
    assert.ok(prompt.includes("W1-T9002-shard.yaml"), "and must name the shard file itself");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unresolvable record path omits the pointer", () => {
  // `taskRecordPath`/`workerVisibleRecordPath` are fail-soft and return `undefined` for an
  // unreadable plan file or an id nowhere in the merged view — the recon call site passes that
  // `undefined` straight through, never a guessed or invented path.
  const prompt = renderReconPrompt("(plan index)", "", TASK, undefined);
  assert.ok(
    !prompt.includes("YOUR TASK'S OWN RECORD IS AT"),
    "an unresolvable record path must omit the pointer line entirely",
  );
  // Still runs: the task line and the fixed recon instructions are both present regardless.
  assert.match(prompt, /TASK: W1-T9001/, "the recon still runs and still names the task");
  assert.match(prompt, /^You are a RECON worker\./, "the fixed recon instructions are unaffected");
});

test("the record is named never inlined into the recon prompt", () => {
  const dir = mktempPlanDir();
  try {
    const planPath = join(dir, "tasks.yaml");
    const uniqueDesignText = "THIS-DESIGN-PROSE-MUST-NEVER-REACH-THE-RECON-PROMPT-VERBATIM";
    writeFileSync(
      planPath,
      minimalTaskYaml("W1-T9003", "a task with a design body", `  design: |\n    ${uniqueDesignText}\n`),
    );

    const resolved = taskRecordPath(planPath, "W1-T9003");
    const recordPath = workerVisibleRecordPath(planPath, resolved);
    const prompt = renderReconPrompt("", "", { id: "W1-T9003", title: "a task with a design body" }, recordPath);

    assert.ok(prompt.includes(String(recordPath)), "the prompt must name the record's path");
    assert.ok(
      !prompt.includes(uniqueDesignText),
      "the record's own content (design prose) must never be copied into the recon prompt — pointer, not payload",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-existing callers with no task argument render exactly as before — no TASK line, no pointer", () => {
  const withIndexOnly = renderReconPrompt("(plan index)");
  assert.ok(!withIndexOnly.includes("TASK:"), "no task argument ⇒ no TASK line");
  assert.ok(!withIndexOnly.includes("YOUR TASK'S OWN RECORD IS AT"), "and no record pointer either");

  const withNotesToo = renderReconPrompt("(plan index)", "(operator notes)");
  assert.ok(!withNotesToo.includes("TASK:"), "same with an operator-notes block supplied");
});

function mktempPlanDir(): string {
  return mkdtempSync(join(tmpdir(), "recon-names-its-task-"));
}

/** The minimal shape `parseTasksFromYaml` accepts — id/title/repo/type are all `req()`uired. */
function minimalTaskYaml(id: string, title: string, extra = ""): string {
  return `- id: ${id}\n  title: "${title}"\n  repo: remudero\n  type: implement\n${extra}`;
}
