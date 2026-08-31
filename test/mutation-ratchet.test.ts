import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ── W1-T1277: a malformed (present but non-number) scorePct must REFUSE at PR time, not silently
// disarm ──
//
// The pre-fix guard was `typeof baseline.scorePct === 'number' && actual.scorePct < baseline...`
// -- any non-number short-circuited the `&&`, so no violation was ever pushed and the run reported
// OK. below-baseline.json's actual score (20%) is below malformed-baseline.json's quoted value
// (80), so a numeric control would BLOCK -- proving the refusal is not just "any malformed value
// happens to pass anyway". The NIGHTLY arm already refuses this shape (see the --nightly-ratchet
// non-numeric scorePct test below); this is the PR-time arm agreeing with it (acceptance
// criterion 3).

test("mutation-ratchet CLI: a scorePct present but not a number refuses instead of passing at PR time, agreeing with the nightly arm (acceptance criterion 3)", () => {
  const result = runRatchet("below-baseline.json", join(FIXTURES, "malformed-baseline.json"));
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /'scorePct' must be a number, got "80"/);
});

test("mutation-ratchet CLI: a malformed scorePct never prints a baseline figure it is not enforcing", () => {
  const result = runRatchet("below-baseline.json", join(FIXTURES, "malformed-baseline.json"));
  assert.doesNotMatch(result.stdout.toString(), /score \d/, result.stdout?.toString() + result.stderr?.toString());
  assert.doesNotMatch(result.stdout.toString(), /OK --/, result.stdout?.toString() + result.stderr?.toString());
});

// ── A well-formed baseline evaluates exactly as it does today (acceptance criterion 5, no value or
// threshold moved) -- BELOW/AT/ABOVE-baseline fixtures above all still exercise the SAME
// evaluateRatchet path and produce byte-identical messages; this test pins that pinning explicitly
// against the production baseline value used elsewhere in this suite (80).

test("mutation-ratchet CLI: a well-formed numeric scorePct baseline still evaluates exactly as before -- no value or threshold moved by the malformed-input fix", () => {
  const result = runRatchet("below-baseline.json");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /mutation score 20\.00% < baseline 80\.00%/);

  const passing = runRatchet("above-baseline.json");
  assert.equal(passing.status, 0, passing.stdout?.toString() + passing.stderr?.toString());
  assert.match(passing.stdout.toString(), /OK -- at or above baseline/);
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

// ── W1-T133: nightly full-scope run owns the global score; the PR gate stays diff-only ─────
//
// Everything above this line is untouched (same SCRIPT constant, same fixtures, same 13
// assertions) -- that IS the proof for this task's 1st acceptance criterion's "the PR job's
// diff-scope trigger is unchanged" clause: this file still drives every prior assertion
// byte-for-byte. The tests below cover the 3 NEW acceptance criteria:
//  (1) the nightly and PR paths resolve DISTINCT scopes, both excluding test/**
//  (2) the nightly scope's sample is deterministic given a seed, and rotates to cover the whole
//      matched set over N nights; a below-baseline sampled score / absent / corrupt report / an
//      unbootstrapped nightly baseline section all BLOCK loudly, never a silent pass
//  (3) test files are never a mutation target in either scope

const REPO_ROOT = join(__dirname, "..");
const STRYKER_CONFIG = join(REPO_ROOT, "stryker.conf.json");
const PROD_NIGHTLY_SCOPE_CONFIG = join(REPO_ROOT, "scripts", "mutation-nightly-scope.json");
const PROD_BASELINE = join(REPO_ROOT, "scripts", "mutation-baseline.json");
const NIGHTLY_CANDIDATES = join(FIXTURES, "nightly-candidates.txt");
const FIXTURE_NIGHTLY_SCOPE_CONFIG = join(FIXTURES, "nightly-scope-config.json");
const NIGHTLY_BASELINE = join(FIXTURES, "nightly-baseline.json");

function resolveScope(configPath: string, filesPath: string = NIGHTLY_CANDIDATES) {
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--resolve-scope",
    "--files",
    filesPath,
    "--config",
    configPath,
  ]);
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  const lines = result.stdout.toString().trim().split("\n");
  const matched = lines[lines.length - 1].split(",").filter(Boolean);
  return matched;
}

test("resolve-scope: the REAL PR gate config (stryker.conf.json) resolves to exactly its declared mutate scope, unchanged by this task", () => {
  const strykerConfig: { mutate: string[] } = JSON.parse(readFileSync(STRYKER_CONFIG, "utf8"));
  assert.deepEqual(strykerConfig.mutate, ["src/lib/classify.ts"], "stryker.conf.json's PR-gate mutate scope must stay exactly W1-T108's shape");

  const matched = resolveScope(STRYKER_CONFIG);
  assert.deepEqual(matched, ["src/lib/classify.ts"]);
});

// W1-T133 LATENCY, ROUND 2: this task's own PR is a `matched: true` PR (it edits scripts/
// mutation-ratchet.mjs + scripts/mutation-baseline.json, both in the trigger's relevant-paths
// list) and was the FIRST PR since W1-T108 to actually drive a real `npx stryker run` through to
// completion -- every prior "matched" run in the wild had died earlier, at the dry-run stage, on
// an unrelated broken fixture. That first real run MEASURED stryker.conf.json's
// `commandRunner.command` (`npm test`, the FULL ~3,000-test Playwright-backed suite, rerun once
// per mutant) blowing past ci-gate's 15-minute required-check ceiling (it was still running past
// the 55-minute mark). test/classify.test.ts and test/block-reason.test.ts are the ONLY two test
// files that import anything from src/lib/classify.ts (verified by grep across test/**), and a
// real Stryker run scoped to exactly those two files reproduced the SAME 108 valid mutants / 70
// killed / 12 timeout / 26 survived / 0 no-coverage split as the recorded baseline in 54 seconds
// -- so scoping the command to them changes nothing about WHAT gets mutated or ratcheted, only
// how fast the PR gate can verify it. This is the assertion that keeps that scope from silently
// drifting back to the full suite (and the latency incident with it).
test("the REAL PR gate config's commandRunner is scoped to exactly the test files that import src/lib/classify.ts -- not the full suite (W1-T133 latency fix)", () => {
  const strykerConfig: { commandRunner: { command: string } } = JSON.parse(readFileSync(STRYKER_CONFIG, "utf8"));
  const command = strykerConfig.commandRunner.command;

  assert.match(command, /\bnode --test\b/, "must invoke node's test runner directly, not `npm test` (the full test/**/*.test.ts glob)");
  assert.match(command, /\btest\/classify\.test\.ts\b/, "must run classify.ts's own dedicated unit test");
  assert.match(command, /\btest\/block-reason\.test\.ts\b/, "must run block-reason.test.ts -- the only OTHER file importing from src/lib/classify.ts");
  assert.equal(command.includes("test/**"), false, "must never fall back to the full test/**/*.test.ts glob -- that is the latency incident this task fixed");

  // WHICH DIRECTION IS ASSERTED, AND WHY ONLY ONE. The property that protects the mutation score
  // is EVERY IMPORTER IS IN THE COMMAND: a test file that exercises classify.ts but sits outside
  // the runner contributes nothing to killing its mutants, and the only symptom is a collapsed
  // score with no reason given (W1-T2524 -- MEASURED at 38.91% against a 75.92% baseline when
  // exactly that happened). That direction is asserted below, derived from the real tree rather
  // than from a hand-kept list: the pair this test used to name verbatim went stale the first
  // time a third file imported classify.ts.
  //
  // THE CONVERSE IS DELIBERATELY NOT ASSERTED -- the command is allowed to LEAD the file it
  // scopes by one PR. stryker.conf.json is on INSTRUMENT_SURFACE (src/lib/review.ts), so it can
  // never ship in the same diff as a src/ change (Standing rule 25, W1-T2521): a new classify
  // test and the scope entry that covers it are STRUCTURALLY two PRs, and the scope entry has to
  // be the one that goes first or the new test lands unmutated. MEASURED, so the lead is not a
  // silent failure: `node --test` given a path that does not exist runs the remaining files and
  // exits 0 (`node --test --import tsx test/block-reason.test.ts test/ghost.test.ts` -> `# pass
  // 15`, `# fail 0`, exit 0), so a leading entry costs a window in which it covers nothing, never
  // a broken mutation run.
  const testFiles = readdirSync(join(REPO_ROOT, "test")).filter((f) => f.endsWith(".test.ts"));
  const classifyImporters = testFiles
    .filter((f) => /from ["'].*classify(\.js)?["']/.test(readFileSync(join(REPO_ROOT, "test", f), "utf8")))
    .sort();
  assert.ok(
    classifyImporters.includes("classify.test.ts") && classifyImporters.includes("block-reason.test.ts"),
    `positive control: the importer sweep must find classify.ts's two known consumers, or it is measuring nothing -- found ${JSON.stringify(classifyImporters)}`,
  );
  for (const importer of classifyImporters) {
    assert.ok(
      new RegExp(`(^|\\s)test/${importer.replace(/\./g, "\\.")}(\\s|$)`).test(command),
      `test/${importer} imports src/lib/classify.ts but is NOT in stryker's commandRunner, so its assertions kill no mutants and the score silently drops -- add it to stryker.conf.json (an instrument-only PR; Standing rule 25 forbids shipping that edit beside a src/ change). Command is: ${command}`,
    );
  }
});

test("resolve-scope: the REAL nightly config (scripts/mutation-nightly-scope.json) resolves to a DISTINCT, wider scope than the PR gate, over the SAME candidate list", () => {
  const prMatched = resolveScope(STRYKER_CONFIG);
  const nightlyMatched = resolveScope(PROD_NIGHTLY_SCOPE_CONFIG);

  assert.notDeepEqual(nightlyMatched, prMatched, "nightly and PR scopes must resolve DISTINCT file sets");
  assert.ok(nightlyMatched.length > prMatched.length, "nightly's src/** scope must cover more files than the PR gate's single classify.ts target");
  assert.ok(nightlyMatched.includes("src/lib/classify.ts"), "the nightly scope must still cover classify.ts (it is part of src/**)");
});

test("resolve-scope: neither the PR scope nor the nightly scope ever matches a test/** fixture path, over a fixture tree mixing src + test files", () => {
  const prMatched = resolveScope(STRYKER_CONFIG);
  const nightlyMatched = resolveScope(PROD_NIGHTLY_SCOPE_CONFIG);

  for (const path of [...prMatched, ...nightlyMatched]) {
    assert.equal(path.startsWith("test/"), false, `${path} must not be a mutation target in either scope`);
  }
  // The fixture candidate list itself DOES include test/** entries -- prove they were actually
  // filtered, not merely absent from the input.
  const candidates = readFileSync(NIGHTLY_CANDIDATES, "utf8").split("\n").filter(Boolean);
  assert.ok(candidates.some((p) => p.startsWith("test/")), "fixture must include at least one test/** path to prove exclusion, not mere absence");
});

test("resolve-scope: a `?` glob segment (globToRegExp's single-char wildcard branch) matches exactly one non-slash character, over the REAL candidate list", () => {
  // `mutation-nightly-scope.json` never happens to use `?`, so this drives globToRegExp's `?`
  // branch (re += '[^/]') directly through a scratch config: "src/lib/classify.t?" must match
  // "src/lib/classify.ts" (the trailing `?` standing in for the single char "s") but must NOT
  // match a path with a different number of trailing characters.
  const questionMarkScope = join(FIXTURES, ".resolve-scope-question-mark-scratch.json");
  writeFileSync(questionMarkScope, JSON.stringify({ mutate: ["src/lib/classify.t?"] }));
  try {
    const matched = resolveScope(questionMarkScope);
    assert.deepEqual(matched, ["src/lib/classify.ts"], "`?` must match exactly one non-slash char, no more, no less");
  } finally {
    rmSync(questionMarkScope);
  }
});

test("resolve-scope: a nightly scope config MISCONFIGURED to include test/** still yields zero test/** matches -- resolveMutateScope()'s hard exclusion cannot be bypassed by data", () => {
  const misconfiguredScope = join(FIXTURES, ".nightly-scope-config-misconfigured-scratch.json");
  writeFileSync(misconfiguredScope, JSON.stringify({ mutate: ["src/**/*.ts", "test/**"], fileCap: 50 }));
  try {
    const matched = resolveScope(misconfiguredScope);
    assert.ok(matched.length > 0, "sanity: src files still matched");
    assert.ok(matched.every((p) => !p.startsWith("test/")), "test/** must be excluded even when the config's own glob asks for it");
  } finally {
    rmSync(misconfiguredScope);
  }
});

test("mutation-ratchet CLI --resolve-scope: missing --files and/or --config -> named loud failure (non-zero exit), never a silent no-op", () => {
  const missingFiles = spawnSync(process.execPath, [SCRIPT, "--resolve-scope", "--config", STRYKER_CONFIG]);
  assert.notEqual(missingFiles.status, 0, missingFiles.stdout?.toString() + missingFiles.stderr?.toString());
  assert.match(missingFiles.stderr.toString(), /--resolve-scope requires --files <path> and --config <path>/);

  const missingConfig = spawnSync(process.execPath, [SCRIPT, "--resolve-scope", "--files", NIGHTLY_CANDIDATES]);
  assert.notEqual(missingConfig.status, 0, missingConfig.stdout?.toString() + missingConfig.stderr?.toString());
  assert.match(missingConfig.stderr.toString(), /--resolve-scope requires --files <path> and --config <path>/);
});

test("mutation-ratchet CLI --nightly-scope: missing --files -> named loud failure (non-zero exit), never a silent no-op", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--nightly-scope", "--night-index", "0"]);
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /--nightly-scope requires --files <candidate-file-list-path>/);
});

function runNightlyScope(nightIndex: number, scopeConfig: string = FIXTURE_NIGHTLY_SCOPE_CONFIG) {
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--nightly-scope",
    "--files",
    NIGHTLY_CANDIDATES,
    "--night-index",
    String(nightIndex),
    "--scope-config",
    scopeConfig,
  ]);
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  const lines = result.stdout.toString().trim().split("\n");
  return lines[lines.length - 1].split(",").filter(Boolean);
}

test("mutation-ratchet CLI --nightly-scope: the same night-index always yields the SAME deterministic sample", () => {
  const first = runNightlyScope(0);
  const second = runNightlyScope(0);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0 && first.length <= 2, "fixture scope-config's fileCap is 2");
});

test("mutation-ratchet CLI --nightly-scope: rotating night-index over a full cycle covers the WHOLE matched set exactly once, zero overlap between nights", () => {
  // The fixture candidate list matches 5 src files against a fileCap of 2 -> groupCount = ceil(5/2) = 3.
  const groups = [runNightlyScope(0), runNightlyScope(1), runNightlyScope(2)];
  for (const group of groups) {
    assert.ok(group.length <= 2, "every night's sample must respect the fileCap");
  }
  const union = groups.flat();
  const expected = resolveScope(FIXTURE_NIGHTLY_SCOPE_CONFIG).sort();
  assert.deepEqual(union.slice().sort(), expected, "3 nights must union back to exactly the matched set");
  assert.equal(new Set(union).size, union.length, "no file may appear in more than one night's sample");

  // Night-index 3 wraps back to night-index 0's group (3 % 3 === 0) -- the rotation is periodic.
  const wrapped = runNightlyScope(3);
  assert.deepEqual(wrapped, groups[0]);
});

test("mutation-ratchet CLI --nightly-scope: a scope config matching ZERO candidates -> sampleForNight's empty-input branch, empty sample, groupCount 0, still exit 0 (no crash, no false REQUIRED)", () => {
  const emptyScope = join(FIXTURES, ".nightly-scope-config-empty-match-scratch.json");
  writeFileSync(emptyScope, JSON.stringify({ mutate: ["nonexistent-dir/**"], fileCap: 2 }));
  try {
    const result = spawnSync(process.execPath, [
      SCRIPT,
      "--nightly-scope",
      "--files",
      NIGHTLY_CANDIDATES,
      "--night-index",
      "0",
      "--scope-config",
      emptyScope,
    ]);
    assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
    const stdout = result.stdout.toString();
    assert.match(stdout, /group 1\/0/);
    assert.match(stdout, /0 file\(s\) sampled from 0 matched/);
    // Do NOT trim() before splitting: sample.join(',') on an empty sample prints an EMPTY line,
    // and trim() would eat that trailing blank line, hiding exactly the thing under test.
    const lines = stdout.split("\n");
    assert.equal(lines[lines.length - 2], "", "the sample line itself must be empty when nothing matched");
  } finally {
    rmSync(emptyScope);
  }
});

test("mutation-ratchet CLI --nightly-scope: writes the sample to $GITHUB_OUTPUT `mutate=...` for the workflow's `npx stryker run --mutate` step", () => {
  const outFile = join(FIXTURES, ".github-output-nightly-scope-scratch.txt");
  spawnSync(process.execPath, [
    SCRIPT,
    "--nightly-scope",
    "--files",
    NIGHTLY_CANDIDATES,
    "--night-index",
    "0",
    "--scope-config",
    FIXTURE_NIGHTLY_SCOPE_CONFIG,
  ], { env: { ...process.env, GITHUB_OUTPUT: outFile } });
  const written = readFileSync(outFile, "utf8");
  rmSync(outFile);
  assert.match(written, /^mutate=.+$/m);
  const mutateLine = written.trim().split("\n").find((l) => l.startsWith("mutate="))!;
  const files = mutateLine.slice("mutate=".length).split(",").filter(Boolean);
  assert.ok(files.every((p) => !p.startsWith("test/")), "the $GITHUB_OUTPUT sample must never include a test/** path");
});

test("mutation-ratchet CLI --nightly-scope: the production scripts/mutation-nightly-scope.json is valid data (a `mutate` array and a numeric `fileCap`)", () => {
  const prodConfig: { mutate: string[]; fileCap: number } = JSON.parse(readFileSync(PROD_NIGHTLY_SCOPE_CONFIG, "utf8"));
  assert.ok(Array.isArray(prodConfig.mutate) && prodConfig.mutate.length > 0);
  assert.equal(typeof prodConfig.fileCap, "number");
  assert.ok(prodConfig.fileCap > 0);
});

function runNightlyRatchet(reportFixture: string, baseline: string = NIGHTLY_BASELINE) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--nightly-ratchet",
    "--report",
    reportFixture.startsWith("/") ? reportFixture : join(FIXTURES, reportFixture),
    "--baseline",
    baseline,
  ]);
}

test("mutation-ratchet CLI --nightly-ratchet: a BELOW-baseline sampled report -> non-zero exit (BLOCKS loudly, never a silent pass)", () => {
  const result = runNightlyRatchet("below-baseline.json");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /NIGHTLY BLOCKED/);
  assert.match(result.stderr.toString(), /mutation score 20\.00% < baseline 80\.00%/);
});

test("mutation-ratchet CLI --nightly-ratchet: an AT/ABOVE-baseline sampled report -> zero exit", () => {
  const result = runNightlyRatchet("above-baseline.json");
  assert.equal(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stdout.toString(), /NIGHTLY score 90\.00%/);
  assert.match(result.stdout.toString(), /NIGHTLY OK -- at or above baseline/);
});

test("mutation-ratchet CLI --nightly-ratchet: an ABSENT Stryker report -> named loud failure (non-zero exit), never a silent pass", () => {
  const result = runNightlyRatchet(join(FIXTURES, "does-not-exist-report.json"));
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /NIGHTLY BLOCKED -- Stryker report absent or unreadable/);
});

test("mutation-ratchet CLI --nightly-ratchet: a CORRUPT (invalid JSON) Stryker report -> named loud failure (non-zero exit), never a silent pass", () => {
  const result = runNightlyRatchet("corrupt-report.json");
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /NIGHTLY BLOCKED -- Stryker report absent or unreadable/);
});

test("mutation-ratchet CLI --nightly-ratchet: a baseline file with NO \"nightly\" section -> named loud failure, never silently defaults to an always-pass floor", () => {
  const result = runNightlyRatchet("above-baseline.json", join(FIXTURES, "nightly-baseline-missing-section.json"));
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /NIGHTLY BLOCKED.*no "nightly" section/);
});

test("mutation-ratchet CLI --nightly-ratchet: a \"nightly\" section with a non-numeric scorePct -> named loud failure, same as a missing section", () => {
  const result = runNightlyRatchet("above-baseline.json", join(FIXTURES, "nightly-baseline-non-numeric.json"));
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /NIGHTLY BLOCKED.*no "nightly" section/);
});

test("mutation-ratchet CLI --nightly-ratchet: a corrupt/unreadable BASELINE file -> named loud failure, never a silent pass", () => {
  const result = runNightlyRatchet("above-baseline.json", join(FIXTURES, "corrupt-report.json"));
  assert.notEqual(result.status, 0, result.stdout?.toString() + result.stderr?.toString());
  assert.match(result.stderr.toString(), /NIGHTLY BLOCKED -- baseline file unreadable\/invalid/);
});

test("the production scripts/mutation-baseline.json carries a bootstrap \"nightly\" section (numeric scorePct) WITHOUT altering the existing PR-gate root-level fields", () => {
  const prodBaseline: {
    scorePct: number;
    mutateScope: string[];
    nightly?: { scorePct: number };
  } = JSON.parse(readFileSync(PROD_BASELINE, "utf8"));

  // PR-gate fields untouched (still W1-T96's originally captured numbers).
  assert.equal(prodBaseline.scorePct, 75.92);
  assert.deepEqual(prodBaseline.mutateScope, ["src/lib/classify.ts"]);

  // Nightly section present and well-formed.
  assert.ok(prodBaseline.nightly, "scripts/mutation-baseline.json must carry a nightly section");
  assert.equal(typeof prodBaseline.nightly!.scorePct, "number");
});
