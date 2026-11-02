import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OPENWEIGHT_UNIT_TEST_MAX_SUITES,
  OPENWEIGHT_UNIT_TEST_TOO_BROAD,
  selectOpenWeightUnitTestSuites,
  spawnOpenWeightWorker,
} from "#src/lib/worker-provider.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

function put(repo: GitRepo, path: string, text = "export {};\n"): void {
  mkdirSync(join(repo.dir, path, ".."), { recursive: true });
  writeFileSync(join(repo.dir, path), text);
}

function consumer(): GitRepo {
  const repo = gitRepo({ kind: "consumer-unit-test" });
  put(repo, "package.json", JSON.stringify({ scripts: { test: "node --import tsx --test" } }));
  put(repo, "src/alpha.ts");
  put(repo, "src/view.tsx");
  put(repo, "test/alpha.test.ts");
  put(repo, "test/view.test.ts");
  put(repo, "test/unrelated.test.ts");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

async function check(repo: GitRepo, fail = false): Promise<{
  argvs: string[][];
  result: Record<string, unknown>;
  row: Record<string, unknown>;
}> {
  const root = join(repo.dir, ".harness");
  const argvs: string[][] = [];
  let result: Record<string, unknown> = {};
  let turn = 0;
  await spawnOpenWeightWorker({
    cwd: repo.dir,
    workerHome: join(root, "home"),
    prompt: "run unit tests",
    tools: ["RunCheck"],
    maxTurns: 3,
    runId: "consumer-run",
    taskId: "W1-T6113",
    env: { RMD_OPENWEIGHT_API_KEY: "fixture" },
    runCheck: ({ argv }) => {
      argvs.push([...argv]);
      if (fail) throw Object.assign(new Error("fixture failure"), { status: 2, stderr: "test failed" });
      return "ok";
    },
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
  assert.equal(rows[0]!.scope_rule, "consumer: changed tests + changed source basenames");
  return { argvs, result, row: rows[0]! };
}

test("test/a-consumer-open-weight-unit-test-is-bounded.test.ts: runs only changed tests and source basename matches, niced and bounded", async () => {
  const repo = consumer();
  try {
    put(repo, "src/alpha.ts", "export const changed = true;\n");
    put(repo, "src/view.tsx", "export const view = <div />;\n");
    put(repo, "tests/nested/alpha.test.js");
    repo.git("add", "tests");
    put(repo, "test/changed.test.ts");
    put(repo, "test/unrelated.test.ts", "export const edited = true;\n");
    const { argvs, result, row } = await check(repo);
    assert.equal(argvs.length, 1);
    assert.deepEqual(argvs[0]!.slice(0, 8), ["nice", "-n", "10", "node", "--import", "tsx", "--test", "--test-reporter=tap"]);
    assert.match(argvs[0]![8]!, /^--test-concurrency=[1-9][0-9]*$/);
    assert.deepEqual(argvs[0]!.slice(9), [
      "test/alpha.test.ts", "test/changed.test.ts", "test/unrelated.test.ts", "test/view.test.ts", "tests/nested/alpha.test.js",
    ]);
    assert.equal(result.suites, 5);
    assert.equal(row.outcome, "ran");
    assert.equal(row.exit_code, 0);
  } finally { repo.cleanup(); }
});

test("test/a-consumer-open-weight-unit-test-is-bounded.test.ts: excludes unrelated and deleted suites and uses the merge base", async () => {
  const repo = consumer();
  try {
    put(repo, "src/alpha.ts", "export const committed = true;\n");
    repo.git("add", "src");
    repo.git("commit", "--quiet", "-m", "worker change");
    repo.git("checkout", "-b", "remote", "refs/remotes/origin/main");
    put(repo, "test/unrelated.test.ts", "export const remote = true;\n");
    repo.git("add", "test");
    repo.git("commit", "--quiet", "-m", "main change");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    repo.git("checkout", "main");
    rmSync(join(repo.dir, "test/unrelated.test.ts"));
    const { argvs } = await check(repo);
    assert.deepEqual(argvs[0]!.slice(9), ["test/alpha.test.ts"]);
  } finally { repo.cleanup(); }
});

test("test/a-consumer-open-weight-unit-test-is-bounded.test.ts: empty scope runs nothing and records its rule", async () => {
  const repo = consumer();
  try {
    put(repo, "docs/note.md", "a note\n");
    const { argvs, result, row } = await check(repo);
    assert.deepEqual(argvs, []);
    assert.equal(result.ran, false);
    assert.equal(result.suites, 0);
    assert.match(String(result.output), /nothing ran/);
    assert.equal(row.outcome, "empty");
    assert.match(String(row.reason), /consumer/);
  } finally { repo.cleanup(); }
});

test("test/a-consumer-open-weight-unit-test-is-bounded.test.ts: accepts the cap and refuses one suite beyond it", async () => {
  const repo = consumer();
  try {
    for (let i = 0; i < OPENWEIGHT_UNIT_TEST_MAX_SUITES; i++) put(repo, `test/new-${i}.test.ts`);
    const at = await check(repo);
    assert.equal(at.result.suites, OPENWEIGHT_UNIT_TEST_MAX_SUITES);
    assert.equal(at.argvs.length, 1);
    rmSync(join(repo.dir, ".harness"), { recursive: true });
    put(repo, "test/over.test.ts");
    const over = await check(repo);
    assert.deepEqual(over.argvs, []);
    assert.equal(over.result.ran, false);
    assert.equal(over.result.suites, OPENWEIGHT_UNIT_TEST_MAX_SUITES + 1);
    assert.ok(String(over.result.refused).startsWith(OPENWEIGHT_UNIT_TEST_TOO_BROAD));
    assert.equal(over.row.outcome, "refused");
  } finally { repo.cleanup(); }
});

test("test/a-consumer-open-weight-unit-test-is-bounded.test.ts: unreadable diff refuses instead of running the whole tree", async () => {
  const repo = consumer();
  try {
    repo.git("update-ref", "-d", "refs/remotes/origin/main");
    const { argvs, result, row } = await check(repo);
    assert.deepEqual(argvs, []);
    assert.match(String(result.refused), /diff could not be read/);
    assert.equal(row.outcome, "refused");
  } finally { repo.cleanup(); }
});

test("test/a-consumer-open-weight-unit-test-is-bounded.test.ts: unsupported consumer runner is a named refusal", async () => {
  const repo = consumer();
  try {
    put(repo, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    put(repo, "test/alpha.test.ts", "export const changed = true;\n");
    const { argvs, result } = await check(repo);
    assert.deepEqual(argvs, []);
    assert.match(String(result.refused), /consumer unit_test requires node --test/);
  } finally { repo.cleanup(); }
});

test("test/a-consumer-open-weight-unit-test-is-bounded.test.ts: failing checks keep the scope rule and failure", async () => {
  const repo = consumer();
  try {
    put(repo, "test/alpha.test.ts", "export const changed = true;\n");
    const { argvs, result, row } = await check(repo, true);
    assert.equal(argvs.length, 1);
    assert.equal(result.exitCode, 2);
    assert.equal(row.exit_code, 2);
    assert.equal(row.outcome, "ran");
  } finally { repo.cleanup(); }
});

test("test/a-consumer-open-weight-unit-test-is-bounded.test.ts: consumer selection reads no harness census scripts", () => {
  const repo = consumer();
  try {
    put(repo, "test/alpha.test.ts", "export const changed = true;\n");
    const selection = selectOpenWeightUnitTestSuites(repo.dir);
    assert.equal(selection.fullRun, false, selection.reasons.join("; "));
    assert.deepEqual(selection.suites, ["test/alpha.test.ts"]);
    assert.match(selection.reasons.join("; "), /consumer/);
  } finally { repo.cleanup(); }
});

test("test/a-consumer-open-weight-unit-test-is-bounded.test.ts: filenames stay operands and external symlinks refuse", async () => {
  const repo = consumer();
  const outside = consumer();
  try {
    put(repo, "--inspect.test.js");
    put(repo, "test/space name.test.ts");
    const ran = await check(repo);
    assert.deepEqual(ran.argvs[0]!.slice(9), ["./--inspect.test.js", "test/space name.test.ts"]);
    rmSync(join(repo.dir, ".harness"), { recursive: true });
    symlinkSync(join(outside.dir, "test/alpha.test.ts"), join(repo.dir, "test/escape.test.ts"));
    const refused = await check(repo);
    assert.deepEqual(refused.argvs, []);
    assert.match(String(refused.result.refused), /escapes the worker cwd/);
  } finally { repo.cleanup(); outside.cleanup(); }
});
