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

function taskYaml(ids: string[], titles: Readonly<Record<string, string>> = {}): string {
  return ids
    .map(
      (id) =>
        `- id: ${id}\n  title: ${titles[id] ?? `task ${id}`}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`,
    )
    .join("");
}

function planOnDisk(ids: string[], titles: Readonly<Record<string, string>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}blocked-plan-reload-`));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, taskYaml(ids, titles));
  return {
    plan: () => loadPlan(file),
    rewrite: (next: string[], nextTitles: Readonly<Record<string, string>> = {}) =>
      writeFileSync(file, taskYaml(next, nextTitles)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("W1-T3565 preserves paid independent block across reload", async () => {
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

test("W1-T3565 releases legacy illformed block after reload", async () => {
  const p = planOnDisk(["A"]);
  const ledgerRows: Record<string, unknown>[] = [
    { step: "dispatch.blocked_independent", task_id: "A", task: "A", verdict: "blocked_illformed" },
  ];
  const ran: string[] = [];
  try {
    const statusOf = (id: string) =>
      deriveStatus(p.plan().byId.get(id)!, {
        ledgerPath: "unused",
        github: OFFLINE_GITHUB,
        readLedger: () => ledgerRows,
      });

    assert.equal(statusOf("A").independentFailureBlocked, undefined, "the legacy row is retained but is not a durable block");

    const summary = await runDaemon(
      p.plan(),
      {
        refreshMerged: () => () => false,
        isIndependentFailureBlocked: (id) => statusOf(id).independentFailureBlocked === true,
        runOne: async (id): Promise<RunResult> => {
          ran.push(id);
          return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.1, verdict: "merged" };
        },
        sleep: async () => {},
        log: (step, extra = {}) => {
          ledgerRows.push({ step, ...extra });
        },
      },
      { max: 1 },
    );

    assert.deepEqual(ran, ["A"], "the corrected task is admitted despite its retained historical refusal");
    assert.equal(summary.stopReason, "max_reached");
    assert.ok(
      ledgerRows.some((row) => row.step === "dispatch.blocked_independent" && row.verdict === "blocked_illformed"),
      "the historical admission-refusal row remains available for forensics",
    );
  } finally {
    p.cleanup();
  }
});

test("W1-T3565 prevents illformed retry loop within process", async () => {
  const p = planOnDisk(["A", "B"]);
  const ledgerRows: Record<string, unknown>[] = [];
  const merged = new Set<string>();
  const ran: string[] = [];
  let reloaded = false;
  let stopChecks = 0;
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
        checkStop: () => (++stopChecks > 8 ? "test tick cap" : undefined),
        reloadPlan: () => {
          if (!reloaded && ran.includes("B")) {
            reloaded = true;
            p.rewrite(["A", "B"], { A: "corrected task A" });
            return p.plan();
          }
          return null;
        },
        runOne: async (id): Promise<RunResult> => {
          ran.push(id);
          if (id === "A" && ran.filter((attempt) => attempt === "A").length === 1) {
            return { taskId: id, runId: "A-refused", merged: false, costUsd: 0, verdict: "blocked_illformed" };
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

    assert.equal(reloaded, true, "the task contract changes only after another task can run");
    assert.deepEqual(
      ran,
      ["A", "B", "A"],
      "the unchanged refusal is skipped, then a changed task contract is admitted again without a process restart",
    );
    assert.equal(summary.stopReason, "max_reached");
    assert.ok(
      !ledgerRows.some((row) => row.step === "dispatch.blocked_independent" && row.task_id === "A"),
      "a zero-cost admission refusal does not create a durable independent-failure block",
    );
  } finally {
    p.cleanup();
  }
});
