import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { buildSweepEffects, renderClarificationQuestion, stalledStageCauseKey, type OpenPrView } from "#src/lib/sweep.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import type { Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// OBSERVED 2026-11-10: #17633 to #17637 opened within eight seconds, one per PR, each "awaiting-review" with this
// one diagnosis. The cause was one (the review pipeline was not posting); the operator got five asks for it.
const TITLE = "test/sweep/pull-requests-stuck-for-one-cause-share-one-escalation.test.ts";
const NEVER_POSTED = `repeat: "checks green, review never posted — running the review lane on #<pr>" x3`;
const FIVE = [17622, 17617, 17626, 17619, 17618];

const prView = (prNumber: number): OpenPrView => ({
  prNumber,
  prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
  headSha: String(prNumber).padEnd(40, "a"),
  headRefName: `run-unfiled-17940000${prNumber}`,
  reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: "2026-11-10T10:46:15.943Z", autoMergeArmed: false,
});

const reasonFor = (prNumber: number, blocker: string, diagnosis: string, heldMinutes?: number) =>
  `PR stage stalled: #${prNumber} https://github.com/craigoley/remudero/pull/${prNumber} — ${blocker} for 49 minutes ` +
    `(BACKSTOP 30); since 2026-11-10T10:46:15.943Z; DIAGNOSIS: ${diagnosis}` +
    (heldMinutes === undefined ? "" : `; the fleet itself withheld the repair for ${heldMinutes} of those minutes`);

function fixture(t: TestContext, opts: { lagging?: boolean; firstReadFails?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}one-cause-one-escalation-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const created: Array<OpenIssue & { labels: string[] }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  // GitHub's labelled list can lag an issue it just created; a lagging fixture lists only issues of earlier passes.
  let listedUpTo = 0;
  let reads = 0;
  const issues: IssueGateway = {
    create(title, body, labels) {
      const number = 17633 + created.length;
      const url = `https://github.com/craigoley/remudero/issues/${number}`;
      created.push({ number, url, title, body, labels });
      return url;
    },
    listOpen(label) {
      reads += 1;
      if (opts.firstReadFails && reads === 1) throw new Error("gh api issues: HTTP 502");
      const visible = opts.lagging ? created.slice(0, listedUpTo) : created;
      return visible.filter(issue => issue.labels.includes(label));
    },
    comment: (url, body) => { comments.push({ url, body }); },
  };
  const logged: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const ledgerPath = join(root, "ledger.ndjson");
  /** One sweep pass: the daemon builds the effects afresh on every pass. */
  const pass = () => {
    listedUpTo = created.length;
    const effects = buildSweepEffects({
      owner: "craigoley", repo: "remudero", repoRoot: root,
      config: { claudeBin: "claude", root } as Config,
      ledgerPath, runId: "DAEMON-one-cause-one-escalation",
      plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: (step: string, fields: Record<string, unknown> = {}) => { logged.push({ step, fields }); },
      issuesImpl: issues, reloadPlanForFixImpl: () => undefined,
      readJsonImpl: async () => { throw new Error("unexpected remote read"); },
    });
    return async (prNumber: number, blocker: string, diagnosis: string, heldMinutes?: number) => {
      const view = prView(prNumber);
      const reason = reasonFor(prNumber, blocker, diagnosis, heldMinutes);
      await effects.escalate(view, reason, { ...renderClarificationQuestion(view, reason), cause: "stage-stall" });
    };
  };
  const issueOf = (prNumber: number) => created.find(issue => issue.title?.includes(`/pull/${prNumber}`) ||
    issue.body?.includes(`PR stage stalled: #${prNumber} `));
  return { created, comments, logged, pass, issueOf };
}

test(`${TITLE}: W1-T12046 criterion 1 — five PRs stalled in one stage for one diagnosis in one sweep share one escalation that lists each`, async t => {
  const f = fixture(t, { lagging: true });
  const escalate = f.pass();
  // The sweep's dispositions may overlap; the list never shows this pass's own new issue.
  await Promise.all(FIVE.map((prNumber, i) => escalate(prNumber, "awaiting-review", NEVER_POSTED, i % 2 === 0 ? undefined : 16 + i)));
  assert.equal(f.created.length, 1, f.created.map(issue => issue.title).join("\n"));
  const shared = f.created[0]!;
  assert.equal(f.comments.length, FIVE.length - 1);
  assert.ok(f.comments.every(comment => comment.url === shared.url));
  const listedText = [shared.body ?? "", ...f.comments.map(comment => comment.body)].join("\n");
  for (const prNumber of FIVE) {
    assert.ok(listedText.includes(`https://github.com/craigoley/remudero/pull/${prNumber}`), `#${prNumber} is listed`);
  }
  // The newest comment carries the whole list, the opener first.
  assert.match(f.comments.at(-1)!.body, /Pull requests stalled for this cause: #17622, #17617, #17626, #17619, #17618/);
  const joined = f.logged.filter(row => row.step === "escalation.stall_cause_joined");
  assert.deepEqual(joined.map(row => row.fields.pr_number), FIVE.slice(1));
  assert.ok(joined.every(row => row.fields.issue_url === shared.url));
  assert.deepEqual(joined.map(row => row.fields.task_id), FIVE.slice(1).map(n => `PR-${n}`));
});

test(`${TITLE}: W1-T12046 criterion 2 — a PR stalled for a different diagnosis, or in a different stage, still gets its own escalation`, async t => {
  const f = fixture(t);
  const escalate = f.pass();
  await escalate(17622, "awaiting-review", NEVER_POSTED);
  await escalate(17617, "awaiting-review", "review running past its observed length");
  await escalate(17626, "own-red", NEVER_POSTED);
  await escalate(17619, "awaiting-review", NEVER_POSTED);
  assert.equal(f.created.length, 3, f.created.map(issue => issue.title).join("\n"));
  for (const prNumber of [17622, 17617, 17626]) assert.ok(f.issueOf(prNumber), `#${prNumber} has its own issue`);
  assert.equal(f.issueOf(17619), undefined, "the one PR of a shared cause has no issue of its own");
  assert.deepEqual(f.comments.map(comment => comment.url), [f.issueOf(17622)!.url]);
  assert.match(f.comments[0]!.body, /Pull requests stalled for this cause: #17622, #17619/);
  // The key itself: the same cause reads alike across PRs and held tails, and a stage or diagnosis splits it.
  const key = (prNumber: number, blocker: string, diagnosis: string, held?: number) =>
    stalledStageCauseKey(reasonFor(prNumber, blocker, diagnosis, held));
  assert.equal(key(17622, "awaiting-review", NEVER_POSTED), key(17618, "awaiting-review", NEVER_POSTED, 18));
  assert.equal(key(17622, "awaiting-review", NEVER_POSTED), `awaiting-review — ${NEVER_POSTED}`);
  assert.notEqual(key(17622, "awaiting-review", NEVER_POSTED), key(17618, "own-red", NEVER_POSTED));
  assert.notEqual(key(17622, "awaiting-review", NEVER_POSTED), key(17618, "awaiting-review", "unknown signature"));
  assert.equal(stalledStageCauseKey("review failing with no actionable unmet criteria"), undefined);
});

test(`${TITLE}: W1-T12046 criterion 3 — a PR stalled later for a cause with an open escalation is added to it as a comment and opens no issue`, async t => {
  const f = fixture(t);
  await f.pass()(17622, "awaiting-review", NEVER_POSTED, 16);
  assert.equal(f.created.length, 1);
  // A later sweep: a new effects instance, which knows the open issue only from GitHub's list.
  await f.pass()(17618, "awaiting-review", NEVER_POSTED);
  assert.equal(f.created.length, 1, "no new issue is opened");
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0]!.url, f.created[0]!.url);
  assert.match(f.comments[0]!.body, /Pull request #17618 \(https:\/\/github\.com\/craigoley\/remudero\/pull\/17618\) is stalled for the same cause/);
  assert.match(f.comments[0]!.body, /Pull requests stalled for this cause: #17622, #17618/);
  assert.match(f.comments[0]!.body, new RegExp(`Task PR-17618, head ${prView(17618).headSha}\\.`));
  assert.deepEqual(f.logged.filter(row => row.step === "escalation.stall_cause_joined").map(row => row.fields.issue_url),
    [f.created[0]!.url]);
});

test(`${TITLE}: a PR that already has its own open stall question appends there, never to another PR's cause issue`, async t => {
  const f = fixture(t);
  const first = f.pass();
  await first(17622, "awaiting-review", NEVER_POSTED);
  await first(17618, "own-red", "unknown signature");
  assert.equal(f.created.length, 2);
  await f.pass()(17618, "awaiting-review", NEVER_POSTED);
  assert.equal(f.created.length, 2);
  assert.deepEqual(f.comments.map(comment => comment.url), [f.issueOf(17618)!.url]);
  assert.equal(f.logged.filter(row => row.step === "escalation.stall_cause_joined").length, 0);
});

test(`${TITLE}: an unreadable open list is logged and the stall still escalates on its own`, async t => {
  const f = fixture(t, { firstReadFails: true });
  await f.pass()(17622, "awaiting-review", NEVER_POSTED);
  const unread = f.logged.filter(row => row.step === "escalation.stall_cause_unread");
  assert.equal(unread.length, 1);
  assert.match(String(unread[0]!.fields.reason), /HTTP 502/);
  assert.equal(f.created.length, 1, "the gateway's own read still files the escalation");
  assert.equal(f.comments.length, 0);
});
