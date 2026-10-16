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
  type DependabotRefreshVerdict,
  type DepReviewRequired,
} from "../src/lib/dep-review.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Plan } from "../src/lib/plan.js";
import { buildSweepEffects, depReviewCommand, readDepReviewRequiredChecks, type DepReviewDeps } from "../src/run-task.js";
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
} from "./helpers/sweep-test.js";

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
    },
  };
  return {
    run: (refresh) => depReviewCommand("11793", ["--repo", "remudero", ...(refresh === undefined ? [] : ["--dependabot-refresh", refresh])], deps),
    advance: (ms) => { now += ms; },
    setHead: (sha, c) => { head = sha; commits = c; },
    setRed: (value) => { red = value; },
    failComment: (value) => { commentFails = value; },
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

  // The command side: one comment per head, recorded durably, the rest of the passes say it is unanswered.
  const f = commandFixture(t);
  assert.equal(await f.run("base-red-recovered"), 1);
  assert.deepEqual(f.comments, [{ url: "https://github.com/craigoley/remudero/pull/11793", body: DEPENDABOT_REBASE_COMMAND }]);
  const requested = f.ledger().filter((r) => r.step === "dep-review.refresh_requested");
  assert.equal(requested.length, 1);
  assert.equal(requested[0].command, DEPENDABOT_REBASE_COMMAND);
  assert.equal(requested[0].cause, "base-red-recovered");
  assert.equal(requested[0].head_sha, HEAD);
  assert.equal(requested[0].pr_number, 11793);
  f.advance(120_000);
  assert.equal(await f.run("base-red-recovered"), 1);
  assert.equal(f.comments.length, 1, "the same head is never asked twice");
  const unanswered = f.ledger().filter((r) => r.step === "dep-review.refresh_unanswered");
  assert.equal(unanswered.length, 1);
  assert.equal(unanswered[0].age_ms, 120_000);
  assert.equal(unanswered[0].command, DEPENDABOT_REBASE_COMMAND);
  f.forgetLedger();
  await f.run("base-red-recovered");
  assert.equal(f.comments.length, 1, "a ledger rotation never re-asks: the head is recorded in the durable hold state");

  // The aged-hold backstop is unchanged (no new timeout) and its body names the request.
  f.advance(24 * 60 * 60 * 1000);
  await f.run("base-red-recovered");
  assert.equal(f.opened.length, 1);
  assert.match(f.opened[0].body, /@dependabot rebase/);
  assert.match(f.opened[0].body, /Refresh requested/);

  // A failed comment records nothing, so the next pass asks again.
  f.setHead("e".repeat(40), [{ oid: "e", authors: [DEPENDABOT_AUTHOR] }]);
  f.failComment(true);
  await f.run("base-red-recovered");
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.refresh_failed").length, 1);
  f.failComment(false);
  await f.run("base-red-recovered");
  assert.equal(f.comments.at(-1)?.body, DEPENDABOT_REBASE_COMMAND);
  assert.equal(f.comments.length, 2, "a NEW head re-earns judgement, and a failed ask is retried");

  // A head carrying the fleet's merge commit (#11793's 2d5030059) is edited: rebase is refused, so recreate.
  f.setHead("d".repeat(40), [{ oid: "x", authors: [DEPENDABOT_AUTHOR] }, { oid: "d", authors: [FLEET_AUTHOR] }]);
  await f.run("base-red-recovered");
  assert.equal(f.comments.at(-1)?.body, DEPENDABOT_RECREATE_COMMAND);
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.refresh_requested").at(-1)?.edited_head, true);
  assert.equal(headCarriesForeignCommit([{ authors: [{ login: "dependabot[bot]" }] }]), false);
  assert.equal(DEPENDABOT_NOREPLY_EMAIL_RE.test(DEPENDABOT_AUTHOR.email), true);
  assert.equal(DEPENDABOT_NOREPLY_EMAIL_RE.test(FLEET_AUTHOR.email), false, "the fleet App's noreply address is not Dependabot's");
  assert.equal(dependabotRefreshCommand(undefined), DEPENDABOT_RECREATE_COMMAND, "unread commits fail toward recreate");
  assert.equal(dependabotRefreshCommand([{ authors: [] }]), DEPENDABOT_RECREATE_COMMAND);

  // Green checks on a requested head are not a hold: nothing more is asked or reported.
  f.setRed(false);
  const before = f.ledger().length;
  assert.equal(await f.run("base-red-recovered"), 0);
  assert.equal(f.comments.length, 3);
  assert.equal(f.ledger().slice(before).filter((r) => String(r.step).startsWith("dep-review.refresh")).length, 0);
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

test("W1-T9584: invalid refresh history refuses to forget requested heads", (t) => {
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
    assert.throws(() => reconcileDependabotRefresh({
      statePath, prNumber: 11793, headSha: HEAD, nowMs: NOW + 120_000,
      result: {
        decision: "hold", semverLevel: "patch", pinOnly: false, offendingFiles: [],
        redChecks: ["coverage-ratchet"], migrationBumps: [], reason: "checks are red",
      },
      cause: "base-red-recovered", commits: [{ oid: HEAD, authors: [DEPENDABOT_AUTHOR] }],
      comment: (body) => { comments.push(body); },
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
