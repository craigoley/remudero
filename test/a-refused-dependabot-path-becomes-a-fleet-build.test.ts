/**
 * W1-T9797 — A REFUSED DEPENDABOT PATH BECOMES A FLEET BUILD.
 *
 * 2026-10-15T23:52Z: #12191 (mcp 1.29.0 -> 1.30.0 in /.github/semgrep) was refused because its diff touched
 * .github/semgrep/requirements.txt, outside the manifest allowlist. The refuse arm printed one line and filed
 * nothing; the sweep dedups every outcome but hold, so the PR sat 12 h behind a generic stage-stall issue.
 * The bump also needed a companion test edit no bot branch can carry, so the remedy is W1-T9586's owned-build
 * proposal, never a wider allowlist.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { prioritizeDepReviewRepairs, reconcileDependabotRefusedPath, type DepReviewResult } from "#src/lib/dep-review.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Plan } from "../src/lib/plan.js";
import { buildSweepEffects, depReviewCommand, type DepReviewDeps } from "./helpers/run-task-test.js";
import { DEFAULT_SWEEP_POLICY, type OpenPrView } from "./helpers/sweep-test.js";

const NOW = Date.parse("2026-10-15T23:52:00.000Z");
const HEAD = "1da14b29fee7376616bb5a3016add44ea355aad9";
const TITLE = "chore(deps): bump mcp from 1.29.0 to 1.30.0 in /.github/semgrep";
const BODY = "Bumps the pip group with 1 update in the /.github/semgrep directory: mcp.\n\nUpdates `mcp` from 1.29.0 to 1.30.0\n";
const LOCK = ".github/semgrep/requirements.txt";
const DIFF = `diff --git a/${LOCK} b/${LOCK}\n--- a/${LOCK}\n+++ b/${LOCK}\n@@ -30 +30 @@\n-mcp==1.29.0\n+mcp==1.30.0\n`;
const DEPENDABOT_COMMIT = { oid: HEAD, authors: [{ login: "", name: "dependabot[bot]" }] };

interface Pr { login: string; title: string; body: string; commits: Array<{ oid: string; authors: Array<{ login: string; name: string }> }> }

interface Fixture {
  run: () => Promise<number>;
  pr: Pr;
  root: string;
  ledgerPath: string;
  deps: DepReviewDeps;
  captures: Array<{ id: string; raw: string; submissionKey: string }>;
  failCapture: (fail: boolean) => void;
  comments: string[];
  ledger: () => Record<string, unknown>[];
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-refused-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const pr: Pr = { login: "app/dependabot", title: TITLE, body: BODY, commits: [DEPENDABOT_COMMIT] };
  let captureFails = false;
  const captures: Fixture["captures"] = [];
  const comments: string[] = [];
  const issues: IssueGateway = { create: () => assert.fail("a refused path opens no issue"), listOpen: () => [], closeWithComment() {} };
  const deps: DepReviewDeps = {
    config: { root, ledger: ledgerPath } as never,
    clock: clockFromMillisFn(() => NOW),
    gh: () => ({
      number: 12191, url: "https://github.com/craigoley/remudero/pull/12191", title: pr.title, body: pr.body, headRefOid: HEAD,
      headRefName: "dependabot/pip/dot-github/semgrep/pip-0c88ea3f4b", author: { login: pr.login },
      statusCheckRollup: [{ name: "head-identity-gate", conclusion: "FAILURE" }], commits: pr.commits,
    }),
    prDiff: () => DIFF,
    postStatus: (async () => assert.fail("a refuse posts no status")) as never,
    arm: () => assert.fail("a refuse never arms"),
    issues,
    captureMigrationFeedback: ((args: { id: string; raw: string; submissionKey: string }) => {
      if (captureFails) throw new Error("feedback store unavailable");
      captures.push({ id: args.id, raw: args.raw, submissionKey: args.submissionKey });
      return { id: args.id };
    }) as never,
    prMutations: {
      comment: (_url, body) => { comments.push(body); },
      close: () => { throw new Error("a refused-path proposal never closes the Dependabot PR"); },
    },
  };
  return {
    run: () => depReviewCommand("12191", ["--repo", "remudero"], deps),
    pr, root, ledgerPath, deps, captures, comments,
    failCapture: (fail) => { captureFails = fail; },
    ledger: () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
}

function view(): OpenPrView {
  return {
    prNumber: 12191, prUrl: "https://github.com/craigoley/remudero/pull/12191", headSha: HEAD,
    headRefName: "dependabot/pip/dot-github/semgrep/pip-0c88ea3f4b", isDependabot: true, reviewState: "none", checksState: "red",
    ciFailures: [{ name: "head-identity-gate", logTail: "" }], unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-10-15T22:44:00.000Z", autoMergeArmed: false, mergeState: "clean", changedFiles: [LOCK],
  };
}

/** The sweep's real depReview effect over the fixture's real command and ledger. */
function sweepOutcome(f: Fixture): Promise<string | void> {
  const effects = buildSweepEffects({ owner: "craigoley", repo: "remudero", config: { root: f.root, claudeBin: "/bin/true" } as Config,
    ledgerPath: f.ledgerPath, runId: "refused-path-sweep", plan: { tasks: [], byId: new Map() } as Plan,
    policy: DEFAULT_SWEEP_POLICY, log: () => {}, contributorAdmissionImpl: async () => {},
    depReviewCommandImpl: (pr, rest) => depReviewCommand(pr, rest, f.deps) });
  return effects.depReview!(view(), undefined, undefined) as Promise<string | void>;
}

test("W1-T9797 a refused dependabot path files one owned-build proposal", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run(), 2, "still a refuse: nothing is posted or armed");
  assert.equal(f.captures.length, 1, "one owned-build proposal");
  const [proposal] = f.captures;
  assert.match(proposal.id, /^fb-dep-review-[0-9a-f]{16}$/);
  assert.match(proposal.raw, /Dependabot PR #12191/);
  assert.match(proposal.raw, /outside the lane's allowlist: \.github\/semgrep\/requirements\.txt\./);
  assert.match(proposal.raw, /Bumps: mcp 1\.29\.0 -> 1\.30\.0/);
  assert.match(proposal.raw, new RegExp(`Head: ${HEAD}`));
  assert.match(proposal.raw, /owned task branch/);
  assert.equal(proposal.submissionKey, "dep-review:own-red:craigoley/remudero:mcp@1.30.0",
    "the W1-T9586 key, so a later own-red proposal for the same target folds in");
  assert.deepEqual(f.comments, [], "no @dependabot command is posted");
  const captured = f.ledger().filter((r) => r.step === "dep-review.refused_path.feedback_captured");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].pr_number, 12191);
  assert.equal(captured[0].head_sha, HEAD);
  assert.equal(captured[0].feedback_id, proposal.id);
  assert.deepEqual(captured[0].offending_files, [LOCK]);
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.decided").at(-1)?.decision, "refuse");

  // A second pass on the same head files nothing new, and the sweep reads a settled refuse.
  assert.equal(await f.run(), 2);
  assert.equal(f.captures.length, 1, "the same bump never files a second proposal");
  assert.deepEqual(f.ledger().filter((r) => r.step === "dep-review.refused_path.folded").map((r) => r.feedback_id), [proposal.id]);
  assert.equal(await sweepOutcome(f), "refuse");
  assert.equal(f.captures.length, 1);
});

test("W1-T9797 an unsettled or unproposable refuse is never a silent terminal dedup", async (t) => {
  const f = fixture(t);
  f.failCapture(true);
  assert.equal(await sweepOutcome(f), "hold", "an unfiled remedy reads as hold, so the next sweep pass re-runs it");
  const decided = f.ledger().filter((r) => r.step === "dep-review.decided");
  assert.deepEqual(decided.map((r) => r.decision), ["refuse", "hold"]);
  assert.equal(decided.at(-1)?.review_decision, "refuse");
  assert.match(String(f.ledger().find((r) => r.step === "dep-review.refused_path.capture_failed")?.error), /feedback store unavailable/);
  assert.equal(f.captures.length, 0);
  f.failCapture(false);
  assert.equal(await sweepOutcome(f), "refuse", "the retry files the proposal and settles");
  assert.equal(f.captures.length, 1);

  // Unproposable refuses stay plain refuses, each with its reason on the record and nothing filed.
  for (const [label, edit, reason] of [
    ["non-Dependabot author", (pr: Pr) => { pr.login = "craigoley"; }, "non-dependabot-author"],
    ["foreign commit on the bot branch", (pr: Pr) => { pr.commits = [DEPENDABOT_COMMIT, { oid: "f".repeat(40), authors: [{ login: "craigoley", name: "Craig" }] }]; }, "foreign-commit"],
    ["no parseable bump", (pr: Pr) => { pr.title = "chore(deps): bump the pip group"; pr.body = ""; }, "unkeyed"],
  ] as const) {
    const g = fixture(t);
    edit(g.pr);
    assert.equal(await g.run(), 2, label);
    assert.equal(g.captures.length, 0, `${label}: nothing filed`);
    assert.deepEqual(g.ledger().filter((r) => r.step === "dep-review.refused_path.not_proposed").map((r) => r.reason), [reason], label);
  }
});


test("an aged refused-path repair receives exact-head priority after capture and fold", async t => {
  const f = fixture(t);
  assert.equal(await f.run(), 2);
  const id = f.captures[0].id;
  const candidates = ["older-incident", id];
  const snapshot = { owner: "craigoley", repo: "remudero", asOfMs: NOW, prs: [{
    prNumber: 12191, headSha: HEAD, headRefName: "dependabot/pip/semgrep", checksState: "red" as const,
    createdAt: new Date(NOW - 7200000).toISOString(),
  }] };
  const stateRoot = join(f.root, "state");
  const dir = join(stateRoot, "dep-review-holds", "craigoley", "remudero");
  const path = join(dir, "PR12191.json");
  assert.deepEqual(await prioritizeDepReviewRepairs(candidates, stateRoot, snapshot, NOW), [id, "older-incident"]);
  assert.deepEqual(candidates, ["older-incident", id]);
  const original = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...original, preserved: { identity: "keep" } }));
  assert.equal(await f.run(), 2);
  assert.equal(f.captures.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).preserved, { identity: "keep" });
  for (const changed of [
    { ...snapshot, asOfMs: NOW - 300001 },
    { ...snapshot, prs: [{ ...snapshot.prs[0], headSha: "different" }] },
    { ...snapshot, prs: [{ ...snapshot.prs[0], checksState: "pending" as const }] },
    { ...snapshot, prs: [{ ...snapshot.prs[0], createdAt: new Date(NOW - 3599999).toISOString() }] },
  ]) assert.deepEqual(await prioritizeDepReviewRepairs(candidates, stateRoot, changed, NOW), candidates);
  assert.deepEqual(await prioritizeDepReviewRepairs(["older-incident"], stateRoot, snapshot, NOW), ["older-incident"]);
  rmSync(path);
  assert.deepEqual(await prioritizeDepReviewRepairs(candidates, stateRoot, snapshot, NOW), candidates);
  assert.equal(await f.run(), 2, "the normal folded producer reconstructs a missing binding");
  assert.equal(f.captures.length, 1, "binding recovery captures no new proposal");
  assert.deepEqual(await prioritizeDepReviewRepairs(candidates, stateRoot, snapshot, NOW), [id, "older-incident"]);
});

test("a folded refused-path repair binds each observed PR and refuses corrupt local state", async t => {
  const f = fixture(t);
  assert.equal(await f.run(), 2);
  const id = f.captures[0].id;
  const stateRoot = join(f.root, "state");
  const dir = join(stateRoot, "dep-review-holds", "craigoley", "remudero");
  const bind = (prNumber: number) => reconcileDependabotRefusedPath({
    registryDir: dir, owner: "craigoley", repo: "remudero", prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`, title: TITLE, body: BODY,
    headSha: HEAD, author: { login: "app/dependabot" }, commits: [DEPENDABOT_COMMIT],
    result: { decision: "refuse", redChecks: ["ci"], offendingFiles: [LOCK] } as DepReviewResult,
    capture: () => assert.fail("a folded bump is not captured twice"), nowMs: NOW, log: () => {},
  });
  assert.equal(bind(12192), "folded");
  const registry = JSON.parse(readFileSync(join(dir, "own-red-proposals.json"), "utf8"));
  assert.deepEqual(registry.proposals[0].prNumbers, [12191, 12192]);
  const candidates = ["older-incident", id];
  const snapshot = { owner: "craigoley", repo: "remudero", asOfMs: NOW, prs: [{
    prNumber: 12192, headSha: HEAD, headRefName: "dependabot/pip/semgrep", checksState: "red" as const,
    createdAt: new Date(NOW - 7200000).toISOString(),
  }] };
  assert.deepEqual(await prioritizeDepReviewRepairs(candidates, stateRoot, snapshot, NOW), [id, "older-incident"]);
  const corrupt = join(dir, "PR12193.json");
  writeFileSync(corrupt, "unreadable state");
  assert.equal(bind(12193), "failed");
  assert.equal(readFileSync(corrupt, "utf8"), "unreadable state");
  rmSync(corrupt);
  assert.equal(bind(12193), "folded");
  assert.equal(f.captures.length, 1);
  const healthy = JSON.parse(readFileSync(join(dir, "PR12192.json"), "utf8"));
  for (const [prNumber, invalid] of [
    [12194, { ...healthy, asks: "not-an-array" }],
    [12195, { ...healthy, refusedPathRepair: { ...healthy.refusedPathRepair, headSha: 42 } }],
    [12196, { ...healthy, refusedPathRepair: { ...healthy.refusedPathRepair, feedbackId: "fb-other-repair" } }],
  ] as const) {
    const statePath = join(dir, `PR${prNumber}.json`);
    const bytes = JSON.stringify(invalid);
    writeFileSync(statePath, bytes);
    assert.equal(bind(prNumber), "failed", `PR${prNumber}: invalid or contradictory identity refuses`);
    assert.equal(readFileSync(statePath, "utf8"), bytes, "refusal preserves the exact prior evidence");
  }
  assert.equal(f.captures.length, 1, "invalid bindings never capture another proposal");
});
