// W1-T15282, 2026-11-28: `craigoley` is a GitHub organization and the operator is `cao825`. The SRE runbook
// escalation, the fleet liveness DOWN alarm and the strike-ladder digest each ran `gh issue edit --add-assignee
// <repository owner>`, so every attempt failed "'craigoley' not found" (13 `*assign_failed` rows in November) and
// the operator never got the assignment notification. They now assign `config.operatorGithubLogins`, and nobody
// when no list is configured. The reviewer-regression gateway (src/run-task.ts) and the fix lane's scope question
// are pinned in test/review/a-reviewer-regression-heals-itself.test.ts and
// test/a-baked-closure-join-is-catalogued-by-its-build-or-reaches-a-person.test.ts, which already drive them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import { operatorNotifyLogins, type IssueGateway } from "#src/lib/escalate.js";
import { checkInstanceLiveness } from "#src/lib/instance-gateway.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { Plan } from "#src/lib/plan.js";
import { sreOperatorEscalation } from "#src/lib/sre-runbooks.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, type OpenPrView } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-11-28T12:00:00.000Z");
const OWNER = "craigoley";
const ISSUE = "https://github.com/craigoley/remudero/issues/21300";

interface Run {
  /** Every `gh` argv the path ran, in order. */
  calls: string[][];
  /** Every ledger step the path logged. */
  steps: string[];
}

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-tassign-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recordingGh(calls: string[][]): (args: string[]) => string {
  return (args) => {
    calls.push([...args]);
    if (args[0] === "api") return "[]";
    if (args[0] === "issue" && args[1] === "create") return `${ISSUE}\n`;
    return "";
  };
}

/** sre-runbooks.ts `sreOperatorEscalation`: the runbook catalog's needs-human issue. */
function sreRunbook(t: TestContext, logins: string[] | undefined): Run {
  const run: Run = { calls: [], steps: [] };
  const ledgerPath = join(scratch(t), "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const escalate = sreOperatorEscalation({
    owner: OWNER, repo: "remudero", ledgerPath, gh: recordingGh(run.calls), log: (step) => run.steps.push(step), nowMs: () => NOW,
    ...(logins === undefined ? {} : { operatorLogins: logins }),
  });
  const url = withLiveWritesAllowed(() => escalate({
    class: "BLOCKED", taskId: "SRE-dispatch-stall", summary: "dispatch stalled for 40 minutes", detail: "No runbook cleared the stall.",
    options: [{ label: "inspect the queue", detail: "Read the queue governor rows." }], recommendation: "inspect the queue",
    consequence: "No task dispatches until the stall clears.",
  }));
  assert.equal(url, ISSUE, "the SRE escalation opens its issue");
  return run;
}

/** instance-gateway.ts `checkInstanceLiveness`: an instance with no sweep in the window is DOWN. */
function livenessAlarm(t: TestContext, logins: string[] | undefined): Run {
  const run: Run = { calls: [], steps: [] };
  const ledgerPath = join(scratch(t), "gateway-ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const [judged] = withLiveWritesAllowed(() => checkInstanceLiveness(
    [{ name: "console", repo: "craigoley/remudero-console", stateDir: "/unused/console/state" }],
    {
      ledgerPath, down: new Set(), readLastRows: () => [], clock: fixedClock(NOW), gh: recordingGh(run.calls),
      log: (step) => run.steps.push(step),
      ...(logins === undefined ? {} : { operatorGithubLogins: logins }),
    },
  ));
  assert.equal(judged?.state, "down", "the fixture instance is judged down");
  assert.ok(run.calls.some((args) => args[0] === "issue" && args[1] === "create"), "the DOWN alarm opens its issue");
  return run;
}

/** sweep.ts strike-ladder `digest`: a spent rebuild budget opens one cause issue. */
function strikeLadderDigest(t: TestContext, logins: string[] | undefined): Run {
  const run: Run = { calls: [], steps: [] };
  const root = scratch(t);
  const issues: IssueGateway = {
    ensureLabel: () => true,
    listOpen: () => [],
    create: (title, body, labels) => {
      run.calls.push(["issue", "create", "--repo", `${OWNER}/remudero`, "--title", title, "--body", body, ...labels.flatMap((l) => ["--label", l])]);
      return ISSUE;
    },
  };
  const effects = buildSweepEffects({
    owner: OWNER, repo: "remudero", repoRoot: root,
    config: { root, claudeBin: "/bin/true", ...(logins === undefined ? {} : { operatorGithubLogins: logins }) } as Config,
    plan: { tasks: [], byId: new Map() } as unknown as Plan, ledgerPath: join(root, "ledger.ndjson"), runId: "w1-tassign",
    log: (step) => run.steps.push(step), issuesImpl: issues, ghRunImpl: (_file, args) => { run.calls.push([...args]); },
    nowMsImpl: () => NOW,
  });
  const pr: OpenPrView = {
    prNumber: 21290, prUrl: "https://github.com/craigoley/remudero/pull/21290", taskId: "W1-T21290",
    headSha: "spent-head", headRefName: "run-W1-T21290-1", checksState: "red", reviewState: "success", unmetCriteria: [],
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap, lastActivityAt: new Date(NOW).toISOString(), autoMergeArmed: false,
    ciFailures: [{ name: "ci (3/8)", logTail: "not ok 7 - a broken invariant" }],
  };
  const result = effects.strikeLadder!.digest(pr, "check:ci#a broken invariant", 2, []);
  assert.equal(result.outcome, "opened", "the digest opens its cause issue");
  return run;
}

const PATHS = [
  { name: "the SRE runbook escalation", run: sreRunbook, repo: `${OWNER}/remudero`, assignFailed: "sre.escalation_assign_failed" },
  { name: "the fleet liveness DOWN alarm", run: livenessAlarm, repo: `${OWNER}/remudero-console`, assignFailed: "fleet.liveness_assign_failed" },
  { name: "the strike-ladder digest", run: strikeLadderDigest, repo: `${OWNER}/remudero`, assignFailed: "sweep.strike_ladder.assign_failed" },
] as const;

const assignments = (run: Run) => run.calls.filter((args) => args.includes("--add-assignee") || args.includes("--assignee"));
const created = (run: Run) => run.calls.find((args) => args[0] === "issue" && args[1] === "create");

for (const path of PATHS) {
  test(`W1-T15282 criterion 1: ${path.name} assigns exactly the configured operator logins, never the repository owner`, async (t) => {
    const run = await path.run(t, ["cao825"]);
    assert.deepEqual(assignments(run), [["issue", "edit", ISSUE, "--repo", path.repo, "--add-assignee", "cao825"]],
      "one edit assigns the configured operator");
    for (const args of assignments(run)) assert.equal(args.at(-1)?.split(",").includes(OWNER), false, "the organization is never an assignee");
    const two = await path.run(t, ["cao825", "relief-operator"]);
    assert.deepEqual(assignments(two).map((args) => args.at(-1)), ["cao825,relief-operator"], "every configured login, in one write");
    assert.equal(run.steps.includes(path.assignFailed), false, "a successful assignment logs no failure");
  });

  test(`W1-T15282 criterion 2: with no operator list ${path.name} assigns nobody and files the same issue`, async (t) => {
    const bare = await path.run(t, undefined);
    assert.deepEqual(assignments(bare), [], "no assignment is attempted, so no gh write is spent on the organization");
    assert.equal(bare.steps.includes(path.assignFailed), false, "and no assign_failed row is logged");
    const configured = await path.run(t, ["cao825"]);
    assert.deepEqual(created(bare), created(configured), "title, body and labels do not depend on the list");
    assert.equal(created(bare)?.includes("--assignee"), false);
  });
}

test("W1-T15282 criterion 1: the shared helper returns the configured logins once each and none when absent", () => {
  assert.deepEqual(operatorNotifyLogins(["cao825"]), ["cao825"]);
  assert.deepEqual(operatorNotifyLogins(["cao825", "Relief-Op", "CAO825", "relief-op"]), ["cao825", "Relief-Op"]);
  assert.deepEqual(operatorNotifyLogins(undefined), []);
  assert.deepEqual(operatorNotifyLogins([]), []);
});
