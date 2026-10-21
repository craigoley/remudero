import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

// W1-T9873: test files now live in subfolders of test/ (test/ci/, test/review/, ...). A workflow
// that lists test/ only at its top level silently drops them. The nightly mutation run then maps
// fewer importers, and a suite count under-reports. Once no flat test is left, the count step fails.
// A paths: trigger that names one exact test path stops firing when that test moves.
// The suite reads the real workflow files, so a later edit is what it judges.

const WORKFLOWS = ["mutation-nightly.yml", "ci.yml", "recovery-drill.yml"] as const;

type Step = { name?: string; run?: string };
type Job = { steps?: Step[] };
type Workflow = { on?: Record<string, { paths?: string[] } | null>; jobs?: Record<string, Job> };

function loadWorkflow(file: string): Workflow {
  return parseYaml(readFileSync(join(REPO_ROOT, ".github", "workflows", file), "utf8")) as Workflow;
}

function runSteps(file: string): Array<{ job: string; step: Step }> {
  const out: Array<{ job: string; step: Step }> = [];
  for (const [job, body] of Object.entries(loadWorkflow(file).jobs ?? {})) {
    for (const step of body.steps ?? []) if (typeof step.run === "string") out.push({ job, step });
  }
  return out;
}

// `find test ... -maxdepth 1` (the starting point is test/ itself), or a flat `test/*.test.ts`
// shell glob. `test/**/*.test.ts` and `find test-duration-shards` do not match.
const TOP_LEVEL_FIND = /\bfind\s+(?:\.\/)?test\/?(?=\s)[^|;&\n]*?-maxdepth\s+1\b/;
const FLAT_GLOB = /(?:^|[\s"'(=])(?:\.\/)?test\/\*\.test\.ts/m;

test("W1-T9873: no workflow step lists test/ only at its top level", () => {
  const offenders: string[] = [];
  for (const file of WORKFLOWS) {
    const steps = runSteps(file);
    assert.ok(steps.length > 0, `${file}: parsed 0 run: steps, so this check would compare nothing`);
    for (const { job, step } of steps) {
      for (const line of step.run!.split("\n")) {
        if (TOP_LEVEL_FIND.test(line) || FLAT_GLOB.test(line)) {
          offenders.push(`${file} jobs.${job} "${step.name ?? "(unnamed)"}": ${line.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], "these steps list test/ only at its top level and miss nested tests");
});

test("W1-T9873: no paths trigger names an exact flat test path", () => {
  const offenders: string[] = [];
  let pathsSeen = 0;
  for (const file of WORKFLOWS) {
    for (const [event, config] of Object.entries(loadWorkflow(file).on ?? {})) {
      for (const entry of config?.paths ?? []) {
        pathsSeen += 1;
        // A glob-free test path stops matching the moment the test moves into another folder.
        if (/^(?:\.\/)?test\/[^*?[]*\.test\.ts$/.test(entry)) offenders.push(`${file} on.${event}.paths: ${entry}`);
      }
    }
  }
  assert.ok(pathsSeen > 0, "parsed 0 paths: entries, so this check would compare nothing");
  assert.deepEqual(offenders, [], "these paths: triggers name one exact test path");
});

function writeTree(root: string, files: readonly string[]): void {
  for (const rel of files) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), "");
  }
}

function bash(cwd: string, script: string) {
  return spawnSync("bash", ["-eo", "pipefail", "-c", script], { cwd, encoding: "utf8" });
}

test("W1-T9873: the nightly's test-file list holds nested tests and leaves out fixture trees", (t) => {
  const step = runSteps("mutation-nightly.yml")
    .map(({ step }) => step)
    .find((s) => /nightly-test-files\.txt/.test(s.run ?? "") && /^List /.test(s.name ?? ""));
  assert.ok(step, "mutation-nightly.yml has no step that writes nightly-test-files.txt");
  const { dir } = ownedFixtureDir(t, "nightly-nested-tests");
  writeTree(dir, [
    "test/flat.test.ts",
    "test/ci/nested.test.ts",
    "test/ci/gates/deeper.test.ts",
    "test/ci/helper.ts",
    "test/fixtures/golden/checkout/test/existing.test.ts",
  ]);
  const result = bash(dir, step.run!);
  assert.equal(result.status, 0, result.stderr);
  const listed = readFileSync(join(dir, "nightly-test-files.txt"), "utf8").split("\n").filter(Boolean);
  // Full repo-relative paths: the per-file mapping resolves each test's relative imports from them.
  assert.deepEqual(listed, ["test/ci/gates/deeper.test.ts", "test/ci/nested.test.ts", "test/flat.test.ts"]);
});

test("W1-T9873: ci.yml's repository-suite count includes nested tests and survives an empty flat folder", (t) => {
  const lines = runSteps("ci.yml").flatMap(({ step }) =>
    step.run!.split("\n").map((l) => l.trim()).filter((l) => /^TOTAL="\$\(.*\.test\.ts.*\)"$/.test(l)));
  assert.ok(lines.length > 0, "ci.yml has no TOTAL=\"$(... .test.ts ...)\" suite count, so this check would compare nothing");
  const { dir } = ownedFixtureDir(t, "ci-suite-count");
  writeTree(dir, ["test/ci/nested.test.ts", "test/review/other.test.ts", "test/ci/helper.ts"]);
  for (const line of lines) {
    const result = bash(dir, `${line}\nprintf '%s' "$TOTAL"`);
    assert.equal(result.status, 0, `${line} failed with no flat test left: ${result.stderr}`);
    assert.equal(result.stdout, "2", `${line} counted ${result.stdout}, not the 2 nested tests`);
  }
});
