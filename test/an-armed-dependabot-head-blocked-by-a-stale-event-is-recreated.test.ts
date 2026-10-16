import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEPENDABOT_RECREATE_COMMAND,
  DEPENDABOT_STALE_EVENT_CAUSE,
  buildDepReviewStaleEventEscalation,
  dependabotStaleEventVerdict,
  reconcileDependabotOwnRed,
  reconcileDependabotStaleEvent,
  type DepReviewResult,
} from "../src/lib/dep-review.js";
import {
  DEFAULT_SWEEP_POLICY,
  depReviewDedupStandsAside,
  runSweep,
  supersededRedsNowPassing,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";

// #11968 at f102d2d75: commitlint and ci-gate FAILED on 10-15 (old title), then passed in runs of a later event.
const PR11968_ROLLUP = [
  { name: "commitlint", conclusion: "FAILURE", startedAt: "2026-10-15T10:41:00Z", completedAt: "2026-10-15T10:42:00Z" },
  { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-10-15T10:43:00Z", completedAt: "2026-10-15T11:03:00Z" },
  { name: "commitlint", conclusion: "SUCCESS", startedAt: "2026-10-15T15:10:50Z", completedAt: "2026-10-15T15:11:40Z" },
  { name: "ci-gate", conclusion: "SUCCESS", startedAt: "2026-10-15T15:10:50Z", completedAt: "2026-10-15T15:30:00Z" },
  { context: "remudero-review", state: "SUCCESS", startedAt: "2026-10-16T14:33:00Z" },
];
const HEAD = "f102d2d7503c18b8e77cd5f28be32e78a32a156c";
const NEW_HEAD = "676bed0941f224b2e03146f3cf339f7458f2eccb";

const supersededReds = (rollup: typeof PR11968_ROLLUP): string[] => supersededRedsNowPassing(rollup).sort();

test("W1-T9913: a superseded red under an armed, blocked head is a stale-event block", () => {
  const blocked = { mergeStateStatus: "BLOCKED", autoMergeArmed: true, reviewPosted: true, supersededReds: supersededReds(PR11968_ROLLUP) };
  assert.deepEqual(dependabotStaleEventVerdict(blocked), { kind: "stale-event", checks: ["ci-gate", "commitlint"] });
  assert.deepEqual(dependabotStaleEventVerdict({ ...blocked, mergeStateStatus: "CLEAN" }), { kind: "none" }, "GitHub is not blocking");
  assert.deepEqual(dependabotStaleEventVerdict({ ...blocked, autoMergeArmed: false }), { kind: "none" }, "the lane has not armed it");
  assert.deepEqual(dependabotStaleEventVerdict({ ...blocked, reviewPosted: false }), { kind: "none" }, "the review is still to post");
  const latestRed = [...PR11968_ROLLUP, { name: "ci-gate", conclusion: "FAILURE", startedAt: "2026-10-15T16:00:00Z", completedAt: "2026-10-15T16:20:00Z" }];
  assert.deepEqual(supersededReds(latestRed), ["commitlint"], "a red that is still the newest run is no stale event");
  const pending = [...PR11968_ROLLUP, { name: "ci-gate", conclusion: "", status: "IN_PROGRESS", startedAt: "2026-10-15T16:00:00Z" }];
  assert.deepEqual(supersededReds(pending as typeof PR11968_ROLLUP), ["commitlint"], "a re-run still in flight is not a pass");
  assert.deepEqual(dependabotStaleEventVerdict({ ...blocked, supersededReds: [] }), { kind: "none" });
});

test("W1-T9913: a stale-event block asks Dependabot to recreate once per head, on its second sighting", (t) => {
  const f = fixture(t);
  assert.equal(f.run(HEAD), "observed", "the first sighting only records the head");
  assert.deepEqual(f.comments, []);
  assert.equal(f.run(HEAD), "requested");
  assert.deepEqual(f.comments, [DEPENDABOT_RECREATE_COMMAND]);
  const state = f.state() as { refreshes: Array<Record<string, unknown>> };
  assert.deepEqual(state.refreshes.map((r) => [r.headSha, r.command, r.cause, r.delivered]),
    [[HEAD, DEPENDABOT_RECREATE_COMMAND, DEPENDABOT_STALE_EVENT_CAUSE, true]]);
  assert.equal(f.run(HEAD), "awaiting-dependabot", "the same head is never asked twice");
  assert.equal(f.comments.length, 1);
  const rows = f.rows.filter((r) => r.step === "dep-review.stale_event.recreate_requested");
  assert.deepEqual(rows, [{ step: "dep-review.stale_event.recreate_requested", pr_number: 11968, head_sha: HEAD,
    stale_checks: ["ci-gate", "commitlint"], command: DEPENDABOT_RECREATE_COMMAND }]);

  const failing = fixture(t, { failComment: true });
  failing.run(HEAD);
  assert.equal(failing.run(HEAD), "failed");
  assert.deepEqual((failing.state() as { refreshes: unknown[] }).refreshes, [], "a failed ask records nothing, so the next pass asks again");
  assert.equal(failing.rows.filter((r) => r.step === "dep-review.stale_event.failed").length, 1);
});

test("W1-T9913: a stale-event block after a delivered recreate escalates instead of recreating again", (t) => {
  const f = fixture(t);
  f.run(HEAD);
  f.run(HEAD);
  assert.equal(f.run(NEW_HEAD), "observed");
  assert.equal(f.run(NEW_HEAD), "escalated");
  assert.equal(f.run(NEW_HEAD), "escalated");
  assert.equal(f.comments.length, 1, "the recreated head is not recreated again");
  assert.equal(f.escalations, 1, "one ask per head");
  assert.equal(f.rows.filter((r) => r.step === "dep-review.stale_event.escalated").length, 1);
  const e = buildDepReviewStaleEventEscalation({ prUrl: "https://github.com/craigoley/remudero/pull/11968", prNumber: 11968,
    title: "chore(deps): bump x", headSha: NEW_HEAD, checks: ["ci-gate"] });
  assert.equal(e.taskId, "dep-review-stale-event-PR11968");
  assert.equal(e.headSha, NEW_HEAD);

  const unsent = fixture(t, { escalation: undefined });
  unsent.run(HEAD);
  unsent.run(HEAD);
  unsent.run(NEW_HEAD);
  assert.equal(unsent.run(NEW_HEAD), "failed", "an undelivered ask is retried");
  const thrown = fixture(t, { escalationThrows: true });
  thrown.run(HEAD);
  thrown.run(HEAD);
  thrown.run(NEW_HEAD);
  assert.equal(thrown.run(NEW_HEAD), "failed");
  assert.equal(thrown.rows.filter((r) => r.step === "dep-review.stale_event.failed").length, 1);

  // A stale-event recreate is not a base-red refresh: own-red never reads it as a refresh that survived.
  const hold: DepReviewResult = { decision: "hold", semverLevel: "patch", pinOnly: false, offendingFiles: [], redChecks: ["ci"],
    migrationBumps: [], reason: "required check(s) not green: ci" };
  const ownRed = reconcileDependabotOwnRed({ statePath: f.statePath, owner: "craigoley", repo: "remudero",
    prUrl: "https://github.com/craigoley/remudero/pull/11968", prNumber: 11968, title: "chore(deps): bump x from 1.0.0 to 1.0.1",
    body: "", headSha: NEW_HEAD, result: hold, signal: "unclassified", nowMs: 5, capture: () => ({ id: "fb" }), log: () => {} });
  assert.equal(ownRed, "none");
});

test("W1-T9913: the terminal dep-review dedup stands aside for an armed blocked head and a new head re-earns it", async () => {
  assert.equal(depReviewDedupStandsAside({ autoMergeArmed: true, mergeableState: "blocked" }), true);
  assert.equal(depReviewDedupStandsAside({ autoMergeArmed: false, mergeableState: "blocked" }), false);
  assert.equal(depReviewDedupStandsAside({ autoMergeArmed: true, mergeableState: "clean" }), false);

  const rows: Record<string, unknown>[] = [];
  const reviewed: string[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: "/nonexistent-rmd-w1-t9913/ledger.ndjson", runId: "W1-T9913-sweep", now: () => Date.parse("2026-10-16T18:00:00Z"),
    readLedger: () => rows.slice(),
    appendLine: (_path, row) => { rows.push({ ...row, ts: "2026-10-16T18:00:00Z" }); },
    depReview: (pr) => { reviewed.push(pr.headSha); return "arm"; },
  };
  const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
    prNumber: 11968, prUrl: "https://github.com/craigoley/remudero/pull/11968", headSha: HEAD,
    headRefName: "dependabot/github_actions/actions-minor-and-patch-0123", isDependabot: true,
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-10-16T17:00:00Z", autoMergeArmed: false, mergeState: "clean", changedFiles: [".github/workflows/scan.yml"], ...over,
  });
  await runSweep([pr()], deps, DEFAULT_SWEEP_POLICY);
  await runSweep([pr()], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(reviewed, [HEAD], "a terminal arm dedups the same head");
  await runSweep([pr({ autoMergeArmed: true, mergeableState: "blocked" })], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(reviewed, [HEAD, HEAD], "an armed head GitHub still blocks is reviewed again");
  await runSweep([pr({ headSha: NEW_HEAD })], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(reviewed, [HEAD, HEAD, NEW_HEAD], "a recreated head re-earns its review");
});

function fixture(t: { after(fn: () => void): void },
  opts: { failComment?: boolean; escalation?: string | undefined; escalationThrows?: boolean } = { escalation: "https://github.com/craigoley/remudero/issues/1" }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9913-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "dep-review-holds", "craigoley", "remudero", "PR11968.json");
  const comments: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  let escalations = 0;
  let now = 1_000;
  return {
    statePath, comments, rows,
    get escalations() { return escalations; },
    state: () => JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>,
    run: (headSha: string) => reconcileDependabotStaleEvent({
      statePath, prNumber: 11968, headSha, checks: ["ci-gate", "commitlint"], nowMs: (now += 1_000),
      comment: (body) => { if (opts.failComment) throw new Error("comment unavailable"); comments.push(body); },
      escalate: () => { if (opts.escalationThrows) throw new Error("issues unavailable"); escalations += 1; return opts.escalation; },
      log: (step, extra) => { rows.push({ step, ...extra }); },
    }),
  };
}
