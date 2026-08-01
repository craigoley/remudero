import assert from "node:assert/strict";
import test from "node:test";
import { lintTask, monolithFilingViolations } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// ── impl-DS: a NEW task id may not be filed into plan/tasks.yaml ──────────────────────────
//
// PR #1060 redirected `rmd triage` to propose a new task as its own plan/tasks.d/<id>-<slug>.yaml
// shard. But it is ONLY A PROMPT INSTRUCTION: decideTriage filters `!f.startsWith("plan/")`, so a
// shard passes AND so does a monolith append. Hand-filings and the plan/architect lanes are equally
// unconstrained. This is the rule the prompt only asked for.
//
// NOT a size emergency — the 1 MiB cliff is gone and the monolith stopped growing (+3,666 bytes on
// 07-30, ZERO on 07-31). The reason is CONSISTENCY: one storage convention the toolchain, the id
// minter and the conflict story can rely on.

function task(id: string): Task {
  return { id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto" } as never;
}

test("a NEW id filed into plan/tasks.yaml is FLAGGED, and the message names the shard remedy", () => {
  const v = monolithFilingViolations(task("W1-T900"), { newMonolithIds: new Set(["W1-T900"]) });

  assert.equal(v.length, 1);
  assert.equal(v[0].check, "monolith-filing");
  assert.equal(v[0].severity, "block", "retrofit cost is zero, so this blocks");
  assert.match(v[0].message, /plan\/tasks\.d\/W1-T900-<kebab-slug>\.yaml/, "the remedy names the exact path");
  assert.match(v[0].message, /remove the entry from the monolith/, "and says what to do with the old one");
});

test("a NEW id filed into a shard PASSES -- it never enters the monolith id set", () => {
  // The shard case reaches the linter with the same task object; what differs is that its id is
  // absent from plan/tasks.yaml, so the caller's set does not contain it.
  const v = monolithFilingViolations(task("W1-T900"), { newMonolithIds: new Set() });

  assert.deepEqual(v, []);
});

test("TRAP 1 LOCK: an EXISTING monolith id that is reformatted, renamed or moved does NOT trip", () => {
  // The check compares ID SETS, never diff lines. A reformat, a whitespace change, a retitle, or a
  // moved block leaves the monolith's id set identical, so none of them can produce a violation —
  // this is the false positive most likely to bite in practice.
  const existing = new Set<string>(); // nothing NEW to the monolith: the id was already there

  for (const id of ["W1-T1", "W1-T254", "W3-T6"]) {
    assert.deepEqual(
      monolithFilingViolations(task(id), { newMonolithIds: existing }),
      [],
      `${id} existed at base — editing it in place is not a filing`,
    );
  }
});

test("WHOLE-PLAN MODE IS SILENT: with no --base the check cannot run and does not fire", () => {
  // Chosen polarity, stated in the name: SILENT. "New" has no meaning without a base ref, so the
  // caller leaves newMonolithIds undefined. The CLI prints a skip note so a check that cannot run
  // never looks like a check that passed.
  assert.deepEqual(monolithFilingViolations(task("W1-T900"), {}), []);
  assert.deepEqual(monolithFilingViolations(task("W1-T900"), { newMonolithIds: undefined }), []);
});

test("the violation reaches lintTask, so lint-plan and the relint prompt both see it", () => {
  // Wiring, not logic: a check nothing calls is the defect this repo has hit eleven times.
  const result = lintTask(task("W1-T900"), { newMonolithIds: new Set(["W1-T900"]) });

  assert.ok(
    result.violations.some((v) => v.check === "monolith-filing"),
    "lintTask must surface it, not just monolithFilingViolations directly",
  );
  assert.equal(result.ok, false, "a blocking violation fails the lint");
});

test("severity is demotable to warn without touching the logic", () => {
  const v = monolithFilingViolations(task("W1-T900"), {
    newMonolithIds: new Set(["W1-T900"]),
    monolithFiling: "warn",
  });

  assert.equal(v[0].severity, "warn");
});

test("lint-plan without --base PRINTS the skip note, so a check that cannot run never looks passed", async () => {
  // Trap 1's other half. Silence would be worse than the check not existing: whole-plan is the mode
  // people run by hand, and a check that quietly does nothing there is one nobody notices is broken.
  const { lintPlanCommand } = await import("../src/run-task.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");

  // INSIDE the repo root on purpose: lintPlanCommand refuses a --plan that resolves outside it
  // (run-task.ts's repo-root identity guard), so a tmpdir fixture never reaches the check at all.
  const dir = mkdtempSync(join(process.cwd(), ".rmd-monolith-note-"));
  const said: string[] = [];
  const origLog = console.log;
  console.log = (m?: unknown) => void said.push(String(m));
  try {
    const planPath = join(dir, "tasks.yaml");
    writeFileSync(
      planPath,
      "- id: W1-T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: human\n",
    );
    await lintPlanCommand(["--plan", planPath]);
  } finally {
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(
    said.some((l) => /monolith-filing check is SKIPPED/.test(l)),
    `whole-plan mode must say the check was skipped; saw:\n${said.join("\n")}`,
  );
});
