import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPlanFromYaml } from "../src/lib/plan.js";
// A NAMESPACE import: at the merge base `independentQueueGateway` does not exist, and a named import would fail the
// whole file at load, which the reviewer reads as "never ran" rather than as a red.
import * as agreement from "../src/lib/reader-agreement.js";
import type { GitHub } from "../src/lib/status.js";
import { ghShim } from "./helpers/gh-shim.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

/**
 * W1-T6246 — THE READER-AGREEMENT CHECK PROJECTS THE PLAN OFF THE DAEMON LOOP. Its independent queue figure built a
 * fresh gateway every sweep pass and ran projectPlan over it, so every pass walked GitHub with synchronous, paced gh
 * calls on the daemon thread: one unbroken 89.6 s block in a live CPU profile (2026-10-07).
 *
 * FIXTURES ONLY: the ledger, the status cache and a gh stand-in that sleeps all live in throwaway directories.
 */

const GH_SLEEP_S = 3;
const figures: agreement.ReaderFigures = { dispatchStreaks: {}, queuedTaskCount: 1, healthyDeploys: {} };

function corpus(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t6246-agreement-"));
  writeFileSync(join(dir, "ledger.ndjson"), `${JSON.stringify({ task_id: "W1-T1", run_id: "r", step: "run.start", ts: "2026-10-07T10:00:00.000Z" })}\n`);
  writeFileSync(join(dir, "status.json"), JSON.stringify({ tasks: { a: { status: "queued" } } }));
  return { dir, path: join(dir, "ledger.ndjson") };
}

test("W1-T6246: the independent queue figure reaches no synchronous gh call on the loop", async () => {
  const { path } = corpus();
  // A gh that answers only after GH_SLEEP_S: a synchronous call on this thread would hold the check that long.
  const shim = ghShim([{ when: "", stdout: "[]", delaySeconds: GH_SLEEP_S }]);
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath}`;
  try {
    const started = performance.now();
    const findings = await agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t6246",
      owner: "t6246-owner", repo: `t6246-repo-${process.pid}`, plan: loadPlanFromYaml("[]\n", "fixture"),
      boardReader: () => figures, appendLine: () => {} });
    const elapsedMs = performance.now() - started;
    assertWallClockBound(elapsedMs, (GH_SLEEP_S * 1000) / 2, `the check waited ${Math.round(elapsedMs)} ms on gh`);
    assert.deepEqual(findings.filter((f) => f.figure === "queued_task_count"), [], "a cold gateway's figure is absent, not compared");
    assert.equal(agreement.independentQueueGateway("t6246-owner", `t6246-repo-${process.pid}`).warmsOffLoop?.(), true,
      "the default gateway refreshes on a worker thread");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("W1-T6246: an unready independent queue figure is absent, never stale", async () => {
  const { path } = corpus();
  let warmed = 0;
  const untouchable = () => { throw new Error("an unready gateway's facts must not be projected"); };
  const notReady = {
    warm: () => void warmed++, factsStale: () => true, readFailed: () => false,
    listOpenHeadBranches: untouchable, listMergedHeadBranches: untouchable,
  } as unknown as GitHub;
  const findings = await agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t6246",
    owner: "owner", repo: "repo", plan: loadPlanFromYaml("[]\n", "fixture"), queueGithub: () => notReady,
    boardReader: () => figures, appendLine: () => {} });
  assert.equal(warmed, 1, "the pass asks the gateway to refresh");
  assert.deepEqual(findings.filter((f) => f.figure === "queued_task_count"), [], "no stale or partial figure is compared");
});
