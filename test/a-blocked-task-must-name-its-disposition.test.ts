/**
 * test/a-blocked-task-must-name-its-disposition.test.ts — W1-T2487.
 *
 * Fifty tasks on main carry `status: blocked`; twenty-six of them name no `retirement:` at all,
 * and nothing before this task ever asked one to. W1-T2474 made the field LOAD-BEARING — drain
 * now splits a retired task out of the recoverable-blocker class by reading it — so a consumer
 * reading a field absent on more than half its population is no longer classifying, it is
 * defaulting.
 *
 * This suite proves `blockedDispositionViolations` (src/lib/task-linter.ts) and its wiring into
 * `lintPlanCommand`'s changed-tasks pass (src/run-task.ts), against every one of the task
 * record's eight acceptance criteria, IN ORDER:
 *
 *   1. a task the diff moves into blocked with no disposition is refused
 *   2. the refusal names the three legal values
 *   3. a task moved into blocked that already names one passes
 *   4. a task already blocked before the diff is reported and never refused
 *   5. nothing on this path writes or infers a disposition
 *   6. the refusal reaches lint-plan's exit code
 *   7. a value outside RETIREMENT_REASONS is refused rather than accepted as present
 *   8. removing the transition scoping makes the standing population fail the gate
 *
 * Two registers, mirroring test/task-retirement-reason.test.ts and
 * test/base-lint-attributes-pre-existing-violations.test.ts: the pure `blockedDispositionViolations`
 * function is exercised directly (deterministic, no I/O) for criteria that are about the
 * PREDICATE's own shape, and the real `lintPlanCommand` is driven over REAL, UNREACHABLE git
 * commits (the same `commit-tree` fixture recipe base-lint-attributes-pre-existing-violations.test.ts
 * uses) for the criteria that are about what actually happens end-to-end on a PR's diff.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { RETIREMENT_REASONS, type Task } from "../src/lib/plan.js";
import { blockedDispositionViolations, type BlockedDispositionContext } from "../src/lib/task-linter.js";
import { lintPlanCommand } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── shared fixtures (pure, in-memory) ───────────────────────────────────────────────────────────

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

// ── ACCEPTANCE 1 & 6: a task the diff moves into blocked with no disposition is refused, and ───
// ── the refusal reaches lint-plan's exit code ───────────────────────────────────────────────────

/** The fixture's OWN committer — mirrors test/base-lint-attributes-pre-existing-violations.test.ts
 *  (`commit-tree` refuses with "Author identity unknown" on a runner with no repo/global config). */
const FIXTURE_IDENTITY = { name: "remudero test fixture", email: "fixture@remudero.invalid" };

function git(args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    env: { ...process.env, ...env },
  }).trim();
}

/** An UNREACHABLE commit whose tree is HEAD's plus one planted blob — mirrors
 *  test/base-lint-attributes-pre-existing-violations.test.ts's `baseCommitWithBlob` exactly. */
function baseCommitWithBlob(relPath: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t2487-base-"));
  try {
    const indexFile = join(dir, "index");
    const env = { GIT_INDEX_FILE: indexFile };
    git(["read-tree", "HEAD"], env);
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: content,
    }).trim();
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${relPath}`], env);
    const tree = git(["write-tree"], env);
    const identityEnv = {
      GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
    };
    const sha = git(["commit-tree", tree, "-p", "HEAD", "-m", "planted: W1-T2487 base fixture"], identityEnv);
    assert.match(sha, /^[0-9a-f]{40}$/, "commit-tree must return a real commit sha");
    return sha;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixturePlanPaths(): { dir: string; planPath: string; relPath: string } {
  const dir = mkdtempSync(join(REPO_ROOT, ".rmd-w1-t2487-fixture-"));
  const planPath = join(dir, "tasks.yaml");
  const relPath = relative(REPO_ROOT, planPath);
  return { dir, planPath, relPath };
}

function captureConsole(): { errLines: string[]; logLines: string[]; restore: () => void } {
  const errLines: string[] = [];
  const logLines: string[] = [];
  const origError = console.error;
  const origWarn = console.warn;
  const origLog = console.log;
  console.error = (...a: unknown[]) => void errLines.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void errLines.push(a.map(String).join(" "));
  console.log = (...a: unknown[]) => void logLines.push(a.map(String).join(" "));
  return {
    errLines,
    logLines,
    restore: () => {
      console.error = origError;
      console.warn = origWarn;
      console.log = origLog;
    },
  };
}

/** A single fixture task record, its `status:`/`retirement:` fully controlled by the caller. A
 *  clean, resolvable proof so the ONLY blocking violation any of these fixtures can ever carry
 *  is the one this task adds — no incidental proof-shape/proof-dialect noise. */
function fixtureTask(id: string, status: string, retirement?: string): string {
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
    "  files: [test/a-blocked-task-must-name-its-disposition.test.ts]",
    "  acceptance:",
    '    - claim: "the thing holds"',
    '      proof: "unit test: test/a-blocked-task-must-name-its-disposition.test.ts"',
    ...(retirement !== undefined ? [`  retirement: ${retirement}`] : []),
    "",
  ].join("\n");
}

test("criterion 1 & 6: a task the diff moves into blocked with no disposition is refused, and the refusal reaches lint-plan's exit code", async () => {
  const { dir, planPath, relPath } = fixturePlanPaths();
  try {
    const base = baseCommitWithBlob(relPath, fixtureTask("ZZ-NEWLY-BLOCKED", "queued"));
    writeFileSync(planPath, fixtureTask("ZZ-NEWLY-BLOCKED", "blocked"), "utf8");

    const cap = captureConsole();
    let code: number;
    try {
      code = await lintPlanCommand(["--plan", planPath, "--base", base]);
    } finally {
      cap.restore();
    }

    assert.equal(code, 1, "a task the diff moves into blocked with no disposition must fail the run");
    const line = cap.errLines.find((l) => l.includes("[blocked-task-disposition]") && l.includes("ZZ-NEWLY-BLOCKED"));
    assert.ok(line, `must report the refusal; stderr was ${JSON.stringify(cap.errLines)}`);
    assert.match(line!, /moves to status: blocked in this PR/, "the message must name the transition, not merely 'blocked'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 2: the refusal names the three legal values ─────────────────────────────────────

test("criterion 2: the refusal names the three legal RETIREMENT_REASONS values", () => {
  assert.deepEqual([...RETIREMENT_REASONS], ["retired", "closed", "withdrawn"], "sanity: exactly three legal values, unchanged");
  const t = task("W1-X", { status: "blocked" });
  const ctx: BlockedDispositionContext = { baseTask: task("W1-X", { status: "queued" }) };
  const violations = blockedDispositionViolations(t, { blockedDisposition: ctx });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.severity, "block");
  for (const reason of RETIREMENT_REASONS) {
    assert.match(violations[0]!.message, new RegExp(reason), `the refusal must name '${reason}' among the legal values`);
  }
});

// ── ACCEPTANCE 3: a task moved into blocked that already names one passes ──────────────────────

test("criterion 3: a task moved into blocked that already names a legal disposition passes silently", () => {
  for (const reason of RETIREMENT_REASONS) {
    const t = task("W1-Y", { status: "blocked", retirement: reason } as Partial<Task>);
    const ctx: BlockedDispositionContext = { baseTask: task("W1-Y", { status: "queued" }) };
    const violations = blockedDispositionViolations(t, { blockedDisposition: ctx });
    assert.deepEqual(violations, [], `'${reason}' must pass with zero violations`);
  }
});

test("criterion 3 (end-to-end): a diff that moves a task into blocked AND names its disposition exits 0", async () => {
  const { dir, planPath, relPath } = fixturePlanPaths();
  try {
    const base = baseCommitWithBlob(relPath, fixtureTask("ZZ-RETIRED-NOW", "queued"));
    writeFileSync(planPath, fixtureTask("ZZ-RETIRED-NOW", "blocked", "retired"), "utf8");

    const cap = captureConsole();
    let code: number;
    try {
      code = await lintPlanCommand(["--plan", planPath, "--base", base]);
    } finally {
      cap.restore();
    }

    assert.equal(code, 0, "a disposition-naming transition into blocked must not fail the run");
    assert.ok(
      cap.errLines.every((l) => !l.includes("blocked-task-disposition")),
      "no blocked-task-disposition violation of any severity should fire at all",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 4: a task already blocked before the diff is reported and never refused ──────────

test("criterion 4: a task already status: blocked at the base ref, with no retirement, is reported (warn) and never refused (block)", () => {
  const t = task("W1-STANDING", { status: "blocked" });
  const ctx: BlockedDispositionContext = { baseTask: task("W1-STANDING", { status: "blocked" }) };
  const violations = blockedDispositionViolations(t, { blockedDisposition: ctx });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.severity, "warn", "the standing population must never be BLOCKED, only reported");
  assert.match(violations[0]!.message, /already blocked before this PR/);
});

test("criterion 4 (end-to-end): a diff that merely TOUCHES a standing blocked task (unrelated prose edit) still exits 0", async () => {
  const { dir, planPath, relPath } = fixturePlanPaths();
  try {
    const base = baseCommitWithBlob(relPath, fixtureTask("ZZ-STANDING", "blocked"));
    // The diff: the task was ALREADY blocked at base, and stays blocked — no retirement either
    // side, only the title text differs (a one-word unrelated edit, mirroring
    // test/base-lint-attributes-pre-existing-violations.test.ts's own "diff merely touches" shape).
    writeFileSync(
      planPath,
      fixtureTask("ZZ-STANDING", "blocked").replace("fixture task ZZ-STANDING", "fixture task ZZ-STANDING, edited"),
      "utf8",
    );

    const cap = captureConsole();
    let code: number;
    try {
      code = await lintPlanCommand(["--plan", planPath, "--base", base]);
    } finally {
      cap.restore();
    }

    assert.equal(code, 0, "the standing population must never fail the gate merely by being touched");
    const warnLine = cap.errLines.find((l) => l.includes("[blocked-task-disposition]") && l.includes("ZZ-STANDING"));
    assert.ok(warnLine, `the standing task must still be REPORTED; stderr was ${JSON.stringify(cap.errLines)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("criterion 4 (whole-plan pass): with no --base at all, the standing population is silent — no report, no refusal", async () => {
  const { dir, planPath } = fixturePlanPaths();
  try {
    writeFileSync(planPath, fixtureTask("ZZ-WHOLE-PLAN", "blocked"), "utf8");

    const cap = captureConsole();
    let code: number;
    try {
      code = await lintPlanCommand(["--plan", planPath]);
    } finally {
      cap.restore();
    }

    assert.equal(code, 0, "the whole-plan pass must never refuse the standing population");
    assert.ok(
      cap.errLines.every((l) => !l.includes("blocked-task-disposition")),
      "the check must be entirely silent absent a --base to compare against",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 5: nothing on this path writes or infers a disposition ──────────────────────────

test("criterion 5a: calling the check never mutates the task it is given — the field is read-only here", () => {
  const t = task("W1-NOWRITE", { status: "blocked" });
  const ctx: BlockedDispositionContext = { baseTask: task("W1-NOWRITE", { status: "queued" }) };
  assert.equal(t.retirement, undefined);
  blockedDispositionViolations(t, { blockedDisposition: ctx });
  assert.equal(t.retirement, undefined, "the check must never write, guess, or default the field");
});

test("criterion 5b: no file under src/ assigns to `.retirement` — grep, with a positive control proving the query is real", () => {
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
    `no file under src/ may assign to '.retirement' — this task's own gate must ASK, never WRITE:\n${matches}`,
  );

  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t2487-retirement-grep-control-"));
  try {
    writeFileSync(join(dir, "control.ts"), 'task.retirement = "retired";\n');
    const control = execFileSync("grep", ["-n", "-E", "--", pattern, join(dir, "control.ts")], { encoding: "utf8" });
    assert.match(control, /retirement = "retired"/, "the control fixture, which DOES write the field, must be caught by this same query");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 7: a value outside RETIREMENT_REASONS is refused rather than accepted as present ──

test("criterion 7: a bogus retirement value is treated as ABSENT (present-but-illegal is not 'present') and refused on transition", () => {
  // plan.ts's own parser already throws PlanError on this at load time (test/task-retirement-reason.test.ts
  // criterion 2) — this exercises a Task object built directly, the only way an illegal value can
  // ever reach this predicate, and asserts it is never mistaken for a legal disposition.
  const t = task("W1-BOGUS", { status: "blocked", retirement: "not-a-real-reason" } as unknown as Partial<Task>);
  const ctx: BlockedDispositionContext = { baseTask: task("W1-BOGUS", { status: "queued" }) };
  const violations = blockedDispositionViolations(t, { blockedDisposition: ctx });
  assert.equal(violations.length, 1, "an illegal value must not short-circuit the check as though a real disposition were named");
  assert.equal(violations[0]!.severity, "block");
  for (const reason of RETIREMENT_REASONS) {
    assert.match(violations[0]!.message, new RegExp(reason));
  }
});

// ── ACCEPTANCE 8: removing the transition scoping makes the standing population fail the gate ──

test("criterion 8: the SAME standing-population task (already blocked, no retirement) is WARNED with the base-transition context supplied, but would BLOCK if that scoping were removed", () => {
  const t = task("W1-SCOPED", { status: "blocked" });

  // WITH the transition scoping: the caller supplies the base-ref task, and it was ALSO blocked
  // there — the standing population is correctly identified and only reported.
  const scoped: BlockedDispositionContext = { baseTask: task("W1-SCOPED", { status: "blocked" }) };
  const withScoping = blockedDispositionViolations(t, { blockedDisposition: scoped });
  assert.equal(withScoping.length, 1);
  assert.equal(withScoping[0]!.severity, "warn", "correctly scoped, the standing population must only be reported");

  // WITHOUT it: the exact same task, but the caller no longer resolves/supplies which base-ref
  // state it came from (`baseTask` omitted) — indistinguishable, from this check's point of view,
  // from a task filed straight into blocked. This is the failure mode the transition scoping
  // exists to prevent: an UNSCOPED gate would treat every standing-population task as newly
  // blocked and refuse it outright.
  const unscoped: BlockedDispositionContext = {};
  const withoutScoping = blockedDispositionViolations(t, { blockedDisposition: unscoped });
  assert.equal(withoutScoping.length, 1);
  assert.equal(
    withoutScoping[0]!.severity,
    "block",
    "removing the transition scoping must make the standing population FAIL the gate — proving the scoping is load-bearing, not decorative",
  );
});
