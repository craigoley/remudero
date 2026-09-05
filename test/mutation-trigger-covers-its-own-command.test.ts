import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ── R-42 (docs/audits/recon-2026-09-05.md), W1-T108/W1-T133's own sibling gap ──────────────────
//
// scripts/mutation-ratchet.mjs's path-filter mode (`evaluatePathFilter`) decides whether a diff
// can move src/lib/classify.ts's mutation score by checking whether any changed path is a member
// of scripts/mutation-relevant-paths.json -- an exact `Set.has`, no partial credit. stryker.conf.
// json's `commandRunner.command` runs FIVE test files (classify, block-reason, and three quota/
// lockout classification suites this task's own diff review found), but until this PR the
// relevant-paths list named only ONE of them (test/classify.test.ts). A PR that weakened
// test/block-reason.test.ts, test/three-retries-in-three-seconds-against-a-lockout.test.ts,
// test/session-limit-is-a-refusal-not-a-success.test.ts or test/codex-quota-window-refusal.test.ts
// alone -- none of which is scoped to a `src/` path the filter also watches -- would read
// `matched: false` and skip Stryker entirely, so a weakened test could ship with the mutation gate
// silently never having run against it.
//
// THE FIX HERE is the data-file edit (the four missing paths are now in
// scripts/mutation-relevant-paths.json); THIS is the census that keeps it from drifting back --
// every `*.test.ts` argument stryker.conf.json's own commandRunner.command names must appear in
// the relevant-paths list, checked against the REAL production files (never a copy), so adding a
// sixth test file to the Stryker command with no matching relevant-paths entry turns this red
// instead of silently reopening the gap.
//
// scripts/mutation-ratchet.mjs sits outside tsconfig's `include` (see tsconfig.json), so its pure
// functions are reached here via a runtime import of the REAL file -- the same idiom
// test/mutation-per-file-runner.test.ts and test/a-gate-shaped-instrument-that-nothing-invokes.
// test.ts already use for their own scripts/*.mjs targets -- rather than a statically-typed one
// that would need a shadow copy to stay in sync.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const STRYKER_CONFIG = join(REPO_ROOT, "stryker.conf.json");
const RATCHET_SCRIPT = join(REPO_ROOT, "scripts", "mutation-ratchet.mjs");

const mod = (await import(pathToFileURL(RATCHET_SCRIPT).href)) as {
  extractCommandTestFiles: (command: string | undefined) => string[];
  loadRelevantPaths: (filePath?: string) => string[];
};

/** Every `*.test.ts` argument commandRunner.command names that is absent from `relevantPaths`. */
function findUncoveredCommandTestFiles(command: string | undefined, relevantPaths: readonly string[]): string[] {
  const relevant = new Set(relevantPaths);
  return mod.extractCommandTestFiles(command).filter((f) => !relevant.has(f));
}

// ── the census, run for real against the live tree ──────────────────────────────────────────────

test("W1-T108/R-42: every test file stryker.conf.json's commandRunner.command runs is named in scripts/mutation-relevant-paths.json", () => {
  const strykerConfig = JSON.parse(readFileSync(STRYKER_CONFIG, "utf8")) as { commandRunner: { command: string } };
  const commandTestFiles = mod.extractCommandTestFiles(strykerConfig.commandRunner.command);
  assert.ok(
    commandTestFiles.length >= 2,
    `sanity: the command must really run more than one test file, or this census checks nothing; got ${JSON.stringify(commandTestFiles)}`,
  );

  const relevantPaths = mod.loadRelevantPaths();
  const uncovered = findUncoveredCommandTestFiles(strykerConfig.commandRunner.command, relevantPaths);
  assert.deepEqual(
    uncovered,
    [],
    `test file(s) the Stryker command runs but scripts/mutation-relevant-paths.json does not list: ` +
      `${uncovered.join(", ")} -- a PR weakening one of these alone would read \`matched: false\` and skip Stryker`,
  );
});

test("W1-T108/R-42: positive control -- the real command really does name more than test/classify.test.ts", () => {
  // Regression pin for the exact defect this task fixes: R-42 measured `commandRunner.command`
  // running five files while the relevant-paths list carried only one of them. If the command ever
  // shrinks back to a single file, this control (not the assertion above) is what says so plainly.
  const strykerConfig = JSON.parse(readFileSync(STRYKER_CONFIG, "utf8")) as { commandRunner: { command: string } };
  const commandTestFiles = mod.extractCommandTestFiles(strykerConfig.commandRunner.command);
  assert.deepEqual(
    [...commandTestFiles].sort(),
    [
      "test/block-reason.test.ts",
      "test/classify.test.ts",
      "test/codex-quota-window-refusal.test.ts",
      "test/session-limit-is-a-refusal-not-a-success.test.ts",
      "test/three-retries-in-three-seconds-against-a-lockout.test.ts",
    ],
    "control: the command's own test-file set must match what R-42 measured",
  );
});

// ── the mechanism, proven against a synthetic drift the real tree cannot currently exhibit ──────

test("W1-T108/R-42: findUncoveredCommandTestFiles reports a command test file absent from relevant-paths, and only that one", () => {
  const command = "node --test --import tsx test/a.test.ts test/b.test.ts test/c.test.ts";
  const uncovered = findUncoveredCommandTestFiles(command, ["src/lib/x.ts", "test/a.test.ts", "test/c.test.ts"]);
  assert.deepEqual(uncovered, ["test/b.test.ts"], "the one command file missing from relevant-paths must be named, and named alone");
});

test("W1-T108/R-42: findUncoveredCommandTestFiles reports nothing when every command test file is covered", () => {
  const command = "node --test --import tsx test/a.test.ts test/b.test.ts";
  const uncovered = findUncoveredCommandTestFiles(command, ["test/a.test.ts", "test/b.test.ts", "scripts/mutation-ratchet.mjs"]);
  assert.deepEqual(uncovered, [], "extra relevant-paths entries beyond the command's own files must not be flagged");
});
