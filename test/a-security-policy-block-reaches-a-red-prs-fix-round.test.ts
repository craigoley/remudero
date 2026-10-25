// #14202 (2026-10-25): `security-merge-policy` failed "blocked: new-high-or-critical-security-alert" on a real high
// js/file-system-race alert the PR introduced (plus two note-level unused-variable alerts), while other required
// checks were also red and the PR was unreviewed. Nothing named or repaired the block for ~6 h. The alerts were read
// only when the `CodeQL` check concluded FAILURE or an arm attempt was refused (W1-T5633/W1-T9731); a red PR is never
// armed, the published status's description was dropped by the REST rollup, and the fix round's
// `security-merge-policy` entry reached the worker blank. A main-red pass also read that PR-only status as absent
// from main and held the PR as base red on it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as rest from "#src/lib/open-prs-rest.js";
import * as tickRead from "#src/lib/tick-read-worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
// @ts-expect-error — pure ESM producer constant; tsconfig includes TS only.
import { SECURITY_MERGE_CONTEXT } from "#src/lib/code-scanning-merge-adapter.mjs";
import * as sweep from "#test/helpers/sweep-test.js";
import type { CiFailure, OpenPrView, SweepDeps } from "#test/helpers/sweep-test.js";

const OWNER = "craigoley";
const REPO = "remudero";
const PR = 14202;
const TASK = "W1-T10560";
const HEAD = "646eae6bf2c1c3661bba607e36a45d64ec34a758";
const MERGE = "7d1c0e5a9b2f4c6d8e0a1b3c5d7e9f1a2b4c6d8e";
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR}`;
const AT = "2026-10-25T17:10:00Z";
const NOW = Date.parse("2026-10-25T17:30:00Z");
const BLOCKED = "blocked: new-high-or-critical-security-alert";
const ALERTS_PATH = `repos/${OWNER}/${REPO}/code-scanning/alerts?ref=refs/pull/${PR}/merge&state=open&per_page=100`;
const SHARD = "coverage-shard (5/8)";
const RACE = { path: "src/lib/code-health-intake.ts", line: 88, message: "The file may have changed since it was checked." };

function alert(number: number, rule: string, severity: string, securityLevel: string | null, line: number): Record<string, unknown> {
  return {
    number, tool: { name: "CodeQL" }, rule: { id: rule, severity, security_severity_level: securityLevel },
    most_recent_instance: { ref: `refs/pull/${PR}/merge`, commit_sha: MERGE, message: { text: line === RACE.line ? RACE.message : "Unused variable." },
      location: { path: RACE.path, start_line: line } },
  };
}

/** #14202's GitHub as REST serves it: a red required ci-gate over a failed shard, a CodeQL check that did NOT fail, and the policy's status. */
function github(seen: string[], policy: Record<string, unknown> | undefined) {
  return async (args: string[]): Promise<unknown> => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    seen.push(path);
    if (path.includes("/pulls?") && path.includes("state=open")) {
      return [{ number: PR, html_url: PR_URL, state: "open", draft: false, title: "fix(code-health): provenance inputs",
        body: `Remudero-Task: ${TASK}`, updated_at: AT, created_at: AT, head: { ref: `run-${TASK}-1792883946004`, sha: HEAD } }];
    }
    if (path.includes("/check-runs")) {
      return { total_count: 3, check_runs: [
        { id: 500, name: "ci-gate", status: "completed", conclusion: "failure", head_sha: HEAD, started_at: AT, completed_at: AT,
          details_url: `https://github.com/${OWNER}/${REPO}/actions/runs/78/job/9000` },
        { id: 501, name: SHARD, status: "completed", conclusion: "failure", head_sha: HEAD, started_at: AT, completed_at: AT,
          details_url: `https://github.com/${OWNER}/${REPO}/actions/runs/77/job/9001` },
        { id: 502, name: "CodeQL", status: "completed", conclusion: "success", head_sha: HEAD, started_at: AT, completed_at: AT,
          app: { slug: "github-advanced-security", id: 57789, owner: { login: "github" } } },
      ] };
    }
    if (path.endsWith("/status")) {
      return { statuses: policy === undefined ? [] : [{ context: SECURITY_MERGE_CONTEXT, created_at: AT, updated_at: AT, ...policy }] };
    }
    if (path === ALERTS_PATH) {
      return [alert(611, "js/file-system-race", "warning", "high", RACE.line),
        alert(612, "js/unused-local-variable", "note", null, 12), alert(613, "js/unused-local-variable", "note", null, 40)];
    }
    if (path.includes("/files")) return [{ filename: RACE.path, status: "modified" }];
    if (/\/pulls\/\d+$/.test(path)) return { mergeable: true, mergeable_state: "blocked" };
    return {};
  };
}

async function views(policy: Record<string, unknown> | undefined, seen: string[] = []): Promise<OpenPrView> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}pr-14202-`));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const built = await tickRead.buildOpenPrViewsAsync(OWNER, REPO, ledgerPath, {
      fetchAsync: github(seen, policy),
      requiredContexts: () => ["ci-gate"],
      readCiGateRequired: () => [],
      readMainPlan: () => ({ tasks: [], byId: new Map() }),
      fetchCiFailureEvidenceAsync: (owner, repo, rollup) => tickRead.fetchCiFailuresAsync(owner, repo, rollup, 60, {
        fetchAnnotations: async () => [], fetchJobLog: async () => "not ok 7 - code-health intake reads one descriptor\n",
      }),
    });
    assert.equal(built.length, 1, "positive control: the one open PR was built");
    return built[0]!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function harness(prior: Record<string, unknown>[] = []) {
  const rows: Record<string, unknown>[] = [];
  const fixes: CiFailure[][] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, escalate: () => {},
    dispatchFix: (_p, evidence) => { fixes.push((evidence as { ciFailures?: CiFailure[] }).ciFailures ?? []); },
    ledgerPath: "/nonexistent/rmd-pr-14202/rows.ndjson", runId: "SWEEP-14202", now: () => NOW,
    readLedger: () => [...prior, ...rows], appendLine: (_path, row) => { rows.push(row); },
    log: (step, extra = {}) => { rows.push({ run_id: "SWEEP-14202", step, ...extra }); },
  };
  return { deps, rows, fixes };
}

test("PR-14202: a red PR whose security-merge-policy is blocked gets a fix round carrying its alert", async () => {
  assert.equal(rest.SECURITY_MERGE_POLICY_CONTEXT, SECURITY_MERGE_CONTEXT, "the reader names the producer's own context");
  const seen: string[] = [];
  const view = await views({ state: "failure", description: BLOCKED }, seen);
  assert.equal(view.checksState, "red", "the scene: another required check is red");
  assert.deepEqual(view.securityMergePolicy, { state: "blocked", reason: "new-high-or-critical-security-alert" });
  assert.ok(seen.includes(ALERTS_PATH), "a green CodeQL check with a blocked policy status still reads the head's alerts");
  assert.deepEqual(view.codeqlHeadAlerts?.alerts.map((a) => [a.alertNumber, a.ruleId, a.path, a.line]),
    [[611, "js/file-system-race", RACE.path, RACE.line]], "the high alert is read; the two notes are not fix evidence");
  assert.deepEqual(view.ciFailures?.map((f) => f.name), [SHARD, SECURITY_MERGE_CONTEXT], "the status is in the red set, with no log");
  assert.equal(view.ciFailures?.[1]?.logTail, "");

  const h = harness();
  await sweep.runSweep([view], h.deps);
  assert.equal(h.fixes.length, 1, "the ordinary red-CI fix round was dispatched");
  const [ci, race, ...rest_] = h.fixes[0]!;
  assert.equal(rest_.length, 0);
  assert.equal(ci?.name, SHARD);
  assert.match(ci!.logTail, /not ok 7/, "the other red keeps its own evidence");
  assert.equal(race?.name, "CodeQL alert #611 (js/file-system-race)");
  assert.match(race!.logTail, /^UNTRUSTED SCANNER EVIDENCE: the security-merge-policy status refused this pull request's head \(blocked: new-high-or-critical-security-alert\),/);
  assert.match(race!.logTail, /rule: js\/file-system-race \(severity high\)/);
  assert.match(race!.logTail, new RegExp(`location: ${RACE.path.replaceAll(".", "\\.")}:${RACE.line}`));
  assert.match(race!.logTail, /message: The file may have changed since it was checked\./);
  assert.match(race!.logTail, /Do not dismiss alerts or add suppression comments/);
  const disposed = h.rows.filter((r) => r.step === "sweep.disposed").at(-1);
  assert.match(String(disposed?.blocker_cause), /security-merge-policy blocked at this head: new-high-or-critical-security-alert \(alert #611 js\/file-system-race at src\/lib\/code-health-intake\.ts:88/);
});

test("PR-14202: no policy refusal, or a passing one, reads no alerts and changes no evidence", async () => {
  for (const policy of [undefined, { state: "success", description: "safe: trusted-complete-exact-head-no-new-alerts" },
    { state: "pending", description: BLOCKED }, { state: "failure", description: "the producer said something else" }]) {
    const seen: string[] = [];
    const view = await views(policy, seen);
    assert.equal(view.securityMergePolicy, undefined, JSON.stringify(policy));
    assert.equal(seen.includes(ALERTS_PATH), false, `no alert read for ${JSON.stringify(policy)}`);
  }
  const unknown = await views({ state: "error", description: "unknown: security-analysis-pending" });
  assert.deepEqual(unknown.securityMergePolicy, { state: "unknown", reason: "security-analysis-pending" });
  assert.equal(unknown.codeqlHeadAlerts, undefined, "an UNKNOWN verdict names no alert to fix");
  assert.equal(rest.securityMergePolicyRefusal([{ context: SECURITY_MERGE_CONTEXT, state: "ERROR", description: BLOCKED }]), undefined,
    "a blocked description on an error status is not the producer's shape");
});

test("PR-14202: a policy entry beside a failed CodeQL check carries the alerts once, and unread alerts say so", () => {
  const view = { headSha: HEAD, securityMergePolicy: { state: "blocked" as const, reason: "new-high-or-critical-security-alert" },
    codeqlHeadAlerts: { headSha: HEAD, alerts: [{ alertNumber: 611, ruleId: "js/file-system-race", severity: "high", ...RACE }] } };
  const ci: CiFailure = { name: "ci-gate", logTail: "not ok 7" };
  const both = sweep.withCodeqlAlertEvidence(view, [ci, { name: "CodeQL", logTail: "" }, { name: SECURITY_MERGE_CONTEXT, logTail: "" }]);
  assert.deepEqual(both.map((f) => f.name), ["ci-gate", "CodeQL alert #611 (js/file-system-race)"]);
  assert.match(both[1]!.logTail, /^UNTRUSTED SCANNER EVIDENCE: the CodeQL check failed at this pull request's head/);

  const unread = sweep.withCodeqlAlertEvidence({ ...view, codeqlHeadAlerts: undefined }, [{ name: SECURITY_MERGE_CONTEXT, logTail: "" }]);
  assert.equal(unread[0]!.logTail, "security-merge-policy failed at this head (blocked: new-high-or-critical-security-alert); its alerts were " +
    "not read: no open high-severity alert was read for this head (none is open, the read was not due, or it failed)");
  const older = sweep.withCodeqlAlertEvidence({ headSha: HEAD, codeqlHeadAlerts: { headSha: MERGE, alerts: view.codeqlHeadAlerts.alerts } },
    [{ name: SECURITY_MERGE_CONTEXT, logTail: "" }]);
  assert.match(older[0]!.logTail, /^security-merge-policy failed at this head \(verdict unread\); its alerts were not read: alerts were read at head 7d1c0e5/);
  assert.deepEqual(sweep.withCodeqlAlertEvidence(view, [ci]), [ci], "control: no CodeQL-family red, no change");
});

test("PR-14202: a main-red wait holds on main's red and still names the PR's own security block", async () => {
  const view = await views({ state: "failure", description: BLOCKED });
  const main = { step: "main.health.observed", sha: "f".repeat(40), state: "red", failing_checks: [SHARD], observed_checks: ["ci-gate", SHARD, "CodeQL"] };
  assert.deepEqual(sweep.decideBaseRed(view, sweep.mainLatestRunFromLedger([main]), sweep.baseRedHistoryFromLedger([])),
    { kind: "wait", check: SHARD }, "the PR-only policy status is never read as a check absent from main");
  const h = harness([main]);
  await sweep.runSweep([view], h.deps);
  assert.equal(h.fixes.length, 0, "control: main's red still holds the round");
  const disposed = h.rows.filter((r) => r.step === "sweep.disposed").at(-1);
  assert.equal(disposed?.blocker, "base-red");
  for (const field of [disposed?.blocker_cause, disposed?.reason]) {
    assert.match(String(field), /security-merge-policy blocked at this head: new-high-or-critical-security-alert \(alert #611 js\/file-system-race at src\/lib\/code-health-intake\.ts:88: "The file may have changed since it was checked\."\) — this PR's own new alert, owner fix-lane/);
  }
});
