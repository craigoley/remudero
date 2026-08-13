import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServiceFreshness, daemonFreshnessFromService, type ServiceFreshness } from "../src/lib/self-sync.js";
import { runDaemon, type DaemonDeps, type DaemonSummary, type DaemonFreshness } from "../src/lib/daemon.js";
import { daemonCommand } from "../src/run-task.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";

// ── W1-T126's MISSING PRODUCER ────────────────────────────────────────────────────────────────
//
// The consumer (`daemon.ts`, `deps.checkFreshness?.()`) has existed since 2026 and NOTHING ever
// wrote it: `git log -S` finds zero commits passing it, and the Azure daemon's own ledger carries
// 0 `daemon_selfrestart_for_freshness` rows in 6,838. So the checks below are split deliberately:
// the ADAPTER's truth table, the REMOTE-read proof, the LOOP's two directions, and — the one
// test/daemon-freshness.test.ts could never have — the REAL `daemonCommand` seam. Every existing
// test in that file injects its own `checkFreshness` fake, which is exactly why eight of them
// passed for months against a production path that supplied none.

const CLEAN_BEHIND: ServiceFreshness = {
  status: "assessed",
  dirty: false,
  behind: { oldSha: "a".repeat(40), newSha: "b".repeat(40) },
};

// ── the adapter's truth table ─────────────────────────────────────────────────────────────────

test("adapter, STALE direction: assessed + clean + behind is the ONLY input that asks for a restart", () => {
  const f = daemonFreshnessFromService(CLEAN_BEHIND);
  assert.equal(f.stale, true);
  assert.equal(f.stale && f.oldSha, "a".repeat(40));
  assert.equal(f.stale && f.newSha, "b".repeat(40));
  // runInstall stays unwired: the restart re-enters serviceFreshnessGate, which already runs
  // ensureInstallFresh on every daemon boot. Setting this would double-install, not fix anything.
  assert.equal(f.stale && f.installNeeded, undefined, "installNeeded is never set by this adapter");
});

// THE TRAP THE BRIEF NAMES: a test asserting only that a stale daemon exits passes just as
// happily on a change that exits unconditionally. This is the other direction, at the adapter.
test("adapter, NOT-STALE direction: a caught-up tree is not stale — the falsifier for an unconditional restart", () => {
  const f = daemonFreshnessFromService({ status: "assessed", dirty: false, behind: null });
  assert.equal(f.stale, false, "up to date -> no restart, or the daemon restarts forever");
});

test("adapter: a DIRTY tree that is behind is NOT stale — restarting could not clear it, so it would storm", () => {
  // entrypoint.sh REFUSES to sync a tree with tracked modifications, so the restarted container
  // comes back on the SAME sha and reads the SAME staleness. That is the relaunch storm
  // DaemonStopReason's doc says must never reach an exit.
  const f = daemonFreshnessFromService({ ...CLEAN_BEHIND, dirty: true });
  assert.equal(f.stale, false, "dirty + behind -> report it at boot, never bounce on it");
});

test("adapter: every 'I could not tell' status fails SAFE (no restart) — guarded and degraded alike", () => {
  assert.equal(daemonFreshnessFromService({ status: "guarded" }).stale, false);
  assert.equal(daemonFreshnessFromService({ status: "degraded", reason: "git fetch origin failed" }).stale, false);
});

// ── the REMOTE-read proof (a check comparing a checkout to itself is always fresh) ────────────

function gitFixture(): { originDir: string; localDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-daemon-freshness-"));
  const originDir = join(root, "origin");
  const localDir = join(root, "local");
  mkdirSync(originDir, { recursive: true });
  const git = (dir: string, args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(originDir, ["init", "--quiet", "-b", "main"]);
  git(originDir, ["config", "user.email", "test@example.com"]);
  git(originDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "f.txt"), "one\n");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);
  execFileSync("git", ["clone", "--quiet", originDir, localDir], { encoding: "utf8" });
  git(localDir, ["config", "user.email", "test@example.com"]);
  git(localDir, ["config", "user.name", "Test"]);
  return { originDir, localDir };
}

const headSha = (dir: string): string =>
  execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

test("REMOTE, not the local checkout: a commit pushed to origin alone flips the verdict to stale", () => {
  const { originDir, localDir } = gitFixture();
  // The env must NOT look like CI, or checkServiceFreshness short-circuits to `guarded` and this
  // test would pass while measuring nothing — the vacuous direction.
  const env = { HOME: localDir };
  const localBefore = headSha(localDir);

  assert.equal(
    daemonFreshnessFromService(checkServiceFreshness(localDir, env)).stale,
    false,
    "a fresh clone is level with its origin",
  );

  // Advance ONLY the remote. Nothing touches localDir: no fetch, no checkout, no merge.
  writeFileSync(join(originDir, "f.txt"), "two\n");
  execFileSync("git", ["add", "."], { cwd: originDir });
  execFileSync("git", ["commit", "--quiet", "-m", "second"], { cwd: originDir });
  const originAfter = headSha(originDir);

  const f = daemonFreshnessFromService(checkServiceFreshness(localDir, env));
  assert.equal(f.stale, true, "the check fetched origin and saw the advance");
  assert.equal(f.stale && f.oldSha, localBefore, "oldSha is the LOCAL head, unchanged by the check");
  assert.equal(f.stale && f.newSha, originAfter, "newSha is the REMOTE's new head — read over the wire");
  assert.notEqual(localBefore, originAfter, "control: the two shas really did differ");
  assert.equal(headSha(localDir), localBefore, "the check MUTATED NOTHING — local HEAD did not move");
  rmSync(join(localDir, ".."), { recursive: true, force: true });
});

test("REMOTE control: with the remote NOT advanced, repeated checks stay not-stale (no timer, no drift)", () => {
  const { localDir } = gitFixture();
  const env = { HOME: localDir };
  for (let i = 0; i < 3; i++) {
    assert.equal(daemonFreshnessFromService(checkServiceFreshness(localDir, env)).stale, false);
  }
  rmSync(join(localDir, ".."), { recursive: true, force: true });
});

// ── the LOOP, through the adapter, in both directions ────────────────────────────────────────

const PLAN_YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "daemon-freshness-wiring-plan-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, PLAN_YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({
  taskId: id,
  runId: id + "-run",
  merged: true,
  costUsd: 0,
  verdict: "merged",
});

test("loop, THROUGH THE ADAPTER: a service assessment of clean+behind stops the daemon as stale", async () => {
  const plan = fixturePlan();
  // THE ESCAPE HATCH IS LOAD-BEARING, not tidiness. Without it a regression that made the adapter
  // never return stale would leave this loop spinning forever: the run is KILLED, and a killed
  // `node --test` prints no `# tests` summary at all — a hang reads as an infrastructure problem
  // rather than as this assertion failing. Measured: the first draft of this test did exactly that
  // under the never-stale mutant. `checkStop` is consulted BEFORE freshness each tick, so a broken
  // adapter now stops as `stopped` and fails the assertion below in one line.
  const root = mkdtempSync(join(tmpdir(), "daemon-freshness-wiring-stale-"));
  let ticks = 0;
  const s = await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id) => okResult(id),
    sleep: async () => {},
    checkStop: () => (++ticks >= 4 ? (requestStop(root, "escape hatch"), stopDetail(root)) : undefined),
    checkFreshness: () => daemonFreshnessFromService(CLEAN_BEHIND),
  });
  assert.equal(s.stopReason, "stale", "behind origin -> the loop asks for a restart, and does so on tick 1");
  assert.ok(ticks <= 1, `freshness wins immediately; it must not take ${ticks} ticks to notice`);
  rmSync(root, { recursive: true, force: true });
});

test("loop, THROUGH THE ADAPTER: a NOT-behind assessment never stops as stale, across many polls", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-freshness-wiring-fresh-"));
  const lines: string[] = [];
  let ticks = 0;
  let calls = 0;
  const s = await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id) => okResult(id),
    sleep: async () => {},
    log: (step) => lines.push(step),
    checkFreshness: () => {
      calls += 1;
      return daemonFreshnessFromService({ status: "assessed", dirty: false, behind: null });
    },
    checkStop: () => (++ticks >= 5 ? (requestStop(root, "test done"), stopDetail(root)) : undefined),
  });
  assert.equal(s.stopReason, "stopped", "a current daemon runs on — it does not restart");
  assert.ok(calls >= 3, `the adapter really was consulted each tick (got ${calls})`);
  assert.equal(lines.filter((l) => l === "daemon_selfrestart_for_freshness").length, 0);
  rmSync(root, { recursive: true, force: true });
});

// ── THE IDLE GATE (Q2): the check can never interrupt a live dispatch ─────────────────────────

test("IDLE GATE: origin advancing DURING a dispatch never interrupts it — the worker reaches its verdict first", async () => {
  const plan = fixturePlan();
  const order: string[] = [];
  let advanced = false;
  // Same escape hatch, same reason as the stale-direction test above: a regression must FAIL here,
  // never hang. checkStop runs before freshness, so a broken adapter stops as `stopped`.
  const root = mkdtempSync(join(tmpdir(), "daemon-freshness-wiring-idle-"));
  let ticks = 0;
  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    checkStop: () => (++ticks >= 4 ? (requestStop(root, "escape hatch"), stopDetail(root)) : undefined),
    runOne: async (id) => {
      order.push("runOne:start");
      // origin/main moves WHILE the worker is in flight — the exact race the brief asks about.
      advanced = true;
      await new Promise((r) => setTimeout(r, 5));
      order.push("runOne:end");
      return okResult(id);
    },
    sleep: async () => {},
    log: (step) => order.push(`log:${step}`),
    checkFreshness: (): DaemonFreshness =>
      daemonFreshnessFromService(advanced ? CLEAN_BEHIND : { status: "assessed", dirty: false, behind: null }),
  });
  assert.equal(s.stopReason, "stale", "the advance IS acted on — just not immediately");
  const restart = order.indexOf("log:daemon_selfrestart_for_freshness");
  assert.ok(restart >= 0, "the restart really happened");
  assert.ok(
    order.indexOf("runOne:end") >= 0 && order.indexOf("runOne:end") < restart,
    `the in-flight dispatch completed BEFORE the restart decision — got ${JSON.stringify(order)}`,
  );
  rmSync(root, { recursive: true, force: true });
});
