import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── The nightly's per-file runner ─────────────────────────────────────────────────────────────
//
// Stryker's `commandRunner.command` is ONE command for a whole run, with no per-file hook, so a
// single invocation cannot run a different test set per mutated file. That is why the old nightly
// could override `--mutate` across all of src/** while leaving a two-file command in place, and
// why nine scheduled runs reported success at a 0.50% score. The fix is one invocation per mutated
// file, each with a command derived from that file's own DIRECT test importers.
//
// These tests cover the three pieces that makes possible: deriving the mapping, deciding what a
// night can honestly measure (and naming what it cannot), and merging the N reports back into one
// the ratchet reads WITHOUT losing the per-file outcome distributions #1467's validity guard is
// computed from.
//
// scripts/** sits outside tsconfig's `include`, so the module is imported at runtime through the
// repo's existing shim idiom rather than statically -- which also guarantees these assertions run
// against the file the workflow executes, not a copy.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "mutation-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "mutation-ratchet");
const BASELINE_ZERO = join(FIXTURES, "nightly-baseline-zero.json");

type Measure = (testFiles: readonly string[]) => { ms: number; ok: boolean; timedOut: boolean };

const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  deriveDirectImporters: (
    srcModules: readonly string[],
    testFiles: readonly string[],
    readFile: (path: string) => string,
  ) => Map<string, string[]>;
  planNightlyRun: (
    sample: readonly string[],
    importers: Map<string, string[]>,
    opts: { commandBudgetMs: number; measure: Measure },
  ) => {
    included: Array<{ file: string; testFiles: string[]; ms: number }>;
    excluded: Array<{ file: string; reason: string }>;
  };
  buildNightlyStrykerConfig: (
    file: string,
    testFiles: readonly string[],
    opts: { reportPath: string; tempDirName: string },
  ) => Record<string, unknown>;
  mergeReports: (reports: ReadonlyArray<{ files?: Record<string, unknown> }>) => {
    files: Record<string, unknown>;
    collisions: string[];
  };
};

const { deriveDirectImporters, planNightlyRun, buildNightlyStrykerConfig, mergeReports } = mod;

const alwaysFast: Measure = () => ({ ms: 10, ok: true, timedOut: false });

// ── Deriving the mapping ──────────────────────────────────────────────────────────────────────

test("a module is mapped to the test files that import it directly", () => {
  const importers = deriveDirectImporters(
    ["src/lib/alpha.ts", "src/lib/beta.ts"],
    ["test/one.test.ts", "test/two.test.ts"],
    (p) =>
      p === "test/one.test.ts"
        ? 'import { a } from "../src/lib/alpha.js";'
        : 'import { b } from "../src/lib/beta.js";\nimport { a } from "../src/lib/alpha.js";',
  );
  assert.deepEqual(importers.get("src/lib/alpha.ts"), ["test/one.test.ts", "test/two.test.ts"]);
  assert.deepEqual(importers.get("src/lib/beta.ts"), ["test/two.test.ts"]);
});

test("the .js suffix TypeScript writes for its own siblings resolves to the .ts module", () => {
  // Without this the mapping would be empty for the entire repo, since every import is written .js.
  const importers = deriveDirectImporters(
    ["src/lib/alpha.ts"],
    ["test/one.test.ts"],
    () => 'import { a } from "../src/lib/alpha.js";',
  );
  assert.deepEqual(importers.get("src/lib/alpha.ts"), ["test/one.test.ts"]);
});

test("a module no test imports gets no entry rather than an empty one", () => {
  const importers = deriveDirectImporters(
    ["src/lib/alpha.ts", "src/lib/orphan.ts"],
    ["test/one.test.ts"],
    () => 'import { a } from "../src/lib/alpha.js";',
  );
  assert.equal(importers.has("src/lib/orphan.ts"), false);
});

test("an unreadable test file drops its edges instead of aborting the whole derivation", () => {
  const importers = deriveDirectImporters(
    ["src/lib/alpha.ts"],
    ["test/broken.test.ts", "test/one.test.ts"],
    (p) => {
      if (p === "test/broken.test.ts") throw new Error("EACCES");
      return 'import { a } from "../src/lib/alpha.js";';
    },
  );
  assert.deepEqual(importers.get("src/lib/alpha.ts"), ["test/one.test.ts"]);
});

// ── Deciding what a night can honestly measure ────────────────────────────────────────────────

test("a module no test imports directly is excluded and the reason names that", () => {
  const plan = planNightlyRun(["src/lib/orphan.ts"], new Map(), {
    commandBudgetMs: 1000,
    measure: alwaysFast,
  });
  assert.deepEqual(plan.included, []);
  assert.equal(plan.excluded.length, 1);
  assert.match(plan.excluded[0].reason, /imports it directly/);
});

test("a module whose test command exceeds the per-file budget is excluded, not silently run", () => {
  // This is the hot-module case: every mutant pays the command again, so a slow command is what
  // makes a file unaffordable rather than any judgement about the file itself.
  const plan = planNightlyRun(
    ["src/lib/hot.ts"],
    new Map([["src/lib/hot.ts", ["test/a.test.ts", "test/b.test.ts"]]]),
    { commandBudgetMs: 500, measure: () => ({ ms: 500, ok: false, timedOut: true }) },
  );
  assert.deepEqual(plan.included, []);
  assert.match(plan.excluded[0].reason, /per-file command budget/);
});

test("a module whose importers fail on unmutated source is excluded rather than scored", () => {
  const plan = planNightlyRun(
    ["src/lib/red.ts"],
    new Map([["src/lib/red.ts", ["test/red.test.ts"]]]),
    { commandBudgetMs: 1000, measure: () => ({ ms: 20, ok: false, timedOut: false }) },
  );
  assert.deepEqual(plan.included, []);
  assert.match(plan.excluded[0].reason, /unmutated source/);
});

test("a module whose command fits the budget is included with its own importer list", () => {
  const plan = planNightlyRun(
    ["src/lib/ok.ts"],
    new Map([["src/lib/ok.ts", ["test/ok.test.ts"]]]),
    { commandBudgetMs: 1000, measure: alwaysFast },
  );
  assert.deepEqual(plan.excluded, []);
  assert.deepEqual(plan.included[0].testFiles, ["test/ok.test.ts"]);
});

test("the budget is applied per file, so one unaffordable module never drops the affordable ones", () => {
  const plan = planNightlyRun(
    ["src/lib/hot.ts", "src/lib/ok.ts"],
    new Map([
      ["src/lib/hot.ts", ["test/hot.test.ts"]],
      ["src/lib/ok.ts", ["test/ok.test.ts"]],
    ]),
    {
      commandBudgetMs: 500,
      measure: (files) =>
        files[0] === "test/hot.test.ts"
          ? { ms: 500, ok: false, timedOut: true }
          : { ms: 10, ok: true, timedOut: false },
    },
  );
  assert.deepEqual(
    plan.included.map((e) => e.file),
    ["src/lib/ok.ts"],
  );
  assert.deepEqual(
    plan.excluded.map((e) => e.file),
    ["src/lib/hot.ts"],
  );
});

// ── The generated config ──────────────────────────────────────────────────────────────────────

test("the generated config runs the mutated file's own importers and mutates only that file", () => {
  const cfg = buildNightlyStrykerConfig("src/lib/alpha.ts", ["test/one.test.ts", "test/two.test.ts"], {
    reportPath: "reports/mutation/nightly/alpha.json",
    tempDirName: ".stryker-tmp-alpha",
  }) as { mutate: string[]; commandRunner: { command: string } };
  assert.deepEqual(cfg.mutate, ["src/lib/alpha.ts"]);
  assert.match(cfg.commandRunner.command, /test\/one\.test\.ts test\/two\.test\.ts$/);
});

test("the generated config carries no incremental cache, so a night describes only that night", () => {
  // The single-run nightly accumulated across nights: its valid-mutant count grew 25,223 to 27,017
  // over two nights of a supposedly rotating sample, which made the number neither a sample score
  // nor a tree score. Per-file runs would additionally carry each other's state.
  const cfg = buildNightlyStrykerConfig("src/lib/alpha.ts", ["test/one.test.ts"], {
    reportPath: "r.json",
    tempDirName: ".t",
  });
  assert.equal("incremental" in cfg, false);
  assert.equal("incrementalFile" in cfg, false);
});

test("each generated config gets its own temp dir and report path, so parallel runs cannot collide", () => {
  const a = buildNightlyStrykerConfig("src/lib/a.ts", ["test/a.test.ts"], {
    reportPath: "reports/a.json",
    tempDirName: ".stryker-tmp-a",
  }) as { tempDirName: string; jsonReporter: { fileName: string } };
  const b = buildNightlyStrykerConfig("src/lib/b.ts", ["test/b.test.ts"], {
    reportPath: "reports/b.json",
    tempDirName: ".stryker-tmp-b",
  }) as { tempDirName: string; jsonReporter: { fileName: string } };
  assert.notEqual(a.tempDirName, b.tempDirName);
  assert.notEqual(a.jsonReporter.fileName, b.jsonReporter.fileName);
});

// ── Merging N reports without losing what the validity guard reads ────────────────────────────

test("merging keeps every file's own mutant list rather than flattening to one score", () => {
  const merged = mergeReports([
    { files: { "src/a.ts": { mutants: [{ status: "Killed" }] } } },
    { files: { "src/b.ts": { mutants: [{ status: "Survived" }, { status: "Survived" }] } } },
  ]);
  assert.deepEqual(Object.keys(merged.files).sort(), ["src/a.ts", "src/b.ts"]);
  assert.equal((merged.files["src/b.ts"] as { mutants: unknown[] }).mutants.length, 2);
});

test("two reports claiming the same mutated file are a named collision, never a silent overwrite", () => {
  const merged = mergeReports([
    { files: { "src/a.ts": { mutants: [{ status: "Killed" }] } } },
    { files: { "src/a.ts": { mutants: [{ status: "Survived" }] } } },
  ]);
  assert.deepEqual(merged.collisions, ["src/a.ts"]);
});

// ── The CLI, driven end to end ────────────────────────────────────────────────────────────────

function runNightly(args: string[]) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--nightly-ratchet",
    "--baseline",
    BASELINE_ZERO,
    ...args,
  ]);
}

function reportDirWith(fixtures: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "mutation-merge-"));
  for (const f of fixtures) writeFileSync(join(dir, f), readFileSync(join(FIXTURES, f), "utf8"));
  return dir;
}

test("a directory of per-file reports is merged and judged as one run", () => {
  const dir = reportDirWith(["real-runner-reached.json", "real-runner-unreached.json"]);
  const r = runNightly([
    "--report-dir",
    dir,
    "--mutate-scope",
    "src/lib/classify.ts,src/lib/dispatch-governor.ts",
  ]);
  assert.match(r.stdout.toString(), /merged 2 per-file report\(s\)/);
  assert.match(r.stdout.toString(), /2 file\(s\) judged/);
});

test("merging preserves the per-file outcomes the validity guard is computed from", () => {
  // The load-bearing property. If the merge flattened to a single score, the unreached file would
  // vanish into an aggregate that still shows 82 caught mutants and the run would certify.
  const dir = reportDirWith(["real-runner-reached.json", "real-runner-unreached.json"]);
  const r = runNightly([
    "--report-dir",
    dir,
    "--mutate-scope",
    "src/lib/classify.ts,src/lib/dispatch-governor.ts",
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr.toString(), /dispatch-governor\.ts -- 36 valid mutant\(s\), 0 caught/);
});

test("a merged run of reached files only is accepted", () => {
  const dir = reportDirWith(["real-runner-reached.json"]);
  const r = runNightly(["--report-dir", dir, "--mutate-scope", "src/lib/classify.ts"]);
  assert.equal(r.status, 0, r.stdout?.toString() + r.stderr?.toString());
  assert.match(r.stdout.toString(), /NIGHTLY OK -- at or above baseline/);
});

test("a run that judged no file at all is refused as vacuous rather than scored", () => {
  // Every sampled file can legitimately be excluded by the plan, which leaves an empty report
  // directory and a score of 100% over an empty set.
  const dir = mkdtempSync(join(tmpdir(), "mutation-merge-empty-"));
  const r = runNightly(["--report-dir", dir]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr.toString(), /VACUOUS RUN/);
});

test("two per-file reports claiming the same mutated file are refused rather than merged over", () => {
  // The plan is meant to mutate each file exactly once, so a duplicate means the plan or the
  // report directory is wrong -- and taking whichever landed second would hide one run's outcome
  // from the validity guard entirely.
  const dir = mkdtempSync(join(tmpdir(), "mutation-merge-dup-"));
  const body = readFileSync(join(FIXTURES, "real-runner-reached.json"), "utf8");
  writeFileSync(join(dir, "a.json"), body);
  writeFileSync(join(dir, "b.json"), body);
  const r = runNightly(["--report-dir", dir, "--mutate-scope", "src/lib/classify.ts"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr.toString(), /claim the same mutated file/);
  assert.match(r.stderr.toString(), /src\/lib\/classify\.ts/);
});

test("an absent report directory is a named failure, never a pass", () => {
  const r = runNightly(["--report-dir", join(tmpdir(), "definitely-not-here-mutation")]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr.toString(), /report directory absent or unreadable/);
});

// ── The plan, run against this repo's real tree ───────────────────────────────────────────────

test("planning without its required inputs refuses by name instead of planning nothing quietly", () => {
  // A plan step that silently produced zero configs would hand the ratchet an empty report
  // directory, and "no files to judge" is not the same fact as "the arguments were missing".
  const r = spawnSync(process.execPath, [SCRIPT, "--nightly-plan", "--night-index", "0"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr.toString(), /--nightly-plan requires --files/);
});

test("planning against the real tree emits a config whose command imports the file it mutates", () => {
  // Not a synthetic mapping: this drives --nightly-plan over the repo's own src/ and test/ files
  // and then checks the generated command against the mutated module, which is the property the
  // whole change exists to establish.
  const planDir = mkdtempSync(join(tmpdir(), "mutation-plan-"));
  const filesList = join(planDir, "files.txt");
  const testList = join(planDir, "tests.txt");
  writeFileSync(filesList, "src/lib/runbook-coverage.ts\n");
  writeFileSync(testList, readdirSync(join(__dirname)).filter((n) => n.endsWith(".test.ts")).map((n) => `test/${n}`).join("\n"));

  // GITHUB_OUTPUT is pinned to a temp file rather than inherited: on a CI runner the real one is
  // set, and a subprocess writing into the live step output would be a side effect this test has
  // no business having. It also makes the workflow handoff below assertable off a runner.
  const outFile = join(planDir, "github-output.txt");
  const r = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--nightly-plan",
      "--files",
      filesList,
      "--test-files",
      testList,
      "--night-index",
      "0",
      "--plan-dir",
      planDir,
    ],
    { env: { ...process.env, GITHUB_OUTPUT: outFile } },
  );
  assert.equal(r.status, 0, r.stdout?.toString() + r.stderr?.toString());

  // The workflow's run loop reads `configs`, and the ratchet's validity scope reads `mutate` --
  // which must carry the INCLUDED files only, or the guard would fail on files the plan already
  // declined to measure and named.
  const outputs = readFileSync(outFile, "utf8");
  assert.match(outputs, /^configs=.*\.stryker\.json$/m);
  assert.match(outputs, /^mutate=src\/lib\/runbook-coverage\.ts$/m);
  assert.match(outputs, /^included=1$/m);

  const configs = readdirSync(planDir).filter((n) => n.endsWith(".stryker.json"));
  assert.equal(configs.length, 1, `expected one generated config, got ${configs.join(",")}`);
  const cfg = JSON.parse(readFileSync(join(planDir, configs[0]), "utf8")) as {
    mutate: string[];
    commandRunner: { command: string };
  };
  assert.deepEqual(cfg.mutate, ["src/lib/runbook-coverage.ts"]);
  assert.match(cfg.commandRunner.command, /test\/runbook-coverage\.test\.ts/);
});
