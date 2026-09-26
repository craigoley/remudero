// W1-T4582: six /v1/operator-agent/* reads re-parsed every rotated ledger archive on every request
// (W1-T4576's reach census named consequences, context, experiments, promotions, proposals and
// settings). They now read through one rotation memo per state dir and step set. A COMPLETE pass
// parses only the live file; a pass that lacks a rotation answers with a full read and loads the
// rotation off the request, so an answer is never missing rows.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { OPERATOR_AGENT_EXPERIMENT_STEP, readOperatorAgentExperiments, type OperatorAgentExperiment } from "../src/lib/operator-agent.js";
import { CONSOLE_UNBOUNDED_LEDGER_READ_BASELINE } from "../src/lib/serve.js";

const ARCHIVE_MTIME_S = 1_790_000_000;

function experiment(id: string): OperatorAgentExperiment {
  return {
    version: "experiment-v1",
    experimentId: id,
    proposalId: "operator-agent:repo:scale:queue-pressure",
    hypothesis: "Increasing the worker pool will reduce queue latency for the repository's worker tasks.",
    intervention: {
      summary: "Increase the worker pool from 2 to 4 for one observation window.",
      plan: "Apply the scoped worker-pool setting and restore it if the regression guard fires.",
      taskId: "W1-T3853",
      prUrl: "https://github.com/craigoley/remudero/pull/6221",
    },
    scope: { repo: "owner/repo", taskType: "worker", lane: "main", evidenceAnchors: ["ledger:queue-latency"] },
    baseline: {
      metricName: "queue_latency_p50",
      value: 8,
      unit: "minutes",
      denominator: 20,
      comparisonPopulation: "owner/repo worker tasks on main",
      windowStart: "2026-09-18T10:00:00.000Z",
      windowEnd: "2026-09-20T10:00:00.000Z",
      source: "ledger:queue-latency",
      freshness: "verified",
    },
    rollback: {
      plan: "Restore worker pool size to 2 and record the deployment receipt.",
      reason: "Rollback if queue latency or task failure rate regresses.",
      receipt: "change:worker-pool-restore",
    },
    createdAt: "2026-09-20T10:00:00.000Z",
    state: "proposed",
  };
}

function archive(stateDir: string, name: string, id: string): string {
  const path = join(stateDir, name);
  writeFileSync(path, gzipSync(`${JSON.stringify({ step: OPERATOR_AGENT_EXPERIMENT_STEP, experiment: experiment(id) })}\n`));
  utimesSync(path, ARCHIVE_MTIME_S, ARCHIVE_MTIME_S);
  return path;
}

const ids = (ledgerPath: string): string[] => readOperatorAgentExperiments({ ledgerPath }).map((e) => e.experimentId).sort();
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));

test("W1-T4582: a warm operator-agent read answers from the memo, not by re-opening the archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t4582-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  try {
    const path = archive(stateDir, "ledger.2026-09-19T00-00-00-000Z.ndjson.gz", "experiment:repo:archived");
    assert.deepEqual(ids(ledgerPath), ["experiment:repo:archived"], "the cold read is complete");
    await settle(); // the memo loads the rotation off the request

    // Same length, same mtime, unreadable bytes: only a read that re-opens the archive can notice.
    const before = statSync(path);
    writeFileSync(path, Buffer.alloc(before.size, 0x21));
    utimesSync(path, ARCHIVE_MTIME_S, ARCHIVE_MTIME_S);
    assert.deepEqual(ids(ledgerPath), ["experiment:repo:archived"], "the warm read is answered from the memo");

    // A rotation written later is never missed: the pass lacks it, so that read is a full one.
    archive(stateDir, "ledger.2026-09-20T00-00-00-000Z.ndjson.gz", "experiment:repo:newer");
    assert.ok(ids(ledgerPath).includes("experiment:repo:newer"), "a new rotation is read the first time it is seen");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4582: no operator-agent read route is left in the unbounded-read baseline", () => {
  assert.deepEqual(CONSOLE_UNBOUNDED_LEDGER_READ_BASELINE.filter((route) => route.startsWith("GET /v1/operator-agent/")), []);
});
