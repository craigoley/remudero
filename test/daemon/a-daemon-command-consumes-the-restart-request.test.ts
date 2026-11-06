import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { requestRestartInPlace, restartInPlaceFilePath } from "#src/lib/fleet-control.js";
import type { DaemonDeps, DaemonSummary } from "#src/lib/daemon.js";
import { daemonCommand } from "#src/run-task.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("W1-T11327: daemonCommand wires a one-shot restart request stamped with its loaded code sha", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}restart-request-wire-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let captured: DaemonDeps | undefined;
    const summary: DaemonSummary = { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps) => { captured = deps; return summary; },
    });
    assert.equal(code, 0);
    assert.ok(captured, "the command passed DaemonDeps to runDaemon");
    assert.equal(typeof captured.consumeRestartRequest, "function");

    const marker = requestRestartInPlace(root, "progress-watchdog");
    assert.deepEqual(captured.consumeRestartRequest?.(), {
      ...marker,
      codeSha: execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    });
    assert.equal(captured.consumeRestartRequest?.(), null, "the real command wiring consumes the marker once");
    assert.equal(existsSync(restartInPlaceFilePath(root)), false, "the marker is deleted after consumption");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
