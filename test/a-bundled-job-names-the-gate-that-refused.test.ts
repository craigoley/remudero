import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

// W1-T3720 — A BUNDLED JOB REPORTED UNDER ONE GATE'S NAME WHILE ANOTHER GATE REFUSED. MEASURED
// 2026-09-17 on five PRs: the `comment-load-ratchet` check run was red while comment-load-ratchet
// printed OK and `expiring-fixture-census: BLOCKED` was the real refusal. These tests pin the
// derivation (scripts/bundled-gate-report.mjs) AND the real ci.yml reporting step that uses it,
// executed with a stub `gh`, so a later edit to either is what they check.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
type Constituent = { id: string; outcome: string; report?: string };
type Described = { name: string; conclusion: string; title: string; refusedBy: string[] };
type Mod = {
  refusedGateNames: (text: string | undefined) => string[];
  parseConstituent: (arg: string, checkName: string) => Constituent;
  describeBundledCheck: (checkName: string, constituents: Constituent[]) => Described;
  main: (argv: string[], opts?: { env?: Record<string, string | undefined>; log?: (s: string) => void }) => number;
};
// `scripts/**` is outside tsconfig's include, so the real module is loaded through a runtime import —
// INSIDE each test, so on a tree without the script each test FAILS rather than the file failing to load.
const loadModule = async (): Promise<Mod> => (await import(pathToFileURL(join(REPO_ROOT, "scripts", "bundled-gate-report.mjs")).href)) as Mod;

const COMMENT_LOAD_OK =
  "comment-load-ratchet: OK -- 354 measured file(s), 71142 comment lines against 143033 code lines (33.2%); none over its ceiling, no added block over 25 lines.";
const CENSUS_BLOCKED =
  "::error title=expiring-fixture-census::expiring-fixture-census: BLOCKED -- 1 fixture(s) CROSS their threshold within 7 day(s)\n" +
  "expiring-fixture-census: BLOCKED -- 1 fixture(s) CROSS their threshold within 7 day(s)";

/** Run the REAL ci.yml reporting step under bash with a recording `gh` stub. */
function runReporter(outcomes: Record<string, string>, reports: Record<string, string>): { status: number | null; calls: Array<{ name: string; conclusion: string; title: string }>; stdout: string; stderr: string } {
  const workflow = parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: { commitlint: { steps: Array<{ env?: Record<string, string>; run?: string }> } };
  };
  const reporter = workflow.jobs.commitlint.steps.find((step) => step.run?.includes("report()"));
  assert.ok(reporter?.run && reporter.env, "ci.yml's commitlint job must carry the report() step");
  const root = mkdtempSync(join(tmpdir(), "rmd-bundled-gate-"));
  try {
    for (const [id, text] of Object.entries(reports)) writeFileSync(join(root, `${id}.log`), text);
    const stub = `gh() { printf '%s\\n' "$*" >> "$GH_LOG_FILE"; }\nsleep() { :; }\n`;
    const outcomeEnv = Object.fromEntries(Object.keys(reporter.env).filter((k) => k.startsWith("OUTCOME_")).map((k) => [k, outcomes[k] ?? "success"]));
    const logFile = join(root, "calls");
    writeFileSync(logFile, "");
    const run = spawnSync("bash", ["-c", stub + reporter.run], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...outcomeEnv, GITHUB_REPOSITORY: "owner/repo", HEAD_SHA: "abc123", POSTING_JOB_ID: "1", GATE_REPORT_DIR: root, GH_LOG_FILE: logFile },
    });
    const calls = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => ({
      name: /-f name=(\S+) /.exec(line)?.[1] ?? "",
      conclusion: /-f conclusion=(\S+) /.exec(line)?.[1] ?? "",
      title: /-f output\[title\]=(.*?) -f output\[summary\]=/.exec(line)?.[1] ?? "",
    }));
    return { status: run.status, calls, stdout: run.stdout, stderr: run.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T3720: a bundled job names the gate that refused, not the job", async () => {
  const mod = await loadModule();
  const described = mod.describeBundledCheck("comment-load-ratchet", [
    { id: "comment-load-ratchet", outcome: "success", report: COMMENT_LOAD_OK },
    { id: "expiring-fixture-census", outcome: "failure", report: CENSUS_BLOCKED },
    { id: "console-parity", outcome: "success" },
  ]);
  assert.equal(described.conclusion, "failure");
  assert.equal(described.title, "expiring-fixture-census");
  // FALSIFIER: the name comes from the report's own first token, not a gate-to-job table. A step
  // whose id no table would map, reporting a gate no table knows, is still named by its report.
  assert.equal(
    mod.describeBundledCheck("comment-load-ratchet", [{ id: "step-7", outcome: "failure", report: "##[error]web-vitals-ratchet: BLOCKED -- p95 over budget" }]).title,
    "web-vitals-ratchet",
  );
  // A gate merely QUOTED mid-line is not a refusal; a failing step whose report names no gate falls
  // back to its own step id rather than to the bundle's name.
  assert.deepEqual(mod.refusedGateNames("see comment-load-ratchet: BLOCKED in the docs"), []);
  assert.equal(mod.describeBundledCheck("depcruise", [{ id: "cycle-ratchet", outcome: "failure", report: "TypeError: boom" }]).title, "cycle-ratchet");

  // End to end through the real workflow step: the check run is posted as `comment-load-ratchet`
  // (the required context) and TITLED by the gate that actually refused.
  const run = runReporter(
    { OUTCOME_EXPIRING_FIXTURE_CENSUS: "failure" },
    { "comment-load-ratchet": COMMENT_LOAD_OK, "expiring-fixture-census": CENSUS_BLOCKED },
  );
  assert.equal(run.status, 0, run.stderr);
  const posted = run.calls.find((c) => c.name === "comment-load-ratchet");
  assert.deepEqual(posted, { name: "comment-load-ratchet", conclusion: "failure", title: "expiring-fixture-census" });
  assert.match(run.stdout, /reported comment-load-ratchet = failure .*title: expiring-fixture-census/);
});

test("W1-T3720: two refusing gates are both named", async () => {
  const mod = await loadModule();
  const both = mod.describeBundledCheck("comment-load-ratchet", [
    { id: "comment-load-ratchet", outcome: "success", report: COMMENT_LOAD_OK },
    { id: "expiring-fixture-census", outcome: "failure", report: CENSUS_BLOCKED },
    // console-parity's own report carries no `BLOCKED` headline, so it is named by its step id.
    { id: "console-parity", outcome: "failure", report: "console-parity: 41 COMMANDS verb(s) — 30 console-routed, 10 cli-only, 1 unmapped." },
  ]);
  assert.deepEqual(both.refusedBy, ["console-parity", "expiring-fixture-census"]);
  assert.equal(both.title, "console-parity, expiring-fixture-census");
  // Two refusals inside ONE step's report are both named too — never the first one found.
  assert.deepEqual(mod.refusedGateNames("a-gate: BLOCKED -- x\nb-gate: OK -- y\n##[error]c-gate: BLOCKED -- z\na-gate: BLOCKED -- again"), ["a-gate", "c-gate"]);

  const run = runReporter(
    { OUTCOME_EXPIRING_FIXTURE_CENSUS: "failure", OUTCOME_CONSOLE_PARITY: "failure" },
    { "expiring-fixture-census": CENSUS_BLOCKED },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls.find((c) => c.name === "comment-load-ratchet"), {
    name: "comment-load-ratchet",
    conclusion: "failure",
    title: "console-parity, expiring-fixture-census",
  });
});

test("W1-T3720: a passing bundled job keeps its job name", async () => {
  const mod = await loadModule();
  // Even a passing step whose report text says BLOCKED (a signal-only gate) renames nothing: the
  // step's OUTCOME is the verdict, the report only supplies a name once the step has failed.
  const passing = mod.describeBundledCheck("comment-load-ratchet", [
    { id: "comment-load-ratchet", outcome: "success", report: "comment-load-ratchet: BLOCKED -- advisory only" },
    { id: "expiring-fixture-census", outcome: "skipped" },
    { id: "console-parity", outcome: "success" },
  ]);
  assert.deepEqual(passing, { name: "comment-load-ratchet", conclusion: "success", title: "comment-load-ratchet", refusedBy: [] });
  assert.deepEqual(mod.parseConstituent("success", "leak-grep"), { id: "leak-grep", outcome: "success" });

  // Through the real step: on an all-green run EVERY posted check run is titled by its own name.
  const run = runReporter({}, { "comment-load-ratchet": "comment-load-ratchet: BLOCKED -- advisory only" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.calls.length >= 16, `expected every gate posted, saw ${run.calls.length}`);
  for (const call of run.calls) assert.deepEqual(call, { name: call.name, conclusion: "success", title: call.name });
});

test("W1-T3720: renaming a bundled report never moves a required context", async () => {
  const mod = await loadModule();
  // The module never returns any NAME but the check's own, whatever the reports say.
  assert.equal(mod.describeBundledCheck("comment-load-ratchet", [{ id: "x", outcome: "failure", report: "web-vitals-ratchet: BLOCKED" }]).name, "comment-load-ratchet");

  const green = runReporter({}, {});
  const allRed = runReporter(
    {
      OUTCOME_COMMITLINT: "failure",
      OUTCOME_CYCLE_RATCHET: "failure",
      OUTCOME_CLAUDE_MD_BUDGET_RATCHET: "failure",
      OUTCOME_COMMENT_LOAD_RATCHET: "failure",
      OUTCOME_EXPIRING_FIXTURE_CENSUS: "failure",
      OUTCOME_CONSOLE_PARITY: "failure",
    },
    { "comment-load-ratchet": "web-vitals-ratchet: BLOCKED -- an alien gate", "expiring-fixture-census": CENSUS_BLOCKED },
  );
  assert.equal(allRed.status, 0, allRed.stderr);
  const names = (calls: Array<{ name: string }>) => calls.map((c) => c.name).sort();
  // Every refusal renames only the TITLE: the set of posted check-run names is identical red or green.
  assert.deepEqual(names(allRed.calls), names(green.calls));
  assert.ok(!names(allRed.calls).includes("web-vitals-ratchet") && !names(allRed.calls).includes("expiring-fixture-census"));
  assert.equal(allRed.calls.find((c) => c.name === "comment-load-ratchet")?.title, "console-parity, expiring-fixture-census, web-vitals-ratchet");
  assert.equal(allRed.calls.find((c) => c.name === "depcruise")?.title, "cycle-ratchet");

  // And every name ci-gate.yml requires that this job used to post is still posted.
  const gate = parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci-gate.yml"), "utf8")) as { jobs: Record<string, { env?: Record<string, string> }> };
  const required = JSON.parse(gate.jobs["ci-gate"]!.env!.REQUIRED!) as string[];
  for (const name of ["commitlint", "learnings-budget-ratchet", "depcruise", "comment-load-ratchet"].filter((n) => required.includes(n))) {
    assert.ok(names(allRed.calls).includes(name), `required context ${name} must still be posted under its own name`);
  }
});

test("W1-T3720: the CLI reads each step's report from GATE_REPORT_DIR and prints the title", async () => {
  const mod = await loadModule();
  const dir = mkdtempSync(join(tmpdir(), "rmd-bundled-gate-cli-"));
  try {
    writeFileSync(join(dir, "expiring-fixture-census.log"), CENSUS_BLOCKED);
    const out: string[] = [];
    const args = ["comment-load-ratchet", "comment-load-ratchet=success", "expiring-fixture-census=failure", "console-parity=skipped"];
    assert.equal(mod.main(args, { env: { GATE_REPORT_DIR: dir }, log: (s) => out.push(s) }), 0);
    assert.deepEqual(out, ["expiring-fixture-census"]);
    // No report directory: every failing step is named by its own id.
    out.length = 0;
    mod.main(args, { env: {}, log: (s) => out.push(s) });
    assert.deepEqual(out, ["expiring-fixture-census"]);
    assert.throws(() => mod.main([], { env: {}, log: () => {} }), /usage/);
    // Spawned for real, as the workflow step invokes it.
    const spawned = spawnSync(process.execPath, ["scripts/bundled-gate-report.mjs", ...args], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, GATE_REPORT_DIR: dir } });
    assert.equal(spawned.status, 0, spawned.stderr);
    assert.equal(spawned.stdout.trim(), "expiring-fixture-census");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
