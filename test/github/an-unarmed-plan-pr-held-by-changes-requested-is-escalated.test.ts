import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildOpenPrViews } from "#src/run-task.js";
import { reviewInputDigest } from "#src/lib/review.js";
import {
  hydrateScannerBlockerObservations,
  isHumanHoldCandidate,
  isScannerBlockerCandidate,
  type ScannerBlockerCandidate,
} from "#src/lib/open-prs-rest.js";
import {
  changesRequestedHold,
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  MERGEABLE_PLAN_PR_REASON,
  repairableCodeqlBlocker,
  runSweep,
  scannerBlockerAmbiguity,
  type OpenPrView,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";

/*
 * craigoley/remudero #14599 (2026-10-26): a triage plan PR, required checks green, remudero-review success,
 * `mergeable: true`, `mergeable_state: "blocked"` for ~1.5 h because cao825's standing review was
 * CHANGES_REQUESTED. A plan PR is never armed (W1-T5615; it takes W1-T6595's direct merge), and the hold read
 * and its escalation row covered only armed PRs, so nothing read the hold and nothing said a person held it.
 */

const OWNER = "craigoley";
const REPO = "remudero";
const PR = 14599;
const TASK = "TRIAGE-console-operator-guidance-generation-store-20261026";
const HEAD = "c1881bd0a4f2e6b8d1c3e5a7f9b0d2c4e6a8f0b1";
const OLD_HEAD = "7b2e4d6f8a0c1e3b5d7f9a1c3e5b7d9f0a2c4e6b";
const MERGE = "e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6";
const BRANCH = `run-${TASK}-1793053679407`;
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR}`;
const BODY = `Proposed by the intake triage.\n\nRemudero-Task: ${TASK}`;
const PLAN_FILE = "plan/tasks.d/W1-T10772-operator-guidance-survives-a-serving-generation-switch.yaml";
const NOW = Date.parse("2026-10-27T01:00:00Z");

function review(login: string, state: string, commit = OLD_HEAD): Record<string, unknown> {
  return { id: 5660893043, state, commit_id: commit, submitted_at: "2026-10-26T23:10:00Z", user: { login, type: "User" } };
}

interface Scene {
  armed?: boolean;
  files?: string[];
  reviews?: unknown;
  seen?: string[];
}

function sceneFetch(scene: Scene): (args: string[]) => unknown {
  return (args) => {
    const path = args[args.length - 1] ?? "";
    scene.seen?.push(path);
    if (/pulls\?state=open/.test(path)) {
      return [{
        number: PR, html_url: PR_URL, head: { ref: BRANCH, sha: HEAD },
        updated_at: "2026-10-27T00:30:00.000Z", // expiring-fixture: exempt -- aged only against this suite's injected NOW, never the wall clock
        body: BODY, auto_merge: scene.armed === true ? { merge_method: "squash" } : null, draft: false, state: "open",
      }];
    }
    if (path.includes("/check-runs")) {
      return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success", started_at: "2026-10-27T00:00:00Z", completed_at: "2026-10-27T00:05:00Z" }] };
    }
    if (path.endsWith(`/commits/${HEAD}/status`)) {
      return { statuses: [{ context: "remudero-review", state: "success", created_at: "2026-10-27T00:10:00Z", updated_at: "2026-10-27T00:10:00Z" }] }; // expiring-fixture: exempt -- aged only against this suite's injected NOW, never the wall clock
    }
    if (path.endsWith(`/pulls/${PR}`)) return { mergeable: true, mergeable_state: "blocked", merge_commit_sha: MERGE, head: { sha: HEAD } };
    if (path.includes(`/pulls/${PR}/reviews`)) return scene.reviews ?? [review("cao825", "CHANGES_REQUESTED")];
    if (path.includes(`/pulls/${PR}/files`)) return (scene.files ?? [PLAN_FILE]).map((filename) => ({ filename }));
    if (path.includes("/compare/")) return { ahead_by: 0 };
    return [];
  };
}

/** The production view producer over the scene. `emitterFiling` writes the `pr.opened{plan_only}` receipt a
 *  triage run logs, which is #14599's shape: its file read is skipped, so only `isPlanFiling` names it. */
function producedViews(scene: Scene, emitterFiling: boolean): { views: OpenPrView[]; rows: Record<string, unknown>[] } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-unarmed-plan-hold-"));
  try {
    const rows: Record<string, unknown>[] = [
      ...(emitterFiling ? [{ ts: "2026-10-26T22:32:30.000Z", step: "pr.opened", task_id: TASK, pr_url: PR_URL, plan_only: true }] : []),
      {
        ts: "2026-10-27T00:11:00.000Z", step: "review.posted", task_id: TASK, head_sha: HEAD, pr_url: PR_URL,
        review_input_digest: reviewInputDigest(HEAD, BODY),
      },
    ];
    const path = join(dir, "rows.ndjson");
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const views = buildOpenPrViews(OWNER, REPO, path, {
      fetch: sceneFetch(scene), requiredContexts: () => ["ci-gate"], readMainPlan: () => ({ tasks: [], byId: new Map() }),
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
    ledgerPath: "/nonexistent/rmd-unarmed-plan-hold/rows.ndjson",
    runId: "SWEEP-UNARMED-PLAN-HOLD",
    now: () => NOW,
    readLedger: () => [...prior, ...rows],
    appendLine: (_path, row) => { rows.push(row); },
  };
  return { deps, events, escalated };
}

test("an unarmed plan PR held by a changes-requested review is escalated, not left waiting", async () => {
  const seen: string[] = [];
  const { views, rows } = producedViews({ seen }, true);
  assert.equal(views.length, 1);
  const view = views[0];
  assert.equal(view.autoMergeArmed, false);
  assert.equal(view.isPlanFiling, true);
  assert.equal(view.scannerBlocker?.kind, "changes-requested", "the unarmed plan PR's hold is read");
  assert.deepEqual(changesRequestedHold(view)?.map((hold) => [hold.login, hold.reviewId]), [["cao825", 5660893043]]);
  assert.equal(seen.some((path) => path.includes("/compare/") || path.includes("/code-scanning/")), false,
    "a hold-only read takes the review read alone");

  const result = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /^an unarmed plan PR the fleet merges directly, checks green and review success/);
  assert.match(result.reason, /CHANGES_REQUESTED review from cao825 \(review 5660893043, at 7b2e4d6f8, before head c1881bd0a\)/);

  const { deps, events, escalated } = sweepDeps(rows);
  await runSweep([view], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(escalated.length, 1, "the hold is named once");
  assert.match(escalated[0], /needs that reviewer's re-review/);
  assert.deepEqual(events.filter((event) => event === "arm" || event === "dispatch"), [],
    "no direct merge retried and no worker for a person's hold");
});

test("an unarmed PR whose observed files reach plan/ is held the same way", () => {
  const { views } = producedViews({ files: [PLAN_FILE, "src/lib/sweep.ts"] }, false);
  const view = views[0];
  assert.equal(view.isPlanFiling, false);
  assert.equal(view.scannerBlocker?.kind, "changes-requested");
  assert.equal(deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
});

test("an unarmed non-plan PR takes no hold read and still reads as mergeable, which arms it", () => {
  const seen: string[] = [];
  const { views } = producedViews({ files: ["src/lib/sweep.ts"], seen }, false);
  const view = views[0];
  assert.equal(view.scannerBlocker, undefined);
  assert.equal(seen.some((path) => path.includes(`/pulls/${PR}/reviews`)), false, "no new REST read for a code PR");
  const result = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "mergeable");
  assert.equal(result.reason, "review success, required checks green — arming auto-merge");
});

test("an unarmed plan PR with no standing hold is absent from the read and merges directly as before", () => {
  const { views } = producedViews({ reviews: [review("cao825", "APPROVED", HEAD)] }, true);
  const view = views[0];
  assert.equal(view.scannerBlocker, undefined, "no hold means no observation, never a scanner verdict");
  const result = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "mergeable");
  assert.equal(result.reason, MERGEABLE_PLAN_PR_REASON);
});

test("the armed PR's hold still escalates as before", () => {
  const seen: string[] = [];
  const { views } = producedViews({ armed: true, files: ["src/lib/sweep.ts"], seen }, false);
  const view = views[0];
  assert.equal(view.scannerBlocker?.kind, "changes-requested");
  const result = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /^armed, checks green and review success, but mergeable_state is blocked by a CHANGES_REQUESTED/);
});

test("scanner repair still requires an armed PR: an unarmed plan PR's CodeQL singleton is never repairable", () => {
  const { views } = producedViews({ reviews: [] }, true);
  const view: OpenPrView = {
    ...views[0],
    scannerBlocker: {
      kind: "codeql-singleton", headSha: HEAD, mergeCommitSha: MERGE,
      alert: { alertNumber: 7, ruleId: "js/unused-local-variable", path: "src/lib/sweep.ts", line: 1, message: "unused" },
    },
  };
  assert.equal(isHumanHoldCandidate(view), true);
  assert.equal(isScannerBlockerCandidate(view), false);
  assert.equal(repairableCodeqlBlocker(view), undefined);
  assert.equal(scannerBlockerAmbiguity(view, DEFAULT_SWEEP_POLICY), undefined);
  assert.equal(changesRequestedHold(view), undefined);
  assert.notEqual(deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-fixable");
});

test("hold-only reads share the existing cap behind the armed scanner reads", () => {
  const seen: string[] = [];
  const fetch = (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    seen.push(path);
    if (path.includes("/reviews")) return [review("cao825", "CHANGES_REQUESTED")];
    if (path.includes("/compare/")) return { ahead_by: 0 };
    return [];
  };
  const holdOnly: ScannerBlockerCandidate = { number: 900, headSha: HEAD, holdOnly: true };
  const armed = [1, 2, 3].map((number): ScannerBlockerCandidate => ({ number, headSha: HEAD }));
  const capped = hydrateScannerBlockerObservations(OWNER, REPO, [holdOnly, ...armed], fetch, 3);
  assert.deepEqual([...capped.keys()], [1, 2, 3], "an armed candidate is never displaced by a hold-only one");
  assert.equal(seen.some((path) => path.includes("/pulls/900/")), false);

  seen.length = 0;
  const all = hydrateScannerBlockerObservations(OWNER, REPO, [holdOnly], fetch, 3);
  assert.equal(all.get(900)?.kind, "changes-requested");
  assert.deepEqual(seen, [`repos/${OWNER}/${REPO}/pulls/900/reviews?per_page=100`], "one REST read per hold-only PR");
});
