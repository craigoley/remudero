// W1-T4629: a worker's REPORT ends with an anchored `SELF_FORECAST: p=<0..1>` line — its own
// probability that this head passes review and merges without rework. The harness parses it
// strictly (a bad or missing line is ABSENT with a named reason, never coerced to 0.5), ledgers
// it on the terminal `implement.done` row beside the assignment, and a projection scores it
// against the verified outcome (W1-T4608) with a Brier score and a reliability curve per model
// and task class. Never a gate or a routing input.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SELF_FORECAST_LINE_RE,
  SELF_FORECAST_REPORT_CONTRACT,
  SELF_FORECAST_VALUE_RE,
  parseSelfForecast,
  scoreSelfForecasts,
  type SelfForecastPair,
} from "../src/lib/self-forecast.js";
import { runTask } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { spawnWorker, WorkerResult } from "../src/lib/worker.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────

test("parseSelfForecast reads a valid anchored line as present with its probability", () => {
  assert.deepEqual(parseSelfForecast("REPORT\ndid the work\nSELF_FORECAST: p=0.72\nPR_URL: x"), { state: "present", p: 0.72 });
  assert.deepEqual(parseSelfForecast("  SELF_FORECAST:p=.5  "), { state: "present", p: 0.5 });
});

test("parseSelfForecast accepts both closed bounds exactly", () => {
  assert.deepEqual(parseSelfForecast("SELF_FORECAST: p=0"), { state: "present", p: 0 });
  assert.deepEqual(parseSelfForecast("SELF_FORECAST: p=1"), { state: "present", p: 1 });
  assert.deepEqual(parseSelfForecast("SELF_FORECAST: p=1.000"), { state: "present", p: 1 });
});

test("parseSelfForecast refuses a value outside [0,1] as invalid, never clamped", () => {
  assert.deepEqual(parseSelfForecast("SELF_FORECAST: p=1.01"), { state: "invalid", reason: "out-of-range" });
  assert.deepEqual(parseSelfForecast("SELF_FORECAST: p=7"), { state: "invalid", reason: "out-of-range" });
});

test("parseSelfForecast refuses a malformed line as invalid, never coerced to 0.5", () => {
  for (const bad of ["SELF_FORECAST: 0.7", "SELF_FORECAST: p=high", "SELF_FORECAST: p=-0.2", "SELF_FORECAST: p=70%",
    "SELF_FORECAST: p=0.7 because tests pass", "SELF_FORECAST:"]) {
    assert.deepEqual(parseSelfForecast(bad), { state: "invalid", reason: "malformed" }, bad);
  }
});

test("parseSelfForecast reads a missing line as absent, and an unanchored mention does not count", () => {
  assert.deepEqual(parseSelfForecast("REPORT\nPR_URL: x"), { state: "absent", reason: "missing" });
  assert.deepEqual(parseSelfForecast("I would put SELF_FORECAST: p=0.9 here"), { state: "absent", reason: "missing" });
  assert.deepEqual(parseSelfForecast(""), { state: "absent", reason: "missing" });
});

test("parseSelfForecast refuses duplicate lines as invalid rather than picking one", () => {
  assert.deepEqual(parseSelfForecast("SELF_FORECAST: p=0.2\nSELF_FORECAST: p=0.9"), { state: "invalid", reason: "duplicate" });
  assert.deepEqual(parseSelfForecast("SELF_FORECAST: p=0.4\nSELF_FORECAST: p=0.4"), { state: "invalid", reason: "duplicate" });
});

test("SELF_FORECAST_LINE_RE and SELF_FORECAST_VALUE_RE accept the contract and refuse everything else", () => {
  assert.equal(SELF_FORECAST_LINE_RE.test("SELF_FORECAST: p=0.3"), true);
  assert.equal(SELF_FORECAST_LINE_RE.test("my SELF_FORECAST: p=0.3"), false);
  assert.equal(SELF_FORECAST_VALUE_RE.test("SELF_FORECAST: p=0.3"), true);
  assert.equal(SELF_FORECAST_VALUE_RE.test("SELF_FORECAST: p=0.3x"), false);
});

test("the report contract names the anchored line, its range, and what it forecasts, in one line", () => {
  assert.match(SELF_FORECAST_REPORT_CONTRACT, /SELF_FORECAST: p=/);
  assert.match(SELF_FORECAST_REPORT_CONTRACT, /merges without rework/);
  assert.equal(SELF_FORECAST_REPORT_CONTRACT.trim().split("\n").length, 1);
  assert.deepEqual(parseSelfForecast(SELF_FORECAST_REPORT_CONTRACT), { state: "absent", reason: "missing" },
    "the instruction itself, echoed into a transcript, never reads as a forecast");
});

// ── Scoring ─────────────────────────────────────────────────────────────────────────────────

const present = (p: number) => ({ state: "present", p }) as const;

test("scoreSelfForecasts computes Brier, perception gap and a binned reliability curve against hand-computed values", () => {
  const pairs: SelfForecastPair[] = [
    { model: "sonnet", taskClass: "implement", forecast: present(0.9), verifiedOutcome: 1 },
    { model: "sonnet", taskClass: "implement", forecast: present(0.8), verifiedOutcome: 0 },
    { model: "sonnet", taskClass: "implement", forecast: present(0.2), verifiedOutcome: 0 },
    { model: "sonnet", taskClass: "implement", forecast: present(0.6), verifiedOutcome: 1 },
    // Counted but never scored: no forecast, and a forecast with no verified outcome.
    { model: "sonnet", taskClass: "implement", forecast: { state: "absent", reason: "missing" }, verifiedOutcome: 1 },
    { model: "sonnet", taskClass: "implement", forecast: present(0.5), verifiedOutcome: null },
    { model: "opus", taskClass: "implement", forecast: present(1), verifiedOutcome: 1 },
  ];
  const score = scoreSelfForecasts(pairs, { bins: 5 });
  assert.equal(score.state, "observed");
  assert.equal(score.groups.length, 2);
  const [opus, sonnet] = score.groups;
  assert.equal(opus.model, "opus");
  assert.deepEqual(opus.brier, { state: "observed", value: 0 });

  assert.equal(sonnet.model, "sonnet");
  assert.equal(sonnet.taskClass, "implement");
  assert.equal(sonnet.pairs, 6);
  assert.equal(sonnet.scored, 4);
  assert.equal(sonnet.forecastAbsent, 1);
  assert.equal(sonnet.outcomeUnverified, 1);
  // (0.9-1)^2 + (0.8-0)^2 + (0.2-0)^2 + (0.6-1)^2 = 0.01 + 0.64 + 0.04 + 0.16 = 0.85; / 4 = 0.2125
  assert.equal(sonnet.brier.state, "observed");
  assert.ok(sonnet.brier.state === "observed" && Math.abs(sonnet.brier.value - 0.2125) < 1e-12);
  // mean forecast (0.9+0.8+0.2+0.6)/4 = 0.625; observed rate 2/4 = 0.5; gap = +0.125 (over-confident)
  assert.ok(Math.abs(sonnet.meanForecast! - 0.625) < 1e-12);
  assert.equal(sonnet.observedRate, 0.5);
  assert.ok(Math.abs(sonnet.perceptionGap! - 0.125) < 1e-12);
  // 5 bins of width 0.2: 0.2 -> bin 1, 0.6 -> bin 3, 0.8 & 0.9 -> bin 4.
  assert.equal(sonnet.reliability.length, 5);
  assert.deepEqual(sonnet.reliability.map((b) => b.count), [0, 1, 0, 1, 2]);
  assert.equal(sonnet.reliability[0].meanForecast, null);
  assert.equal(sonnet.reliability[0].observedRate, null);
  assert.ok(Math.abs(sonnet.reliability[4].meanForecast! - 0.85) < 1e-12);
  assert.equal(sonnet.reliability[4].observedRate, 0.5);
  assert.equal(sonnet.reliability[1].observedRate, 0);
  assert.equal(sonnet.reliability[3].observedRate, 1);
  assert.ok(Math.abs(sonnet.reliability[4].lo - 0.8) < 1e-12 && sonnet.reliability[4].hi === 1);
});

test("scoreSelfForecasts reports unavailable, never a score, when no verified outcome or no forecast exists", () => {
  const noOutcome = scoreSelfForecasts([
    { model: "sonnet", taskClass: "implement", forecast: present(0.7), verifiedOutcome: null },
  ]);
  assert.equal(noOutcome.state, "unavailable");
  assert.deepEqual(noOutcome.groups[0].brier, { state: "unavailable", reason: "no-verified-outcome" });
  assert.equal(noOutcome.groups[0].meanForecast, null);
  assert.equal(noOutcome.groups[0].perceptionGap, null);
  assert.equal(noOutcome.groups[0].reliability.length, 10, "the default curve has ten bins");

  const noForecast = scoreSelfForecasts([
    { model: "sonnet", taskClass: "implement", forecast: { state: "invalid", reason: "malformed" }, verifiedOutcome: 1 },
  ]);
  assert.deepEqual(noForecast.groups[0].brier, { state: "unavailable", reason: "no-forecast" });
  assert.equal(noForecast.groups[0].forecastAbsent, 1);

  const neither = scoreSelfForecasts([
    { model: null, taskClass: null, forecast: { state: "absent", reason: "missing" }, verifiedOutcome: 1 },
    { model: null, taskClass: null, forecast: present(0.3), verifiedOutcome: null },
  ]);
  assert.deepEqual(neither.groups[0].brier, { state: "unavailable", reason: "no-scored-pair" });

  assert.deepEqual(scoreSelfForecasts([]), { state: "unavailable", groups: [] });
  assert.throws(() => scoreSelfForecasts([], { bins: 0 }), /bins/);
});

// ── Wiring: the implement worker is asked for the line, and implement.done carries it ─────

const FIXTURE_PLAN = [
  "- id: TST-SELFFORECAST",
  "  title: self forecast wiring probe",
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

const passingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false,
    insideWriteCreated: true, costUsd: 0 });

const passingIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

function gitFixture(root: string): void {
  const origin = gitRepo({ bare: true, kind: "selfforecast-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "selfforecast-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "selfforecast-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "selfforecast-test"]);
}

function workerResult(text: string, extra: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success", isError: false,
    apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false, ...extra,
  };
}

async function runWithImplementReport(report: string): Promise<{ prompt: string; row: Record<string, unknown> }> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}selfforecast-`));
  try {
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, FIXTURE_PLAN);
    const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
    gitFixture(root);
    const prompts: string[] = [];
    const spawn: typeof spawnWorker = async (opts) => {
      prompts.push(opts.prompt);
      return prompts.length === 1
        ? workerResult("RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n")
        : workerResult(report, { selectionAssignmentId: "asg-4629" });
    };
    const res = await runTask("TST-SELFFORECAST", { skipGitSync: true, planPath, config, github: OFFLINE_GITHUB, spawn,
      containmentExec: passingContainmentExec, isolationExec: passingIsolationExec });
    assert.equal(res.verdict, "no_pr");
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const row = ledger.find((l) => l.step === "implement.done");
    assert.ok(row, "implement.done was ledgered");
    return { prompt: prompts[1], row: row! };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("BEHAVIORAL: the implement prompt asks for SELF_FORECAST and implement.done ledgers the parsed forecast beside its assignment", async () => {
  const { prompt, row } = await runWithImplementReport("REPORT\nno PR opened yet\nSELF_FORECAST: p=0.35\n");
  assert.ok(prompt.includes(SELF_FORECAST_REPORT_CONTRACT), "the implement worker is told to end its REPORT with the line");
  assert.deepEqual(row.self_forecast, { state: "present", p: 0.35 });
  assert.equal(row.selection_assignment_id, "asg-4629");
});

test("BEHAVIORAL: a report with no SELF_FORECAST line ledgers absent, never 0.5, and the run is unchanged", async () => {
  const { row } = await runWithImplementReport("REPORT\nno PR opened yet\n");
  assert.deepEqual(row.self_forecast, { state: "absent", reason: "missing" });
  assert.equal(row.selection_assignment_id, "asg-4629");
});
