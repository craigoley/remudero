/**
 * W1-T9584 — A HELD DEPENDABOT PR IS REFRESHED BY DEPENDABOT, NEVER BY A FLEET MERGE COMMIT.
 *
 * 2026-10-14: #11788, #11791 and #11793 held on `dep-review` for hours. Nothing asked Dependabot
 * for anything; the only refresh was the distance update-branch rung merging main onto #11793
 * (behind_by 22) and #11791, after which Dependabot no longer managed either branch. An operator's
 * `@dependabot rebase` on #11788 produced a rebased head in two minutes.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  DEPENDABOT_NOREPLY_EMAIL_RE,
  DEPENDABOT_REBASE_COMMAND,
  DEPENDABOT_RECREATE_COMMAND,
  dependabotRefreshCommand,
  dependabotRefreshVerdict,
  headCarriesForeignCommit,
  reconcileDependabotRefresh,
  type DependabotHeadCommit,
  type DependabotIssueComment,
  type DependabotActionsPort,
  type DependabotHeadRun,
  type DependabotRefreshVerdict,
  type DepReviewRequired,
} from "#src/lib/dep-review.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import type { Plan } from "#src/lib/plan.js";
import { buildSweepEffects, defaultDepReviewActions, depReviewCommand, readDepReviewRequiredChecks, type DepReviewDeps } from "#src/run-task.js";
import {
  BASE_RED_STOOD_DOWN_STEP,
  DEFAULT_SWEEP_POLICY,
  DEPENDABOT_UPDATE_BRANCH_DEFERRED_STEP,
  runLightPassReadyRefresh,
  runSweep,
  selectUpdateBranchDecision,
  type ArmedStalledPr,
  type BaseChangedFiles,
  type OpenPrView,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";

const NOW = Date.parse("2026-10-14T23:45:35.000Z");
const ASOF = new Date(NOW).toISOString();
const POLICY = { ...DEFAULT_SWEEP_POLICY, reviewWaitingBranchRefreshEnabled: true, reviewWaitingBranchRefreshThreshold: 10 };
const HEAD = "2d5030059".padEnd(40, "0");
const MAIN = "7cfdd7775".padEnd(40, "0");
const DEPENDABOT_AUTHOR = { login: "", name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };
const FLEET_AUTHOR = { login: "", name: "remudero-fleet[bot]", email: "1234+remudero-fleet[bot]@users.noreply.github.com" };

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 11793, prUrl: "https://github.com/craigoley/remudero/pull/11793", headSha: HEAD,
    headRefName: "dependabot/npm_and_yarn/example-1.0.1", isDependabot: true,
    reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60 * 60_000).toISOString(), autoMergeArmed: false, mergeState: "clean",
    changedFiles: ["package.json", "package-lock.json"], ...over,
  };
}

function redView(over: Partial<OpenPrView> = {}): OpenPrView {
  return view({ checksState: "red", ciFailures: [{ name: "coverage-ratchet", logTail: "coverage-ratchet: FAILED" }], ...over });
}

function mainHealth(state: "red" | "green", over: Record<string, unknown> = {}): Record<string, unknown> {
  return { run_id: "main-health", task_id: "DAEMON", step: "main.health.observed", ts: ASOF, sha: MAIN, state,
    failing_checks: state === "red" ? ["ci"] : [], observed_checks: ["ci", "ci-gate", "test-slow-shard (1/2)"], ...over };
}

function sweepHarness(seed: Record<string, unknown>[] = [], over: Partial<SweepDeps> = {}) {
  const rows: Record<string, unknown>[] = [...seed];
  const refreshes: Array<DependabotRefreshVerdict | undefined> = [];
  const updates: string[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: "/nonexistent-rmd-w1-t9584/ledger.ndjson", runId: "W1-T9584-sweep", now: () => NOW,
    readLedger: () => rows.slice(),
    appendLine: (_path, row) => { rows.push({ ...row, ts: ASOF }); },
    depReview: (_pr, refresh) => { refreshes.push(refresh); return "hold"; },
    ...over,
  };
  return { deps, rows, refreshes, updates, run: (prs: OpenPrView[]) => runSweep(prs, deps, POLICY) };
}

test("W1-T9584: no update-branch rung selects a Dependabot head", async () => {
  // #11793 on 2026-10-14: behind main by 22, picked by the distance rung, and a fleet merge followed.
  const dependabot = view();
  const fleet = view({ prNumber: 11800, prUrl: "https://github.com/craigoley/remudero/pull/11800", headSha: "c".repeat(40),
    headRefName: "run-unfiled-1", isDependabot: undefined });
  const behind = (prs: OpenPrView[]) => new Map(prs.map((p) => [p.prNumber, 22]));
  const select = (prs: OpenPrView[]) =>
    selectUpdateBranchDecision(prs, NOW, new Set(), new Map(), new Set(), behind(prs), POLICY, new Set(), undefined);

  const control = select([fleet]);
  assert.equal(control.target?.prNumber, 11800, "positive control: the same shape on a fleet head IS selected");
  assert.equal(control.dependabotDeferred, undefined);
  const alone = select([dependabot]);
  assert.equal(alone.target, undefined, "a Dependabot head is never an update-branch target");
  assert.deepEqual(alone.dependabotDeferred?.map((c) => [c.prNumber, c.updateReason, c.behindBy]), [[11793, "distance", 22]]);
  assert.equal(select([dependabot, fleet]).target?.prNumber, 11800, "the deferral never starves another PR");
  const armed = view({ autoMergeArmed: true, mergeState: "behind" });
  assert.equal(selectUpdateBranchDecision([armed], NOW).target, undefined, "the armed-but-stalled rung skips it too");
  const staleGate = redView();
  assert.equal(selectUpdateBranchDecision([staleGate], NOW, new Set(), new Map([[11793, ["coverage-ratchet"]]])).target, undefined,
    "the stale-gate rung skips it too");

  // The full pass ledgers the stand-down by name, once per head, and presses nothing.
  const h = sweepHarness([], {
    behindMainByPr: new Map([[11793, 22]]),
    updateBranch: (c) => { h.updates.push(c.headSha); return "updated"; },
  });
  await h.run([dependabot]);
  await h.run([dependabot]);
  assert.deepEqual(h.updates, []);
  const deferred = h.rows.filter((r) => r.step === DEPENDABOT_UPDATE_BRANCH_DEFERRED_STEP);
  assert.equal(deferred.length, 1, "one deferral row per head, not one per pass");
  assert.equal(deferred[0].pr_number, 11793);
  assert.equal(deferred[0].head_sha, HEAD);
  assert.equal(deferred[0].update_reason, "distance");
  assert.equal(deferred[0].behind_by, 22);
  assert.equal(h.rows.filter((r) => r.step === "sweep.update_branch.attempted").length, 0);

  // The light pass's ready-overlap refresh skips it as well, and names that it did.
  const FILE = "package.json";
  const ready = view({ reviewState: "success", autoMergeArmed: true });
  const lightRows: Record<string, unknown>[] = [];
  const pressed: ArmedStalledPr[] = [];
  const lightDeps = {
    ledgerPath: "/nonexistent-rmd-w1-t9584/light.ndjson", runId: "W1-T9584-light", now: () => NOW,
    readLedger: () => lightRows.slice(), appendLine: (_p: string, row: Record<string, unknown>) => { lightRows.push(row); },
    updateBranch: (c: ArmedStalledPr) => { pressed.push(c); return "updated" as const; },
    behindMainByPr: new Map([[11793, 2]]),
    baseChangedFilesByPr: new Map<number, BaseChangedFiles>([[11793, { files: [FILE], truncated: false }]]),
  };
  assert.equal(await runLightPassReadyRefresh([ready], lightDeps, POLICY), undefined);
  assert.deepEqual(pressed, []);
  const lightDeferred = lightRows.filter((r) => r.step === DEPENDABOT_UPDATE_BRANCH_DEFERRED_STEP);
  assert.equal(lightDeferred.length, 1);
  assert.equal(lightDeferred[0].source, "light_pass");
  assert.equal(lightDeferred[0].update_reason, "ready-overlap");
  assert.equal(await runLightPassReadyRefresh([{ ...ready, isDependabot: undefined }], lightDeps, POLICY), 11793,
    "positive control: the same ready head on a fleet branch IS refreshed by the light pass");
});

interface CommandFixture {
  run: (refresh?: string) => Promise<number>;
  advance: (ms: number) => void;
  setHead: (sha: string, commits: DependabotHeadCommit[] | undefined) => void;
  setRed: (red: boolean) => void;
  failComment: (fail: boolean) => void;
  failUpdate: (error: string | undefined) => void;
  setComments: (rows: DependabotIssueComment[]) => void;
  updates: Array<{ prNumber: number; expectedHeadSha: string }>;
  root: string;
  forgetLedger: () => void;
  ledger: () => Record<string, unknown>[];
  comments: Array<{ url: string; body: string }>;
  opened: Array<{ title: string; body: string }>;
}

function commandFixture(t: TestContext): CommandFixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9584-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  let now = NOW;
  let head = HEAD;
  let commits: DependabotHeadCommit[] | undefined = [{ oid: HEAD, authors: [DEPENDABOT_AUTHOR] }];
  let red = true;
  let commentFails = false;
  let updateError: string | undefined;
  let replies: DependabotIssueComment[] = [];
  const updates: Array<{ prNumber: number; expectedHeadSha: string }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  const opened: Array<{ title: string; body: string }> = [];
  const issues: IssueGateway = {
    create(title, body) { opened.push({ title, body }); return `https://github.com/craigoley/remudero/issues/${9000 + opened.length}`; },
    listOpen() { return []; },
    closeWithComment() {},
  };
  const deps: DepReviewDeps = {
    config: { root, ledger: ledgerPath } as never,
    clock: clockFromMillisFn(() => now),
    gh: () => ({
      number: 11793, url: "https://github.com/craigoley/remudero/pull/11793",
      title: "build(deps): bump example from 1.0.0 to 1.0.1", body: "", headRefOid: head,
      headRefName: "dependabot/npm_and_yarn/example-1.0.1", author: { login: "app/dependabot" },
      statusCheckRollup: [{ name: "coverage-ratchet", conclusion: red ? "FAILURE" : "SUCCESS" }],
      ...(commits === undefined ? {} : { commits }),
    }),
    prDiff: () => "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n",
    postStatus: (async () => ({ posted: true })) as DepReviewDeps["postStatus"],
    arm: () => "armed",
    issues,
    // The positive control the shard names: the App-authored PR comment is the ONE write a refresh uses.
    prMutations: {
      comment: (url, body) => {
        if (commentFails) throw new Error("comment unavailable");
        comments.push({ url, body });
      },
      close: () => { throw new Error("a refresh never closes the PR"); },
      updateBranch: async (prNumber, expectedHeadSha) => {
        updates.push({ prNumber, expectedHeadSha });
        return updateError === undefined ? { ok: true } : { ok: false, error: updateError };
      },
      comments: async () => replies,
    },
  };
  return {
    run: (refresh) => depReviewCommand("11793", ["--repo", "remudero", ...(refresh === undefined ? [] : ["--dependabot-refresh", refresh])], deps),
    advance: (ms) => { now += ms; },
    setHead: (sha, c) => { head = sha; commits = c; },
    setRed: (value) => { red = value; },
    failComment: (value) => { commentFails = value; },
    failUpdate: (value) => { updateError = value; },
    setComments: (rows) => { replies = rows; },
    updates, root,
    forgetLedger: () => rmSync(ledgerPath, { force: true }),
    ledger: () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    comments, opened,
  };
}

test("W1-T9584: a stale held Dependabot head asks Dependabot to rebase once per head", async (t) => {
  // The sweep side: the SAME evidence decideBaseRed reads. Main red on a run whose census lacks the
  // head's red check is a wait (and the stand-down is recorded once); main green afterwards is a refresh.
  const h = sweepHarness([mainHealth("red")]);
  await h.run([redView()]);
  assert.deepEqual(h.refreshes, [{ kind: "wait", check: "coverage-ratchet" }]);
  const stoodDown = h.rows.filter((r) => r.step === BASE_RED_STOOD_DOWN_STEP);
  assert.equal(stoodDown.length, 1);
  assert.equal(stoodDown[0].check_name, "coverage-ratchet");
  await h.run([redView()]);
  assert.equal(h.rows.filter((r) => r.step === BASE_RED_STOOD_DOWN_STEP).length, 1, "the stand-down is recorded once per head");
  h.rows.push(mainHealth("green"));
  await h.run([redView()]);
  assert.deepEqual(h.refreshes.at(-1), { kind: "request", cause: "base-red-recovered", check: "coverage-ratchet" });
  assert.equal(h.rows.filter((r) => r.step === "sweep.disposed").at(-1)?.dependabot_refresh, "base-red-recovered");
  assert.deepEqual(dependabotRefreshVerdict({ kind: "own" }, ["test/x.test.ts"]),
    { kind: "request", cause: "fixed-on-main", check: "test/x.test.ts" }, "W1-T6405's fixed-on-main probe is stale-base evidence too");

  // The effect adapter carries a `request` verdict to the command as a flag, and nothing else does.
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9584-fx-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const commandArgs: string[][] = [];
  const effects = buildSweepEffects({ owner: "craigoley", repo: "remudero", config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "ledger.ndjson"), runId: "W1-T9584-fx", plan: { tasks: [], byId: new Map() } as Plan,
    policy: DEFAULT_SWEEP_POLICY, log: () => {}, contributorAdmissionImpl: async () => {},
    depReviewCommandImpl: async (_pr, rest = []) => { commandArgs.push(rest); return 1; } });
  await effects.depReview!(redView(), { kind: "request", cause: "base-red-recovered", check: "coverage-ratchet" });
  await effects.depReview!(redView(), { kind: "wait", check: "coverage-ratchet" });
  assert.deepEqual(commandArgs, [["--repo", "remudero", "--dependabot-refresh", "base-red-recovered"], ["--repo", "remudero"]]);

  assert.deepEqual([headCarriesForeignCommit([{ authors: [{ login: "dependabot[bot]" }] }]), DEPENDABOT_NOREPLY_EMAIL_RE.test(DEPENDABOT_AUTHOR.email),
    DEPENDABOT_NOREPLY_EMAIL_RE.test(FLEET_AUTHOR.email)], [false, true, false], "the fleet App's noreply address is not Dependabot's");
  assert.equal(dependabotRefreshCommand(undefined), DEPENDABOT_RECREATE_COMMAND, "unread commits fail toward recreate");
  assert.equal(dependabotRefreshCommand([{ authors: [] }]), DEPENDABOT_RECREATE_COMMAND);
  assert.equal(dependabotRefreshCommand([{ authors: [DEPENDABOT_AUTHOR] }]), DEPENDABOT_REBASE_COMMAND);
});

test("W1-T9994: a base-red Dependabot refresh uses the guarded update-branch, not a command", async (t) => {
  const f = commandFixture(t);
  assert.equal(await f.run("base-red-recovered"), 1);
  assert.deepEqual(f.updates, [{ prNumber: 11793, expectedHeadSha: HEAD }], "the update carries the head it judged as the expected head");
  assert.deepEqual(f.comments, [], "no @dependabot command is commented");
  const requested = f.ledger().filter((r) => r.step === "dep-review.refresh_requested");
  assert.equal(requested.length, 1);
  assert.equal(requested[0].via, "update-branch");
  assert.equal(requested[0].cause, "base-red-recovered");
  assert.equal(requested[0].head_sha, HEAD);
  assert.equal(requested[0].pr_number, 11793);
  f.advance(120_000);
  assert.equal(await f.run("base-red-recovered"), 1);
  assert.equal(f.updates.length, 1, "the same head is refreshed once");
  const unanswered = f.ledger().filter((r) => r.step === "dep-review.refresh_unanswered");
  assert.equal(unanswered.length, 1);
  assert.equal(unanswered[0].age_ms, 120_000);
  f.forgetLedger();
  await f.run("base-red-recovered");
  assert.equal(f.updates.length, 1, "a ledger rotation never refreshes twice: the head is recorded in the durable hold state");

  // The aged-hold backstop is unchanged (no new timeout) and its body names the refresh.
  f.advance(24 * 60 * 60 * 1000);
  await f.run("base-red-recovered");
  assert.equal(f.opened.length, 1);
  assert.match(f.opened[0].body, /guarded update-branch was applied/);

  // A NEW head re-earns judgement.
  f.setHead("e".repeat(40), [{ oid: "e", authors: [DEPENDABOT_AUTHOR] }]);
  await f.run("base-red-recovered");
  assert.deepEqual(f.updates.at(-1), { prNumber: 11793, expectedHeadSha: "e".repeat(40) });
  assert.equal(f.updates.length, 2);
  assert.deepEqual(f.comments, []);

  // Green checks on a refreshed head are not a hold: nothing more is attempted or reported.
  f.setRed(false);
  const before = f.ledger().length;
  assert.equal(await f.run("base-red-recovered"), 0);
  assert.equal(f.updates.length, 2);
  assert.equal(f.ledger().slice(before).filter((r) => String(r.step).startsWith("dep-review.refresh")).length, 0);
});

test("W1-T9994: a refused update-branch escalates once with the refusal quoted", async (t) => {
  const f = commandFixture(t);
  f.failUpdate("HTTP 422: merge conflict between base and head");
  assert.equal(await f.run("base-red-recovered"), 1);
  assert.equal(f.updates.length, 1);
  assert.equal(f.opened.length, 1);
  assert.match(f.opened[0].body, /update-branch of this head was refused or does not apply/);
  assert.match(f.opened[0].body, /merge conflict between base and head/);
  const failed = f.ledger().filter((r) => r.step === "dep-review.refresh_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].via, "update-branch");
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.refresh_requested").length, 0, "a refused refresh is not requested");
  f.advance(60_000);
  await f.run("base-red-recovered");
  await f.run("base-red-recovered");
  assert.equal(f.updates.length, 1, "a refused update-branch is not retried on this head");
  assert.equal(f.opened.length, 1, "the escalation is raised once per head");
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.refresh_escalated").length, 1);

  // An earlier command Dependabot refused is quoted beside the update-branch refusal.
  const g = commandFixture(t);
  g.failUpdate("HTTP 403");
  const statePath = join(g.root, "state", "dep-review-holds", "craigoley", "remudero", "PR11793.json");
  mkdirSync(join(statePath, ".."), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({ headSha: HEAD, heldSinceMs: NOW, asks: [], refreshes: [{
    headSha: HEAD, command: DEPENDABOT_REBASE_COMMAND, cause: "base-red-recovered", requestedAtMs: NOW - 3_600_000, delivered: true }] })}\n`);
  g.setComments([{ user: { login: "dependabot[bot]" }, created_at: new Date(NOW - 3_599_000).toISOString(),
    body: "Sorry, only users with push access can use that command.\n\nmore" }]);
  await g.run();
  assert.equal(g.opened.length, 1);
  assert.match(g.opened[0].body, /Sorry, only users with push access can use that command\./);
  assert.match(g.opened[0].body, /HTTP 403/);
});

test("W1-T9584: an own red on a Dependabot head posts no command", async (t) => {
  // Main green with no recorded base-red stand-down for this head: decideBaseRed says the red is the head's own.
  const green = sweepHarness([mainHealth("green")]);
  await green.run([redView()]);
  assert.deepEqual(green.refreshes, [{ kind: "own" }]);
  assert.equal(green.rows.filter((r) => r.step === "sweep.disposed").at(-1)?.dependabot_refresh, "own");
  // Main red, but main's run PASSES the head's failing check: the red is this head's, even beside main's red.
  const passing = sweepHarness([mainHealth("red", { observed_checks: ["ci", "coverage-ratchet"] })]);
  await passing.run([redView()]);
  assert.deepEqual(passing.refreshes, [{ kind: "own" }]);
  assert.equal(passing.rows.filter((r) => r.step === BASE_RED_STOOD_DOWN_STEP).length, 0);
  // A green Dependabot head carries no refresh field at all.
  const quiet = sweepHarness([mainHealth("green")]);
  await quiet.run([view()]);
  assert.equal(quiet.rows.filter((r) => r.step === "sweep.disposed").at(-1)?.dependabot_refresh, undefined);

  // The command, given no refresh cause (or one it does not know), comments nothing and records nothing.
  const f = commandFixture(t);
  assert.equal(await f.run(), 1);
  assert.equal(await f.run("not-a-cause"), 1);
  assert.deepEqual(f.comments, []);
  assert.equal(f.ledger().filter((r) => String(r.step).startsWith("dep-review.refresh")).length, 0);
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.decided").at(-1)?.decision, "hold", "the hold stands");
});

test("W1-T9584: invalid refresh history refuses to forget requested heads", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9584-invalid-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "hold.json");
  const prior = {
    headSha: HEAD, command: DEPENDABOT_REBASE_COMMAND, cause: "base-red-recovered",
    requestedAtMs: NOW, delivered: true,
  };
  const malformed = [
    { description: "non-array history", refreshes: { prior } },
    { description: "null record", refreshes: [prior, null] },
    { description: "invalid head", refreshes: [prior, { ...prior, headSha: 123 }] },
    { description: "invalid command", refreshes: [prior, { ...prior, command: null }] },
    { description: "invalid timestamp", refreshes: [prior, { ...prior, requestedAtMs: "yesterday" }] },
  ];
  for (const { description, refreshes } of malformed) {
    const saved = `${JSON.stringify({ headSha: HEAD, heldSinceMs: NOW, asks: [], refreshes })}\n`;
    writeFileSync(statePath, saved);
    const comments: string[] = [];
    const logs: string[] = [];
    await assert.rejects(() => reconcileDependabotRefresh({
      statePath, prNumber: 11793, headSha: HEAD, nowMs: NOW + 120_000,
      result: {
        decision: "hold", semverLevel: "patch", pinOnly: false, offendingFiles: [],
        redChecks: ["coverage-ratchet"], migrationBumps: [], reason: "checks are red",
      },
      cause: "base-red-recovered",
      updateBranch: async () => { comments.push("update-branch"); return { ok: true }; },
      readComments: async () => [], escalate: () => "https://example.test/issues/1",
      log: (step) => { logs.push(step); },
    }), { message: "invalid dependency refresh state; refusing to forget requested heads" }, description);
    assert.equal(readFileSync(statePath, "utf8"), saved, `${description}: preserve the durable history`);
    assert.deepEqual(comments, [], `${description}: never ask again with unreadable history`);
    assert.deepEqual(logs, [], `${description}: never claim a refresh outcome`);
  }
});

test("W1-T9929: the dep-review command arms past an advisory red and ledgers advisory_red", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9929-cmd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  let checks: Array<Record<string, string>> = [];
  let required: DepReviewRequired = { kind: "required", names: ["ci-gate", "commitlint", "remudero-review"] };
  const branches: string[] = [];
  const descriptions: string[] = [];
  const arms: string[] = [];
  const deps: DepReviewDeps = {
    config: { root, ledger: ledgerPath } as never,
    clock: clockFromMillisFn(() => NOW),
    gh: () => ({
      number: 11968, url: "https://github.com/craigoley/remudero/pull/11968",
      title: "chore(deps): bump example from 1.0.0 to 1.1.0", body: "", headRefOid: HEAD, baseRefName: "main",
      headRefName: "dependabot/github_actions/example-1.1.0", author: { login: "app/dependabot" }, statusCheckRollup: checks,
    }),
    prDiff: () => "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n",
    postStatus: (async (args) => { descriptions.push(args.description ?? ""); return { posted: true }; }) as DepReviewDeps["postStatus"],
    arm: (url) => { arms.push(url); return "armed"; },
    requiredChecks: async (branch) => { branches.push(branch); return required; },
    issues: { create: () => "https://github.com/craigoley/remudero/issues/1", listOpen: () => [], closeWithComment: () => {} },
    prMutations: { comment: () => {}, close: () => { throw new Error("never closes"); } },
  };
  const run = () => depReviewCommand("11968", ["--repo", "remudero"], deps);
  const decided = () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((r) => r.step === "dep-review.decided").at(-1);
  const scan = { name: "Scan", conclusion: "FAILURE" };

  checks = [{ name: "ci-gate", conclusion: "SUCCESS" }, { name: "commitlint", conclusion: "SUCCESS" }, scan];
  assert.equal(await run(), 0, "an advisory-only red arms");
  assert.deepEqual(arms, ["https://github.com/craigoley/remudero/pull/11968"]);
  assert.match(descriptions[0], /; advisory red: Scan$/, "the remudero-review description names the advisory red");
  assert.deepEqual(decided()?.advisory_red, ["Scan"]);
  assert.equal(decided()?.judged_against, "required");
  assert.equal(decided()?.required_fallback, undefined);
  assert.deepEqual(branches, ["main"], "the required set is read once per run, for the PR's base branch");

  // A pending advisory check never blocks the arm guard; a pending required one still does.
  checks = [{ name: "ci-gate", conclusion: "SUCCESS" }, { name: "commitlint", conclusion: "SUCCESS" }, { name: "Scan", status: "IN_PROGRESS" }];
  assert.equal(await run(), 0);
  checks = [{ name: "ci-gate", status: "IN_PROGRESS" }, { name: "commitlint", conclusion: "SUCCESS" }, scan];
  assert.equal(await run(), 1, "a pending required check holds the arm");
  assert.equal(arms.length, 2);

  checks = [{ name: "ci-gate", conclusion: "SUCCESS" }, { name: "commitlint", conclusion: "FAILURE" }, scan];
  assert.equal(await run(), 1, "a red required check still holds");
  assert.deepEqual(decided()?.redChecks, ["commitlint"]);
  assert.deepEqual(decided()?.advisory_red, ["Scan"]);

  required = { kind: "all-checks", fallback: "protection-unreadable:HTTP 403" };
  checks = [{ name: "ci-gate", conclusion: "SUCCESS" }, { name: "commitlint", conclusion: "SUCCESS" }, scan];
  assert.equal(await run(), 1, "an unreadable required set holds on every red");
  assert.equal(decided()?.judged_against, "all-checks");
  assert.equal(decided()?.required_fallback, "protection-unreadable:HTTP 403");
  assert.equal(arms.length, 2, "nothing armed past a fallback hold");

  // A legacy injected `gh` with no reader keeps today's hold-on-all, and says why.
  delete deps.requiredChecks;
  assert.equal(await run(), 1);
  assert.equal(decided()?.required_fallback, "required-reader-not-injected");
});

test("W1-T9929: the default required-set reader unions branch protection and ci-gate's REQUIRED", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9929-req-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "ci-gate.yml"),
    "jobs:\n  ci-gate:\n    env:\n      REQUIRED: '[\"ci\",\"commitlint\"]'\n");
  const reads: string[][] = [];
  const protection = async (args: string[]) => { reads.push(args); return JSON.stringify({ contexts: ["ci-gate", "remudero-review"] }); };
  assert.deepEqual(await readDepReviewRequiredChecks("craigoley", "remudero", "main", root, protection),
    { kind: "required", names: ["ci", "ci-gate", "commitlint", "remudero-review"] });
  assert.deepEqual(reads, [["api", "repos/craigoley/remudero/branches/main/protection/required_status_checks"]]);
  const refused = async () => { throw new Error("HTTP 403: Resource not accessible by integration"); };
  assert.deepEqual(await readDepReviewRequiredChecks("craigoley", "remudero", "main", root, refused),
    { kind: "all-checks", fallback: "protection-unreadable:HTTP 403: Resource not accessible by integration" });
});

test("W1-T9913: the dep-review command holds an armed head blocked by a stale event instead of re-posting", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9913-cmd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  let mergeStateStatus = "BLOCKED";
  const posts: string[] = [];
  const arms: string[] = [];
  const comments: string[] = [];
  const deps: DepReviewDeps = {
    config: { root, ledger: ledgerPath } as never,
    clock: clockFromMillisFn(() => NOW),
    gh: (args) => {
      const fields = String(args[args.indexOf("--json") + 1]).split(",");
      for (const field of ["baseRefName", "mergeStateStatus", "autoMergeRequest"]) {
        assert.ok(fields.includes(field), `the command requests ${field}`);
      }
      return {
        number: 11968, url: "https://github.com/craigoley/remudero/pull/11968",
        title: "chore(deps): bump example from 1.0.0 to 1.0.1", body: "", headRefOid: HEAD,
        headRefName: "dependabot/github_actions/example-1.0.1", author: { login: "app/dependabot" },
        mergeStateStatus, autoMergeRequest: { enabledAt: "2026-10-16T14:33:10Z" },
        statusCheckRollup: [
          { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-10-15T10:43:00Z", completedAt: "2026-10-15T11:03:00Z" },
          { name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-10-15T15:10:50Z", completedAt: "2026-10-15T15:30:00Z" },
          { context: "remudero-review", state: "SUCCESS", startedAt: "2026-10-16T14:33:00Z" },
          { name: "Scan", conclusion: "FAILURE" },
        ],
      };
    },
    requiredChecks: async () => ({ kind: "required", names: ["ci-gate", "remudero-review"] }),
    prDiff: () => "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n",
    postStatus: (async (args) => { posts.push(args.state); return { posted: true }; }) as DepReviewDeps["postStatus"],
    arm: (url) => { arms.push(url); return "armed"; },
    prMutations: { comment: (_url, body) => { comments.push(body); }, close: () => { throw new Error("never closes"); } },
  };
  const run = () => depReviewCommand("11968", ["--repo", "remudero"], deps);
  const ledger = () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(await run(), 1);
  assert.equal(await run(), 1);
  // W1-T9995: Dependabot refuses recreate from rmd; with no Actions port injected there is no re-run either.
  assert.deepEqual(comments, [], "the second sighting never asks Dependabot to recreate");
  assert.deepEqual(posts, [], "no review is re-posted on a stale-event block");
  assert.deepEqual(arms, [], "nothing is re-armed");
  assert.equal(ledger().filter((r) => r.step === "dep-review.stale_event.observed").length, 1);
  assert.equal(ledger().filter((r) => r.step === "dep-review.decided").at(-1)?.decision, "arm");
  assert.deepEqual(ledger().filter((r) => r.step === "dep-review.decided").at(-1)?.advisory_red, ["Scan"]);
  mergeStateStatus = "CLEAN";
  assert.equal(await run(), 0, "a head GitHub does not block takes the ordinary arm path");
  assert.deepEqual(posts, ["success"]);
});

// ── W1-T9995 — #11968 at 676bed094 (10-17): retitled, both pre-retitle reds (2026-10-16 16:44Z) still in the rollup.
const PR11968_HEAD = "676bed0941f224b2e03146f3cf339f7458f2eccb";
const TITLE_LINT_OLD = 38934326485;
const CI_OLD = 38934327039;
const COMMITLINT_JOB = 117085868891;

test("W1-T9995: the dep-review command re-runs an armed BLOCKED head's superseded red and never comments recreate", async (t) => {
  const c = rerunCommandFixture(t, { mergeStateStatus: "BLOCKED", armed: true });
  assert.equal(await c.run(), 1);
  assert.deepEqual(c.events, [`POST actions/runs/${TITLE_LINT_OLD}/rerun-failed-jobs`, `POST actions/runs/${CI_OLD}/rerun-failed-jobs`]);
  assert.equal(c.ledger("dep-review.stale_event.observed").length, 1);
  assert.equal(await c.run(), 1);
  assert.equal(c.events.length, 2, "the second sighting waits on the re-run it already requested");
  c.setRun(CI_OLD, { conclusion: "failure", run_attempt: 2 });
  assert.equal(await c.run(), 1);
  assert.equal(c.ledger("dep-review.superseded_red.rerun_red").length, 1);
  assert.equal(c.ledger("dep-review.stale_event.escalated").length, 1, "a red re-run escalates once");
  assert.equal(c.opened.length, 1);
  assert.equal(await c.run(), 1);
  assert.equal(c.opened.length, 1);
  assert.deepEqual(c.comments, [], `never ${DEPENDABOT_RECREATE_COMMAND}`);
  assert.equal(c.events.length, 2, "never a second re-run, and no review post or arm");
});

test("W1-T9995: the dep-review command re-runs a superseded red before it posts and arms, BLOCKED or not", async (t) => {
  // 10-17: #11968 was not yet armed, and the sweep read its mergeability "unknown".
  const c = rerunCommandFixture(t, { mergeStateStatus: "UNKNOWN", armed: false });
  assert.equal(await c.run(), 0);
  assert.deepEqual(c.events, [`POST actions/runs/${TITLE_LINT_OLD}/rerun-failed-jobs`, `POST actions/runs/${CI_OLD}/rerun-failed-jobs`,
    "post success", "arm"]);
  assert.equal(c.ledger("dep-review.superseded_red.rerun_requested").length, 2);
  assert.equal(c.ledger("dep-review.stale_event.observed").length, 0);
  assert.equal(await c.run(), 0);
  assert.equal(c.events.filter((e) => e.startsWith("POST")).length, 2, "once per head, across passes");

  // The re-run commitlint went red: the head now holds on it, and the hold pass confirms and escalates once.
  const h = rerunCommandFixture(t, { mergeStateStatus: "CLEAN", armed: false });
  await h.run();
  h.setRun(TITLE_LINT_OLD, { conclusion: "failure", run_attempt: 2 });
  h.setRollup((rollup) => [...rollup, { name: "commitlint", conclusion: "FAILURE", startedAt: "2026-10-17T03:24:00Z", completedAt: "2026-10-17T03:24:25Z" }]);
  assert.equal(await h.run(), 1);
  assert.equal(h.ledger("dep-review.superseded_red.rerun_red").length, 1);
  assert.equal(h.opened.length, 1);
  assert.match(h.opened[0].body, /re-run: red/);
  assert.equal(await h.run(), 1);
  assert.equal(h.opened.length, 1, "escalated on the pass the red was seen, not on every hold");
  h.corruptState();
  assert.equal(await h.run(), 1);
  assert.equal(h.ledger("dep-review.superseded_red.rerun_failed").at(-1)?.action, "confirm");

  // A legacy injected `gh` with no Actions port re-runs nothing and still arms.
  const legacy = rerunCommandFixture(t, { mergeStateStatus: "CLEAN", armed: false, port: false });
  assert.equal(await legacy.run(), 0);
  assert.deepEqual(legacy.events, ["post success", "arm"]);
});

test("W1-T9995: the default Actions port re-runs through a gh api POST", async () => {
  const reads: string[][] = [];
  const writes: string[][] = [];
  const port = defaultDepReviewActions("craigoley", "remudero", async (args) => { reads.push(args); return { workflow_runs: [] }; },
    async (args) => { writes.push(args); return ""; });
  assert.deepEqual(await port.runs(PR11968_HEAD), []);
  await port.rerun(`actions/runs/${CI_OLD}/rerun-failed-jobs`);
  assert.deepEqual(reads, [["api", `repos/craigoley/remudero/actions/runs?head_sha=${PR11968_HEAD}&per_page=100`]]);
  assert.deepEqual(writes, [["api", "-X", "POST", `repos/craigoley/remudero/actions/runs/${CI_OLD}/rerun-failed-jobs`]]);
});

/** depReviewCommand over #11968 at 676bed094 (10-17), retitled, with both pre-retitle reds still in the rollup. */
function rerunCommandFixture(t: TestContext, opts: { mergeStateStatus: string; armed: boolean; port?: false }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9995-cmd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const statePath = join(root, "state", "dep-review-holds", "craigoley", "remudero", "PR11968.json");
  let rollup: Array<Record<string, string>> = [
    { name: "commitlint", conclusion: "FAILURE", startedAt: "2026-10-16T16:44:39Z", completedAt: "2026-10-16T16:44:58Z" },
    { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-10-16T17:06:23Z", completedAt: "2026-10-16T17:16:56Z" },
    { name: "commitlint", conclusion: "SUCCESS", startedAt: "2026-10-16T22:54:34Z", completedAt: "2026-10-16T22:54:57Z" },
    { name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-10-16T22:54:35Z", completedAt: "2026-10-16T22:55:30Z" },
    ...(opts.armed ? [{ context: "remudero-review", state: "SUCCESS", startedAt: "2026-10-17T02:58:23Z" }] : []),
  ];
  const runs: DependabotHeadRun[] = [
    { id: 38978493953, path: ".github/workflows/pr-title-lint.yml", status: "completed", conclusion: "success", run_attempt: 1 },
    { id: 38978493967, path: ".github/workflows/ci-gate.yml", status: "completed", conclusion: "success", run_attempt: 1 },
    { id: CI_OLD, path: ".github/workflows/ci.yml", status: "completed", conclusion: "failure", run_attempt: 1 },
    { id: TITLE_LINT_OLD, path: ".github/workflows/pr-title-lint.yml", status: "completed", conclusion: "failure", run_attempt: 1 },
  ];
  const jobs: Record<number, Array<{ id: number; name: string; conclusion: string }>> = {
    [CI_OLD]: [{ id: 117087456422, name: "ci", conclusion: "success" }, { id: 117095262265, name: "ci-gate", conclusion: "failure" }],
    [TITLE_LINT_OLD]: [{ id: COMMITLINT_JOB, name: "commitlint", conclusion: "failure" }],
  };
  const events: string[] = [];
  const comments: string[] = [];
  const opened: Array<{ title: string; body: string }> = [];
  const issues: IssueGateway = {
    create(title, body) { opened.push({ title, body }); return `https://github.com/craigoley/remudero/issues/${9000 + opened.length}`; },
    listOpen() { return []; },
    closeWithComment() {},
  };
  const actions: DependabotActionsPort = {
    runs: async () => runs.map((r) => ({ ...r })),
    jobs: async (runId) => jobs[runId] ?? [],
    rerun: async (endpoint) => { events.push(`POST ${endpoint}`); },
  };
  const deps: DepReviewDeps = {
    config: { root, ledger: ledgerPath } as never,
    clock: clockFromMillisFn(() => Date.parse("2026-10-17T02:58:23Z")),
    gh: () => ({
      number: 11968, url: "https://github.com/craigoley/remudero/pull/11968",
      // W1-T9828 fitted it at 22:54:33Z, so the title is already the one commitlint passed.
      title: "chore(deps): bump google/osv-scanner-action/…/osv-scanner-reusable.yml from 2.6.0 to 2.7.0",
      body: "", headRefOid: PR11968_HEAD, headRefName: "dependabot/github_actions/google/osv-scanner-action-2.7.0",
      author: { login: "app/dependabot" }, mergeStateStatus: opts.mergeStateStatus,
      ...(opts.armed ? { autoMergeRequest: { enabledAt: "2026-10-17T02:58:49Z" } } : {}), statusCheckRollup: rollup,
    }),
    requiredChecks: async () => ({ kind: "required", names: ["ci-gate", "commitlint", "remudero-review"] }),
    prDiff: () => "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n",
    postStatus: (async (args) => { events.push(`post ${args.state}`); return { posted: true }; }) as DepReviewDeps["postStatus"],
    arm: () => { events.push("arm"); return "armed"; },
    issues,
    prMutations: { comment: (_url, body) => { comments.push(body); }, close: () => { throw new Error("never closes"); } },
    ...(opts.port === false ? {} : { actions }),
  };
  return {
    events, comments, opened,
    run: () => depReviewCommand("11968", ["--repo", "remudero"], deps),
    setRun: (id: number, over: Partial<DependabotHeadRun>) => { Object.assign(runs.find((r) => r.id === id)!, { status: "completed", ...over }); },
    setRollup: (edit: (r: typeof rollup) => typeof rollup) => { rollup = edit(rollup); },
    corruptState: () => { const s = JSON.parse(readFileSync(statePath, "utf8")); s.supersededReruns = [{}]; writeFileSync(statePath, JSON.stringify(s)); },
    ledger: (step: string) => readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.step === step),
  };
}

test("W1-T9994: the migrate branch ledgers a refused ignore command and still completes", async (t) => {
  const run = async (answer: DependabotIssueComment[] | "throw") => {
    const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9994-migrate-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const deps: DepReviewDeps = {
      config: { root, ledger: ledgerPath } as never,
      clock: clockFromMillisFn(() => NOW),
      gh: () => ({
        number: 3654, url: "https://github.com/craigoley/remudero/pull/3654",
        title: "build(deps-dev): bump @types/node from 22.20.1 to 26.4.0",
        body: "Bumps [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/node) from 22.20.1 to 26.4.0.",
        headRefOid: HEAD, author: { login: "app/dependabot" }, statusCheckRollup: [{ name: "ci-shard 1", conclusion: "FAILURE" }],
      }),
      prDiff: () => "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n",
      captureMigrationFeedback: (({ id }: { id: string }) => ({ id })) as never,
      prMutations: {
        comment: () => {}, close: () => {},
        comments: async () => { if (answer === "throw") throw new Error("comments unavailable"); return answer; },
      },
      issues: { create: () => "https://github.com/craigoley/remudero/issues/999", listOpen: () => [], closeWithComment() {} },
    };
    const realLog = console.log;
    console.log = () => {};
    try {
      assert.equal(await depReviewCommand("3654", ["--repo", "remudero"], deps), 0);
    } finally {
      console.log = realLog;
    }
    return readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  const refusal = { user: { login: "dependabot[bot]" }, created_at: new Date(NOW + 4_000).toISOString(),
    body: "Sorry, only users with push access can use that command." };
  const refused = await run([refusal]);
  const row = refused.find((l) => l.step === "dep-review.refresh_refused");
  assert.equal(row?.cause, "migrate");
  assert.equal(row?.command, "@dependabot ignore this major version");
  assert.equal(row?.reply, refusal.body);
  assert.equal(refused.some((l) => l.step === "dep-review.migrate.completed"), true);
  const unread = await run("throw");
  assert.equal(unread.some((l) => l.step === "dep-review.migrate.answer_unread"), true);
  assert.equal(unread.some((l) => l.step === "dep-review.refresh_refused"), false);
  assert.equal(unread.some((l) => l.step === "dep-review.migrate.completed"), true);
  assert.equal((await run([])).some((l) => l.step === "dep-review.refresh_refused"), false);
});
