import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { daemonCommand } from "../src/run-task.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";

function fixtureHome(): { home: string; planPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-nonself-feedback-landing-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return { home, planPath };
}

async function captureDeps(args: string[]): Promise<DaemonDeps> {
  let captured: DaemonDeps | undefined;
  const code = await daemonCommand(args, {
    runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
      captured = deps;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  });
  assert.equal(code, 0);
  assert.ok(captured, "daemonCommand must reach the injected daemon loop");
  return captured;
}

test("W1-T3778 criterion 1: a non-self daemon does not wire the core feedback landing bridge", async () => {
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const deps = await captureDeps(["--repo", "remudero-sandbox", "--plan", planPath, "--max", "0"]);
    assert.equal(deps.sweepFeedbackLanding, undefined, "a foreign-target daemon must not push a core inbox branch or open a PR in the drained repo");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T3778 criterion 2: a self-target daemon wires the existing feedback landing bridge", async () => {
  const { home, planPath } = fixtureHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const deps = await captureDeps(["--allow-self-target", "--plan", planPath, "--max", "0"]);
    assert.equal(typeof deps.sweepFeedbackLanding, "function", "the core daemon remains the owner of its feedback inbox");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
