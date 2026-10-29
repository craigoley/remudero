import assert from "node:assert/strict";
import { test } from "node:test";

import { CONFIG_GARDEN_LEDGER_STEPS } from "#src/lib/config-gardener.js";
import { gatherRuns, type LedgerRecord } from "#src/lib/retro.js";

test("W1-T9966: check:test:test/every-priced-ledger-step-is-in-the-config-garden-read.test.ts:flaky is prevented, not retried", () => {
  const fallbackStep = "acceptance.repair.unrepresentable";
  const rows: LedgerRecord[] = [
    { run_id: "worker-1", task_id: "T-1", step: "run.start", type: "implement" },
    { run_id: "worker-1", step: "implement.done", cost_usd: 2, num_turns: 1 },
    { run_id: "worker-1", step: fallbackStep, pr_url: "https://github.com/example/repo/pull/1" },
  ];
  const gathered = gatherRuns(rows);
  assert.equal(gathered.length, 1, "the fixture reaches the unverdicted run fallback");
  assert.equal(gathered[0]?.prUrl, rows[2]?.pr_url);
  assert.equal(gathered[0]?.costUsd, 2);

  const filtered = rows.filter((row) => CONFIG_GARDEN_LEDGER_STEPS.includes(String(row.step)));
  assert.deepEqual(gatherRuns(filtered), gathered, "the gardener's bounded read preserves the run's PR and price");
  assert.notDeepEqual(gatherRuns(rows.filter((row) => row.step !== fallbackStep)), gathered,
    "dropping the fallback row would lose the PR credit");
});
