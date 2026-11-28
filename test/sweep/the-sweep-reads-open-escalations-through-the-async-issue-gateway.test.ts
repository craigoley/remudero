import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { ghIssueGateway, NEEDS_HUMAN_LABEL, type OpenIssue } from "#src/lib/escalate.js";
import { buildSweepEffects, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
// W1-T14998: an escalation files in the host's escalation repository; this suite's gh fixture answers for craigoley/remudero.
process.env.RMD_ESCALATION_REPOSITORY ??= "craigoley/remudero";

const OWNER = "craigoley";
const REPO = "remudero";
const LIST = "repos/craigoley/remudero/issues?labels=needs-human&state=open";
const ISSUES_JSON = JSON.stringify([
  { number: 13250, html_url: "https://github.com/craigoley/remudero/issues/13250", state: "open",
    title: "[BLOCKED] repair", body: "**Task:** PR-13218\n**Class:** BLOCKED\n" },
  { number: 13251, html_url: "https://github.com/craigoley/remudero/issues/13251", state: "open",
    title: "[BLOCKED] second", body: "**Task:** PR-13219\n" },
  { number: 13252, html_url: "https://github.com/craigoley/remudero/pull/13252", state: "open",
    title: "a pull request, not an issue", body: "", pull_request: {} },
]);

function withGh(t: TestContext, routes: GhShimRoute[]) {
  const shim = ghShim(routes, { kind: "t13670-gh" });
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  t.after(() => {
    process.env.PATH = savedPath;
    rmSync(shim.dir, { recursive: true, force: true });
  });
  return shim;
}

function scratch(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13670-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function effectsFor(root: string, issuesImpl?: unknown) {
  return buildSweepEffects({
    owner: OWNER, repo: REPO, config: { root } as never, ledgerPath: join(root, "ledger.ndjson"),
    runId: "RUN-t13670", plan: { tasks: [], byId: new Map() }, log: () => {}, policy: undefined,
    reviewRunner: undefined, spawnImpl: undefined, pushEmptyCommit: undefined, issuesImpl: issuesImpl as never,
    stallNotice: undefined, armImpl: undefined, armSessionPrsOverride: undefined, updateBranchImpl: undefined,
    captureRepairFeedbackImpl: undefined, ghRunImpl: undefined, spawnWallClockBoundMsOverride: undefined,
    reclaimWorkerImpl: undefined,
  } as never);
}

test("W1-T13670 criterion 1: the open-escalation read starts no synchronous gh child", async (t) => {
  const root = scratch(t);
  const done = join(root, "list.done");
  const shim = withGh(t, [{ when: LIST, stdout: ISSUES_JSON, delaySeconds: 0.3, doneFile: done }]);
  const effects = effectsFor(root);
  let timerRanWhileInFlight = false;
  let timerRan = false;
  const timer = setTimeout(() => {
    timerRan = true;
    timerRanWhileInFlight = !existsSync(done);
  }, 0);
  const read = effects.readOpenEscalations!();
  assert.ok(read instanceof Promise, "the read returns a pending promise");
  const issues = await read;
  clearTimeout(timer);
  assert.ok(timerRan, "a timer set before the call runs before the read resolves");
  assert.ok(timerRanWhileInFlight, "the timer ran while the gh child was still in flight");
  assert.equal(issues.length, 2);
  assert.equal(shim.calls().filter((call) => call.includes(LIST)).length, 1);
});

/** The smallest sweep pass that reaches the open-escalation read: one red PR whose last rung ended. */
function sweepFixture(root: string, readOpenEscalations: SweepDeps["readOpenEscalations"]) {
  const now = Date.now();
  const head = "2f835be";
  const url = "https://github.com/craigoley/remudero/pull/13218";
  const rows: Record<string, unknown>[] = [
    { ts: new Date(now - 2000).toISOString(), run_id: "prior", task_id: "PR-13218",
      step: "sweep.disposed", disposition: "blocked-fixable", acted: true, pr_number: 13218, head_sha: head },
    { ts: new Date(now - 1000).toISOString(), run_id: "prior", task_id: "PR-13218",
      step: "fix.stood_down", site: "rung.strike", reason: "ALREADY OPEN", head_sha: head },
  ];
  const pr: OpenPrView = { prNumber: 13218, prUrl: url, taskId: "PR-13218", headSha: head,
    headRefName: "run-PR-13218-123", checksState: "red", reviewState: "pending",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(now).toISOString(), redRequiredChecks: ["ci"],
    ciFailures: [{ name: "ci", logTail: "Error: expected the repair to pass" }] };
  const logged: { step: string; fields: Record<string, unknown> }[] = [];
  const dispatched: number[] = [];
  const deps: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "t13670-sweep", now: () => now,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: new Date(now).toISOString(), ...row }); },
    readTaskContractRevision: () => "rev",
    readOpenEscalations,
    claimFixAdmission: () => ({ admitted: true }),
    dispatchFix: (view) => { dispatched.push(view.prNumber); return false; },
    arm: () => assert.fail("a red PR must not arm"), close: () => assert.fail("no close is due"),
    escalate: () => assert.fail("no escalation is due"),
    log: (step: string, fields?: Record<string, unknown>) => { logged.push({ step, fields: fields ?? {} }); },
  } as SweepDeps;
  return { pass: () => runSweep([pr], deps), logged, dispatched };
}

test("W1-T13670 criterion 2: the async read gives the same list as the sync gateway, and a gh failure ends as a logged read_error", async (t) => {
  const root = scratch(t);
  const shim = withGh(t, [{ when: LIST, stdout: ISSUES_JSON }]);
  const effects = effectsFor(root);
  const asyncList = await effects.readOpenEscalations!();
  const syncList = ghIssueGateway(OWNER, REPO).listOpen!(NEEDS_HUMAN_LABEL) as OpenIssue[];
  assert.deepEqual(asyncList, syncList);
  assert.deepEqual(asyncList.map((issue) => issue.number), [13250, 13251]);
  const listCalls = shim.calls().filter((call) => call.includes(LIST));
  assert.equal(listCalls.length, 2, "both reads ask for the needs-human label");
  assert.equal(listCalls[0], listCalls[1], "the same gh argv");

  shim.addRoute({ when: LIST, stderr: "HTTP 502: bad gateway", exit: 1 });
  const failing = effectsFor(root);
  await assert.rejects(Promise.resolve().then(() => failing.readOpenEscalations!()), "a gh failure rejects");
  const sweep = sweepFixture(root, failing.readOpenEscalations);
  await sweep.pass();
  const errors = sweep.logged.filter((row) => row.step === "sweep.open_escalations.read_error");
  assert.equal(errors.length, 1, JSON.stringify(sweep.logged.map((row) => row.step)));
  assert.deepEqual(sweep.dispatched, [13218], "an empty list fails open, as before");
});

test("W1-T13670 criterion 3: an injected issuesImpl is still the gateway read, and no gh runs", async (t) => {
  const root = scratch(t);
  const shim = withGh(t, []);
  const labels: string[] = [];
  const injected: OpenIssue[] = [{ number: 7, url: "https://github.com/craigoley/remudero/issues/7", title: "t", body: "b" }];
  const effects = effectsFor(root, {
    create: () => assert.fail("read-only"),
    listOpen: (label: string) => { labels.push(label); return injected; },
  });
  assert.deepEqual(await effects.readOpenEscalations!(), injected);
  assert.deepEqual(labels, [NEEDS_HUMAN_LABEL]);
  assert.deepEqual(shim.calls(), [], "no gh call");
});
