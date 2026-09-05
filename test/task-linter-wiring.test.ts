import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTask, lintPlanCommand } from "../src/run-task.js";
import { assertLintClean } from "../src/lib/task-linter.js";
import { loadPlan } from "../src/lib/plan.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { spawnWorker } from "../src/lib/worker.js";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── §5C Layer A pre-dispatch guard is WIRED into the run path (W1-T20c) ───────

test("the run path INVOKES assertLintClean right after assertRunnable (the pre-dispatch guard is wired, not just implemented)", () => {
  assert.match(runTaskSrc, /assertLintClean\(/, "run-task.ts must call assertLintClean");
  assert.match(runTaskSrc, /TaskLintError/, "run-task.ts must convert a failing lint into a terminal verdict");
  const assertRunnableIdx = runTaskSrc.indexOf("assertRunnable(plan, task, isMerged)");
  const lintIdx = runTaskSrc.indexOf("assertLintClean(");
  assert.ok(assertRunnableIdx >= 0, "assertRunnable must be called");
  assert.ok(lintIdx > assertRunnableIdx, "the lint guard must run AFTER assertRunnable (unmet-deps/blocked/verify:human are checked first)");
});

test("the lint guard runs BEFORE the inflight lock and BEFORE any worktree/worker work — no spawn on a linter-failing task", () => {
  const lintIdx = runTaskSrc.indexOf("assertLintClean(");
  const inflightIdx = runTaskSrc.indexOf("acquireInflightLock(");
  const worktreeAddIdx = runTaskSrc.indexOf("worktreeAdd(");
  const reconIdx = runTaskSrc.indexOf('"recon worker"');
  assert.ok(lintIdx >= 0, "assertLintClean must be called somewhere in run-task.ts");
  assert.ok(lintIdx < inflightIdx, "the lint guard must precede the inflight lock");
  assert.ok(lintIdx < worktreeAddIdx, "the lint guard must precede worktreeAdd (repo/worktree setup)");
  assert.ok(lintIdx < reconIdx, "the lint guard must precede the recon worker spawn");
});

// ── CRITERION 5 (BEHAVIORAL, injected-exec): rmd run-task REFUSES a linter-failing ────────
// task with blocked_illformed and NEVER spawns; a clean task passes the guard. This drives
// the REAL runTask dispatch path through injected seams (spawn + github) — not a source grep.

/** A fixture plan: TST-BAD trips the sizing linter (3 subsystems @ risk medium); TST-OK is clean. */
const FIXTURE_PLAN = `- id: TST-BAD
  title: "malformed — spans three subsystems at medium risk (sizing block)"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: architect
  files: [src/lib/daemon.ts, src/lib/launchd.ts, src/lib/review.ts]
  acceptance:
    - claim: "does the thing"
      proof: "unit test test/foo.test.ts asserts the thing"
  status: queued
  attempts: 0
- id: TST-OK
  title: "clean — one subsystem, observable proof, origin present"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: architect
  files: [src/lib/daemon.ts]
  acceptance:
    - claim: "does the thing"
      proof: "unit test test/daemon.test.ts asserts the thing"
  status: queued
  attempts: 0
- id: TST-WARN
  title: "clean sizing; the proof PARSES but names no resolvable artifact (W1-T101 warn rollout)"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: architect
  files: [src/lib/daemon.ts]
  acceptance:
    - claim: "does the thing"
      proof: "unit test: a seeded fixture, an injected clock, and a recorded verdict all agree"
  status: queued
  attempts: 0
- id: TST-PROSE
  title: "clean sizing, but the proof is free prose that can never execute (impl-AK: dialect BLOCKS)"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: architect
  files: [src/lib/daemon.ts]
  acceptance:
    - claim: "the daemon keeps polling after a failed tick"
      proof: "unit test: test/daemon.test.ts asserts the poll loop survives a failed tick"
    - claim: "the operator can see why a tick failed"
      proof: "the board visibly shows the failed tick when you look at it"
  status: queued
  attempts: 0
- id: TST-FWD
  title: "clean sizing; the proof FORWARD-REFERENCES a test file its own PR will create"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: architect
  files: [src/lib/daemon.ts]
  acceptance:
    - claim: "does the thing"
      proof: "unit test: test/impl-ak-not-yet-created.test.ts"
  status: queued
  attempts: 0
`;

/** An offline GitHub gateway: projectPlan runs with zero network round-trips. */
const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function fixturePlanPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lint-wiring-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  return planPath;
}

test("CRITERION 5 (behavioral): a linter-failing task -> verdict=blocked_illformed, costUsd 0, and the injected worker-spawn is NEVER called", async () => {
  const planPath = fixturePlanPath();
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-lint-root-"));
  const config: Config = { claudeBin: "/bin/true", root: configRoot };

  let spawnCalls = 0;
  // A spawn stub that COUNTS calls and hard-fails if ever reached — a linter-failing
  // task must return before any worker is spawned. Typed as the real spawnWorker.
  const spawn = (async () => {
    spawnCalls++;
    throw new Error("spawn must never run for a linter-failing task");
  }) as typeof spawnWorker;

  const res = await runTask("TST-BAD", {
    skipGitSync: true, // fixture plan is read literally, no git fetch
    planPath,
    config,
    github: OFFLINE_GITHUB, // projectPlan runs offline
    spawn, // the recon/first worker-spawn is routed through this
  });

  assert.equal(res.verdict, "blocked_illformed", "a linter-failing task is REFUSED with a terminal blocked_illformed verdict");
  assert.equal(res.costUsd, 0, "no cost is incurred — the run never reached a worker");
  assert.equal(spawnCalls, 0, "the injected worker-spawn was NEVER called (no lock, no worktree, no worker)");
});

test("CRITERION 5 (behavioral): a CLEAN task PASSES the pre-dispatch guard (assertLintClean does not throw), while the malformed one throws", () => {
  const plan = loadPlan(fixturePlanPath());
  // assertLintClean is the EXACT guard runTask invokes at dispatch (run-task.ts).
  assert.doesNotThrow(() => assertLintClean(plan.byId.get("TST-OK")!), "a clean task must pass the guard");
  assert.throws(() => assertLintClean(plan.byId.get("TST-BAD")!), /lint|violation/i, "the malformed task must be refused by the same guard");
});

// ── W1-T101: the proof-resolvability warn rollout is REAL at the pre-dispatch call site ──
// (not just implemented in the linter) — a task whose only violation is an unresolvable
// dialect-prefixed proof passes assertLintClean (demoted to warn, same convention proof-dialect
// already established) AND the pre-dispatch loop LOGS it via `log("lint.warned", ...)` before
// falling through to the rest of the dispatch path.

test("CRITERION 5 (behavioral): a proof-resolvability-only violation WARNS (never refuses) at pre-dispatch, and the warning is ledgered", async () => {
  const planPath = fixturePlanPath();
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-lint-root-"));
  const config: Config = { claudeBin: "/bin/true", root: configRoot };

  // Pre-seed a LIVE (this process' own pid) in-flight lock for TST-WARN so runTask refuses
  // with blocked_inflight right after the lint gate — proving the lint guard (and its warn
  // logging) already ran and PASSED without ever reaching a real worktree/worker spawn.
  const inflightDir = join(configRoot, "state", "inflight");
  mkdirSync(inflightDir, { recursive: true });
  writeFileSync(
    join(inflightDir, "TST-WARN.lock"),
    JSON.stringify({ pid: process.pid, run_id: "pre-existing-run", host: "test-host", startedAt: new Date().toISOString() }),
  );

  let spawnCalls = 0;
  const spawn = (async () => {
    spawnCalls++;
    throw new Error("spawn must never run once the pre-seeded inflight lock refuses the run");
  }) as typeof spawnWorker;

  const res = await runTask("TST-WARN", {
    skipGitSync: true,
    planPath,
    config,
    github: OFFLINE_GITHUB,
    spawn,
  });

  assert.equal(res.verdict, "blocked_inflight", "the lint gate must PASS (warn, not block) so the run reaches the inflight-lock check next");
  assert.equal(spawnCalls, 0, "the pre-seeded inflight lock refuses before any worker is spawned");

  const ledgerLines = readFileSync(join(configRoot, "state", "ledger.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const warned = ledgerLines.find((l) => l.step === "lint.warned" && l.check === "proof-resolvability");
  assert.ok(warned, "the pre-dispatch loop must ledger a lint.warned line for the demoted proof-resolvability violation");
  assert.match(warned.message, /names no resolvable/, "the ledgered warning carries the linter's own remedy message");
});

test("blocked_illformed is a recognized terminal verdict on RunResult", () => {
  assert.match(runTaskSrc, /"blocked_illformed"/);
});

// ── impl-AK: proofDialect BLOCKS pre-dispatch; proofResolvability STAYS demoted ──────────
//
// The two halves of this section are deliberately asymmetric and must stay that way:
//   • a proof that cannot PARSE (free prose / a near-miss prefix) is REFUSED before the
//     in-flight lock — no lock, no worktree, no worker, cost 0;
//   • a proof that DOES parse but names no artifact resolvable TODAY still DISPATCHES,
//     because a queued task's proof legitimately forward-references the test its own PR
//     will create. The dispatch case is the regression lock on that carve-out.
//
// Both halves drive the REAL runTask path through injected seams. "Still dispatches" is
// proved by PRE-SEEDING a live (this process' own pid) in-flight lock for the task, so
// runTask refuses with `blocked_inflight` at the guard IMMEDIATELY AFTER the lint gate:
// reaching that verdict is positive proof the lint gate ran and PASSED, and the injected
// spawn counter proves no worker was reached either way. Never a timing assertion.

/** Drive runTask for `taskId` with a pre-seeded LIVE in-flight lock and a counting spawn
 *  stub. `blocked_inflight` ⇒ the pre-dispatch lint gate PASSED; `blocked_illformed` ⇒ it
 *  REFUSED. Returns the verdict, the spawn count, and the run's own ledger lines. */
async function dispatchProbe(taskId: string, opts: { seedInflight: boolean }) {
  const planPath = fixturePlanPath();
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-implak-root-"));
  const config: Config = { claudeBin: "/bin/true", root: configRoot };

  if (opts.seedInflight) {
    const inflightDir = join(configRoot, "state", "inflight");
    mkdirSync(inflightDir, { recursive: true });
    writeFileSync(
      join(inflightDir, `${taskId}.lock`),
      JSON.stringify({ pid: process.pid, run_id: "pre-existing-run", host: "test-host", startedAt: new Date().toISOString() }),
    );
  }

  let spawnCalls = 0;
  const spawn = (async () => {
    spawnCalls++;
    throw new Error(`spawn must never be reached for ${taskId} on this path`);
  }) as typeof spawnWorker;

  const res = await runTask(taskId, { skipGitSync: true, planPath, config, github: OFFLINE_GITHUB, spawn });
  let ledger: Record<string, unknown>[] = [];
  try {
    ledger = readFileSync(join(configRoot, "state", "ledger.ndjson"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    ledger = [];
  }
  return { res, spawnCalls, ledger };
}

test("impl-AK: a free-prose proof is REFUSED at dispatch and no worker spawns", async () => {
  const { res, spawnCalls } = await dispatchProbe("TST-PROSE", { seedInflight: false });
  assert.equal(res.verdict, "blocked_illformed", "a proof that cannot execute must REFUSE dispatch, not merely warn");
  assert.equal(res.costUsd, 0, "the refusal costs nothing — it precedes the in-flight lock");
  assert.equal(spawnCalls, 0, "the injected worker-spawn counter proves NO worker was spawned");
});

test("impl-AK: the dialect refusal names the task, the criterion, and the offending proof string", async () => {
  const { res, ledger } = await dispatchProbe("TST-PROSE", { seedInflight: false });
  assert.equal(res.verdict, "blocked_illformed");
  const blocked = ledger.find((l) => l.step === "lint.blocked");
  assert.ok(blocked, "the refusal must be ledgered on the EXISTING lint.blocked channel, never a new one");
  assert.equal(blocked!.task_id, "TST-PROSE", "the ledgered refusal names WHICH task");
  const violations = blocked!.violations as { check: string; message: string }[];
  const dialect = violations.filter((v) => v.check === "proof-dialect");
  assert.equal(dialect.length, 1, "exactly the one non-parsing criterion is cited");
  assert.match(dialect[0]!.message, /criterion 2/, "the refusal names WHICH criterion");
  assert.match(
    dialect[0]!.message,
    /the board visibly shows the failed tick when you look at it/,
    "the refusal quotes WHICH proof string",
  );
  assert.match(dialect[0]!.message, /rewrite as `unit test: <path-or-test-title>` or `grep: <pattern> in <path>`/, "the refusal carries the remedy");
});

test("impl-AK: a parsing-but-unresolvable proof still DISPATCHES (the forward-reference carve-out)", async () => {
  const { res, spawnCalls, ledger } = await dispatchProbe("TST-WARN", { seedInflight: true });
  assert.equal(
    res.verdict,
    "blocked_inflight",
    "proofResolvability must STAY demoted to warn: reaching the in-flight guard proves the lint gate PASSED",
  );
  assert.equal(spawnCalls, 0, "the pre-seeded in-flight lock refuses before any worker is spawned");
  const warned = ledger.find((l) => l.step === "lint.warned" && l.check === "proof-resolvability");
  assert.ok(warned, "the still-demoted violation is ledgered as a WARNING, so the authoring gap stays visible");
  assert.match(String(warned!.message), /names no resolvable/, "the warning carries the linter's own remedy");
  assert.equal(
    ledger.find((l) => l.step === "lint.blocked"),
    undefined,
    "nothing blocked: a resolvability-only violation must never refuse dispatch",
  );
});

test("impl-AK: a forward-referenced test path still DISPATCHES", async () => {
  const plan = loadPlan(fixturePlanPath());
  const fwd = plan.byId.get("TST-FWD")!;
  assert.equal(
    existsSync(fileURLToPath(new URL("../test/impl-ak-not-yet-created.test.ts", import.meta.url))),
    false,
    "the proof's target must NOT exist — that is what makes this a forward reference",
  );
  assert.doesNotThrow(() => assertLintClean(fwd), "a path proof naming a file the PR will create passes the gate");
  const { res, spawnCalls } = await dispatchProbe("TST-FWD", { seedInflight: true });
  assert.equal(res.verdict, "blocked_inflight", "reaching the in-flight guard proves the lint gate PASSED");
  assert.equal(spawnCalls, 0);
});

test("impl-AK: a fully valid resolvable proof dispatches exactly as before", async () => {
  const { res, spawnCalls, ledger } = await dispatchProbe("TST-OK", { seedInflight: true });
  assert.equal(res.verdict, "blocked_inflight", "an unchanged clean task still passes the lint gate");
  assert.equal(spawnCalls, 0);
  assert.equal(ledger.find((l) => l.step === "lint.blocked"), undefined, "nothing blocked");
  assert.equal(ledger.find((l) => l.step === "lint.warned"), undefined, "nothing warned either");
});

test("impl-AK: the pre-dispatch gate passes ONE options object to both lint calls so they cannot drift", () => {
  assert.match(
    runTaskSrc,
    /const preDispatchLint = \{ proofResolvability: "warn" \} as const;/,
    "the pre-dispatch lint options are declared once, with proofDialect left at its blocking default",
  );
  assert.match(runTaskSrc, /assertLintClean\(task, preDispatchLint\);/, "the gate uses that one object");
  assert.doesNotMatch(runTaskSrc, /proofDialect: "warn"/, 'no call site may demote proofDialect to "warn"');
});

// ── the CI half is wired too ───────────────────────────────────────────────────

test("rmd lint-plan is wired into the CLI dispatch", () => {
  assert.match(runTaskSrc, /cmd === "lint-plan"/);
  assert.match(runTaskSrc, /lintPlanCommand/);
});

// ── W1-T497: `proofNameResolutionViolations` (task-linter.ts, W1-T488) is WIRED at the
// `--base` changed-tasks call site in `lintPlanCommand` — behavioral, through the REAL
// lintPlanCommand path, never a source grep on the wiring line itself. Mirrors
// test/changed-tasks-raw-text.test.ts's own "the real --base path" shape.
//
// Before this task, `lintTask` never received `opts.resolveNameFilteredCandidates` from any
// production call site, so the check (correct, unit-tested in isolation in
// test/lint-proof-name-resolution.test.ts) always returned `[]` in a real run. The three tests
// below prove: (1) it now FIRES through the real --base path, (2) it stays silent through the
// whole-plan path where the resolver is deliberately never supplied — the same differential
// that would fail test (1) alone if the `if (scope)` wiring were ever deleted, and (3) firing
// never fails the run — severity stays `warn`.

/** A fixture whose only interesting trait is a name-filtered `unit test:` proof that resolves
 *  to ZERO tests today: metacharacter-bearing, non-scenario-narrative, guaranteed absent from
 *  the corpus — the exact high-precision shape test/lint-proof-name-resolution.test.ts's own
 *  ACCEPTANCE 1 already proves trips `proofNameResolutionViolations`.
 *
 *  ASSEMBLED FROM TWO HALVES ON PURPOSE — never one contiguous literal. `resolveNameFilteredCandidates`
 *  greps `test/**\/*.test.ts` (its own TEST_GLOB) with a FIXED STRING, and THIS FILE is itself
 *  inside that glob — a literal label written whole here would trivially "resolve" to this very
 *  file (the self-reference trap the task's own note names), certifying nothing. */
const PROBE_ID = "W1-T90497";
const PROBE_LABEL = "zzz-w1-t497-wiring-probe-nonexistent" + "-title [marker]";
const PROBE_PROOF = `unit test: ${PROBE_LABEL}`;

function probeShardYaml(): string {
  return [
    `- id: ${PROBE_ID}`,
    `  title: "W1-T497 wiring probe (fixture only — never a real task)"`,
    "  repo: remudero",
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  risk: low",
    "  status: queued",
    "  attempts: 0",
    "  files: [test/task-linter-wiring.test.ts]",
    "  acceptance:",
    '    - claim: "a fixture claim naming a name-filtered proof that resolves to nothing"',
    `      proof: "${PROBE_PROOF}"`,
    "",
  ].join("\n");
}

/** Captures console.log/error/warn during a `lintPlanCommand` call into ONE combined stream —
 *  the warning this task cares about is printed via console.warn (the soft-violation branch),
 *  distinct from test/lint-plan-open-only.test.ts's own helper, which discards warn entirely. */
async function runLintPlanCapturingEverything(args: string[]): Promise<{ exitCode: number; combined: string }> {
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const lines: string[] = [];
  console.log = (m?: unknown) => void lines.push(String(m));
  console.error = (m?: unknown) => void lines.push(String(m));
  console.warn = (m?: unknown) => void lines.push(String(m));
  try {
    const exitCode = await lintPlanCommand(args);
    return { exitCode, combined: lines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

test("W1-T497 ACCEPTANCE 1+3: the --base changed-tasks pass WARNS on a zero-resolving name-filtered proof, and the warning stays advisory (no block, exit 0)", async () => {
  // Placed as a NEW, untracked shard under the REAL plan/tasks.d/: absent from `git show
  // HEAD:...`, so `changedTaskIds` counts it as new-in-scope without editing any tracked file.
  // W1-T515: THE FIXTURE PLAN, NOT THE LIVE ONE. This probe used to land under the real
  // `plan/tasks.d/`. It never dirtied TRACKED state — `checkServiceFreshness` reads
  // `--porcelain -uno`, so untracked litter can never pin the daemon — but `checkCliFreshness`
  // reads a BARE `--porcelain`, so a crash between the write and the cleanup made every `rmd`
  // verb in this checkout refuse with `reason: "dirty"`. It also raced every other reader of that
  // directory under a parallel runner, which is the ENOENT crash #1873/#1874 guards the symptom of.
  // The probe still has to be ABSENT AT THE BASE REF for `changedTaskIds` to count it new-in-scope,
  // and an untracked file under the COMMITTED fixture satisfies that exactly as it did before.
  const fixturePlan = join(REPO_ROOT, "test", "fixtures", "live-plan-writers", "wiring", "tasks.yaml");
  const shardPath = join(REPO_ROOT, "test", "fixtures", "live-plan-writers", "wiring", "tasks.d", "zzz-w1-t497-wiring-probe.yaml");
  assert.equal(existsSync(shardPath), false, "the probe shard must not already exist on disk");
  mkdirSync(dirname(shardPath), { recursive: true }); // the fixture ships no tasks.d until a probe needs one
  const livePlanBefore = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain", "--", "plan/"], { encoding: "utf8" }).trim();
  writeFileSync(shardPath, probeShardYaml(), "utf8");
  try {
    // DURING, not only after: the dirty window IS the race, so the live tree is checked while the
    // probe is on disk rather than once it has been cleaned up.
    const livePlanDuring = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain", "--", "plan/"], { encoding: "utf8" }).trim();
    assert.equal(livePlanDuring, livePlanBefore, "the LIVE plan/ tree must be untouched WHILE the probe shard exists");
    const { exitCode, combined } = await runLintPlanCapturingEverything(["--plan", fixturePlan, "--base", "HEAD"]);
    assert.match(
      combined,
      new RegExp(`⚠ ${PROBE_ID}: \\[proof-name-resolution\\]`),
      `the --base pass must WARN proof-name-resolution for ${PROBE_ID}; saw:\n${combined}`,
    );
    assert.match(combined, /resolves to ZERO tests today/, "the warning carries the check's own zero-match message");
    assert.doesNotMatch(combined, new RegExp(`✗ ${PROBE_ID}`), "a name-resolution-only violation must never BLOCK");
    assert.equal(exitCode, 0, "a warn-only violation must not fail the lint-plan run");
  } finally {
    rmSync(shardPath, { force: true });
  }
});

test("W1-T497 ACCEPTANCE 2: whole-plan mode (no --base) stays UNWIRED on purpose — the IDENTICAL fixture is silent there, proving the warning above depends on the --base wiring, not the check's own logic", async () => {
  // A self-contained fixture plan (mirrors test/lint-plan-open-only.test.ts's
  // buildCountingFixture), never the live 484-task plan — whole-plan mode deliberately never
  // supplies `opts.resolveNameFilteredCandidates` (the 66s-over-320-proofs regression this
  // task's rationale measured), so this must stay silent regardless of corpus size.
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t497-wiring-"));
  try {
    mkdirSync(join(dir, "plan"), { recursive: true });
    const tasksPath = join(dir, "plan", "tasks.yaml");
    writeFileSync(tasksPath, probeShardYaml(), "utf8");
    const { combined } = await runLintPlanCapturingEverything(["--plan", tasksPath]);
    assert.doesNotMatch(
      combined,
      /proof-name-resolution/,
      `whole-plan mode must never fire proof-name-resolution (the resolver is never supplied there); saw:\n${combined}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T1225: `proofGrepUnmatchableViolations` (task-linter.ts) is WIRED at the SAME `--base`
// changed-tasks call site as W1-T497's resolver above, via `opts.readGrepProofFile` — a real
// filesystem reader bound to `repoRoot`, never a stub. Mirrors the W1-T497 wiring suite one
// section up: (1) fires through the real --base path, (2) stays silent in whole-plan mode (the
// reader is never supplied there either), and (3) the reader's own catch branch — reached when
// `existsSync` is true but `readFileSync` still throws (a directory sits where a file was
// expected) — is exercised directly, proving a real read failure degrades to the SAME "not on
// disk yet" silence as an absent path, rather than crashing the whole lint-plan run.

const GREP_PROBE_ID = "W1-T91225";
const GREP_CASE_PATTERN = "widget registry becomes authoritative";
const GREP_CASE_FILE_TEXT = "The Widget Registry becomes authoritative here.\n";

/** `caseFileRel`/`dirAsFileRel` are repo-root-relative paths supplied by the caller — the first
 *  names a real file carrying `GREP_CASE_FILE_TEXT` (case-only mismatch ⇒ WARN), the second
 *  names a real DIRECTORY (existsSync true, readFileSync throws ⇒ the catch branch ⇒ silence). */
function grepProbeShardYaml(caseFileRel: string, dirAsFileRel: string): string {
  return [
    `- id: ${GREP_PROBE_ID}`,
    `  title: "W1-T1225 wiring probe (fixture only — never a real task)"`,
    "  repo: remudero",
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  risk: low",
    "  status: queued",
    "  attempts: 0",
    "  files: [test/task-linter-wiring.test.ts]",
    "  acceptance:",
    '    - claim: "the widget registry line is present, but only under different capitalisation"',
    `      proof: "grep: ${GREP_CASE_PATTERN} in ${caseFileRel}"`,
    '    - claim: "a path that is a DIRECTORY, not a file, must degrade to silence, never a crash"',
    `      proof: "grep: anything at all in ${dirAsFileRel}"`,
    "",
  ].join("\n");
}

test("W1-T1225 ACCEPTANCE: the --base changed-tasks pass WARNS proof-grep-unmatchable on a case-only grep proof, AND a directory named where a file was expected degrades to silence rather than crashing", async () => {
  const fixturePlan = join(REPO_ROOT, "test", "fixtures", "live-plan-writers", "wiring", "tasks.yaml");
  const shardPath = join(
    REPO_ROOT,
    "test",
    "fixtures",
    "live-plan-writers",
    "wiring",
    "tasks.d",
    "zzz-w1-t1225-wiring-probe.yaml",
  );
  const tmpDir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t1225-wiring-"));
  const caseFileAbs = join(tmpDir, "case-fixture.md");
  // Named WITH an extension on purpose (R-12): parseDialectGrep and proof-grep-safety now refuse a
  // directory-SHAPED target (no extension on the final segment) before anything opens it, so an
  // extensionless name would BLOCK here and never reach the unmatchable check's own EISDIR branch —
  // the branch this test exists to drive. A dotted directory passes the shape rule.
  const dirAsFileAbs = join(tmpDir, "dir-as-file.md");
  const caseFileRel = relative(REPO_ROOT, caseFileAbs);
  const dirAsFileRel = relative(REPO_ROOT, dirAsFileAbs);
  assert.equal(existsSync(shardPath), false, "the probe shard must not already exist on disk");
  mkdirSync(dirname(shardPath), { recursive: true });
  mkdirSync(dirAsFileAbs, { recursive: true }); // a REAL directory: existsSync true, readFileSync throws EISDIR
  writeFileSync(caseFileAbs, GREP_CASE_FILE_TEXT, "utf8");
  writeFileSync(shardPath, grepProbeShardYaml(caseFileRel, dirAsFileRel), "utf8");
  try {
    const { exitCode, combined } = await runLintPlanCapturingEverything(["--plan", fixturePlan, "--base", "HEAD"]);
    assert.match(
      combined,
      new RegExp(`⚠ ${GREP_PROBE_ID}: \\[proof-grep-unmatchable\\]`),
      `the --base pass must WARN proof-grep-unmatchable for ${GREP_PROBE_ID}; saw:\n${combined}`,
    );
    assert.match(combined, /DIFFERENT CAPITALISATION/, "the warning carries the check's own case-only message");
    assert.doesNotMatch(combined, new RegExp(`✗ ${GREP_PROBE_ID}`), "a grep-unmatchable-only violation must never BLOCK");
    assert.equal(exitCode, 0, "a warn-only violation must not fail the lint-plan run");
    // Exactly ONE proof-grep-unmatchable warning for this probe — the directory-path criterion
    // stayed silent (the catch branch degraded it to "not on disk", not a second warning).
    const warnCount = (combined.match(new RegExp(`⚠ ${GREP_PROBE_ID}: \\[proof-grep-unmatchable\\]`, "g")) ?? []).length;
    assert.equal(warnCount, 1, "the directory-as-file criterion must stay silent, not add a second warning");
  } finally {
    rmSync(shardPath, { force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("W1-T1225 ACCEPTANCE: whole-plan mode (no --base) stays UNWIRED on purpose — the IDENTICAL fixture is silent there, proving the warning above depends on the --base wiring, not the check's own logic", async () => {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t1225-wiring-wholeplan-"));
  try {
    mkdirSync(join(dir, "plan"), { recursive: true });
    const tasksPath = join(dir, "plan", "tasks.yaml");
    writeFileSync(tasksPath, grepProbeShardYaml("docs/does-not-matter.md", "docs/also-does-not-matter"), "utf8");
    const { combined } = await runLintPlanCapturingEverything(["--plan", tasksPath]);
    assert.doesNotMatch(
      combined,
      /proof-grep-unmatchable/,
      `whole-plan mode must never fire proof-grep-unmatchable (the reader is never supplied there); saw:\n${combined}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── W1-T515: the probe no longer lands in the live plan tree ─────────────────────────────────
test("the wiring probe shard lands outside the live plan tree", () => {
  // Asserted on the SOURCE of the probe's own path, so a future edit that points it back at
  // `plan/tasks.d/` fails here rather than being found by a flake three PRs later.
  const src = readFileSync(fileURLToPath(new URL("./task-linter-wiring.test.ts", import.meta.url)), "utf8");
  const probeLine = src.split("\n").find((l) => l.includes('"zzz-w1-t497-wiring-probe.yaml"'));
  assert.ok(probeLine, "the probe path line must still exist");
  assert.match(probeLine!, /fixtures/, "the probe shard must be built under test/fixtures, never the live plan tree");
  assert.doesNotMatch(probeLine!, /"plan",\s*"tasks\.d"/, "the probe must not address the live plan/tasks.d/ directory");
  // CONTROL: the query can see a live-plan path when one is present — this file still contains
  // REPO_ROOT-anchored joins, so a silent zero here would be the query failing, not the fix working.
  assert.match(src, /join\(REPO_ROOT/, "control: repo-root-anchored joins are still greppable in this file");
});

test("the plan tree is unchanged after the suite runs", () => {
  const porcelain = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain", "--", "plan/"], { encoding: "utf8" }).trim();
  assert.equal(porcelain, "", `this suite must leave plan/ byte-identical; saw:\n${porcelain}`);
});
