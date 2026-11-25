// W1-T14710: a run child that settles with an unreadable check-run producer identity ends its own lane, never the
// daemon. OBSERVED 2026-11-24 17:06Z: W1-T14638's run child settled rejected with "workflow producer identity
// incomplete for independent check runs", the daemon stopped with stopReason error, and the container cold-started.
import assert from "node:assert/strict";
import { test } from "node:test";

import { GH_CHECK_IDENTITY_UNREADABLE, runDaemon } from "#src/lib/daemon.js";
import type { MergedSet } from "#src/lib/drain.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { fromRunChildFailure, toRunChildFailure } from "#src/lib/run-child-contract.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";

const NONE_MERGED: MergedSet = () => false;

function twoTaskPlan() {
  return loadPlanFromYaml(["IDENTITY", "SIBLING"].map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""),
  "check-identity.fixture.yaml");
}

/** The error as the daemon sees it after the child wrote it to status.json and the settle loop read it back. */
function settledFromChild(error: Error): Error {
  const settlement = fromRunChildFailure(toRunChildFailure(error));
  assert.equal(settlement.kind, "error");
  return settlement.error;
}

async function runWith(failure: Error) {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const summary = await runDaemon(twoTaskPlan(), {
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => {
      calls.push(id);
      if (id === "IDENTITY") throw failure;
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    sleep: async () => {},
    log: (step, extra = {}) => rows.push({ step, extra }),
  }, { laneCount: 2, max: 2, pollIntervalMs: 1 });
  return { summary, rows, calls };
}

test("W1-T14710 a run with an unreadable check identity ends its lane and the daemon keeps running", async () => {
  for (const message of ["workflow producer identity incomplete for independent check runs",
    "workflow producer identity response unavailable"]) {
    const failure = settledFromChild(Object.assign(new Error(message), { code: GH_CHECK_IDENTITY_UNREADABLE }));
    const { summary, rows, calls } = await runWith(failure);
    assert.notEqual(summary.stopReason, "error", `${message}: the daemon keeps running`);
    assert.deepEqual(calls.sort(), ["IDENTITY", "SIBLING"], "the sibling lane still ran");
    const readFailed = rows.find((r) => r.step === "daemon.gh_read_failed");
    assert.equal(readFailed?.extra.task, "IDENTITY", JSON.stringify(readFailed));
    assert.match(String(readFailed?.extra.error ?? ""), /workflow producer identity/);
  }
});

test("W1-T14710 an unclassified lane error still stops the daemon", async () => {
  const { summary } = await runWith(settledFromChild(new Error("workflow producer identity incomplete for independent check runs")));
  assert.equal(summary.stopReason, "error", "without the code, a bare Error is still a fatal crash");
});
