import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildFixProgressInput } from "../src/lib/fix-progress-judge.js";
import { productionFixProgressJudge } from "../src/lib/sweep.js";

// Shaped on PR #10628 (W1-T7616), 2026-10-10: round 1 ended NEEDS_SCOPE / scope_amendment_pending with no push,
// amendment #10633 merged at 11:50, and the 12:16 judge read the round as a no-op and escalated.
const TASK = "W1-T7616";
const PR = 10628;
const AMENDMENT = 10633;
const HEAD = "ed2109e";
const URL = `https://github.com/o/r/pull/${PR}`;
const round = (amendment: Record<string, unknown>[]): Record<string, unknown>[] => [
  { task_id: TASK, step: "fix.dispatch", round_id: "r1", repair_pr_url: URL, head_sha: HEAD, mode: "ci-log",
    ci_failures: [{ check: "coverage-shard (5/8)" }], diff_stat: [] },
  ...amendment,
  { task_id: TASK, step: "fix.done", round_id: "r1", repair_pr_url: URL, head_sha: HEAD, worker_exit: "exit",
    worker_exit_code: 0, fix_outcome: "NEEDS_SCOPE", subtype: "scope_amendment_pending" },
];
const opened: Record<string, unknown>[] = [
  { task_id: TASK, step: "fix.scope_amendment", kind: "scope_amendment", pr_number: PR, amendment_number: AMENDMENT },
  { task_id: TASK, step: "fix.scope_amendment", outcome: "created", kind: "created", amendmentNumber: AMENDMENT,
    paths: ["src/lib/gardener.ts"], head_sha: HEAD, pr_number: PR },
];
const terminal = (state: string) =>
  ({ task_id: "SWEEP", step: "pr.terminal", pr_number: AMENDMENT, state, pr_url: `https://github.com/o/r/pull/${AMENDMENT}` });
const input = (ledger: Record<string, unknown>[]) =>
  buildFixProgressInput({ taskId: TASK, prNumber: PR, headSha: HEAD, currentRed: ["coverage-ratchet"], ledger });

describe("test/a-merged-scope-amendment-is-progress-to-the-fix-judge.test.ts", () => {
  test("a NEEDS_SCOPE round whose scope amendment merged is not a no-op and reaches the judge as merged", () => {
    const built = input([...round(opened), terminal("merged")]);
    assert.equal(built.rounds.length, 1);
    assert.deepEqual(built.rounds[0].scopeAmendment, { number: AMENDMENT, state: "merged" });
    assert.equal(built.signals.noOpRounds, 0);
    assert.equal(built.signals.scopeAmendmentsMerged, 1);
    assert.equal(built.signals.scopeAmendmentsPending, undefined);
  });

  test("a NEEDS_SCOPE round whose scope amendment is still open reaches the judge as pending, not a no-op", () => {
    const built = input(round(opened));
    assert.deepEqual(built.rounds[0].scopeAmendment, { number: AMENDMENT, state: "pending" });
    assert.equal(built.signals.noOpRounds, 0);
    assert.equal(built.signals.scopeAmendmentsPending, 1);
    assert.equal(built.signals.scopeAmendmentsMerged, undefined);
  });

  test("a scope amendment closed unmerged or refused leaves its round a no-op the judge can see", () => {
    const closed = input([...round(opened), terminal("closed")]);
    assert.deepEqual(closed.rounds[0].scopeAmendment, { number: AMENDMENT, state: "closed" });
    assert.equal(closed.signals.noOpRounds, 1);
    const refused = input(round([{ task_id: TASK, step: "fix.scope_amendment", outcome: "refused", kind: "refused",
      reason: "scope-amendment-error", detail: "x", head_sha: HEAD, pr_number: PR }]));
    assert.equal(refused.rounds[0].scopeAmendment?.state, "refused");
    assert.equal(refused.signals.noOpRounds, 1);
  });

  test("a round with no scope amendment keeps the signals an earlier escalation's input key was hashed from", () => {
    const built = input(round([]));
    assert.equal(built.rounds[0].scopeAmendment, undefined);
    assert.equal(built.signals.noOpRounds, 1);
    assert.equal("scopeAmendmentsMerged" in built.signals, false);
    assert.equal("scopeAmendmentsPending" in built.signals, false);
  });

  test("the production fix judge's prompt says a merged scope amendment is progress and an open one is a wait", async () => {
    let prompt = "";
    const judge = productionFixProgressJudge({ cwd: ".", settingsFile: "settings/worker.json",
      mount: { model: "test-model", effort: "low", maxTurns: 1, contextBudget: 10000 }, spawn: async args => {
        prompt = args.prompt;
        return { text: 'FIX_PROGRESS: {"verdict":"continue","reason":"amendment merged"}' } as never;
      } });
    await judge(input([...round(opened), terminal("merged")]));
    assert.match(prompt, /scopeAmendmentsMerged > 0 means a round stopped for a scope amendment that has since MERGED/);
    assert.match(prompt, /scopeAmendmentsPending > 0 means an amendment PR is still open/);
    assert.match(prompt, /"scopeAmendment":\{"number":10633,"state":"merged"\}/);
  });
});
