import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { openEscalationStandDownReason, runFixRung } from "#src/run-task.js";
import { findDuplicateEscalation, taskContractRevision, type IssueGateway, type OpenIssue } from "#src/lib/escalate.js";
import { buildSweepEffects, renderClarificationQuestion, type OpenPrView } from "#src/lib/sweep.js";
import type { Config } from "#src/lib/config.js";
import type { Task } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const TASK = { id: "W1-T10314", title: "repair the code red", files: ["src/x.ts"], acceptance: [] } as unknown as Task;
const HEAD = "660d92c".padEnd(40, "0");
const PR: OpenPrView = {
  prNumber: 13218, prUrl: "https://github.com/craigoley/remudero/pull/13218", taskId: TASK.id,
  headSha: HEAD, headRefName: "run-W1-T10314-1792514519658", checksState: "red", reviewState: "none",
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
};
const METADATA = "metadata-only required checks acceptance-author-gate need title/body repair: no deterministic body cure";
const CODE_REDS = ["acceptance-author-gate", "coverage-shard (1/8)", "coverage-ratchet"];

async function fixture(t: TestContext, reason = METADATA, question = reason) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}metadata-stand-down-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const open: OpenIssue[] = [];
  const issues: IssueGateway = {
    create(title, body) {
      const url = "https://github.com/craigoley/remudero/issues/13219";
      open.push({ number: 13219, url, title, body });
      return url;
    },
    listOpen: () => open,
    comment: () => assert.fail("the guard must not append to the metadata question"),
    closeWithComment: () => assert.fail("the metadata question must stay open"),
  };
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", repoRoot: root, config: { claudeBin: "claude", root } as Config,
    ledgerPath: join(root, "ledger.ndjson"), runId: "metadata-escalation-test",
    plan: { tasks: [TASK], byId: new Map([[TASK.id, TASK]]) },
    log: () => {}, issuesImpl: issues, reloadPlanForFixImpl: () => undefined,
    readJsonImpl: async () => assert.fail("the fixture must not read GitHub"),
  });
  await effects.escalate(PR, reason, { ...renderClarificationQuestion(PR, reason), question });
  const revision = taskContractRevision(TASK);
  const candidate = findDuplicateEscalation({
    class: "BLOCKED", taskId: TASK.id, summary: `review false-block — ${PR.prUrl}`, detail: "",
    headSha: HEAD, cause: "ci", contractRevision: revision,
  }, { issues });
  assert.ok(candidate, "the production producer and dedup must find this exact head and cause");
  return { candidate, revision, issues, open, root };
}

describe("test/inbox/a-metadata-escalation-never-freezes-a-fix-for-a-red-it-never-named.test.ts", () => {
  test("W1-T10314: a metadata escalation lets a strike at an unnamed code red run", async (t) => {
    const { candidate, revision, open } = await fixture(t);
    for (const reds of [CODE_REDS, ["coverage-shard (1/8)"], ["acceptance-author-gate-extra"]]) {
      assert.equal(openEscalationStandDownReason(HEAD, candidate, revision, undefined, reds), undefined);
      assert.equal(openEscalationStandDownReason(HEAD, { ...candidate, title: undefined }, revision, undefined, reds), undefined,
        "recognition uses the persisted reason even if the issue title is missing or clipped");
    }
    assert.deepEqual(open, [candidate], "the unanswered metadata issue stays open");
  });

  test("W1-T10314: a metadata escalation still stands down a strike at the check it named", async (t) => {
    for (const reason of [METADATA, METADATA.replace("acceptance-author-gate", "acceptance-author-gate, commitlint")]) {
      const { candidate, revision } = await fixture(t, reason);
      for (const reds of [["acceptance-author-gate"], [], undefined]) {
        assert.match(openEscalationStandDownReason(HEAD, candidate, revision, undefined, reds)!.reason, /ALREADY OPEN and awaiting a human/);
      }
      if (reason !== METADATA) {
        assert.ok(openEscalationStandDownReason(HEAD, candidate, revision, undefined, ["commitlint", "acceptance-author-gate"]));
      }
      assert.equal(openEscalationStandDownReason("new-head", candidate, revision, undefined, ["acceptance-author-gate"]), undefined);
      assert.equal(openEscalationStandDownReason(HEAD, candidate, "amended-contract", undefined, ["acceptance-author-gate"]), undefined);
    }
  });

  test("other escalation kinds keep their stand-down when metadata text appears only in the question", async (t) => {
    for (const reason of ["cancelled twice", "fix progress loop: operator scope decision", "ci-log false-block"]) {
      const { candidate, revision } = await fixture(t, reason, `Should we revise scope?\n\n${METADATA}`);
      assert.match(openEscalationStandDownReason(HEAD, candidate, revision, undefined, CODE_REDS)!.reason, /ALREADY OPEN/);
    }
  });

  test("the fix rung passes its targeted reds to the guard even without a rollup reader", async (t) => {
    const { candidate, issues, open, root } = await fixture(t);
    const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
    for (const reds of [CODE_REDS, ["acceptance-author-gate"]]) {
      const judged: string[][] = [];
      const outcome = await runFixRung({
        taskId: TASK.id, task: TASK, runId: "metadata-fix-test", prUrl: PR.prUrl,
        branch: PR.headRefName!, worktreePath: root, initialSessionId: "initial", mount,
        settingsFile: join(root, "settings.json"), config: { root } as Config, budgetUsd: 10, strikeCap: 1,
        initialReview: { state: "failure", criteria: [], testTheater: false, summary: "CI is red",
          floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: HEAD, reviewerOutcome: "failure" },
        ciFailures: reds.map(name => ({ name, logTail: "required check failed" })),
        reviewBase: { owner: "craigoley", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
        deps: {
          issues, ledgerPath: join(root, "fix-ledger.ndjson"), ledgerLines: () => [
            { step: "fix.dispatch", task_id: TASK.id, pr_number: PR.prNumber, head_sha: HEAD,
              round_id: "prior-round", current_red: reds, mode: "ci-log" },
            { step: "fix.done", task_id: TASK.id, pr_number: PR.prNumber, head_sha: HEAD,
              round_id: "prior-round", subtype: "success" },
          ],
          log: () => {}, say: () => {}, account: result => result,
          readLiveState: async () => ({ ok: true, state: "OPEN" }),
          fixProgressJudge: async input => {
            judged.push([...input.currentRed]);
            throw new Error("fixture reached the strike admission judge");
          },
          spawn: async () => assert.fail("the fixture stops at strike admission"),
          push: () => assert.fail("no worker ran"), waitForCiGreen: async () => "red",
          runReview: async () => assert.fail("CI is still red"),
        },
      });
      if (reds === CODE_REDS) {
        assert.equal(outcome.outcome, "handed_off");
        assert.deepEqual(judged, [[...reds].sort()], "the mixed red set reaches strike admission");
        assert.equal(outcome.reason, "fix progress judgment failed: Error: fixture reached the strike admission judge");
      } else {
        assert.equal(outcome.outcome, "stood_down");
        assert.deepEqual(judged, []);
        assert.match(outcome.reason!, /ALREADY OPEN/);
      }
      assert.deepEqual(open, [candidate]);
    }
  });
});
