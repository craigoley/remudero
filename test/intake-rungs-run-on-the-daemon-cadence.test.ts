import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { appendLedger } from "../src/lib/ledger.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { loadPolicy, policyPath, type Policy } from "../src/lib/policy.js";
import { buildIntakeRungsDaemonHooks, ledgerPathFor } from "../src/run-task.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const NOW = new Date("2026-09-10T12:00:00.000Z");

function fixture(): { root: string; planPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "rmd-intake-rungs-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return { root, planPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function policyWithIssues(enabled: boolean): Policy {
  const shipped = loadPolicy(policyPath(REPO_ROOT));
  return {
    ...shipped,
    values: {
      ...shipped.values,
      intakeCadence: {
        ...shipped.values.intakeCadence,
        issues: { enabled, minIntervalMinutes: 60, maxPerDay: 4 },
      },
    },
  };
}

async function runTwoIntakeTicks(root: string, planPath: string, deps: Pick<DaemonDeps, "checkIntakeRungs" | "runIntakeRung">) {
  let stopChecks = 0;
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDaemon(loadPlan(planPath), {
    refreshMerged: () => () => true,
    runOne: async () => {
      throw new Error("empty plan must never dispatch");
    },
    checkStop: () => {
      stopChecks++;
      return stopChecks > 2 ? "bound" : undefined;
    },
    sleep: async () => {},
    log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
    ...deps,
  });
  return lines;
}

test("one daemon tick polls issues when enabled, and the next tick inside the interval runs nothing", async () => {
  const disabled = fixture();
  try {
    let disabledPolls = 0;
    const disabledHooks = buildIntakeRungsDaemonHooks({
      config: { root: disabled.root, claudeBin: "/bin/true" },
      now: () => NOW,
      policy: policyWithIssues(false),
      loadManagedRepos: () => [{ owner: "acme", repo: "app" }],
      pollIssues: async () => {
        disabledPolls++;
        throw new Error("disabled issues rung must not poll");
      },
    });
    await runTwoIntakeTicks(disabled.root, disabled.planPath, disabledHooks);
    assert.equal(disabledPolls, 0, "disabled policy is the control: no issue poll runs");
    assert.equal(readLedgerRows(ledgerPathFor({ root: disabled.root, claudeBin: "/bin/true" })).length, 0);
  } finally {
    disabled.cleanup();
  }

  const enabled = fixture();
  try {
    let polls = 0;
    const hooks = buildIntakeRungsDaemonHooks({
      config: { root: enabled.root, claudeBin: "/bin/true" },
      now: () => NOW,
      policy: policyWithIssues(true),
      loadManagedRepos: () => [{ owner: "acme", repo: "app" }],
      pollIssues: async (managed, deps) => {
        polls++;
        const summary = {
          polledAt: NOW.toISOString(),
          repos: managed.map((r) => `${r.owner}/${r.repo}`),
          reviewedCount: 1,
          createdCount: 0,
        };
        appendLedger(deps.ledgerPath, {
          run_id: deps.runId,
          task_id: "ISSUES",
          step: "issues.polled",
          issues: summary,
        });
        return { summary, newIssues: [], created: [], skippedExisting: 0 };
      },
    });

    const lines = await runTwoIntakeTicks(enabled.root, enabled.planPath, hooks);
    const ledgerRows = readLedgerRows(ledgerPathFor({ root: enabled.root, claudeBin: "/bin/true" }));

    assert.equal(polls, 1, "the marker-first cadence blocks the immediate second tick");
    assert.equal(ledgerRows.filter((r) => r.step === "issues.polled").length, 1, "the issue poll ran from the daemon");
    assert.ok(lines.some((l) => l.step === "intake_cadence.fired" && l.extra.rung === "issues"));
    assert.ok(
      lines.some(
        (l) => l.step === "intake_cadence.skipped" && l.extra.rung === "issues" && String(l.extra.reason).includes("minInterval"),
      ),
      "the second tick names the interval refusal",
    );
  } finally {
    enabled.cleanup();
  }
});

function readLedgerRows(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}
