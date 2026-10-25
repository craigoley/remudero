import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixRungDispatchArgs, runFixRung } from "./run-task-test.js";
import type { Config } from "../../src/lib/config.js";
import type { CriterionVerdict } from "../../src/lib/review.js";
import type { WorkerResult } from "../../src/lib/worker.js";

export const headSha = "a".repeat(40);
export const prUrl = "https://github.com/acme/remudero/pull/1";
export const criteria: CriterionVerdict[] = [
  { claim: "already met", proof: "first proof", met: true, reason: "", proof_exec: "executed_pass" },
  { claim: "hidden claim", proof: "hidden proof", met: false, holdout: true, reason: "hidden reason", proof_exec: "executed_fail" },
  { claim: "wire producer", proof: "third proof", met: false, reason: "consumer disconnected", proof_exec: "executed_fail" },
  { claim: "keep all unmet", proof: "fourth proof", met: false, reason: "second gap", proof_exec: "executed_fail" },
];
export const task = { id: "W1-T5019", title: "return findings", files: ["src/changed.ts"], acceptance: criteria };
const mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };

/**
 * Drives one fix round against ledger `rows` and returns the single worker prompt it rendered.
 *
 * Every judge the rung would otherwise build from the live checkout (the escalation judge reads the
 * repo's mounts file; the progress judge is the former-bound stand-in) is injected, so the round can
 * only reach the worker spawn and never exits early on ambient repo or machine state.
 */
export async function promptFrom(
  rows: Array<Record<string, unknown>>, sweep: boolean, head = headSha, contract = task,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "rmd-finding-fix-"));
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const initialReview = {
    state: "failure" as const, criteria, testTheater: false, summary: "two visible gaps",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: head, reviewerOutcome: "success",
  };
  const base = {
    task: contract, runId: "finding-fix", prUrl, branch: "run-W1-T5019-1791151948510",
    worktreePath: root, mount, settingsFile: join(root, "settings.json"), config: {} as Config,
    budgetUsd: 1, strikeCap: 1,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver" as const, reason: "fixture" }),
  };
  const opts = sweep
    ? buildFixRungDispatchArgs({
        ...base, pr: { headSha: head },
        evidence: { unmetCriteria: criteria.filter((c) => !c.met && !c.holdout).map((c) => ({ ...c, proof: "" })) },
      })
    : { ...base, taskId: task.id, initialSessionId: "", initialReview };
  const prompts: string[] = [];
  try {
    await runFixRung({
      ...opts,
      escalationJudge: base.escalationJudge,
      deps: {
        ledgerLines: sweep ? undefined : () => rows, ledgerPath,
        spawn: async (args) => {
          prompts.push(args.prompt);
          return {
            sessionId: "fix", costUsd: 0, numTurns: 1, text: "fixed", blocks: [], stderr: "",
            subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
            model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            modelUsage: {}, compactionEvents: [], qualitySuspect: false,
          } satisfies WorkerResult;
        },
        waitForCiGreen: async () => "green",
        runReview: async () => ({ ...initialReview, state: "success", criteria: criteria.map((c) => ({ ...c, met: true })), headSha: "d".repeat(40) }),
        push: () => {}, fetchPrBody: async () => "implemented", fetchPrDiffFiles: async () => task.files,
        issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
        log: () => {}, say: () => {}, account: (worker) => worker,
      },
    });
    assert.equal(prompts.length, 1, "both unmet criteria are repaired in one worker pass");
    return prompts[0]!;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
