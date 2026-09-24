import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SWEEP_POLICY,
  checkQueueGovernor,
  deriveQueueGovernorTrailingFlow,
  isFleetOwnedRunBranch,
  logQueueGovernorDeferral,
  type SweepPolicy,
} from "../src/lib/sweep.js";
import { readLedgerLines, type GitHub } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";
import { drainCommand, daemonCommand } from "../src/run-task.js";
import type { DrainDeps, DrainSummary } from "../src/lib/drain.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import type { Config } from "../src/lib/config.js";

// ── W1-T4465 — THE QUEUE GOVERNOR HELD ALL DISPATCH FOR 2.7 HOURS WHILE THE QUEUE WAS DRAINING ──
//
// OBSERVED 2026-09-24: `checkQueueGovernor` deferred every new task at wipLimit (10) open PRs while
// 4-7 of those were `run-unfiled-*` operator-session branches the fleet neither authored nor could
// throttle, and while the trailing hour had 11 merges against 8 opens (the queue was DRAINING). A
// bare count cannot tell a draining queue from a growing one, and cannot tell the fleet's own WIP
// from an operator's. This suite proves the fix: ADMIT BY OWNERSHIP AND FLOW.

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-queue-governor-flow-")), "ledger.ndjson");
}

const AT_LIMIT_POLICY: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 10 };

// ── acceptance 1: ownership — a PR the fleet did not author does not hold dispatch ───────────

test("W1-T4465: an open pull request the fleet did not author does not hold dispatch", () => {
  // isFleetOwnedRunBranch itself: the exact incident branch shape reads NOT fleet-owned, while a
  // real dispatched run's own branch, and each orchestrator lane, read fleet-owned.
  assert.equal(isFleetOwnedRunBranch("run-unfiled-1758714000000"), false, "an operator's own run-unfiled-* session is not the fleet's");
  assert.equal(isFleetOwnedRunBranch("fix/some-human-branch"), false, "a non-run-shaped head is not the fleet's either");
  assert.equal(isFleetOwnedRunBranch("run-W1-T4465-1758714000000"), true, "a dispatched run's own branch for a real filed task IS the fleet's");
  assert.equal(isFleetOwnedRunBranch("run-RETRO-1758714000000"), true, "the RETRO orchestrator lane IS the fleet's");
  assert.equal(isFleetOwnedRunBranch("run-PLAN-fb-1758714000000"), true, "the PLAN orchestrator lane IS the fleet's");
  assert.equal(isFleetOwnedRunBranch(undefined), true, "an UNRESOLVABLE head fails CLOSED (still gates), never silently drops out");

  // checkQueueGovernor: an owned count under the limit is NOT deferred, no matter how many
  // foreign PRs sit alongside it — the exact incident: 4-7 of 10-16 open PRs were run-unfiled-*.
  const owned = 6; // under AT_LIMIT_POLICY.wipLimit (10)
  const foreign = 8; // owned + foreign = 14, well OVER the limit if counted as a bare total
  const result = checkQueueGovernor(owned, AT_LIMIT_POLICY, { foreignOpenCount: foreign });
  assert.equal(result.deferred, false, "6 fleet-owned PRs, under the limit, must not be held back by 8 foreign PRs the fleet cannot throttle");
  assert.equal(result.observedOpenCount, 6, "the governed count is the OWNED count, never owned+foreign");
  assert.equal(result.observedForeignCount, 8, "the foreign count is still carried for ledger transparency (design iii)");
  assert.equal(result.tier, "under_limit");

  // The falsifier's own converse: a bare total that ignores ownership (owned+foreign, both simply
  // "open") WOULD defer at this same limit — proving the fix is ownership, not a laxer threshold.
  const bareTotal = checkQueueGovernor(owned + foreign, AT_LIMIT_POLICY);
  assert.equal(bareTotal.deferred, true, "counting every open PR without the ownership split would incorrectly hold this dispatch");
});

// ── acceptance 2: flow, tiered — draining admits ONE lane ────────────────────────────────────

test("W1-T4465: a queue over its limit that is draining admits one lane", () => {
  // The incident's own trailing-hour reading: 11 merges against 8 opens.
  const result = checkQueueGovernor(AT_LIMIT_POLICY.wipLimit, AT_LIMIT_POLICY, {
    trailingMergedCount: 11,
    trailingOpenedCount: 8,
  });
  assert.equal(result.tier, "draining");
  assert.equal(result.deferred, false, "merges outpacing opens at the limit must admit one lane, not zero");
  assert.equal(result.trailingMergedCount, 11);
  assert.equal(result.trailingOpenedCount, 8);

  // Equal flow (merges == opens) is still draining — "merges >= opens" per design (ii).
  const equalFlow = checkQueueGovernor(AT_LIMIT_POLICY.wipLimit, AT_LIMIT_POLICY, {
    trailingMergedCount: 4,
    trailingOpenedCount: 4,
  });
  assert.equal(equalFlow.tier, "draining");
  assert.equal(equalFlow.deferred, false);

  // ABOVE the limit, draining flow still admits — the ceiling itself is not what moved.
  const aboveLimit = checkQueueGovernor(AT_LIMIT_POLICY.wipLimit + 3, AT_LIMIT_POLICY, {
    trailingMergedCount: 5,
    trailingOpenedCount: 1,
  });
  assert.equal(aboveLimit.tier, "draining");
  assert.equal(aboveLimit.deferred, false);
});

// ── acceptance 3: flow, tiered — growing still defers ────────────────────────────────────────

test("W1-T4465: a queue over its limit that is growing still defers", () => {
  const result = checkQueueGovernor(AT_LIMIT_POLICY.wipLimit, AT_LIMIT_POLICY, {
    trailingMergedCount: 3,
    trailingOpenedCount: 5,
  });
  assert.equal(result.tier, "growing");
  assert.equal(result.deferred, true, "opens outpacing merges at the limit must still defer, exactly as before this task");

  // The falsifier: a caller that supplies no trailing flow at all (every pre-W1-T4465 call in
  // test/queue-governor.test.ts) keeps the EXACT prior always-defer answer — "count every open PR
  // and ignore the trailing merges, and the draining-queue test finds zero lanes admitted."
  const noFlowSupplied = checkQueueGovernor(AT_LIMIT_POLICY.wipLimit, AT_LIMIT_POLICY);
  assert.equal(noFlowSupplied.tier, "growing");
  assert.equal(noFlowSupplied.deferred, true);

  // A silent window — zero merges AND zero opens — is degenerate, not draining: 0 >= 0 must not
  // vacuously admit a lane on a freshly-initialized state with no ledger history yet.
  const silentWindow = checkQueueGovernor(AT_LIMIT_POLICY.wipLimit, AT_LIMIT_POLICY, {
    trailingMergedCount: 0,
    trailingOpenedCount: 0,
  });
  assert.equal(silentWindow.tier, "growing");
  assert.equal(silentWindow.deferred, true);

  // Under the limit, flow is irrelevant — growth alone never defers a queue that isn't full.
  const underLimit = checkQueueGovernor(AT_LIMIT_POLICY.wipLimit - 1, AT_LIMIT_POLICY, {
    trailingMergedCount: 0,
    trailingOpenedCount: 20,
  });
  assert.equal(underLimit.tier, "under_limit");
  assert.equal(underLimit.deferred, false);
});

// ── design (iii): the ledger row names WHY a held daemon is held and which way the queue moves ──

test("W1-T4465: the dispatch_deferred_wip ledger line carries the tier, the owned/foreign split, and the trailing flow", () => {
  const path = ledgerPath();
  const result = checkQueueGovernor(AT_LIMIT_POLICY.wipLimit, AT_LIMIT_POLICY, {
    foreignOpenCount: 3,
    trailingMergedCount: 2,
    trailingOpenedCount: 5,
  });
  assert.equal(result.deferred, true);
  logQueueGovernorDeferral(result, appendLedger, path, "DAEMON-1");
  const lines = readLedgerLines(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "dispatch_deferred_wip");
  assert.equal(lines[0].observed_open_count, AT_LIMIT_POLICY.wipLimit);
  assert.equal(lines[0].wip_limit, AT_LIMIT_POLICY.wipLimit);
  assert.equal(lines[0].observed_foreign_count, 3);
  assert.equal(lines[0].tier, "growing");
  assert.equal(lines[0].trailing_merged_count, 2);
  assert.equal(lines[0].trailing_opened_count, 5);
});

// ── deriveQueueGovernorTrailingFlow: the pure ledger-window reduction (design ii) ────────────

const WINDOW_POLICY: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, queueGovernorFlowWindowMinutes: 60 };
const NOW_MS = Date.parse("2026-09-24T13:22:00Z"); // the incident's own "trailing hour" reading
const INSIDE = "2026-09-24T13:00:00Z";
const OUTSIDE = "2026-09-24T11:00:00Z"; // more than 60 minutes before NOW_MS

test("W1-T4465: deriveQueueGovernorTrailingFlow counts merges and opens inside the trailing window only", () => {
  const lines = [
    { step: "verdict.merged", ts: INSIDE },
    { step: "verdict", verdict: "merged", ts: INSIDE },
    { step: "pr.opened", ts: INSIDE },
    // outside the window — must not count
    { step: "verdict.merged", ts: OUTSIDE },
    { step: "pr.opened", ts: OUTSIDE },
    // unrelated steps — must not count either direction
    { step: "sweep.tick", ts: INSIDE },
    { step: "verdict", verdict: "failed", ts: INSIDE },
  ];
  const flow = deriveQueueGovernorTrailingFlow(lines, NOW_MS, WINDOW_POLICY);
  assert.equal(flow.trailingMergedCount, 2, "both verdict.merged AND verdict{verdict:merged} rows count as a merge");
  assert.equal(flow.trailingOpenedCount, 1);
});

test("W1-T4465: the window is policy data — narrowing queueGovernorFlowWindowMinutes drops an older merge with zero code change", () => {
  const lines = [{ step: "verdict.merged", ts: OUTSIDE }, { step: "pr.opened", ts: OUTSIDE }];
  const wide = deriveQueueGovernorTrailingFlow(lines, NOW_MS, { ...WINDOW_POLICY, queueGovernorFlowWindowMinutes: 180 });
  assert.equal(wide.trailingMergedCount, 1);
  const narrow = deriveQueueGovernorTrailingFlow(lines, NOW_MS, { ...WINDOW_POLICY, queueGovernorFlowWindowMinutes: 60 });
  assert.equal(narrow.trailingMergedCount, 0, "the SAME row, a policy-data window edit away from being outside it");
});

// ── the REAL wiring: drainCommand's checkQueueGovernor admits a fleet-owned-under-limit queue
// even while the complete board is at/over the limit, because the excess is run-unfiled-* ──────

function queueGovernorFixtureConfig(): Config {
  return { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-queue-governor-flow-drain-")) } as Config;
}

function onePlanWithOpenPr(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-queue-governor-flow-plan-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "- id: W1-A0\n  title: a0\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  pr: 1\n");
  return planPath;
}

const OPEN_GITHUB: GitHub = {
  prByRef: (ref) => ({ number: Number(ref), url: `https://github.com/o/r/pull/${ref}`, state: "OPEN" }),
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** A board at/over `wipLimit` in TOTAL, but where most of the excess is a `run-unfiled-*` operator
 *  session the fleet did not author — the exact 2026-09-24 incident shape. */
function boardWithMostlyForeignOpenPrs(wipLimit: number): GitHub {
  return {
    ...OPEN_GITHUB,
    listOpenHeadBranches: () =>
      Array.from({ length: wipLimit + 2 }, (_, i) => ({
        number: 20_000 + i,
        url: `https://github.com/o/r/pull/${20_000 + i}`,
        state: "OPEN",
        // Only 2 of these are fleet-owned; the rest are operator-session run-unfiled-* branches.
        headRefName: i < 2 ? `run-W1-T80${i}-1758714000000` : `run-unfiled-175871400000${i}`,
      })),
  };
}

async function captureDrainDepsWithLiveProjection(config: Config, planPath: string, github: GitHub): Promise<DrainDeps> {
  let captured: DrainDeps | undefined;
  const code = await drainCommand([], {
    config,
    planPath,
    skipGitSync: true,
    githubFactory: () => github,
    notifyChannel: { send: () => true } as never,
    runDrain: async (_plan, deps): Promise<DrainSummary> => {
      deps.refreshMerged();
      captured = deps;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" };
    },
  });
  assert.equal(code, 0);
  assert.ok(captured);
  return captured;
}

test("W1-T4465: drainCommand's WIRED checkQueueGovernor admits dispatch when the excess over wipLimit is run-unfiled-* PRs the fleet did not author", async () => {
  const config = queueGovernorFixtureConfig();
  try {
    const planPath = onePlanWithOpenPr();
    const github = boardWithMostlyForeignOpenPrs(DEFAULT_SWEEP_POLICY.wipLimit);
    const deps = await captureDrainDepsWithLiveProjection(config, planPath, github);
    const result = deps.checkQueueGovernor!();
    assert.equal(
      result,
      undefined,
      "the board is at/over wipLimit in TOTAL, but only 2 of those PRs are fleet-owned — the real wiring must NOT defer",
    );
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

function daemonFixtureHome(): { home: string; root: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-queue-governor-flow-daemon-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return { home, root, planPath };
}

test("W1-T4465: daemonCommand's WIRED checkQueueGovernor also admits by ownership, not a bare board total", async () => {
  const { home, root } = daemonFixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const planPath = onePlanWithOpenPr();
    const github = boardWithMostlyForeignOpenPrs(DEFAULT_SWEEP_POLICY.wipLimit);
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      githubFactory: () => github,
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        deps.refreshMerged();
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured);
    const result = captured!.checkQueueGovernor!();
    assert.equal(result, undefined, "the daemon's real wiring must also admit — only 2 of the board's PRs are fleet-owned");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
