/**
 * test/task-retirement-reason.test.ts — W1-T1287.
 *
 * `status: blocked` is the ONLY field a retired task (an operator ruling that it will never be
 * built) and a merely dependency-stalled one both carry — the only signal that separated them
 * was a `RETIRED (…)` / `CLOSED UNBUILT (…)` title-prefix convention that nothing in `src/` or
 * `test/` ever read. This file proves the sibling field this task adds (`Task.retirement`,
 * `src/lib/plan.ts`) and its one reader (`status-board.ts`'s new `retired` blocker class) satisfy
 * every one of the task record's six acceptance criteria, IN ORDER.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  assertRunnable,
  loadPlanFromYaml,
  PlanError,
  RETIREMENT_REASONS,
  TASK_STATUSES,
  unmetDependencies,
  type Plan,
  type Task,
} from "../src/lib/plan.js";
import { nextRunnable, tallyDispatchFilters } from "../src/lib/drain.js";
import { lintPlanCommand } from "../src/run-task.js";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── shared fixtures ──────────────────────────────────────────────────────────────────────────

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

const NONE_MERGED = () => false;

// ── ACCEPTANCE 1: the field round-trips through the parser ─────────────────────────────────────

test("criterion 1: a task carrying `retirement` parses with it preserved, and one omitting it parses with it undefined", () => {
  const yaml = `
- id: T-WITH
  title: with
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: blocked
  attempts: 0
  retirement: retired
- id: T-WITHOUT
  title: without
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: blocked
  attempts: 0
`;
  const plan = loadPlanFromYaml(yaml, "fixture");
  assert.equal(plan.byId.get("T-WITH")?.retirement, "retired", "the field is preserved, not silently dropped by the explicit key allowlist");
  assert.equal(plan.byId.get("T-WITHOUT")?.retirement, undefined, "an absent field parses as undefined, not defaulted");
});

// ── ACCEPTANCE 2: an unrecognised value is refused, fail-closed ────────────────────────────────

test("criterion 2: an unrecognised retirement value is REFUSED at load with a PlanError naming the field and the permitted values", () => {
  const yaml = `
- id: BAD
  title: bad
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: blocked
  attempts: 0
  retirement: not-a-real-reason
`;
  assert.throws(() => loadPlanFromYaml(yaml, "fixture"), PlanError);
  let message = "";
  try {
    loadPlanFromYaml(yaml, "fixture");
  } catch (err) {
    message = (err as Error).message;
  }
  assert.match(message, /retirement/, "the error must name the field");
  assert.match(message, /not-a-real-reason/, "the error must name the offending value");
  for (const permitted of RETIREMENT_REASONS) {
    assert.match(message, new RegExp(permitted), `the error must list '${permitted}' among the permitted values`);
  }
});

// ── ACCEPTANCE 3: blocked's exclusion is unaffected at all three enforcement points ────────────

test("criterion 3a: assertRunnable (plan.ts:448) throws identically for a blocked task with and without retirement", () => {
  const yaml = `
- id: A-WITH
  title: with
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: blocked
  attempts: 0
  retirement: closed
- id: A-WITHOUT
  title: without
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: blocked
  attempts: 0
`;
  const plan = loadPlanFromYaml(yaml, "fixture");
  const withT = plan.byId.get("A-WITH")!;
  const withoutT = plan.byId.get("A-WITHOUT")!;

  assert.throws(() => assertRunnable(plan, withT), PlanError);
  assert.throws(() => assertRunnable(plan, withoutT), PlanError);

  let msgWith = "";
  let msgWithout = "";
  try {
    assertRunnable(plan, withT);
  } catch (err) {
    msgWith = (err as Error).message;
  }
  try {
    assertRunnable(plan, withoutT);
  } catch (err) {
    msgWithout = (err as Error).message;
  }
  assert.equal(msgWith, "task A-WITH is blocked", "retirement must not change assertRunnable's blocked message");
  assert.equal(msgWithout, "task A-WITHOUT is blocked");
});

test("criterion 3b: isDispatchEligible (via nextRunnable/runnableCandidates' shared filter, drain.ts:510) excludes a blocked task identically with and without retirement", () => {
  const runnable = task("W1-T2000");
  const blockedWith = task("W1-T1000", { status: "blocked", retirement: "retired" } as Partial<Task>);
  const blockedWithout = task("W1-T1001", { status: "blocked" });
  const plan = planOf([blockedWith, blockedWithout, runnable]);

  const picked = nextRunnable(plan, NONE_MERGED);
  assert.equal(picked?.id, "W1-T2000", "neither blocked task — retirement or not — is ever offered as the next runnable task");

  const tally = tallyDispatchFilters();
  for (const t of plan.tasks) {
    nextRunnable(planOf([t]), NONE_MERGED, { onFiltered: tally.onFiltered });
  }
  const snapshot = tally.snapshot();
  // W1-T2474: the filter now SPLITS at this exact point — a blocked task carrying a
  // `retirement` ruling files under its own 'retired' reason, never under 'blocked', so the
  // two populations (deliberate record vs. dependency-stalled) stop being conflated in the
  // tally an idle daemon reads. See test/a-retired-task-is-not-a-recoverable-blocker.test.ts
  // for the full split's coverage; this test only needed updating to stop asserting the old
  // conflated shape.
  assert.ok(snapshot.retired.ids.includes("W1-T1000"), "the retired task now files under its own 'retired' filter reason");
  assert.ok(!snapshot.blocked.ids.includes("W1-T1000"), "the retired task no longer files under 'blocked'");
  assert.ok(snapshot.blocked.ids.includes("W1-T1001"), "the plain blocked task (no retirement) still files under 'blocked', unchanged");
});

/** Captures console.log/error/warn during a `lintPlanCommand` call — mirrors
 *  test/lint-plan-open-only.test.ts's own helper. */
async function runLintPlanCapturing(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (m: string) => logs.push(m);
  console.error = (m: string) => errors.push(m);
  console.warn = () => {};
  try {
    const exitCode = await lintPlanCommand(args);
    return { exitCode, stdout: logs.join("\n"), stderr: errors.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

/** Mirrors test/lint-plan-open-only.test.ts's `fixtureTask` exactly, plus an `extra` line so a
 *  retirement field can be appended without disturbing the rest of the shape that check relies on. */
function fixtureTask(id: string, status: string, clean: boolean, extra = ""): string {
  const proof = clean ? "unit test: test/task-retirement-reason.test.ts" : "the existing suite passes unchanged, verified by hand";
  return [
    `- id: ${id}`,
    `  title: "fixture task ${id}"`,
    "  repo: remudero",
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    `  status: ${status}`,
    "  attempts: 0",
    "  files: [test/task-retirement-reason.test.ts]",
    "  acceptance:",
    '    - claim: "the thing holds"',
    `      proof: "${proof}"`,
    extra,
    "",
  ].join("\n");
}

test("criterion 3c: isOpenLintTask (run-task.ts, NON_OPEN_LINT_STATUSES) excludes a blocked+retirement task exactly like a plain blocked task", async () => {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t1287-lint-"));
  try {
    mkdirSync(join(dir, "plan"), { recursive: true });
    const tasksPath = join(dir, "plan", "tasks.yaml");
    const body =
      fixtureTask("FIX-OPEN", "queued", true) +
      fixtureTask("FIX-BLOCKED-RETIRED", "blocked", false, "  retirement: retired") +
      fixtureTask("FIX-BLOCKED-PLAIN", "blocked", false);
    writeFileSync(tasksPath, body, "utf8");

    const { exitCode, stdout, stderr } = await runLintPlanCapturing(["--plan", tasksPath]);
    assert.doesNotMatch(stderr, /FIX-BLOCKED-RETIRED/, "a retired blocked task's violations must not print under the default open-only mode");
    assert.doesNotMatch(stderr, /FIX-BLOCKED-PLAIN/, "a plain blocked task's violations must not print either — unchanged baseline");
    assert.match(stdout, /1 task\(s\) checked \(open tasks only\)/, "only the one open task is checked");
    assert.match(stdout, /2 merged-task record\(s\) behind --all/, "both non-open records are named, not silently dropped");
    assert.equal(exitCode, 0, "no open failures ⇒ clean exit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 4: status-board renders a retired task as its own blocker class ─────────────────

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "status-board-retirement-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function writeLedger(lines: Record<string, unknown>[]): string {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "status-board-retirement-ledger-")), "ledger.ndjson");
  writeFileSync(ledgerPath, lines.length ? lines.map((l) => JSON.stringify(l)).join("\n") + "\n" : "");
  return ledgerPath;
}

const NOW_MS = Date.parse("2026-08-24T00:00:00.000Z");

function baseDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    ...overrides,
  };
}

test("criterion 4: a retired blocked task renders as its own 'retired' blocker class naming the recorded reason; a plain blocked task renders exactly as it does today (no row at all)", () => {
  const yaml = `
- id: W1-T2200
  title: retired one
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: blocked
  attempts: 0
  retirement: closed
- id: W1-T2201
  title: plain blocked
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: blocked
  attempts: 0
`;
  const plan = loadPlanFromYaml(yaml, "fixture");
  const ledgerPath = writeLedger([]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan }));

  const retiredRows = model.blockers.rows.filter((r) => r.kind === "retired");
  assert.equal(retiredRows.length, 1, "exactly the retired task gets a 'retired' row");
  assert.equal(retiredRows[0]!.taskId, "W1-T2200");
  if (retiredRows[0]!.kind === "retired") {
    assert.match(retiredRows[0]!.reason, /closed/i, "the row names the recorded reason");
  }
  assert.ok(
    !model.blockers.rows.some((r) => r.kind === "retired" && r.taskId === "W1-T2201"),
    "a blocked task without retirement contributes no row — unchanged from before this field existed",
  );
  assert.equal(model.blockers.rows.length, 1, "no other blocker class fires for either plain-plan-declared blocked task");

  const text = renderStatusBoardText(model);
  assert.match(text, /retired\s+: W1-T2200 — .*closed/i);
  assert.doesNotMatch(text, /W1-T2201/);
});

// ── ACCEPTANCE 5: no enum growth, nothing retired can be credited as shipped ───────────────────

test("criterion 5: TASK_STATUSES gains no member, and a retired blocked task is never credited as merged (MERGED_STATUSES unchanged)", () => {
  assert.deepEqual(
    [...TASK_STATUSES],
    ["queued", "recon", "prompted", "running", "review", "fixing", "diagnosing", "blocked", "merged", "done"],
    "TASK_STATUSES must be byte-identical to before this task — no new member",
  );
  for (const reason of RETIREMENT_REASONS) {
    assert.ok(!(TASK_STATUSES as readonly string[]).includes(reason), `'${reason}' must not have become a TASK_STATUSES member`);
  }

  const yaml = `
- id: RETIRED-DEP
  title: retired dep
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  status: blocked
  attempts: 0
  retirement: retired
- id: DEPENDENT
  title: dependent
  repo: remudero
  depends_on: [RETIRED-DEP]
  type: implement
  verify: auto
  status: queued
  attempts: 0
`;
  const plan = loadPlanFromYaml(yaml, "fixture");
  assert.deepEqual(
    unmetDependencies(plan, plan.byId.get("DEPENDENT")!),
    ["RETIRED-DEP"],
    "a retired blocked task is NOT counted as merged — no retirement can be credited as shipped",
  );
});

// ── ACCEPTANCE 6: nothing writes the field automatically ───────────────────────────────────────

test("criterion 6: no code path in src/ writes the retirement field — it is set only in the plan record, by an operator", () => {
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
  assert.equal(matches.trim(), "", `no file under src/ may assign to '.retirement' — a writer would violate the operator-only invariant:\n${matches}`);

  // POSITIVE CONTROL: the same query, against a fixture that DOES assign it, must find it — proving
  // the grep above is a real check and not silently vacuous.
  const dir = mkdtempSync(join(tmpdir(), "rmd-retirement-grep-control-"));
  try {
    writeFileSync(join(dir, "control.ts"), 'task.retirement = "retired";\n');
    const control = execFileSync("grep", ["-n", "-E", "--", pattern, join(dir, "control.ts")], { encoding: "utf8" });
    assert.match(control, /retirement = "retired"/, "the control fixture, which DOES write the field, must be caught by this same query");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
