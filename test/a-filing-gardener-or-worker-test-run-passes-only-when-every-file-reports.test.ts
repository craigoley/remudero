/**
 * W1-T8380 — a filing PR's shard census, the gate gardener's clock-shifted defuse run and the
 * open-weight worker's `unit_test` check each judge their `node --test` run by its per-file
 * summaries (scripts/pure-test-pool.mjs's judge), as #10894/#10918/#11000 do for CI, pre-push and
 * the review's proof runner.
 *
 * Each test drives the REAL runner with a test file that registers one passing test and then
 * calls the real `process.exit(0)` before its next test runs: node reports the file, loses the
 * rest, and exits 0. A control file that finishes still passes at every site.
 * FALSIFIER: drop the judgment at any one site and its test reads a pass — status 0 from the shard
 * census, `true` from `runSuiteShifted`, `exitCode: 0` from the unit_test check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planPrPreflight, planPrPreflightAsync } from "../src/lib/plan-pr-emitter.js";
import { runSuiteShifted } from "../src/lib/gate-gardener.js";
import { spawnOpenWeightWorker } from "../src/lib/worker-provider.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UNREPORTED = "test-judge: UNREPORTED FILE ";

/** One passing test, then the real `process.exit(0)` before the next test runs. */
const EXITS_EARLY = [
  `import { test } from "node:test";`,
  `test("the first test passes", () => {});`,
  `test("the second test exits the process", () => { process.exit(0); });`,
  `test("the third test never runs", () => { throw new Error("unreachable"); });`,
  "",
].join("\n");
/** The control: the same tests, finishing. */
const FINISHES = [
  `import { test } from "node:test";`,
  `test("the first test passes", () => {});`,
  `test("the second test passes", () => {});`,
  "",
].join("\n");

function scratch(t: { after: (fn: () => void) => void }, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t8380-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GREEN = { status: 0, output: "" };

test("W1-T8380: a filing PR shard census fails when the suite exits 0 before its summary", async (t) => {
  const census = "test/every-shard-on-main-is-lintable.test.ts";
  const tree = (source: string): string => {
    const dir = scratch(t, "census");
    symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, census), source);
    return dir;
  };
  const input = (cwd: string) => ({ cwd, title: "chore(plan): file a task", body: "" });
  const stubs = { lintPlan: () => GREEN, taskIdExistence: () => GREEN, checkProof: () => 0, budgetMs: () => 120_000 };
  const asyncStubs = { lintPlan: async () => GREEN, taskIdExistence: async () => GREEN, checkProof: async () => 0, budgetMs: () => 120_000 };

  const early = tree(EXITS_EARLY);
  for (const result of [planPrPreflight(input(early), stubs), await planPrPreflightAsync(input(early), asyncStubs)]) {
    const finding = result.failures.find((f) => f.check === "shard-census");
    assert.ok(finding, `an exit-0 census that never reached its summary is a failed reading: ${JSON.stringify(result)}`);
    assert.equal(result.ok, false, "the filing is refused");
    assert.match(finding.firstLine, /^test-judge: SHARD CENSUS RUN INCOMPLETE/, "the finding leads with the judge's line");
    assert.ok((finding.lines ?? []).includes(`${UNREPORTED}${census}`), `the finding names the unreported file: ${JSON.stringify(finding)}`);
  }

  const done = tree(FINISHES);
  for (const result of [planPrPreflight(input(done), stubs), await planPrPreflightAsync(input(done), asyncStubs)]) {
    assert.equal(result.failures.find((f) => f.check === "shard-census"), undefined, `a census that finished stays green: ${JSON.stringify(result)}`);
    assert.equal(result.unreadable.find((f) => f.check === "shard-census"), undefined, "and is read, not unreadable");
  }
});

test("W1-T8380: a shifted defuse run that exits 0 before its summary reaches no verdict", (t) => {
  const dir = scratch(t, "defuse");
  const early = join(dir, "exits-early.test.mjs");
  const done = join(dir, "finishes.test.mjs");
  writeFileSync(early, EXITS_EARLY);
  writeFileSync(done, FINISHES);

  assert.throws(
    () => runSuiteShifted(REPO_ROOT, early, 2),
    (e: unknown) => String((e as Error).message).includes(`${UNREPORTED}${early}`) && /reaches no verdict/.test(String((e as Error).message)),
    "an exit-0 run that never reached its summary is no verdict, never `shifted_passed`",
  );
  assert.equal(runSuiteShifted(REPO_ROOT, done, 2), true, "a run that finished still passes");
});

/** Drive ONE `run_check unit_test` through the real tool loop and real runner; bwrap is replaced by a pass-through. */
async function unitTestCheck(repo: GitRepo, sandboxDir: string): Promise<{ result: Record<string, unknown>; row: Record<string, unknown> }> {
  const root = join(repo.dir, ".harness");
  let result: Record<string, unknown> = {};
  let turn = 0;
  await spawnOpenWeightWorker({
    cwd: repo.dir,
    workerHome: join(root, "home"),
    prompt: "run unit tests",
    tools: ["RunCheck"],
    maxTurns: 3,
    runId: "w1-t8380-run",
    taskId: "W1-T8380",
    env: { RMD_OPENWEIGHT_API_KEY: "fixture", PATH: `${sandboxDir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    fetchImpl: async (_input, init) => {
      if (++turn === 1) {
        return Response.json({ choices: [{ message: { tool_calls: [{
          id: "check", type: "function", function: { name: "run_check", arguments: '{"check":"unit_test"}' },
        }] } }] });
      }
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const tool = body.messages.find((message) => message.role === "tool");
      assert.ok(tool);
      result = JSON.parse(tool.content) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: "done" } }] });
    },
  }, {
    claudeBin: "/unused/claude", root, dailyCapUsd: 1,
    workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" },
  }, { model: "gpt-oss-120b", effort: "low" });
  const rows = readFileSync(join(root, "state/ledger.ndjson"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.step === "cash.run_check");
  assert.equal(rows.length, 1);
  return { result, row: rows[0]! };
}

test("W1-T8380: an open-weight unit_test check that stops before its summary reports a failure", async (t) => {
  // The namespace wrapper is the one thing replaced: a `bwrap` on the check's PATH that drops its own flags and execs the
  // fixed argv in the worktree, so the real runner, the real `node --test` child and the real judge all run.
  const sandboxDir = scratch(t, "sandbox");
  writeFileSync(join(sandboxDir, "bwrap"), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
  chmodSync(join(sandboxDir, "bwrap"), 0o755);
  const consumer = (source: string): GitRepo => {
    const repo = gitRepo({ kind: "w1-t8380-unit-test" });
    t.after(() => repo.cleanup());
    writeFileSync(join(repo.dir, "package.json"), JSON.stringify({ scripts: { test: "node --import tsx --test" } }));
    writeFileSync(join(repo.dir, ".gitignore"), "node_modules\n.harness\n");
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "-m", "base");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    symlinkSync(join(REPO_ROOT, "node_modules"), join(repo.dir, "node_modules"));
    mkdirSync(join(repo.dir, "test"));
    writeFileSync(join(repo.dir, "test", "changed.test.mjs"), source);
    return repo;
  };

  const early = await unitTestCheck(consumer(EXITS_EARLY), sandboxDir);
  assert.equal(early.result.suites, 1, "the one changed suite ran");
  assert.notEqual(early.result.exitCode, 0, `an exit-0 run that never reached its summary is red: ${JSON.stringify(early.result)}`);
  assert.equal(typeof early.result.exitCode, "number");
  assert.ok(String(early.result.output).includes(`${UNREPORTED}test/changed.test.mjs`), `the output carries the judge's line: ${early.result.output}`);
  assert.equal(early.row.exit_code, early.result.exitCode, "the ledger records the same exit code the lane reads");

  const done = await unitTestCheck(consumer(FINISHES), sandboxDir);
  assert.equal(done.result.exitCode, 0, `a run that finished stays green: ${JSON.stringify(done.result)}`);
  assert.match(String(done.result.output), /# pass 2/);
  assert.ok(!String(done.result.output).includes('{"version":1,'), "the judge's tally line is taken off the output");
  assert.equal(done.row.exit_code, 0);
});
