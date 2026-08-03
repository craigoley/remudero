import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTask } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";

// ── W1-T299: a recon worker that runs out of turns must not kill the whole dispatch — a
// read-only preamble failing must never cost the task its ability to ever run again. These
// mirror test/run-task.test.ts's W1-T105 followup-harvest fixture (a REAL local git "origin"
// standing in for GitHub, a fake `gh` on PATH, an injectable `spawn`) to drive the REAL
// runTask() dispatch path all the way to a real implement spawn, never a unit test of the
// retry/degrade logic in isolation. ──────────────────────────────────────────────────────

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

function result(over: Partial<WorkerResult>): WorkerResult {
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
  "- id: T-RECON-DEGRADE",
  "  title: recon-degrade wiring probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

/** An offline GitHub gateway: projectPlan runs with zero network round-trips. */
const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** A containmentExec that reports the outside-cwd write OS-DENIED — containment PASSES. */
const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

/** An isolationExec reporting zero inherited operator aliases/functions — isolation PASSES. */
const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

/** A real, throwaway BARE "origin" + a real clone at `repoDir` (mirrors run-task.test.ts's
 *  own `followupGitFixture`) — `worktreeAdd`'s `git fetch`/`git worktree add` and the run's
 *  later `git push origin HEAD` all run for real, entirely offline. */
function gitFixture(root: string): { repoDir: string } {
  const originGit = mkdtempSync(join(tmpdir(), "runtask-recon-degrade-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "runtask-recon-degrade-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "recon-degrade-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "recon-degrade-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "recon-degrade-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "recon-degrade-test"]);
  return { repoDir };
}

/** A fake `gh` on PATH answering the handful of subcommands this run reaches, red on CI so
 *  the run reaches its terminal verdict right after the implement spawn (mirrors
 *  run-task.test.ts's own `followupFakeGh`). */
function fakeGh(branch: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "runtask-recon-degrade-bin-"));
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
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

/** Runs a fixture dispatch with the given `spawn`, returning the RunResult and the parsed
 *  ledger lines. Shared by every behavioral test below. */
async function runFixture(
  t: import("node:test").TestContext,
  spawn: typeof spawnWorker,
): Promise<{ res: Awaited<ReturnType<typeof runTask>>; ledger: Array<Record<string, unknown>> }> {
  const root = mkdtempSync(join(tmpdir(), "runtask-recon-degrade-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };

  gitFixture(root);

  const FIXED_TS = 1785100000000;
  const branch = `run-T-RECON-DEGRADE-${FIXED_TS}`;
  const fakeBinDir = fakeGh(branch);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const { withLiveWritesAllowed } = await import("../src/lib/live-write-guard.js");
  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-RECON-DEGRADE", {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return { res, ledger };
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Static: the source actually implements the ledger line + prompt note ─────────────────

test("recon.degraded is ledgered in src/run-task.ts, naming the subtype", () => {
  assert.match(runTaskSrc, /log\("recon\.degraded"/, "run-task.ts must log a recon.degraded ledger line");
  const idx = runTaskSrc.indexOf('log("recon.degraded"');
  const block = runTaskSrc.slice(idx, idx + 400);
  assert.match(block, /subtype:\s*recon\.subtype/, "the recon.degraded line must name the subtype");
});

test("the implement prompt gets an EXPLICIT recon-absence claim on degrade, never a silent omission", () => {
  assert.match(runTaskSrc, /reconDegradedContextNote/, "a degraded recon must render an explicit absence note");
  const fnIdx = runTaskSrc.indexOf("function reconDegradedContextNote");
  const fnBlock = runTaskSrc.slice(fnIdx, fnIdx + 800);
  assert.match(fnBlock, /RECON CONTEXT ABSENT/, "the note must say, in words, that recon context is absent");
  assert.match(fnBlock, /citation\(`recon#\$\{taskId\}`\)/, "the absence note still carries a recon# citation (provenance gate)");
});

// ── Behavioral: recon errors ONCE then succeeds — no degrade, implement gets real context ──

test("BEHAVIORAL: a recon that errors once and succeeds on retry reaches implement with REAL recon context — never degraded", async (t) => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      // First recon attempt: error_max_turns — the measured dominant recon failure shape.
      return result({ sessionId: "s-recon-1", subtype: "error_max_turns", isError: true, numTurns: 20 });
    }
    if (spawnCalls.length === 2) {
      // Retry succeeds — a real OBSERVED line for the implement prompt to cite.
      return result({
        sessionId: "s-recon-2",
        text: "RECON REPORT\nOBSERVED: the repo has a README.md\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    // Implement.
    return result({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  const { res, ledger } = await runFixture(t, spawn);

  assert.equal(res.verdict, "blocked_ci", "the run reaches implement and its post-PR terminal verdict");
  assert.equal(spawnCalls.length, 3, "recon attempt 1 (error), recon attempt 2 (retry), implement — no fourth spawn");

  assert.equal(ledger.filter((l) => l.step === "recon.retry").length, 1, "exactly one bounded retry is ledgered");
  assert.equal(ledger.filter((l) => l.step === "recon.degraded").length, 0, "a retry that SUCCEEDS never degrades");

  const implementSpawn = spawnCalls[2];
  assert.match(String(implementSpawn.prompt), /the repo has a README\.md/, "the real recon OBSERVED line reaches the implement prompt");
  assert.doesNotMatch(String(implementSpawn.prompt), /RECON CONTEXT ABSENT/, "a successful retry never injects the absence note");
});

// ── Behavioral: recon errors TWICE — degrades, implement still spawns with the absence note ─

test("BEHAVIORAL: a recon that errors twice in a row DEGRADES (never aborts the run) — implement still spawns with an explicit absent-context note, and the degrade is ledgered naming the subtype", async (t) => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length <= 2) {
      // Both recon attempts die on the turn cap.
      return result({ sessionId: `s-recon-${spawnCalls.length}`, subtype: "error_max_turns", isError: true, numTurns: 20 });
    }
    // Implement still runs — a REAL dispatch, per the task's mandate.
    return result({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  const { res, ledger } = await runFixture(t, spawn);

  assert.equal(res.verdict, "blocked_ci", "the run reaches implement and a real terminal verdict — never fatal at recon");
  assert.equal(spawnCalls.length, 3, "recon attempt 1, recon attempt 2 (retry), implement — the bounded retry, then degrade");

  assert.equal(ledger.filter((l) => l.step === "recon.retry").length, 1, "the one bounded retry is ledgered");
  const degraded = ledger.filter((l) => l.step === "recon.degraded");
  assert.equal(degraded.length, 1, "the second failure is ledgered as recon.degraded, exactly once");
  assert.equal(degraded[0].subtype, "error_max_turns", "recon.degraded names the subtype that caused it");

  // implement must still be a REAL run.start dispatch (the per-task breaker's own counter) —
  // this run's run.start line was ledgered before recon ever spawned, unconditionally.
  assert.equal(ledger.filter((l) => l.step === "run.start" && l.task_id === "T-RECON-DEGRADE").length, 1);
  assert.equal(ledger.filter((l) => l.step === "verdict" && l.stage === "recon").length, 0, "recon never produces its own terminal verdict on a degrade — the run is NOT killed");

  const implementSpawn = spawnCalls[2];
  assert.match(String(implementSpawn.prompt), /RECON CONTEXT ABSENT/, "implement is explicitly told recon context is absent");
  assert.match(String(implementSpawn.prompt), /error_max_turns/, "the absence note names the subtype, same as the ledger line");
});

// ── Behavioral: a BUDGET breach at recon is the ONE exception the task carved out — it stays
// FATAL (never retried, never degraded) exactly like every other stage, on EITHER attempt ────

test("BEHAVIORAL: a recon budget breach on the FIRST attempt is FATAL — no retry, no implement, blocked_budget", async (t) => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    // The lone spawn breaches maxBudgetUsd — workerErrorVerdict's own doc says dollars are
    // the hard backstop and are NEVER retried, recon included.
    return result({ sessionId: "s-recon-1", subtype: "error_max_budget_usd", isError: true, numTurns: 5 });
  };

  const { res, ledger } = await runFixture(t, spawn);

  assert.equal(res.verdict, "blocked_budget", "a recon budget breach still ends the run as blocked_budget");
  assert.equal(spawnCalls.length, 1, "no bounded retry and no implement spawn follow a budget breach");

  assert.equal(ledger.filter((l) => l.step === "recon.retry").length, 0, "a budget breach is never retried");
  assert.equal(ledger.filter((l) => l.step === "recon.degraded").length, 0, "a budget breach degrades nothing — it is fatal");
  const verdicts = ledger.filter((l) => l.step === "verdict" && l.stage === "recon");
  assert.equal(verdicts.length, 1, "the budget breach is ledgered as the run's one terminal verdict");
  assert.equal(verdicts[0].verdict, "blocked_budget");
  assert.equal(verdicts[0].subtype, "error_max_budget_usd");
});

test("BEHAVIORAL: a recon budget breach on the SECOND (retry) attempt is still FATAL — never degraded to implement", async (t) => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      // First attempt: an ordinary (non-budget) error — earns the ONE bounded retry.
      return result({ sessionId: "s-recon-1", subtype: "error_max_turns", isError: true, numTurns: 20 });
    }
    // The retry itself breaches maxBudgetUsd — still fatal, never degraded to implement.
    return result({ sessionId: "s-recon-2", subtype: "error_max_budget_usd", isError: true, numTurns: 5 });
  };

  const { res, ledger } = await runFixture(t, spawn);

  assert.equal(res.verdict, "blocked_budget", "the retry's budget breach ends the run as blocked_budget, never a degrade");
  assert.equal(spawnCalls.length, 2, "recon attempt 1 (error), recon attempt 2 (budget breach) — implement never spawns");

  assert.equal(ledger.filter((l) => l.step === "recon.retry").length, 1, "the one bounded retry is still ledgered before the breach");
  assert.equal(ledger.filter((l) => l.step === "recon.degraded").length, 0, "a budget breach on the retry is fatal, not a degrade");
  const verdicts = ledger.filter((l) => l.step === "verdict" && l.stage === "recon");
  assert.equal(verdicts.length, 1, "the retry's budget breach is ledgered as the run's one terminal verdict");
  assert.equal(verdicts[0].verdict, "blocked_budget");
  assert.equal(verdicts[0].subtype, "error_max_budget_usd");
});
