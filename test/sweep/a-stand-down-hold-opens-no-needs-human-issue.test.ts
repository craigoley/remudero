import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import { PARKED_PR_REMEDY_STEP } from "#src/lib/parked-pr-remedy.js";
import type { Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { buildSweepEffects, HELD_ESCALATION_SLO_MS, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

// W1-T13045: the operator ruled that no pull request waits on the operator. From 2026-11-08 to 2026-11-15 the W1-T10339
// stand-down hold still opened 26 needs-human issues on 19 open pull requests (for example #18616 at 528d4c6, "fix stood
// down at rung.strike and nothing it read has changed"). The hold is right; the issue is not. With the production parkedPr
// effect wired, the hold writes one parked_pr.remedy row per pull request, head and stand-down site, and opens no issue.

const MIN = 60_000;
const NOW = Date.parse("2026-11-15T07:32:00.000Z");
const stamp = (offset = 0) => new Date(NOW + offset).toISOString();
const TASK = "W1-T13045-FIXTURE";
const PR = 18616;
const HEAD = "528d4c6".padEnd(40, "0");
const NEW_HEAD = "9b1e2f0".padEnd(40, "0");
const RUN = "stand-down-hold-run";
const SITE = "rung.strike";
const HOLD_REASON = "the same evidence would strike again at this head";

function fixture(t: { after: (fn: () => void) => void }, opts: { heldForMs?: number; parked?: boolean;
  judge?: SweepDeps["fixProgressJudge"] } = {}) {
  const heldForMs = opts.heldForMs ?? 30 * MIN;
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stand-down-hold-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const rows: Record<string, unknown>[] = [
    { step: "sweep.disposed", pr_number: PR, head_sha: HEAD, task_id: TASK, run_id: RUN, disposition: "blocked-fixable",
      acted: true, ts: stamp(-heldForMs - 20 * MIN) },
    { step: "fix.dispatch", task_id: TASK, head_sha: HEAD, run_id: RUN, mode: "reviewer-unmet", strike: 1, ts: stamp(-heldForMs - 19 * MIN) },
    { step: "fix.stood_down", task_id: TASK, head_sha: HEAD, run_id: RUN, site: SITE, reason: HOLD_REASON,
      read_head_sha: HEAD, read_contract_revision: "contract-A", ts: stamp(-heldForMs) },
  ];
  const calls: string[] = [];
  const closed = new Set<number>();
  const issues: IssueGateway = {
    ensureLabel: () => true, listOpen: () => [],
    create: () => { calls.push("issue"); return "https://github.com/acme/remudero/issues/1"; },
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
  assert.ok(effects.parkedPr, "the production effects wire the parkedPr host");
  const contract = { revision: "contract-A" };
  const deps: SweepDeps = {
    strikeLadder: effects.strikeLadder,
    ...(opts.parked === false ? {} : { parkedPr: effects.parkedPr }),
    fixProgressJudge: opts.judge ?? (async () => ({ verdict: "change-approach", reason: "the same round stood down twice",
      approach: "strike on new evidence only" })),
    readTaskContractRevision: () => contract.revision,
    arm: () => { calls.push("arm"); },
    close: (candidate) => { calls.push("close"); closed.add(candidate.prNumber); },
    updateBranch: () => { calls.push("refresh"); return "updated"; },
    dispatchFix: () => { calls.push("fix"); },
    escalate: () => { calls.push("escalate"); },
    claimFixAdmission: () => ({ admitted: true }),
    readLiveState: (candidate) => ({ ok: true, state: closed.has(candidate.prNumber) ? "CLOSED" : "OPEN", headSha: candidate.headSha }),
    ledgerPath: join(root, "ledger.ndjson"), runId: RUN,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: stamp(), ...row }); }, now: () => NOW,
    log: () => undefined,
  } as SweepDeps;
  const pr: OpenPrView = {
    prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: TASK, headSha: HEAD,
    headRefName: `run-${TASK}-1794776376000`, checksState: "green", reviewState: "failure",
    unmetCriteria: [{ claim: "the stand-down hold opens no issue", proof: "unit test: W1-T13045",
      met: false, reason: "the hold opens an issue", proof_exec: "executed_fail" }],
    priorStrikes: 1, autoMergeArmed: false, lastActivityAt: stamp(-heldForMs),
    body: `Builds the remedy.\n\nRemudero-Task: ${TASK}\n`,
  };
  const remedies = () => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP);
  const holds = () => rows.filter(r => r.step === "sweep.disposed" && r.run_id === RUN && r.stand_down_hold === true);
  return { rows, calls, pr, contract, remedies, holds, sweep: (view: OpenPrView = pr) => runSweep([view], deps) };
}

/** invariant:no-stand-down-issue, read off the ledger. */
const issueOutcomes = (holds: readonly Record<string, unknown>[]) => holds.filter(r =>
  r.stand_down_escalation_outcome === "delivered" || r.stand_down_escalation_outcome === "failed");

test("W1-T13045 criterion 1: a stand-down hold with the production parkedPr effect writes one remedy row and opens no issue", async (t) => {
  const legacy = fixture(t, { parked: false });
  await legacy.sweep();
  assert.deepEqual(legacy.calls, ["escalate"], "without parkedPr the hold opens a needs-human issue as before");
  assert.equal(legacy.holds()[0]!.stand_down_escalation_outcome, "delivered");

  const f = fixture(t);
  await f.sweep();
  assert.deepEqual(f.calls, [], "deps.escalate is never called, and no worker is dispatched on the unchanged inputs");
  const held = f.holds();
  assert.equal(held.length, 1, "the pass writes a sweep.disposed row with stand_down_hold true");
  assert.equal(held[0]!.stand_down_site, SITE);
  assert.equal(held[0]!.disposition, "refused-escalate", "the hold keeps its disposition, so the held-escalation ladder still reads it");
  assert.equal(held[0]!.acted, false);
  assert.match(String(held[0]!.stand_down_reason), /parked-pr remedy fix-on-pr \(W1-T13045\).*no needs-human issue is opened/);
  assert.deepEqual(f.remedies().map(r => [r.pr_number, r.head_sha, r.remedy, r.cause, r.outcome, r.text]),
    [[PR, HEAD, "fix-on-pr", `stand-down:${SITE}`, "taken", HOLD_REASON]]);
});

test("W1-T13045 criterion 2: invariant:no-stand-down-issue, no hold row written with parkedPr wired carries an issue outcome", async (t) => {
  const legacy = fixture(t, { parked: false });
  for (let pass = 0; pass < 3; pass++) await legacy.sweep();
  assert.equal(issueOutcomes(legacy.holds()).length, 1, "the check reads the issue outcome the old path writes");

  const f = fixture(t);
  for (let pass = 0; pass < 3; pass++) await f.sweep();
  const aged = fixture(t, { heldForMs: HELD_ESCALATION_SLO_MS + 10 * MIN, judge: async () => { throw new Error("judge unreachable"); } });
  for (let pass = 0; pass < 2; pass++) await aged.sweep();
  for (const w of [f, aged]) {
    assert.ok(w.holds().length > 0, "the hold rows exist");
    assert.deepEqual(issueOutcomes(w.holds()), [], "no hold row carries stand_down_escalation_outcome delivered or failed");
    assert.equal(w.calls.includes("escalate"), false);
  }
});

test("W1-T13045 criterion 3: invariant:one-row, five passes over the same pull request, head and site write one remedy row", async (t) => {
  const f = fixture(t);
  for (let pass = 0; pass < 5; pass++) await f.sweep();
  assert.equal(f.remedies().length, 1, "exactly one parked_pr.remedy row");
  assert.equal(f.holds().length, 5, "every pass holds");
  assert.deepEqual(f.calls, [], "no issue and no worker on any pass");
  assert.match(String(f.holds().at(-1)!.stand_down_reason), /parked-pr remedy fix-on-pr is already recorded for this head/);
});

test("W1-T13045 criterion 4: a new head or a changed task contract still releases the hold and dispatches a fix round", async (t) => {
  const headed = fixture(t);
  await headed.sweep();
  assert.equal(headed.remedies().length, 1);
  await headed.sweep({ ...headed.pr, headSha: NEW_HEAD });
  assert.deepEqual(headed.calls, ["fix"], "the new head gets a fix round as it does today");
  assert.equal(headed.remedies().filter(r => r.head_sha === NEW_HEAD).length, 0, "no remedy row for the new head");

  const amended = fixture(t);
  await amended.sweep();
  amended.contract.revision = "contract-B";
  await amended.sweep();
  assert.deepEqual(amended.calls, ["fix"], "the changed task contract gets a fix round as it does today");
  assert.equal(amended.remedies().length, 1, "the release writes no second remedy row");
  assert.equal(amended.holds().length, 1, "the released pass is not a hold");
});

test("W1-T13045 criterion 5: a stand-down hold past HELD_ESCALATION_SLO_MS still reaches the held-escalation ladder", async (t) => {
  const f = fixture(t, { heldForMs: HELD_ESCALATION_SLO_MS + 10 * MIN });
  await f.sweep();
  assert.deepEqual(f.calls, ["close"], "applyStrikeLadder's judged rebuild acts, and deps.escalate is called zero times");
  assert.ok(f.rows.some(r => r.step === "sweep.strike_ladder.requeued" && r.pr_number === PR), "the task is requeued");

  const holding = fixture(t, { heldForMs: HELD_ESCALATION_SLO_MS + 10 * MIN, judge: async () => { throw new Error("judge unreachable"); } });
  for (let pass = 0; pass < 2; pass++) await holding.sweep();
  assert.equal(holding.calls.includes("escalate"), false, "a ladder that holds opens no issue either");
  assert.ok(holding.holds().every(r => typeof r.held_escalation_ladder === "string" ||
    /ladder: /.test(String(r.stand_down_reason))), "each pass reached the ladder");
  assert.equal(holding.remedies().length, 1, "the hold still names its one remedy row");
});
