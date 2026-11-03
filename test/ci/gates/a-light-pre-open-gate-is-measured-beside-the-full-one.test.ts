import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// @ts-ignore the executable .mjs module has no declaration file.
import { main as censusMain } from "#scripts/census-precheck.mjs";
import { CENSUS_COUNTS_LOG_ENV, CENSUS_COUNTS_STEP_JOB, FAST_GATE_STEPS } from "#src/lib/ci-parity.js";
import type { PreflightSpawn } from "#src/lib/commit-message.js";
import {
  GATE_STEP_LOG_NAME, defaultRunGate, deriveLightGate, preopenGateLedgerFields, readPreflightStepLog, runPreopenGate,
  type GateRun, type PreflightStepRecord,
} from "#src/lib/preopen-gate.js";
import { preflightCommand } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { finishJudgedRun } from "#test/helpers/judged-pool-run.js";

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

/** Drive the real preflightCommand over an injected spawn, keeping the census-precheck child's environment. */
async function preflightWith(rest: string[]): Promise<{ censusEnv: NodeJS.ProcessEnv | undefined; spawned: boolean }> {
  let censusEnv: NodeJS.ProcessEnv | undefined;
  let spawned = false;
  const spawn: PreflightSpawn = (_file, args, opts) => {
    if (args.some((arg) => arg.endsWith("census-precheck.mjs"))) {
      spawned = true;
      censusEnv = opts?.env;
    }
    if (args.includes("rev-list")) return { status: 0, stdout: "0\n", stderr: "" };
    return { ...finishJudgedRun(args, opts), stdout: "\0feat(x): fine\n", stderr: "" };
  };
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await preflightCommand(rest, { spawn, loadavg: () => [1, 1, 1], cpuCount: 4 });
  } finally {
    console.log = log;
    console.error = error;
  }
  return { censusEnv, spawned };
}

test("W1-T11105 criterion 1: rmd preflight --step-log appends its plan, each finished phase and each fast-gate job, and hands census-precheck the log", async (t) => {
  const path = join(scratch(t, "steplog"), "steps.ndjson");
  const { censusEnv, spawned } = await preflightWith(["--step-log", path]);
  const lines = records(path);
  const jobs = FAST_GATE_STEPS.map(({ job }) => job);
  assert.deepEqual(lines[0], { plan: { phases: ["default", "fast", "ci-checks", "fast-coverage"], fast_jobs: jobs } },
    "the first line names what this invocation runs");
  const phases = lines.filter((line) => typeof line.phase === "string");
  assert.deepEqual(phases.map((line) => line.phase), ["default", "fast", "ci-checks", "fast-coverage"], "one line per finished phase, in order");
  for (const line of phases) {
    assert.equal(typeof line.ok, "boolean", `${String(line.phase)} records its verdict`);
    assert.equal(typeof line.ms, "number");
    assert.ok(Array.isArray(line.failed));
  }
  const logged = new Set(lines.filter((line) => typeof line.job === "string").map((line) => line.job));
  for (const job of jobs) assert.ok(logged.has(job), `fast-gate job ${job} is logged as it finishes`);
  assert.ok(spawned, "the fixture reached the census-precheck leaf");
  assert.equal(censusEnv?.[CENSUS_COUNTS_LOG_ENV], path, "census-precheck receives the log through its environment, never a flag");
});

test("W1-T11105 criterion 1: without --step-log nothing is logged and census-precheck gets no log", async () => {
  const { censusEnv, spawned } = await preflightWith([]);
  assert.ok(spawned);
  assert.equal(censusEnv?.[CENSUS_COUNTS_LOG_ENV], undefined);
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
