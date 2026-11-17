// W1-T13269 — a cancelled coverage shard names the step its ceiling killed.
// MEASURED 2026-11-16 from the Actions jobs API: on #18947 (run 43965996579) coverage-shard (4/8) spent 20m45s in
// actions/checkout, PASSED "Test with coverage" (23m23s) and was cancelled at the 49m ceiling in "Upload coverage
// shard". On #18949 (run 43968903627) coverage-shard (3/8) spent 20m36s in checkout before its tests. The coverage
// gate printed "THE COVERAGE TESTS DID NOT RUN" for both. The gate now reads the run attempt's job steps and says
// which phase the ceiling hit. This drives the gate step's own bash out of ci.yml with a stubbed `gh`, and the
// script's functions in-process.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
// @ts-expect-error -- plain .mjs script, no type declarations
import { classifyCancelledJob, describeCancelledShards, formatDuration, main, parseJobs } from "#scripts/shard-cancel-phase.mjs";
import { makeTempDir } from "#src/lib/tmp.js";
import { ghStubPath, pathWith } from "#test/helpers/gh-stub.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Step = { id?: string; run?: string };
type Job = { steps?: Step[] };

const HEAD = "a".repeat(40);
const TEST_STEP = "Test with coverage (spec output to the CI log, lcov to a file — src/** only, test/** excluded from the ratio)";

function step(name: string, conclusion: string | null, startedAt: string | null, completedAt: string | null) {
  return { name, status: conclusion === null ? "pending" : "completed", conclusion, started_at: startedAt, completed_at: completedAt };
}

/** #18947's coverage-shard (4/8), step times copied from the jobs API (run 43965996579, job 133678879380). */
const PASSED_THEN_UPLOAD = {
  name: "coverage-shard (4/8)",
  conclusion: "cancelled",
  steps: [
    step("Set up job", "success", "2026-11-16T22:02:12Z", "2026-11-16T22:02:13Z"),
    step("Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "success", "2026-11-16T22:02:13Z", "2026-11-16T22:22:58Z"),
    step("Install (clean, from lockfile)", "success", "2026-11-16T22:23:02Z", "2026-11-16T22:23:07Z"),
    step(TEST_STEP, "success", "2026-11-16T22:23:13Z", "2026-11-16T22:46:36Z"),
    step("Stage this coverage shard for the required-check aggregator", "success", "2026-11-16T22:46:36Z", "2026-11-16T22:51:05Z"),
    step("Upload coverage shard", "cancelled", "2026-11-16T22:51:05Z", "2026-11-16T22:51:11Z"),
  ],
};
/** #18949's coverage-shard (5/8) (run 43968903627): its test step ran to the ceiling. */
const KILLED_IN_TESTS = {
  name: "coverage-shard (5/8)",
  conclusion: "cancelled",
  steps: [
    step("Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "success", "2026-11-16T22:19:33Z", "2026-11-16T22:19:58Z"),
    step(TEST_STEP, "cancelled", "2026-11-16T22:20:24Z", "2026-11-16T23:08:45Z"),
    step("Stage this coverage shard for the required-check aggregator", "skipped", "2026-11-16T23:08:45Z", "2026-11-16T23:08:45Z"),
  ],
};
/** A shard killed while still checking out: its tests never started. */
const KILLED_IN_SETUP = {
  name: "coverage-shard (2/8)",
  conclusion: "cancelled",
  steps: [
    step("Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "cancelled", "2026-11-16T22:02:13Z", "2026-11-16T22:51:10Z"),
    step(TEST_STEP, "skipped", null, null),
  ],
};
const PASSED_SHARD = { name: "coverage-shard (1/8)", conclusion: "success", steps: [step(TEST_STEP, "success", "2026-11-16T22:03:00Z", "2026-11-16T22:30:00Z")] };
const OTHER_JOB = { name: "ci-shard (1/8)", conclusion: "cancelled", steps: [step("Test", "cancelled", "2026-11-16T22:03:00Z", "2026-11-16T22:40:00Z")] };

const ndjson = (...jobs: object[]) => jobs.map((j) => JSON.stringify(j)).join("\n") + "\n";

function gateRun(): string {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> };
  const gate = doc.jobs["coverage-ratchet-required"]?.steps?.find((s) => s.id === "coverage-gate");
  assert.ok(gate?.run, "coverage-ratchet-required has a step with id coverage-gate");
  assert.match(gate.run, /shard-cancel-phase\.mjs/, "the gate asks the phase script, so this suite cannot pass over nothing");
  return gate.run;
}

/** Runs the gate's own bash with the matrix cancelled and the head unchanged. The `gh` stub answers the jobs read
 *  with `jobsBody`, the PR-head read with HEAD, and refuses the run-log read. */
function runCancelledGate(jobsBody: string | undefined): { code: number; out: string } {
  const dir = makeTempDir("w1-t13269-gate-");
  const jobsFile = join(dir, "jobs.ndjson");
  writeFileSync(jobsFile, jobsBody ?? "");
  const jobsArm = jobsBody === undefined ? "exit 1" : `cat '${jobsFile}'`;
  const bin = ghStubPath(`#!/bin/sh\ncase "$*" in\n  *"/jobs"*) ${jobsArm} ;;\n  *"run view"*) exit 1 ;;\n  *) echo ${HEAD} ;;\nesac\n`);
  const scriptPath = join(dir, "gate.sh");
  writeFileSync(scriptPath, gateRun());
  const env = {
    ...process.env,
    PATH: pathWith(bin),
    SHARD_RESULT: "cancelled",
    RUN_HEAD_SHA: HEAD,
    PR_NUMBER: "1",
    GH_REPO_SLUG: "o/r",
    GITHUB_RUN_ID: "43965996579",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKSPACE: REPO_ROOT,
    GITHUB_OUTPUT: join(dir, "github-output"),
  };
  try {
    return { code: 0, out: execFileSync("bash", [scriptPath], { encoding: "utf8", env, cwd: dir }) };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("W1-T13269 criterion 1: a shard cancelled after its tests passed says the tests PASSED, names the step and the slow checkout", () => {
  const r = runCancelledGate(ndjson(PASSED_SHARD, PASSED_THEN_UPLOAD, OTHER_JOB));
  assert.equal(r.code, 1, `an unchanged-head cancellation still blocks:\n${r.out}`);
  assert.match(r.out, /SHARD HANG — the matrix was cancelled/, "the first line the sweep matches is unchanged");
  assert.match(r.out, /coverage-shard \(4\/8\): the tests PASSED \('Test with coverage' succeeded after 23m23s\)/);
  assert.match(r.out, /the ceiling was reached later, in 'Upload coverage shard'/);
  assert.match(r.out, /'Run actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' took 20m45s/);
  assert.doesNotMatch(r.out, /DID NOT RUN/, "a shard whose tests passed must not be reported as tests that did not run");
  assert.doesNotMatch(r.out, /ci-shard \(1\/8\)|coverage-shard \(1\/8\)/, "only cancelled coverage shards are described");
});

test("W1-T13269 criterion 2: a shard killed before its tests started is a setup stall, and one killed in its tests says so", () => {
  const setup = runCancelledGate(ndjson(KILLED_IN_SETUP));
  assert.equal(setup.code, 1, setup.out);
  assert.match(setup.out, /coverage-shard \(2\/8\): killed in 'Run actions\/checkout@\S+', before 'Test with coverage' started/);
  assert.match(setup.out, /a re-run of the shard is expected to pass/);
  const tests = runCancelledGate(ndjson(KILLED_IN_TESTS));
  assert.equal(tests.code, 1, tests.out);
  assert.match(tests.out, /coverage-shard \(5\/8\): killed in 'Test with coverage' after 48m21s/);
  assert.match(tests.out, /SHARD-CANCEL-PHASE: coverage-shard \(5\/8\): tests/);
});

test("W1-T13269 criterion 3: an unreadable or empty jobs read keeps the old did-not-run text and still blocks", () => {
  for (const body of [undefined, "", "not json\n", ndjson(PASSED_SHARD)]) {
    const r = runCancelledGate(body);
    assert.equal(r.code, 1, `the gate must fail closed:\n${r.out}`);
    assert.match(r.out, /SHARD HANG — the matrix was cancelled/);
    assert.match(r.out, /THE COVERAGE TESTS DID NOT RUN to a verdict/);
    assert.match(r.out, /could not be read/);
  }
});

test("W1-T13269: the phase script reads NDJSON, a jobs document and a bare array, and refuses garbage", () => {
  assert.equal(parseJobs(ndjson(PASSED_SHARD, OTHER_JOB))?.length, 2);
  assert.equal(parseJobs(JSON.stringify({ total_count: 1, jobs: [PASSED_SHARD] }))?.length, 1);
  assert.equal(parseJobs(JSON.stringify([PASSED_SHARD, OTHER_JOB]))?.length, 2);
  assert.equal(parseJobs(JSON.stringify(PASSED_THEN_UPLOAD))?.length, 1);
  assert.equal(parseJobs(""), undefined);
  assert.equal(parseJobs(undefined), undefined);
  assert.equal(parseJobs("{\"name\": 3}\n"), undefined);
  assert.equal(parseJobs("{\"name\":\"x\"}\nnot json\n"), undefined);
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(1245), "20m45s");
});

test("W1-T13269: a job whose steps name no test step, or no cancelled step, is unknown, never a guessed phase", () => {
  assert.equal(classifyCancelledJob({ name: "x", steps: [step("Other", "cancelled", null, null)] }, "Test with coverage").phase, "unknown");
  assert.equal(classifyCancelledJob({ name: "x", steps: [step(TEST_STEP, "failure", null, null)] }, "Test with coverage").phase, "unknown");
  assert.equal(classifyCancelledJob({ name: "x" }, "Test with coverage").phase, "unknown");
  const lines = describeCancelledShards([{ name: "coverage-shard (7/8)", conclusion: "cancelled", steps: [] }], "coverage-shard (", "Test with coverage");
  assert.deepEqual(lines, ["  coverage-shard (7/8): the step it was killed in could not be read from its steps.", "SHARD-CANCEL-PHASE: coverage-shard (7/8): unknown"]);
});

test("W1-T13269: the CLI prints unreadable, none, or the phases, and exits 2 only on a usage error", () => {
  const dir = makeTempDir("w1-t13269-cli-");
  const file = join(dir, "jobs.ndjson");
  const log = console.log;
  const err = console.error;
  const seen: string[] = [];
  console.log = (line: string) => void seen.push(line);
  console.error = (line: string) => void seen.push(line);
  try {
    assert.equal(main(["--jobs", file]), 2);
    assert.equal(main(["--jobs", join(dir, "missing"), "--job-prefix", "coverage-shard (", "--test-step", "Test with coverage"]), 0);
    writeFileSync(file, ndjson(PASSED_SHARD));
    assert.equal(main(["--jobs", file, "--job-prefix", "coverage-shard (", "--test-step", "Test with coverage"]), 0);
    writeFileSync(file, ndjson(PASSED_THEN_UPLOAD));
    assert.equal(main(["--jobs", file, "--job-prefix", "coverage-shard (", "--test-step", "Test with coverage"]), 0);
  } finally {
    console.log = log;
    console.error = err;
  }
  assert.ok(seen.some((l) => l.startsWith("usage:")));
  assert.ok(seen.includes("SHARD-CANCEL-PHASE: unreadable"));
  assert.ok(seen.includes("SHARD-CANCEL-PHASE: none"));
  assert.ok(seen.includes("SHARD-CANCEL-PHASE: coverage-shard (4/8): after-tests"));
});

test("W1-T13269: the shipped script runs as a CLI from the repository", () => {
  const dir = makeTempDir("w1-t13269-spawn-");
  const file = join(dir, "jobs.ndjson");
  writeFileSync(file, ndjson(KILLED_IN_SETUP));
  const out = execFileSync(process.execPath, [join(REPO_ROOT, "scripts/shard-cancel-phase.mjs"), "--jobs", file, "--job-prefix", "coverage-shard (", "--test-step", "Test with coverage"], { encoding: "utf8" });
  assert.match(out, /SHARD-CANCEL-PHASE: coverage-shard \(2\/8\): setup/);
});
