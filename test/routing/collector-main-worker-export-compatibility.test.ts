import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import test from "node:test";
import * as worker from "#src/lib/worker.js";
import { existsSync } from "node:fs";

test("collector reconciliation keeps terminal held charges attributable through the actual worker imports", async () => {
  assert.ok(existsSync(new URL("src/lib/cash-accounting.ts", __workspaceRootUrl)), "the held-charge implementation must exist before importing its control");
  const { cashAccountingEvidence, recordCashAccounting } = await import("#src/lib/cash-accounting.js");
  const { spendAmountUsd } = await import("#src/lib/spend-rows.js");
  const { terminalVerdictFields } = await import("#src/run-task.js");
  const accounting = cashAccountingEvidence(); recordCashAccounting(accounting, "held", 0.02);
  const result = { sessionId: "fixture", costUsd: 0, numTurns: 1, text: "", blocks: [], stderr: "",
    subtype: "error_during_execution", isError: true, apiError: true, permissionDenials: [], childEnvKeys: [],
    model: "gpt-6-luna", effort: "low", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, provider: "cash", executionTransport: "chat-completions", requestEfforts: [],
    cashAccounting: accounting, compactionEvents: [], qualitySuspect: false,
    tokenUsageState: "partial", budgetReservedUsd: 0.02, budgetHeldUsd: 0.02, budgetSettledUsd: 0 } as worker.WorkerResult;
  const fields = terminalVerdictFields(result);
  for (const [key, value] of Object.entries(worker.workerExecutionLedgerFields(result)))
    assert.deepEqual((fields as Record<string, unknown>)[key], value);
  assert.deepEqual(fields.cash_accounting, accounting);
  assert.equal(fields.budget_held_usd, 0.02);
  assert.equal(fields.spend_role, "restated");
  assert.equal(spendAmountUsd(fields), undefined, "a held charge remains unavailable rather than free");
});
