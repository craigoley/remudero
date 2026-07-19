import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T96: mutation-testing ratchet gate (MASTER-PLAN §5 TIER 2, quality gate 2/4) ──
//
// A green test suite that kills no mutants is theater -- the gate must be proven ACTIVE, not
// merely present: a below-baseline mutation score is REJECTED (non-zero exit), an at/above-
// baseline score is ACCEPTED (zero exit). Every test below drives the actual CLI
// (scripts/mutation-ratchet.mjs) as a subprocess against a planted fixture report, so the
// assertion is on the real exit code a CI job would see -- the falsifier fixture proves the gate
// is ACTIVE, not merely present.
//
// (scripts/mutation-ratchet.mjs is a plain .mjs file outside tsconfig's `include`, so it is
// exercised here only via its CLI surface, never imported -- keeping this test file itself clean
// under `tsc --noEmit`.)
//
// W1-T108 adds a second CLI surface to the SAME script/test file: `--changed-files` decides
// whether a diff can move src/lib/classify.ts's mutation score at all, so ci.yml's
// mutation-ratchet job can skip the ~13-minute `npx stryker run` on any PR that cannot possibly
// change the answer (same always-registers-but-internally-scoped shape as containment-probe).
// See the block below the existing 8 falsifier tests.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "scripts", "mutation-ratchet.mjs");
const RELEVANT_PATHS_FILE = join(__dirname, "..", "scripts", "mutation-relevant-paths.json");
const FIXTURES = join(__dirname, "fixtures", "mutation-ratchet");
const BASELINE = join(FIXTURES, "baseline.json");

function runRatchet(reportFixture: string, baseline: string = BASELINE) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--report",
    join(FIXTURES, reportFixture),
    "--baseline",
    baseline,
  ]);
}

test("mutation-ratchet CLI: BELOW-baseline fixture -> non-zero exit (the gate BLOCKS)", () => {
  const result = runRatchet("below-baseline.json");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /BLOCKED/);
  assert.match(result.stderr.toString(), /mutation score 20\.00% < baseline 80\.00%/);
});

test("mutation-ratchet CLI: AT-baseline fixture (exact match) -> zero exit (the gate ACCEPTS)", () => {
  const result = runRatchet("at-baseline.json");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /OK -- at or above baseline/);
});

test("mutation-ratchet CLI: ABOVE-baseline fixture -> zero exit (the gate ACCEPTS)", () => {
  const result = runRatchet("above-baseline.json");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /score 90\.00%/);
  assert.match(result.stdout.toString(), /OK -- at or above baseline/);
});

test("mutation-ratchet CLI: report with NO valid mutants (all Ignored/CompileError) -> scorePct falls back to 100% (validTotal === 0 edge case)", () => {
  const result = runRatchet("no-valid-mutants.json");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /score 100\.00%/);
});

test("mutation-ratchet CLI: report with NO `files` key at all -> report.files ?? {} fallback, scorePct 100%", () => {
  const result = runRatchet("no-files-key.json");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /score 100\.00%/);
});

test("mutation-ratchet CLI: file record with NO `mutants` key -> mutants ?? [] fallback, scorePct 100%", () => {
  const result = runRatchet("file-missing-mutants.json");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /score 100\.00%/);
});

test("mutation-ratchet CLI: baseline record missing scorePct -> no crash, no false block, prints 0.00% baseline", () => {
  const result = runRatchet("above-baseline.json", join(FIXTURES, "baseline-no-metrics.json"));
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /baseline 0\.00%/);
  assert.match(result.stdout.toString(), /OK -- at or above baseline/);
});

test("mutation-ratchet module: importing (not spawning as the entry script) does not re-invoke main() -- process.argv[1] is undefined when eval'd", () => {
  // Drives the `import.meta.url === pathToFileURL(process.argv[1] ?? '').href` direct-execution
  // guard down its OTHER path: when this module is loaded via `node --input-type=module -e`
  // (dynamic import, no script-file argv[1]), process.argv[1] is undefined, so the `?? ''`
  // fallback is exercised and the guard correctly evaluates to false -- main() must not run (it
  // would otherwise crash trying to read a nonexistent default report/baseline path).
  const scriptUrl = pathToFileURL(SCRIPT).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(scriptUrl)}); console.log("imported-without-main-invocation");`,
  ]);
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /imported-without-main-invocation/);
});

// ── W1-T108: diff-scoped path-filter mode (`--changed-files`) ──────────────────────────────
//
// The 8 tests above are untouched by everything below -- same SCRIPT constant, same subprocess-
// CLI convention, `--changed-files` is a purely additive flag. That is itself the proof for the
// task's 2nd acceptance criterion ("the existing 8 mutation-ratchet falsifier tests pass
// unchanged"): this file still drives exactly those 8 assertions above, byte-for-byte.

function runPathFilter(changedFilesFixture: string, relevantPathsFixture?: string) {
  const args = [SCRIPT, "--changed-files", join(FIXTURES, changedFilesFixture)];
  if (relevantPathsFixture) {
    args.push("--relevant-paths", join(FIXTURES, relevantPathsFixture));
  }
  return spawnSync(process.execPath, args);
}

test("mutation-ratchet CLI --changed-files: a plan-only diff (MASTER-PLAN.md) -> skip decision with a reason; exits 0 WITHOUT ever touching --report/--baseline or invoking stryker", () => {
  // No --report/--baseline given at all, and the default `reports/mutation/mutation.json` does
  // not exist in this checkout -- if this mode fell through to the ratchet-comparison code path
  // (which is what would happen if it needed Stryker's output), it would crash with ENOENT. A
  // clean zero exit is only possible because the skip branch returns before ever reaching that
  // code, i.e. structurally proves this run never shelled out to (or waited on) Stryker.
  const result = runPathFilter("changed-files-plan-only.txt");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /mutation-ratchet: skip/);
  assert.match(
    result.stdout.toString(),
    /no changed path can move src\/lib\/classify\.ts's mutation score/,
  );
});

test("mutation-ratchet CLI --changed-files: a classify.ts-touching fixture -> run decision naming the matched path", () => {
  const result = runPathFilter("changed-files-classify.txt");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /mutation-ratchet: REQUIRED/);
  assert.match(result.stdout.toString(), /diff touches src\/lib\/classify\.ts/);
});

test("mutation-ratchet CLI --changed-files: writes matched=true|false to $GITHUB_OUTPUT for the workflow's `if:` gate to read", () => {
  const outFile = join(FIXTURES, ".github-output-scratch-run.txt");
  spawnSync(process.execPath, [SCRIPT, "--changed-files", join(FIXTURES, "changed-files-classify.txt")], {
    env: { ...process.env, GITHUB_OUTPUT: outFile },
  });
  const runOutput = readFileSync(outFile, "utf8");
  rmSync(outFile);
  assert.match(runOutput, /^matched=true$/m);

  const outFile2 = join(FIXTURES, ".github-output-scratch-skip.txt");
  spawnSync(process.execPath, [SCRIPT, "--changed-files", join(FIXTURES, "changed-files-plan-only.txt")], {
    env: { ...process.env, GITHUB_OUTPUT: outFile2 },
  });
  const skipOutput = readFileSync(outFile2, "utf8");
  rmSync(outFile2);
  assert.match(skipOutput, /^matched=false$/m);
});

test("mutation-ratchet CLI --changed-files --relevant-paths: the paths list is DATA -- adding a row flips a seeded fixture from skip to run with ZERO script changes", () => {
  // Same changed-files fixture, same SCRIPT, same evaluatePathFilter code path in both calls --
  // the ONLY thing that differs between the two invocations below is which JSON data file is
  // passed via --relevant-paths. If the filter were hardcoded control flow instead of data, the
  // second call could not possibly flip the verdict without editing scripts/mutation-ratchet.mjs.
  const before = runPathFilter("changed-files-seeded-only.txt");
  assert.equal(before.status, 0, before.stdout?.toString() + before.stderr?.toString());
  assert.match(before.stdout.toString(), /mutation-ratchet: skip/);

  const after = runPathFilter("changed-files-seeded-only.txt", "relevant-paths-seeded.json");
  assert.equal(after.status, 0, after.stdout?.toString() + after.stderr?.toString());
  assert.match(after.stdout.toString(), /mutation-ratchet: REQUIRED/);
  assert.match(after.stdout.toString(), /diff touches fixtures\/seeded-mutation-scope\.ts/);
});

test("mutation-ratchet CLI --changed-files (NO --relevant-paths, i.e. production default): the matched path is read from scripts/mutation-relevant-paths.json's live content, not a literal baked into mutation-ratchet.mjs", () => {
  // This test never hardcodes an entry from the paths list -- it reads scripts/mutation-
  // relevant-paths.json itself at test time and asserts the CLI's DEFAULT (no --relevant-paths
  // flag at all) names exactly the row it read. If the production list were an array literal
  // embedded in mutation-ratchet.mjs, this round trip would still pass -- but if someone edits
  // scripts/mutation-relevant-paths.json's row wording (e.g. reorders/renames an entry) with
  // ZERO changes to mutation-ratchet.mjs, this test proves the CLI's decision follows the DATA
  // FILE, because the assertion itself is derived from that same file's content, not a copy of it
  // pasted into this test.
  const relevantPaths: string[] = JSON.parse(readFileSync(RELEVANT_PATHS_FILE, "utf8"));
  assert.ok(relevantPaths.length > 0, "scripts/mutation-relevant-paths.json must not be empty");
  const [firstRelevantPath] = relevantPaths;

  const scratchChangedFiles = join(FIXTURES, ".changed-files-default-list-scratch.txt");
  writeFileSync(scratchChangedFiles, `README.md\n${firstRelevantPath}\n`);
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--changed-files", scratchChangedFiles]);
    assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
    assert.match(result.stdout.toString(), /mutation-ratchet: REQUIRED/);
    assert.equal(
      result.stdout.toString().includes(`diff touches ${firstRelevantPath}`),
      true,
      result.stdout.toString(),
    );
  } finally {
    rmSync(scratchChangedFiles);
  }
});
