/**
 * W1-T12955 — A REFUSED DEPENDABOT PR GETS A FULL REVIEW INSTEAD OF A NEEDS-HUMAN ISSUE.
 *
 * 2026-11-14 to 2026-11-15: #18405 (setuptools 84.0.0 to 84.1.0 in .github/semgrep/build-requirements.txt,
 * plus two test files) was refused 11 times. Its head carried repair commits, so the W1-T9797 owned-build
 * proposal was not filed (foreign-commit), and the sweep disposed it to the dep-review lane 223 times while
 * issue #18409 waited on the operator. The refused PR now goes to the full review.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { decideDepReview, isDependencyDeclarationPath, isManifestPath } from "#src/lib/dep-review.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import type { Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { buildSweepEffects, depReviewCommand, type DepReviewDeps } from "#test/helpers/run-task-test.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

const NOW = Date.parse("2026-11-15T18:25:00.000Z");
const PR = 18405;
const URL = `https://github.com/craigoley/remudero/pull/${PR}`;
const HEAD = "5d4e1f0b2c3a49e8b7f6a5d4c3b2a1908f7e6d5c";
const TITLE = "chore(deps): bump setuptools from 84.0.0 to 84.1.0 in /.github/semgrep";
const BODY = "Bumps the pip group with 1 update in the /.github/semgrep directory: setuptools.\n\n" +
  "Updates `setuptools` from 84.0.0 to 84.1.0\n";
const DIGEST = "c".repeat(64);
const LOCK = ".github/semgrep/build-requirements.txt";
const TESTS = ["test/review/semgrep-dependency-bumps-14094.test.ts", "test/review/semgrep-setuptools-trust-before-lock-12716.test.ts"];
const DIFF = [LOCK, ...TESTS].map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-84.0.0\n+84.1.0\n`).join("");
const DEPENDABOT_COMMIT = { oid: HEAD, authors: [{ login: "", name: "dependabot[bot]" }] };
const REPAIR_COMMIT = { oid: "f".repeat(40), authors: [{ login: "craigoley", name: "Craig" }] };

interface Fixture {
  root: string;
  ledgerPath: string;
  deps: DepReviewDeps;
  commits: Array<typeof DEPENDABOT_COMMIT>;
  created: string[];
  captures: Array<{ id: string; raw: string }>;
  run: (rest?: string[]) => Promise<number>;
  ledger: () => Record<string, unknown>[];
}

function fixture(t: TestContext, commits = [DEPENDABOT_COMMIT, REPAIR_COMMIT]): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}refused-full-review-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const created: string[] = [];
  const captures: Fixture["captures"] = [];
  const issues: IssueGateway = {
    create: (title) => { created.push(title); return `https://github.com/craigoley/remudero/issues/${90000 + created.length}`; },
    listOpen: () => [], closeWithComment() {},
  };
  const deps: DepReviewDeps = {
    config: { root, ledger: ledgerPath } as never,
    clock: clockFromMillisFn(() => NOW),
    gh: () => ({
      number: PR, url: URL, title: TITLE, body: BODY, headRefOid: HEAD,
      headRefName: "dependabot/pip/dot-github/semgrep/setuptools-84.1.0", author: { login: "app/dependabot" },
      statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }], commits,
    }),
    prDiff: () => DIFF,
    postStatus: (async () => assert.fail("a refuse posts no status")) as never,
    arm: () => assert.fail("the dep-review lane never arms a refused PR"),
    issues,
    captureMigrationFeedback: ((args: { id: string; raw: string }) => {
      captures.push({ id: args.id, raw: args.raw });
      return { id: args.id };
    }) as never,
    prMutations: { comment: () => {}, close: () => assert.fail("a refused PR is never closed by this lane") },
  };
  return {
    root, ledgerPath, deps, commits, created, captures,
    run: (rest = []) => depReviewCommand(String(PR), ["--repo", "remudero", ...rest], deps),
    ledger: () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
}

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR, prUrl: URL, headSha: HEAD, headRefName: "dependabot/pip/dot-github/semgrep/setuptools-84.1.0",
    isDependabot: true, reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-11-15T18:00:00.000Z", autoMergeArmed: false, mergeState: "clean", changedFiles: [LOCK, ...TESTS],
    reviewInputDigest: DIGEST, ...over,
  };
}

/** The sweep's real effects over the fixture's real dep-review command, ledger and issue gateway. */
function effects(f: Fixture, issues?: IssueGateway) {
  return buildSweepEffects({ owner: "craigoley", repo: "remudero", config: { root: f.root, claudeBin: "/bin/true" } as Config,
    ledgerPath: f.ledgerPath, runId: "refused-full-review", plan: { tasks: [], byId: new Map() } as Plan,
    policy: DEFAULT_SWEEP_POLICY, log: () => {}, contributorAdmissionImpl: async () => {},
    depReviewCommandImpl: (pr, rest) => depReviewCommand(pr, rest, f.deps), ...(issues ? { issuesImpl: issues } : {}) });
}

interface SweepRecord { postReviews: number; depReviews: string[][]; fixes: number; arms: number; retired: number; rows: Record<string, unknown>[] }

/** One runSweep pass over `lines` plus whatever this pass appends; the effects named here only count. */
async function sweepPass(f: Fixture, pr: OpenPrView, lines: Record<string, unknown>[], depReview?: SweepDeps["depReview"]): Promise<SweepRecord> {
  const record: SweepRecord = { postReviews: 0, depReviews: [], fixes: 0, arms: 0, retired: 0, rows: [] };
  const sweepLedger = join(f.root, "state", `sweep-${Math.random().toString(16).slice(2)}.ndjson`);
  const deps: SweepDeps = {
    arm: () => { record.arms++; }, close: () => assert.fail("a routed PR is never closed"),
    dispatchFix: () => { record.fixes++; }, escalate: () => {},
    ledgerPath: sweepLedger, runId: "refused-full-review-sweep", now: () => NOW,
    readLedger: () => lines,
    depReview: depReview ?? (async (p) => { record.depReviews.push([String(p.prNumber), p.reviewState]); return "refuse"; }),
    postReview: async () => { record.postReviews++; },
    retireDepReviewRefusedAsk: async () => { record.retired++; },
  };
  await runSweep([pr], deps);
  record.rows = readFileSync(sweepLedger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return record;
}

const disposed = (r: SweepRecord) => r.rows.find((row) => row.step === "sweep.disposed" && row.pr_number === PR);
// The review lane keys a task-less PR's verdict as PR-<n> with the exact input digest (reviewLedgerKeyFor).
const delivered = (state: "success" | "failure") => ({ step: "review.posted", task_id: `PR-${PR}`, head_sha: HEAD, pr_url: URL, state,
  review_input_digest: DIGEST,
  ts: "2026-11-15T18:20:00.000Z" });

test("W1-T12955 criterion 1: a refuse with no owned-build proposal is routed to the full review and opens no needs-human issue", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run(), 2, "still a refuse: nothing is posted or armed");
  const decided = f.ledger().filter((r) => r.step === "dep-review.decided");
  assert.deepEqual(decided.map((r) => [r.decision, r.route]), [["refuse", undefined], ["refuse", "review"]]);
  assert.equal(decided.at(-1)?.head_sha, HEAD);
  assert.deepEqual(decided.at(-1)?.offendingFiles, [LOCK, ...TESTS]);
  assert.deepEqual(f.ledger().filter((r) => r.step === "dep-review.refused_path.not_proposed").map((r) => r.reason), ["foreign-commit"]);
  assert.deepEqual(f.created, [], "no needs-human escalation issue is opened");
  assert.equal(f.captures.length, 0, "no owned-build proposal before the review");
  assert.equal(await effects(f).depReview!(view(), undefined, undefined), "route-review",
    "the sweep's real effect reads the routed refuse as a non-terminal outcome");
});

test("W1-T12955 criterion 2: the next sweep pass disposes the routed PR as post-review and runs the review once", async (t) => {
  const f = fixture(t);
  await f.run();
  const lines = [...f.ledger(), { step: "sweep.disposed", acted: true, pr_number: PR, head_sha: HEAD, disposition: "dep-review",
    dep_review_outcome: "route-review" }];
  const first = await sweepPass(f, view(), lines);
  const row = disposed(first);
  assert.equal(row?.disposition, "post-review");
  assert.equal(row?.blocker, "awaiting-review");
  assert.equal(row?.blocker_owner, "review-lane");
  assert.equal(first.postReviews, 1, "the review command runs for this head");
  assert.deepEqual(first.depReviews, [], "the dep-review lane is not run again");
  const second = await sweepPass(f, view(), [...lines, ...first.rows, delivered("failure")]);
  assert.equal(second.postReviews, 0, "a delivered verdict is never reviewed again at the same head");

  // Without the route row, the same PR stays with the dep-review lane.
  const plain = await sweepPass(f, view(), f.ledger().filter((r) => r.route !== "review"));
  assert.equal(disposed(plain)?.disposition, "dep-review");
  assert.equal(plain.postReviews, 0);
});

test("W1-T12955 criterion 3: a routed PR arms only on a delivered pass and green checks; a failure files the rebuild", async (t) => {
  const routed = { dependabotReviewRouted: true };
  const now = NOW;
  assert.equal(deriveDisposition(view({ reviewState: "success" }), DEFAULT_SWEEP_POLICY, now, { ...routed, reviewVerdictDelivered: true }).disposition, "mergeable");
  assert.notEqual(deriveDisposition(view({ reviewState: "success" }), DEFAULT_SWEEP_POLICY, now, { ...routed, reviewVerdictDelivered: false }).disposition, "mergeable",
    "a success status with no delivered verdict does not arm");
  for (const checksState of ["red", "pending"] as const) {
    assert.equal(deriveDisposition(view({ reviewState: "success", checksState }), DEFAULT_SWEEP_POLICY, now, { ...routed, reviewVerdictDelivered: true }).disposition,
      "dep-review", `checks ${checksState}: never armed`);
  }
  assert.equal(deriveDisposition(view({ reviewState: "success", mergeState: "dirty" }), DEFAULT_SWEEP_POLICY, now, { ...routed, reviewVerdictDelivered: true }).disposition,
    "dep-review", "a dirty head is never armed and never escalated by the generic conflict rows");
  assert.equal(deriveDisposition(view({ reviewState: "pending", reviewPendingSince: "2026-11-15T18:24:00.000Z" }), DEFAULT_SWEEP_POLICY, now, routed).disposition,
    "wait", "a fresh review in flight is waited on");
  const failing = view({ reviewState: "failure", unmetCriteria: [{ criterion: "no acceptance criteria", reason: "fail closed" }] as never });
  assert.equal(deriveDisposition(failing, DEFAULT_SWEEP_POLICY, now, { ...routed, reviewVerdictDelivered: true }).disposition, "dep-review",
    "a failing verdict stays above every fix row");

  // Through runSweep and the real dep-review command: the failure files the W1-T9797 proposal for the foreign-commit head.
  const f = fixture(t);
  await f.run();
  const pass = await sweepPass(f, failing, [...f.ledger(), delivered("failure")], effects(f).depReview);
  assert.equal(disposed(pass)?.disposition, "dep-review");
  assert.equal(pass.fixes, 0, "no fix round is dispatched onto the Dependabot branch");
  assert.equal(pass.arms, 0);
  assert.equal(f.captures.length, 1, "the failing review files one owned-build proposal (a rebuild)");
  assert.match(f.captures[0].raw, /Bumps: setuptools 84\.0\.0 -> 84\.1\.0/);
  const decided = f.ledger().filter((r) => r.step === "dep-review.decided");
  assert.equal(decided.at(-1)?.route, undefined, "the newest row is a plain refuse, so the PR is no longer routed");
  assert.equal(disposed(pass)?.dep_review_outcome, "refuse", "a terminal outcome: the next pass dedups it");
  const next = await sweepPass(f, failing, [...f.ledger(), delivered("failure"), ...pass.rows]);
  assert.equal(disposed(next)?.disposition, "dep-review");
  assert.deepEqual(next.depReviews, [], "deduped at this head");
  assert.equal(next.fixes + next.arms + next.postReviews, 0);
});

test("W1-T12955 criterion 4: a delivered full review closes only the PR's dep-review-refused issue, naming the review", async (t) => {
  const f = fixture(t);
  const open: OpenIssue[] = [
    { number: 18409, url: "https://github.com/craigoley/remudero/issues/18409", title: "[BLOCKED] dep-review-refused-PR18405 ...",
      body: "**Task:** dep-review-refused-PR18405\n**PR:** #18405\n" },
    { number: 18412, url: "https://github.com/craigoley/remudero/issues/18412", title: "PR stage stalled: #18405",
      body: "**Task:** dep-review-PR18405\n" },
    { number: 18499, url: "https://github.com/craigoley/remudero/issues/18499", title: "[BLOCKED] dep-review-refused-PR184050",
      body: "**Task:** dep-review-refused-PR184050\n" },
  ];
  const closed: Array<[string, string]> = [];
  const labels: string[] = [];
  const issues: IssueGateway = { create: () => assert.fail("no issue is opened"),
    listOpen: (label) => { labels.push(label); return open; }, closeWithComment: (url, comment) => { closed.push([url, comment]); } };
  await effects(f, issues).retireDepReviewRefusedAsk!(view({ reviewState: "failure" }));
  assert.deepEqual(labels, ["needs-human"]);
  assert.deepEqual(closed.map(([url]) => url), ["https://github.com/craigoley/remudero/issues/18409"], "no other open issue is closed");
  assert.match(closed[0][1], /full review at head 5d4e1f0b2c3a49e8b7f6a5d4c3b2a1908f7e6d5c: remudero-review failure/);
  const retired = f.ledger().filter((r) => r.step === "dep-review.refused_ask.retired");
  assert.deepEqual(retired.map((r) => [r.pr_number, r.head_sha, r.issue_urls]), [[PR, HEAD, ["https://github.com/craigoley/remudero/issues/18409"]]]);

  // runSweep calls it once per head, after the verdict is delivered, and never before.
  const g = fixture(t);
  await g.run();
  const before = await sweepPass(g, view(), g.ledger());
  assert.equal(before.retired, 0, "no verdict yet: the ask stays");
  const after = await sweepPass(g, view({ reviewState: "success" }), [...g.ledger(), delivered("success")], async () => "refuse");
  assert.equal(after.retired, 1, "a delivered verdict at this head retires the ask");
  const again = await sweepPass(g, view({ reviewState: "success" }), [...g.ledger(), delivered("success"), ...retired], async () => "refuse");
  assert.equal(again.retired, 0, "the retired row at this head stops a second close");
});

test("W1-T12955 criterion 5: a refuse whose owned-build proposal is captured keeps that route", async (t) => {
  const f = fixture(t, [DEPENDABOT_COMMIT]);
  assert.equal(await f.run(), 2);
  assert.equal(f.captures.length, 1, "the W1-T9797 proposal is filed");
  const decided = f.ledger().filter((r) => r.step === "dep-review.decided");
  assert.deepEqual(decided.map((r) => [r.decision, r.route]), [["refuse", undefined]], "no route row");
  assert.equal(await effects(f).depReview!(view(), undefined, undefined), "refuse");
  const pass = await sweepPass(f, view(), f.ledger());
  assert.equal(disposed(pass)?.disposition, "dep-review");
  assert.equal(pass.postReviews, 0);
});

test("W1-T12955 criterion 6: the manifest allowlist keeps the Semgrep runtime locks outside it", () => {
  for (const path of [".github/semgrep/requirements.txt", LOCK]) {
    assert.equal(isManifestPath(path, () => "{}"), false, path);
    assert.equal(isDependencyDeclarationPath(path, () => "{}"), false, path);
  }
  assert.equal(isManifestPath("requirements.txt"), true, "a root pip lock is still a manifest");
  const result = decideDepReview({ author: { login: "app/dependabot" }, title: TITLE, body: BODY,
    diff: `diff --git a/${LOCK} b/${LOCK}\n--- a/${LOCK}\n+++ b/${LOCK}\n@@ -1 +1 @@\n-84.0.0\n+84.1.0\n`,
    checks: [{ name: "ci", conclusion: "SUCCESS" }], required: { kind: "all-checks", fallback: "required-reader-not-injected" } });
  assert.equal(result.decision, "refuse", "a lock-only Semgrep bump is refused, so it is routed to the full review, never armed here");
});
