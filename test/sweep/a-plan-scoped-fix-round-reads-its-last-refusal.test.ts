import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { Plan } from "#src/lib/plan.js";
import { buildSweepEffects, type BuildSweepEffectsDeps, type OpenPrView } from "#src/lib/sweep.js";

/**
 * W1-T15006. The plan-scoped fix round is handed the reason its last round on this head was refused, read from the
 * ledger file. Parsing the ledger PATH as ndjson text found no rows, so every round started blind.
 */

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const PR_NUMBER = 15006;
const PR_URL = `https://github.com/acme/remudero/pull/${PR_NUMBER}`;
const BRANCH = "ci-friction-garden-1795712311884";
const task = { id: "W1-T15006", title: "plan round reads its last refusal", files: [], status: "queued" };

async function lastRefusalSeen(rows: Record<string, unknown>[]): Promise<string | undefined> {
  const root = mkdtempSync(join(tmpdir(), "rmd-t15006-sweep-"));
  mkdirSync(join(root, "state", "inflight"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  let seen: { lastRefusal?: string } | undefined;
  const deps: BuildSweepEffectsDeps = {
    owner: "acme", repo: "remudero", config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath, runId: "SWEEP-T15006", repoRoot: process.cwd(),
    plan: { tasks: [task], byId: new Map([[task.id, task]]) } as unknown as Plan,
    log: () => {},
    dispatchFixPreflightStandDownImpl: async () => false,
    fetchPrDiffFilesImpl: async () => ["plan/tasks.yaml"],
    fixRungTaskForImpl: () => ({ task: { ...task, risk: "high", acceptance: [], files: ["plan/tasks.yaml"] }, synthetic: false }),
    ghJsonImpl: () => ({ head: { ref: BRANCH, sha: HEAD }, user: { login: "remudero-fleet[bot]" },
      title: "chore(plan): fixture", body: "fixture" }),
    fixBranchClaimKeyImpl: () => "t15006-claim",
    materializePlanRoundWorktreeImpl: () => ({ worktreePath: "/fixture" }),
    restRollupForImpl: async () => [], fetchCiFailuresImpl: async () => [],
    worktreeRemoveImpl: () => {},
    runPlanScopedFixRoundImpl: async (input: { lastRefusal?: string }) => {
      seen = input;
      return { outcome: "refused", reason: "fixture round" };
    },
  } as BuildSweepEffectsDeps;
  const pr = { prNumber: PR_NUMBER, prUrl: PR_URL, taskId: task.id, headSha: HEAD, headRefName: BRANCH,
    unmetCriteria: [] } as unknown as OpenPrView;
  try {
    await withLiveWritesAllowed(() => buildSweepEffects(deps).dispatchPlanGateRound!(pr));
    assert.ok(seen, "the plan-scoped round ran");
    return seen.lastRefusal;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T15006 criterion 1: a prior plan-round refusal reaches lastRefusal", async () => {
  const refused = (reason: string, over: Record<string, unknown> = {}) => ({ step: "sweep.plan_round.refused",
    pr_number: PR_NUMBER, head_sha: HEAD, reason, ...over });
  assert.equal(await lastRefusalSeen([
    refused("the first refusal"),
    refused("another PR's refusal", { pr_number: PR_NUMBER + 1 }),
    refused("the newest refusal on this head"),
    refused("a refusal on an older head", { head_sha: OTHER }),
  ]), "the newest refusal on this head");
  assert.equal(await lastRefusalSeen([refused("an older head only", { head_sha: OTHER })]), undefined);
});
