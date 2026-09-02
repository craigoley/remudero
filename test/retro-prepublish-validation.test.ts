import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RETRO_PREFLIGHT_CAPTURE_BYTES,
  runRetroPrepublishCommand,
  runRetroPrepublishPreflight,
  type RetroPrepublishRunner,
} from "../src/lib/retro-preflight.js";

const provenance = {
  provider: "codex" as const,
  model: "frontier",
  servedModel: "gpt-5.6-sol",
  effort: "high",
  sessionId: "codex-thread-2728",
};

function commandResult(status: number, stdout = "", stderr = "") {
  return { status, signal: null, stdout, stderr };
}

function subprocessOptions(maxBuffer = 64 * 1024, timeout = 5_000) {
  return {
    cwd: process.cwd(),
    encoding: "utf8" as const,
    maxBuffer,
    timeout,
    env: { ...process.env },
  };
}

test("the default runner captures a real subprocess exit and both output streams", async () => {
  const result = await runRetroPrepublishCommand(
    process.execPath,
    ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7"],
    subprocessOptions(),
  );

  assert.equal(result.status, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.error, undefined);
});

test("the default runner terminates a subprocess that exceeds its output ceiling", async () => {
  const result = await runRetroPrepublishCommand(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)"],
    subprocessOptions(32),
  );

  assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "ENOBUFS");
  assert.equal(Buffer.byteLength(result.stdout), 32);
  assert.equal(result.signal, "SIGTERM");
});

test("the default runner terminates a subprocess at its deadline", async () => {
  const result = await runRetroPrepublishCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    subprocessOptions(64 * 1024, 20),
  );

  assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "ETIMEDOUT");
  assert.equal(result.signal, "SIGTERM");
});

test("the default runner returns a spawn error instead of rejecting", async () => {
  const result = await runRetroPrepublishCommand(
    `rmd-retro-preflight-command-that-does-not-exist-${process.pid}`,
    [],
    subprocessOptions(),
  );

  assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
  assert.equal(result.status, -2);
});

test("retro prepublish runs the dynamically enumerated plan-reading suites through test-with-retry", async () => {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const run: RetroPrepublishRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    await Promise.resolve(); // production uses an async child; the orchestrator must await either seam shape
    if (args.includes("--list-plan-reading-suites")) {
      return commandResult(0, "test/a.test.ts\ntest/z.test.ts\n");
    }
    return commandResult(0, "# tests 2\n# pass 2\n");
  };

  const result = await runRetroPrepublishPreflight({
    worktreePath: "/tmp/retro-worktree",
    provenance,
    remotePrExisted: false,
    repair: async () => assert.fail("a passing preflight must not resume the Architect"),
    regenerateHarnessArtifacts: async () => assert.fail("a passing preflight must not regenerate twice"),
    log: (step, extra) => rows.push({ step, extra }),
    deps: { run, now: (() => { let now = 1_000; return () => (now += 25); })() },
  });

  assert.deepEqual(result, { ok: true, attempts: 1, suiteCount: 2, repaired: false });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    command: process.execPath,
    args: ["--import", "tsx", "scripts/diff-class.mjs", "--list-plan-reading-suites"],
    cwd: "/tmp/retro-worktree",
  });
  assert.deepEqual(calls[1], {
    command: process.execPath,
    args: [
      "scripts/test-with-retry.mjs",
      process.execPath,
      "--test",
      "--import", "tsx",
      "--import", "./test/setup/tmp-hygiene.ts",
      "test/a.test.ts",
      "test/z.test.ts",
    ],
    cwd: "/tmp/retro-worktree",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, "retro.preflight_passed");
  assert.deepEqual(
    {
      attempt: rows[0].extra.attempt,
      outcome: rows[0].extra.outcome,
      suiteCount: rows[0].extra.suite_count,
      provider: rows[0].extra.provider,
      model: rows[0].extra.model,
      servedModel: rows[0].extra.served_model,
      effort: rows[0].extra.effort,
      session: rows[0].extra.session_id,
      remotePrExisted: rows[0].extra.remote_pr_existed,
    },
    {
      attempt: 1,
      outcome: "passed",
      suiteCount: 2,
      provider: "codex",
      model: "frontier",
      servedModel: "gpt-5.6-sol",
      effort: "high",
      session: "codex-thread-2728",
      remotePrExisted: false,
    },
  );
  assert.equal(typeof rows[0].extra.elapsed_ms, "number");
});

test("the first failure resumes once with bounded fenced evidence, regenerates, and reruns every suite", async () => {
  const huge = `BEGIN-${"x".repeat(RETRO_PREFLIGHT_CAPTURE_BYTES * 3)}-NEVER-PERSIST-TAIL`;
  const testResults = [
    commandResult(1, `not ok 1 - Standing rule citations agree\n${huge}`, "first stderr"),
    commandResult(0, "# pass 2\n"),
  ];
  let enumerationCalls = 0;
  let testCalls = 0;
  let repairPrompt = "";
  let regenerations = 0;
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const run: RetroPrepublishRunner = (_command, args) => {
    if (args.includes("--list-plan-reading-suites")) {
      enumerationCalls += 1;
      return commandResult(0, "test/rule-citations-match-their-rule.test.ts\ntest/task-linter.test.ts\n");
    }
    testCalls += 1;
    return testResults.shift()!;
  };

  const result = await runRetroPrepublishPreflight({
    worktreePath: "/tmp/retro-worktree",
    provenance,
    remotePrExisted: true,
    repair: async (prompt) => { repairPrompt = prompt; },
    regenerateHarnessArtifacts: async () => { regenerations += 1; },
    log: (step, extra) => rows.push({ step, extra }),
    deps: { run },
  });

  assert.deepEqual(result, { ok: true, attempts: 2, suiteCount: 2, repaired: true });
  assert.equal(enumerationCalls, 2, "the dynamic source of truth is re-read after repair");
  assert.equal(testCalls, 2, "all enumerated suites run again after repair");
  assert.equal(regenerations, 1, "all harness-owned generators rerun after the resumed repair");
  assert.match(repairPrompt, /BEGIN UNTRUSTED RETRO PREFLIGHT EVIDENCE/);
  assert.match(repairPrompt, /END UNTRUSTED RETRO PREFLIGHT EVIDENCE/);
  assert.match(repairPrompt, /Standing rule citations agree/);
  assert.match(repairPrompt, /Do not push, open a PR, create a task, or change branches/);
  assert.ok(repairPrompt.length < RETRO_PREFLIGHT_CAPTURE_BYTES * 2, "repair evidence is bounded");
  assert.ok(!repairPrompt.includes("NEVER-PERSIST-TAIL"), "the discarded transcript tail never reaches the resumed session");
  assert.deepEqual(rows.map((row) => row.step), ["retro.preflight_failed", "retro.preflight_passed"]);
  assert.equal(rows[0].extra.remote_pr_existed, true);
  assert.deepEqual(rows[0].extra.failing_tests, ["Standing rule citations agree"]);
  assert.ok(!JSON.stringify(rows).includes("NEVER-PERSIST-TAIL"), "the ledger projection never persists full output");
});

test("a second failure is terminal and emits two compact attempt rows", async () => {
  const testResults = [
    commandResult(1, "not ok 1 - first deterministic failure\n"),
    commandResult(1, "not ok 2 - second deterministic failure\n"),
  ];
  let repairs = 0;
  let regenerations = 0;
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const run: RetroPrepublishRunner = (_command, args) => {
    if (args.includes("--list-plan-reading-suites")) return commandResult(0, "test/plan.test.ts\n");
    return testResults.shift()!;
  };

  const result = await runRetroPrepublishPreflight({
    worktreePath: "/tmp/retro-worktree",
    provenance,
    remotePrExisted: false,
    repair: async () => { repairs += 1; },
    regenerateHarnessArtifacts: async () => { regenerations += 1; },
    log: (step, extra) => rows.push({ step, extra }),
    deps: { run },
  });

  assert.deepEqual(result, { ok: false, attempts: 2, suiteCount: 1, repaired: true });
  assert.equal(repairs, 1, "exactly one same-session repair is allowed");
  assert.equal(regenerations, 1);
  assert.deepEqual(rows.map((row) => row.step), ["retro.preflight_failed", "retro.preflight_failed"]);
  assert.deepEqual(rows.map((row) => row.extra.attempt), [1, 2]);
  assert.deepEqual(rows.map((row) => row.extra.outcome), ["failed", "failed"]);
  assert.deepEqual(rows[1].extra.failing_tests, ["second deterministic failure"]);
});

test("suite enumeration failure fails closed without inventing an empty passing set", async () => {
  let repairs = 0;
  let testWrapperRan = false;
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const run: RetroPrepublishRunner = (_command, args) => {
    if (args.includes("--list-plan-reading-suites")) return commandResult(1, "", "cannot read test tree");
    testWrapperRan = true;
    return commandResult(0);
  };

  const result = await runRetroPrepublishPreflight({
    worktreePath: "/tmp/retro-worktree",
    provenance,
    remotePrExisted: false,
    repair: async () => { repairs += 1; },
    regenerateHarnessArtifacts: async () => {},
    log: (step, extra) => rows.push({ step, extra }),
    deps: { run },
  });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2, "enumeration gets the same single bounded repair chance");
  assert.equal(repairs, 1);
  assert.equal(testWrapperRan, false);
  assert.deepEqual(rows.map((row) => row.extra.exit_class), ["suite_enumeration_failed", "suite_enumeration_failed"]);
  assert.deepEqual(rows.map((row) => row.extra.suite_count), [0, 0]);
});

test("an output ceiling breach is classified distinctly from a spawn failure", async () => {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const run: RetroPrepublishRunner = () => ({
    status: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("capture ceiling reached"), { code: "ENOBUFS" }),
  });

  const result = await runRetroPrepublishPreflight({
    worktreePath: "/tmp/retro-worktree",
    provenance,
    remotePrExisted: false,
    repair: async () => {},
    regenerateHarnessArtifacts: async () => {},
    log: (step, extra) => rows.push({ step, extra }),
    deps: { run },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(rows.map((row) => row.extra.exit_class), ["output_limit_exceeded", "output_limit_exceeded"]);
});

test("a failed repair is terminal and records a compact synthetic second attempt", async () => {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const run: RetroPrepublishRunner = (_command, args) => args.includes("--list-plan-reading-suites")
    ? commandResult(0, "test/plan.test.ts\n")
    : commandResult(1, "not ok 1 - repair me\n");

  const result = await runRetroPrepublishPreflight({
    worktreePath: "/tmp/retro-worktree",
    provenance,
    remotePrExisted: false,
    repair: async () => { throw new Error("repair worker unavailable"); },
    regenerateHarnessArtifacts: async () => assert.fail("regeneration must wait for a successful repair"),
    log: (step, extra) => rows.push({ step, extra }),
    deps: { run },
  });

  assert.deepEqual(result, { ok: false, attempts: 2, suiteCount: 1, repaired: false });
  assert.deepEqual(rows.map((row) => row.extra.exit_class), ["tests_failed", "repair_spawn_failed"]);
  assert.equal(rows[1].extra.stderr_excerpt, "repair worker unavailable");
});

test("a failed harness regeneration is terminal after a successful repair", async () => {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const run: RetroPrepublishRunner = (_command, args) => args.includes("--list-plan-reading-suites")
    ? commandResult(0, "test/plan.test.ts\n")
    : commandResult(1, "not ok 1 - regenerate me\n");

  const result = await runRetroPrepublishPreflight({
    worktreePath: "/tmp/retro-worktree",
    provenance,
    remotePrExisted: false,
    repair: async () => {},
    regenerateHarnessArtifacts: async () => { throw "generator unavailable"; },
    log: (step, extra) => rows.push({ step, extra }),
    deps: { run },
  });

  assert.deepEqual(result, { ok: false, attempts: 2, suiteCount: 1, repaired: true });
  assert.deepEqual(rows.map((row) => row.extra.exit_class), ["tests_failed", "harness_regeneration_failed"]);
  assert.equal(rows[1].extra.stderr_excerpt, "generator unavailable");
});
