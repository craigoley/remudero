import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  runEscalationReconcile,
  type EscalationReconcileCandidate,
  type OpenPrView,
} from "../src/lib/sweep.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { buildEscalationReconcileCandidates } from "../src/run-task.js";
import type { GitHub, PrRef } from "../src/lib/status.js";

/**
 * THE CLARIFICATION RUNG MANUFACTURED 57 UNRETIRABLE ISSUES IN ONE DAY.
 *
 * Every one titled `… PR <url> needs a clarification — not positively mergeable — checks pending,
 * review none — escalating`, and 53 of them stamped `**Task:** UNKNOWN`. Measured against the live
 * repo, the escalation reconciler's population on the same set was **0** — it was not declining to
 * close them, it never enumerated them.
 *
 * THREE STACKED DEFECTS, and the first is not what it looks like:
 *
 *  1. A bound for pending checks ALREADY EXISTED (W1-T114) and was INERT. Its rows require
 *     `pendingAgeMinutes(pr, now) !== undefined`, which reads `checksPendingSince` — a field with
 *     six references in `src/`, all in sweep.ts, and NOT ONE of them a write. So every pending PR
 *     was undatable, both rows failed their guard, and everything fell to the terminal escalate.
 *  2. `taskId: pr.taskId ?? "UNKNOWN"` — an untrailered operator-lane PR got a non-id.
 *  3. `plan.byId.get("UNKNOWN")` is undefined, so the reconciler's `!task` guard dropped all 53.
 *
 * These tests lock the fix at all three points, and — the part that actually matters — prove the
 * ROUND TRIP: an id that makes an issue enumerable but underivable would turn a visible orphan into
 * an invisible one, which is worse than doing nothing.
 */

/** A minimal open-PR view. Field-for-field the shape `buildOpenPrViews` produces. */
function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1038,
    prUrl: "https://github.com/craigoley/remudero/pull/1038",
    taskId: undefined,
    headSha: "de96a291cef04f0367f7bfd70898051ea400960b",
    headRefName: "plan/file-session-harvest",
    reviewState: "none",
    checksState: "pending",
    mergeState: "blocked",
    lastActivityAt: new Date().toISOString(),
    ...over,
  } as OpenPrView;
}

const NOW = Date.parse("2026-07-31T21:50:00.000Z");
const mins = (n: number) => new Date(NOW - n * 60_000).toISOString();

test("a PR whose checks are pending and whose head is younger than the ceiling does NOT escalate", () => {
  // THE REGRESSION. Before the fix this exact shape produced `blocked-ambiguous` and an issue.
  const d = deriveDisposition(pr({ lastActivityAt: mins(6) }), DEFAULT_SWEEP_POLICY, NOW);

  // ASSERT THE ABSENCE OF THE ESCALATE PATH, not merely that the code ran: `blocked-ambiguous` is
  // the ONLY disposition that reaches the clarification rung's `escalate` closure, so a `wait`
  // here is the absence of the escalate call, structurally.
  assert.equal(d.disposition, "wait");
  assert.notEqual(d.disposition, "blocked-ambiguous");
  assert.match(d.reason, /checks pending 6m \(< 60m ceiling\) — waiting/);
});

test("a genuinely ambiguous PR past the ceiling STILL escalates — W1-T78's purpose survives", () => {
  // THE PRESERVATION LOCK. W1-T78 exists because a PR that is not positively mergeable, with no
  // actionable unmet criterion and no fix-rung strike, really does need a human — and the
  // alternative is a PR nobody is ever told about. Bounding the transient case must not remove it.
  const stale = deriveDisposition(pr({ lastActivityAt: mins(61) }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(stale.disposition, "blocked-ambiguous", "past the ceiling, pending IS ambiguity");
  assert.match(stale.reason, /stale-pending — checks pending 61m \(>= 60m ceiling\) — escalating/);

  // And the terminal catch-all still catches a shape that is not pending at all and not
  // failure-shaped — the case that has no earlier row and must never fall through to mergeable.
  const undatable = deriveDisposition(
    pr({ checksState: "pending", lastActivityAt: "not-a-timestamp" }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );
  assert.equal(undatable.disposition, "blocked-ambiguous", "state we cannot date is still escalated, never silently waited");
});

test("PR 1038's real recorded shape does not escalate, while PR 921's 7h45m shape still does", () => {
  // REPLAYED FROM THE RECORD, not invented. #1038's checks were pending at 21:44 and green-and-
  // merged by 21:50 — six minutes. #921 sat with no progress for 7h45m and genuinely needed a human.
  // A discriminator that cannot separate these is not a discriminator.
  const t1038 = deriveDisposition(pr({ prNumber: 1038, lastActivityAt: mins(6) }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(t1038.disposition, "wait", "#1038 resolved on its own — escalating it was the defect");

  const t921 = deriveDisposition(
    pr({ prNumber: 921, lastActivityAt: mins(7 * 60 + 45) }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );
  assert.equal(t921.disposition, "blocked-ambiguous", "#921 was genuinely stuck — it must still escalate");
  assert.match(t921.reason, /stale-pending/);
});

/** A plan with one real task, so `plan.byId` behaves exactly as it does live. */
function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "cn-plan-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(
    path,
    `- id: W1-REAL
  title: a real task
  repo: remudero
  type: implement
  depends_on: []
  acceptance:
    - claim: a
      proof: unit test
  verify: auto
  status: queued
`,
  );
  return loadPlan(path);
}

/** A GitHub gateway answering `prByRef` for exactly the numbers seeded. */
function gatewayFor(refs: Record<number, PrRef | null>): GitHub {
  return {
    prByRef: (r: string | number) => refs[Number(String(r).replace(/^.*\//, ""))] ?? null,
    findMergedByTrailer: () => null,
    prBody: () => undefined,
    headRefName: () => undefined,
    autoMergeArmed: () => false,
    issueByUrl: () => null,
  } as unknown as GitHub;
}

test("an escalation for an untrailered PR carries a resolvable identity the reconciler can enumerate", () => {
  // The issue body the fixed clarification rung now writes: `PR-<n>`, never "UNKNOWN".
  const issue = {
    number: 1039,
    url: "https://github.com/craigoley/remudero/issues/1039",
    body: "**Class:** BLOCKED\n**Task:** PR-1038\n**Run:** DAEMON-1785527315947\n",
  };
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "cn-ledger-")), "ledger.ndjson");
  writeFileSync(ledgerPath, "");

  const cands = buildEscalationReconcileCandidates(
    "craigoley",
    "remudero",
    fixturePlan(),
    ledgerPath,
    undefined,
    {
      issues: { listOpen: () => [issue] } as never,
      github: gatewayFor({ 1038: { number: 1038, url: "https://github.com/craigoley/remudero/pull/1038", state: "MERGED" } as PrRef }),
    },
  );

  // ENUMERATED — the whole point. Before the fix this list was empty for every one of the 53.
  assert.equal(cands.length, 1, "the PR referent is enumerable; `UNKNOWN` never was");
  assert.equal(cands[0].taskId, "PR-1038", "the identity is the synthetic id the review lane already mints");
  assert.equal(cands[0].derived.merged, true, "and it RESOLVES — enumerable but underivable would be worse than nothing");
  assert.equal(cands[0].derived.source, "pr-referent");
  assert.equal(cands[0].issueNumber, 1039);

  // A body that is neither a plan task nor a PR referent is still left alone — genuinely human.
  const human = buildEscalationReconcileCandidates("craigoley", "remudero", fixturePlan(), ledgerPath, undefined, {
    issues: { listOpen: () => [{ ...issue, body: "**Task:** UNKNOWN\n" }] } as never,
    github: gatewayFor({}),
  });
  assert.equal(human.length, 0, "the old UNKNOWN stamp is still unenumerable — only newly-minted ids are recoverable");
});

test("THE ROUND TRIP: a merged untrailered PR's issue is enumerated AND closed by the reconciler", async () => {
  // The proof the second trap demands. Mint the identity, run the REAL reconciler, and show the
  // referent actually closes — offline, against fixtures. Nothing on the live repo is touched.
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "cn-rt-")), "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const cands = buildEscalationReconcileCandidates(
    "craigoley",
    "remudero",
    fixturePlan(),
    ledgerPath,
    undefined,
    {
      issues: {
        listOpen: () => [
          { number: 1039, url: "https://github.com/craigoley/remudero/issues/1039", body: "**Task:** PR-1038\n" },
        ],
      } as never,
      github: gatewayFor({ 1038: { number: 1038, url: "https://github.com/craigoley/remudero/pull/1038", state: "MERGED" } as PrRef }),
    },
  );

  const closedUrls: string[] = [];
  const summary = await runEscalationReconcile(cands, {
    closeIssue: (url: string) => closedUrls.push(url),
    ledgerPath,
    runId: "TEST-RT",
  } as never);

  assert.equal(summary.total, 1, "the population is no longer empty");
  assert.equal(summary.closed, 1, "and the issue is actually retired");
  assert.deepEqual(closedUrls, ["https://github.com/craigoley/remudero/issues/1039"]);

  const line = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).at(-1)!;
  assert.equal(line.task_id, "PR-1038", "the ledger records the same identity, so the trail is one id end to end");
});

test("an OPEN untrailered PR's issue is enumerated but LEFT LIVE, and an unreadable one is left indeterminate", async () => {
  // The two negative halves of the round trip — without these, "it closes things" is not a fix,
  // it is a shredder.
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "cn-neg-")), "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const issues = { listOpen: () => [{ number: 1039, url: "u/1039", body: "**Task:** PR-1038\n" }] } as never;

  const open = buildEscalationReconcileCandidates("craigoley", "remudero", fixturePlan(), ledgerPath, undefined, {
    issues,
    github: gatewayFor({ 1038: { number: 1038, url: "p/1038", state: "OPEN" } as PrRef }),
  });
  assert.equal(open[0].derived.merged, false);
  assert.equal(open[0].derived.closed, false);
  const openSummary = await runEscalationReconcile(open, { closeIssue: () => { throw new Error("must not close a live PR"); }, ledgerPath, runId: "T" } as never);
  assert.equal(openSummary.closed, 0, "a live PR's escalation is a live decision — never swept off the board");

  // A gateway that cannot answer must yield indeterminate, never a confident "not merged".
  const dark = buildEscalationReconcileCandidates("craigoley", "remudero", fixturePlan(), ledgerPath, undefined, {
    issues,
    github: gatewayFor({}),
  });
  assert.equal(dark[0].derived.indeterminate, true, "unreadable is not the same as unmerged");
  const darkSummary = await runEscalationReconcile(dark, { closeIssue: () => { throw new Error("must not close on a failed read"); }, ledgerPath, runId: "T" } as never);
  assert.equal(darkSummary.closed, 0);
});
