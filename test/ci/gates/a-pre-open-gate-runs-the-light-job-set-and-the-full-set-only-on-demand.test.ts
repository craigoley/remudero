import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CENSUS_COUNTS_LOG_ENV, CENSUS_COUNTS_STEP_JOB, FAST_GATE_STEPS, LIGHT_GATE_SKIPPED_JOBS, createPreflightStepLog, preflightStepLogPlan, runPreflightFast,
} from "#src/lib/ci-parity.js";
import type { PreflightSpawn } from "#src/lib/commit-message.js";
import {
  PREOPEN_GATE_MODE_ENV, defaultRunGate, preopenGateLedgerFields, readPreflightStepLog, runPreopenGate,
  type GateRun, type PreflightStepRecord,
} from "#src/lib/preopen-gate.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const noPush = async () => ({ kind: "skipped" as const, reason: "fixture has no remote" });
const noProcfs = () => [];

function scratch(t: { after: (fn: () => void) => void }, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rmd-w11818-${kind}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The step log a `--light` run leaves: its plan names the mode and the skipped jobs, and only the light units are recorded. */
function lightLog(over: Partial<Record<string, Partial<PreflightStepRecord> | null>> = {}): PreflightStepRecord[] {
  const units: Record<string, PreflightStepRecord> = {
    "phase:default": { phase: "default", ok: true, ms: 4000, failed: [] },
    "cli-reference": { job: "cli-reference", ok: true, ms: 1000 },
    [CENSUS_COUNTS_STEP_JOB]: { job: CENSUS_COUNTS_STEP_JOB, ok: true, ms: 3000 },
    "phase:ci-checks": { phase: "ci-checks", ok: true, ms: 2000, failed: [] },
  };
  const lines: PreflightStepRecord[] = [{ plan: { phases: ["default", "fast", "ci-checks"], fast_jobs: ["cli-reference"], light: true, skipped_jobs: [...LIGHT_GATE_SKIPPED_JOBS] } }];
  for (const [unit, record] of Object.entries(units)) {
    const change = over[unit];
    if (change === null) continue;
    lines.push({ ...record, ...(change ?? {}) });
  }
  return lines;
}

const lightRun = (over: Partial<GateRun> = {}): GateRun => ({ exitCode: 0, gateMode: "light", stepLog: lightLog(), ...over });
const gate = (run: GateRun) => runPreopenGate("/nowhere", { runGate: async () => run, runPushGate: noPush, scanProcfsWrites: noProcfs });

test("W1-T11818 criterion 1: --light plans every fast job but the skipped ones, runs the census counts only, and logs the mode", (t) => {
  const jobs = FAST_GATE_STEPS.map(({ job }) => job);
  const plan = preflightStepLogPlan(["--light"], true);
  assert.deepEqual(plan.fastJobs, jobs.filter((job) => !LIGHT_GATE_SKIPPED_JOBS.includes(job)));
  assert.deepEqual(plan.lightSkipped, [...LIGHT_GATE_SKIPPED_JOBS]);
  assert.equal(preflightStepLogPlan([], true).lightSkipped, undefined, "the full plan is unchanged");
  assert.deepEqual(preflightStepLogPlan([], true).fastJobs, jobs);
  assert.deepEqual(preflightStepLogPlan(["--light", "--no-fast"], true).fastJobs, [], "no fast tier, nothing to lighten");

  const steps = FAST_GATE_STEPS.filter(({ job }) => ["rule-checks", "cli-reference", "census-precheck"].includes(job));
  const run = (light: boolean) => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const spawn: PreflightSpawn = (_file, args, opts) => {
      calls.push({ args: [...args], env: opts?.env });
      return { status: 0, stdout: "", stderr: "" };
    };
    const logPath = join(scratch(t, light ? "light" : "full"), "steps.ndjson");
    const stepLog = createPreflightStepLog(logPath);
    const planned = preflightStepLogPlan(light ? ["--light"] : [], true);
    stepLog.plan(planned.phases, planned.fastJobs, planned.lightSkipped);
    const prior = process.env.RMD_AUTHOR_CENSUS_ANSWERED;
    delete process.env.RMD_AUTHOR_CENSUS_ANSWERED;
    try {
      runPreflightFast(REPO_ROOT, { steps, spawn, stepLog, ...(light ? { light: true } : {}) });
    } finally {
      if (prior !== undefined) process.env.RMD_AUTHOR_CENSUS_ANSWERED = prior;
    }
    const read = readPreflightStepLog(logPath);
    assert.ok(Array.isArray(read));
    return { calls, records: read, logPath };
  };

  const light = run(true);
  assert.equal(light.calls.some((c) => c.args.some((a) => a.endsWith("list-rule-suites.mjs"))), false, "rule-checks is not run");
  const census = light.calls.filter((c) => c.args.some((a) => a.endsWith("census-precheck.mjs")));
  assert.equal(census.length, 1);
  assert.ok(census[0].args.includes("--counts-only"), "the census answers its cheap counts only");
  assert.equal(census[0].env?.[CENSUS_COUNTS_LOG_ENV], light.logPath, "and logs them to the step log");
  const first = light.records[0] as { plan: { light?: boolean; skipped_jobs?: string[] } };
  assert.equal(first.plan.light, true, "the plan record names the light mode");
  assert.deepEqual(first.plan.skipped_jobs, [...LIGHT_GATE_SKIPPED_JOBS], "and the skipped jobs");
  assert.deepEqual(light.records.filter((r) => typeof r.job === "string").map((r) => r.job), ["cli-reference"], "a skipped job leaves no record");

  const full = run(false);
  assert.ok(full.calls.some((c) => c.args.some((a) => a.endsWith("list-rule-suites.mjs"))), "control: the full set still runs rule-checks");
  assert.equal(full.calls.find((c) => c.args.some((a) => a.endsWith("census-precheck.mjs")))!.args.includes("--counts-only"), false, "and the whole census");
});

test("W1-T11818 criterion 2: the gate launches the light mode by default; a failed light unit fails it and all passed units pass it", async (t) => {
  const dir = scratch(t, "launch");
  mkdirSync(join(dir, "bin"));
  const argsFile = join(dir, "args.json");
  writeFileSync(join(dir, "bin", "rmd"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));\n`);
  const sandbox = join(dir, "sandbox");
  writeFileSync(sandbox, `#!${process.execPath}\nconst cp=require('node:child_process');const a=process.argv.slice(2);const at=a.indexOf('--');const r=cp.spawnSync(a[at+1],a.slice(at+2),{stdio:'inherit'});process.exit(r.status??128);\n`);
  chmodSync(join(dir, "bin", "rmd"), 0o755);
  chmodSync(sandbox, 0o755);
  const launched = async (parentEnv: NodeJS.ProcessEnv) => {
    const run = await defaultRunGate(dir, undefined, () => {}, { backstopMs: 20_000 },
      { harnessRoot: dir, parentEnv, contain: () => ({ mode: "sandboxed", file: sandbox, argv: ["--"] }) });
    return { run, args: JSON.parse(readFileSync(argsFile, "utf8")) as string[] };
  };
  const byDefault = await launched({});
  assert.ok(byDefault.args.includes("--light"), `the child is asked for the light set: ${byDefault.args.join(" ")}`);
  assert.equal(byDefault.run.gateMode, "light");

  const passed = await gate(lightRun());
  assert.equal(passed.kind, "pass");
  const fields = preopenGateLedgerFields(passed);
  assert.equal(fields.gate_mode, "light", "the row names the light mode");
  assert.deepEqual(fields.light_skipped_jobs, [...LIGHT_GATE_SKIPPED_JOBS], "and the jobs it skipped");
  assert.equal(fields.light_miss, false, "a light run claims no miss against a full run that never happened");
  assert.equal(fields.light_would_save_ms, undefined, "and no saving");

  const failedUnit = await gate(lightRun({ exitCode: 1, summary: { failedSteps: ["cli-reference"] }, stepLog: lightLog({ "cli-reference": { ok: false } }) }));
  assert.equal(failedUnit.kind, "fail");
  assert.deepEqual(failedUnit.kind === "fail" ? failedUnit.failedSteps : [], ["cli-reference"]);
  const missedByExit = await gate(lightRun({ stepLog: lightLog({ "phase:default": { ok: false, failed: ["typecheck"] } }) }));
  assert.equal(missedByExit.kind, "fail", "a failed unit fails the gate even if the exit status missed it");
  assert.deepEqual(missedByExit.kind === "fail" ? missedByExit.failedSteps : [], ["typecheck"]);
});

test("W1-T11818 criterion 3: a unit the light step log never recorded, or an unreadable log, is never a pass", async () => {
  const noCounts = await gate(lightRun({ stepLog: lightLog({ [CENSUS_COUNTS_STEP_JOB]: null }) }));
  assert.equal(noCounts.kind, "unmeasured");
  assert.match(noCounts.kind === "unmeasured" ? noCounts.reason : "", new RegExp(`no record of ${CENSUS_COUNTS_STEP_JOB}`));
  const unreadable = await gate(lightRun({ stepLog: { unreadable: "no readable step log (ENOENT)" } }));
  assert.equal(unreadable.kind, "unmeasured");
  assert.match(unreadable.kind === "unmeasured" ? unreadable.reason : "", /ENOENT/);
  const absent = await gate(lightRun({ stepLog: undefined }));
  assert.equal(absent.kind, "unmeasured");
  assert.match(absent.kind === "unmeasured" ? absent.reason : "", /wrote no step log/);
  const killed = await gate(lightRun({ exitCode: null, error: "fast gate exceeded its backstop", deadlineEnforcedBy: "timeout", stepLog: lightLog({ "phase:ci-checks": null }) }));
  assert.equal(killed.kind, "unmeasured", "a backstop kill stays unmeasured, as before");
  assert.deepEqual(preopenGateLedgerFields(killed).light_unreached, ["phase:ci-checks"]);
});

test("W1-T11818 criterion 4: RMD_PREOPEN_GATE=full restores the full gate exactly, with today's launch and row fields", async (t) => {
  const dir = scratch(t, "revert");
  mkdirSync(join(dir, "bin"));
  const argsFile = join(dir, "args.json");
  writeFileSync(join(dir, "bin", "rmd"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));\n`);
  const sandbox = join(dir, "sandbox");
  writeFileSync(sandbox, `#!${process.execPath}\nconst cp=require('node:child_process');const a=process.argv.slice(2);const at=a.indexOf('--');const r=cp.spawnSync(a[at+1],a.slice(at+2),{stdio:'inherit'});process.exit(r.status??128);\n`);
  chmodSync(join(dir, "bin", "rmd"), 0o755);
  chmodSync(sandbox, 0o755);
  const run = await defaultRunGate(dir, undefined, () => {}, { backstopMs: 20_000 },
    { harnessRoot: dir, parentEnv: { [PREOPEN_GATE_MODE_ENV]: "full" }, contain: () => ({ mode: "sandboxed", file: sandbox, argv: ["--"] }) });
  const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
  assert.equal(args.includes("--light"), false, "the full gate is launched without --light");
  assert.ok(args.includes("--fast") && args.includes("--step-log") && args.includes("--sandbox-metrics"), "with today's arguments");
  assert.equal(run.gateMode, undefined);

  const full = await gate({ exitCode: 1, summary: { failedSteps: ["rule-checks"] }, stepLog: lightLog() });
  assert.equal(full.kind, "fail", "the child's own verdict decides, as before");
  const fields = preopenGateLedgerFields(full);
  assert.equal("gate_mode" in fields, false, "a full-gate row carries no light-mode fields");
  assert.equal("light_skipped_jobs" in fields, false);
  assert.equal(fields.light_result, "pass", "the shadow comparison is still recorded beside it");
  const wouldStillPass = await gate({ exitCode: 0, stepLog: lightLog() });
  assert.equal(wouldStillPass.kind, "pass");
  assert.equal(preopenGateLedgerFields(wouldStillPass).light_would_save_ms !== undefined, true, "and the saving is still measured against the full run");
});
