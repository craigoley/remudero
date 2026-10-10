import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import { gitRepo } from "./helpers/git-repo.js";

// 2026-10-10: three main reds, each from a test a PR ADDED that passed the one time its PR ran it.
// scripts/flake-screen.mjs reruns every added test file before merge; these pin what it screens,
// how long, and that one failed run fails the shard.

const root = process.cwd();
const script = join(root, "scripts/flake-screen.mjs");
type RunResult = { ok: boolean; output: string };
type Screen = {
  addedTestFiles(base: string, opts?: { cwd?: string }): string[];
  screenBudgetMs(root?: string): number;
  screen(opts: { files: string[]; budgetMs: number; concurrency: number; runFile: (f: string) => Promise<RunResult>; now?: () => number }): Promise<{
    passes: Map<string, number>;
    failure?: { file: string; passesBefore: number; output: string };
  }>;
  main(argv: string[], deps?: Record<string, unknown>): Promise<number>;
};
const flake = (existsSync(script) ? await import(pathToFileURL(script).href) : {}) as Screen;

/** A repo whose `origin/main` holds two tests and whose HEAD adds, modifies and deletes around them. */
function addingBranch() {
  const repo = gitRepo({ kind: "flake-screen" });
  mkdirSync(join(repo.dir, "test", "helpers"), { recursive: true });
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "test", "kept.test.ts"), "// kept\n");
  writeFileSync(join(repo.dir, "test", "gone.test.ts"), "// gone\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, "test", "kept.test.ts"), "// kept, edited\n");
  rmSync(join(repo.dir, "test", "gone.test.ts"));
  writeFileSync(join(repo.dir, "test", "fresh.test.ts"), 'import { test } from "node:test";\ntest("fresh", () => {});\n');
  writeFileSync(join(repo.dir, "test", "helpers", "aid.ts"), "export {};\n");
  writeFileSync(join(repo.dir, "src", "leaf.ts"), "export {};\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "pull request");
  return repo;
}

/** A clock each run advances by `stepMs`, and a runner whose `fails` set names the 1-based run of a file that fails. */
function fakeRuns(stepMs: number, fails: Record<string, number[]> = {}) {
  let clock = 0;
  const seen = new Map<string, number>();
  return {
    now: () => clock,
    runFile: async (file: string): Promise<RunResult> => {
      const n = (seen.get(file) ?? 0) + 1;
      seen.set(file, n);
      clock += stepMs;
      const bad = (fails[file] ?? []).includes(n);
      return { ok: !bad, output: bad ? `not ok 1 - ${file} run ${n}` : "ok 1" };
    },
  };
}

test("only a test file the pull request adds is screened, never a modified, deleted, helper or source file", () => {
  const repo = addingBranch();
  try {
    assert.deepEqual(flake.addedTestFiles("origin/main", { cwd: repo.dir }), ["test/fresh.test.ts"]);
    assert.throws(() => flake.addedTestFiles("origin/no-such-base", { cwd: repo.dir }), /git diff against origin\/no-such-base failed/);
  } finally {
    repo.cleanup();
  }
});

test("the screen repeats every added file until the budget is spent, and stops at the first failing run", async () => {
  const clean = fakeRuns(10);
  const spent = await flake.screen({ files: ["test/a.test.ts", "test/b.test.ts"], budgetMs: 100, concurrency: 1, ...clean });
  assert.equal(spent.failure, undefined);
  assert.deepEqual([...spent.passes.values()], [5, 5], "100 ms of 10 ms runs, round-robin over two files");

  const once = fakeRuns(10);
  const zero = await flake.screen({ files: ["test/a.test.ts", "test/b.test.ts"], budgetMs: 0, concurrency: 4, ...once });
  assert.deepEqual([...zero.passes.values()], [1, 1], "a spent budget still runs each file once");

  const flaky = fakeRuns(10, { "test/b.test.ts": [3] });
  const red = await flake.screen({ files: ["test/a.test.ts", "test/b.test.ts"], budgetMs: 1_000, concurrency: 1, ...flaky });
  assert.deepEqual(red.failure, { file: "test/b.test.ts", passesBefore: 2, output: "not ok 1 - test/b.test.ts run 3" });
  assert.equal(red.passes.get("test/a.test.ts"), 3, "nothing new starts after a failure");
});

test("the budget is the predicted coverage makespan, never shorter than the heaviest file it packs", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-flake-budget-"));
  try {
    mkdirSync(join(dir, "test"));
    mkdirSync(join(dir, "scripts"));
    const files: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(dir, "test", `f${i}.test.ts`), "");
      files[`test/f${i}.test.ts`] = 1_000;
    }
    files["test/f0.test.ts"] = 50_000;
    writeFileSync(join(dir, "scripts", "test-tier-manifest.json"), JSON.stringify({ files }));
    writeFileSync(join(dir, "scripts", "test-tier-coverage-manifest.json"), JSON.stringify({ files: { "test/f0.test.ts": 90_000 } }));
    assert.equal(flake.screenBudgetMs(dir), 90_000, "the instrumented heaviest file sets one shard's wall time");
    assert.ok(flake.screenBudgetMs(root) > 0, "the repository's own ledgers predict a real window");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only shard 1 of a pull request screens, and one failed run fails it with a FLAKE-SCREEN line", async () => {
  const repo = addingBranch();
  const summary = join(repo.dir, "summary.md");
  try {
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    assert.equal(await flake.main(["--shard", "1"], { env: {}, root: repo.dir, log }), 0);
    assert.match(lines.join("\n"), /no pull-request base/);
    lines.length = 0;
    assert.equal(await flake.main(["--list"], { env: {}, root: repo.dir, log }), 0);
    assert.equal(lines.length, 0, "a push lists nothing");
    const env = { GITHUB_BASE_REF: "main", GITHUB_STEP_SUMMARY: summary };
    assert.equal(await flake.main(["--list"], { env, root: repo.dir, log }), 0);
    assert.equal(lines.join("\n"), "test/fresh.test.ts");
    lines.length = 0;
    assert.equal(await flake.main(["--shard", "2"], { env, root: repo.dir, log }), 0);
    assert.match(lines.join("\n"), /shard 2 — 1 added test file\(s\); shard 1 screens them/);

    const pass = fakeRuns(10);
    assert.equal(await flake.main(["--shard", "1"], { env, root: repo.dir, log, budgetMs: 50, concurrency: 1, ...pass }), 0);
    assert.match(lines.join("\n"), /test\/fresh\.test\.ts passed 5 run\(s\)/);

    const fail = fakeRuns(10, { "test/fresh.test.ts": [4] });
    assert.equal(await flake.main(["--shard", "1"], { env, root: repo.dir, log, budgetMs: 1_000, concurrency: 1, ...fail }), 1);
    const flagged = "FLAKE-SCREEN: test/fresh.test.ts failed after 3 passing run(s) — a test this pull request adds is nondeterministic.";
    assert.ok(lines.includes(flagged));
    assert.equal(readFileSync(summary, "utf8"), `- ${flagged}\n`);
  } finally {
    repo.cleanup();
  }
});

test("the default runner really spawns node --test, and a really failing added file fails the screen", async () => {
  const repo = addingBranch();
  try {
    symlinkSync(join(root, "node_modules"), join(repo.dir, "node_modules"));
    mkdirSync(join(repo.dir, "test", "setup"), { recursive: true });
    writeFileSync(join(repo.dir, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
    mkdirSync(join(repo.dir, "scripts"), { recursive: true });
    writeFileSync(join(repo.dir, "scripts", "test-tier-manifest.json"), JSON.stringify({ files: { "test/fresh.test.ts": 1 } }));
    const env = { GITHUB_BASE_REF: "main" };
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    assert.equal(await flake.main(["--shard", "1"], { env, root: repo.dir, log, concurrency: 1 }), 0, lines.join("\n"));
    assert.match(lines.join("\n"), /test\/fresh\.test\.ts passed [1-9]\d* run\(s\)/);

    writeFileSync(join(repo.dir, "test", "fresh.test.ts"), 'import { test } from "node:test";\ntest("red", () => { throw new Error("boom"); });\n');
    lines.length = 0;
    assert.equal(await flake.main(["--shard", "1"], { env, root: repo.dir, log, concurrency: 1 }), 1);
    assert.match(lines.join("\n"), /not ok 1 - red[\s\S]*FLAKE-SCREEN: test\/fresh\.test\.ts failed after 0 passing run\(s\)/);
  } finally {
    repo.cleanup();
  }
});

test("every ci shard runs the flake screen after its tests, and shard 1 installs the browser an added suite may need", () => {
  const ci = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")).jobs.ci as { steps: { name?: string; id?: string; if?: string; run?: string }[] };
  const names = ci.steps.map((s) => s.name ?? "");
  const at = ci.steps.findIndex((s) => s.run?.trim() === "node scripts/flake-screen.mjs --shard ${{ matrix.shard }}");
  assert.ok(at > names.indexOf("Test"), "the screen follows the shard's own test run");
  assert.equal(ci.steps[at]!.if, undefined, "a skipped screen would read as a passed one");
  const admission = ci.steps.find((s) => s.id === "admission")!.run!;
  assert.match(admission, /"\$\{\{ matrix\.shard \}\}" = "1" \] && \[ -n "\$\(node scripts\/flake-screen\.mjs --list[^\n]*\n\s*BROWSER="true"/);
});
