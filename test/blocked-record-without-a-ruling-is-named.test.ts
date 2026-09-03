/**
 * test/blocked-record-without-a-ruling-is-named.test.ts — W1-T2634.
 *
 * `blockedDispositionViolations` (W1-T2487) only ever fires inside `lintPlanCommand`'s
 * changed-tasks (`--base`) pass, and even there only for a task the diff itself touches — by
 * design, so a blocking arm never wedges the standing population the way applying the retirement
 * ruling on #3305 wedged thirteen tombstones (W1-T2481). The consequence: the STANDING population
 * of `status: blocked` records that name no `retirement:` is invisible to every lint pass nobody's
 * PR happens to touch, and W1-T391, W1-T2474 and W1-T2481 each re-derived it BY HAND at three
 * different shas and got three different numbers (31/32, 46/50, 13 wedged).
 *
 * `blockedRecordUnruledViolations` (src/lib/task-linter.ts) closes that gap: it runs
 * UNCONDITIONALLY — no `opts`, no base-ref context — so it names the standing population in a
 * whole-plan `lintPlan` sweep too, not only inside a diff. This suite proves it against every one
 * of the task record's seven acceptance criteria, IN ORDER:
 *
 *   1. a blocked task carrying no retirement ruling is NAMED, measured over the LOADED plan
 *   2. a blocked task that carries a retirement ruling emits nothing
 *   3. the check NEVER blocks — a plan whose only violations are this class still reports ok
 *   4. a changed-tasks base pass over a blocked record carrying no ruling stays green
 *   5. a task whose status is not blocked emits nothing, whether or not it carries the field
 *   6. the check writes and infers nothing — no retirement value derived from prose or any signal
 *      other than the two structured fields
 *   7. deleting the check makes the population unnamed again — the report is doing the work
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadPlanFromYaml, RETIREMENT_REASONS, type Plan, type Task } from "../src/lib/plan.js";
import { blockedRecordUnruledViolations, lintPlan, lintTask, type BlockedDispositionContext } from "../src/lib/task-linter.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── shared fixtures (pure, in-memory — no I/O, mirrors every other suite in this file family) ──

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  } as never;
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as never;
}

// ── ACCEPTANCE 1: a blocked task carrying no retirement ruling is NAMED, measured over the ─────
// ── LOADED plan rather than over file text ──────────────────────────────────────────────────────

test("criterion 1a: a status:blocked task with no retirement, as a directly-loaded Task object, is named", () => {
  const t = task("W1-CENSUS-A", { status: "blocked" });
  const violations = blockedRecordUnruledViolations(t);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "blocked-record-unruled");
  assert.equal(violations[0]!.severity, "warn");
  assert.match(violations[0]!.message, /W1-CENSUS-A/, "the violation must name the task id");
  assert.match(violations[0]!.message, /retirement/);
});

test("criterion 1b: measured over the LOADED plan (loadPlanFromYaml's parsed Task objects), not raw text — a plan-level sweep names exactly the blocked+unruled ids", () => {
  const yaml = `
- id: W1-YAML-BLOCKED-NO-RULING
  title: "no ruling"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: blocked
  attempts: 0
- id: W1-YAML-BLOCKED-RULED
  title: "already ruled"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: blocked
  attempts: 0
  retirement: retired
- id: W1-YAML-QUEUED
  title: "not blocked at all"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: queued
  attempts: 0
`;
  const plan = loadPlanFromYaml(yaml, "test-fixture");
  const results = lintPlan(plan);
  const namedIds = new Set<string>();
  for (const [id, result] of results) {
    if (result.violations.some((v) => v.check === "blocked-record-unruled")) namedIds.add(id);
  }
  assert.deepEqual(
    [...namedIds],
    ["W1-YAML-BLOCKED-NO-RULING"],
    "only the blocked task that parsed with no `retirement:` may be named — this is asserted " +
      "against the PARSED plan (loadPlanFromYaml), never a grep over the yaml text",
  );
});

// ── ACCEPTANCE 2: a blocked task that carries a retirement ruling emits nothing ─────────────────

test("criterion 2: a blocked task naming any of the three legal RETIREMENT_REASONS emits zero violations", () => {
  assert.deepEqual([...RETIREMENT_REASONS], ["retired", "closed", "withdrawn"], "sanity: exactly three legal values, unchanged");
  for (const reason of RETIREMENT_REASONS) {
    const t = task("W1-RULED", { status: "blocked", retirement: reason } as Partial<Task>);
    assert.deepEqual(blockedRecordUnruledViolations(t), [], `retirement: ${reason} must pass with zero violations`);
  }
});

// ── ACCEPTANCE 3: the check NEVER blocks — a plan whose only violations are this class still ───
// ── reports ok ───────────────────────────────────────────────────────────────────────────────────

test("criterion 3: lintTask over a blocked, unruled record whose ONLY violation is this class still reports ok: true", () => {
  const t = task("W1-ONLY-CENSUS", {
    status: "blocked",
    files: ["test/blocked-record-without-a-ruling-is-named.test.ts"],
    origin: "architect",
    acceptance: [
      {
        claim: "the thing holds",
        proof: "unit test: test/blocked-record-without-a-ruling-is-named.test.ts",
      },
    ],
  } as Partial<Task>);
  const result = lintTask(t);
  const census = result.violations.filter((v) => v.check === "blocked-record-unruled");
  assert.equal(census.length, 1, "the census violation must actually be present");
  assert.equal(census[0]!.severity, "warn");
  assert.equal(result.ok, true, "a plan whose only violation is this class must never fail the gate");
});

// ── ACCEPTANCE 4: a changed-tasks base pass over a blocked record carrying no ruling stays green ─

test("criterion 4: lintTask with a --base-style blockedDisposition context, over a record already blocked before the diff, stays ok:true despite TWO warn-only violations naming the same fact", () => {
  const t = task("W1-BASE-PASS", {
    status: "blocked",
    files: ["test/blocked-record-without-a-ruling-is-named.test.ts"],
    origin: "architect",
    acceptance: [
      {
        claim: "the thing holds",
        proof: "unit test: test/blocked-record-without-a-ruling-is-named.test.ts",
      },
    ],
  } as Partial<Task>);
  // Mirrors lintPlanCommand's --base wiring: the record was ALSO status:blocked at the base ref,
  // so blockedDispositionViolations (W1-T2487) takes its warn arm, never its block arm.
  const ctx: BlockedDispositionContext = { baseTask: task("W1-BASE-PASS", { status: "blocked" }) };
  const result = lintTask(t, { blockedDisposition: ctx });
  const dispositionWarn = result.violations.filter((v) => v.check === "blocked-task-disposition");
  const censusWarn = result.violations.filter((v) => v.check === "blocked-record-unruled");
  assert.equal(dispositionWarn.length, 1);
  assert.equal(dispositionWarn[0]!.severity, "warn");
  assert.equal(censusWarn.length, 1);
  assert.equal(censusWarn[0]!.severity, "warn");
  assert.equal(result.ok, true, "a changed-tasks base pass over a standing blocked-unruled record must stay green");
});

// ── ACCEPTANCE 5: a task whose status is not blocked emits nothing, whether or not it carries ──
// ── the field ────────────────────────────────────────────────────────────────────────────────────

test("criterion 5: every non-blocked status emits nothing, with or without `retirement` set", () => {
  const nonBlockedStatuses = ["queued", "in_progress", "merged", "done"];
  for (const status of nonBlockedStatuses) {
    const bare = task(`W1-${status}-bare`, { status } as Partial<Task>);
    assert.deepEqual(blockedRecordUnruledViolations(bare), [], `status: ${status} with no retirement must emit nothing`);
    const withField = task(`W1-${status}-ruled`, { status, retirement: "retired" } as Partial<Task>);
    assert.deepEqual(blockedRecordUnruledViolations(withField), [], `status: ${status} carrying retirement must ALSO emit nothing`);
  }
});

// ── ACCEPTANCE 6: the check writes and infers nothing — no retirement value derived from prose ─
// ── or any signal other than the two structured fields ──────────────────────────────────────────

test("criterion 6a: a blocked task never mutates — the field stays exactly as given, read-only", () => {
  const t = task("W1-NO-WRITE", { status: "blocked" });
  assert.equal(t.retirement, undefined);
  blockedRecordUnruledViolations(t);
  assert.equal(t.retirement, undefined, "the check must never write, guess, or default the field");
});

test("criterion 6b: prose that reads exactly like a disposition (title/rationale/note) never suppresses or substitutes for the structured field", () => {
  for (const reason of RETIREMENT_REASONS) {
    const t = task("W1-PROSE-TRAP", {
      status: "blocked",
      title: `this task is ${reason} — see rationale`,
      rationale: `RULING: ${reason.toUpperCase()}. This record is ${reason} and should read as such.`,
      note: `${reason}`,
    } as Partial<Task>);
    const violations = blockedRecordUnruledViolations(t);
    assert.equal(
      violations.length,
      1,
      `prose containing the word '${reason}' must NOT suppress the violation — only the structured ` +
        "`retirement:` field may do that",
    );
    assert.equal(violations[0]!.severity, "warn");
  }
});

test("criterion 6c: no file under src/ infers `.retirement` from a lexicon or narrative match — grep, with a positive control proving the query is real", () => {
  // Same discipline test/a-blocked-task-must-name-its-disposition.test.ts's criterion 5b already
  // established for the sibling W1-T2487 check: this task's own gate must ASK the structured
  // field, never GUESS one from `note:`/`rationale:`/title prose.
  const pattern = "\\.retirement[[:space:]]*=[^=]";
  const run = (target: string): string => {
    try {
      return execFileSync("grep", ["-rn", "-E", "--include=*.ts", "--", pattern, target], { cwd: REPO_ROOT, encoding: "utf8" });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1) return e.stdout ?? ""; // grep exit 1 == "no matches" — the expected case
      throw err;
    }
  };

  const matches = run("src");
  assert.equal(
    matches.trim(),
    "",
    `no file under src/ may assign to '.retirement' — this task's own check must ASK, never WRITE:\n${matches}`,
  );

  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t2634-retirement-grep-control-"));
  try {
    writeFileSync(join(dir, "control.ts"), 'task.retirement = "retired";\n');
    const control = execFileSync("grep", ["-n", "-E", "--", pattern, join(dir, "control.ts")], { encoding: "utf8" });
    assert.match(control, /retirement = "retired"/, "the control fixture, which DOES write the field, must be caught by this same query");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 7: deleting the check makes the population unnamed again — the report is doing ──
// ── the work, not an unrelated pass ─────────────────────────────────────────────────────────────

test("criterion 7: over a mixed plan, ONLY blockedRecordUnruledViolations's own check-tag names the blocked-unruled population — no other check already does this job", () => {
  const tasks = [
    task("W1-MIX-UNRULED-1", {
      status: "blocked",
      files: ["test/blocked-record-without-a-ruling-is-named.test.ts"],
      acceptance: [{ claim: "c", proof: "unit test: test/blocked-record-without-a-ruling-is-named.test.ts" }],
    } as Partial<Task>),
    task("W1-MIX-UNRULED-2", {
      status: "blocked",
      files: ["test/blocked-record-without-a-ruling-is-named.test.ts"],
      acceptance: [{ claim: "c", proof: "unit test: test/blocked-record-without-a-ruling-is-named.test.ts" }],
    } as Partial<Task>),
    task("W1-MIX-RULED", {
      status: "blocked",
      retirement: "closed",
      files: ["test/blocked-record-without-a-ruling-is-named.test.ts"],
      acceptance: [{ claim: "c", proof: "unit test: test/blocked-record-without-a-ruling-is-named.test.ts" }],
    } as Partial<Task>),
    task("W1-MIX-QUEUED", {
      status: "queued",
      files: ["test/blocked-record-without-a-ruling-is-named.test.ts"],
      acceptance: [{ claim: "c", proof: "unit test: test/blocked-record-without-a-ruling-is-named.test.ts" }],
    } as Partial<Task>),
  ];
  const plan = planOf(tasks);
  const results = lintPlan(plan);

  // The real population, computed independently of any lint check at all — the ground truth
  // this task's rationale says nothing currently names.
  const truePopulation = new Set(
    plan.tasks.filter((t) => t.status === "blocked" && t.retirement === undefined).map((t) => t.id),
  );
  assert.deepEqual([...truePopulation].sort(), ["W1-MIX-UNRULED-1", "W1-MIX-UNRULED-2"]);

  // What `blocked-record-unruled` alone names, over the whole plan.
  const namedByThisCheck = new Set<string>();
  // What every OTHER check combined names (by task id) among violations that even mention
  // "retirement" or "disposition" — the only way an unrelated check could be doing this job.
  const namedByAnyOtherCheck = new Set<string>();
  for (const [id, result] of results) {
    for (const v of result.violations) {
      if (v.check === "blocked-record-unruled") {
        namedByThisCheck.add(id);
      } else if (/retirement|disposition/i.test(v.message)) {
        namedByAnyOtherCheck.add(id);
      }
    }
  }

  assert.deepEqual(namedByThisCheck, truePopulation, "blockedRecordUnruledViolations must name EXACTLY the real population");
  assert.deepEqual(
    [...namedByAnyOtherCheck],
    [],
    "no OTHER check may already report this population — if one did, deleting this check would " +
      "leave the population still named, and this task would not be closing a real gap",
  );

  // Simulate "deleting the check": recompute the same plan's violations with `lintTask` but drop
  // every violation this check contributed. The population is unnamed again — proving THIS
  // check, and nothing incidental, is what did the naming.
  const withoutThisCheck = new Set<string>();
  for (const t of plan.tasks) {
    const { violations } = lintTask(t);
    for (const v of violations) {
      if (v.check !== "blocked-record-unruled" && /retirement|disposition/i.test(v.message)) {
        withoutThisCheck.add(t.id);
      }
    }
  }
  assert.deepEqual([...withoutThisCheck], [], "with this check's own violations excluded, the population is unnamed again");
});
