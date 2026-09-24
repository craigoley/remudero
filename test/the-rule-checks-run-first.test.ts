import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { FAST_GATE_STEPS, listRuleSuites, MIN_RULE_SUITE_COUNT, runPreflightFast } from "../src/lib/ci-parity.js";
import { gitRepo } from "./helpers/git-repo.js";
import {
  main,
  runRuleSuites,
  // @ts-ignore the executable .mjs module is exercised directly and has no declaration file.
} from "../scripts/list-rule-suites.mjs";

const REPO_ROOT = process.cwd();

test("W1-T4433: every census and ratchet suite runs in the rule-checks job", () => {
  const workflow = readFileSync(`${REPO_ROOT}/.github/workflows/ci.yml`, "utf8");
  assert.match(workflow, /name: rule-checks population \(tree-derived census and ratchet suites, without coverage\)/);
  assert.match(workflow, /node --import tsx scripts\/list-rule-suites\.mjs --run/);
  assert.match(workflow, /OUTCOME_RULE_CHECKS: \$\{\{ steps\.rule-checks\.outcome \}\}/);
  assert.match(workflow, /report "commitlint" "\$\{OUTCOME_COMMITLINT\}" "\$\{OUTCOME_RULE_CHECKS\}"/);
});

test("W1-T4433: preflight runs the same rule-check population", () => {
  const step = FAST_GATE_STEPS.find((candidate) => candidate.runner === "rule-checks");
  assert.ok(step, "the default fast preflight includes the rule-check runner");
  assert.equal(step.script, "rule-checks:population");
  const calls: { file: string; args: string[] }[] = [];
  const result = runPreflightFast(REPO_ROOT, {
    packageJsonText: JSON.stringify({ scripts: Object.fromEntries(FAST_GATE_STEPS.map(({ script }) => [script, "echo stub"])) }),
    now: () => 0,
    spawn: (file, args) => {
      calls.push({ file, args: [...args] });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.steps.find(({ name }) => name === "rule-checks")?.ok, true);
  assert.ok(calls.some(({ file, args }) => file.endsWith("node") && args.join(" ").includes("scripts/list-rule-suites.mjs --run")));
});

test("the tree-derived rule-check runner executes one test file per child process", () => {
  const calls: unknown[][] = [];
  const fakeRun = (...args: unknown[]) => {
    calls.push(args);
    return { status: 0, error: undefined };
  };
  const code = runRuleSuites(REPO_ROOT, fakeRun as typeof spawnSync);
  assert.equal(code, 0);
  const suites = listRuleSuites(REPO_ROOT);
  assert.equal(calls.length, suites.length, "one spawn per suite, sequential — never backgrounded or parallelised");
});

test("W1-T4433: the rule-check population is derived from the tree", () => {
  const suites = listRuleSuites(REPO_ROOT);
  assert.ok(suites.length >= MIN_RULE_SUITE_COUNT);
  assert.ok(suites.includes("test/clock-signature-census.test.ts"));
  assert.ok(suites.includes("test/fixture-copy-census.test.ts"));
  assert.ok(suites.includes("test/deps-interface-census.test.ts"));
  assert.ok(suites.includes("test/comment-load-ratchet.test.ts"));
  assert.equal(new Set(suites).size, suites.length, "each tracked suite appears once");
});

test("the rule-check runner fails the population when a suite cannot spawn or exits non-zero", (t) => {
  t.mock.method(console, "log", () => {});
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => errors.push(line));
  const spawnFailed = () => ({ status: null, error: new Error("spawn ENOENT") });
  assert.equal(runRuleSuites(REPO_ROOT, spawnFailed as unknown as typeof spawnSync), 1);
  assert.match(errors[0] ?? "", /: spawn ENOENT$/);
  errors.length = 0;
  const redSuite = () => ({ status: 1, error: undefined });
  assert.equal(runRuleSuites(REPO_ROOT, redSuite as unknown as typeof spawnSync), 1);
  assert.match(errors[0] ?? "", /: failed \(1\)$/);
});

test("list-rule-suites CLI: --list prints the population, --run runs it, an unknown flag is a usage error", (t) => {
  const printed: string[] = [];
  t.mock.method(console, "log", (line: string) => printed.push(line));
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => errors.push(line));
  assert.equal(main(["--list"]), 0);
  assert.deepEqual(printed, listRuleSuites(REPO_ROOT));
  let spawned = 0;
  const fakeRun = () => {
    spawned += 1;
    return { status: 0, error: undefined };
  };
  assert.equal(main(["--run"], fakeRun as unknown as typeof spawnSync), 0);
  assert.equal(spawned, listRuleSuites(REPO_ROOT).length);
  assert.equal(main(["--bogus"]), 2);
  assert.match(errors.join("\n"), /usage: .*\[--list\|--run\]/);
});

test("listRuleSuites refuses rather than returning an empty population when git cannot list the tree", () => {
  const repo = gitRepo({ kind: "rule-suites-absent" });
  try {
    assert.throws(() => listRuleSuites(join(repo.dir, "absent")), /git ls-files -- test failed: .*ENOENT/);
  } finally {
    repo.cleanup();
  }
});

test("listRuleSuites refuses a population below MIN_RULE_SUITE_COUNT and counts only committed-to-index suites", () => {
  const repo = gitRepo({ kind: "rule-suites-small" });
  try {
    mkdirSync(join(repo.dir, "test"));
    writeFileSync(join(repo.dir, "test", "tracked-census.test.ts"), "");
    writeFileSync(join(repo.dir, "test", "untracked-ratchet.test.ts"), "");
    repo.git("add", "test/tracked-census.test.ts");
    assert.throws(() => listRuleSuites(repo.dir), /rule-check population too small: found 1, expected at least 20/);
  } finally {
    repo.cleanup();
  }
});
