// W1-T9731 (2026-10-15): #12088 sat green and unarmed from 17:59Z to past 20:33Z behind
// "security merge blocked: new-high-or-critical-security-alert" (repeat_streak 12, acted:false). W1-T5633's
// fix path read a head's alerts only when its CodeQL check FAILED, and it read `refs/pull/<n>/head`, where a
// pull_request analysis is never filed, so no code_scanning row was ever written and the hold named no alert.
// The real alert: CodeQL #400, high, js/file-system-race at src/lib/main-health-rung.ts:1213.
import assert from "node:assert/strict";
import { test } from "node:test";

// Namespace reads, so the file loads at a base without these exports and each test fails on its own.
import * as blockers from "#src/lib/pr-blocker.js";
import { hydrateCodeqlHeadAlerts } from "#src/lib/open-prs-rest.js";
import { runSweep, CODE_SCANNING_FIX_DISPATCH_STEP, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

const OWNER = "craigoley";
const REPO = "remudero";
const PR = 12088;
const TASK = "W1-T9551";
const HEAD = "4d0406d308fcbef87904ba3f4e15160ea52e9a4e";
// The merge commit alert #400 was really analysed at (GET .../alerts/400/instances?ref=refs/pull/12088/merge).
const MERGE = "bc021cbbbac4103697cf5e842e6384ba4ffd838c";
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR}`;
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

/** The open-PR producer's two steps for one head: is a read due, and what the merge-ref listing holds. */
function readAlerts(rows: Record<string, unknown>[], seen: string[], head = HEAD) {
  if (!blockers.codeqlAlertsReadDue(rows, PR, head, false)) return undefined;
  return hydrateCodeqlHeadAlerts(OWNER, REPO, [{ number: PR, headSha: head }], (args) => {
    const path = args[args.length - 1] ?? "";
    seen.push(path);
    return path.includes(`ref=refs/pull/${PR}/merge`) ? [alertRow()] : [];
  }).get(PR);
}

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR, prUrl: PR_URL, taskId: TASK, headRefName: `run-${TASK}-1792082362617`, headSha: HEAD,
    checksState: "green", reviewState: "success", autoMergeArmed: false, isDraft: false,
    priorStrikes: 0, unmetCriteria: [], lastActivityAt: "2026-10-15T17:50:00Z", ...over,
  };
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
  const prior = [armRefused()];
  const seen: string[] = [];
  const observed = readAlerts(prior, seen);
  assert.deepEqual(seen, [`repos/${OWNER}/${REPO}/code-scanning/alerts?ref=refs/pull/${PR}/merge&state=open&per_page=100`],
    "a green CodeQL check with a refused arm still reads the head's alerts, on the merge ref");
  assert.deepEqual(observed?.alerts.map((a) => [a.alertNumber, a.ruleId, a.path, a.line]),
    [[400, "js/file-system-race", "src/lib/main-health-rung.ts", 1213]]);

  const s = sweep(prior);
  await runSweep([view({ codeqlHeadAlerts: observed })], s.deps);
  assert.deepEqual(s.armed, [], "a head with a fix ruling is not re-armed into the same refusal");
  assert.equal(s.fixes.length, 1, "the existing code-scanning fix path dispatched one fix round");
  assert.match(s.fixes[0]![0]!, /location: src\/lib\/main-health-rung\.ts:1213/);
  assert.match(s.fixes[0]![0]!, /rule: js\/file-system-race/);
  const dispatched = s.rows.filter((r) => r.step === CODE_SCANNING_FIX_DISPATCH_STEP);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0]!.alert_numbers, [400]);
});

test("W1-T9731: the security hold names its alert", async () => {
  const prior = [armRefused()];
  const s = sweep(prior);
  await runSweep([view({ codeqlHeadAlerts: readAlerts(prior, []) })], s.deps);
  const disposed = s.rows.filter((r) => r.step === "sweep.disposed").at(-1);
  assert.equal(disposed?.blocker, "security-alert-hold");
  for (const field of [disposed?.blocker_cause, disposed?.reason]) {
    assert.match(String(field), /alert #400 js\/file-system-race at src\/lib\/main-health-rung\.ts:1213: "The file may have changed since it was checked\."/);
  }

  // Once the fix is dispatched the head is settled and unread: the next pass says why it waits.
  const next = sweep([...prior, ...s.rows]);
  await runSweep([view()], next.deps);
  const held = next.rows.filter((r) => r.step === "sweep.disposed").at(-1);
  assert.equal(held?.blocker, "security-alert-hold");
  assert.match(String(held?.blocker_cause), /no high or critical CodeQL alert was read at this head this pass/);
  assert.match(String(held?.blocker_cause), /this pass: a code-scanning fix was already dispatched for this head/);
  assert.equal(next.fixes.length, 0);
  assert.deepEqual(next.armed, []);
});

test("W1-T9731: a refusal at another head reads no alerts", () => {
  const seen: string[] = [];
  assert.equal(readAlerts([armRefused("b".repeat(40))], seen), undefined);
  assert.deepEqual(seen, [], "no refusal at this head costs no alert read");
  // Positive controls: a failed CodeQL check still reads (W1-T5633), and so does this head's own refusal.
  assert.equal(blockers.codeqlAlertsReadDue([], PR, HEAD, true), true);
  assert.equal(blockers.codeqlAlertsReadDue([armRefused()], PR, HEAD, false), true);
  assert.equal(blockers.codeqlAlertsReadDue([armRefused(), { step: "automerge.armed", pr_number: PR, head_sha: HEAD }], PR, HEAD, false), false,
    "a later arm at this head ends the refusal");
});
