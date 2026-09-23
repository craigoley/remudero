/**
 * W1-T4395 — a pull request that changes only tests runs those tests.
 *
 * #6867 changed one test file and no CI job ran it: ci-shard classified the diff SOURCE and skipped
 * under W1-T3207 (coverage owns the one full-suite run), and coverage-shard classified it TEST_ONLY and
 * skipped (source coverage cannot move). Now the ordinary test lane runs a test-only diff's changed files
 * through the same candidate lane a plan/docs diff uses, and a helper, fixture or setup change — which can
 * move many suites — runs the full suite. The second half of each test drives the REAL `Test` step body
 * through Actions' own shell with a stub `node` that records what it was asked to run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "diff-class.mjs");
const { testOnlyRun } = (await import(pathToFileURL(SCRIPT).href)) as {
  testOnlyRun: (files: unknown) => { mode: "files"; files: string[] } | { mode: "full" } | null;
};

type CiDoc = { jobs: Record<string, { steps?: Array<{ name?: string; id?: string; run?: string }> }> };
const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8")) as CiDoc;
const steps = doc.jobs.ci!.steps!;
const TEST_STEP = steps.find((s) => s.name === "Test")!.run!;
const CLASSIFY_STEP = steps.find((s) => s.id === "classify")!.run!;

function cli(changed: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4395-`));
  const list = join(dir, "changed.txt");
  writeFileSync(list, changed.join("\n") + "\n");
  const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--test-only-run", "--changed-files", list], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** Runs the real Test step for shard 1 of a pull request, with `test-only-run.txt` as the classify step
 *  would have left it, and a stub `node` that logs each call and answers like the real tools. */
function runTestStep(testOnlyRunFile: string | undefined): { status: number | null; calls: string; candidates: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4395-step-`));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "x.test.ts"), "");
  if (testOnlyRunFile !== undefined) writeFileSync(join(dir, "test-only-run.txt"), testOnlyRunFile);
  const log = join(dir, "node-calls.log");
  writeFileSync(
    join(dir, "bin", "node"),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$*" in
  *--select-candidates*) cat "$3"; echo "test-tier-manifest: plan-reading shard summary candidate_count=1" >&2 ;;
  *) echo "# tests 1"; echo "# pass 1"; echo "# fail 0" ;;
esac
`,
  );
  chmodSync(join(dir, "bin", "node"), 0o755);
  const body = TEST_STEP.replaceAll("${{ steps.classify.outputs.class }}", "SOURCE").replaceAll("${{ matrix.shard }}", "1");
  writeFileSync(join(dir, "run.sh"), body);
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "run.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: join(dir, "summary.md"), RUNNER_TEMP: dir },
  });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return { status: r.status, calls: read("node-calls.log"), candidates: read("plan-reading-suites.txt"), out: r.stdout + r.stderr };
}

test("W1-T4395: a test-only diff runs the changed test files", () => {
  const changed = ["test/a-test-only-change-runs-its-own-tests.test.ts", "test/fast-lane-classifier.test.ts"];
  assert.deepEqual(testOnlyRun(changed), { mode: "files", files: changed });
  assert.equal(cli(changed), `files\n${changed.join("\n")}\n`);
  assert.match(CLASSIFY_STEP, /diff-class\.mjs --test-only-run --changed-files changed-files\.txt > test-only-run\.txt/, "the classify step records the decision");
  // The real step hands exactly the changed files to the candidate runner, instead of skipping.
  const run = runTestStep(`files\n${changed.join("\n")}\n`);
  assert.equal(run.status, 0, run.out);
  assert.equal(run.candidates.trim(), changed.join("\n"));
  assert.match(run.calls, /test-tier-manifest\.mjs --run-candidates plan-reading-suites\.txt --shard 1\/4/);
  assert.doesNotMatch(run.out, /W1-T3207: coverage-ratchet owns/);
});

test("W1-T4395: a helper or fixture change is not treated as test-only", () => {
  assert.deepEqual(testOnlyRun(["test/helpers/git-repo.ts"]), { mode: "full" });
  assert.deepEqual(testOnlyRun(["test/fast-lane-classifier.test.ts", "test/fixtures/example.json"]), { mode: "full" });
  assert.equal(cli(["test/setup/tmp-hygiene.ts"]), "full\n");
  // Outside test/, or nothing readable: no opinion, and the ordinary classification stands.
  assert.equal(testOnlyRun(["test/fast-lane-classifier.test.ts", "src/lib/plan-scope.ts"]), null);
  assert.equal(testOnlyRun([]), null);
  assert.equal(testOnlyRun("test/x.test.ts"), null);
  assert.equal(cli(["src/lib/plan-scope.ts"]), "");
  // An unreadable list prints nothing and fails, so CI keeps the ordinary classification.
  const unreadable = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--test-only-run", "--changed-files", join(tmpdir(), "rmd-w1t4395-missing.txt")], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(unreadable.status, 1);
  assert.equal(unreadable.stdout, "");
  // "full" runs the sharded full suite rather than taking the W1-T3207 skip ...
  const full = runTestStep("full\n");
  assert.equal(full.status, 0, full.out);
  assert.match(full.calls, /test-tier-manifest\.mjs --run fast --shard 1\/4/);
  // ... and a plain source diff (the control) still takes that skip, so the harness can tell them apart.
  const source = runTestStep(undefined);
  assert.equal(source.status, 0, source.out);
  assert.match(source.out, /W1-T3207: coverage-ratchet owns/);
  assert.doesNotMatch(source.calls, /--run fast|--run-candidates/);
});
