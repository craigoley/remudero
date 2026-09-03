import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_COMMAND = "npm run --silent mkdtemp-callsite-check";

type WorkflowStep = { name?: unknown; uses?: unknown; run?: unknown; "continue-on-error"?: unknown };
type WorkflowJob = {
  if?: unknown;
  steps?: WorkflowStep[];
  "continue-on-error"?: unknown;
  "timeout-minutes"?: unknown;
};
type Workflow = {
  on?: unknown;
  permissions?: unknown;
  jobs?: Record<string, WorkflowJob>;
};

function workflowFiles(): string[] {
  return execFileSync("git", ["ls-files", ".github/workflows/*.yml", ".github/workflows/*.yaml"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
}

function parsedWorkflow(path: string): Workflow {
  return parseYaml(readFileSync(join(REPO_ROOT, path), "utf8")) as Workflow;
}

function checkerSteps() {
  return workflowFiles().flatMap((workflowPath) => {
    const workflow = parsedWorkflow(workflowPath);
    return Object.entries(workflow.jobs ?? {}).flatMap(([jobId, job]) =>
      (job.steps ?? [])
        .filter((step) => typeof step.run === "string" && step.run.includes("mkdtemp-callsite-check"))
        .map((step) => ({ workflowPath, jobId, job, step })),
    );
  });
}

test("W1-T2781: exactly one executable workflow step runs the mkdtemp checker in the existing unwired-gate job", () => {
  const hits = checkerSteps();
  assert.equal(hits.length, 1);
  assert.equal(hits[0].workflowPath, ".github/workflows/unwired-gate.yml");
  assert.equal(hits[0].jobId, "unwired-gate");
  assert.equal(hits[0].step.run, TARGET_COMMAND);
});

test("W1-T2781: the checker step and its job cannot mask a nonzero exit", () => {
  const [hit] = checkerSteps();
  assert.ok(hit, "the executable checker step must exist");
  assert.notEqual(hit.step["continue-on-error"], true);
  assert.notEqual(hit.job["continue-on-error"], true);
  assert.equal(hit.step.run, TARGET_COMMAND, "an exact single command leaves no shell failure-masking suffix");
});

test("W1-T2781: the existing unconditional unwired-gate workflow contract is otherwise preserved", () => {
  const workflow = parsedWorkflow(".github/workflows/unwired-gate.yml");
  const job = workflow.jobs?.["unwired-gate"];
  assert.ok(job);
  assert.deepEqual(workflow.on, { pull_request: null });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(job.if, undefined);
  assert.equal(job["timeout-minutes"], 10);
  assert.deepEqual(
    (job.steps ?? []).filter((step) => typeof step.uses === "string").map((step) => step.uses),
    [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    ],
  );
  assert.ok((job.steps ?? []).some((step) => step.run === "npm ci"));
  assert.ok((job.steps ?? []).some((step) => step.run === "npm run --silent unwired-gate:check"));
});

test("W1-T2781: the exact workflow command preserves the checker's refusal in a tracked fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-mkdtemp-ci-wiring-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "hooks"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    cpSync(join(REPO_ROOT, "scripts", "mkdtemp-callsite-check.mjs"), join(root, "scripts", "mkdtemp-callsite-check.mjs"));
    writeFileSync(join(root, "hooks", "mkdtemp-allowlist.txt"), "");
    writeFileSync(join(root, "package.json"), JSON.stringify({
      type: "module",
      scripts: { "mkdtemp-callsite-check": "node scripts/mkdtemp-callsite-check.mjs" },
    }));
    writeFileSync(
      join(root, "test", "candidate.test.ts"),
      "const leaked = mkdtempSync(join(tmpdir(), 'workflow-bare-prefix-'));\n",
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "package.json", "scripts", "hooks", "test"], { cwd: root });

    const refused = spawnSync("npm", ["run", "--silent", "mkdtemp-callsite-check"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /workflow-bare-prefix-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
