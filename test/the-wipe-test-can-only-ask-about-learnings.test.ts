import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureConsoleError } from "./helpers/captured-console.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { loadReconArtifact, main, runTask, wipeTestCommand, writeReconArtifact } from "../src/run-task.js";
import type { RunResult } from "../src/lib/run-result.js";
import {
  aggregateWipeTestPairs,
  computeWipeTestDelta,
  isWipeTestNullPair,
  ledgerWipeTestPair,
  resolveWipeTestFactor,
  wipeTestFactorMasksLearnings,
  wipeTestFactorMasksRecon,
  wipeTestPairFactor,
  WIPE_TEST_PAIR_STEP,
  type WipeTestFactor,
  type WipeTestPair,
  type WipeTestRunResult,
} from "../src/lib/wipe-test.js";

// W1-T2512 — "THE WIPE TEST CAN ONLY EVER ASK ABOUT LEARNINGS": the harness generalises from
// one hard-coded factor (learnings) to a NAMED factor (`WipeTestFactor`, "learnings" | "recon"),
// so it can also ask about the single most expensive per-dispatch cost it could not previously
// reach — the recon worker spawn. These are this task's own acceptance proofs.

// ── shared fixtures ──────────────────────────────────────────────────────────────────────────

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

function noWorkResult(runId: string): WipeTestRunResult {
  return runResult({ runId, numTurns: 0, costUsd: 0, verdict: "task_already_merged" });
}

function wipeTestFixtureConfig(): Config {
  return { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-wipe-test-factor-root-")) };
}

// ═══ criterion 1: a wipe-test pair names WHICH factor it varied, and a learnings pair still
// says learnings ═════════════════════════════════════════════════════════════════════════════

test("wipeTestPairFactor: a pair with no factor field reads as \"learnings\" — the only factor that existed before W1-T2512", () => {
  const pair: WipeTestPair = { taskId: "W1-T1", armA: runResult({}), armB: runResult({}) };
  assert.equal(wipeTestPairFactor(pair), "learnings");
});

test("wipeTestPairFactor: an explicit factor is read verbatim", () => {
  const pair: WipeTestPair = { taskId: "W1-T1", factor: "recon", armA: runResult({}), armB: runResult({}) };
  assert.equal(wipeTestPairFactor(pair), "recon");
});

test("computeWipeTestDelta: carries the pair's factor through — missing defaults to learnings, explicit recon travels", () => {
  const legacyPair: WipeTestPair = { taskId: "W1-T1", armA: runResult({}), armB: runResult({}) };
  assert.equal(computeWipeTestDelta(legacyPair).factor, "learnings");

  const reconPair: WipeTestPair = { taskId: "W1-T1", factor: "recon", armA: runResult({}), armB: runResult({}) };
  assert.equal(computeWipeTestDelta(reconPair).factor, "recon");
});

test("ledgerWipeTestPair: writes the factor into the wipetest.pair ledger line, for both factors", () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-wipe-test-factor-ledger-")), "ledger.ndjson");
  const learningsPair: WipeTestPair = {
    taskId: "W1-T1",
    armA: runResult({ runId: "A1" }),
    armB: runResult({ runId: "B1" }),
  };
  const reconPair: WipeTestPair = {
    taskId: "W1-T2",
    factor: "recon",
    armA: runResult({ runId: "A2" }),
    armB: runResult({ runId: "B2" }),
  };
  ledgerWipeTestPair(ledgerPath, "RUN-1", learningsPair);
  ledgerWipeTestPair(ledgerPath, "RUN-2", reconPair);

  const lines = readLedgerLines(ledgerPath).filter((l) => l.step === WIPE_TEST_PAIR_STEP);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].task_id, "W1-T1");
  assert.equal(lines[0].factor, "learnings", "a pair with no explicit factor is ledgered as learnings, not omitted");
  assert.equal(lines[1].task_id, "W1-T2");
  assert.equal(lines[1].factor, "recon");
});

test("wipeTestFactorMasksLearnings / wipeTestFactorMasksRecon: EXACTLY one factor is masked on arm B, never both, never neither", () => {
  const factors: WipeTestFactor[] = ["learnings", "recon"];
  for (const factor of factors) {
    // Arm A never masks anything, for either factor.
    assert.equal(wipeTestFactorMasksLearnings(factor, "A"), false);
    assert.equal(wipeTestFactorMasksRecon(factor, "A"), false);
    // Arm B masks EXACTLY the pair's own factor.
    const masksLearnings = wipeTestFactorMasksLearnings(factor, "B");
    const masksRecon = wipeTestFactorMasksRecon(factor, "B");
    assert.notEqual(masksLearnings, masksRecon, `factor ${factor}: exactly one of the two must mask on arm B`);
    assert.equal(masksLearnings, factor === "learnings");
    assert.equal(masksRecon, factor === "recon");
  }
});

// ═══ criteria 2 + 3: a recon-factor arm B reaches implement with no recon context, says so
// explicitly, and never reads or writes the recon artifact store ═══════════════════════════════

function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

const FIXTURE_PLAN = [
  "- id: T-WIPE-RECON",
  "  title: wipe-test recon-factor wiring probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

function gitFixture(root: string): { repoDir: string } {
  const originGit = mkdtempSync(join(tmpdir(), "runtask-wipe-recon-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "runtask-wipe-recon-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "wipe-recon-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "wipe-recon-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "wipe-recon-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "wipe-recon-test"]);
  return { repoDir };
}

function fakeGh(branch: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "runtask-wipe-recon-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${branch}"}'; exit 0; fi`,
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"FAILURE\"}]}'; exit 0; fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      "if [[ \"$1\" == 'api' ]]; then",
      "  case \"$2\" in",
      "    */check-runs*) echo '{\"check_runs\":[{\"name\":\"ci\",\"status\":\"completed\",\"conclusion\":\"failure\"}]}'; exit 0 ;;",
      "    */status) echo '{\"state\":\"failure\",\"statuses\":[]}'; exit 0 ;;",
      `    */pulls/*) echo '{"number":1,"state":"open","merged":false,"head":{"sha":"deadbee","ref":"${branch}"}}'; exit 0 ;;`,
      "  esac",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

/** Runs a fixture `runTask` dispatch (mirrors test/recon-degrade.test.ts's own harness), with
 *  `opts` merged in — the wipe-test seam under test (`maskRecon`) rides through `opts` exactly
 *  the way `wipeTestCommand` itself would pass it. */
async function runFixture(
  t: import("node:test").TestContext,
  spawn: typeof spawnWorker,
  opts: Record<string, unknown> = {},
): Promise<{ res: Awaited<ReturnType<typeof runTask>>; ledger: Array<Record<string, unknown>>; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "runtask-wipe-recon-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };

  gitFixture(root);

  const FIXED_TS = 1785200000000;
  const branch = `run-T-WIPE-RECON-${FIXED_TS}`;
  const fakeBinDir = fakeGh(branch);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const { withLiveWritesAllowed } = await import("../src/lib/live-write-guard.js");
  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-WIPE-RECON", {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
        ...opts,
      }),
    );
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return { res, ledger, root };
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
}

test("BEHAVIORAL: maskRecon:true (recon factor, arm B) never spawns recon at all — implement is the ONLY spawn", async (t) => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    return workerResult({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  const { res, ledger } = await runFixture(t, spawn, { maskRecon: true });

  assert.equal(res.verdict, "blocked_ci", "the run reaches implement and a real terminal verdict");
  assert.equal(spawnCalls.length, 1, "recon is never spawned — only the implement worker is");
  assert.equal(ledger.filter((l) => l.step === "recon.done").length, 0, "no recon spawn was ever ledgered");
  assert.equal(ledger.filter((l) => l.step === "recon.degraded").length, 0, "masked is not degraded — different cause");
  assert.equal(ledger.filter((l) => l.step === "recon.masked").length, 1, "the masked skip is ledgered explicitly, once");

  const implementPrompt = String(spawnCalls[0].prompt);
  assert.match(implementPrompt, /RECON CONTEXT MASKED/, "implement is told, explicitly, that recon context is masked");
  assert.match(implementPrompt, /W1-T2512/, "the note cites the wipe-test mechanism that caused the mask");
  assert.doesNotMatch(implementPrompt, /RECON CONTEXT ABSENT/, "masked is worded distinctly from degraded — no error ever happened");
});

test("BEHAVIORAL: maskRecon:true never reads or writes the recon artifact store — a pre-seeded artifact survives byte-unchanged, and its content never reaches the prompt", async (t) => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    return workerResult({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  const root = mkdtempSync(join(tmpdir(), "runtask-wipe-recon-artifact-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);

  // Seed a prior artifact — whatever its content, a maskRecon:true run must neither read it
  // (else its OBSERVED text — or a "REUSED RECON ARTIFACT" claim — would reach the prompt) nor
  // overwrite it (masked, not deleted, same discipline as computeMatchedLearningsForArm's
  // learnings store).
  writeReconArtifact(config.root, {
    task_id: "T-WIPE-RECON",
    plan_sha: "sentinel-plan-sha",
    files_digest: "sentinel-files-digest",
    observed: "THIS TEXT MUST NEVER REACH A MASKED PROMPT",
    inferred: "",
    couldnt_verify: "",
    written_at: "2026-01-01T00:00:00.000Z",
    run_id: "PRIOR-RUN",
  });
  const before = readFileSync(join(config.root, "state", "recon-artifacts", "T-WIPE-RECON.json"), "utf8");

  const FIXED_TS = 1785300000000;
  const branch = `run-T-WIPE-RECON-${FIXED_TS}`;
  const fakeBinDir = fakeGh(branch);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);
  const { withLiveWritesAllowed } = await import("../src/lib/live-write-guard.js");
  try {
    await withLiveWritesAllowed(() =>
      runTask("T-WIPE-RECON", {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
        maskRecon: true,
      }),
    );
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
  }

  const after = readFileSync(join(config.root, "state", "recon-artifacts", "T-WIPE-RECON.json"), "utf8");
  assert.equal(after, before, "the artifact file is byte-identical after a masked run -- never overwritten");
  assert.equal(
    loadReconArtifact(config.root, "T-WIPE-RECON")?.observed,
    "THIS TEXT MUST NEVER REACH A MASKED PROMPT",
    "sanity: the artifact really is still there, untouched, for a later NON-wipe-test dispatch to reuse",
  );

  assert.equal(spawnCalls.length, 1, "recon still never spawns, artifact present or not");
  const implementPrompt = String(spawnCalls[0].prompt);
  assert.doesNotMatch(implementPrompt, /THIS TEXT MUST NEVER REACH A MASKED PROMPT/, "the seeded artifact's content never reached the prompt -- it was never read");
  assert.doesNotMatch(implementPrompt, /REUSED RECON ARTIFACT/, "a masked run never takes the reused-artifact branch -- that would mean it read the store");
  assert.match(implementPrompt, /RECON CONTEXT MASKED/, "the masked note renders instead");

  rmSync(root, { recursive: true, force: true });
});

// ═══ criterion 4: the learnings factor's arm A and arm B behave byte-identically to today ═════

function fakeRunTaskFnCapturingOpts(
  calls: Array<{ maskLearnings?: boolean; maskRecon?: boolean }>,
): typeof import("../src/run-task.js").runTask {
  return (async (_taskId: string, opts: { maskLearnings?: boolean; maskRecon?: boolean } = {}) => {
    calls.push({ maskLearnings: opts.maskLearnings, maskRecon: opts.maskRecon });
    return {
      taskId: "W1-T86",
      runId: opts.maskLearnings ? "R-B" : "R-A",
      merged: true,
      costUsd: 1,
      verdict: "merged",
    } as RunResult;
  }) as unknown as typeof import("../src/run-task.js").runTask;
}

test("wipeTestCommand: omitting --factor (default \"learnings\") dispatches BYTE-IDENTICALLY to before W1-T2512 -- maskLearnings on arm B only, maskRecon never set", async () => {
  const config = wipeTestFixtureConfig();
  const calls: Array<{ maskLearnings?: boolean; maskRecon?: boolean }> = [];
  const runTaskFn = fakeRunTaskFnCapturingOpts(calls);

  const code = await wipeTestCommand(["W1-T86", "--repo", "remudero", "--allow-non-sandbox"], {
    config,
    runTaskFn,
    resolveMergedState: () => ({ merged: false }),
  });

  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((c) => c.maskLearnings),
    [undefined, true],
    "arm A dispatches with maskLearnings omitted, arm B with maskLearnings:true -- unchanged",
  );
  assert.deepEqual(
    calls.map((c) => c.maskRecon),
    [undefined, undefined],
    "maskRecon is never set for a learnings-factor pair, on either arm",
  );

  const pairLine = readLedgerLines(join(config.root, "state", "ledger.ndjson")).find(
    (l) => l.step === WIPE_TEST_PAIR_STEP && l.task_id === "W1-T86",
  );
  assert.ok(pairLine);
  assert.equal(pairLine!.factor, "learnings", "the ledgered pair still says learnings when --factor is omitted");
});

test("wipeTestCommand: --factor recon dispatches maskRecon on arm B only, and never touches maskLearnings", async () => {
  const config = wipeTestFixtureConfig();
  const calls: Array<{ maskLearnings?: boolean; maskRecon?: boolean }> = [];
  const runTaskFn = (async (_taskId: string, opts: { maskLearnings?: boolean; maskRecon?: boolean } = {}) => {
    calls.push({ maskLearnings: opts.maskLearnings, maskRecon: opts.maskRecon });
    return {
      taskId: "W1-T86",
      runId: opts.maskRecon ? "R-B" : "R-A",
      merged: true,
      costUsd: 1,
      verdict: "merged",
    } as RunResult;
  }) as unknown as typeof import("../src/run-task.js").runTask;

  const code = await wipeTestCommand(["W1-T86", "--factor", "recon", "--repo", "remudero", "--allow-non-sandbox"], {
    config,
    runTaskFn,
    resolveMergedState: () => ({ merged: false }),
  });

  assert.equal(code, 0);
  assert.deepEqual(
    calls.map((c) => c.maskRecon),
    [undefined, true],
    "arm A dispatches with maskRecon omitted, arm B with maskRecon:true",
  );
  assert.deepEqual(
    calls.map((c) => c.maskLearnings),
    [undefined, undefined],
    "maskLearnings is never set for a recon-factor pair, on either arm",
  );

  const pairLine = readLedgerLines(join(config.root, "state", "ledger.ndjson")).find(
    (l) => l.step === WIPE_TEST_PAIR_STEP && l.task_id === "W1-T86",
  );
  assert.ok(pairLine);
  assert.equal(pairLine!.factor, "recon");
});

test("resolveWipeTestFactor: omitted defaults to learnings; a known value is accepted; an unknown value is refused loud (never silently coerced)", () => {
  assert.deepEqual(resolveWipeTestFactor([]), { factor: "learnings" });
  assert.deepEqual(resolveWipeTestFactor(["--factor", "recon"]), { factor: "recon" });
  assert.deepEqual(resolveWipeTestFactor(["--factor", "learnings"]), { factor: "learnings" });

  const bad = resolveWipeTestFactor(["--factor", "bogus"]);
  assert.ok("error" in bad);
  assert.match((bad as { error: string }).error, /bogus/);
  assert.match((bad as { error: string }).error, /learnings/);
  assert.match((bad as { error: string }).error, /recon/);
});

test("wipeTestCommand: an unrecognized --factor value fails loud (exit 2), before either arm ever dispatches", async () => {
  const config = wipeTestFixtureConfig();
  let dispatched = 0;
  const runTaskFn = (async () => {
    dispatched++;
    return { taskId: "W1-T86", runId: "X", merged: false, costUsd: 0, verdict: "merged" } as RunResult;
  }) as unknown as typeof import("../src/run-task.js").runTask;

  const code = await wipeTestCommand(["W1-T86", "--factor", "bogus", "--repo", "remudero", "--allow-non-sandbox"], {
    config,
    runTaskFn,
    resolveMergedState: () => ({ merged: false }),
  });

  assert.equal(code, 2, "an unrecognized --factor is refused, never silently defaulted");
  assert.equal(dispatched, 0, "neither arm is ever dispatched on a bad --factor");
});

// ═══ criterion 5: the aggregate can be taken per factor, and never mixes two factors into one
// report ══════════════════════════════════════════════════════════════════════════════════════

test("aggregateWipeTestPairs: refuses to average a learnings pair together with a recon pair", () => {
  const pairs: WipeTestPair[] = [
    { taskId: "W1-T1", factor: "learnings", armA: runResult({ runId: "A1" }), armB: runResult({ runId: "B1", numTurns: 20 }) },
    { taskId: "W1-T2", factor: "recon", armA: runResult({ runId: "A2" }), armB: runResult({ runId: "B2", numTurns: 30 }) },
  ];
  assert.throws(() => aggregateWipeTestPairs(pairs), /more than one factor/);
});

test("aggregateWipeTestPairs: filtering to one factor first yields a real per-factor aggregate, and stamps which factor it is", () => {
  const pairs: WipeTestPair[] = [
    { taskId: "W1-T1", factor: "learnings", armA: runResult({ runId: "A1", numTurns: 10 }), armB: runResult({ runId: "B1", numTurns: 20 }) },
    { taskId: "W1-T2", factor: "recon", armA: runResult({ runId: "A2", numTurns: 10 }), armB: runResult({ runId: "B2", numTurns: 40 }) },
  ];
  const learningsOnly = aggregateWipeTestPairs(pairs.filter((p) => wipeTestPairFactor(p) === "learnings"));
  assert.equal(learningsOnly.factor, "learnings");
  assert.equal(learningsOnly.pairs, 1);
  assert.equal(learningsOnly.avgTurnsDelta, 10);

  const reconOnly = aggregateWipeTestPairs(pairs.filter((p) => wipeTestPairFactor(p) === "recon"));
  assert.equal(reconOnly.factor, "recon");
  assert.equal(reconOnly.pairs, 1);
  assert.equal(reconOnly.avgTurnsDelta, 30);
});

test("aggregateWipeTestPairs: zero pairs is still a well-defined empty aggregate, factor null, never NaN", () => {
  const agg = aggregateWipeTestPairs([]);
  assert.equal(agg.pairs, 0);
  assert.equal(agg.factor, null);
  assert.equal(agg.avgTurnsDelta, 0);
});

// ═══ criterion 6: a ledgered pair predating this change still aggregates as a learnings pair ══

test("a pair reconstructed WITHOUT a factor field (as any pre-W1-T2512 pair or ledger row would be) aggregates alongside explicit learnings pairs without throwing, and reads as learnings", () => {
  const legacyPair: WipeTestPair = {
    // No `factor` at all -- exactly the shape every wipetest.pair row predating this task has.
    taskId: "W1-T-OLD",
    armA: runResult({ runId: "A-OLD", numTurns: 10 }),
    armB: runResult({ runId: "B-OLD", numTurns: 15 }),
  };
  const explicitLearningsPair: WipeTestPair = {
    taskId: "W1-T-NEW",
    factor: "learnings",
    armA: runResult({ runId: "A-NEW", numTurns: 10 }),
    armB: runResult({ runId: "B-NEW", numTurns: 15 }),
  };

  const agg = aggregateWipeTestPairs([legacyPair, explicitLearningsPair]);
  assert.equal(agg.factor, "learnings", "the legacy pair's silence and the new pair's explicit label agree");
  assert.equal(agg.pairs, 2);

  // And a legacy pair mixed with an EXPLICIT recon pair still throws, exactly as two explicit
  // labels would -- the default does not create a silent escape hatch from the mixing refusal.
  const reconPair: WipeTestPair = { taskId: "W1-T-R", factor: "recon", armA: runResult({}), armB: runResult({}) };
  assert.throws(() => aggregateWipeTestPairs([legacyPair, reconPair]), /more than one factor/);
});

// ═══ criterion 7: both zero-work backstops still refuse a pair neither arm measured, for every
// factor ══════════════════════════════════════════════════════════════════════════════════════

test("isWipeTestNullPair: a recon-factor pair where neither arm did any work is still a null pair", () => {
  const nullPair: WipeTestPair = {
    taskId: "W1-T1",
    factor: "recon",
    armA: noWorkResult("A1"),
    armB: noWorkResult("B1"),
  };
  assert.equal(isWipeTestNullPair(nullPair), true);
});

test("ledgerWipeTestPair: a null recon-factor pair writes NO wipetest.pair line, ledger left byte-unchanged", () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-wipe-test-factor-null-")), "ledger.ndjson");
  const nullPair: WipeTestPair = { taskId: "W1-T1", factor: "recon", armA: noWorkResult("A1"), armB: noWorkResult("B1") };

  const delta = ledgerWipeTestPair(ledgerPath, "RUN-NULL", nullPair);
  assert.equal(delta.factor, "recon", "the pure delta is still computed and still names its factor");
  assert.equal(
    readLedgerLines(ledgerPath).filter((l) => l.step === WIPE_TEST_PAIR_STEP).length,
    0,
    "no wipetest.pair line for a pair neither arm measured, whatever its factor",
  );
});

test("wipeTestCommand: the merged pre-flight refuses a recon-factor pair exactly as it refuses a learnings-factor pair -- NEITHER arm dispatches", async () => {
  const config = wipeTestFixtureConfig();
  let dispatched = 0;
  const mergedPrUrl = "https://github.com/acme/remudero-sandbox/pull/9";
  const runTaskFn = (async () => {
    dispatched++;
    return { taskId: "W1-T86", runId: "X", merged: false, costUsd: 0, verdict: "merged" } as RunResult;
  }) as unknown as typeof import("../src/run-task.js").runTask;

  // The default target is the SANDBOX, not self, so `wipeTestCommand` reaches its clone-if-absent
  // branch before the merged pre-flight — see that branch's own doc for why the pre-flight has to
  // read a just-synced plan. Fake the shell out the SAME way the learnings-factor counterpart in
  // test/wipe-test.test.ts does ("so this test never shells out to a real `gh`/`git`"): without it
  // this test dies on `spawnSync gh ENOENT` on any host with no gh on PATH, which is what CI saw.
  const execFileSyncFn = (() => Buffer.from("")) as unknown as typeof import("node:child_process").execFileSync;
  const code = await wipeTestCommand(["W1-T86", "--factor", "recon"], {
    config,
    runTaskFn,
    execFileSyncFn,
    resolveMergedState: () => ({ merged: true, prUrl: mergedPrUrl }),
  });

  assert.equal(code, 2);
  assert.equal(dispatched, 0, "neither arm A nor arm B is ever called, recon factor included");
  const ledgerPath = join(config.root, "state", "ledger.ndjson");
  const pairLines = readLedgerLines(ledgerPath).filter((l) => l.step === WIPE_TEST_PAIR_STEP);
  assert.equal(pairLines.length, 0, "a pre-flight refusal writes no wipetest.pair line, for the recon factor either");
});

// ═══ criterion 8: the sandbox-only refusal still fires for every factor, not only for learnings

test("wipeTestCommand: --factor recon on a non-sandbox --repo without --allow-non-sandbox is STILL refused (exit 2), before the merged pre-flight and before either arm dispatches", async () => {
  const config = wipeTestFixtureConfig();
  let mergeCheckCalls = 0;
  let dispatched = 0;
  const runTaskFn = (async () => {
    dispatched++;
    return { taskId: "W1-T86", runId: "X", merged: false, costUsd: 0, verdict: "merged" } as RunResult;
  }) as unknown as typeof import("../src/run-task.js").runTask;

  const code = await wipeTestCommand(["W1-T86", "--factor", "recon", "--repo", "remudero"], {
    config,
    runTaskFn,
    resolveMergedState: () => {
      mergeCheckCalls++;
      return { merged: false };
    },
  });

  assert.equal(code, 2, "the sandbox-only guard fires for the recon factor exactly as it does for learnings");
  assert.equal(mergeCheckCalls, 0, "refused before the merged pre-flight is ever consulted");
  assert.equal(dispatched, 0, "and before either arm ever dispatches");
});

test("main(): `rmd wipe-test <id> --factor recon --repo remudero` (no --allow-non-sandbox) dispatches to wipeTestCommand and exits 2", async () => {
  const savedArgv = process.argv;
  const savedExit = process.exit;
  process.argv = ["node", "rmd", "wipe-test", "W1-T86", "--factor", "recon", "--repo", "remudero"];
  let exitCode: number | undefined;
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    exitCode = code;
    throw new Error("__exit__");
  }) as never;
  const cap = captureConsoleError();
  try {
    await main().catch((e) => {
      if (!(e instanceof Error) || e.message !== "__exit__") throw e;
    });
  } finally {
    process.argv = savedArgv;
    process.exit = savedExit;
    cap.restore();
  }
  cap.explains(() => assert.equal(exitCode, 2, "the CLI entrypoint refuses a non-sandbox --repo for the recon factor too"));
});
