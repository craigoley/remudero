/**
 * W1-T9913 found the stale-event block: an armed Dependabot head GitHub still BLOCKS on a red an older event's run
 * left behind. W1-T9995 replaces its remedy. Dependabot refuses `@dependabot recreate` from rmd (W1-T9994), so the
 * block is cleared by re-running that old run of a live-reading check, and escalated once when the re-run is red,
 * cannot clear it, or the check reads the frozen event payload.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  DEPENDABOT_RECREATE_COMMAND,
  buildDepReviewStaleEventEscalation,
  dependabotStaleEventVerdict,
  reconcileDependabotStaleEvent,
  type SupersededRerunOutcome,
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

test("W1-T9995: a stale-event block re-runs the superseded run instead of commenting recreate", (t) => {
  // The second sighting rides the re-run lane's outcome; the reconciler has no comment port at all. The command-level
  // half (#11968's armed BLOCKED head re-runs both old runs) is in test/a-held-dependabot-pr-is-refreshed-by-dependabot.test.ts.
  const f = fixture(t);
  const rerun = (kind: SupersededRerunOutcome["kind"]): SupersededRerunOutcome => ({ kind, checks: ["ci-gate", "commitlint"] });
  assert.equal(f.run(HEAD, rerun("requested")), "observed", "the first sighting only records the head");
  assert.equal(f.run(HEAD, rerun("requested")), "rerun");
  assert.deepEqual(f.rows.filter((r) => r.step === "dep-review.stale_event.rerun_requested").map((r) => r.rerun_checks), [["ci-gate", "commitlint"]]);
  assert.equal(f.run(HEAD, rerun("pending")), "awaiting-rerun");
  assert.equal(f.run(HEAD, rerun("failed")), "failed", "an unrecorded re-run is retried, never escalated");
  assert.equal(f.run(HEAD, rerun("unavailable")), "failed");
  assert.equal(f.escalations, 0);
  assert.equal(f.run(HEAD, rerun("red")), "escalated", "a red re-run escalates");
  assert.equal(f.run(HEAD, rerun("red")), "escalated");
  assert.equal(f.escalations, 1, "once per head");
  for (const kind of ["verified", "unselected"] as const) {
    const g = fixture(t);
    g.run(HEAD, rerun(kind));
    assert.equal(g.run(HEAD, rerun(kind)), "escalated", `${kind}: the re-run cannot clear a block GitHub still holds`);
  }
  // A check that reads the frozen event payload is never re-run, so its block escalates on the second sighting.
  const payload = fixture(t);
  payload.run(HEAD, rerun("none"), ["acceptance-author-gate"]);
  assert.equal(payload.run(HEAD, rerun("requested"), ["acceptance-author-gate", "commitlint"]), "escalated");
  assert.deepEqual(payload.rows.find((r) => r.step === "dep-review.stale_event.escalated")?.payload_checks, ["acceptance-author-gate"]);
  const unsent = fixture(t, { escalation: undefined });
  unsent.run(HEAD, rerun("red"));
  assert.equal(unsent.run(HEAD, rerun("red")), "failed", "an undelivered ask is retried");
  const thrown = fixture(t, { escalationThrows: true });
  thrown.run(HEAD, rerun("red"));
  assert.equal(thrown.run(HEAD, rerun("red")), "failed");
  assert.equal(thrown.rows.filter((r) => r.step === "dep-review.stale_event.failed").length, 1);
  const e = buildDepReviewStaleEventEscalation({ prUrl: "https://github.com/craigoley/remudero/pull/11968", prNumber: 11968,
    title: "chore(deps): bump x", headSha: NEW_HEAD, checks: ["ci-gate"], rerun: "red" });
  assert.equal(e.taskId, "dep-review-stale-event-PR11968");
  assert.equal(e.headSha, NEW_HEAD);
  assert.match(e.detail, /re-run: red/);
  assert.ok(e.options.some((o) => o.label === e.recommendation));

  assert.ok(!JSON.stringify(f.rows).includes(DEPENDABOT_RECREATE_COMMAND), "no outcome is a recreate comment");
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

function fixture(t: TestContext,
  opts: { escalation?: string | undefined; escalationThrows?: boolean } = { escalation: "https://github.com/craigoley/remudero/issues/1" }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9913-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "dep-review-holds", "craigoley", "remudero", "PR11968.json");
  const rows: Array<Record<string, unknown>> = [];
  let escalations = 0;
  let now = 1_000;
  return {
    statePath, rows,
    get escalations() { return escalations; },
    run: (headSha: string, rerun: SupersededRerunOutcome, checks: string[] = ["ci-gate", "commitlint"]) => reconcileDependabotStaleEvent({
      statePath, prNumber: 11968, headSha, checks, rerun, nowMs: (now += 1_000),
      escalate: () => { if (opts.escalationThrows) throw new Error("issues unavailable"); escalations += 1; return opts.escalation; },
      log: (step, extra) => { rows.push({ step, ...extra }); },
    }),
  };
}
