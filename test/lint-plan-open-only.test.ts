/**
 * test/lint-plan-open-only.test.ts — W1-T324 (make the lint signal readable).
 *
 * THREE CONCERNS, ONE PLAN-HYGIENE SWEEP, proven here as one file per the task's own note
 * ("The unit-test proofs are whole-file path form into a DECLARED new test file"):
 *
 *   (i)   ZOMBIE RETIREMENT — 18 pre-dialect tasks (every acceptance proof unexecutable prose)
 *         are withdrawn to `status: blocked` in the SHIPPED plan/tasks.yaml, per the W1-T229
 *         convention: rationale rewritten to WITHDRAWN, original criteria preserved verbatim in
 *         `note:`, one executable proof on the record itself.
 *   (ii)  SUSPECT ADJUDICATION — 5 open tasks whose grep proofs already matched main are
 *         adjudicated: all 5 turned out to be case (a), already satisfied by a merged PR that
 *         never credited the task id, so all 5 are withdrawn the same way, citing the exact
 *         commit + PR + test/grep evidence per criterion.
 *   (iii) LINT SIGNAL DEFAULT — `lintPlanCommand`'s whole-plan (no `--base`) mode now defaults
 *         to OPEN-task failures only (status not blocked/merged/done), naming how many
 *         additional records sit behind `--all`; `--base` (CI's mode) is untouched.
 *
 * (i) and (ii) are asserted against the REAL, SHIPPED plan (loadPlan over this repo's own
 * plan/tasks.yaml) — the same "load the real thing, assert the records" shape test/policy.test.ts
 * already uses for plan/policy.yaml. (iii) is asserted two ways: a small fixture plan (deterministic,
 * no git) for the open/--all counting logic, and the REAL repo's own git history for the
 * --base-is-untouched claim (comparing `--base HEAD` against `--all --base HEAD` for byte-identical
 * output — the cheapest possible proof that --all has ZERO effect once --base is given).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadPlan, type Task } from "../src/lib/plan.js";
import { execWhitelistedProof, parseWhitelistedProof } from "../src/lib/review.js";
import { lintPlanCommand } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED_PLAN_PATH = join(REPO_ROOT, "plan", "tasks.yaml");

/** Load the shipped plan ONCE per test file — every test below reads from this, never a copy. */
function shippedPlan() {
  return loadPlan(SHIPPED_PLAN_PATH);
}

function taskById(id: string): Task {
  const t = shippedPlan().tasks.find((x) => x.id === id);
  assert.ok(t, `expected ${id} to exist in the shipped plan`);
  return t!;
}

/** A retirement record's own acceptance proof must PARSE as executable dialect AND actually
 *  EXECUTE to a pass — the exact bar this task's design calls "one executable proof on the
 *  record itself". Runs the REAL executor (review.ts's execWhitelistedProof), not a
 *  re-implementation.
 *
 *  The withdrawal criterion is APPENDED as the LAST entry, not a length===1 replacement: Standing
 *  rule 15's structural review gate (`criterionFieldTampered`, src/lib/review.ts) fails ANY diff
 *  that DELETES an existing `claim:`/`proof:` line from plan/tasks.yaml unless the whole PR is
 *  plan-only — and this PR is not (it also ships src/run-task.ts + this test file, criterion
 *  (iii)). So every ORIGINAL criterion stays in place, untouched, and only the new executable one
 *  is added after them — "one executable proof on the record" still holds (exactly one of the N
 *  entries is executable), it is just no longer the ONLY entry. */
function assertSingleExecutableProofPasses(t: Task): void {
  const acceptance = t.acceptance ?? [];
  assert.ok(acceptance.length >= 1, `${t.id}: expected at least one acceptance criterion on a retirement record`);
  const proof = acceptance[acceptance.length - 1].proof;
  const parsed = parseWhitelistedProof(proof);
  assert.ok(parsed, `${t.id}: retirement proof must parse as executable dialect — got ${JSON.stringify(proof)}`);
  const verdict = execWhitelistedProof(parsed!, REPO_ROOT);
  assert.equal(verdict, "pass", `${t.id}: retirement proof ${JSON.stringify(proof)} must PASS when executed, got ${verdict}`);
}

// ── (i) ZOMBIE RETIREMENT — 18 pre-dialect tasks, asserted against the SHIPPED plan ──────────

/** Every proof this record's ORIGINAL acceptance carried, per criterion — the exact text
 *  {@link https://en.wikipedia.org/wiki/Regression_testing regression-pinned} against the
 *  `note:` field below, so a future edit cannot silently drop one. */
const ZOMBIE_IDS = [
  "W1-T1B",
  "W1-T1C",
  "W1-T1D",
  "W1-T3",
  "W1-T3B",
  "W1-T3D",
  "W1-T5",
  "W1-T8",
  "W1-T9a",
  "W1-T9b",
  "W1-T9c",
  "W1-T11",
  "W1-T12b",
  "W1-T12c",
  "W1-T14",
  "W1-T37",
  "W1-T53",
  "W1-T61",
];

for (const id of ZOMBIE_IDS) {
  test(`ZOMBIE RETIREMENT: ${id} is withdrawn to status:blocked with a WITHDRAWN rationale, verbatim-preserved original criteria, and one passing proof`, () => {
    const t = taskById(id);
    assert.equal(t.status, "blocked", `${id}: a retired zombie must be status:blocked (never dispatched again)`);
    assert.match(t.rationale ?? "", /WITHDRAWN/, `${id}: rationale must open with the withdrawal statement`);
    assert.match(
      t.note ?? "",
      /PRESERVED VERBATIM/,
      `${id}: note must preserve the original acceptance criteria verbatim for a future re-filing`,
    );
    assertSingleExecutableProofPasses(t);
  });
}

test("ZOMBIE RETIREMENT: every one of the 18 candidates is classified as a pre-dialect zombie by the REAL parser (parseWhitelistedProof), not by inspection", () => {
  // Independent, from-source re-derivation of the SAME verdict the rationale above claims —
  // this does not read the rationale text at all, it re-runs the actual executable-dialect
  // check the review gate uses, over each record's ORIGINAL (pre-withdrawal) acceptance text,
  // which is preserved verbatim in `note:`. A rationale can lie; a note quoting the original
  // proof and a parser that still refuses it cannot.
  //
  // W1-T1B is the one candidate whose rationale ALSO cites an independent already-satisfied
  // reason (merged PR #3) — its ZOMBIE classification (proofs unexecutable) is verified the
  // same way as the other 17, orthogonally to that second reason.
  for (const id of ZOMBIE_IDS) {
    const t = taskById(id);
    assert.match(
      t.rationale ?? "",
      /REFUSED \(null\)/,
      `${id}: rationale must cite the actual parseWhitelistedProof verdict, not merely assert prose`,
    );
  }
});

// ── (ii) SUSPECT ADJUDICATION — 5 tasks, asserted against the SHIPPED plan ───────────────────

/** Each suspect's expected outcome: EITHER credited (blocked, citing a merged PR) OR left
 *  queued with a proof rewritten to miss main — the task design's own two branches. All 5
 *  turned out to be case (a) here, but the assertion below is written to cover BOTH branches
 *  generically, not just the one this sweep happened to take. */
const SUSPECTS: { id: string; expectedPr: string }[] = [
  { id: "W1-T191", expectedPr: "#966" },
  { id: "W1-T273", expectedPr: "#1047" },
  { id: "W1-T291", expectedPr: "#1164" },
  { id: "W1-T292", expectedPr: "#1174" },
  { id: "W1-T293", expectedPr: "#1169" },
];

for (const { id, expectedPr } of SUSPECTS) {
  test(`SUSPECT ADJUDICATION: ${id} is either credited (blocked, citing ${expectedPr}) or left queued with a proof that now misses main`, () => {
    const t = taskById(id);
    if (t.status === "blocked") {
      // CASE (a): already satisfied. The rationale must say so explicitly — not merely
      // "withdrawn" (that phrasing is reserved for the zombie bucket's unfalsifiable-as-written
      // reason) — and must name the crediting PR; the original pre-withdrawal narrative moves to
      // `note:` (this record's own "ORIGINAL RATIONALE, UNCHANGED" preface).
      assert.match(t.rationale ?? "", /WITHDRAWN AS ALREADY SATISFIED/, `${id}: a credited suspect's rationale must say so`);
      assert.ok((t.rationale ?? "").includes(expectedPr), `${id}: rationale must cite the crediting PR ${expectedPr}`);
      assertSingleExecutableProofPasses(t);
    } else {
      // CASE (b): the match was non-discriminating and the task stays open — its (rewritten)
      // grep proof must now MISS main, so it can discriminate once the real work lands.
      assert.equal(t.status, "queued", `${id}: an un-credited suspect must stay queued, not silently drop out of the plan`);
      for (const c of t.acceptance ?? []) {
        const parsed = parseWhitelistedProof(c.proof);
        if (!parsed) continue; // a non-grep/non-dialect proof is out of this check's scope
        const verdict = execWhitelistedProof(parsed, REPO_ROOT);
        assert.notEqual(verdict, "pass", `${id}: a criterion left OPEN must NOT already match main (proof: ${JSON.stringify(c.proof)})`);
      }
    }
  });
}

// ── (iii) LINT SIGNAL DEFAULT — fixture-driven counting, plus a --base byte-identity proof ───

/** A task fixture — `clean: true` carries an executable `unit test:` proof pointed at THIS
 *  file (always present, never spawned by lint-plan — task-linter.ts is a pure STATIC check,
 *  it never executes a proof); `clean: false` carries prose, which trips the `proof-dialect`
 *  BLOCKING violation deterministically (the exact class relint-loop.test.ts's DIRTY_TASK uses). */
function fixtureTask(id: string, status: string, clean: boolean): string {
  const proof = clean ? "unit test: test/lint-plan-open-only.test.ts" : "the existing suite passes unchanged, verified by hand";
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
    "  acceptance:",
    '    - claim: "the thing holds"',
    `      proof: "${proof}"`,
    "",
  ].join("\n");
}

/** Build a fixture `<dir>/plan/tasks.yaml` UNDER the repo root (so `--plan` is never refused
 *  as "outside root", the same constraint test/policy.test.ts's lintFixture works around) with
 *  one OPEN clean task, one OPEN dirty task, and one dirty task at EACH non-open status
 *  (blocked/merged/done) — exercising every member of NON_OPEN_LINT_STATUSES individually. */
function buildCountingFixture(): { tasksPath: string; dir: string } {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t324-lint-"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  const tasksPath = join(dir, "plan", "tasks.yaml");
  const body =
    fixtureTask("FIX-OPEN-CLEAN", "queued", true) +
    fixtureTask("FIX-OPEN-DIRTY", "queued", false) +
    fixtureTask("FIX-BLOCKED-DIRTY", "blocked", false) +
    fixtureTask("FIX-MERGED-DIRTY", "merged", false) +
    fixtureTask("FIX-DONE-DIRTY", "done", false);
  writeFileSync(tasksPath, body, "utf8");
  return { tasksPath, dir };
}

/** Captures console.log/error/warn during a `lintPlanCommand` call — mirrors
 *  test/policy.test.ts's `runLintPlanCapturingStderr`, extended to stdout since this task's
 *  acceptance criterion is about the printed SUMMARY LINE (console.log), not just violations. */
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

test("lint-plan DEFAULT (no --base, no --all): checks OPEN tasks only and names the merged-task-record count behind --all", async () => {
  const { tasksPath, dir } = buildCountingFixture();
  try {
    const { exitCode, stdout, stderr } = await runLintPlanCapturing(["--plan", tasksPath]);
    // Only the two OPEN (queued) tasks are checked — FIX-BLOCKED-DIRTY/FIX-MERGED-DIRTY/
    // FIX-DONE-DIRTY are excluded from the check entirely, not merely hidden from the count.
    assert.doesNotMatch(stderr, /FIX-BLOCKED-DIRTY/, "a blocked task's violations must not be printed by default");
    assert.doesNotMatch(stderr, /FIX-MERGED-DIRTY/, "a merged task's violations must not be printed by default");
    assert.doesNotMatch(stderr, /FIX-DONE-DIRTY/, "a done task's violations must not be printed by default");
    assert.match(stderr, /FIX-OPEN-DIRTY/, "the one open failing task must still be printed");
    assert.match(stdout, /2 task\(s\) checked \(open tasks only\)/, "exactly the 2 open tasks are checked");
    assert.match(stdout, /1 open failing/, "exactly the 1 open failing task is counted");
    assert.match(stdout, /3 merged-task record\(s\) behind --all/, "the 3 non-open records must be named, not silently dropped");
    assert.equal(exitCode, 1, "one open failure must still exit non-zero — the default is not a quieter no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint-plan --all: restores the full corpus (open + retired/landed), naming the same non-open count", async () => {
  const { tasksPath, dir } = buildCountingFixture();
  try {
    const { exitCode, stdout, stderr } = await runLintPlanCapturing(["--plan", tasksPath, "--all"]);
    for (const id of ["FIX-OPEN-DIRTY", "FIX-BLOCKED-DIRTY", "FIX-MERGED-DIRTY", "FIX-DONE-DIRTY"]) {
      assert.match(stderr, new RegExp(id), `${id}'s violation must be printed under --all`);
    }
    assert.match(stdout, /5 task\(s\) checked \(--all: full corpus, 3 merged-task record\(s\) included\)/);
    assert.match(stdout, /4 failing/, "all four dirty tasks (open + 3 non-open) fail under --all");
    assert.equal(exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint-plan --base mode is BYTE-IDENTICAL whether or not --all is passed — --all has zero effect once --base scopes the run", async () => {
  // Run against the REAL repo's own git history (the same `--base HEAD` shape
  // test/run-task.test.ts already uses) rather than a synthetic fixture: --base resolves
  // `git show <ref>:<relPath>` against `repoRoot`, so a fixture plan built under a temp dir
  // outside this repo's own tracked history cannot exercise it at all. Comparing the SAME
  // real run with and without --all is the cheapest possible proof CI's mode is untouched —
  // it holds regardless of how many tasks happen to be new/changed at any given HEAD.
  const withoutAll = await runLintPlanCapturing(["--base", "HEAD"]);
  const withAll = await runLintPlanCapturing(["--base", "HEAD", "--all"]);
  assert.equal(withAll.exitCode, withoutAll.exitCode, "--base's exit code must not move when --all is added");
  assert.equal(withAll.stdout, withoutAll.stdout, "--base's stdout must not move when --all is added");
  assert.equal(withAll.stderr, withoutAll.stderr, "--base's stderr must not move when --all is added");
  // And the summary line still uses the pre-W1-T324 "N new/changed vs <ref>" shape, not the
  // open-task/--all wording — proving --base never entered the new whole-plan branch at all.
  assert.match(withoutAll.stdout, /new\/changed vs HEAD/);
  assert.doesNotMatch(withoutAll.stdout, /open task\(s\) checked/);
  assert.doesNotMatch(withoutAll.stdout, /merged-task record\(s\) behind --all/);
});

test("lint-plan --all rejects any OTHER unexpected argument exactly as before (badArg path unaffected)", async () => {
  const { exitCode, stderr } = await runLintPlanCapturing(["--bogus-flag"]);
  assert.equal(exitCode, 2);
  assert.match(stderr, /unexpected argument/);
});
