import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// @ts-expect-error — the executable script has no declaration output.
import * as workflowGuard from "#scripts/workflow-guard-mutation-ratchet.mjs";

const { main, catcherFirst } = workflowGuard as {
  main(argv: string[], io: Record<string, unknown>): number;
  catcherFirst(job: string, suites: string[], textOf: (suite: string) => string): string[];
};

const WORKFLOW = ".github/workflows/ci.yml";
const CI = [
  "jobs:",
  "  build:",
  "    steps:",
  "      - run: |",
  '          if [ "$A" = "1" ]; then',
  "            exit 0",
  "          fi",
  "  build-required:",
  "    steps:",
  "      - run: |",
  '          if [ "$B" = "1" ]; then',
  "            exit 0",
  "          fi",
  "",
].join("\n");
const SUITES = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"];
const TEXT: Record<string, string> = {
  "test/a.test.ts": "// reads ci.yml and names no job\n",
  "test/b.test.ts": '// reads ci.yml for jobs["build-required"]\n',
  "test/c.test.ts": '// reads ci.yml for jobs["build"]\n',
  "test/d.test.ts": "// reads ci.yml for the build job and the build-required job\n",
};

test("a guard's catcher-first order puts suites naming its job first, keeps corpus order, and drops none", () => {
  assert.deepEqual(catcherFirst("build", SUITES, (s) => TEXT[s]!), ["test/c.test.ts", "test/d.test.ts", "test/a.test.ts", "test/b.test.ts"]);
  assert.deepEqual(catcherFirst("build-required", SUITES, (s) => TEXT[s]!), ["test/b.test.ts", "test/d.test.ts", "test/a.test.ts", "test/c.test.ts"]);
  assert.deepEqual(catcherFirst("deploy", SUITES, (s) => TEXT[s]!), SUITES);
  assert.deepEqual(catcherFirst("a.b", ["x", "y"], (s) => (s === "y" ? "a.b" : "axb")), ["y", "x"]);
});

test("each mutant asks the suites naming its job first, the corpus control keeps corpus order, and verdicts are unchanged", () => {
  const repo = gitRepo({ kind: "workflow-mutant" });
  const parent = mkdtempSync(join(tmpdir(), "rmd-workflow-mutant-order-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  try {
    write(WORKFLOW, CI);
    for (const suite of SUITES) write(suite, TEXT[suite]!);
    repo.git("add", ".");
    repo.git("commit", "--quiet", "-m", "seed workflow");
    symlinkSync(join(REPO_ROOT, "node_modules"), join(repo.dir, "node_modules"), "dir");
    const asked: Array<{ tree: string; suite: string }> = [];
    const lines: string[] = [];
    const code = main(["--all"], {
      root: repo.dir,
      scratchParent: parent,
      readBaseline: () => ({ guards: {} }),
      suites: () => SUITES,
      log: (line: string) => lines.push(line),
      err: (line: string) => assert.fail(line),
      runSuite: (suite: string, root: string) => {
        const text = readFileSync(join(root, WORKFLOW), "utf8");
        const tree = text === CI ? "original" : text.split("\n")[4] !== CI.split("\n")[4] ? "build mutant" : "build-required mutant";
        asked.push({ tree, suite });
        // Only d tells either mutant apart, so every guard runs until d and is COVERED by it.
        return { failed: tree !== "original" && suite === "test/d.test.ts" };
      },
    });
    assert.equal(code, 0);
    const order = (tree: string) => asked.filter((a) => a.tree === tree).map((a) => a.suite);
    assert.deepEqual(order("original"), SUITES);
    assert.deepEqual(order("build mutant"), ["test/c.test.ts", "test/d.test.ts"]);
    assert.deepEqual(order("build-required mutant"), ["test/b.test.ts", "test/d.test.ts"]);
    assert.equal(lines.filter((line) => /distinguished by test\/d\.test\.ts/.test(line)).length, 2);
  } finally {
    repo.cleanup();
    rmSync(parent, { recursive: true, force: true });
  }
});
