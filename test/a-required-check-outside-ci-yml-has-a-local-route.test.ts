import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PR_WORKFLOW_PARITY_TABLE,
  parsePullRequestWorkflowJobs,
  runCiParity,
  type CiParityEntry,
} from "../src/lib/ci-parity.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_ROOT = join(REPO_ROOT, ".github", "workflows");
const MINIMAL_CI = "on:\n  pull_request:\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps: []\n";

function prWorkflowTexts(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(WORKFLOWS_ROOT)
      .filter((name) => /\.ya?ml$/.test(name) && name !== "ci.yml")
      .map((name) => [name, readFileSync(join(WORKFLOWS_ROOT, name), "utf8")]),
  );
}

function cleanSpawn(calls: string[] = []): PreflightSpawn {
  return (file, args) => {
    calls.push(`${file} ${args.join(" ")}`);
    return { status: 0, stdout: "", stderr: "" };
  };
}

test("W1-T3361: the parser includes jobs from mapping, sequence and scalar pull_request triggers, never a push-only workflow", () => {
  const jobs = parsePullRequestWorkflowJobs({
    "mapping.yml": "on:\n  pull_request:\n    types: [opened]\njobs:\n  mapped:\n    runs-on: ubuntu-latest\n",
    "sequence.yml": "on: [push, pull_request]\njobs:\n  sequenced:\n    runs-on: ubuntu-latest\n",
    "scalar.yml": "on: pull_request\njobs:\n  scalar:\n    runs-on: ubuntu-latest\n",
    "push-only.yml": "on: push\njobs:\n  absent:\n    runs-on: ubuntu-latest\n",
  });

  assert.deepEqual(jobs, [
    { workflow: "mapping.yml", job: "mapped" },
    { workflow: "scalar.yml", job: "scalar" },
    { workflow: "sequence.yml", job: "sequenced" },
  ]);
});

test("W1-T3361: every real standalone PR workflow job has a parity entry, mirrored or explicitly excluded", () => {
  const discovered = parsePullRequestWorkflowJobs(prWorkflowTexts());
  assert.ok(discovered.length > 0, "precondition: expected standalone pull-request workflow jobs");
  const byKey = new Map(PR_WORKFLOW_PARITY_TABLE.map((entry) => [`${entry.workflow}:${entry.job}`, entry]));

  for (const job of discovered) {
    const entry = byKey.get(`${job.workflow}:${job.job}`);
    assert.ok(entry, `${job.workflow}:${job.job} has no local route or explicit exclusion`);
    if (entry!.mirrored) assert.equal(typeof entry!.run, "function", `${job.workflow}:${job.job} is mirrored without a runner`);
    else assert.ok(entry!.reason?.trim(), `${job.workflow}:${job.job} is excluded without a reason`);
  }

  const discoveredKeys = new Set(discovered.map((job) => `${job.workflow}:${job.job}`));
  for (const entry of PR_WORKFLOW_PARITY_TABLE) {
    assert.ok(discoveredKeys.has(`${entry.workflow}:${entry.job}`), `stale standalone parity entry ${entry.workflow}:${entry.job}`);
  }
});

test("W1-T3361: a workflow that runs on pull_request and is absent from the parity table is named", () => {
  const result = runCiParity(REPO_ROOT, {
    spawn: cleanSpawn(),
    ciYamlText: MINIMAL_CI,
    workflowTexts: {
      "new-required-gate.yml": "on:\n  pull_request:\njobs:\n  new-required-gate:\n    runs-on: ubuntu-latest\n    steps: []\n",
    },
  });
  const drift = result.steps.find((step) => step.name === "ci-parity:drift");
  assert.ok(drift);
  assert.equal(drift.ok, false);
  assert.match(drift.detail, /new-required-gate\.yml:new-required-gate/);
});

test("W1-T3361: a standalone PR workflow with no parity entry fails the drift step", () => {
  const result = runCiParity(REPO_ROOT, {
    spawn: cleanSpawn(),
    ciYamlText: MINIMAL_CI,
    workflowTexts: {
      "new-required-gate.yml": "on:\n  pull_request:\njobs:\n  new-required-gate:\n    runs-on: ubuntu-latest\n    steps: []\n",
    },
  });
  const drift = result.steps.find((step) => step.name === "ci-parity:drift");
  assert.ok(drift);
  assert.equal(drift.ok, false);
});

test("W1-T3361: an unmirrored standalone entry without a reason is refused", () => {
  const malformed: CiParityEntry[] = [
    {
      workflow: "new-required-gate.yml",
      job: "new-required-gate",
      mirrored: false,
    },
  ];
  const result = runCiParity(REPO_ROOT, {
    spawn: cleanSpawn(),
    ciYamlText: MINIMAL_CI,
    workflowTexts: {
      "new-required-gate.yml": "on:\n  pull_request:\njobs:\n  new-required-gate:\n    runs-on: ubuntu-latest\n    steps: []\n",
    },
    prWorkflowParityTable: malformed,
  });
  const drift = result.steps.find((step) => step.name === "ci-parity:drift");
  assert.ok(drift);
  assert.equal(drift.ok, false);
  assert.match(drift.detail, /excluded without reason/);
});

test("W1-T3361: the deterministic standalone workflows run their own CI commands locally", () => {
  const calls: string[] = [];
  runCiParity(REPO_ROOT, { spawn: cleanSpawn(calls), workflowTexts: {} });
  for (const script of [
    "coverage-session-blanking:check",
    "docs-index:check",
    "docs-index:check-paths",
    "mkdtemp-callsite-check",
    "unwired-gate:check",
  ]) {
    assert.ok(calls.some((call) => call.includes(`run --silent ${script}`)), `expected local parity to invoke ${script}`);
  }
});
