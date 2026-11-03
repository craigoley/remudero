import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// @ts-ignore the executable .mjs module has no declaration file.
import { CENSUS_SNAPSHOT_ENV, main as censusMain } from "#scripts/census-precheck.mjs";
import {
  CENSUS_COUNTS_LOG_ENV, CENSUS_COUNTS_STEP_JOB, FAST_GATE_STEPS, createPreflightStepLog, preflightStepLogPlan, runPreflightFast,
} from "#src/lib/ci-parity.js";
import type { PreflightSpawn } from "#src/lib/commit-message.js";
import {
  GATE_STEP_LOG_NAME, defaultRunGate, deriveLightGate, preopenGateLedgerFields, readPreflightStepLog, runPreopenGate,
  type GateRun, type PreflightStepRecord,
} from "#src/lib/preopen-gate.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const noPush = async () => ({ kind: "skipped" as const, reason: "fixture has no remote" });
const noProcfs = () => [];

function scratch(t: { after: (fn: () => void) => void }, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rmd-w11105-${kind}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function records(path: string): PreflightStepRecord[] {
  const read = readPreflightStepLog(path);
  assert.ok(Array.isArray(read), `the step log is readable: ${JSON.stringify(read)}`);
  return read;
}

/** The fast gate over a few real FAST_GATE_STEPS rows and an injected spawn, keeping the census-precheck child's environment. */
function fastGateWith(stepLog?: ReturnType<typeof createPreflightStepLog>) {
  let censusEnv: NodeJS.ProcessEnv | undefined;
  let censusSpawned = false;
  const spawn: PreflightSpawn = (_file, args, opts) => {
    if (args.some((arg) => arg.endsWith("census-precheck.mjs"))) {
      censusSpawned = true;
      censusEnv = opts?.env;
    }
    return { status: args.some((arg) => arg.endsWith("list-rule-suites.mjs")) ? 1 : 0, stdout: "", stderr: "" };
  };
  const steps = FAST_GATE_STEPS.filter(({ job }) => ["rule-checks", "cli-reference", "census-precheck"].includes(job));
  const prior = process.env.RMD_AUTHOR_CENSUS_ANSWERED;
  delete process.env.RMD_AUTHOR_CENSUS_ANSWERED;
  try {
    const result = runPreflightFast(REPO_ROOT, { steps, spawn, ...(stepLog ? { stepLog } : {}) });
    return { result, censusEnv, censusSpawned };
  } finally {
    if (prior !== undefined) process.env.RMD_AUTHOR_CENSUS_ANSWERED = prior;
  }
}

test("W1-T11105 criterion 1: the step log's first line names the phases and fast-gate jobs this invocation runs", () => {
  const jobs = FAST_GATE_STEPS.map(({ job }) => job);
  assert.deepEqual(preflightStepLogPlan([], true), { phases: ["default", "fast", "ci-checks", "fast-coverage"], fastJobs: jobs });
  assert.deepEqual(preflightStepLogPlan(["--no-fast", "--ci-parity"], true), { phases: ["default", "ci-parity"], fastJobs: [] });
  assert.deepEqual(preflightStepLogPlan([], false), { phases: ["default"], fastJobs: [] }, "a consumer repo runs no fast tier");
});

test("W1-T11105 criterion 1: the fast gate logs each job as it finishes and hands census-precheck the log; without a log nothing changes", (t) => {
  const path = join(scratch(t, "steplog"), "steps.ndjson");
  const stepLog = createPreflightStepLog(path);
  stepLog.plan(["default", "fast"], ["rule-checks", "cli-reference", "census-precheck"]);
  const logged = fastGateWith(stepLog);
  stepLog.phase("fast", logged.result, 12.4);
  const lines = records(path);
  assert.deepEqual(lines[0], { plan: { phases: ["default", "fast"], fast_jobs: ["rule-checks", "cli-reference", "census-precheck"] } });
  const jobs = lines.filter((line) => typeof line.job === "string");
  assert.deepEqual(jobs.map(({ job, ok }) => ({ job, ok })), logged.result.steps.map(({ name, ok }) => ({ job: name, ok })),
    "one line per fast-gate job, in the order they finished, carrying each verdict");
  assert.ok(jobs.every((line) => typeof line.ms === "number"));
  assert.deepEqual(lines.at(-1), { phase: "fast", ok: false, ms: 12, failed: ["rule-checks"] }, "a phase line names its failed steps");
  assert.ok(logged.censusSpawned, "the fixture reached the census-precheck leaf");
  assert.equal(logged.censusEnv?.[CENSUS_COUNTS_LOG_ENV], path, "census-precheck receives the log through its environment, never a flag");

  const plain = fastGateWith();
  assert.equal(plain.censusEnv?.[CENSUS_COUNTS_LOG_ENV], undefined, "without a step log census-precheck gets no log");
  assert.deepEqual(plain.result.steps.map(({ name, ok }) => ({ name, ok })), logged.result.steps.map(({ name, ok }) => ({ name, ok })),
    "every step runs and decides as before");
});

test("W1-T11105 criterion 1: an unwritable step log is reported once and changes no verdict", (t) => {
  const stepLog = createPreflightStepLog(join(scratch(t, "unwritable"), "missing-dir", "steps.ndjson"));
  const said: string[] = [];
  t.mock.method(console, "error", (line: string) => { said.push(line); });
  const logged = fastGateWith(stepLog);
  assert.equal(logged.result.steps.length, 3);
  assert.equal(said.filter((line) => line.includes("step log NOT written")).length, 1);
});

/** A census fixture: the real rule-suite selector, one src leaf and one test; the head adds a clock read or not. */
function censusFixture(head: "clock" | "clean") {
  const repo = gitRepo({ kind: "census-counts-log", seedCommit: false });
  mkdirSync(join(repo.dir, "src/lib"), { recursive: true });
  mkdirSync(join(repo.dir, "test"), { recursive: true });
  writeFileSync(join(repo.dir, "src/lib/rule-suites.ts"), [
    "export const CENSUS_POPULATION = [];", "export const RETAINED_RULE_SUITES = [];",
    "export const RULE_SUITE_NAME_RE = /census|ratchet|baseline/;", 'export const RULE_SUITE_DIR = "test/rules/";',
  ].join("\n") + "\n");
  writeFileSync(join(repo.dir, "src/lib/leaf.ts"), "export const leaf = 1;\n");
  writeFileSync(join(repo.dir, "test/leaf.test.ts"), "import { test } from 'node:test';\ntest('leaf', () => {});\n");
  repo.git("add", "."); repo.git("commit", "-q", "-m", "base");
  const base = repo.git("rev-parse", "HEAD");
  writeFileSync(join(repo.dir, "src/lib/leaf.ts"), head === "clock" ? "export const leaf = Date.now();\n" : "export const leaf = 2;\n");
  repo.git("commit", "-q", "-am", "head");
  return { repo, base };
}

function withCountsLog<T>(path: string, fn: () => T): T {
  const prior = process.env[CENSUS_COUNTS_LOG_ENV];
  process.env[CENSUS_COUNTS_LOG_ENV] = path;
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = error;
    if (prior === undefined) delete process.env[CENSUS_COUNTS_LOG_ENV];
    else process.env[CENSUS_COUNTS_LOG_ENV] = prior;
  }
}

test("W1-T11105 criterion 1: census-precheck logs its counts verdict before any instrument child or census suite starts", (t) => {
  const neverStarted = (what: string) => () => { throw new Error(`${what} must not start`); };
  const refused = censusFixture("clock"); t.after(() => refused.repo.cleanup());
  const refusedLog = join(scratch(t, "counts"), "steps.ndjson");
  const status = withCountsLog(refusedLog, () => censusMain(["--root", refused.repo.dir, "--base", refused.base],
    { measure: neverStarted("the instrument child"), admitted: neverStarted("the census roster"), runSuites: neverStarted("a census suite") }));
  assert.equal(status, 1);
  assert.deepEqual(records(refusedLog).map(({ job, ok }) => ({ job, ok })), [{ job: CENSUS_COUNTS_STEP_JOB, ok: false }]);

  const clean = censusFixture("clean"); t.after(() => clean.repo.cleanup());
  const cleanLog = join(scratch(t, "counts"), "steps.ndjson");
  let loggedFirst: boolean | undefined;
  const cleanStatus = withCountsLog(cleanLog, () => censusMain(["--root", clean.repo.dir, "--base", clean.base], {
    measure: neverStarted("the instrument child, which this fixture's diff never reaches"),
    // The census roster is the first thing the full run loads once its counts are known.
    admitted: () => {
      loggedFirst = existsSync(cleanLog) && readFileSync(cleanLog, "utf8").includes(`"job":"${CENSUS_COUNTS_STEP_JOB}","ok":true`);
      return [];
    },
    runSuites: () => [],
  }));
  assert.equal(cleanStatus, 0);
  assert.equal(loggedFirst, true, "the counts line is on disk before the census roster loads");

  const countsOnlyLog = join(scratch(t, "counts"), "steps.ndjson");
  assert.equal(withCountsLog(countsOnlyLog, () => censusMain(["--counts-only", "--root", clean.repo.dir, "--base", clean.base])), 0);
  assert.equal(records(countsOnlyLog)[0]?.ok, true, "--counts-only logs the same verdict");
});

test("W1-T11105 criterion 1: a failed counts-log write reports its cause once and preserves the census verdict", (t) => {
  const root = scratch(t, "counts-write-failure");
  const leaf = "src/lib/leaf.ts";
  mkdirSync(join(root, "src/lib"), { recursive: true });
  const snapshot = join(root, "snapshot.json");
  writeFileSync(snapshot, JSON.stringify({
    version: 1, root, mergeBase: "fixture-base", headPaths: [leaf], basePaths: [leaf],
    baseBlobs: { [leaf]: "export const leaf = 1;\n" }, mainBlobs: {},
  }));
  const priorSnapshot = process.env[CENSUS_SNAPSHOT_ENV];
  const priorLog = process.env[CENSUS_COUNTS_LOG_ENV];
  t.after(() => {
    if (priorSnapshot === undefined) delete process.env[CENSUS_SNAPSHOT_ENV];
    else process.env[CENSUS_SNAPSHOT_ENV] = priorSnapshot;
    if (priorLog === undefined) delete process.env[CENSUS_COUNTS_LOG_ENV];
    else process.env[CENSUS_COUNTS_LOG_ENV] = priorLog;
  });
  process.env[CENSUS_SNAPSHOT_ENV] = snapshot;
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => { errors.push(line); });
  t.mock.method(console, "log", () => {});
  const unwritable = join(root, "missing-parent", "steps.ndjson");
  for (const expected of [0, 1]) {
    writeFileSync(join(root, leaf), expected === 0 ? "export const leaf = 2;\n" : "export const leaf = Date.now();\n");
    const writable = join(root, `counts-${expected}.ndjson`);
    const args = ["--counts-only", "--root", root];
    process.env[CENSUS_COUNTS_LOG_ENV] = writable;
    const control = censusMain(args);
    assert.equal(control, expected, `the writable-log control returns the census verdict: ${errors.join("\n")}`);
    assert.equal(records(writable)[0]?.ok, expected === 0);
    process.env[CENSUS_COUNTS_LOG_ENV] = unwritable;
    errors.length = 0;
    assert.equal(censusMain(args), expected, "a logging error preserves both pass and refusal");
    const diagnostics = errors.filter((line) => line.startsWith("census-precheck: counts verdict NOT logged"));
    assert.equal(diagnostics.length, 1, "one diagnostic per failed append");
    assert.ok(diagnostics[0]?.includes(unwritable), "the diagnostic names the failed log destination");
    assert.match(diagnostics[0]!, /ENOENT/, "the diagnostic preserves the filesystem failure reason");
    assert.equal(existsSync(unwritable), false);
  }
});

/** A step log as `rmd preflight --step-log` would leave it: two phases, three fast jobs, the census counts. */
function stepLog(over: Partial<Record<string, Partial<PreflightStepRecord> | null>> = {}): PreflightStepRecord[] {
  const units: Record<string, PreflightStepRecord> = {
    "phase:default": { phase: "default", ok: true, ms: 4000, failed: [] },
    "cli-reference": { job: "cli-reference", ok: true, ms: 1000 },
    "rule-checks": { job: "rule-checks", ok: true, ms: 900_000 },
    [CENSUS_COUNTS_STEP_JOB]: { job: CENSUS_COUNTS_STEP_JOB, ok: true, ms: 3000 },
    "census-precheck": { job: "census-precheck", ok: true, ms: 1_800_000 },
    "phase:ci-checks": { phase: "ci-checks", ok: true, ms: 2000, failed: [] },
  };
  const lines: PreflightStepRecord[] = [{ plan: { phases: ["default", "fast", "ci-checks"], fast_jobs: ["rule-checks", "cli-reference", "census-precheck"] } }];
  for (const [unit, record] of Object.entries(units)) {
    const change = over[unit];
    if (change === null) continue;
    lines.push({ ...record, ...(change ?? {}) });
  }
  return lines;
}

const killed = (log: GateRun["stepLog"]): GateRun => ({ exitCode: null, error: "fast gate exceeded its backstop", deadlineEnforcedBy: "timeout", stepLog: log });
const failed = (steps: string[], log: GateRun["stepLog"]): GateRun => ({ exitCode: 1, summary: { failedSteps: steps }, stepLog: log });
const gate = (run: GateRun) => runPreopenGate("/nowhere", { runGate: async () => run, runPushGate: noPush, scanProcfsWrites: noProcfs });

test("W1-T11105 criterion 2: a gate the backstop ended still records what the light gate would have decided, and the full verdict is unchanged", async () => {
  const withLog = await gate(killed(stepLog({ "census-precheck": null })));
  const without = await gate(killed(undefined));
  assert.equal(withLog.kind, "unmeasured");
  assert.deepEqual({ ...withLog, light: undefined, durationMs: 0 }, { ...without, light: undefined, durationMs: 0 }, "the full gate decides exactly as before");
  const fields = preopenGateLedgerFields(withLog);
  assert.equal(fields.light_result, "pass", "every light unit finished green before the kill");
  assert.deepEqual(fields.light_failed, []);
  assert.deepEqual(fields.light_unreached, []);
  assert.equal(fields.light_duration_ms, 4000 + 1000 + 3000 + 2000, "the light gate's cost is its own units, never rule-checks or the census suites");
  assert.equal(preopenGateLedgerFields(without).light_result, undefined, "no step log, no shadow fields");
});

test("W1-T11105 criterion 2: a failed light unit fails the light gate, by its own step names, and an unrecorded one leaves it unreached", async () => {
  const typecheck = preopenGateLedgerFields(await gate(failed(["typecheck"], stepLog({ "phase:default": { ok: false, failed: ["typecheck"] } }))));
  assert.equal(typecheck.light_result, "fail");
  assert.deepEqual(typecheck.light_failed, ["typecheck"], "a failed phase names its failed steps");
  const job = preopenGateLedgerFields(await gate(failed(["cli-reference"], stepLog({ "cli-reference": { ok: false } }))));
  assert.deepEqual(job.light_failed, ["cli-reference"]);
  const torn = preopenGateLedgerFields(await gate(killed(stepLog({ [CENSUS_COUNTS_STEP_JOB]: null, "census-precheck": null, "phase:ci-checks": null }))));
  assert.equal(torn.light_result, "unreached");
  assert.deepEqual(torn.light_unreached, ["phase:ci-checks", CENSUS_COUNTS_STEP_JOB]);
  assert.equal(torn.light_would_save_ms, undefined, "an unreached light gate claims no saving");
  const noFast = preopenGateLedgerFields(await gate(killed([{ plan: { phases: ["default"], fast_jobs: [] } }])));
  assert.match(String(noFast.light_unmeasured), /no fast tier/);
  assert.match(String(preopenGateLedgerFields(await gate(killed({ unreadable: "no readable step log (ENOENT)" }))).light_unmeasured), /ENOENT/);
});

test("W1-T11105 criterion 2: the harness gate passes the step log inside its own HOME and reads it after a backstop kill", async (t) => {
  const dir = scratch(t, "harness");
  mkdirSync(join(dir, "bin"));
  const launcher = join(dir, "bin", "rmd");
  const sandbox = join(dir, "sandbox");
  const lines = stepLog({ "census-precheck": null }).map((line) => JSON.stringify(line)).join("\n");
  writeFileSync(launcher, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);const p=a[a.indexOf('--step-log')+1];\n` +
    `if(!p||!p.endsWith(${JSON.stringify(`/${GATE_STEP_LOG_NAME}`)})||p.startsWith(${JSON.stringify(dir)}))process.exit(23);\n` +
    `fs.writeFileSync(p,${JSON.stringify(lines + "\n")}+'{"job":"census-pre');setInterval(()=>{},1000);\n`);
  writeFileSync(sandbox, `#!${process.execPath}\nconst cp=require('node:child_process');const a=process.argv.slice(2);const at=a.indexOf('--');const r=cp.spawnSync(a[at+1],a.slice(at+2),{stdio:'inherit'});process.exit(r.status??128);\n`);
  chmodSync(launcher, 0o755);
  chmodSync(sandbox, 0o755);
  const result = await runPreopenGate(dir, {
    runGate: (cwd) => defaultRunGate(cwd, undefined, () => {}, { backstopMs: 3000 }, { harnessRoot: dir, contain: () => ({ mode: "sandboxed", file: sandbox, argv: ["--"] }) }),
    runPushGate: noPush,
    scanProcfsWrites: noProcfs,
  });
  assert.equal(result.kind, "unmeasured", "the backstop ended the full gate");
  assert.equal(preopenGateLedgerFields(result).light_result, "pass", "the log the child left, torn last line and all, was read");
});

test("W1-T11105 criterion 3: a light pass is a miss only when the full gate failed on rule-checks or census-precheck", () => {
  const pass = stepLog();
  const full = (failedSteps: string[]) => ({ kind: "fail" as const, failedSteps, durationMs: 2_000_000 });
  for (const step of ["rule-checks", "census-precheck"]) {
    const light = deriveLightGate(pass, full([step]));
    assert.ok(!("unmeasured" in light) && light.miss === true, `${step} is a step the light gate does not run`);
  }
  const caught = deriveLightGate(pass, full(["cli-reference"]));
  assert.ok(!("unmeasured" in caught) && caught.miss === false, "a full failure the light gate also runs is no miss");
  const both = deriveLightGate(stepLog({ "cli-reference": { ok: false } }), full(["cli-reference", "rule-checks"]));
  assert.ok(!("unmeasured" in both) && both.result === "fail" && both.miss === false, "a light gate that also failed missed nothing");
  const fullPass = deriveLightGate(pass, { kind: "pass", durationMs: 2_000_000 });
  assert.ok(!("unmeasured" in fullPass) && fullPass.miss === false);
});

test("W1-T11105 criterion 3: the would-save is the full gate's duration minus the light gate's, when the full gate passed or was unmeasured", () => {
  const lightMs = 4000 + 1000 + 3000 + 2000;
  const passed = deriveLightGate(stepLog(), { kind: "pass", durationMs: 2_000_000 });
  assert.ok(!("unmeasured" in passed) && passed.wouldSaveMs === 2_000_000 - lightMs);
  const unmeasured = deriveLightGate(stepLog(), { kind: "unmeasured", reason: "fast gate exceeded its backstop", durationMs: 2_316_000 });
  assert.ok(!("unmeasured" in unmeasured) && unmeasured.wouldSaveMs === 2_316_000 - lightMs);
  const failedFull = deriveLightGate(stepLog(), { kind: "fail", failedSteps: ["rule-checks"], durationMs: 2_000_000 });
  assert.ok(!("unmeasured" in failedFull) && failedFull.wouldSaveMs === undefined, "a full gate that caught something saves nothing by being skipped");
  assert.equal(preopenGateLedgerFields({ kind: "pass", durationMs: 2_000_000, light: passed }).light_would_save_ms, 2_000_000 - lightMs);
});
