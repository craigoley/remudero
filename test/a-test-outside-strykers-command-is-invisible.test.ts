// test/a-test-outside-strykers-command-is-invisible.test.ts — W1-T2524
//
// THE DEFECT, MEASURED on a real PR (2026-08-30). `stryker.conf.json`'s `commandRunner.command`
// runs exactly `test/classify.test.ts test/block-reason.test.ts test/three-retries-in-three-
// seconds-against-a-lockout.test.ts`. A test asserting on `src/lib/classify.ts` from ANY other
// file is perfectly visible to every other gate (type-check, coverage, lint) but INVISIBLE to
// mutation testing, because the command runner never executes it — nothing about the new code was
// weak, the runner just never ran the test that would have killed those mutants. The gate's
// output was a bare `mutation score 38.91% < baseline 75.92%`: no file names, no test names,
// nothing pointing at the actual cause. The author's rational next move — "my tests are weak,
// write more" — makes it worse by adding tests to a file the runner still ignores.
//
// AND THE OBVIOUS FIX WAS BLOCKED. Widening `commandRunner.command` edits `stryker.conf.json`,
// which sits on the INSTRUMENT_SURFACE, so doing it beside the `src/` change it serves trips
// Standing rule 25's entanglement refusal.
//
// THE FIX HERE is a report change inside the instrument, not a redesign: when the PR-gate ratchet
// mode (scripts/mutation-ratchet.mjs's default `--report`/`--baseline` mode) BLOCKS, it now also
// prints (a) the mutated files the report actually scored and (b) the test files the command
// runner actually executed (parsed straight from `stryker.conf.json`'s own `commandRunner.command`
// via `--stryker-config`, default `stryker.conf.json`). "Your tests were not in this set" is now
// readable straight from the failure. A PASSING run's output, and the score/baseline comparison
// itself, are untouched — this is additional BLOCKED-branch explanation only.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "mutation-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "mutation-ratchet");
const BASELINE = join(FIXTURES, "baseline.json");
const STRYKER_CONFIG = join(REPO_ROOT, "stryker.conf.json");
const TASK_YAML = join(
  REPO_ROOT,
  "plan",
  "tasks.d",
  "W1-T2524-a-test-outside-strykers-command-is-invisible-to-mutation.yaml",
);

function runRatchet(reportFixture: string, opts: { baseline?: string; strykerConfig?: string } = {}) {
  const args = [
    SCRIPT,
    "--report",
    join(FIXTURES, reportFixture),
    "--baseline",
    opts.baseline ?? BASELINE,
  ];
  if (opts.strykerConfig !== undefined) {
    args.push("--stryker-config", opts.strykerConfig);
  }
  return spawnSync(process.execPath, args);
}

// ── acceptance criterion 1: "a blocking mutation run names the test files it actually
// executed" ──────────────────────────────────────────────────────────────────────────────────
//
// Derived from the REAL production stryker.conf.json rather than hardcoded, same convention as
// test/mutation-ratchet.test.ts's own W1-T133 latency test -- if a future PR widens the command
// (a config-only PR, per Standing rule 25), this assertion follows it with zero edits here.

test("a BLOCKED run names every test file in stryker.conf.json's commandRunner.command (acceptance criterion 1)", () => {
  const strykerConfig: { commandRunner: { command: string } } = JSON.parse(
    readFileSync(STRYKER_CONFIG, "utf8"),
  );
  const testFiles = strykerConfig.commandRunner.command
    .split(/\s+/)
    .filter((token) => /\.test\.ts$/.test(token));
  assert.ok(testFiles.length > 0, "sanity: the real command must run at least one test file");

  const result = runRatchet("below-baseline.json");
  assert.notEqual(result.status, 0, result.stdout.toString() + result.stderr.toString());
  const stderr = result.stderr.toString();

  assert.match(stderr, /test files executed \(commandRunner\.command in stryker\.conf\.json\):/);
  for (const testFile of testFiles) {
    assert.ok(
      stderr.includes(testFile),
      `BLOCKED output must name ${testFile} (a real commandRunner.command entry) -- got: ${stderr}`,
    );
  }
});

// ── acceptance criterion 7 (folded in here): removing the named test-file list breaks this
// exact assertion -- it is not a loose substring match, it pins the full comma-joined list
// against the live production command so any regression (list dropped, or silently truncated)
// fails this line specifically.

test("a BLOCKED run's test-file list is the FULL comma-joined command, not a truncated or absent one (acceptance criterion 7 falsifier)", () => {
  const strykerConfig: { commandRunner: { command: string } } = JSON.parse(
    readFileSync(STRYKER_CONFIG, "utf8"),
  );
  const testFiles = strykerConfig.commandRunner.command
    .split(/\s+/)
    .filter((token) => /\.test\.ts$/.test(token));

  const result = runRatchet("below-baseline.json");
  const stderr = result.stderr.toString();

  const expectedLine = `mutation-ratchet: test files executed (commandRunner.command in stryker.conf.json): ${testFiles.join(", ")}`;
  assert.ok(
    stderr.includes(expectedLine),
    `expected the exact line ${JSON.stringify(expectedLine)} in stderr, got: ${stderr}`,
  );
});

// ── acceptance criterion 2: "it names the mutated files it scored, beside the tests that
// ran" ────────────────────────────────────────────────────────────────────────────────────────

test("a BLOCKED run names the mutated files the report actually scored, beside the executed test files (acceptance criterion 2)", () => {
  const result = runRatchet("below-baseline.json");
  assert.notEqual(result.status, 0, result.stdout.toString() + result.stderr.toString());
  const stderr = result.stderr.toString();

  // below-baseline.json's own `files` key -- the report is the SOURCE of the mutated-files list,
  // not stryker.conf.json's `mutate` array, so this is a genuinely distinct fact from criterion 1.
  assert.match(stderr, /mutated files scored: src\/lib\/fixture\.ts/);

  const scoredIndex = stderr.indexOf("mutated files scored:");
  const executedIndex = stderr.indexOf("test files executed");
  assert.ok(scoredIndex >= 0 && executedIndex >= 0, stderr);
  assert.ok(scoredIndex < executedIndex, "mutated files scored must be printed BESIDE (before) the executed test files");
});

// ── acceptance criterion 3: "a passing run's output is unchanged" ──────────────────────────────

test("a PASSING (at/above-baseline) run's output is byte-for-byte unchanged by this task (acceptance criterion 3)", () => {
  const result = runRatchet("above-baseline.json");
  assert.equal(result.status, 0, result.stdout.toString() + result.stderr.toString());
  assert.equal(
    result.stdout.toString(),
    "mutation-ratchet: score 90.00% (baseline 80.00%) -- 8 killed, 1 timeout, 0 survived, 1 no-coverage\n" +
      "mutation-ratchet: OK -- at or above baseline.\n",
  );
  assert.equal(result.stderr.toString(), "");
  assert.doesNotMatch(result.stdout.toString() + result.stderr.toString(), /mutated files scored/);
  assert.doesNotMatch(result.stdout.toString() + result.stderr.toString(), /test files executed/);
});

// ── acceptance criterion 4: "the score and the baseline comparison are unchanged — only the
// explanation is added" ─────────────────────────────────────────────────────────────────────────

test("the score line and the BLOCKED violation line are pinned to their pre-existing wording -- only new lines are appended after them (acceptance criterion 4)", () => {
  const result = runRatchet("below-baseline.json");
  assert.notEqual(result.status, 0, result.stdout.toString() + result.stderr.toString());

  assert.equal(
    result.stdout.toString(),
    "mutation-ratchet: score 20.00% (baseline 80.00%) -- 2 killed, 0 timeout, 8 survived, 0 no-coverage\n",
  );

  const stderrLines = result.stderr.toString().split("\n");
  assert.equal(stderrLines[0], "mutation-ratchet: BLOCKED -- mutation score dropped below the recorded baseline:");
  assert.equal(stderrLines[1], "  - mutation score 20.00% < baseline 80.00%");
});

// ── acceptance criterion 5: "an unreadable or corrupt report still refuses, exactly as it does
// today" ─────────────────────────────────────────────────────────────────────────────────────────
//
// This code path (report/baseline JSON.parse in the default ratchet mode) is untouched by this
// task's diff -- the new explanation lines only run AFTER `evaluateRatchet` has already produced a
// violations array, which requires a successfully parsed report. A corrupt report never reaches
// that point, so its failure mode (an uncaught SyntaxError, non-zero exit) is identical before and
// after.

test("a CORRUPT (invalid JSON) report still refuses with a non-zero exit, exactly as before this task (acceptance criterion 5)", () => {
  const result = runRatchet("corrupt-report.json");
  assert.notEqual(result.status, 0, result.stdout.toString() + result.stderr.toString());
  assert.match(result.stderr.toString(), /SyntaxError/);
  // The new BLOCKED-branch explanation lines require a successfully evaluated ratchet, which a
  // corrupt report never reaches -- proving the new code path was never entered.
  assert.doesNotMatch(result.stderr.toString(), /mutated files scored/);
  assert.doesNotMatch(result.stderr.toString(), /test files executed/);
});

test("an ABSENT report file still refuses with a non-zero exit, exactly as before this task (acceptance criterion 5)", () => {
  const result = runRatchet("does-not-exist.json");
  assert.notEqual(result.status, 0, result.stdout.toString() + result.stderr.toString());
  assert.match(result.stderr.toString(), /ENOENT/);
});

// ── acceptance criterion 6: "no src/ path is touched, so the change cannot be refused for
// entanglement" ──────────────────────────────────────────────────────────────────────────────────
//
// This task's own declared scope (plan/tasks.d/W1-T2524-....yaml `files:`) is the allowlist that
// governs what this run's diff may touch. Asserting every declared path is outside `src/` proves
// the diff structurally cannot trip Standing rule 25's src/+INSTRUMENT_SURFACE entanglement
// refusal -- the same shape the task's own rationale calls out (`stryker.conf.json` is on
// INSTRUMENT_SURFACE; this task deliberately edits scripts/mutation-ratchet.mjs instead).

test("this task's declared file scope contains no src/ path (acceptance criterion 6)", () => {
  const taskYaml = readFileSync(TASK_YAML, "utf8");
  const filesLine = taskYaml.match(/^\s*files:\s*\[([^\]]*)\]/m);
  assert.ok(filesLine, "task yaml must declare a files: [...] scope");
  const declaredFiles = filesLine![1]
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  assert.ok(declaredFiles.length > 0, "declared scope must be non-empty");

  for (const file of declaredFiles) {
    assert.equal(file.startsWith("src/"), false, `${file} is under src/ -- would trip Rule 25 beside stryker.conf.json`);
  }
  // Positive control: both files this task actually touches are present in the declared list.
  assert.ok(declaredFiles.includes("scripts/mutation-ratchet.mjs"));
  assert.ok(
    declaredFiles.includes("test/a-test-outside-strykers-command-is-invisible.test.ts"),
  );
});

// ── extra: the --stryker-config override and its graceful-degradation fallback ─────────────────
//
// Not a numbered acceptance criterion on its own, but the mechanism the criterion-1/2 tests above
// depend on: --stryker-config lets a BLOCKED run be pointed at a config other than the production
// default, and a missing/unreadable one degrades to a named "could not read" line rather than
// crashing the whole gate -- the score/baseline verdict a CI job actually gates on must still be
// reported even if this best-effort enrichment cannot be produced.

test("--stryker-config pointed at a NONEXISTENT file: BLOCKED verdict still reported, enrichment degrades to a named message instead of crashing", () => {
  const result = runRatchet("below-baseline.json", {
    strykerConfig: join(FIXTURES, "does-not-exist-stryker-config.json"),
  });
  assert.notEqual(result.status, 0, result.stdout.toString() + result.stderr.toString());
  assert.match(result.stderr.toString(), /BLOCKED -- mutation score dropped below the recorded baseline/);
  assert.match(
    result.stderr.toString(),
    /could not read commandRunner\.command from .*does-not-exist-stryker-config\.json -- unable to name the test files this run actually executed/,
  );
  assert.doesNotMatch(result.stderr.toString(), /test files executed/);
});
