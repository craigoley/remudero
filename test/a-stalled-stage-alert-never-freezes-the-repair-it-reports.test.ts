import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { openEscalationStandDownReason } from "#src/run-task.js";
import {
  findDuplicateEscalation,
  taskContractRevision,
  type IssueGateway,
  type OpenIssue,
} from "#src/lib/escalate.js";
import { buildSweepEffects, renderClarificationQuestion, type OpenPrView } from "#src/lib/sweep.js";
import type { Config } from "#src/lib/config.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { systemClock } from "#src/lib/clock.js";

const TASK = { id: "W1-T7739", files: ["src/x.ts"], acceptance: [] } as unknown as Task;
const HEAD = "936a81f13aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PR: OpenPrView = {
  prNumber: 11821, prUrl: "https://github.com/craigoley/remudero/pull/11821", taskId: TASK.id,
  headSha: HEAD, headRefName: "run-W1-T7739-1792014654970", checksState: "red", reviewState: "none",
  unmetCriteria: [], priorStrikes: 0, lastActivityAt: systemClock.iso(), autoMergeArmed: false,
};
const STALLED = `PR stage stalled: #11821 ${PR.prUrl} — own-red for 53 minutes (BACKSTOP 45); ` +
  "since 2026-10-14T22:43:46.000Z; DIAGNOSIS: unknown signature";

async function candidateFor(t: TestContext, reason: string, question = reason) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stalled-stage-stand-down-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const open: OpenIssue[] = [];
  const issues: IssueGateway = {
    create(title, body) {
      const url = "https://github.com/craigoley/remudero/issues/11853";
      open.push({ number: 11853, url, title, body });
      return url;
    },
    listOpen: () => open,
    comment: () => assert.fail("the stand-down probe must not modify the issue"),
    closeWithComment: () => assert.fail("the stage's recovery path owns closing the issue"),
  };
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", repoRoot: root, config: { claudeBin: "claude", root } as Config,
    ledgerPath: join(root, "ledger.ndjson"), runId: "SWEEP-stalled-stage-stand-down",
    plan: { tasks: [TASK], byId: new Map([[TASK.id, TASK]]) } as Plan,
    log: () => {}, issuesImpl: issues, reloadPlanForFixImpl: () => undefined,
    readJsonImpl: async () => assert.fail("this fixture must not read GitHub"),
  });
  await effects.escalate(PR, reason, { ...renderClarificationQuestion(PR, reason), question });
  const revision = taskContractRevision(TASK);
  const candidate = findDuplicateEscalation({
    class: "BLOCKED", taskId: TASK.id, summary: `review false-block — ${PR.prUrl}`, detail: "",
    headSha: HEAD, cause: "ci", contractRevision: revision,
  }, { issues });
  assert.ok(candidate, "the fix probe must find the same-head, same-cause, same-contract issue");
  assert.equal(open.length, 1);
  return { candidate, revision, open };
}

describe("test/a-stalled-stage-alert-never-freezes-the-repair-it-reports.test.ts", () => {
  test("W1-T9585: an open stalled-stage alert lets the fix strike run", async (t) => {
    const { candidate, revision, open } = await candidateFor(t, STALLED);
    assert.equal(openEscalationStandDownReason(HEAD, candidate, revision), undefined);
    assert.equal(open.length, 1, "the alert stays open until the stage recovers");
    assert.equal(open[0], candidate);
    assert.equal(openEscalationStandDownReason(HEAD, { ...candidate, title: undefined }, revision), undefined,
      "the persisted question identifies the alert even without its title");
  });

  test("W1-T9585: an open question escalation still stands the strike down", async (t) => {
    const question = "Should the acceptance contract change before repairing this PR?";
    for (const quoted of ["", `\n\n${STALLED}`, `\n\n\`\`\`text\n\n${STALLED}\n\n\`\`\``]) {
      const { candidate, revision } = await candidateFor(t, "fix progress loop: operator scope decision",
        question + quoted);
      const held = openEscalationStandDownReason(HEAD, candidate, revision);
      assert.ok(held, `the unanswered question still blocks repair with quoted evidence ${JSON.stringify(quoted)}`);
      assert.match(held.reason, /ALREADY OPEN and awaiting a human/);
      assert.ok(held.reason.includes(candidate.url));
      assert.equal(openEscalationStandDownReason(HEAD, candidate, "amended-contract"), undefined);
      assert.equal(openEscalationStandDownReason("new-head", candidate, revision), undefined);
    }
  });

  test("a question that mentions a stalled-stage alert still waits for its answer", async (t) => {
    const { candidate, revision } = await candidateFor(t, "fix progress loop: operator scope decision",
      `Should we change the contract after this alert: ${STALLED}?`);
    assert.ok(openEscalationStandDownReason(HEAD, candidate, revision));
  });

  test("a stalled-stage reason does not override an ordinary persisted question", async (t) => {
    const { candidate, revision } = await candidateFor(t, STALLED,
      "Should the operator revise the scope before repair?");
    assert.ok(openEscalationStandDownReason(HEAD, candidate, revision));
  });
});
