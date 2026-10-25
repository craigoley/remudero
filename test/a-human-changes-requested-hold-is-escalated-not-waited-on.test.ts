import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildOpenPrViews } from "../src/run-task.js";
import { reviewInputDigest } from "../src/lib/review.js";
import { classifyChangesRequested, pullReviewsRestArgs } from "../src/lib/open-prs-rest.js";
import {
  changesRequestedHold,
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  openPrsBehindMain,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";

/*
 * craigoley/remudero #13851, #13895 and #13952 (2026-10-25): every required context green, remudero-review
 * success, auto-merge armed, `mergeable: true`, and still `mergeable_state: "blocked"` — because a reviewer's
 * standing verdict was CHANGES_REQUESTED. The scanner-blocker read saw no alert and no inline thread, so the
 * sweep read the PR as `mergeable`; re-arming changed nothing, and #13851's positive distance pressed
 * update-branch after every main move (four CI cycles in a day). Nothing ever said a person was holding it.
 */

const OWNER = "craigoley";
const REPO = "remudero";
const PR = 13952;
const TASK = "W1-T9578";
const HEAD = "4f437816b2b1969af534ea8a8285dd120c7fda52";
const OLD_HEAD = "623985af57a3833b99cf8ca53d376e0fef3a6229";
const MERGE = "f0e1d2c3b4a5968778695a4b3c2d1e0f98765432";
const BRANCH = `run-${TASK}-1792839891250`;
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR}`;
const BODY = `Remudero-Task: ${TASK}`;
const NOW = Date.parse("2026-10-25T12:00:00Z");

function review(login: string, state: string, commit = OLD_HEAD, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 5641056801, state, commit_id: commit, submitted_at: "2026-10-25T02:03:09Z", user: { login, type: "User" }, ...over };
}

const FLEET_REVIEW = { id: 1, state: "COMMENTED", commit_id: HEAD, user: { login: "remudero-fleet[bot]", type: "Bot" } };

function sceneFetch(over: { reviews?: unknown; aheadBy?: number; seen?: string[] } = {}): (args: string[]) => unknown {
  return (args) => {
    const path = args[args.length - 1] ?? "";
    over.seen?.push(path);
    if (/pulls\?state=open/.test(path)) {
      return [{
        number: PR, html_url: PR_URL, head: { ref: BRANCH, sha: HEAD },
        updated_at: "2026-10-25T11:00:00.000Z", // expiring-fixture: exempt -- aged only against this suite's injected NOW, never the wall clock
        body: BODY, auto_merge: { merge_method: "squash" }, draft: false, state: "open",
      }];
    }
    if (path.includes("/check-runs")) {
      return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success", started_at: "2026-10-25T10:00:00Z", completed_at: "2026-10-25T10:05:00Z" }] };
    }
    if (path.endsWith(`/commits/${HEAD}/status`)) {
      return { statuses: [{ context: "remudero-review", state: "success", created_at: "2026-10-25T10:10:00Z", updated_at: "2026-10-25T10:10:00Z" }] }; // expiring-fixture: exempt -- aged only against this suite's injected NOW, never the wall clock
    }
    if (path.endsWith(`/pulls/${PR}`)) return { mergeable: true, mergeable_state: "blocked", merge_commit_sha: MERGE, head: { sha: HEAD } };
    if (path.includes(`/pulls/${PR}/reviews`)) return over.reviews ?? [FLEET_REVIEW, review("cao825", "CHANGES_REQUESTED")];
    if (path.includes("/compare/")) return { ahead_by: over.aheadBy ?? 0 };
    return [];
  };
}

function producedViews(fetch: (args: string[]) => unknown): { views: OpenPrView[]; rows: Record<string, unknown>[] } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-changes-requested-"));
  try {
    const rows: Record<string, unknown>[] = [{
      ts: "2026-10-25T10:11:00.000Z", step: "review.posted", task_id: TASK, head_sha: HEAD, pr_url: PR_URL,
      review_input_digest: reviewInputDigest(HEAD, BODY),
    }];
    const path = join(dir, "rows.ndjson");
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const views = buildOpenPrViews(OWNER, REPO, path, {
      fetch, requiredContexts: () => ["ci-gate"], readMainPlan: () => ({ tasks: [], byId: new Map() }),
    });
    return { views, rows };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sweepDeps(prior: Record<string, unknown>[]): { deps: SweepDeps; events: string[]; escalated: string[] } {
  const events: string[] = [];
  const escalated: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const deps: SweepDeps = {
    arm: () => { events.push("arm"); },
    close: () => {},
    dispatchFix: () => { events.push("dispatch"); },
    escalate: (_pr, reason) => { escalated.push(reason); },
    ledgerPath: "/nonexistent/rmd-changes-requested/rows.ndjson",
    runId: "SWEEP-CHANGES-REQUESTED",
    now: () => NOW,
    readLedger: () => [...prior, ...rows],
    appendLine: (_path, row) => { rows.push(row); },
  };
  return { deps, events, escalated };
}

test("a reviewer's standing CHANGES_REQUESTED is a hold; a later approval, a dismissal or a bot's review is not", () => {
  const held = classifyChangesRequested({ headSha: HEAD }, [review("cao825", "CHANGES_REQUESTED"), review("cao825", "COMMENTED")]);
  assert.equal(held?.kind, "changes-requested");
  assert.deepEqual(held?.kind === "changes-requested" ? held.holds.map((h) => [h.login, h.commitId]) : [], [["cao825", OLD_HEAD]]);
  assert.equal(classifyChangesRequested({ headSha: HEAD }, [review("cao825", "CHANGES_REQUESTED"), review("cao825", "APPROVED", HEAD)]), undefined);
  assert.equal(classifyChangesRequested({ headSha: HEAD }, [review("cao825", "DISMISSED")]), undefined);
  assert.equal(classifyChangesRequested({ headSha: HEAD }, [{ ...FLEET_REVIEW, state: "CHANGES_REQUESTED" }]), undefined);
  assert.equal(classifyChangesRequested({ headSha: HEAD }, []), undefined);
});

test("an unreadable review listing is named, never read as no hold", () => {
  assert.equal(classifyChangesRequested({ headSha: HEAD }, { message: "Not Found" })?.kind, "ambiguous");
  const fullPage = Array.from({ length: 100 }, () => review("someone", "COMMENTED"));
  assert.equal(classifyChangesRequested({ headSha: HEAD }, fullPage)?.kind, "ambiguous");
  assert.deepEqual(pullReviewsRestArgs(OWNER, REPO, PR), ["api", `repos/${OWNER}/${REPO}/pulls/${PR}/reviews?per_page=100`]);
});

test("the producer reads a human hold before the distance, and the sweep escalates it instead of waiting as mergeable", async () => {
  const seen: string[] = [];
  const { views, rows } = producedViews(sceneFetch({ aheadBy: 7, seen }));
  assert.equal(views.length, 1);
  const view = views[0];
  assert.equal(view.scannerBlocker?.kind, "changes-requested");
  assert.equal(seen.some((path) => path.includes("/compare/")), false, "the hold is decided before the distance read");

  const result = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /CHANGES_REQUESTED review from cao825 \(review 5641056801, at 623985af5, before head 4f437816b\)/);

  const { deps, events, escalated } = sweepDeps(rows);
  await runSweep([view], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(escalated.length, 1, "the hold is named once");
  assert.match(escalated[0], /needs that reviewer's re-review/);
  assert.deepEqual(events.filter((event) => event === "arm" || event === "dispatch"), [], "no re-arm and no worker for a person's hold");
});

test("without a standing hold the same armed, green, blocked PR still reads as it did before", () => {
  const { views } = producedViews(sceneFetch({ reviews: [FLEET_REVIEW, review("cao825", "CHANGES_REQUESTED"), review("cao825", "APPROVED", HEAD)] }));
  const view = views[0];
  assert.equal(view.scannerBlocker?.kind, "no-scanner-alert");
  assert.equal(changesRequestedHold(view), undefined);
  assert.equal(deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW).disposition, "mergeable");
});

test("a held PR behind main is not refreshed; the same PR without a hold is", () => {
  const { views } = producedViews(sceneFetch());
  const held = views[0];
  const free: OpenPrView = { ...held, scannerBlocker: { kind: "base-behind", behindBy: 7 } };
  const policy = { reviewWaitingBranchRefreshEnabled: true, reviewWaitingBranchRefreshThreshold: 11 };
  const behind = new Map([[PR, 7]]);
  assert.deepEqual(openPrsBehindMain([held], behind, policy), []);
  assert.deepEqual(openPrsBehindMain([free], behind, policy).map((pr) => [pr.prNumber, pr.updateReason]), [[PR, "stale-blocked"]]);
});

test("a failed review read is an unreadable blocker, never no hold", () => {
  const throwing = sceneFetch();
  const { views } = producedViews((args) => {
    if ((args[args.length - 1] ?? "").includes(`/pulls/${PR}/reviews`)) throw new Error("HTTP 502");
    return throwing(args);
  });
  assert.deepEqual(views[0].scannerBlocker, { kind: "ambiguous", cause: "unreadable", detail: "the pull request review read failed" });
  assert.notEqual(deriveDisposition(views[0], DEFAULT_SWEEP_POLICY, NOW).disposition, "mergeable");
});
