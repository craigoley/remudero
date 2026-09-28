// test/a-refused-dispatch-returns-with-a-verdict.test.ts — W1-T4708: two pre-worktree refusals in
// runTaskBody RETURN a RunResult rather than throw — a contested (or unreachable) dispatch claim and a
// stale worktree base — and neither ledgered the verdict it returned, so each refused run read as in
// flight forever (20 claim and 7 stale-base runs 2026-09-25..28). Each test drives the REAL runTask
// against a real local git origin and asserts one terminal verdict naming the site, the SAME RunResult,
// and that the new rows leave every re-dispatch reader where the verdict-less runs left it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { endRefusedRun, runTask, type RunResult } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import { detectRunningLong } from "../src/lib/cost-anomaly.js";
import type { DispatchClaimOutcome, DispatchClaimReserver } from "../src/lib/dispatch-claim.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import {
  dispatchesWithoutNewOwnedPr,
  isDispatchBreakerTripped,
  latestIndependentFailureBlock,
  REFUSED_RUN_VERDICT_STAGE_LIST,
  THROWN_RUN_VERDICT_STAGES,
  type GitHub,
} from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { spawnWorker } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const TASK_ID = "T-REFUSED-VERDICT";
type Row = Record<string, unknown>;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" });
}

/** A bare origin, a seed commit, and the managed checkout at `<root>/repos/remudero`. */
function buildFixture(): { root: string; planPath: string; config: Config; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}refused-verdict-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(
    planPath,
    [`- id: ${TASK_ID}`, "  title: a refused dispatch still ends with a verdict", "  repo: remudero", "  type: implement",
      "  verify: auto", "  risk: medium", "  files: [src/lib/daemon.ts]", "  origin: test", "  status: queued", ""].join("\n"),
  );
  const origin = gitRepo({ bare: true, kind: "refused-verdict-origin" });
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "-q", origin.dir, seed], { stdio: "pipe" });
  git(seed, "config", "user.email", "t4708@example.invalid");
  git(seed, "config", "user.name", "t4708");
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir], { stdio: "pipe" });
  git(repoDir, "config", "user.email", "t4708@example.invalid");
  git(repoDir, "config", "user.name", "t4708");
  const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
  return { root, planPath, config, cleanup: () => (origin.cleanup(), rmSync(root, { recursive: true, force: true })) };
}

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function scriptedReserver(outcome: DispatchClaimOutcome): DispatchClaimReserver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    mintAnchor: () => "t4708-anchor",
    attempt: () => outcome,
    holder: () => (outcome === "taken" ? "another-hosts-anchor" : undefined),
    drop: (taskId, o) => (calls.push(`drop:${taskId}:${o?.expect ?? "-"}`), true),
    lastAttemptStderr: () => "fatal: unable to access 'https://x-access-token:ghs_t4708secret@github.com/acme/r.git/'",
  };
}

const holdingContainment = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });
const cleanIsolation = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

interface Outcome {
  result: RunResult;
  ledger: Row[];
  reserver: ReturnType<typeof scriptedReserver>;
}

async function dispatch(fx: ReturnType<typeof buildFixture>, claim: DispatchClaimOutcome, staleBase = false): Promise<Outcome> {
  const reserver = scriptedReserver(claim);
  const spawn: typeof spawnWorker = async () => {
    throw new Error("must never spawn — every refusal under test returns before any worker runs");
  };
  const result = await withLiveWritesAllowed(() =>
    runTask(TASK_ID, {
      skipGitSync: true,
      planPath: fx.planPath,
      config: fx.config,
      github: OFFLINE_GITHUB,
      spawn,
      containmentExec: holdingContainment,
      isolationExec: cleanIsolation,
      claimReserver: reserver,
      // The same stale-base injection test/dispatch-claim.test.ts threads through runTask's seam.
      ...(staleBase ? { worktreeBaseDeps: { readRemoteHead: () => "0".repeat(40) } } : {}),
    }),
  );
  const ledger = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
  return { result, ledger, reserver };
}

/** Exactly one terminal verdict for the run, after its site's own row, carrying the returned verdict and `stage`. */
function assertOneTerminalVerdict(o: Outcome, siteStep: string, stage: string, verdict: RunResult["verdict"]): Row {
  const runStart = o.ledger.find((row) => row.step === "run.start");
  assert.ok(runStart, "the run started");
  assert.deepEqual(
    o.result,
    { taskId: TASK_ID, runId: runStart.run_id, merged: false, costUsd: 0, verdict },
    "runTask returns the same RunResult it always did",
  );
  const own = o.ledger.filter((row) => row.run_id === runStart.run_id);
  const verdicts = own.filter((row) => row.step === "verdict");
  assert.equal(verdicts.length, 1, "exactly one terminal verdict row");
  const row = verdicts[0]!;
  assert.equal(row.verdict, verdict, "the row carries the verdict the run returns");
  assert.equal(row.stage, stage);
  assert.equal(row.cost_usd, 0);
  assert.equal(row.model, null, "no worker outcome is read off a run that never spawned one");
  assert.equal(typeof row.reason, "string");
  const site = own.find((r) => r.step === siteStep);
  assert.ok(site, `the site's own ${siteStep} row is unchanged`);
  assert.ok(own.indexOf(row) > own.indexOf(site), "the verdict follows the site's row");
  assert.equal(own.filter((r) => r.step === "run.error").length, 0, "a returned refusal never took the run.error path");
  return row;
}

test("W1-T4708: a held dispatch claim writes one blocked_inflight verdict naming dispatch.claim and returns the same RunResult", async () => {
  const fx = buildFixture();
  try {
    const o = await dispatch(fx, "taken");
    assert.ok(o.ledger.some((row) => row.step === "dispatch.claim_released"), "the release row is still written");
    const row = assertOneTerminalVerdict(o, "dispatch.claim_released", "dispatch.claim", "blocked_inflight");
    const claim = o.ledger.find((r) => r.step === "dispatch.claim");
    assert.equal(row.reason, claim?.reason, "the verdict names the refusal reason the claim row carries");
    assert.equal(o.ledger.find((r) => r.step === "worktree.add"), undefined, "no worktree is cut");

    // The goal: cost-anomaly's in-flight fold listed this run with no verdict row, and no longer does.
    const runStart = o.ledger.find((r) => r.step === "run.start")!;
    const runId = String(runStart.run_id);
    const startMs = Date.parse(String(runStart.ts));
    const settled: LedgerRecord[] = [0, 1, 2].flatMap((i) => [
      { run_id: `settled-${i}`, task_id: `T-SETTLED-${i}`, step: "run.start", task_class: runStart.task_class, ts: new Date(startMs - 86_400_000).toISOString() },
      { run_id: `settled-${i}`, task_id: `T-SETTLED-${i}`, step: "verdict", verdict: "merged", ts: new Date(startMs - 86_340_000).toISOString() },
    ]);
    const records = [...settled, ...(o.ledger as LedgerRecord[])];
    const nowMs = startMs + 35 * 3_600_000;
    const running = (rows: LedgerRecord[]) => detectRunningLong(rows, { multiplier: 3, minSamples: 3 }, nowMs).map((f) => f.runId);
    assert.deepEqual(running(records.filter((r) => r.step !== "verdict" || r.run_id !== runId)), [runId], "control: verdict-less, it reads as running");
    assert.deepEqual(running(records), [], "with its terminal verdict the run is no longer in flight");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4708: an unreachable claim writes one blocked_git_fetch verdict with a credential-scrubbed reason", async () => {
  const fx = buildFixture();
  try {
    const o = await dispatch(fx, "unreachable");
    const row = assertOneTerminalVerdict(o, "dispatch.claim", "dispatch.claim", "blocked_git_fetch");
    assert.equal(o.ledger.find((r) => r.step === "dispatch.claim_released"), undefined, "unreachable still releases nothing");
    assert.ok(!String(row.reason).includes("ghs_t4708secret"), "the git stderr in the reason is scrubbed");
    assert.match(String(row.reason), /unable to access/, "and still names its cause");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4708: a stale worktree base writes one failed verdict naming worktree.stale_base and still drops its claim", async () => {
  const fx = buildFixture();
  try {
    const o = await dispatch(fx, "created", true);
    const row = assertOneTerminalVerdict(o, "worktree.stale_base", "worktree.stale_base", "failed");
    assert.match(String(row.reason), /is BEHIND .* remote head 0{40}/);
    assert.ok(o.reserver.calls.includes(`drop:${TASK_ID}:t4708-anchor`), "the holder-arm release still runs");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4708: a run that already wrote a verdict writes no second, and a ledger failure never replaces the returned result", () => {
  const rows: Array<{ step: string; extra?: Row }> = [];
  const log = (step: string, extra?: Row) => void rows.push({ step, extra });
  const result: RunResult = { taskId: TASK_ID, runId: "r1", merged: false, costUsd: 0, verdict: "blocked_inflight" };
  assert.equal(endRefusedRun(log, true, "dispatch.claim", result, "held"), result);
  assert.equal(rows.length, 0, "a run that already ended gets no second verdict");
  assert.equal(endRefusedRun(log, false, "dispatch.claim", result, "held"), result);
  assert.deepEqual(rows, [
    { step: "verdict", extra: { verdict: "blocked_inflight", reason: "held", stage: "dispatch.claim", cost_usd: 0, model: null, served_model: null } },
  ]);
  const failing = () => { throw new Error("ledger append failed"); };
  assert.equal(endRefusedRun(failing, false, "worktree.stale_base", result, "x"), result);
});

test("W1-T4708: the refused-run verdicts leave the re-offer latch and the dispatch breaker where the verdict-less runs left them", () => {
  assert.deepEqual(REFUSED_RUN_VERDICT_STAGE_LIST.filter((s) => !THROWN_RUN_VERDICT_STAGES.has(s)), [], "every refused-run stage is a run-ending stage");
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (minutes: number) => new Date(baseMs + minutes * 60_000).toISOString();
  const rows: Row[] = [];
  const block = (runId: string, ts: string) =>
    rows.push(
      { task_id: TASK_ID, run_id: runId, step: "run.start", ts },
      { task_id: TASK_ID, run_id: runId, step: "verdict", verdict: "blocked_transient", ts },
      { task_id: TASK_ID, run_id: runId, step: "dispatch.blocked_independent", verdict: "blocked_transient", ts },
    );
  const refused = (runId: string, ts: string, verdict: string, stage: string, withVerdict: boolean) =>
    rows.push(
      { task_id: TASK_ID, run_id: runId, step: "run.start", ts },
      { task_id: TASK_ID, run_id: runId, step: "dispatch.claim", outcome: "taken", proceed: false, ts },
      ...(withVerdict ? [{ task_id: TASK_ID, run_id: runId, step: "verdict", verdict, stage, reason: "x", cost_usd: 0, ts }] : []),
    );
  const cases: Array<[string, string]> = [["blocked_inflight", "dispatch.claim"], ["blocked_git_fetch", "dispatch.claim"], ["failed", "worktree.stale_base"]];
  for (const [verdict, stage] of cases) {
    const read = (withVerdict: boolean) => {
      rows.length = 0;
      block("a", at(0));
      refused("b", at(10), verdict, stage, withVerdict);
      block("c", at(20));
      refused("d", at(30), verdict, stage, withVerdict);
      block("e", at(40));
      const opts = { nowMs: baseMs + 86_400_000 };
      return {
        latch: latestIndependentFailureBlock(rows, TASK_ID, undefined, baseMs + 86_400_000),
        streak: dispatchesWithoutNewOwnedPr(rows, TASK_ID, undefined, opts),
        tripped: isDispatchBreakerTripped(rows, TASK_ID, 2, undefined, opts),
      };
    };
    assert.deepEqual(read(false), { latch: true, streak: 2, tripped: true }, `${verdict}/${stage}: the verdict-less ledger's readings`);
    assert.deepEqual(read(true), read(false), `${verdict}/${stage}: the new verdict rows change no re-dispatch reading`);
  }
});
