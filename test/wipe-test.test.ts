import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LearningEntry } from "../src/lib/learnings.js";
import type { Config } from "../src/lib/config.js";
import type { RunResult } from "../src/lib/run-result.js";
import { readLedgerLines } from "../src/lib/status.js";
import { main, wipeTestCommand } from "../src/run-task.js";
import {
  aggregateWipeTestPairs,
  computeMatchedLearningsForArm,
  computeWipeTestDelta,
  deriveWipeTestRunResult,
  ledgerWipeTestPair,
  resolveWipeTestTarget,
  WIPE_TEST_PAIR_STEP,
  WIPE_TEST_SANDBOX_DEFAULT,
  type LearningsInjectionDeps,
  type WipeTestPair,
  type WipeTestRunResult,
} from "../src/lib/wipe-test.js";

// W1-T86 — ratifies P12: injected learnings must be shown to help, or pruned. These
// tests are the harness's own acceptance proofs (plan/tasks.yaml's design).

function entry(id: string, fact: string): LearningEntry {
  return { id, subsystem: "testing", lifecycle: "active", files: ["src/lib/wipe-test.ts"], fact, src: "PR#1" };
}

function tmpLedgerDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-wipe-test-"));
}

// ── acceptance criterion 1: arm B masks injection, store untouched; arm A carries facts ──

test("computeMatchedLearningsForArm: arm B NEVER calls the load/select/render chain — the store is never touched — and renders zero learning blocks", () => {
  let loadCalls = 0;
  let selectCalls = 0;
  let renderCalls = 0;
  const spyDeps: LearningsInjectionDeps = {
    loadLayeredLearningsForTaskFiles: (...args) => {
      loadCalls++;
      return { entries: [entry("e1", "a fact")] };
    },
    selectLearnings: (...args) => {
      selectCalls++;
      return { selected: [], dropped: [] };
    },
    renderMatchedLearnings: (...args) => {
      renderCalls++;
      return "SHOULD NOT APPEAR";
    },
  };

  const result = computeMatchedLearningsForArm(
    "B",
    { homes: { projectDir: "/nonexistent" }, taskFiles: ["src/lib/wipe-test.ts"] },
    spyDeps,
  );

  assert.equal(loadCalls, 0, "arm B must never call the store loader — masking, not deletion");
  assert.equal(selectCalls, 0, "arm B must never call the selector");
  assert.equal(renderCalls, 0, "arm B must never call the renderer");
  assert.equal(result.matchedLearnings, "", "arm B's rendered prompt text must contain zero learning blocks");
  assert.deepEqual(result.selectedIds, []);
  assert.deepEqual(result.droppedIds, []);
});

test("computeMatchedLearningsForArm: arm A carries the matched learnings via the real chain", () => {
  const facts = [entry("e1", "fact one"), entry("e2", "fact two")];
  let loadCalls = 0;
  const spyDeps: LearningsInjectionDeps = {
    loadLayeredLearningsForTaskFiles: () => {
      loadCalls++;
      return { entries: facts };
    },
    selectLearnings: (entries) => ({ selected: entries, dropped: [] }),
    renderMatchedLearnings: (selected) => selected.map((e) => `- ${e.fact}`).join("\n"),
  };

  const result = computeMatchedLearningsForArm(
    "A",
    { homes: { projectDir: "/nonexistent" }, taskFiles: ["src/lib/wipe-test.ts"] },
    spyDeps,
  );

  assert.equal(loadCalls, 1, "arm A must read the store exactly once");
  assert.match(result.matchedLearnings, /fact one/);
  assert.match(result.matchedLearnings, /fact two/);
  assert.deepEqual(result.selectedIds, ["e1", "e2"]);
});

// ── acceptance criterion 2: paired deltas are computed and ledgered ──

function runResult(over: Partial<WipeTestRunResult>): WipeTestRunResult {
  return {
    taskId: "W1-T999",
    runId: "R1",
    verdict: "merged",
    numTurns: 10,
    costUsd: 1,
    strikes: 0,
    proofExec: [],
    ...over,
  };
}

test("computeWipeTestDelta: computes turn/cost/verdict/strike deltas for one fixture pair (B minus A)", () => {
  const pair: WipeTestPair = {
    taskId: "W1-T999",
    armA: runResult({ runId: "A1", numTurns: 10, costUsd: 2, strikes: 0, verdict: "merged", proofExec: ["executed_pass", "executed_pass"] }),
    armB: runResult({ runId: "B1", numTurns: 18, costUsd: 3.5, strikes: 1, verdict: "blocked_review", proofExec: ["executed_fail", "executed_pass"] }),
  };
  const delta = computeWipeTestDelta(pair);
  assert.equal(delta.taskId, "W1-T999");
  assert.equal(delta.turnsDelta, 8, "masked run took 8 more turns than the injected baseline");
  assert.equal(delta.costDelta, 1.5);
  assert.equal(delta.strikesDelta, 1);
  assert.equal(delta.verdictA, "merged");
  assert.equal(delta.verdictB, "blocked_review");
  assert.equal(delta.verdictChanged, true, "masking flipped the verdict — direct evidence the learnings mattered");
  assert.equal(delta.proofExecPassA, 2);
  assert.equal(delta.proofExecPassB, 1);
});

test("computeWipeTestDelta: an unchanged verdict across arms reports verdictChanged=false", () => {
  const pair: WipeTestPair = {
    taskId: "W1-T999",
    armA: runResult({ verdict: "merged" }),
    armB: runResult({ verdict: "merged" }),
  };
  assert.equal(computeWipeTestDelta(pair).verdictChanged, false);
});

test("ledgerWipeTestPair: writes exactly one wipetest.pair ledger line carrying the turn/cost/verdict deltas", () => {
  const dir = tmpLedgerDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const pair: WipeTestPair = {
      taskId: "W1-T999",
      armA: runResult({ runId: "A1", numTurns: 10, costUsd: 2, verdict: "merged" }),
      armB: runResult({ runId: "B1", numTurns: 20, costUsd: 4, verdict: "merged" }),
    };
    const delta = ledgerWipeTestPair(ledgerPath, "WIPETEST-1", pair);
    assert.equal(delta.turnsDelta, 10);

    const lines = readLedgerLines(ledgerPath);
    const pairLines = lines.filter((l) => l.step === WIPE_TEST_PAIR_STEP);
    assert.equal(pairLines.length, 1, "exactly one wipetest.pair line for one pair");
    const line = pairLines[0];
    assert.equal(line.task_id, "W1-T999");
    assert.equal(line.turns_delta, 10);
    assert.equal(line.cost_delta, 2);
    assert.equal(line.verdict_a, "merged");
    assert.equal(line.verdict_b, "merged");
    assert.equal(line.verdict_changed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregateWipeTestPairs: aggregates two seeded pairs correctly (avg deltas + verdict-changed count/rate)", () => {
  const pairs: WipeTestPair[] = [
    {
      taskId: "W1-T1",
      armA: runResult({ runId: "A1", numTurns: 10, costUsd: 2, strikes: 0, verdict: "merged" }),
      armB: runResult({ runId: "B1", numTurns: 20, costUsd: 4, strikes: 1, verdict: "merged" }),
    },
    {
      taskId: "W1-T2",
      armA: runResult({ runId: "A2", numTurns: 12, costUsd: 3, strikes: 0, verdict: "merged" }),
      armB: runResult({ runId: "B2", numTurns: 12, costUsd: 3, strikes: 0, verdict: "blocked_review" }),
    },
  ];
  const agg = aggregateWipeTestPairs(pairs);
  assert.equal(agg.pairs, 2);
  // pair 1: turnsDelta=10, costDelta=2, strikesDelta=1; pair 2: turnsDelta=0, costDelta=0, strikesDelta=0
  assert.equal(agg.avgTurnsDelta, 5);
  assert.equal(agg.avgCostDelta, 1);
  assert.equal(agg.avgStrikesDelta, 0.5);
  assert.equal(agg.verdictChangedCount, 1, "only pair 2 flipped verdict");
  assert.equal(agg.verdictChangedRate, 0.5);
});

test("aggregateWipeTestPairs: zero pairs is a well-defined empty aggregate, never NaN", () => {
  const agg = aggregateWipeTestPairs([]);
  assert.equal(agg.pairs, 0);
  assert.equal(agg.avgTurnsDelta, 0);
  assert.equal(agg.avgCostDelta, 0);
  assert.equal(agg.avgStrikesDelta, 0);
  assert.equal(agg.verdictChangedCount, 0);
  assert.equal(agg.verdictChangedRate, 0);
});

// ── acceptance criterion 3: the harness refuses non-sandbox targets by default ──

test("resolveWipeTestTarget: no --repo defaults to the sandbox, no refusal", () => {
  const resolved = resolveWipeTestTarget([]);
  assert.ok("target" in resolved);
  assert.equal((resolved as { target: { repo: string } }).target.repo, WIPE_TEST_SANDBOX_DEFAULT);
});

test("resolveWipeTestTarget: target=remudero (primary repo) without --allow-non-sandbox is REFUSED, naming the sandbox default", () => {
  const resolved = resolveWipeTestTarget(["--repo", "remudero"]);
  assert.ok("error" in resolved, "a non-sandbox target must be refused by default");
  const err = (resolved as { error: string }).error;
  assert.match(err, /remudero-sandbox/, "the refusal must name the sandbox default so the operator knows the fix");
  assert.match(err, /remudero/);
});

test("resolveWipeTestTarget: --repo remudero --allow-non-sandbox is honored (explicit override)", () => {
  const resolved = resolveWipeTestTarget(["--repo", "remudero", "--allow-non-sandbox"]);
  assert.ok("target" in resolved);
  assert.equal((resolved as { target: { repo: string } }).target.repo, "remudero");
});

test("resolveWipeTestTarget: an explicit --repo naming the sandbox itself is never refused", () => {
  const resolved = resolveWipeTestTarget(["--repo", WIPE_TEST_SANDBOX_DEFAULT]);
  assert.ok("target" in resolved);
});

// ── deriveWipeTestRunResult: turn a real RunResult + the ledger into the richer shape
// computeWipeTestDelta needs — best-effort glue the CLI path uses (module doc above). ──

function realRunResult(over: Partial<RunResult>): RunResult {
  return {
    taskId: "W1-T86",
    runId: "R-DERIVE",
    merged: true,
    costUsd: 1.25,
    verdict: "merged",
    ...over,
  };
}

test("deriveWipeTestRunResult: sums num_turns over THIS run's own DONE_STEPS ledger lines, ignoring other run_ids", () => {
  const result = realRunResult({ runId: "R-DERIVE" });
  const ledgerLines = [
    { run_id: "R-DERIVE", step: "recon.done", num_turns: 3 },
    { run_id: "R-DERIVE", step: "implement.done", num_turns: 5 },
    { run_id: "R-DERIVE", step: "implement.resumed", num_turns: 2 },
    { run_id: "OTHER-RUN", step: "implement.done", num_turns: 99 }, // must NOT be summed in
    { run_id: "R-DERIVE", step: "some.other.step", num_turns: 1000 }, // not a DONE step — ignored
    { run_id: "R-DERIVE", step: "implement.done", num_turns: "not-a-number" }, // non-numeric — treated as 0
  ];
  const derived = deriveWipeTestRunResult(result, ledgerLines);
  assert.equal(derived.taskId, "W1-T86");
  assert.equal(derived.runId, "R-DERIVE");
  assert.equal(derived.verdict, "merged");
  assert.equal(derived.costUsd, 1.25);
  assert.equal(derived.numTurns, 10, "3 + 5 + 2, other run_ids/non-DONE-steps/non-numeric turns excluded");
});

test("deriveWipeTestRunResult: counts fix.dispatch strikes task-scoped (by task_id, not run_id)", () => {
  const result = realRunResult({ taskId: "W1-T86", runId: "R-DERIVE" });
  const ledgerLines = [
    { task_id: "W1-T86", step: "fix.dispatch", strike: 1 },
    { task_id: "W1-T86", step: "fix.dispatch", strike: 2 },
    { task_id: "W1-T86", step: "fix.dispatch", strike: "not-a-number" }, // not counted — strike must be a number
    { task_id: "OTHER-TASK", step: "fix.dispatch", strike: 3 }, // different task — excluded
    { task_id: "W1-T86", step: "recon.done" }, // wrong step — excluded
  ];
  const derived = deriveWipeTestRunResult(result, ledgerLines);
  assert.equal(derived.strikes, 2);
});

test("deriveWipeTestRunResult: proofExec takes the LAST review.posted line for this task (current posted verdict wins)", () => {
  const result = realRunResult({ taskId: "W1-T86" });
  const ledgerLines = [
    { task_id: "W1-T86", step: "review.posted", proof_exec: ["executed_fail"] },
    { task_id: "OTHER-TASK", step: "review.posted", proof_exec: ["executed_pass", "executed_pass"] },
    { task_id: "W1-T86", step: "review.posted", proof_exec: ["executed_pass", "not_executable"] },
  ];
  const derived = deriveWipeTestRunResult(result, ledgerLines);
  assert.deepEqual(derived.proofExec, ["executed_pass", "not_executable"], "the LAST matching line wins, not the first");
});

test("deriveWipeTestRunResult: zero matching ledger lines yields zero turns, zero strikes, empty proofExec", () => {
  const result = realRunResult({ taskId: "W1-T999", runId: "R-NONE" });
  const derived = deriveWipeTestRunResult(result, []);
  assert.equal(derived.numTurns, 0);
  assert.equal(derived.strikes, 0);
  assert.deepEqual(derived.proofExec, []);
});

// ── wipeTestCommand: the CLI glue (arg validation, sandbox refusal, non-self clone/fetch,
// two dispatches via the injectable runTaskFn, then derive+ledger the pair). Real config root
// under a tmp dir; runTaskFn/execFileSyncFn are injected so no worker actually spawns and no
// subprocess actually runs (mirrors drainCommand's config/githubFactory injection seam). ──

function wipeTestFixtureConfig(): Config {
  return { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-wipe-test-cmd-root-")) };
}

function fakeRunTaskFn(byArm: { A: RunResult; B: RunResult }): typeof import("../src/run-task.js").runTask {
  let calls = 0;
  return (async (_taskId: string, opts: { maskLearnings?: boolean } = {}) => {
    calls++;
    return opts.maskLearnings ? byArm.B : byArm.A;
  }) as unknown as typeof import("../src/run-task.js").runTask;
}

test("wipeTestCommand: no task-id argument fails loud (exit 2), no config/dispatch touched", async () => {
  const code = await wipeTestCommand([]);
  assert.equal(code, 2);
});

test("wipeTestCommand: an unrecognized flag fails loud (exit 2)", async () => {
  const code = await wipeTestCommand(["W1-T86", "--bogus-flag"]);
  assert.equal(code, 2);
});

test("wipeTestCommand: a non-sandbox --repo without --allow-non-sandbox is refused (exit 2), never dispatches", async () => {
  let dispatched = 0;
  const code = await wipeTestCommand(["W1-T86", "--repo", "remudero"], {
    config: wipeTestFixtureConfig(),
    runTaskFn: (async () => {
      dispatched++;
      return realRunResult({});
    }) as unknown as typeof import("../src/run-task.js").runTask,
  });
  assert.equal(code, 2);
  assert.equal(dispatched, 0, "a refused target must never reach either arm's dispatch");
});

test("wipeTestCommand: self-target (--repo remudero) runs BOTH arms via runTaskFn and ledgers one wipetest.pair line", async () => {
  const config = wipeTestFixtureConfig();
  const armA = realRunResult({ taskId: "W1-T86", runId: "RUN-A", costUsd: 2, verdict: "merged" });
  const armB = realRunResult({ taskId: "W1-T86", runId: "RUN-B", costUsd: 3, verdict: "merged" });
  const seenMask: Array<boolean | undefined> = [];
  const runTaskFn = (async (_taskId: string, opts: { maskLearnings?: boolean } = {}) => {
    seenMask.push(opts.maskLearnings);
    return opts.maskLearnings ? armB : armA;
  }) as unknown as typeof import("../src/run-task.js").runTask;

  const code = await wipeTestCommand(["W1-T86", "--repo", "remudero", "--allow-non-sandbox"], {
    config,
    runTaskFn,
  });

  assert.equal(code, 0);
  assert.deepEqual(seenMask, [undefined, true], "arm A dispatches unmasked, arm B dispatches with maskLearnings:true");

  const ledgerLines = readLedgerLines(join(config.root, "state", "ledger.ndjson"));
  const pairLines = ledgerLines.filter((l) => l.step === WIPE_TEST_PAIR_STEP && l.task_id === "W1-T86");
  assert.equal(pairLines.length, 1, "exactly one wipetest.pair line ledgered for one invocation");
  assert.equal(pairLines[0].verdict_a, "merged");
  assert.equal(pairLines[0].verdict_b, "merged");
});

test("wipeTestCommand: a non-self target CLONES via execFileSyncFn when the repo dir does not yet exist", async () => {
  const config = wipeTestFixtureConfig();
  const calls: Array<{ bin: string; args: string[] }> = [];
  const execFileSyncFn = ((bin: string, args: string[]) => {
    calls.push({ bin, args });
    return Buffer.from("");
  }) as unknown as typeof import("node:child_process").execFileSync;
  const runTaskFn = fakeRunTaskFn({ A: realRunResult({ runId: "RA" }), B: realRunResult({ runId: "RB" }) });

  const code = await wipeTestCommand(["W1-T86", "--repo", "wipe-test-fixture-repo", "--allow-non-sandbox"], {
    config,
    runTaskFn,
    execFileSyncFn,
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1, "a missing repo dir clones exactly once, never fetch+reset");
  assert.equal(calls[0].bin, "gh");
  assert.deepEqual(calls[0].args.slice(0, 2), ["repo", "clone"]);
  assert.ok(!existsSync(join(config.root, "repos", "wipe-test-fixture-repo")), "the injected fake never actually clones anything to disk");
});

test("wipeTestCommand: a non-self target FETCH+RESETs via execFileSyncFn when the repo dir already exists", async () => {
  const config = wipeTestFixtureConfig();
  const repoDir = join(config.root, "repos", "wipe-test-fixture-repo-2");
  mkdirSync(repoDir, { recursive: true });
  const calls: Array<{ bin: string; args: string[] }> = [];
  const execFileSyncFn = ((bin: string, args: string[]) => {
    calls.push({ bin, args });
    return Buffer.from("");
  }) as unknown as typeof import("node:child_process").execFileSync;
  const runTaskFn = fakeRunTaskFn({ A: realRunResult({ runId: "RA2" }), B: realRunResult({ runId: "RB2" }) });

  const code = await wipeTestCommand(["W1-T86", "--repo", "wipe-test-fixture-repo-2", "--allow-non-sandbox"], {
    config,
    runTaskFn,
    execFileSyncFn,
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 2, "an existing repo dir fetches THEN resets, never clones");
  assert.equal(calls[0].bin, "git");
  assert.deepEqual(calls[0].args.slice(2, 4), ["fetch", "--quiet"]);
  assert.equal(calls[1].bin, "git");
  assert.deepEqual(calls[1].args.slice(2, 4), ["reset", "--hard"]);
});

test("wipeTestCommand: with `deps` omitted entirely, falls through to the REAL loadConfig() AND the REAL runTask default -- an unknown task id throws (selectTask) before any lock/spawn, never a network round-trip", async () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-wipe-test-realhome-"));
  const root = join(home, "remudero-root");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }), "utf8");
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await assert.rejects(
      () => wipeTestCommand(["W1-T-DOES-NOT-EXIST-99999", "--repo", "remudero", "--allow-non-sandbox"]),
      /no task with id/,
      "the REAL runTask (no injected runTaskFn) reads the REAL plan and refuses an unknown task id synchronously",
    );
  } finally {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── main()'s CLI dispatch: `cmd === "wipe-test"` must actually route to wipeTestCommand
// (not just exist as a registry entry — help-registry.test.ts already proves the latter).
// Driven through a REFUSED (non-sandbox, no --allow-non-sandbox) invocation so this reaches
// wipeTestCommand's real refusal path and returns BEFORE any config/ledger/dispatch I/O —
// same "fails loud before touching anything" shape every other dispatch test in this suite
// relies on. process.exit is mocked (never actually exits the test process); process.argv is
// restored in `finally` regardless of outcome.

// process.exit is mocked to THROW (never merely record-and-return) -- a no-op mock would let
// main()'s flat if-ladder fall through and evaluate EVERY remaining `cmd === "<sibling>"` check
// after ours, which (empirically verified) decomposes ~30 unrelated, pre-existing sibling
// dispatch branches into the branch-coverage report -- none ever true in this test, which tanks
// the aggregate coverage-ratchet for commands this task never touched. A throwing mock halts
// main() at the FIRST process.exit call, exactly like the real process would, so only the
// dispatch checks main() actually walks THROUGH before reaching wipe-test's own are evaluated.
class ProcessExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** Run `main()` against a fake argv with process.exit/console mocked (never a real exit,
 *  never real output), asserting the FIRST exit code main() reaches. Shared by the three
 *  tests below so each pays the SAME one-time main()-invocation cost and none walk any
 *  FURTHER into the ladder than main() itself already requires for that argv. */
async function callMain(t: import("node:test").TestContext, argv: string[]): Promise<number | undefined> {
  const exitMock = ((code?: number): never => {
    throw new ProcessExitCalled(code);
  }) as typeof process.exit;
  t.mock.method(process, "exit", exitMock);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});

  const originalArgv = process.argv;
  process.argv = argv;
  try {
    let caught: unknown;
    await main().catch((e) => {
      caught = e;
    });
    assert.ok(caught instanceof ProcessExitCalled, "main() must reach process.exit, not some other throw (or none at all)");
    return (caught as ProcessExitCalled).code;
  } finally {
    process.argv = originalArgv;
  }
}

test("main(): `rmd wipe-test <id> --repo remudero` (no --allow-non-sandbox) dispatches to wipeTestCommand and exits 2", async (t) => {
  const code = await callMain(t, ["node", "run-task.js", "wipe-test", "W1-T86", "--repo", "remudero"]);
  assert.equal(code, 2, "the wipe-test dispatch branch is reached and propagates wipeTestCommand's refusal exit code");
});

// These two cover the OTHER side of the mandatory help preamble's own branches (every main()
// call evaluates it, so it is ALREADY "paid for" the moment any test calls main() -- these
// exit even EARLIER than the wipe-test dispatch itself, so they add no new decomposed branch
// anywhere, only fill in the true-side coverage the test above's argv never took).

test("main(): `rmd --help` prints USAGE and exits 0 -- the mandatory top-of-ladder help check", async (t) => {
  const code = await callMain(t, ["node", "run-task.js", "--help"]);
  assert.equal(code, 0);
});

test("main(): `rmd wipe-test --help` prints the per-command help and exits 0 BEFORE the wipe-test dispatch itself", async (t) => {
  const code = await callMain(t, ["node", "run-task.js", "wipe-test", "--help"]);
  assert.equal(code, 0);
});
