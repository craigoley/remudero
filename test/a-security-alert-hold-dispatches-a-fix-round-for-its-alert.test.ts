// W1-T9731 (2026-10-15): #12088 sat green and unarmed from 17:59Z to past 20:33Z behind
// "security merge blocked: new-high-or-critical-security-alert" (repeat_streak 12, acted:false). W1-T5633's
// fix path read a head's alerts only when its CodeQL check FAILED, and it read `refs/pull/<n>/head`, where a
// pull_request analysis is never filed, so no code_scanning row was ever written and the hold named no alert.
// The real alert: CodeQL #400, high, js/file-system-race at src/lib/main-health-rung.ts:1213.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rmSync } from "node:fs";

import { buildOpenPrViews } from "../src/run-task.js";
import { reviewInputDigest } from "../src/lib/review.js";
import { runSweep, CODE_SCANNING_FIX_DISPATCH_STEP, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const OWNER = "craigoley";
const REPO = "remudero";
const PR = 12088;
const TASK = "W1-T9551";
const HEAD = "4d0406d30aa1b2c3d4e5f60718293a4b5c6d7e8f";
const MERGE = "77e1d2c3b4a5968778695a4b3c2d1e0f98765432";
const BRANCH = `run-${TASK}-1792082362617`;
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR}`;
const BODY = `Remudero-Task: ${TASK}`;
const NOW = Date.parse("2026-10-15T19:40:00Z");
const MESSAGE = "The file may have changed since it was checked.";
const BLOCKED = "security merge blocked: new-high-or-critical-security-alert";

function armRefused(head = HEAD): Record<string, unknown> {
  return { ts: "2026-10-15T17:59:39.000Z", run_id: "DAEMON-1", task_id: TASK, step: "automerge.arm_failed", lane: "review",
    outcome: "arm-error-ignored", head_sha: head, error: BLOCKED, pr_number: PR, pr_url: PR_URL };
}

/** The live alert as the merge-ref listing serves it: analysed at the merge commit, never at the head. */
function alertRow(): Record<string, unknown> {
  return {
    number: 400,
    rule: { id: "js/file-system-race", security_severity_level: "high" },
    tool: { name: "CodeQL" },
    most_recent_instance: {
      ref: `refs/pull/${PR}/merge`, commit_sha: MERGE, message: { text: MESSAGE },
      location: { path: "src/lib/main-health-rung.ts", start_line: 1213 },
    },
  };
}

function sceneFetch(seen: string[]): (args: string[]) => unknown {
  return (args) => {
    const path = args[args.length - 1] ?? "";
    seen.push(path);
    if (/pulls\?state=open/.test(path)) {
      return [{ number: PR, html_url: PR_URL, head: { ref: BRANCH, sha: HEAD }, updated_at: "2026-10-15T17:50:00.000Z", // expiring-fixture: exempt -- aged only against this suite's injected NOW
        body: BODY, auto_merge: null, draft: false, state: "open" }];
    }
    if (path.includes("/check-runs")) {
      return { check_runs: [
        { name: "ci-gate", status: "completed", conclusion: "success", started_at: "2026-10-15T17:30:00Z", completed_at: "2026-10-15T17:40:00Z" },
        { name: "CodeQL", status: "completed", conclusion: "success", started_at: "2026-10-15T17:31:00Z", completed_at: "2026-10-15T17:45:00Z" },
      ] };
    }
    if (path.endsWith(`/commits/${HEAD}/status`)) {
      return { statuses: [{ context: "remudero-review", state: "success", created_at: "2026-10-15T17:55:00Z", updated_at: "2026-10-15T17:55:00Z" }] }; // expiring-fixture: exempt -- aged only against this suite's injected NOW
    }
    if (path.endsWith(`/pulls/${PR}`)) return { mergeable: true, mergeable_state: "clean", merge_commit_sha: MERGE, head: { sha: HEAD } };
    if (path.includes("/code-scanning/alerts")) return path.includes(`ref=refs/pull/${PR}/merge`) ? [alertRow()] : [];
    return [];
  };
}

const reviewed = { ts: "2026-10-15T17:56:00.000Z", step: "review.posted", task_id: TASK, head_sha: HEAD, pr_url: PR_URL,
  state: "success", review_input_digest: reviewInputDigest(HEAD, BODY) };

function produced(rows: Record<string, unknown>[]): { views: OpenPrView[]; seen: string[] } {
  const ledger = writeLedger(rows);
  const seen: string[] = [];
  try {
    const views = buildOpenPrViews(OWNER, REPO, ledger.path, {
      fetch: sceneFetch(seen), requiredContexts: () => ["ci-gate"], readMainPlan: () => ({ tasks: [], byId: new Map() }),
    });
    return { views, seen };
  } finally {
    rmSync(ledger.dir, { recursive: true, force: true });
  }
}

function sweep(prior: Record<string, unknown>[]) {
  const rows: Record<string, unknown>[] = [];
  const fixes: string[][] = [];
  const armed: string[] = [];
  const deps: SweepDeps = {
    arm: (p) => { armed.push(p.headSha); }, close: () => {}, postReview: () => {}, escalate: () => {},
    dispatchFix: (_p, evidence) => {
      fixes.push(((evidence as { ciFailures?: Array<{ logTail: string }> }).ciFailures ?? []).map((f) => f.logTail));
    },
    ledgerPath: "/nonexistent/rmd-w1-t9731/rows.ndjson", runId: "SWEEP-W1-T9731", now: () => NOW,
    readLedger: () => [...prior, ...rows], appendLine: (_path, row) => { rows.push(row); },
    log: (step, extra = {}) => { rows.push({ run_id: "SWEEP-W1-T9731", step, ...extra }); },
  };
  return { deps, rows, fixes, armed };
}

test("W1-T9731: a security-alert-hold dispatches a fix round for its alert", async () => {
  const prior = [reviewed, armRefused()];
  const { views, seen } = produced(prior);
  assert.equal(views.length, 1);
  assert.ok(seen.some((p) => p.includes(`code-scanning/alerts?ref=refs/pull/${PR}/merge&state=open`)),
    "a green CodeQL check with a refused arm still reads the head's alerts, on the merge ref");
  assert.deepEqual(views[0]!.codeqlHeadAlerts?.alerts.map((a) => [a.alertNumber, a.ruleId, a.path, a.line]),
    [[400, "js/file-system-race", "src/lib/main-health-rung.ts", 1213]]);

  const s = sweep(prior);
  await runSweep(views, s.deps);
  assert.deepEqual(s.armed, [], "a head with a fix ruling is not re-armed into the same refusal");
  assert.equal(s.fixes.length, 1, "the existing code-scanning fix path dispatched one fix round");
  assert.match(s.fixes[0]![0]!, /location: src\/lib\/main-health-rung\.ts:1213/);
  assert.match(s.fixes[0]![0]!, /rule: js\/file-system-race/);
  const dispatched = s.rows.filter((r) => r.step === CODE_SCANNING_FIX_DISPATCH_STEP);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0]!.alert_numbers, [400]);
});

test("W1-T9731: the security hold names its alert", async () => {
  const prior = [reviewed, armRefused()];
  const { views } = produced(prior);
  const s = sweep(prior);
  await runSweep(views, s.deps);
  const disposed = s.rows.filter((r) => r.step === "sweep.disposed").at(-1);
  assert.equal(disposed?.blocker, "security-alert-hold");
  for (const field of [disposed?.blocker_cause, disposed?.reason]) {
    assert.match(String(field), /alert #400 js\/file-system-race at src\/lib\/main-health-rung\.ts:1213: "The file may have changed since it was checked\."/);
  }

  // Once the fix is dispatched the head is settled and unread: the next pass says why it waits.
  const next = sweep([...prior, ...s.rows]);
  const settled = produced([...prior, ...s.rows]);
  assert.equal(settled.views[0]!.codeqlHeadAlerts, undefined);
  await runSweep(settled.views, next.deps);
  const held = next.rows.filter((r) => r.step === "sweep.disposed").at(-1);
  assert.equal(held?.blocker, "security-alert-hold");
  assert.match(String(held?.blocker_cause), /no high or critical CodeQL alert was read at this head this pass/);
  assert.match(String(held?.blocker_cause), /this pass: a code-scanning fix was already dispatched for this head/);
  assert.equal(next.fixes.length, 0);
});

test("W1-T9731: a refusal at another head reads no alerts", () => {
  const { views, seen } = produced([reviewed, armRefused("b".repeat(40))]);
  assert.equal(views.length, 1);
  assert.equal(seen.some((p) => p.includes("/code-scanning/alerts")), false, "no refusal at this head costs no alert read");
  assert.equal(views[0]!.codeqlHeadAlerts, undefined);
});
