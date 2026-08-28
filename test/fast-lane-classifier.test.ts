// test/fast-lane-classifier.test.ts
//
// W1-T2428 — THE FAST LANE RUNS THE SUITES THAT CAN FAIL. Plan-only merges are 60% of recent
// merges and 58.7% of CI spend (measured 2026-08-27: mean 1,873s/merge, `ci` 685s +
// `coverage-ratchet` 1,187s), yet the suites that can actually fail on a plan-only or docs-only
// diff are a knowable subset — no `src/**`/`test/**` file moved. scripts/diff-class.mjs answers
// "what class is this diff?" so ci.yml can skip the rest WITHOUT ever skipping the job itself
// (a conditionally-skipped required check deadlocks merge forever — the #729/skipped-check-
// deadlock discipline this task's rationale, Q4, cites).
//
// WHAT IS REAL HERE: every function under test (`classify`, `parseChangedFiles`, `isDocsPath`,
// `hasRepoRootConstant`, `namesPlanOrDocsPath`, `planReadingSuiteFiles`, `main`) is the PRODUCTION
// function from scripts/diff-class.mjs, imported directly — no seam, nothing mocked. `scripts/**`
// sits outside tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/diff-class.mjs"` is a TS7016 — the same reason
// test/acceptance-author-gate.test.ts reaches its script through a dynamic `import()` off a
// `pathToFileURL` rather than a typed one. The CLI-level tests below drive the real script as a
// subprocess (`node --import tsx scripts/diff-class.mjs`, the same tsx binding that script's own
// header cites from scripts/acceptance-author-gate.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "diff-class.mjs");

const SCRIPT_URL = pathToFileURL(SCRIPT).href;
const mod = (await import(SCRIPT_URL)) as {
  REPO_ROOT: string;
  CLASSES: { PLAN_ONLY: string; DOCS_ONLY: string; SOURCE: string };
  isDocsPath: (path: string) => boolean;
  parseChangedFiles: (rawText: string) => string[];
  classify: (files: unknown) => { class: string; reason: string };
  hasRepoRootConstant: (content: string) => boolean;
  namesPlanOrDocsPath: (content: string) => boolean;
  planReadingSuiteFiles: (root?: string) => string[];
  main: (argv: string[]) => void;
};
const { CLASSES, classify, hasRepoRootConstant, isDocsPath, namesPlanOrDocsPath, parseChangedFiles, planReadingSuiteFiles } = mod;

function tmpFileList(lines: string[]): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-diff-class-"));
  const path = join(dir, "changed-files.txt");
  writeFileSync(path, lines.join("\n"));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
}

// ── acceptance 1: the class comes from the existing canonical predicate, never a fourth ────────
// reimplementation ───────────────────────────────────────────────────────────────────────────

test("acceptance 1: diff-class.mjs imports isInPlanScope/outOfPlanScopeFiles from src/lib/plan-architect.ts, never reimplements scope rules", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(
    source,
    /from ["']\.\.\/src\/lib\/plan-architect\.ts["']/,
    "the classifier must import the canonical predicate module, not restate scope rules itself",
  );
  assert.match(source, /\bisInPlanScope\b|\boutOfPlanScopeFiles\b/, "the classifier must call the real predicate by name");
});

test("acceptance 1: the #3131 control — [MASTER-PLAN.md, docs/ORIENTATION.md, plan/plan-index.json] is PLAN_ONLY per the real predicate", () => {
  // Measured in this task's rationale (Q1): isInPlanScope returns true for all three of #3131's
  // real file list, and outOfPlanScopeFilesInDiff returns [] — this is the POSITIVE control that
  // the classifier's PLAN_ONLY verdict traces to that exact predicate, not a looser stand-in.
  const result = classify(["MASTER-PLAN.md", "docs/ORIENTATION.md", "plan/plan-index.json"]);
  assert.equal(result.class, CLASSES.PLAN_ONLY);
});

test("acceptance 1: the sweep.ts control — a src/lib/sweep.ts diff is SOURCE, both directions agree", () => {
  // Rationale's control: on a src/lib/sweep.ts diff, isInPlanScope-based and nonPlanFilesInDiff-
  // based scope checks both answer ["src/lib/sweep.ts"] — the split between the three existing
  // predicates is real, not a broken call, and the classifier must land on the answer they agree
  // on for this input.
  const result = classify(["src/lib/sweep.ts"]);
  assert.equal(result.class, CLASSES.SOURCE);
});

// ── acceptance 2: on any error or an undeterminable class the lane runs everything ─────────────

test("acceptance 2: a non-array/null/undefined file list is undeterminable and resolves to SOURCE", () => {
  assert.equal(classify(undefined).class, CLASSES.SOURCE);
  assert.equal(classify(null).class, CLASSES.SOURCE);
  assert.equal(classify("not-an-array").class, CLASSES.SOURCE);
  assert.equal(classify(42).class, CLASSES.SOURCE);
});

test("acceptance 2: classify() never throws — an internal error (a malformed entry) is caught and fails closed to SOURCE", () => {
  // A non-string entry makes isInPlanScope's own `.startsWith` throw — classify() must catch
  // this INSIDE itself (the module's whole FAIL CLOSED contract is that this function never
  // propagates), not merely happen to avoid the case.
  assert.doesNotThrow(() => classify(["plan/tasks.yaml", null as unknown as string]));
  const result = classify(["plan/tasks.yaml", null as unknown as string]);
  assert.equal(result.class, CLASSES.SOURCE);
  assert.match(result.reason, /threw|error/i, "the reason must name that this was an internal-error path, not a normal SOURCE verdict");
});

test("acceptance 2 (CLI): an unreadable --changed-files path still exits 0 and prints SOURCE, never crashes the caller", () => {
  const result = runCli(["--changed-files", join(REPO_ROOT, "definitely-does-not-exist.txt")]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), CLASSES.SOURCE);
});

test("acceptance 2 (CLI): --list-plan-reading-suites failing (bad root) exits non-zero and prints NOTHING, never a trusted empty list", () => {
  // Simulate an enumeration failure by pointing REPO_ROOT-relative test/ at a path that does not
  // exist -- done here by running the CLI from a cwd with no test/ dir at all via a broken
  // require is impractical for a real script (it derives REPO_ROOT from import.meta.url, not
  // cwd), so this proves the CONTRACT at the unit level instead: an unreadable root must throw
  // out of planReadingSuiteFiles, which the CLI catches and reports as a hard failure with an
  // EMPTY stdout, never a false "these zero suites are all that matter".
  assert.throws(() => planReadingSuiteFiles(join(REPO_ROOT, "no-such-directory-at-all")));
});

test(
  "acceptance 2 (CLI, real process boundary): --list-plan-reading-suites exits 1 and prints NOTHING on stdout when enumeration throws",
  () => {
    // Drives main()'s own try/catch (scripts/diff-class.mjs's --list-plan-reading-suites branch)
    // as a REAL subprocess, not merely the unit-level throw proven just above. The chmod-based
    // approach (making a real test/ file unreadable) was rejected here: test/host-capability-
    // fixtures.test.ts ratchets every chmodSync call site in test/ against a declared allowlist,
    // and this task's declared file scope (W1-T1227) does not include that guard file. Instead,
    // this uses the CLI's TEST-ONLY `--plan-reading-root` flag (see scripts/diff-class.mjs's
    // main()) to point the real enumeration at a directory that genuinely does not exist, so
    // readdirSync inside planReadingSuiteFiles throws for real — exercising the CLI's catch block
    // (both console.error lines, process.exitCode = 1) byte-for-byte as CI would hit it.
    const result = runCli(["--list-plan-reading-suites", "--plan-reading-root", join(REPO_ROOT, "no-such-directory-at-all")]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, "", "a failed enumeration must print NOTHING on stdout, never a false empty-but-trusted list");
    assert.match(result.stderr, /diff-class: FAILED to enumerate the plan-reading suite set/);
    assert.match(result.stderr, /printing NOTHING — a caller reading zero lines here must fail closed/);
  },
);

// ── acceptance 3: an empty file list runs everything rather than reading as plan-only ──────────

test("acceptance 3: classify([]) is SOURCE, not PLAN_ONLY", () => {
  const result = classify([]);
  assert.equal(result.class, CLASSES.SOURCE);
  assert.match(result.reason, /empty/i);
});

test("acceptance 3 (CLI): an empty --changed-files file classifies as SOURCE", () => {
  const list = tmpFileList([]);
  try {
    const result = runCli(["--changed-files", list.path]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), CLASSES.SOURCE);
  } finally {
    list.cleanup();
  }
});

test("acceptance 3: a file list of only blank lines parses to empty and still classifies SOURCE (positive control on parseChangedFiles)", () => {
  assert.deepEqual(parseChangedFiles("\n\n   \n"), []);
  assert.equal(classify(parseChangedFiles("\n\n   \n")).class, CLASSES.SOURCE);
});

// ── acceptance 4: a diff carrying one source path is classified source whatever else it carries ─

test("acceptance 4: plan + docs + one source path is SOURCE, not PLAN_ONLY or DOCS_ONLY", () => {
  const result = classify(["plan/tasks.yaml", "MASTER-PLAN.md", "docs/foo.md", "src/lib/foo.ts"]);
  assert.equal(result.class, CLASSES.SOURCE);
  assert.match(result.reason, /src\/lib\/foo\.ts/, "the reason should name the offending source path");
});

test("acceptance 4: plan + one source path (no docs at all) is still SOURCE", () => {
  assert.equal(classify(["plan/tasks.yaml", "src/lib/foo.ts"]).class, CLASSES.SOURCE);
});

test("acceptance 4: a single lone source path with nothing else is SOURCE (sanity)", () => {
  assert.equal(classify(["src/lib/foo.ts"]).class, CLASSES.SOURCE);
});

// ── DOCS_ONLY class (not itself an acceptance criterion, but exercised so the SOURCE-forcing
// behavior above is proven against a real second class, not just PLAN_ONLY) ────────────────────

test("DOCS_ONLY: every file is plan-scope-or-docs/, none of it a source path", () => {
  const result = classify(["plan/tasks.yaml", "docs/orientation-notes.md"]);
  assert.equal(result.class, CLASSES.DOCS_ONLY);
});

test("isDocsPath: docs/ prefix only, never a bare .md match (README.md at repo root is NOT a docs path)", () => {
  assert.equal(isDocsPath("docs/foo.md"), true);
  assert.equal(isDocsPath("README.md"), false);
  assert.equal(isDocsPath("src/docs/foo.md"), false);
});

// ── acceptance 5: the plan-reading suites are enumerated from the tree at build time, never ─────
// hand-copied ────────────────────────────────────────────────────────────────────────────────

test("acceptance 5: diff-class.mjs contains no hand-copied array of test file names — it calls readdirSync over test/", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /\breaddirSync\b/, "the enumeration must walk the tree at call time, not read a literal list");
  assert.doesNotMatch(
    source,
    /\[\s*["']test\/[\w-]+\.test\.ts["']\s*,/,
    "a literal array of test/*.test.ts path strings would be exactly the hand-copied list this criterion forbids",
  );
});

test("acceptance 5: CONTROL — test/plan-proposals.test.ts (reads MASTER-PLAN.md off a REPO_ROOT constant) is IN the enumerated set", () => {
  const suites = planReadingSuiteFiles();
  assert.ok(suites.includes("test/plan-proposals.test.ts"), `expected test/plan-proposals.test.ts in: ${suites.slice(0, 5).join(", ")}...`);
});

test("acceptance 5: CONTROL — test/sweep.test.ts (a pure-source suite, no repo-root constant) is NOT in the enumerated set", () => {
  const suites = planReadingSuiteFiles();
  assert.ok(!suites.includes("test/sweep.test.ts"));
  // Positive control on WHY: sweep.test.ts genuinely carries zero repo-root constant, so its
  // exclusion is not a fluke of the plan/docs-path half of the predicate.
  const sweepSource = readFileSync(join(REPO_ROOT, "test", "sweep.test.ts"), "utf8");
  assert.equal(hasRepoRootConstant(sweepSource), false);
});

test("acceptance 5: the enumeration is LIVE tree-scanning, not memoized — a freshly added qualifying fixture file is picked up", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-diff-class-suite-"));
  const testDir = join(dir, "test");
  mkdirSync(testDir, { recursive: true });
  const qualifying = join(testDir, "fixture-newly-added.test.ts");
  const nonQualifying = join(testDir, "fixture-pure-source.test.ts");
  writeFileSync(
    qualifying,
    'const REPO_ROOT = join(__dirname, "..");\nreadFileSync(join(REPO_ROOT, "plan/tasks.yaml"));\n',
  );
  writeFileSync(nonQualifying, 'import { classify } from "../src/lib/classify.ts";\n');
  try {
    const suites = planReadingSuiteFiles(dir);
    assert.deepEqual(suites, ["test/fixture-newly-added.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasRepoRootConstant / namesPlanOrDocsPath: unit-level positive and negative controls", () => {
  assert.equal(hasRepoRootConstant('const REPO_ROOT = join(__dirname, "..");'), true);
  assert.equal(hasRepoRootConstant('readFileSync(join(__dirname, "..", "plan", "tasks.yaml"));'), true);
  assert.equal(hasRepoRootConstant('import { foo } from "../src/lib/foo.ts";'), false);
  assert.equal(namesPlanOrDocsPath('readFileSync(join(REPO_ROOT, "MASTER-PLAN.md"))'), true);
  assert.equal(namesPlanOrDocsPath("readFileSync(join(REPO_ROOT, \"plan\", \"tasks.yaml\"))"), false); // no quoted "plan/" literal
  assert.equal(namesPlanOrDocsPath('const p = "plan/tasks.yaml";'), true);
  assert.equal(namesPlanOrDocsPath('const p = "docs/ORIENTATION.md";'), true);
  assert.equal(namesPlanOrDocsPath('const p = "src/lib/foo.ts";'), false);
});

// ── acceptance 6: every job still registers a check run, so no required check can go absent ────

test("acceptance 6: ci.yml declares no workflow-level `paths:`/`paths-ignore:` filter (would strand ci-gate's REQUIRED wait)", async () => {
  const { readFile } = await import("node:fs/promises");
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.doesNotMatch(ciYml, /\n\s*paths(-ignore)?:/, "a workflow-level paths filter strands ci-gate's REQUIRED wait per this task's rationale, Q4");
});

test("acceptance 6: the coverage-ratchet job body still carries no `if:` anywhere — the fast-lane class check is a step-level BASH guard, never a YAML conditional", async () => {
  const { readFile } = await import("node:fs/promises");
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const jobStart = ciYml.indexOf("coverage-ratchet:");
  assert.notEqual(jobStart, -1, "ci.yml must declare a coverage-ratchet job");
  const nextJobStart = ciYml.indexOf("\n  mutation-ratchet:", jobStart);
  assert.notEqual(nextJobStart, -1, "coverage-ratchet job body must be findable in ci.yml");
  const jobBody = ciYml.slice(jobStart, nextJobStart);
  assert.doesNotMatch(jobBody, /\n\s*if:/, "coverage-ratchet must never gain a job- or step-level `if:` — test/diff-coverage.test.ts pins the same invariant");
  // The class check must still be present, just expressed as bash rather than YAML.
  assert.match(jobBody, /diff-class\.mjs/, "the job must call the classifier");
});

test("acceptance 6: no job in ci.yml gained a NEW diff-dependent job-level `if:` — every `if:` still reads only github.event_name", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse: parseYaml } = await import("yaml");
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const doc = parseYaml(ciYml) as { jobs: Record<string, { if?: string }> };
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    if (job.if === undefined) continue;
    assert.match(job.if, /^github\.event_name == 'pull_request'$/, `job '${jobId}' carries an unexpected job-level if: '${job.if}'`);
  }
});

// ── acceptance 7: each skip names its class and the steps it skipped rather than exiting silently

test("acceptance 7: classify()'s reason string always names WHICH class and WHY, even on the fail-closed paths", () => {
  for (const input of [[], undefined, null, ["plan/tasks.yaml", null as unknown as string]]) {
    const result = classify(input);
    assert.ok(result.reason.length > 10, `reason must be a real explanation, got: '${result.reason}'`);
  }
});

test("acceptance 7 (CI wiring): coverage-ratchet's fast-lane guards write the class and the skipped step to GITHUB_STEP_SUMMARY", async () => {
  const { readFile } = await import("node:fs/promises");
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const jobStart = ciYml.indexOf("coverage-ratchet:");
  const nextJobStart = ciYml.indexOf("\n  mutation-ratchet:", jobStart);
  const jobBody = ciYml.slice(jobStart, nextJobStart);
  assert.match(jobBody, /GITHUB_STEP_SUMMARY/, "a skip must be visible in the job summary, not just a silent exit 0");
  assert.match(jobBody, /class[:=]?\s*\$\{?CLASS/i, "the summary write must name the class, not just say 'skipped'");
});

// ── acceptance 8: no name is removed from the gate's required list by this change ──────────────

test("acceptance 8: every check name ci-gate.yml's REQUIRED list names before this task is still present after it", async () => {
  const { readFile } = await import("node:fs/promises");
  const ciGateYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci-gate.yml"), "utf8");
  const namesBeforeThisTask = [
    "ci",
    "lint-plan",
    "depcruise",
    "containment-probe",
    "coverage-ratchet",
    "mutation-ratchet",
    "jscpd-gate",
    "claims",
    "learnings-budget-ratchet",
    "commitlint",
    "api-client-drift",
    "no-hand-rolled-fetch",
    "scan-pr / osv-scan",
    "License Review",
  ];
  for (const name of namesBeforeThisTask) {
    assert.ok(ciGateYml.includes(`"${name}"`), `ci-gate.yml's REQUIRED list must still name "${name}"`);
  }
});

test("acceptance 8: every job name declared in ci.yml is unchanged by this task (no job renamed or removed)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse: parseYaml } = await import("yaml");
  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const doc = parseYaml(ciYml) as { jobs: Record<string, { name?: string }> };
  const namesBeforeThisTask = [
    "ci",
    "commitlint",
    "leak-grep",
    "coverage-ratchet",
    "mutation-ratchet",
    "learnings-budget-ratchet",
    "jscpd-gate",
    "claims",
    "assertion-discrimination",
    "lint-plan",
    "depcruise",
    "containment-probe",
    "api-client-drift",
    "no-hand-rolled-fetch",
    "task-id-existence",
  ];
  const namesNow = Object.values(doc.jobs).map((j) => j.name);
  for (const name of namesBeforeThisTask) {
    assert.ok(namesNow.includes(name), `ci.yml is missing a job named '${name}' that existed before this task`);
  }
});

// ── CLI-level smoke test: the exact invocation ci.yml uses ─────────────────────────────────────

test("CLI: --list-plan-reading-suites prints one path per line, sorted, all under test/ and ending .test.ts", () => {
  const result = runCli(["--list-plan-reading-suites"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 10, `expected a substantial plan-reading set, got ${lines.length}`);
  for (const line of lines) {
    assert.match(line, /^test\/[^/]+\.test\.ts$/);
  }
  const sorted = [...lines].sort();
  assert.deepEqual(lines, sorted, "the list must be sorted, not enumeration order");
});

test("CLI: classify mode prints exactly one line on stdout, matching one of the three class tokens", () => {
  const list = tmpFileList(["plan/tasks.yaml"]);
  try {
    const result = runCli(["--changed-files", list.path]);
    assert.equal(result.status, 0);
    const lines = result.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${JSON.stringify(lines)}`);
    assert.ok(Object.values(CLASSES).includes(lines[0]));
  } finally {
    list.cleanup();
  }
});

test("CLI: reading the changed-file list from stdin via '-' works the same as a file path", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--changed-files", "-"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: "plan/tasks.yaml\n",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), CLASSES.PLAN_ONLY);
});
