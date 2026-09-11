import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "prompt-surface-gate.mjs");

type GateResult = {
  ok: boolean;
  message: string;
  surfaces: string[];
  evidence: string[];
};

const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  evaluatePromptSurfaceGate: (opts: { root: string; base: string; head?: string }) => GateResult;
};

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "prompt surface fixture",
  GIT_AUTHOR_EMAIL: "fixture@remudero.invalid",
  GIT_COMMITTER_NAME: "prompt surface fixture",
  GIT_COMMITTER_EMAIL: "fixture@remudero.invalid",
};

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV });
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function commit(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-prompt-surface-gate-"));
  git(root, ["init", "-q"]);
  return root;
}

function withFixture(fn: (root: string) => void): void {
  const root = fixtureRepo();
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LEARNINGS_SOURCE = (line: string) => `
export function renderDoctrinePreamble(): string {
  return "${line}";
}

export function unrelatedLearningHelper(): string {
  return "steady";
}
`;

const RUN_TASK_SOURCE = (line: string) => `
export function unrelatedRunTaskHelper(): string {
  return "${line}";
}
`;

test("W1-T3077: a diff that edits a named prompt-surface function and adds no golden fixture is refused with the surface named", () => {
  withFixture((root) => {
    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("old doctrine"));
    commit(root, "base");

    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("new doctrine"));
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.surfaces, ["src/lib/learnings.ts:renderDoctrinePreamble"]);
    assert.match(result.message, /renderDoctrinePreamble/);
    assert.match(result.message, /test\/fixtures\/golden-verdicts/);
  });
});

test("W1-T3077: the same diff plus a fixture under test/fixtures/golden-verdicts passes, and a diff to an unrelated run-task.ts function passes", () => {
  withFixture((root) => {
    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("old doctrine"));
    commit(root, "base");

    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("new doctrine"));
    write(root, "test/fixtures/golden-verdicts/prompt-surface/golden.yaml", "id: prompt-surface\n");
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.evidence, ["test/fixtures/golden-verdicts/prompt-surface/golden.yaml"]);
  });

  withFixture((root) => {
    write(root, "src/run-task.ts", RUN_TASK_SOURCE("old value"));
    commit(root, "base");

    write(root, "src/run-task.ts", RUN_TASK_SOURCE("new value"));
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.surfaces, []);
  });
});

test("prompt surface gate: a learnings shard edit is refused unless the diff carries golden evidence", () => {
  withFixture((root) => {
    write(root, "learnings/testing.yaml", "- id: before\n  fact: old\n");
    commit(root, "base");

    write(root, "learnings/testing.yaml", "- id: before\n  fact: new\n");
    commit(root, "head");

    const result = mod.evaluatePromptSurfaceGate({ root, base: "HEAD^" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.surfaces, ["learnings/testing.yaml"]);
  });
});
