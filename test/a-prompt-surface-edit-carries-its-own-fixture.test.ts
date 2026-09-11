import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";

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
  evaluatePromptSurfaceDiff: (
    diffText: string,
    opts: { root: string; base: string; head?: string },
  ) => GateResult;
  readGitDiff: (root: string, base: string, head?: string) => string;
  functionRanges: (path: string, text: string) => Array<{ symbol: string; start: number; end: number }>;
  main: (
    argv: string[],
    io: { log: (msg: string) => void; error: (msg: string) => void },
  ) => number;
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
  return gitRepo({ seedCommit: false, kind: "prompt-surface-gate" }).dir;
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

test("W1-T3077: readGitDiff surfaces git's own failure rather than swallowing an unresolvable base ref", () => {
  withFixture((root) => {
    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("only doctrine"));
    commit(root, "only commit");

    assert.throws(() => mod.readGitDiff(root, "no-such-ref-at-all"), /git diff .* failed/);
  });
});

test("W1-T3077: functionRanges skips rather than throws on an unmatched signature paren, a bodyless signature, and braces that never balance", () => {
  const unmatchedParen = "export function renderDoctrinePreamble(\n  a: string,\n  no closing paren ever\n";
  assert.deepEqual(mod.functionRanges("src/lib/learnings.ts", unmatchedParen), []);

  const noBodyBrace =
    "export function renderDoctrinePreamble(\n  a,\n  b\n)\n\n// no opening brace ever follows this signature\n";
  assert.deepEqual(mod.functionRanges("src/lib/learnings.ts", noBodyBrace), []);

  const unbalancedBraces = 'export function renderDoctrinePreamble() {\n  if (true) {\n    return "ok";\n  \n';
  assert.deepEqual(mod.functionRanges("src/lib/learnings.ts", unbalancedBraces), []);
});

test("W1-T3077: functionRanges scans past line/block comments and escaped or unterminated quotes inside a matched body", () => {
  const withComments =
    'export function renderDoctrinePreamble() {\n  // a line comment\n  /* a block comment */\n  return "ok";\n}\n';
  const commentRanges = mod.functionRanges("src/lib/learnings.ts", withComments);
  assert.equal(commentRanges.length, 1);
  assert.equal(commentRanges[0].symbol, "renderDoctrinePreamble");

  const withEscapedQuote = 'export function renderDoctrinePreamble() {\n  return "a \\" quote";\n}\n';
  const escapedRanges = mod.functionRanges("src/lib/learnings.ts", withEscapedQuote);
  assert.equal(escapedRanges.length, 1);
  assert.equal(escapedRanges[0].symbol, "renderDoctrinePreamble");

  const withUnterminatedQuote = 'export function renderDoctrinePreamble() {\n  return "unterminated';
  assert.deepEqual(mod.functionRanges("src/lib/learnings.ts", withUnterminatedQuote), []);
});

test("W1-T3077: evidence for a touched surface falls back to a worktree read, and then to empty, once the given head cannot be read from git", () => {
  withFixture((root) => {
    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("old doctrine"));
    commit(root, "only commit");

    write(root, "test/renders-doctrine-preamble.test.ts", "renderDoctrinePreamble();\n");

    const diffText = [
      "diff --git a/src/lib/learnings.ts b/src/lib/learnings.ts",
      "--- a/src/lib/learnings.ts",
      "+++ b/src/lib/learnings.ts",
      "@@ -2,3 +2,3 @@",
      "diff --git a/test/renders-doctrine-preamble.test.ts b/test/renders-doctrine-preamble.test.ts",
      "--- /dev/null",
      "+++ b/test/renders-doctrine-preamble.test.ts",
      "@@ -0,0 +1,1 @@",
      "diff --git a/test/phantom-never-written.test.ts b/test/phantom-never-written.test.ts",
      "--- /dev/null",
      "+++ b/test/phantom-never-written.test.ts",
      "@@ -0,0 +1,1 @@",
    ].join("\n");

    // "no-such-ref-at-all" makes every `git show <head>:<path>` read fail, forcing evidenceFor's
    // worktree-read fallback for the test path that exists on disk, and its own empty-string
    // fallback for the one that was only ever named in the (hand-built) diff above.
    const result = mod.evaluatePromptSurfaceDiff(diffText, { root, base: "HEAD", head: "no-such-ref-at-all" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.evidence, [
      "test/renders-doctrine-preamble.test.ts",
      "test/phantom-never-written.test.ts",
    ]);
  });
});

test("W1-T3077 main(): exits 0 and logs on a clean diff, 1 and errors the refusal on a touched surface, and 1 from a caught git failure", () => {
  withFixture((root) => {
    write(root, "src/run-task.ts", RUN_TASK_SOURCE("old value"));
    commit(root, "base");
    write(root, "src/run-task.ts", RUN_TASK_SOURCE("new value"));
    commit(root, "head");

    const logs: string[] = [];
    const errors: string[] = [];
    const code = mod.main(["--base", "HEAD^", "--worktree-path", root], {
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
    });
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /OK/);
  });

  withFixture((root) => {
    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("old doctrine"));
    commit(root, "base");
    write(root, "src/lib/learnings.ts", LEARNINGS_SOURCE("new doctrine"));
    commit(root, "head");

    const logs: string[] = [];
    const errors: string[] = [];
    const code = mod.main(["--base", "HEAD^", "--worktree-path", root], {
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
    });
    assert.equal(code, 1);
    assert.deepEqual(logs, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /REFUSED/);
  });

  withFixture((root) => {
    write(root, "src/run-task.ts", RUN_TASK_SOURCE("old value"));
    commit(root, "only commit");

    const logs: string[] = [];
    const errors: string[] = [];
    const previousBaseRef = process.env.GITHUB_BASE_REF;
    delete process.env.GITHUB_BASE_REF;
    try {
      // No `--base` and no GITHUB_BASE_REF: main() falls back to "origin/main", which does not
      // exist in this bare fixture repo, so the git failure is caught rather than thrown.
      const code = mod.main(["--worktree-path", root], {
        log: (m) => logs.push(m),
        error: (m) => errors.push(m),
      });
      assert.equal(code, 1);
      assert.deepEqual(logs, []);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /REFUSED/);
    } finally {
      if (previousBaseRef === undefined) delete process.env.GITHUB_BASE_REF;
      else process.env.GITHUB_BASE_REF = previousBaseRef;
    }
  });
});
