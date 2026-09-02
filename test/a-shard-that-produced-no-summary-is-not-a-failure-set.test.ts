// test/a-shard-that-produced-no-summary-is-not-a-failure-set.test.ts
//
// W1-T2597 — MEASURED on PR #3542: `ci-shard (1/4)` exited 1 with 161 KB of log and NO
// `# tests`/`# pass`/`# fail` trailing summary anywhere in it, while its three sibling shards each
// ended with a complete summary and a named FLAKE-RETRY list. A killed/timed-out run prints only
// the assertions it reached before dying and never reaches node's own trailing summary block
// (written ONCE, at the very end) — CLAUDE.md already states the rule this violates: "a test run
// with no `# tests` summary is NOT A RESULT", because that failure set is a SUBSET BY
// CONSTRUCTION. CI applied no such distinction: exit 1 read identically whether the shard reached
// a genuine, complete verdict or died mid-run. `.github/workflows/ci.yml`'s `Test` step now makes
// that distinction legible (a `NO-SUMMARY SHARD` marker in $GITHUB_STEP_SUMMARY plus a greppable
// `::error::` line) WITHOUT changing whether the job is red — a shard that dies mid-run is still a
// failing check; only the evidence behind that red is now distinguishable from a genuine one.
//
// NOT IN SCOPE (this task's rationale): the census family's author-time timing (W1-T2595), the
// escape-hatch class (W1-T2596), and any change to how many shards the matrix runs, or to whether
// a no-summary shard blocks merge — only to whether the difference is OBSERVABLE.
//
// Drives the REAL `ci.yml` `Test` step body, extracted at test time (never a copy-pasted fixture —
// same convention as test/ci-sharding.test.ts and test/push-ci-on-main.test.ts), through the exact
// shell GitHub Actions itself uses for a multi-line `run:` step on a Linux runner
// (`bash --noprofile --norc -eo pipefail <script>`), with a stub `node` on `$PATH` that lets the
// real retry wrapper boot and then stands in for its child test process, so each scenario's
// TAP-shaped output and exit code are fully controlled.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CI_YAML_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const TEST_WITH_RETRY_SCRIPT = join(REPO_ROOT, "scripts", "test-with-retry.mjs");

// scripts/test-with-retry.mjs sits outside tsconfig's `include` (a plain .mjs file), so — same
// convention as test/fast-lane-classifier.test.ts's import of scripts/diff-class.mjs — it is
// reached here via a dynamic `import()` off a `pathToFileURL`, never a static import that TS7016s.
const retryMod = (await import(pathToFileURL(TEST_WITH_RETRY_SCRIPT).href)) as {
  parseFailingTestNames: (output: string) => string[];
};
const { parseFailingTestNames } = retryMod;

type CiStep = { name?: string; run?: string };
type CiDoc = { jobs: Record<string, { steps?: CiStep[] }> };

function loadTestStepRun(): string {
  const doc = parseYaml(readFileSync(CI_YAML_PATH, "utf8")) as CiDoc;
  const step = doc.jobs.ci.steps?.find((s) => s.name === "Test");
  assert.ok(step?.run, 'ci.yml\'s `ci` job must still have a step named "Test" with a `run:` body');
  return step!.run!;
}

/** Substitutes the two `${{ ... }}` GitHub Actions expressions the `Test` step's SOURCE branch
 * actually reads -- everything else in the step's body is plain bash, so this is the whole
 * rendering a real runner would have done before invoking the shell. */
function renderForShard(runText: string, shard: number, cls: string): string {
  return runText.replaceAll("${{ steps.classify.outputs.class }}", cls).replaceAll("${{ matrix.shard }}", String(shard));
}

/** `node --test` sets `NODE_TEST_CONTEXT=child-v8` on its OWN process.env and that is inherited
 * by any child process spawned without an explicit `env:` override -- including this very test
 * file's own process. A nested `node --test` that inherits it silently no-ops ("run() is being
 * called recursively within a test file. skipping running files.", MEASURED locally) instead of
 * actually running the fixture files below, which would make every real-binary assertion in this
 * file pass vacuously on an empty stdout rather than on real sharding behavior. Every spawn of a
 * real `node --test` child in this file must strip it so the child runs as CI's own `npm run
 * test:ci` genuinely does -- a fresh, non-nested invocation. */
function freshTestProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Executes an already-rendered step body through the SAME shell invocation GitHub Actions uses
 * for a multi-line Linux `run:` step. The node stub delegates the outer wrapper invocation to the
 * real binary and controls only the wrapper's child `node --test` process. */
function runRenderedStep(runText: string, nodeStubScript: string): { status: number | null; stdout: string; stderr: string; summary: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-shard-summary-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const nodeStubPath = join(binDir, "node");
  writeFileSync(nodeStubPath, nodeStubScript);
  chmodSync(nodeStubPath, 0o755); // owner digit 7 -- outside test/host-capability-fixtures.test.ts's ratchet
  const scriptPath = join(dir, "run.sh");
  writeFileSync(scriptPath, runText);
  const summaryPath = join(dir, "summary.md");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", scriptPath], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_STEP_SUMMARY: summaryPath,
      RMD_REAL_NODE: process.execPath,
      RMD_TEST_WITH_RETRY_SCRIPT: TEST_WITH_RETRY_SCRIPT,
    },
  });
  const summary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", summary };
}

const DELEGATE_WRAPPER = `if [ "$1" = "scripts/test-with-retry.mjs" ]; then
  shift
  exec "$RMD_REAL_NODE" "$RMD_TEST_WITH_RETRY_SCRIPT" "$@"
fi
`;

const TRUNCATED_NO_SUMMARY_NODE = `#!/usr/bin/env bash
${DELEGATE_WRAPPER}
# Simulates PR #3542 shard 1: a killed/timed-out run prints the assertions it reached and dies
# before node's OWN trailing summary block is ever written.
echo "TAP version 13"
echo "# Subtest: something mid-flight"
echo "not ok 1 - something mid-flight"
exit 1
`;

const GENUINE_FAILURE_NODE = `#!/usr/bin/env bash
${DELEGATE_WRAPPER}
# A run that reached its own trailing summary and named a genuine, complete failure set.
echo "TAP version 13"
echo "# Subtest: a real failing test"
echo "not ok 1 - a real failing test"
echo "1..1"
echo "# tests 1"
echo "# suites 0"
echo "# pass 0"
echo "# fail 1"
echo "# cancelled 0"
echo "# skipped 0"
echo "# todo 0"
echo "# duration_ms 12.3"
exit 1
`;

const EMPTY_SLICE_NODE = `#!/usr/bin/env bash
${DELEGATE_WRAPPER}
# A shard whose slice legitimately contains zero test files -- MEASURED against a real
# 'node --test --test-shard=' invocation below: it still runs to completion and prints a full,
# zero-count summary, exit 0.
echo "TAP version 13"
echo "1..0"
echo "# tests 0"
echo "# suites 0"
echo "# pass 0"
echo "# fail 0"
echo "# cancelled 0"
echo "# skipped 0"
echo "# todo 0"
echo "# duration_ms 3.7"
exit 0
`;

// ── acceptance 1: a no-summary exit is distinguished from a genuine, summarised failure ────────

test("acceptance 1: a shard that exits non-zero with NO `# tests` summary anywhere in its output is marked NO-SUMMARY SHARD in $GITHUB_STEP_SUMMARY, with a greppable ::error:: naming the shard", () => {
  const runText = renderForShard(loadTestStepRun(), 1, "SOURCE");
  const r = runRenderedStep(runText, TRUNCATED_NO_SUMMARY_NODE);
  assert.equal(r.status, 1, `the shard must still be RED -- this must never turn a real failure green: ${r.stdout}${r.stderr}`);
  assert.match(r.summary, /NO-SUMMARY SHARD/, `the step summary must flag the truncated run: ${JSON.stringify(r.summary)}`);
  assert.match(
    r.stdout + r.stderr,
    /::error::ci-shard 1\/4 exited 1 with NO node-test-runner summary/,
    "the raw log must carry a greppable ::error:: annotation naming the shard",
  );
});

test("acceptance 1: a shard that exits non-zero WITH a genuine `# tests`/`# pass`/`# fail` summary is NOT flagged NO-SUMMARY -- same exit code, distinguished evidence", () => {
  const runText = renderForShard(loadTestStepRun(), 1, "SOURCE");
  const r = runRenderedStep(runText, GENUINE_FAILURE_NODE);
  assert.equal(r.status, 1, "a genuine failure must still be RED");
  assert.doesNotMatch(r.summary, /NO-SUMMARY SHARD/, `a run with a real summary must never be flagged unverified: ${JSON.stringify(r.summary)}`);
  assert.doesNotMatch(r.stdout + r.stderr, /::error::ci-shard/, "no NO-SUMMARY annotation belongs on a genuinely diagnosed red");
});

// ── acceptance 2: a shard that legitimately ran nothing is not failed for reporting nothing ────

test("acceptance 2: a shard whose slice legitimately runs nothing (a zero-count summary, exit 0) stays GREEN and is never flagged NO-SUMMARY", () => {
  const runText = renderForShard(loadTestStepRun(), 1, "SOURCE");
  const r = runRenderedStep(runText, EMPTY_SLICE_NODE);
  assert.equal(r.status, 0, `an honest, empty slice must stay GREEN: ${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.summary, /NO-SUMMARY SHARD/);
});

test("acceptance 2 (control, real node --test binary, MEASURED not assumed): a shard slice with zero matched test files still completes with a full, zero-count `# tests` summary and exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-shard-summary-empty-slice-"));
  // A SINGLE fixture file with total shard count 4: node assigns it to exactly one shard, so the
  // other three genuinely receive an empty slice -- the real mechanism a `class=SOURCE` shard hits
  // whenever the file count and the shard count don't divide evenly onto every shard.
  writeFileSync(join(dir, "only.test.mjs"), "import test from 'node:test';\ntest('present', () => {});\n");
  const result = spawnSync(process.execPath, ["--test", "--test-shard=3/4", "only.test.mjs"], {
    cwd: dir,
    encoding: "utf8",
    env: freshTestProcessEnv(),
  });
  assert.equal(result.status, 0, `an empty slice must exit 0: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^# tests 0$/m, "an empty slice must still print the trailing summary, just with zero counts");
});

// ── acceptance 3: the duplicate FLAKE-RETRY lists across shards, on evidence not assumption ─────
//
// Two readings were offered (this task's rationale): either the split is NOT disjoint (the same
// suite executes in more than one shard), or the retry harness reports the matrix-wide union
// rather than the issuing shard's own (a reporting artifact, harmless but misleading). Both parts
// below are MEASURED against the real binary and the real repo, not assumed:
//
//  (a) node's own --test-shard assignment, for a fixed file list, is disjoint AND deterministic
//      across independent process invocations -- this rules OUT "non-disjoint split" as the cause.
//  (b) scripts/test-with-retry.mjs's parseFailingTestNames (the function whose output becomes the
//      FLAKE-RETRY line) reads bare TAP `not ok <n> - <name>` lines -- no file, suite or shard
//      qualifier is present in that line at all -- so two DIFFERENT tests in two DIFFERENT,
//      disjoint shard files that happen to share a title report BYTE-IDENTICAL evidence. This repo
//      genuinely has duplicate test titles across different files today (measured below), so this
//      is the reporting-artifact reading, not an assumption.

test("acceptance 3a: node's real --test-shard assignment is disjoint and deterministic across independent invocations, for a fixed file list", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-shard-summary-disjoint-"));
  const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  for (const name of names) {
    writeFileSync(join(dir, `${name}.test.mjs`), `import test from 'node:test';\ntest('${name}', () => {});\n`);
  }
  function assignmentsFor(shard: number): string[] {
    const result = spawnSync(process.execPath, ["--test", `--test-shard=${shard}/4`, "--test-reporter=tap", "*.test.mjs"], {
      cwd: dir,
      encoding: "utf8",
      env: freshTestProcessEnv(),
    });
    return [...result.stdout.matchAll(/^# Subtest: (.+)$/gm)].map((m) => m[1]).sort();
  }
  const round1 = [1, 2, 3, 4].map(assignmentsFor);
  const round2 = [1, 2, 3, 4].map(assignmentsFor);

  for (let i = 0; i < 4; i++) {
    assert.deepEqual(round2[i], round1[i], `shard ${i + 1}/4 must assign the same files on a repeat run (determinism)`);
  }
  const seen = new Map<string, number>();
  for (const shardNames of round1) {
    for (const n of shardNames) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  for (const [n, count] of seen) {
    assert.equal(count, 1, `'${n}' must be assigned to exactly one shard, not ${count} (disjointness)`);
  }
  assert.deepEqual([...seen.keys()].sort(), [...names].sort(), "every file must land in exactly one shard (completeness)");
});

test("acceptance 3b: two DIFFERENT failing tests, in two DIFFERENT (disjoint) shard files, that share a title produce BYTE-IDENTICAL evidence from parseFailingTestNames -- the retry harness cannot tell them apart by name alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-shard-summary-collision-"));
  writeFileSync(
    join(dir, "shard-a.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert';\ntest('handles the empty case', () => { assert.fail('shard-a reason'); });\n",
  );
  writeFileSync(
    join(dir, "shard-b.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert';\ntest('handles the empty case', () => { assert.fail('shard-b reason'); });\n",
  );
  function tapFor(file: string): string {
    return spawnSync(process.execPath, ["--test", file], { cwd: dir, encoding: "utf8", env: freshTestProcessEnv() }).stdout;
  }
  const namesA = parseFailingTestNames(tapFor("shard-a.test.mjs"));
  const namesB = parseFailingTestNames(tapFor("shard-b.test.mjs"));
  assert.deepEqual(namesA, ["handles the empty case"]);
  assert.deepEqual(
    namesB,
    namesA,
    "two DIFFERENT tests (different files, different failure reasons) must not be distinguishable from their parsed evidence alone -- that is the reporting artifact, not proof the same test ran twice",
  );
});

test("acceptance 3 (evidence, not assumption): this repo's OWN test/ directory already has exact-duplicate test titles across DIFFERENT files today -- the mechanism above is not hypothetical", () => {
  const files = readdirSync(join(REPO_ROOT, "test")).filter((f) => f.endsWith(".test.ts"));
  const titlesToFiles = new Map<string, Set<string>>();
  const titleRe = /^\s*(?:test|it)\(\s*(`[^`]*`|"[^"]*"|'[^']*')/;
  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, "test", file), "utf8");
    for (const line of text.split("\n")) {
      const m = titleRe.exec(line);
      if (!m) continue;
      const title = m[1].slice(1, -1);
      if (!titlesToFiles.has(title)) titlesToFiles.set(title, new Set());
      titlesToFiles.get(title)!.add(file);
    }
  }
  const crossFileDuplicates = [...titlesToFiles.entries()].filter(([, fileSet]) => fileSet.size > 1);
  assert.ok(
    crossFileDuplicates.length > 0,
    "expected at least one test title to recur across two different files in test/ -- if this ever reads zero, re-verify the name-collision mechanism above still applies before trusting it as the explanation",
  );
});
