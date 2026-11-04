import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway, OpenIssue } from "#src/lib/escalate.js";
import type { Plan } from "#src/lib/plan.js";
import { appendLedger, rotateLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
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
  judge?: SweepDeps["fixProgressJudge"], sweepOwned = false) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}held-escalation-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const heldAt = stamp(-heldForMs);
  const rows: Record<string, unknown>[] = sweepOwned ? [] : [
    { step: "sweep.disposed", pr_number: PR, head_sha: HEAD, task_id: TASK, run_id: RUN, disposition: "blocked-fixable",
      acted: true, ts: stamp(-heldForMs - 20 * MIN) },
    { step: "fix.dispatch", task_id: TASK, head_sha: HEAD, run_id: RUN, mode: "reviewer-unmet", strike: 1, ts: stamp(-heldForMs - 19 * MIN) },
    ...(design ? designRound(heldForMs) : [{ step: "fix.stood_down", task_id: TASK, head_sha: HEAD, run_id: RUN,
      site: "rung.strike", reason: HOLD_REASON, read_head_sha: HEAD, read_contract_revision: "contract-A", ts: heldAt }]),
  ];
  const calls: string[] = [];
  const observations: string[] = [];
  const judged: string[] = [];
  const open: OpenIssue[] = [];
  open.push({ number: 14219, url: "https://github.com/acme/remudero/issues/14219",
    title: "[BLOCKED] review false-block", body: `**Task:** ${TASK}\n**Class:** BLOCKED\nhttps://github.com/acme/remudero/pull/${PR}\n**Head:** ${HEAD}\n**Cause:** review\n**Contract:** contract-A\n` });
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
      observations.push("judge");
      judged.push(String(input.parkedReason));
      return { verdict: "change-approach", reason: "the same round stood down twice", approach: "publish the proof through the PR body" };
    }),
    readTaskContractRevision: () => "contract-A",
    readOpenEscalations: () => { observations.push("read-open"); return open; },
    arm: () => { calls.push("arm"); },
    close: (candidate) => { observations.push("close"); calls.push("close"); closed.add(candidate.prNumber); },
    updateBranch: () => { calls.push("refresh"); return "updated"; },
    dispatchFix: () => { observations.push("fix"); calls.push("fix"); },
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
  return { rows, calls, observations, judged, effects, pr, open, deps, sweep: () => runSweep([pr], deps) };
}

test("W1-T10653: flow-review-failed-n-unmet-criterion clears without a person", async (t) => {
  for (const scenario of ["control", "older action", "completed repair resets the hold"]) {
    await t.test(`hourly ledger rotation: ${scenario}`, async (t) => {
      const olderAction = scenario !== "control";
      const reset = scenario === "completed repair resets the hold";
      const clock = { now: NOW - HELD_ESCALATION_SLO_MS };
      const heldSince = new Date(clock.now).toISOString();
      const h = fixture(t, HELD_ESCALATION_SLO_MS, clock, false, undefined, true);
      const seed = { step: "sweep.disposed", task_id: TASK, pr_number: PR, head_sha: HEAD, run_id: RUN,
        disposition: "blocked-fixable", acted: true, ts: new Date(clock.now - 80 * MIN).toISOString() };
      const initialRows: Record<string, unknown>[] = olderAction ? [seed] : [];
      if (reset) initialRows.push({ ...seed, acted: false, ts: new Date(clock.now - 70 * MIN).toISOString(),
        open_escalation_hold_since: new Date(clock.now - 70 * MIN).toISOString() });
      writeFileSync(h.deps.ledgerPath, initialRows.map(row => JSON.stringify(row) + "\n").join(""));
      delete h.deps.readLedger;
      h.deps.appendLine = (path, row) => appendLedger(path, { ts: new Date(clock.now).toISOString(), ...row });
      if (reset) h.deps.appendLine(h.deps.ledgerPath, { step: "fix.done", task_id: TASK, head_sha: HEAD,
        run_id: RUN, ts: new Date(clock.now - 10 * MIN).toISOString() });
      const holds: unknown[] = [];
      let closedAt: number | undefined;
      for (let hour = 0; hour <= 7; hour++) {
        clock.now = Date.parse(heldSince) + hour * 60 * MIN;
        // Each call reloads the rotated ledger, without any in-memory hold history.
        await h.sweep();
        const rows = readLedgerLines(h.deps.ledgerPath);
        if (h.calls.includes("close")) {
          closedAt = hour;
          assert.deepEqual(h.calls, ["close"], "the same head must rebuild exactly once");
          assert.equal(rows.filter(row => row.step === "sweep.strike_ladder.requeued").length, 1);
          break;
        }
        holds.push(rows.findLast(row => row.step === "sweep.disposed")?.open_escalation_hold_since);
        writeFileSync(h.deps.ledgerPath, JSON.stringify({ step: "ci.polling", detail: "x".repeat(64_000) }) + "\n", { flag: "a" });
        const rotated = rotateLedger(h.deps.ledgerPath, { ceilingBytes: 64_000, smoothingWindowMs: 0,
          now: () => new Date(clock.now) });
        assert.equal(rotated.rotated, true, `exercise the real dedup block at hour ${hour}`);
        if (olderAction) {
          assert.ok(readLedgerLines(h.deps.ledgerPath).some(row => row.step === "sweep.disposed" &&
            row.acted === true && row.ts === seed.ts), "rotation keeps the older action receipt");
        }
      }
      assert.equal(closedAt, 6, "a seven-hour replay must rebuild at six hours, including the older-action history");
      assert.deepEqual(holds, Array(6).fill(heldSince), "every pre-SLO pass must preserve the original hold time");
    });
  }

  for (const incomplete of [false, true]) {
    await t.test(`archive recovery refuses incomplete history ${incomplete}`, async (t) => {
      const clock = { now: NOW };
      const h = fixture(t, HELD_ESCALATION_SLO_MS, clock, false, undefined, true);
      const seed = { step: "sweep.disposed", task_id: TASK, pr_number: PR, head_sha: HEAD, run_id: RUN,
        disposition: "blocked-fixable", acted: true, ts: stamp(-8 * 60 * MIN) };
      const oldHold = { ...seed, acted: false, ts: stamp(-7 * 60 * MIN), open_escalation_hold_since: stamp(-7 * 60 * MIN) };
      const liveHold = { ...oldHold, ts: stamp(-60 * MIN), open_escalation_hold_since: stamp(-60 * MIN) };
      writeFileSync(h.deps.ledgerPath, [seed, liveHold].map(row => JSON.stringify(row) + "\n").join(""));
      writeFileSync(join(dirname(h.deps.ledgerPath), "ledger.2026-10-30T05-00-00-000Z.ndjson"), JSON.stringify(oldHold) + "\n");
      if (incomplete) writeFileSync(join(dirname(h.deps.ledgerPath), "ledger.2026-10-30T05-30-00-000Z.ndjson.gz"), "unreadable gzip");
      delete h.deps.readLedger;
      h.deps.appendLine = (path, row) => appendLedger(path, { ts: new Date(clock.now).toISOString(), ...row });
      await h.sweep();
      assert.deepEqual(h.calls, incomplete ? [] : ["close"],
        "only a complete archive can prove that the newer live timer has already expired");
      const rows = readLedgerLines(h.deps.ledgerPath);
      assert.equal(rows.some(row => row.step === "sweep.strike_ladder.requeued"), !incomplete);
      if (incomplete) assert.equal(rows.findLast(row => row.step === "sweep.disposed")?.open_escalation_hold_since,
        liveHold.open_escalation_hold_since, "an unreadable archive preserves the live hold");
    });
  }

  for (const issueOpen of [false, true]) {
    await t.test(`aged fix-lane hold with escalation ${issueOpen ? "open" : "closed"}`, async (t) => {
      const legacy = fixture(t, HELD_ESCALATION_SLO_MS + MIN);
      if (!issueOpen) legacy.open.length = 0;
      assert.equal(legacy.rows.some(r => typeof r.open_escalation_hold_since === "string"), false,
        "the legacy fix-lane stand-down has no sweep-owned hold record");
      await legacy.sweep();
      assert.deepEqual(legacy.observations, ["read-open", "judge", issueOpen ? "close" : "fix"],
        "revalidate before judging or closing; a closed escalation resumes the owner fix lane");
      assert.deepEqual(legacy.calls, issueOpen ? ["close"] : ["fix"]);
      assert.equal(legacy.rows.some(r => r.step === "sweep.strike_ladder.requeued" && r.pr_number === PR), issueOpen,
        "only an escalation observed still open can trigger the aged-hold rebuild");
    });
  }

  const clock = { now: NOW - HELD_ESCALATION_SLO_MS - MIN };
  const owned = fixture(t, HELD_ESCALATION_SLO_MS + MIN, clock, false, undefined, true);
  await owned.sweep();
  const hold = owned.rows.findLast(r => r.step === "sweep.disposed" && r.pr_number === PR);
  assert.equal(hold?.open_escalation_hold_since, new Date(clock.now).toISOString(),
    "the production open-issue guard persists when its own hold began");
  assert.equal(owned.rows.some(r => r.step === "fix.stood_down"), false,
    "the timer cannot rely on a fix-lane stand-down row for this path");
  clock.now = NOW - 2 * MIN;
  await owned.sweep();
  assert.equal(owned.calls.includes("close"), false, "the sweep-owned hold stays inside its SLO");
  clock.now = NOW;
  await owned.sweep();
  assert.deepEqual(owned.calls, ["close"], "the aged sweep-owned hold is rebuilt without an operator");
  assert.ok(owned.rows.some(r => r.step === "sweep.strike_ladder.requeued" && r.pr_number === PR),
    "the task is requeued after the production guard's hold expires");

  const answeredClock = { now: NOW - HELD_ESCALATION_SLO_MS - MIN };
  const answered = fixture(t, HELD_ESCALATION_SLO_MS + MIN, answeredClock, false, undefined, true);
  await answered.sweep();
  answered.open.length = 0;
  answeredClock.now = NOW;
  await answered.sweep();
  assert.equal(answered.calls.includes("close"), false, "a closed escalation releases the sweep hold before the ladder");
  assert.ok(answered.calls.includes("fix"), "the ordinary repair path resumes once the issue is closed");
});
