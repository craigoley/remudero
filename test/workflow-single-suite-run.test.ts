import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CI_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");

type Step = { name?: string; id?: string; run?: string; uses?: string };
type Job = { steps?: Step[]; needs?: string[] | string; if?: string };
const doc = parseYaml(CI_YML) as { jobs: Record<string, Job> };

function step(jobId: string, name: string): Step {
  const found = doc.jobs[jobId]?.steps?.find((s) => s.name === name || s.name?.startsWith(`${name} (`));
  assert.ok(found, `${jobId} must carry a step named ${name}`);
  return found;
}

function runnable(jobId: string, name: string, replacements: Record<string, string> = {}): string {
  const run = step(jobId, name).run;
  assert.ok(run, `${jobId}/${name} must be a run step`);
  return Object.entries({
    "${{ matrix.shard }}": "1",
    "${{ steps.classify.outputs.class }}": "SOURCE",
    "${{ steps.coverage-artifact.outputs.class }}": "SOURCE",
    "${{ steps.plan-reading.outputs.established }}": "false",
    "${{ steps.plan-reading.outputs.class }}": "SOURCE",
    ...replacements,
  }).reduce((body, [from, to]) => body.split(from).join(to), run!);
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-workflow-single-suite-"));
}

function stubbedBin(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["node", "npm"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> "${root}/calls.log"\nexit 99\n`);
    spawnSync("chmod", ["+x", join(bin, name)]);
  }
  return bin;
}

function runBash(script: string, env: Record<string, string> = {}) {
  const root = tmpRoot();
  const bin = stubbedBin(root);
  const summary = join(root, "summary.md");
  const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GITHUB_BASE_REF: "main",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: root,
      ...env,
    },
  });
  const calls = (() => {
    try {
      return readFileSync(join(root, "calls.log"), "utf8");
    } catch {
      return "";
    }
  })();
  return { ...result, calls };
}

test("W1-T3207: source PRs do not invoke the quieter ci or test-slow harnesses", () => {
  const ci = runBash(runnable("ci", "Test"));
  assert.equal(ci.status, 0, ci.stderr + ci.stdout);
  assert.equal(ci.calls, "", "ci's source branch must exit before node/npm can run a second harness");
  assert.match(ci.stdout, /single instrumented full-suite run/);

  const slow = runBash(runnable("test-slow", "Run the slow tier (scripts/test-tier-manifest.json's slow-tier files; none recorded yet still exits 0)"), {
    "STEPS_PLAN_READING_OUTPUTS_ESTABLISHED": "false",
  });
  assert.equal(slow.status, 0, slow.stderr + slow.stdout);
  assert.equal(slow.calls, "", "test-slow must not duplicate slow-tier files on a source PR");
  assert.match(slow.stdout, /single instrumented full-suite run/);
});

test("W1-T3207: a PUSH to main still runs the ci harness — the skip is event-conditional, never unconditional", () => {
  // THE OTHER HALF OF THE TEST ABOVE, and the one with teeth. `coverage-ratchet` is PR-only
  // (W1-T1033), so on a push to main the `ci` job is the ONLY harness that runs the suite at all.
  // A skip that fired unconditionally would leave main with no test run whatsoever and still pass
  // every other case in this file — MEASURED by mutating THIS guard's own line: all 54 assertions
  // across this file, push-ci-on-main and fast-lane-classifier stayed green.
  //
  // A push is modelled by BOTH signals, because the guard may only read push-safe ones: the event
  // name, and an EMPTY base ref (GitHub sets no base ref outside a pull request, which is what
  // makes it a legitimate discriminator here where the request-scoped contexts are not).
  const push = runBash(runnable("ci", "Test"), { GITHUB_EVENT_NAME: "push", GITHUB_BASE_REF: "" });
  assert.match(push.stdout, /class=SOURCE — running test shard/, "a push must reach the shard run, not exit early");
  assert.match(
    push.calls,
    /scripts\/test-with-retry\.mjs/,
    "a push to main must actually invoke the test harness — it is the only one that runs there",
  );
  assert.doesNotMatch(
    push.stdout,
    /single instrumented full-suite run/,
    "the coverage-owns-the-run skip must not fire on a push, where coverage-ratchet does not run",
  );

  const mixedEnv = runBash(runnable("ci", "Test"), { GITHUB_EVENT_NAME: "push", GITHUB_BASE_REF: "main" });
  assert.match(
    mixedEnv.stdout,
    /class=SOURCE — running test shard/,
    "the skip must be keyed to the event, not merely a non-empty base ref inherited by a workflow test",
  );
  assert.match(mixedEnv.calls, /scripts\/test-with-retry\.mjs/, "a push must keep invoking the ci harness");
});

test("W1-T3207: the full test glob appears only in the instrumented coverage run", () => {
  const executableRunText = Object.values(doc.jobs)
    .flatMap((job) => job.steps ?? [])
    .flatMap((s) => (s.run ?? "").split("\n"))
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.equal(
    executableRunText.match(/"test\/\*\*\/\*\.test\.ts"/g)?.length,
    1,
    "the workflow must carry one executable full-suite glob, in the coverage harness",
  );
  assert.match(runnable("coverage-ratchet", "Test with coverage"), /--experimental-test-coverage/);
});

test("W1-T3207: coverage gates consume downloaded artifacts without npm ci or Playwright", () => {
  const required = doc.jobs["coverage-ratchet-required"];
  assert.deepEqual(required.needs, ["coverage-ratchet"]);
  const body = (required.steps ?? []).map((s) => s.run ?? s.uses ?? "").join("\n");
  assert.match(body, /actions\/download-artifact@/, "the consumer must download the uploaded coverage shards");
  assert.match(body, /coverage-shards\/coverage-shard-\$\{SHARD\}\/class/, "the consumer must read shard metadata from the artifact");
  assert.match(body, /coverage-merge-ratchet\.mjs --output coverage\/lcov\.info/, "raw coverage must be merged from downloaded shards");
  assert.match(body, /diff-coverage\.mjs --lcov coverage\/lcov\.info --diff pr\.diff/);
  assert.match(body, /coverage-ratchet\.mjs --lcov coverage\/lcov\.info --baseline scripts\/coverage-baseline\.json/);
  assert.doesNotMatch(body, /\bnpm ci\b|\bplaywright install\b/, "the artifact consumer installs neither npm dependencies nor Playwright");
  assert.doesNotMatch(body, /diff-class\.mjs|--import tsx/, "the consumer must not need npm-installed tsx to classify the diff");
});

test("W1-T3207: missing coverage artifact metadata fails closed", () => {
  const result = runBash(runnable("coverage-ratchet-required", "Require downloaded coverage shard artifacts"));
  assert.notEqual(result.status, 0, "a missing shard artifact must fail the gate");
  assert.match(result.stdout + result.stderr, /refusing a missing or partial artifact/);
});

test("W1-T3207: W1-T2428 fast-lane still skips coverage work for plan/docs diffs", () => {
  const coverage = runBash(runnable("coverage-ratchet", "Test with coverage", { "${{ steps.classify.outputs.class }}": "PLAN_ONLY" }));
  assert.equal(coverage.status, 0, coverage.stderr + coverage.stdout);
  assert.equal(coverage.calls, "", "plan-only coverage collection must exit before node can run the suite");
  assert.match(coverage.stdout, /W1-T2428 fast-lane: class=PLAN_ONLY/);

  const merge = runBash(
    runnable("coverage-ratchet-required", "Merge raw V8 coverage shards before assigning LCOV branch indexes", {
      "${{ steps.coverage-artifact.outputs.class }}": "DOCS_ONLY",
    }),
  );
  assert.equal(merge.status, 0, merge.stderr + merge.stdout);
  assert.equal(merge.calls, "", "docs-only coverage consumption must exit before merging or gating coverage");
  assert.match(merge.stdout, /W1-T2428 fast-lane: class=DOCS_ONLY/);
});

test("W1-T3207: the workflow names the lost second-harness signal", () => {
  assert.match(CI_YML, /12 of 600/, "the workflow must record the measured signal being given up");
});
