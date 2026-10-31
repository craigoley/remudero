import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { buildSweepEffects, renderClarificationQuestion, stalledStageEscalationSummary, type OpenPrView } from "#src/lib/sweep.js";
import type { Config } from "#src/lib/config.js";
import { escalationIssueTitle, renderIssueBody, type Escalation, type IssueGateway, type OpenIssue } from "#src/lib/escalate.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}one-stalled-question-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const created: Array<OpenIssue & { labels: string[]; open: boolean }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  const issues: IssueGateway = {
    create(title, body, labels) {
      const number = 16000 + created.length;
      const url = `https://github.com/craigoley/remudero/issues/${number}`;
      created.push({ number, url, title, body, labels, open: true });
      return url;
    },
    listOpen: label => created.filter(issue => issue.open && issue.labels.includes(label)),
    comment: (url, body) => { comments.push({ url, body }); },
    closeWithComment(url) {
      const issue = created.find(issue => issue.url === url);
      assert.ok(issue);
      issue.open = false;
    },
  };
  const pr: OpenPrView = {
    prNumber: 15520,
    prUrl: "https://github.com/craigoley/remudero/pull/15520",
    taskId: "W1-T10842",
    headSha: "9dca5f8c614f2ec64134bdebbbc32c0204201234",
    headRefName: "run-W1-T10842-1793300000000",
    reviewState: "none", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-10-29T20:20:00.000Z", autoMergeArmed: false,
  };
  const task = { id: pr.taskId, files: ["src/lib/sweep.ts"], acceptance: [] } as unknown as Task;
  const ledgerPath = join(root, "ledger.ndjson");
  const reasonFor = (diagnosis: string, blocker: string, view: OpenPrView) =>
    `PR stage stalled: #${view.prNumber} ${view.prUrl} — ${blocker} for 45 minutes ` +
      `(owner: none); since 2026-10-29T20:20:00.000Z; DIAGNOSIS: ${diagnosis}`;
  const legacyIssue = (diagnosis: string, blocker = "own-red") => {
    const reason = reasonFor(diagnosis, blocker, pr);
    const legacy: Escalation = {
      class: "MANUAL", taskId: task.id, headSha: pr.headSha, cause: "stage-stall",
      summary: `PR ${pr.prUrl} needs a clarification — ${stalledStageEscalationSummary(reason)}`,
      detail: reason, options: [{ label: "inspect", detail: "inspect the stalled stage" }],
      recommendation: "inspect",
    };
    issues.create(escalationIssueTitle(legacy), renderIssueBody(legacy), ["needs-human"]);
    return created[created.length - 1];
  };
  const escalate = async (diagnosis: string, blocker = "own-red", view = pr) => {
    const reason = reasonFor(diagnosis, blocker, view);
    // Rebuild between observations: dedup must survive a sweep restart.
    const effects = buildSweepEffects({
      owner: "craigoley", repo: "remudero", repoRoot: root,
      config: { claudeBin: "claude", root } as Config,
      ledgerPath, runId: "SWEEP-one-stalled-question",
      plan: { tasks: [task], byId: new Map([[task.id, task]]) } as Plan,
      log: () => {}, issuesImpl: issues, reloadPlanForFixImpl: () => undefined,
      readJsonImpl: async () => { throw new Error("unexpected remote read"); },
    });
    await effects.escalate(view, reason, {
      ...renderClarificationQuestion(view, reason), cause: "stage-stall",
    });
  };
  const rows = () => readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { created, comments, pr, escalate, legacyIssue, rows };
}

test("test/sweep/one-stalled-pr-keeps-one-needs-human-question.test.ts: changing diagnoses append to one open question", async t => {
  const f = fixture(t);
  await f.escalate("unknown signature");
  await f.escalate("repeat: worker launch refused; a different remedy is needed\nwith more evidence");
  await f.escalate("review now names the underlying failure");
  assert.equal(f.created.length, 1);
  assert.equal(f.comments.length, 2);
  assert.ok(f.comments.every(comment => comment.url === f.created[0].url));
  assert.match(f.created[0].body!, /DIAGNOSIS: unknown signature/);
  assert.match(f.comments[0].body, /repeat: worker launch refused; a different remedy is needed\nwith more evidence/);
  assert.match(f.comments[1].body, /review now names the underlying failure/);
  assert.doesNotMatch(f.created[0].title!, /DIAGNOSIS|unknown signature/);
  assert.ok(f.created[0].labels.includes("needs-human"));
  assert.deepEqual(f.rows().filter(row => row.step === "escalation.deduped").map(row => row.issue_url),
    [f.created[0].url, f.created[0].url]);
});

test("a legacy stalled issue absorbs a new diagnosis at the same head and blocker", async t => {
  const f = fixture(t);
  f.legacyIssue("unknown signature");
  await f.escalate("repeat: launch refused");
  assert.equal(f.created.length, 1);
  assert.equal(f.comments[0].url, f.created[0].url);
  assert.match(f.comments[0].body, /DIAGNOSIS: repeat: launch refused/);
});

for (const [repoLength, prNumber, clippedSuffix] of [
  [37, 15520, "; DIAGNOSI…"], [37, 155200, "; DIAGN…"], [38, 15520, "; DIAGNO…"],
  [39, 15520, "; DIAG…"], [40, 15520, "; DI…"], [41, 15520, "; …"],
] as const) {
  test(`a real legacy title clipped at ${clippedSuffix} absorbs the new diagnosis`, async t => {
    const f = fixture(t);
    f.pr.prNumber = prNumber;
    f.pr.prUrl = `https://github.com/craigoley/${"remudero".padEnd(repoLength, "-")}/pull/${f.pr.prNumber}`;
    const legacy = f.legacyIssue("unknown signature", "awaiting-review");
    assert.ok(legacy.title!.endsWith(clippedSuffix), legacy.title);
    const diagnosis = "repeat: own-red; DIAGNOSIS: a different remedy\nwith more evidence";
    await f.escalate(diagnosis, "awaiting-review");
    assert.equal(f.created.length, 1);
    assert.equal(f.comments.length, 1);
    assert.equal(f.comments[0].url, legacy.url);
    assert.ok(f.comments[0].body.includes(diagnosis));
    assert.deepEqual(f.rows().filter(row => row.step === "escalation.deduped").map(row => row.issue_url),
      [legacy.url]);
  });
}

for (const change of ["head", "blocker", "closed"] as const) {
  test(`a clipped legacy title still opens a new question when ${change} differs`, async t => {
    const f = fixture(t);
    f.pr.prUrl = `https://github.com/craigoley/${"remudero".padEnd(38, "-")}/pull/${f.pr.prNumber}`;
    const legacy = f.legacyIssue("unknown signature", "awaiting-review");
    assert.ok(legacy.title!.endsWith("; DIAGNO…"), legacy.title);
    if (change === "closed") legacy.open = false;
    await f.escalate("repeat: launch refused", change === "blocker" ? "own-red" : "awaiting-review",
      change === "head" ? { ...f.pr, headSha: "new-head" } : f.pr);
    assert.equal(f.created.length, 2);
    assert.equal(f.comments.length, 0);
    assert.equal(f.created[1].open, true);
    assert.equal(f.rows().filter(row => row.step === "escalation.deduped").length, 0);
  });
}

for (const repoLength of [43, 100] as const) {
  for (const producer of ["legacy", "current"] as const) {
    for (const change of ["diagnosis", "head", "blocker", "closed", "pr"] as const) {
      test(`${producer} question with a ${repoLength}-character repository handles a changed ${change}`, async t => {
        const f = fixture(t);
        f.pr.prUrl = `https://github.com/craigoley/${"remudero".padEnd(repoLength, "-")}/pull/${f.pr.prNumber}`;
        if (producer === "legacy") f.legacyIssue("unknown signature", "awaiting-review");
        else await f.escalate("unknown signature", "awaiting-review");
        const original = f.created[0];
        assert.ok(original.title!.endsWith("…"), original.title);
        assert.ok(!original.title!.includes("awaiting-review"), "control: the title lost the blocker");
        if (change === "closed") original.open = false;
        const diagnosis = "repeat: own-red; DIAGNOSIS: a new remedy\nwith more evidence";
        const view = change === "head" ? { ...f.pr, headSha: "new-head" }
          : change === "pr" ? { ...f.pr, prNumber: 15521, prUrl: f.pr.prUrl.replace("/15520", "/15521") }
          : f.pr;
        await f.escalate(diagnosis, change === "blocker" ? "own-red" : "awaiting-review", view);
        const sameIdentity = change === "diagnosis";
        assert.equal(f.created.length, sameIdentity ? 1 : 2);
        assert.equal(f.comments.length, sameIdentity ? 1 : 0);
        assert.deepEqual(f.rows().filter(row => row.step === "escalation.deduped").map(row => row.issue_url),
          sameIdentity ? [original.url] : []);
        if (sameIdentity) {
          assert.equal(f.comments[0].url, original.url);
          assert.ok(f.comments[0].body.includes(diagnosis));
        } else {
          assert.equal(f.created[1].open, true);
          assert.ok(f.created[1].body!.includes(diagnosis));
        }
      });
    }
  }
}

test("a moved head opens a new stalled question even when its diagnosis is unchanged", async t => {
  const f = fixture(t);
  await f.escalate("unknown signature");
  await f.escalate("unknown signature", "own-red", { ...f.pr, headSha: "new-head" });
  assert.equal(f.created.length, 2);
  assert.match(f.created[1].body!, /\*\*Head:\*\* new-head/);
  assert.equal(f.comments.length, 0);
});

test("different blockers at one head keep separate stalled questions despite their common stage-stall cause", async t => {
  const f = fixture(t);
  await f.escalate("unknown signature");
  await f.escalate("unknown signature", "awaiting-review");
  await f.escalate("repeat: worker refused");
  assert.equal(f.created.length, 2);
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].url, f.created[0].url);
});

test("a closed stalled question is replaced with a new open question", async t => {
  const f = fixture(t);
  await f.escalate("unknown signature");
  f.created[0].open = false;
  await f.escalate("repeat: launch refused");
  assert.equal(f.created.length, 2);
  assert.equal(f.created[1].open, true);
  assert.equal(f.comments.length, 0);
});

test("different PRs at the same head and task keep separate stalled questions", async t => {
  const f = fixture(t);
  await f.escalate("unknown signature");
  await f.escalate("repeat: launch refused", "own-red", {
    ...f.pr, prNumber: 15521, prUrl: "https://github.com/craigoley/remudero/pull/15521",
  });
  assert.equal(f.created.length, 2);
  assert.equal(f.comments.length, 0);
});

test("a different needs-human question cannot absorb a stalled-stage diagnosis", async t => {
  const f = fixture(t);
  await f.escalate("unknown signature");
  f.created[0].title = `[MANUAL] ${f.pr.taskId}: PR ${f.pr.prUrl} needs a different decision`;
  await f.escalate("repeat: launch refused");
  assert.equal(f.created.length, 2);
  assert.equal(f.comments.length, 0);
});

test("a moved head still retires earlier questions across blockers", async t => {
  const f = fixture(t);
  await f.escalate("unknown signature");
  await f.escalate("unknown signature", "awaiting-review");
  await f.escalate("repeat: launch refused", "own-red", { ...f.pr, headSha: "new-head" });
  assert.equal(f.created.length, 3);
  assert.deepEqual(f.created.map(issue => issue.open), [false, false, true]);
  assert.equal(f.comments.length, 0);
});
