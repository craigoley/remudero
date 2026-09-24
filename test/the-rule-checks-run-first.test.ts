import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { FAST_GATE_STEPS, listRuleSuites, MIN_RULE_SUITE_COUNT, runPreflightFast } from "../src/lib/ci-parity.js";

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

test("W1-T4433: the rule-check population is derived from the tree", () => {
  const suites = listRuleSuites(REPO_ROOT);
  assert.ok(suites.length >= MIN_RULE_SUITE_COUNT);
  assert.ok(suites.includes("test/clock-signature-census.test.ts"));
  assert.ok(suites.includes("test/fixture-copy-census.test.ts"));
  assert.ok(suites.includes("test/deps-interface-census.test.ts"));
  assert.ok(suites.includes("test/comment-load-ratchet.test.ts"));
  assert.equal(new Set(suites).size, suites.length, "each tracked suite appears once");
});
