import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import type { Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { buildSweepEffects, HELD_ESCALATION_SLO_MS, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

// Operator ruling 2026-10-30. On 2026-10-29 seven fleet PRs (#15046, #15133, #15317, #15368, #15404, #15419, #15520) read
// refused-escalate for hours: the fix lane stood down ("fix needs design", "instrument edit only the operator can grant"),
// escalated once, and then every pass deduped that escalation. The SLO ladder only ever looked at blocked-ambiguous PRs,
// so nothing ended the wait. After HELD_ESCALATION_SLO_MS unanswered, the ladder's judged rebuild now acts on them.

const MIN = 60_000;
const NOW = Date.parse("2026-10-30T06:00:00.000Z");
const stamp = (offset = 0) => new Date(NOW + offset).toISOString();
const TASK = "W1-T10661";
const PR = 15404;
const HEAD = "f4a25ce".padEnd(40, "0");
const RUN = "held-escalation-run";
const HOLD_REASON = `a needs-human escalation for this exact (task, PR, head ${HEAD}, cause) is ALREADY OPEN and awaiting a human (https://github.com/acme/remudero/issues/14219) — standing down`;

/** A completed NEEDS_DESIGN fix round as the fix lane records it (#15419's shape: dispatch, needs_design, done). */
function designRound(heldForMs: number): Record<string, unknown>[] {
  const who = { task_id: TASK, head_sha: HEAD, run_id: RUN, host: "fleet-host", actor_pid: 4242,
    repair_pr_url: `https://github.com/acme/remudero/pull/${PR}`, round_id: `${RUN}:1:1` };
  return [
    { step: "fix.dispatch", ...who, mode: "reviewer-unmet", ts: stamp(-heldForMs - MIN) },
    { step: "fix.needs_design", ...who, reason: HOLD_REASON, contract_revision: "contract-A", ts: stamp(-heldForMs) },
    { step: "fix.done", ...who, fix_outcome: "NEEDS_DESIGN", ts: stamp(-heldForMs + 1000) },
  ];
}

function fixture(t: { after: (fn: () => void) => void }, heldForMs: number, clock = { now: NOW }, design = false,
  judge?: SweepDeps["fixProgressJudge"]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}held-escalation-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const heldAt = stamp(-heldForMs);
  const rows: Record<string, unknown>[] = [
    { step: "sweep.disposed", pr_number: PR, head_sha: HEAD, task_id: TASK, run_id: RUN, disposition: "blocked-fixable",
      acted: true, ts: stamp(-heldForMs - 20 * MIN) },
    { step: "fix.dispatch", task_id: TASK, head_sha: HEAD, run_id: RUN, mode: "reviewer-unmet", strike: 1, ts: stamp(-heldForMs - 19 * MIN) },
    ...(design ? designRound(heldForMs) : [{ step: "fix.stood_down", task_id: TASK, head_sha: HEAD, run_id: RUN,
      site: "rung.strike", reason: HOLD_REASON, read_head_sha: HEAD, read_contract_revision: "contract-A", ts: heldAt }]),
  ];
  const calls: string[] = [];
  const judged: string[] = [];
  const open: OpenIssue[] = [];
  const closed = new Set<number>();
  const issues: IssueGateway = {
    ensureLabel: () => true, listOpen: () => open,
    create: (title, body) => {
      calls.push("create");
      const url = `https://github.com/acme/remudero/issues/${open.length + 1}`;
      open.push({ number: open.length + 1, url, title, body });
      return url;
    },
    comment: () => { calls.push("comment"); },
  };
  const effects = buildSweepEffects({
    owner: "acme", repo: "remudero", repoRoot: root,
    config: { root, claudeBin: "/bin/true" } as Config,
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    ledgerPath: join(root, "ledger.ndjson"), runId: RUN,
    log: () => undefined, issuesImpl: issues, ghRunImpl: () => undefined, nowMsImpl: () => NOW,
    readJsonImpl: async () => ({ user: { login: "remudero-fleet[bot]" } }),
  });
  const deps: SweepDeps = {
    strikeLadder: effects.strikeLadder,
    fixProgressJudge: judge ?? (async (input) => {
      judged.push(String(input.parkedReason));
      return { verdict: "change-approach", reason: "the same round stood down twice", approach: "publish the proof through the PR body" };
    }),
    readTaskContractRevision: () => "contract-A",
    arm: () => { calls.push("arm"); },
    close: (candidate) => { calls.push("close"); closed.add(candidate.prNumber); },
    updateBranch: () => { calls.push("refresh"); return "updated"; },
    dispatchFix: () => { calls.push("fix"); },
    escalate: () => { calls.push("escalate"); },
    claimFixAdmission: () => ({ admitted: true }),
    readLiveState: (candidate) => ({ ok: true, state: closed.has(candidate.prNumber) ? "CLOSED" : "OPEN", headSha: candidate.headSha }),
    ledgerPath: join(root, "ledger.ndjson"), runId: RUN,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: new Date(clock.now).toISOString(), ...row }); }, now: () => clock.now,
    log: () => undefined,
  } as SweepDeps;
  const pr: OpenPrView = {
    prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: TASK, headSha: HEAD,
    headRefName: `run-${TASK}-1793254254355`, checksState: "green", reviewState: "failure",
    unmetCriteria: [{ claim: "the harness no longer spends a fix round on check:body-coverage", proof: "unit test: W1-T10661",
      met: false, reason: "the proof skips PR-body publication", proof_exec: "executed_pass" }],
    priorStrikes: 1, autoMergeArmed: false, lastActivityAt: stamp(-heldForMs),
    body: `Builds the remedy.\n\nRemudero-Task: ${TASK}\n`,
  };
  return { rows, calls, judged, effects, pr, sweep: () => runSweep([pr], deps) };
}

test("W1-T10653: flow-review-failed-n-unmet-criterion clears without a person", async (t) => {
  const aged = fixture(t, HELD_ESCALATION_SLO_MS + 10 * MIN);
  await aged.sweep();
  assert.deepEqual(aged.calls, ["close"], "an already-open escalation unanswered past the SLO is rebuilt, not stood down on forever");
  assert.ok(aged.rows.some(r => r.step === "sweep.strike_ladder.requeued" && r.pr_number === PR), "the task is requeued");
  const fresh = fixture(t, HELD_ESCALATION_SLO_MS - 10 * MIN);
  await fresh.sweep();
  assert.equal(fresh.calls.includes("close"), false, "inside the SLO the stand-down still holds");
});
