// test/a-deferred-dispatch-leaves-no-run-in-flight.test.ts — W1-T4701: a dispatch deferred before its
// worktree exists (a managed-checkout refresh refusal, a node_modules refusal, a capacity-blocked
// preflight probe) or failing to cut one threw ABOVE runTaskBody's outer catch, so the run's only rows
// were run.start and the refusal: 20 fleet runs 2026-09-26..28 read as in flight forever. Each test
// drives the REAL runTask against a real local git origin and asserts the run now writes exactly one
// terminal verdict naming the site, while the SAME typed error still reaches daemon.ts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { endThrownRun, ManagedCheckoutRefreshRefusedError, runTask, type RunResult } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import { detectRunningLong } from "../src/lib/cost-anomaly.js";
import type { DispatchClaimReserver } from "../src/lib/dispatch-claim.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { latestIndependentFailureBlock, THROWN_RUN_VERDICT_STAGES, type GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { WorktreeNodeModulesRefusedError, type spawnWorker } from "../src/lib/worker.js";
import { ProviderCapacityBlockedError } from "../src/lib/worker-provider.js";
import { gitRepo } from "./helpers/git-repo.js";

const TASK_ID = "T-DEFERRED-VERDICT";
type Row = Record<string, unknown>;

const pkgJson = (deps: Record<string, string>) => JSON.stringify({ name: "t4701-core", version: "0.0.0", dependencies: deps });

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" });
}

type Shape = "plain" | "behind-main" | "lockfile-drift" | "origin-unreachable";

/** A bare origin, a seed, and the managed checkout at `<root>/repos/remudero`, shaped per `shape`. */
function buildFixture(shape: Shape): { root: string; planPath: string; config: Config; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}deferred-verdict-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(
    planPath,
    [`- id: ${TASK_ID}`, "  title: a deferred dispatch still ends with a verdict", "  repo: remudero", "  type: implement",
      "  verify: auto", "  risk: medium", "  files: [src/lib/daemon.ts]", "  origin: test", "  status: queued", ""].join("\n"),
  );
  const origin = gitRepo({ bare: true, kind: "deferred-verdict-origin" });
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "-q", origin.dir, seed], { stdio: "pipe" });
  git(seed, "config", "user.email", "t4701@example.invalid");
  git(seed, "config", "user.name", "t4701");
  writeFileSync(join(seed, ".gitignore"), "node_modules/\n");
  writeFileSync(join(seed, "package.json"), pkgJson({ a: "^1.0.0" }));
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir], { stdio: "pipe" });
  git(repoDir, "config", "user.email", "t4701@example.invalid");
  git(repoDir, "config", "user.name", "t4701");
  if (shape === "behind-main" || shape === "lockfile-drift") mkdirSync(join(repoDir, "node_modules"));
  if (shape === "behind-main") {
    // A clean checkout behind origin/main: the refresh fast-forwards it and runs the (failing) install.
    writeFileSync(join(seed, "package.json"), pkgJson({ a: "^1.0.0", added: "^2.0.0" }));
    git(seed, "commit", "-q", "-am", "add a dependency");
    git(seed, "push", "-q", "origin", "main");
  }
  // W1-T4193's same-package drift: the checkout's own install predates origin/main's package.json (a dirty
  // checkout, so the refresh leaves it and the worktree refuses to borrow it).
  if (shape === "lockfile-drift") writeFileSync(join(repoDir, "package.json"), pkgJson({ a: "^0.9.0" }));
  if (shape === "origin-unreachable") git(repoDir, "remote", "set-url", "origin", join(root, "no-such-origin.git"));
  const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
  return { root, planPath, config, cleanup: () => (origin.cleanup(), rmSync(root, { recursive: true, force: true })) };
}

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function fakeReserver(): DispatchClaimReserver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    mintAnchor: () => "t4701-anchor",
    attempt: () => "created",
    holder: () => undefined,
    drop: (taskId, o) => (calls.push(`drop:${taskId}:${o?.expect ?? "-"}`), true),
  };
}

const holdingContainment = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });
const cleanIsolation = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

interface Outcome {
  err: unknown;
  result: RunResult | undefined;
  ledger: Row[];
  reserver: ReturnType<typeof fakeReserver>;
}

async function dispatch(
  fx: ReturnType<typeof buildFixture>,
  over: { containmentExec?: typeof holdingContainment; isolationExec?: typeof cleanIsolation; managedCheckoutInstall?: (dir: string) => void } = {},
): Promise<Outcome> {
  const reserver = fakeReserver();
  const spawn: typeof spawnWorker = async () => {
    throw new Error("must never spawn — every exit under test fires before any worker runs");
  };
  let err: unknown;
  let result: RunResult | undefined;
  try {
    result = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath: fx.planPath,
        config: fx.config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: over.containmentExec ?? holdingContainment,
        isolationExec: over.isolationExec ?? cleanIsolation,
        claimReserver: reserver,
        managedCheckoutInstall: over.managedCheckoutInstall,
      }),
    );
  } catch (e) {
    err = e;
  }
  const ledger = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
  return { err, result, ledger, reserver };
}

/** The daemon's own deferral test (`isSpawnInfraBlocked`, src/lib/daemon.ts): a duck-typed tag, never instanceof. */
const readsAsDeferral = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { reasonClass?: unknown }).reasonClass === "blocked_toolchain";

/** Exactly one terminal verdict for the run, after its site's own row, naming `stage`. */
function assertOneTerminalVerdict(o: Outcome, siteStep: string, stage: string): Row {
  assert.equal(o.result, undefined, "the exit still throws — it never becomes a returned result");
  const runStart = o.ledger.find((row) => row.step === "run.start");
  assert.ok(runStart, "the run started");
  const own = o.ledger.filter((row) => row.run_id === runStart.run_id);
  const verdicts = own.filter((row) => row.step === "verdict");
  assert.equal(verdicts.length, 1, "exactly one terminal verdict row");
  const verdict = verdicts[0]!;
  assert.equal(verdict.verdict, "failed");
  assert.equal(verdict.stage, stage);
  assert.equal(verdict.model, null, "no worker outcome is read off a run that never spawned one");
  assert.equal(typeof verdict.cost_usd, "number");
  assert.equal(verdict.reason, (o.err as Error).message, "the verdict names the error the caller receives");
  const site = own.find((row) => row.step === siteStep);
  assert.ok(site, `the site's own ${siteStep} row is unchanged`);
  assert.ok(own.indexOf(verdict) > own.indexOf(site), "the verdict follows the site's row");
  assert.equal(own.filter((row) => row.step === "run.error").length, 0, "a pre-worktree exit never took the run.error path");
  return verdict;
}

test("W1-T4701: a managed-checkout refresh refusal writes one terminal verdict and the same deferral still propagates", async () => {
  const fx = buildFixture("behind-main");
  try {
    const o = await dispatch(fx, { managedCheckoutInstall: () => { throw new Error("simulated: npm ci exited 1"); } });
    assert.ok(o.err instanceof ManagedCheckoutRefreshRefusedError, `got: ${String(o.err)}`);
    assert.ok(readsAsDeferral(o.err), "daemon.ts still backs off without a strike");
    const refused = o.ledger.find((row) => row.step === "managed_checkout.refresh_refused");
    assert.equal(refused?.reason, o.err.message, "the refusal row and the thrown error are the same error");
    const verdict = assertOneTerminalVerdict(o, "managed_checkout.refresh_refused", "managed_checkout.refresh");
    assert.match(String(verdict.reason), /simulated: npm ci exited 1/);
    assert.ok(o.reserver.calls.includes(`drop:${TASK_ID}:t4701-anchor`), "the claim is still released");
    assert.equal(o.ledger.find((row) => row.step === "worktree.add"), undefined, "no worktree is cut");

    // The falsifier: cost-anomaly's in-flight fold listed this run with no verdict row, and no longer does.
    const runStart = o.ledger.find((row) => row.step === "run.start")!;
    const runId = String(runStart.run_id);
    const startMs = Date.parse(String(runStart.ts));
    const settled: LedgerRecord[] = [0, 1, 2].flatMap((i) => [
      { run_id: `settled-${i}`, task_id: `T-SETTLED-${i}`, step: "run.start", task_class: runStart.task_class, ts: new Date(startMs - 86_400_000).toISOString() },
      { run_id: `settled-${i}`, task_id: `T-SETTLED-${i}`, step: "verdict", verdict: "merged", ts: new Date(startMs - 86_340_000).toISOString() },
    ]);
    const records = [...settled, ...(o.ledger as LedgerRecord[])];
    const nowMs = startMs + 35 * 3_600_000;
    const running = (rows: LedgerRecord[]) => detectRunningLong(rows, { multiplier: 3, minSamples: 3 }, nowMs).map((f) => f.runId);
    assert.deepEqual(running(records.filter((row) => row.step !== "verdict" || row.run_id !== runId)), [runId], "control: verdict-less, it reads as running");
    assert.deepEqual(running(records), [], "with its terminal verdict the run is no longer in flight");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4701: a node_modules deferral writes its verdict and daemon.ts still reads the thrown error as a deferral", async () => {
  const fx = buildFixture("lockfile-drift");
  try {
    const o = await dispatch(fx);
    assert.ok(o.err instanceof WorktreeNodeModulesRefusedError, `got: ${String(o.err)}`);
    assert.ok(readsAsDeferral(o.err), "the blocked_toolchain tag isSpawnInfraBlocked reads is intact");
    assertOneTerminalVerdict(o, "worktree.node_modules_refused", "worktree.node_modules");
    assert.ok(o.reserver.calls.includes(`drop:${TASK_ID}:t4701-anchor`));
  } finally {
    fx.cleanup();
  }
});

test("W1-T4701: a worktree add that fails writes one worktree.add verdict and rethrows the add failure", async () => {
  const fx = buildFixture("origin-unreachable");
  try {
    const o = await dispatch(fx);
    assert.ok(o.err instanceof Error, `got: ${String(o.err)}`);
    assert.equal(readsAsDeferral(o.err), false, "an add failure was never a deferral and still is not");
    const failed = o.ledger.find((row) => row.step === "worktree.add_failed");
    assert.equal(failed?.error, (o.err as Error).message);
    assertOneTerminalVerdict(o, "worktree.add_failed", "worktree.add");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4701: a capacity-blocked preflight probe writes one verdict naming the probe and still defers", async () => {
  for (const probe of ["containment", "isolation"] as const) {
    const fx = buildFixture("plain");
    try {
      const blocked = new ProviderCapacityBlockedError([]);
      const o = await dispatch(fx, probe === "containment"
        ? { containmentExec: () => Promise.reject(blocked) }
        : { isolationExec: () => Promise.reject(blocked) });
      assert.equal(o.err, blocked, "the SAME error object reaches the caller");
      assert.ok(readsAsDeferral(o.err));
      const site = probe === "containment" ? "settings.validated" : "containment.probe";
      assertOneTerminalVerdict(o, site, `preflight.${probe}`);
      assert.equal(o.ledger.find((row) => row.step === "dispatch.claim"), undefined, "refused before any claim is taken");
    } finally {
      fx.cleanup();
    }
  }
});

test("W1-T4701: the terminal-row writer writes nothing for a run that already ended and never throws on a ledger failure", () => {
  const rows: Array<{ step: string; extra?: Row }> = [];
  const log = (step: string, extra?: Row) => void rows.push({ step, extra });
  endThrownRun(log, true, "managed_checkout.refresh", new Error("fixture"), 0);
  assert.equal(rows.length, 0, "a run that already wrote its verdict gets no second one");
  endThrownRun(log, false, "worktree.add", new Error("https://x-access-token:ghs_secret@github.com/acme/r.git refused"), 0.5);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { stage: rows[0]?.extra?.stage, cost: rows[0]?.extra?.cost_usd, secret: String(rows[0]?.extra?.reason).includes("ghs_secret") },
    { stage: "worktree.add", cost: 0.5, secret: false },
    "the reason is credential-scrubbed",
  );
  assert.doesNotThrow(() => endThrownRun(() => { throw new Error("ledger append failed"); }, false, "worktree.add", new Error("x"), 0));
});

test("W1-T4701: the deferral verdicts leave status.ts's environmental re-offer latch where the verdict-less runs left it", () => {
  assert.deepEqual(
    ["managed_checkout.refresh", "worktree.node_modules", "worktree.add", "preflight.containment", "preflight.isolation"].filter((s) => !THROWN_RUN_VERDICT_STAGES.has(s)),
    [],
    "every pre-worktree stage is a thrown-run stage",
  );
  const rows: Row[] = [];
  const block = (runId: string, ts: string) =>
    rows.push(
      { task_id: TASK_ID, run_id: runId, step: "run.start", ts },
      { task_id: TASK_ID, run_id: runId, step: "verdict", verdict: "blocked_transient", ts },
      { task_id: TASK_ID, run_id: runId, step: "dispatch.blocked_independent", verdict: "blocked_transient", ts },
    );
  const deferred = (runId: string, ts: string, stage: string, withVerdict: boolean) =>
    rows.push(
      { task_id: TASK_ID, run_id: runId, step: "run.start", ts },
      { task_id: TASK_ID, run_id: runId, step: "managed_checkout.refresh_refused", reason: "x", ts },
      ...(withVerdict ? [{ task_id: TASK_ID, run_id: runId, step: "verdict", verdict: "failed", stage, ts }] : []),
    );
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (minutes: number) => new Date(baseMs + minutes * 60_000).toISOString();
  for (const stage of ["managed_checkout.refresh", "worktree.node_modules", "worktree.add", "preflight.containment", "preflight.isolation"]) {
    const latch = (withVerdict: boolean): boolean => {
      rows.length = 0;
      block("a", at(0));
      deferred("b", at(10), stage, withVerdict);
      block("c", at(20));
      deferred("d", at(30), stage, withVerdict);
      block("e", at(40));
      return latestIndependentFailureBlock(rows, TASK_ID, undefined, baseMs + 86_400_000);
    };
    assert.equal(latch(false), true, `${stage}: three environmental blocks stay durable on the pre-W1-T4701 ledger`);
    assert.equal(latch(true), latch(false), `${stage}: the new verdict rows must not reset that streak`);
  }
});
