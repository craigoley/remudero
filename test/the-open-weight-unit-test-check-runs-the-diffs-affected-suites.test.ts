/**
 * W1-T6091 — WHY THIS FILE EXISTS. `OPENWEIGHT_CHECKS.unit_test` was `node --test` with no file
 * list: a lane's `run_check unit_test` ran the WHOLE suite (~21 min, MEASURED 2026-10-06) under a
 * 10-minute OPENWEIGHT_CHECK_TIMEOUT_MS, so every call timed out after ~70 core-minutes and left
 * no ledger row saying it had happened.
 *
 * In a tree carrying the selector, the HARNESS now derives the file list from the worktree's own
 * diff against its merge base — never from a model argument — and runs it niced, at a capped
 * concurrency; a full or oversized selection is a named refusal, an empty one runs nothing. Every
 * run_check call, any check, appends one ledger row.
 *
 * FALSIFIER: keep the fixed whole-tree argv and the first test's argv carries no file operand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/lib/config.js";
import type { AffectedSelection } from "../src/lib/affected-suites.js";
import { defaultPreflightSpawn as defaultSpawn } from "../src/lib/commit-message.js";
import {
  OPENWEIGHT_CHECKS,
  OPENWEIGHT_RUN_CHECK_LEDGER_STEP,
  OPENWEIGHT_UNIT_TEST_CONCURRENCY,
  OPENWEIGHT_UNIT_TEST_MAX_SUITES,
  OPENWEIGHT_UNIT_TEST_TOO_BROAD,
  openWeightUnitTestPlan,
  selectOpenWeightUnitTestSuites,
  selectOpenWeightUnitTestSuitesOffLoop,
  spawnOpenWeightWorker,
} from "../src/lib/worker-provider.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

/** A git tree shaped like remudero's: the selector marker, a source module, the suite that
 *  names it, an unrelated suite, and the setup file — committed, with origin/main at that commit. */
function selectorTree(): GitRepo {
  const repo = gitRepo({ kind: "ow-affected" });
  const put = (rel: string, text: string) => {
    mkdirSync(join(repo.dir, rel, ".."), { recursive: true });
    writeFileSync(join(repo.dir, rel), text);
  };
  put("scripts/diff-class.mjs", "// the selector's census listing lives here in remudero\n");
  put("src/lib/alpha.ts", "export function alpha(): number {\n  return 1;\n}\n");
  put("test/alpha.test.ts", 'import { alpha } from "../src/lib/alpha.js";\nvoid alpha;\n');
  put("test/beta.test.ts", "export {};\n");
  put("test/setup/tmp-hygiene.ts", "export {};\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

function cashConfig(root: string): Config {
  return { claudeBin: "/unused/claude", root, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } } as Config;
}

/** Drive ONE `run_check <check>` through the real tool loop; return the argv(s) run and the tool result. */
async function runCheckIn(
  cwd: string,
  root: string,
  check: string,
  runCheck: (argv: readonly string[]) => string = () => "ok",
): Promise<{ argvs: string[][]; result: Record<string, unknown> }> {
  const argvs: string[][] = [];
  const bodies: string[] = [];
  let turn = 0;
  await spawnOpenWeightWorker(
    {
      cwd,
      workerHome: join(root, "wh"),
      prompt: "run the unit tests",
      tools: ["Read", "RunCheck"],
      maxTurns: 3,
      runId: "run-W1-T6091-1",
      taskId: "W1-T6091",
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-daemon-secret" },
      runCheck: ({ argv }) => {
        argvs.push([...argv]);
        return runCheck(argv);
      },
      fetchImpl: async (_input, init) => {
        bodies.push(String(init?.body ?? ""));
        turn += 1;
        const body = turn === 1
          ? { choices: [{ message: { tool_calls: [{ id: "c1", type: "function", function: { name: "run_check", arguments: JSON.stringify({ check }) } }] } }] }
          : { choices: [{ message: { content: "done" } }] };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    },
    cashConfig(root),
    { model: "gpt-oss-120b", effort: "low" },
  );
  assert.ok(bodies.length >= 2, "the loop must take a second turn carrying the tool result");
  const second = JSON.parse(bodies[1]!) as { messages: Array<{ role: string; content: string }> };
  const tool = second.messages.find((m) => m.role === "tool");
  assert.ok(tool, "the second request must carry the run_check tool result");
  return { argvs, result: JSON.parse(tool.content) as Record<string, unknown> };
}

function runCheckRows(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.step === OPENWEIGHT_RUN_CHECK_LEDGER_STEP);
}

const UNIT_TEST_PREFIX = ["nice", "-n", "10", ...OPENWEIGHT_CHECKS["unit_test"]!];

test("the open-weight unit_test argv names only the harness-derived affected suites of a one-file diff", async () => {
  const repo = selectorTree();
  const root = mkdtempSync(join(tmpdir(), "rmd-ow-affected-root-"));
  try {
    writeFileSync(join(repo.dir, "test", "alpha.test.ts"), 'import { alpha } from "../src/lib/alpha.js";\nvoid alpha();\n');
    const { argvs, result } = await runCheckIn(repo.dir, root, "unit_test");
    assert.equal(argvs.length, 1, "exactly one check process must run, or there is no argv to read");
    const argv = argvs[0]!;
    assert.deepEqual(argv, [...UNIT_TEST_PREFIX, `--test-concurrency=${OPENWEIGHT_UNIT_TEST_CONCURRENCY}`, "test/alpha.test.ts"]);
    assert.ok(!argv.includes("test/beta.test.ts"), "a suite the diff does not reach must not run");
    assert.equal(result.suites, 1);
    assert.equal(result.exitCode, 0);

    const rows = runCheckRows(root);
    assert.equal(rows.length, 1, "one run_check call is one ledger row");
    assert.equal(rows[0]!.check, "unit_test");
    assert.equal(rows[0]!.outcome, "ran");
    assert.equal(rows[0]!.suites, 1);
    assert.equal(rows[0]!.exit_code, 0);
    assert.equal(rows[0]!.timed_out, false);
    assert.equal(typeof rows[0]!.duration_ms, "number");
    assert.equal(rows[0]!.task_id, "W1-T6091");
    assert.equal(rows[0]!.run_id, "run-W1-T6091-1");
  } finally {
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed source symbol selects the suite naming it, not the whole tree", () => {
  const repo = selectorTree();
  try {
    writeFileSync(join(repo.dir, "src", "lib", "alpha.ts"), "export function alpha(): number {\n  return 2;\n}\n");
    const selection = selectOpenWeightUnitTestSuites(repo.dir);
    assert.equal(selection.fullRun, false, selection.reasons.join("; "));
    assert.deepEqual(selection.narrow, ["test/alpha.test.ts"]);
  } finally {
    repo.cleanup();
  }
});

test("the open-weight unit_test check refuses a full selection with its reason and runs nothing", async () => {
  const repo = selectorTree();
  const root = mkdtempSync(join(tmpdir(), "rmd-ow-affected-root-"));
  try {
    writeFileSync(join(repo.dir, "package.json"), "{}\n");
    const { argvs, result } = await runCheckIn(repo.dir, root, "unit_test");
    assert.deepEqual(argvs, [], "a refused selection must not spawn a check");
    assert.equal(result.ran, false);
    assert.match(String(result.refused), new RegExp(`^${OPENWEIGHT_UNIT_TEST_TOO_BROAD}: full run: package\\.json`));
    const rows = runCheckRows(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, "refused");
    assert.match(String(rows[0]!.reason), /package\.json/);
  } finally {
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversized selection is refused with its size, and an empty one runs nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ow-affected-plan-"));
  try {
    mkdirSync(join(dir, "test"));
    const many = Array.from({ length: OPENWEIGHT_UNIT_TEST_MAX_SUITES + 1 }, (_, i) => `test/s${i}.test.ts`);
    for (const s of many) writeFileSync(join(dir, s), "export {};\n");
    const select = (suites: string[]): AffectedSelection => ({ suites, fullRun: false, reasons: [], recentOnly: { floor: [] } });
    const base = [...OPENWEIGHT_CHECKS["unit_test"]!];

    const over = openWeightUnitTestPlan(select(many), base, dir);
    assert.equal(over.kind, "refused");
    assert.ok(over.kind === "refused" && over.suites === many.length);
    assert.match(over.kind === "refused" ? over.reason : "", new RegExp(`${many.length} affected suites exceed the ${OPENWEIGHT_UNIT_TEST_MAX_SUITES}-suite bound`));

    const atBound = openWeightUnitTestPlan(select(many.slice(1)), base, dir);
    assert.equal(atBound.kind, "run");
    assert.ok(atBound.kind === "run" && atBound.argv.includes(`--test-concurrency=${OPENWEIGHT_UNIT_TEST_CONCURRENCY}`));

    // A selected path that is not a present suite file never reaches the argv.
    assert.equal(openWeightUnitTestPlan(select(["test/gone.test.ts", "--inspect"]), base, dir).kind, "empty");
    assert.equal(openWeightUnitTestPlan(select([]), base, dir).kind, "empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a diff that reaches no suite runs nothing and says so", async () => {
  const repo = selectorTree();
  const root = mkdtempSync(join(tmpdir(), "rmd-ow-affected-root-"));
  try {
    mkdirSync(join(repo.dir, "docs"));
    writeFileSync(join(repo.dir, "docs", "note.md"), "# a note\n");
    const { argvs, result } = await runCheckIn(repo.dir, root, "unit_test");
    assert.deepEqual(argvs, []);
    assert.equal(result.ran, false);
    assert.equal(result.suites, 0);
    assert.match(String(result.output), /nothing ran/);
    assert.equal(runCheckRows(root)[0]!.outcome, "empty");
  } finally {
    repo.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable diff or selector input is a full selection naming why", async () => {
  const plain = mkdtempSync(join(tmpdir(), "rmd-ow-affected-plain-"));
  const repo = selectorTree();
  try {
    const notGit = selectOpenWeightUnitTestSuites(plain);
    assert.equal(notGit.fullRun, true);
    assert.match(notGit.reasons[0]!, /the worktree's diff could not be read/);

    writeFileSync(join(repo.dir, "test", "alpha.test.ts"), "export {};\n");
    const failingListing = selectOpenWeightUnitTestSuites(repo.dir, (file, args, opts) => {
      if (file === process.execPath) return { status: 2, stdout: "", stderr: "listing broke" };
      return defaultSpawn(file, args, opts);
    });
    assert.equal(failingListing.fullRun, true);
    assert.match(failingListing.reasons[0]!, /could not read its input.*listing broke/);

    const offLoop = await selectOpenWeightUnitTestSuitesOffLoop(join(plain, "absent"), { PATH: process.env.PATH ?? "" });
    assert.equal(offLoop.fullRun, true);
    assert.match(offLoop.reasons[0]!, /the selection failed/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("every run_check call reaches the ledger with its check name, duration and exit", async () => {
  const consumer = mkdtempSync(join(tmpdir(), "rmd-ow-affected-consumer-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-ow-affected-root-"));
  try {
    // A consumer tree (no selector) keeps the fixed whole-tree argv, and is ledgered all the same.
    const whole = await runCheckIn(consumer, root, "unit_test");
    assert.deepEqual(whole.argvs, [["node", "--import", "tsx", "--test", "--test-reporter=tap"]]);
    assert.equal("suites" in whole.result, false);

    const timedOut = await runCheckIn(consumer, root, "typecheck", () => {
      throw Object.assign(new Error("spawnSync ETIMEDOUT"), { killed: true, signal: "SIGTERM", code: null });
    });
    assert.equal(timedOut.result.exitCode, 1);

    const rows = runCheckRows(root);
    assert.equal(rows.length, 2, "two run_check calls are two ledger rows");
    assert.deepEqual(rows.map((r) => [r.check, r.outcome, r.suites, r.exit_code, r.timed_out]), [
      ["unit_test", "ran", null, 0, false],
      ["typecheck", "ran", null, 1, true],
    ]);
    for (const row of rows) assert.equal(typeof row.duration_ms, "number");
  } finally {
    rmSync(consumer, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
