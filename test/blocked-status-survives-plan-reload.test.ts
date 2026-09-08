import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { deriveStatus, type GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/lib/run-result.js";

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function taskYaml(ids: string[]): string {
  return ids
    .map(
      (id) =>
        `- id: ${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`,
    )
    .join("");
}

function planOnDisk(ids: string[]) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}blocked-plan-reload-`));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, taskYaml(ids));
  return {
    plan: () => loadPlan(file),
    rewrite: (next: string[]) => writeFileSync(file, taskYaml(next)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("W1-T2910: an independent-failure block survives a plan reload and blocks redispatch", async () => {
  const p = planOnDisk(["A", "B"]);
  const ledgerRows: Record<string, unknown>[] = [];
  const merged = new Set<string>();
  const ran: string[] = [];
  let reloaded = false;
  let ticks = 0;
  try {
    const statusOf = (id: string) =>
      deriveStatus(p.plan().byId.get(id)!, {
        ledgerPath: "unused",
        github: OFFLINE_GITHUB,
        readLedger: () => ledgerRows,
      });

    const summary = await runDaemon(
      p.plan(),
      {
        refreshMerged: () => (id) => merged.has(id),
        isIndependentFailureBlocked: (id) => statusOf(id).independentFailureBlocked === true,
        checkStop: () => (++ticks > 8 ? "tick cap" : undefined),
        reloadPlan: () => {
          if (!reloaded && ledgerRows.some((row) => row.step === "dispatch.blocked_independent")) {
            reloaded = true;
            p.rewrite(["A", "B", "C"]);
            return p.plan();
          }
          return null;
        },
        runOne: async (id): Promise<RunResult> => {
          ran.push(id);
          if (id === "A") {
            return {
              taskId: id,
              runId: "A-run",
              merged: false,
              costUsd: 0.2,
              verdict: "blocked_review",
              prUrl: "https://github.com/o/r/pull/2910",
            };
          }
          merged.add(id);
          return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.1, verdict: "merged" };
        },
        sleep: async () => {},
        log: (step, extra = {}) => {
          ledgerRows.push({ step, ...extra });
        },
      },
      { max: 3 },
    );

    assert.equal(reloaded, true, "the test must replace the plan with fresh queued Task objects");
    assert.deepEqual(ran, ["A", "B", "C"], "A must not dispatch again after the reload");
    assert.equal(summary.stopReason, "max_reached");
    assert.equal(p.plan().byId.get("A")?.status, "queued", "the reloaded plan object never carries an in-memory block");
    assert.equal(statusOf("A").status, "blocked", "deriveStatus reconstructs the block from the ledger row");
    assert.equal(statusOf("A").independentFailureBlocked, true);
    assert.ok(
      ledgerRows.some((row) => row.step === "dispatch.blocked_independent" && row.task_id === "A"),
      "the independent failure is persisted as the dispatch.blocked_independent ledger row",
    );
  } finally {
    p.cleanup();
  }
});
