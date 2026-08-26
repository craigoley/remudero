import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTask, taskRecordContextLine, workerVisibleRecordPath } from "../src/run-task.js";
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
      // W1-T2268: `pollToGate`/`waitForCiGreen` no longer spend `gh pr view --json state,
      // statusCheckRollup` (GraphQL) — they read the rollup over REST — so the three argv shapes
      // below are what production now asks for. Answering them keeps this fixture's ORIGINAL
      // contract intact -- red CI on the first poll -- rather than changing what the test asserts.
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

/** Runs a fixture dispatch with the given `spawn`, returning the RunResult and the parsed
 *  ledger lines. Shared by every behavioral test below. */
async function runFixture(
  t: import("node:test").TestContext,
  spawn: typeof spawnWorker,
  // `planText` and the returned `planPath` exist for the record-path tests at the end of this
  // file, which need a task record carrying acceptance criteria AND need to assert on the exact
  // path the prompt names. Defaulted, so every test above is untouched.
  planText: string = FIXTURE_PLAN,
): Promise<{
  res: Awaited<ReturnType<typeof runTask>>;
  ledger: Array<Record<string, unknown>>;
  planPath: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "runtask-recon-degrade-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, planText);
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
    return { res, ledger, planPath };
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

// ── THE DEGRADED WORKER IS TOLD WHERE TO LOOK ────────────────────────────────────────────────
// `reconDegradedContextNote` has always ended "rely only on the CONTEXT/TASK below and your own
// read-only inspection" and never said WHERE. Nothing else in the prompt carries the task's own
// text: `renderImplementPrompt` renders `task.prompt ?? task.title` (MEASURED: zero of 425 task
// records carry `prompt:`), `.design` has ZERO reads anywhere in src/, and `task.acceptance` is
// consumed by `runReview` — the REVIEWER. So recon is the sole transport for the specification,
// and a degraded run loses it entirely. MEASURED on W1-T399: 138 turns, zero commits.
//
// THESE ARE BEHAVIOURAL ON PURPOSE. Asserting the string exists in the note function would prove
// nothing about what a worker receives — the degraded path could render a different template, or
// the provenance linter could reject the added CONTEXT block and kill the run. Both tests drive
// the REAL runTask degrade and assert on `spawnCalls[2].prompt`, the bytes implement is handed.

const FIXTURE_PLAN_WITH_ACCEPTANCE = [
  "- id: T-RECON-DEGRADE",
  "  title: recon-degrade wiring probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "  acceptance:",
  '    - claim: "the widget is load-bearing"',
  '      proof: "unit test: the widget bears load"',
  '    - claim: "the second criterion is also carried"',
  '      proof: "grep: WIDGET in src/lib/daemon.ts"',
  "",
].join("\n");

test("BEHAVIORAL: a degraded implement prompt NAMES the task's own record path and carries its acceptance criteria", async (t) => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length <= 2) {
      return result({ sessionId: `s-recon-${spawnCalls.length}`, subtype: "error_max_turns", isError: true, numTurns: 20 });
    }
    return result({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  const { ledger, planPath } = await runFixture(t, spawn, FIXTURE_PLAN_WITH_ACCEPTANCE);

  // THE FIXTURE MUST REACH THE DEGRADE BRANCH — asserted before anything is concluded from the
  // prompt. A run that never degraded would also "not contain a wrong note".
  assert.equal(spawnCalls.length, 3, "recon, retry, implement — the fixture reached the degrade");
  assert.equal(ledger.filter((l) => l.step === "recon.degraded").length, 1, "the degrade branch actually ran");

  const prompt = String(spawnCalls[2].prompt);
  assert.match(prompt, /RECON CONTEXT ABSENT/, "the pre-existing absence note is still there");
  // W1-T501: the pointer is now TREE-RELATIVE. It must still name the record the loader would
  // resolve, but as a path the worker can open in its OWN worktree — the absolute orchestrator
  // form is what sent workers writing into the daemon's checkout.
  const relRecord = relative(dirname(dirname(planPath)), planPath);
  assert.ok(
    prompt.includes(relRecord),
    `the prompt must name the record the loader would resolve, tree-relative (${relRecord})`,
  );
  assert.ok(!prompt.includes(planPath), "and NEVER the orchestrator's absolute path");
  assert.match(prompt, /READ IT FIRST/, "and tell the worker to open it before anything else");
  assert.match(prompt, /the widget is load-bearing/, "the acceptance criteria travel with it");
  assert.match(prompt, /the second criterion is also carried/, "every criterion, not just the first");
  assert.match(prompt, /unit test: the widget bears load/, "including each criterion's proof");
});

// ── AND SO IS THE HEALTHY ONE ────────────────────────────────────────────────────────────────
// This assertion USED TO READ THE OTHER WAY — "a NON-degraded implement prompt gets no record
// note — recon already relayed it" — and #1525's call-site comment gave that as the reason. The
// premise is false at any sha, and the code says so three ways:
//   (1) recon is NEVER TOLD WHICH TASK it is reconning: the spawn passes
//       `renderReconPrompt(planIndexBlock, operatorNotesBlock)` — no task id, no title, no path,
//       and `operatorNotesBlock` is "" for a task with no console notes;
//   (2) only `OBSERVED:` survives `reconObservedToContext`, so a recon that reads the shard and
//       summarises the design under INFERRED has it dropped;
//   (3) that section can be EMPTY, yielding the silently-empty CONTEXT block the degraded note's
//       own doc says must never happen.
// So the pointer was injected exactly when recon FAILED and withheld whenever it worked — while
// the healthy path is the one that runs on every dispatch.
test("BEHAVIORAL: a NON-degraded implement prompt ALSO names the task's own record path", async (t) => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      // A REAL report shape. `parseReconReport` returns null unless the text contains
      // "RECON REPORT", so the bare `OBSERVED:` line this fixture used before parsed to NOTHING —
      // meaning the healthy-path test that preceded this one never actually had recon context to
      // be redundant with. The empty-OBSERVED case is now its own test below, deliberately.
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: the repo has a README.md\nINFERRED: it is a node project\n",
      });
    }
    return result({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  const { ledger, planPath } = await runFixture(t, spawn, FIXTURE_PLAN_WITH_ACCEPTANCE);

  // THE FIXTURE MUST REACH THE HEALTHY BRANCH — asserted before anything is concluded from the
  // prompt. A run that degraded would also contain the record path, via the other arm entirely.
  assert.equal(spawnCalls.length, 2, "recon succeeded first time — fixture reached implement without degrading");
  assert.equal(ledger.filter((l) => l.step === "recon.degraded").length, 0, "nothing degraded");

  const prompt = String(spawnCalls[1].prompt);
  assert.doesNotMatch(prompt, /RECON CONTEXT ABSENT/, "still no absence note on the healthy path");
  const relRecord = relative(dirname(dirname(planPath)), planPath);
  assert.ok(prompt.includes(relRecord), `the healthy prompt names the record path too (${relRecord})`);
  assert.ok(!prompt.includes(planPath), "tree-relative on the healthy path as well (W1-T501)");
  assert.match(prompt, /YOUR TASK'S OWN RECORD IS AT/, "with the same READ IT FIRST instruction");
  assert.match(prompt, /the repo has a README\.md/, "and recon's OBSERVED lines are still relayed");

  // CRITERIA DO NOT TRAVEL HERE. The pointer costs one line; the criteria cost N, recon may
  // already have relayed them, and the record itself carries the design that criteria alone
  // would not give. This is the one asymmetry between the two arms that IS deliberate.
  assert.doesNotMatch(prompt, /Acceptance criteria, verbatim from that record/, "no criteria block");
  assert.doesNotMatch(prompt, /the widget is load-bearing/, "the criteria themselves stay out");
});

test("BEHAVIORAL: the healthy path names the record even when recon's OBSERVED section is EMPTY", async (t) => {
  // THE CASE THAT KILLS THE OLD RATIONALE OUTRIGHT. "recon already relayed all of this" assumed
  // recon produced something; an unparseable report yields `parsed?.observed ?? ""` → a CONTEXT
  // block with nothing in it. Before this change that worker got a title and no pointer, without
  // ever tripping the degrade branch that exists to make exactly that absence explicit.
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return result({ sessionId: "s-recon", text: "no report shape at all, just prose" });
    return result({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };

  const { ledger, planPath } = await runFixture(t, spawn, FIXTURE_PLAN_WITH_ACCEPTANCE);

  assert.equal(spawnCalls.length, 2, "recon 'succeeded' — no degrade, so the healthy arm rendered");
  assert.equal(ledger.filter((l) => l.step === "recon.degraded").length, 0, "nothing degraded");
  const relRecord = relative(dirname(dirname(planPath)), planPath);
  assert.ok(String(spawnCalls[1].prompt).includes(relRecord), "the pointer is there even with no OBSERVED lines");
  assert.ok(!String(spawnCalls[1].prompt).includes(planPath), "and still tree-relative (W1-T501)");
});

test("the record line is omitted, not thrown, when the record cannot be resolved", () => {
  // FAIL-SOFT, the property #1525 built `taskRecordPath` for: an advisory line must never turn one
  // unresolvable plan record into a failed run. This branch is unreachable behaviourally — a plan
  // that does not hold the task cannot dispatch it — so the helper is exported and driven directly,
  // the same reason `softBudgetWarning` next to it is.
  assert.equal(
    taskRecordContextLine("T-NOT-IN-ANY-PLAN", undefined, [{ claim: "unreachable", proof: "unit test: unreachable" }]),
    "",
    "an unresolved record renders nothing at all — no bullet, no criteria, no throw",
  );

  // AND THE CITED SHAPE, since `assertProvenance` is what a malformed line would kill the run at.
  const line = taskRecordContextLine("T-X", "/plan/tasks.d/T-X.yaml");
  assert.match(line, /^- YOUR TASK'S OWN RECORD IS AT \/plan\/tasks\.d\/T-X\.yaml/, "one bullet, path named");
  assert.match(line, /\[src: plan#T-X\]$/, "cited with an ACCEPTED_KIND, on the block's last line");

  // Criteria render as NON-BULLET continuation lines: `contextBlocks` absorbs them into this same
  // block, so they never open uncited blocks of their own.
  const withCriteria = taskRecordContextLine("T-X", "/plan/tasks.d/T-X.yaml", [{ claim: "c1", proof: "p1" }]);
  for (const l of withCriteria.split("\n").slice(1)) {
    assert.doesNotMatch(l, /^\s*[-*+]\s/, `continuation line must not be a bullet: ${JSON.stringify(l)}`);
  }
});

// ── W1-T501: THE RECORD PATH MUST MEAN THE WORKER'S TREE ────────────────────────────────────
//
// THE DEFECT. `taskRecordPath` resolves against the ORCHESTRATOR's `planPath` — the daemon's own
// checkout — and that absolute answer went straight into the worker's prompt. Workers followed it:
// counting Write/Edit calls only, 12 of 41 surviving transcripts wrote into the daemon's checkout
// and 7 wrote there exclusively; 29 wrote only to their worktree (the control that makes those two
// populations distinguishable). The harm is the STALENESS PIN, not lost work — a dirty parent makes
// `daemonFreshnessFromService` report the daemon fresh, so it never restarts onto merged code.
//
// A STRING ASSERTION WOULD PROVE NOTHING, so these RESOLVE the emitted path against a worktree and
// against the orchestrator's tree, and assert which one it lands in. The falsifier drives the SAME
// helper with the pre-fix absolute form and shows it fails that assertion.

/** The two trees a record path could land in, laid out the way production has them. */
function twoTrees(): { orchestrator: string; worktree: string; planPath: string; record: string } {
  const base = mkdtempSync(join(tmpdir(), "w1t501-"));
  const orchestrator = join(base, "remudero");
  const worktree = join(base, "worktrees", "run-W1-T501-1");
  mkdirSync(join(orchestrator, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(worktree, "plan", "tasks.d"), { recursive: true });
  return {
    orchestrator,
    worktree,
    planPath: join(orchestrator, "plan", "tasks.yaml"),
    record: join(orchestrator, "plan", "tasks.d", "W1-T501-x.yaml"),
  };
}

/** Pull the path back out of the rendered bullet, exactly as a worker reading it would. */
function pathFromLine(line: string): string {
  const m = line.match(/^- YOUR TASK'S OWN RECORD IS AT (\S+) —/);
  assert.ok(m, `the bullet must name a path: ${JSON.stringify(line.slice(0, 90))}`);
  return m![1];
}

test("W1-T501: the task record line never names the orchestrator checkout", () => {
  const { orchestrator, worktree, planPath, record } = twoTrees();
  const line = taskRecordContextLine("W1-T501", workerVisibleRecordPath(planPath, record));
  const emitted = pathFromLine(line);

  // THE ASSERTION THAT MATTERS: resolved against the WORKER's cwd it lands inside the worktree,
  // and it does NOT land in the orchestrator's tree. Both directions, because a path that resolved
  // nowhere would also satisfy "not in the orchestrator".
  assert.equal(isAbsolute(emitted), false, "the emitted path must not be absolute");
  const inWorktree = resolve(worktree, emitted);
  assert.ok(inWorktree.startsWith(worktree + "/"), `must resolve inside the worktree, got ${inWorktree}`);
  assert.ok(!inWorktree.startsWith(orchestrator + "/"), "and must not reach the orchestrator's tree");
  assert.equal(emitted, join("plan", "tasks.d", "W1-T501-x.yaml"), "and it is the plain repo-relative path");

  // FALSIFIER: the pre-W1-T501 form is the raw absolute answer. Same helper, same extraction — it
  // resolves into the ORCHESTRATOR's tree, which is exactly the write that dirtied the daemon.
  const before = pathFromLine(taskRecordContextLine("W1-T501", record));
  assert.equal(isAbsolute(before), true, "sanity: the old form really was absolute");
  assert.ok(
    resolve(worktree, before).startsWith(orchestrator + "/"),
    "the falsifier must land in the orchestrator's tree — otherwise this test proves nothing",
  );
});

test("W1-T501: an absent worktree shard degrades without naming a foreign path", () => {
  const { planPath } = twoTrees();

  // Unresolvable record: the bullet is omitted entirely rather than pointing anywhere.
  assert.equal(workerVisibleRecordPath(planPath, undefined), undefined, "nothing in, nothing out");
  assert.equal(taskRecordContextLine("W1-T501", workerVisibleRecordPath(planPath, undefined)), "");

  // AND THE ESCAPE CASE, which is the one that could smuggle a foreign tree back in: a record that
  // sits OUTSIDE the plan's own root would relativise to `../…`. Refuse it — an omitted advisory
  // line is strictly better than a path that climbs out of the worker's tree.
  const foreign = join(mkdtempSync(join(tmpdir(), "w1t501-foreign-")), "plan", "tasks.d", "W1-T501-x.yaml");
  const escaped = workerVisibleRecordPath(planPath, foreign);
  assert.equal(escaped, undefined, "a record outside the plan's root is refused, not emitted as ../..");
  assert.equal(taskRecordContextLine("W1-T501", escaped), "", "so no bullet is rendered at all");
});

test("W1-T501: no worker prompt text carries an orchestrator absolute path", async (t) => {
  // BEHAVIOURAL — the REAL dispatch, not the helper. Whatever the implement worker is handed must
  // contain no absolute path into the tree the plan was loaded from.
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) return result({ sessionId: "s-recon", text: "REPORT\nOBSERVED: a thing\n" });
    return result({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" });
  };
  const { planPath } = await runFixture(t, spawn, FIXTURE_PLAN_WITH_ACCEPTANCE);
  assert.equal(spawnCalls.length, 2, "the fixture reached a real implement spawn");

  const prompt = String(spawnCalls[1].prompt);
  // ANCHOR ON THE DIRECTORY THE PLAN ACTUALLY LIVES IN, not a computed repo root. This fixture is
  // FLAT (`planPath` is `<root>/tasks.yaml`), so `dirname(dirname(planPath))` is `/tmp` and would
  // match the prompt's own unrelated `/tmp/done` boilerplate — a false positive that says nothing
  // about the defect. `dirname(planPath)` is the orchestrator tree here and `<repo>/plan` in
  // production; either way, no worker prompt line has any business naming it absolutely.
  const planDir = dirname(planPath);
  assert.ok(!prompt.includes(planPath), "the plan's own absolute path must not appear");
  for (const line of prompt.split("\n")) {
    assert.ok(
      !line.includes(`${planDir}/`),
      `no prompt line may carry an orchestrator-rooted absolute path: ${JSON.stringify(line.slice(0, 100))}`,
    );
  }
  // POSITIVE CONTROL on that sweep: the pointer really is present, so the zero above is a real
  // absence rather than a prompt that simply never mentioned the record.
  assert.match(prompt, /YOUR TASK'S OWN RECORD IS AT /, "the record bullet is still emitted");
});

test("W1-T501: the acceptance criteria still render beside the record line", () => {
  const { planPath, record } = twoTrees();
  const line = taskRecordContextLine("W1-T501", workerVisibleRecordPath(planPath, record), [
    { claim: "the path resolves in the worker's tree", proof: "unit test: resolves in tree" },
    { claim: "the second criterion also travels", proof: "grep: second in src/run-task.ts" },
  ]);
  assert.match(line, /Acceptance criteria, verbatim from that record:/);
  assert.match(line, /the path resolves in the worker's tree/, "the first criterion travels");
  assert.match(line, /the second criterion also travels/, "and every later one");
  assert.match(line, /proof: unit test: resolves in tree/, "including each proof");
  // The continuation lines must stay NON-BULLET so `contextBlocks` keeps them in this cited block.
  for (const l of line.split("\n").slice(1)) {
    assert.doesNotMatch(l, /^\s*[-*+]\s/, `continuation must not be a bullet: ${JSON.stringify(l)}`);
  }
});
