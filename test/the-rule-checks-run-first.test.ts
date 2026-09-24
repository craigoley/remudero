import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FAST_GATE_STEPS, listRuleSuites, MIN_RULE_SUITE_COUNT, runPreflightFast } from "../src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
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

test("the runner reports a spawn error for one suite and still finishes the population", () => {
  let calls = 0;
  const fakeRun = (() => {
    calls += 1;
    return calls === 1 ? { status: null, error: new Error("boom") } : { status: 0, error: undefined };
  }) as unknown as typeof spawnSync;
  const code = runRuleSuites(REPO_ROOT, fakeRun);
  assert.equal(code, 1, "one suite's spawn error fails the whole population's exit code");
  assert.ok(calls >= 2, "a failing suite does not stop the sequential runner early");
});

test("the runner reports a non-zero exit status for one suite and still finishes the population", () => {
  let calls = 0;
  const fakeRun = (() => {
    calls += 1;
    return calls === 1 ? { status: 1, error: undefined } : { status: 0, error: undefined };
  }) as unknown as typeof spawnSync;
  const code = runRuleSuites(REPO_ROOT, fakeRun);
  assert.equal(code, 1, "one suite's non-zero exit fails the whole population's exit code");
});

test("main: --list prints the derived population and exits 0", () => {
  const code = main(["--list"]);
  assert.equal(code, 0);
});

test("main: no flag also prints the derived population and exits 0", () => {
  const code = main([]);
  assert.equal(code, 0);
});

test("main: an unrecognised flag prints usage and refuses with exit 2", () => {
  const code = main(["--bogus"]);
  assert.equal(code, 2);
});

test("main: --run delegates to the injected rule-suite runner, never the real spawn, in this falsifier", () => {
  let called = false;
  const code = main(["--run"], () => {
    called = true;
    return 0;
  });
  assert.equal(code, 0);
  assert.ok(called, "the --run flag reaches the injected runner");
});

test("the CLI entrypoint runs main() for real when the script is invoked directly (covers the module-execution guard)", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/list-rule-suites.mjs", "--list"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /test\/clock-signature-census\.test\.ts/);
});

test("listRuleSuites refuses when git itself cannot enumerate the tracked tree (not a git repository)", () => {
  // NOTE: deliberately never spells the literal git-subcommand token this throws for — that
  // exact substring is what src/lib/ci-parity.ts's own census-shaped-file recognizer greps
  // test/*.test.ts for, and this file is a falsifier ABOUT that population, not a member of it.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rule-suites-not-a-repo-`));
  try {
    assert.throws(() => listRuleSuites(root), /-- test failed:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listRuleSuites refuses when the derived population is too small (no census/ratchet/baseline suite tracked)", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rule-suites-too-small-`));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "ordinary.test.ts"), 'test("x", () => {});\n');
    execFileSync("git", ["add", "test/ordinary.test.ts"], { cwd: root });
    assert.throws(() => listRuleSuites(root), /rule-check population too small/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
