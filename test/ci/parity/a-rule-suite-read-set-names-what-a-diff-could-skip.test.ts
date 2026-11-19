import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { AUTHOR_CENSUS_ANSWERED_ENV, authorCiSplit, listRuleSuites, readAuthorCiContract, runPreflightFast } from "#src/lib/ci-parity.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-expect-error The executable recorder has no declaration file.
import { recordRuleSuiteReads, selectRuleSuites } from "#scripts/record-rule-suite-reads.mjs";

const RECORDER = "scripts/record-rule-suite-reads.mjs";
const RULE_SUITE_RUNNER = "#scripts/list-rule-suites.mjs";
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
type ReadRow = { roots: string[]; sha256: string; incomplete?: boolean };
type SpawnSuite = (command: string, argv: string[]) => { status: number };
type ConcurrentOptions = {
  pressure?: () => unknown;
  run?: (suite: string) => Promise<{ status: number; output: string }>;
};
type RunConcurrently = (root: string, options: ConcurrentOptions) => Promise<number>;

function put(root: string, path: string, contents: string) {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents);
}

test("W1-T11819 criterion 1: the recorder runs each suite once and writes sorted relative roots and source hashes", async (t) => {
  const { dir } = ownedFixtureDir(t, "rule-suite-reads");
  const suites = ["test/rules/z.test.mjs", "test/rules/a.test.mjs"];
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(REPO_ROOT, RECORDER), join(dir, RECORDER));
  put(dir, "src/sync/input", "sync");
  put(dir, "plan/tasks.d/input", "async");
  put(dir, "docs/index/input", "directory");
  put(dir, "other/opened/input", "open");
  for (const suite of suites) {
    put(dir, suite, `
      import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
      import { open, opendir, readFile, readdir } from "node:fs/promises";
      import { test } from "node:test";
      test("read fixture", async () => {
        const syncInput = Buffer.from("src/sync/input");
        readFileSync(syncInput);
        await readFile(new URL("../../plan/tasks.d/input", import.meta.url));
        await (await open("other/opened/input")).close();
        await (await opendir("docs/index")).close();
        await readdir("docs/index");
        statSync("src/sync/input");
        statSync(".");
        existsSync("future/config/input");
        readFileSync(${JSON.stringify(join(REPO_ROOT, "package.json"))});
        appendFileSync("runs.txt", ${JSON.stringify(suite + "\n")});
      });
    `);
  }

  assert.equal(recordRuleSuiteReads(dir, suites, (suite: string) => ["--test", suite]), 0);
  const { RULE_SUITE_READS: record }: { RULE_SUITE_READS: Record<string, ReadRow> } =
    await import(pathToFileURL(join(dir, RECORDER)).href);
  assert.deepEqual(Object.keys(record), [...suites].sort());
  assert.deepEqual(readFileSync(join(dir, "runs.txt"), "utf8").trim().split("\n"), [...suites].sort());
  for (const suite of suites) {
    const { roots, sha256: hash, incomplete } = record[suite]!;
    assert.equal(hash, sha256(readFileSync(join(dir, suite))));
    assert.equal(incomplete, undefined);
    assert.deepEqual(roots, [...new Set(roots)].sort());
    assert.ok(roots.every((root: string) => !root.startsWith("/") && !root.startsWith("../")));
    for (const root of ["docs/index", "future/config", "other/opened", "plan/tasks.d", "src/sync", "test/rules"]) {
      assert.ok(roots.includes(root), `${suite} did not record ${root}: ${roots.join(", ")}`);
    }
    assert.ok(!roots.includes("package.json"), "an absolute read outside the fixture never enters its roots");
    assert.ok(!roots.includes("."), "stat of the checkout does not enumerate its contents");
  }
});

test("W1-T11819 criterion 2: shadow keeps missing, stale, incomplete and intersecting records", (t) => {
  const { dir } = ownedFixtureDir(t, "rule-suite-selection");
  const suites = ["missing", "stale", "incomplete", "gone", "child", "parent", "exact", "whole-tree", "disjoint"];
  for (const suite of suites.filter((suite) => suite !== "gone")) put(dir, suite, "fresh");
  const fresh = (roots: string[]) => ({ sha256: sha256("fresh"), roots });
  const record = {
    stale: { sha256: sha256("old"), roots: ["src/independent"] },
    incomplete: { ...fresh(["src/independent"]), incomplete: true },
    gone: fresh(["src/independent"]),
    child: fresh(["plan/tasks.d"]),
    parent: fresh(["src/lib"]),
    exact: fresh(["package.json"]),
    "whole-tree": fresh(["."]),
    disjoint: fresh(["plan/tasks.data"]),
  };
  const changed = ["plan/tasks.d/task.yaml", "src", "package.json"];
  assert.deepEqual(selectRuleSuites(dir, suites, changed, record), {
    wouldRun: suites.slice(0, -1),
    wouldSkip: ["disjoint"],
  });
});

test("W1-T11819 criterion 3: a shadow run prints one would-skip line and preserves every run and the failed-suite verdict", async (t) => {
  const { main, runRuleSuitesConcurrently } = await import(RULE_SUITE_RUNNER) as {
    main: (argv: string[], run: SpawnSuite | undefined, concurrency: number, runConcurrently?: RunConcurrently) => number | Promise<number>;
    runRuleSuitesConcurrently: RunConcurrently;
  };
  const suites = listRuleSuites(REPO_ROOT);
  const [candidate] = selectRuleSuites(REPO_ROOT, suites, []).wouldSkip;
  assert.ok(candidate, "the committed snapshot contains a fresh suite to exercise the shadow");
  const out: string[] = [];
  const errors: string[] = [];
  t.mock.method(console, "log", (line: string) => void out.push(line));
  t.mock.method(console, "error", (line: string) => void errors.push(line));
  const run = (args: string[]) => {
    const invoked: string[] = [];
    const status = main(args, (_command, argv) => {
      const suite = argv.at(-1)!;
      invoked.push(suite);
      return { status: suite === candidate ? 1 : 0 };
    }, 1);
    assert.deepEqual(invoked, suites);
    return status;
  };
  assert.equal(run(["--run"]), 1);
  const failedLine = errors.at(-1);
  const baseline = [...errors];
  assert.equal(failedLine, `rule-checks: failed suites: ${candidate}`);
  errors.length = 0;
  assert.equal(run(["--run", "--scope", "HEAD"]), 1);
  assert.deepEqual(errors, baseline);
  const shadow = out.filter((line) => line.startsWith("rule-checks: shadow would skip"));
  assert.equal(shadow.length, 1);
  const [count, names] = shadow[0]!.split(": ").slice(1);
  assert.equal(count, `shadow would skip ${names!.split(" ").length}/${suites.length} suites`);
  assert.ok(names!.split(" ").includes(candidate));

  out.length = 0;
  errors.length = 0;
  const concurrent: string[] = [];
  assert.equal(await main(["--run", "--scope", "no-such-rule-suite-base"], undefined, 2,
    (root, options) => runRuleSuitesConcurrently(root, {
      ...options,
      pressure: undefined,
      run: async (suite) => {
        concurrent.push(suite);
        return { status: 0, output: "" };
      },
    })), 0);
  assert.deepEqual(concurrent, suites);
  assert.match(out.join("\n"), /^rule-checks: shadow unavailable:/);
  assert.deepEqual(errors, []);
});

test("the author static stage emits rule-suite shadow data alongside its existing CI split", (t) => {
  const split = authorCiSplit(readAuthorCiContract(REPO_ROOT));
  assert.ok(split.leftToCi.some(({ job }) => job === "rule-checks"));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const log = t.mock.method(console, "log", () => {});
  const saved = process.env[AUTHOR_CENSUS_ANSWERED_ENV];
  process.env[AUTHOR_CENSUS_ANSWERED_ENV] = `${head}:ok`;
  t.after(() => {
    if (saved === undefined) delete process.env[AUTHOR_CENSUS_ANSWERED_ENV];
    else process.env[AUTHOR_CENSUS_ANSWERED_ENV] = saved;
  });
  const result = runPreflightFast(REPO_ROOT, {
    spawn: (_file, args) => {
      assert.ok(!args.includes("scripts/list-rule-suites.mjs"), "hosted CI owns the rule-suite execution on this route");
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.ok, true);
  assert.ok(!result.steps.some(({ name }) => name === "rule-checks"));
  assert.equal(log.mock.calls.filter(({ arguments: [line] }) => String(line).startsWith("rule-checks: shadow would skip")).length, 1);
});
