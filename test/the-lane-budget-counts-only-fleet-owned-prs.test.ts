import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHub } from "../src/lib/status.js";
import { laneDispatchBudget, type DrainDeps, type DrainSummary } from "../src/lib/drain.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import type { Config } from "../src/lib/config.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { drainCommand, daemonCommand } from "../src/run-task.js";

// MEASURED 2026-10-01 00:11-02:15Z: zero builds started. Every daemon tick logged dispatch.wip_deferred
// at observed_open_count 10-14 while about half the open PRs were operator run-unfiled-*, plan-filing and
// codex/* branches. W1-T4465 split the queue governor's count by ownership; the lane budget still read the
// bare total, so every foreign PR took a fleet lane.

const WIP = DEFAULT_SWEEP_POLICY.wipLimit;

function planOf(n: number): string {
  const dir = makeTempDir("lane-budget-plan");
  const planPath = join(dir, "tasks.yaml");
  const lines = Array.from(
    { length: n },
    (_, i) => `- id: W1-A${i}\n  title: a${i}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  pr: ${i + 1}\n`,
  );
  writeFileSync(planPath, n === 0 ? "[]\n" : lines.join(""));
  return planPath;
}

const OPEN_BOARD: GitHub = {
  prByRef: (ref) => ({ number: Number(ref), url: `https://github.com/o/r/pull/${ref}`, state: "OPEN" }),
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** One fleet build plus `foreign` operator and session PRs, as the 2026-10-01 board looked. */
function mixedBoard(foreign: number): GitHub {
  const heads = ["run-W1-T9001-1721400000000"];
  for (let i = 0; i < foreign; i++) heads.push(i % 3 === 0 ? `run-unfiled-17914000000${i}` : i % 3 === 1 ? `plan-filing-${i}` : `codex/file-plan-${i}`);
  return {
    ...OPEN_BOARD,
    listOpenHeadBranches: () =>
      heads.map((headRefName, i) => ({ number: 20_000 + i, url: `https://github.com/o/r/pull/${20_000 + i}`, state: "OPEN", headRefName })),
  };
}

async function drainDeps(board: GitHub, planPath: string): Promise<{ deps: DrainDeps; root: string }> {
  const config = { claudeBin: "/bin/true", root: makeTempDir("lane-budget-drain") } as Config;
  let captured: DrainDeps | undefined;
  const code = await drainCommand([], {
    config,
    planPath,
    skipGitSync: true,
    githubFactory: () => board,
    notifyChannel: { send: () => true } as never,
    runDrain: async (_plan, deps): Promise<DrainSummary> => {
      deps.refreshMerged();
      captured = deps;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" };
    },
  });
  assert.equal(code, 0);
  assert.ok(captured);
  return { deps: captured, root: config.root };
}

async function daemonDeps(board: GitHub, planPath: string): Promise<DaemonDeps> {
  const home = makeTempDir("lane-budget-daemon");
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      githubFactory: () => board,
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        deps.refreshMerged();
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured);
    return captured;
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("W1-T5046: foreign open PRs do not consume the lane budget", async () => {
  const board = mixedBoard(WIP + 3);
  const { deps: drain, root } = await drainDeps(board, planOf(0));
  try {
    assert.equal(drain.openPrCount!(), 1, "drain's lane budget counts only the one fleet build");
    assert.equal(laneDispatchBudget({ laneCount: 2, wipLimit: WIP, openPrCount: drain.openPrCount!() }), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const daemon = await daemonDeps(board, planOf(0));
  assert.equal(daemon.openPrCount!(), 1, "the daemon's lane budget counts only the one fleet build");
  assert.equal(laneDispatchBudget({ laneCount: 2, wipLimit: WIP, openPrCount: daemon.openPrCount!() }), 2);
});

test("W1-T5046: an unobservable ownership split still counts every open PR", async () => {
  const planPath = planOf(WIP);
  const { deps: drain, root } = await drainDeps(OPEN_BOARD, planPath);
  try {
    assert.equal(drain.openPrCount!(), WIP, "with no head refs every open PR still counts");
    assert.equal(laneDispatchBudget({ laneCount: 2, wipLimit: WIP, openPrCount: drain.openPrCount!() }), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const daemon = await daemonDeps(OPEN_BOARD, planPath);
  assert.equal(daemon.openPrCount!(), WIP);
});
