import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Plan } from "../src/lib/plan.js";
import {
  BLOCKER_SLO_MS, blockerFields, decideSloRung, PR_BLOCKER_OWNERS, PR_BLOCKERS, priorBlockersFromLedger,
  SLO_CLIMBING_BLOCKERS, type PrBlocker, type SloRungInput, type SloRungTaken,
} from "../src/lib/pr-blocker.js";
import {
  buildSweepEffects, DEFAULT_SWEEP_POLICY, DISPOSITION_RULES, postReviewFailureHistoryDisposition,
  runSweep, type OpenPrView, type SweepDeps,
} from "./helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const MIN = 60_000;
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const stamp = (offset = 0) => new Date(NOW + offset).toISOString();

const input = (over: Partial<SloRungInput> = {}): SloRungInput => ({
  blocker: "strikes-exhausted", owner: "strike-ladder", reasonClass: "other",
  blockerAgeMs: BLOCKER_SLO_MS + MIN, rungHistory: [], nowMs: NOW, ...over,
});

test("every blocked-ambiguous source in DISPOSITION_RULES maps to a rung with a deadline", () => {
  assert.equal(BLOCKER_SLO_MS, 45 * MIN);
  const sources: Array<{ source: string; blocker: PrBlocker }> = [];
  DISPOSITION_RULES.forEach((rule, i) => {
    if (rule.disposition === "blocked-ambiguous") sources.push({ source: `DISPOSITION_RULES[${i}]`, blocker: rule.blocker });
  });
  assert.ok(sources.length >= 10, "the table still carries its blocked-ambiguous rows");
  // The deriveDisposition default is unreachable through the table; it is pinned by its own literal.
  sources.push({ source: "deriveDisposition default", blocker: "other" });
  // postReviewFailureHistoryDisposition: both rows, reached through a prior that always matches.
  class AllKeys extends Set<string> { override has(): boolean { return true; } }
  class ManyThrows extends Map<string, number> { override get(): number { return 99; } }
  const postPr = { ...basePr(), checksState: "green", reviewState: "none" } as OpenPrView;
  const ceiling = postReviewFailureHistoryDisposition(postPr,
    { reviewDiffCeilingRefused: new AllKeys(), reviewRetryableThrowCounts: new Map() }, DEFAULT_SWEEP_POLICY, NOW);
  const thrown = postReviewFailureHistoryDisposition(postPr,
    { reviewDiffCeilingRefused: new Set(), reviewRetryableThrowCounts: new ManyThrows() }, DEFAULT_SWEEP_POLICY, NOW);
  for (const [source, d] of [["post-review ceiling row", ceiling], ["post-review throw row", thrown]] as const) {
    assert.equal(d?.disposition, "blocked-ambiguous", source);
    sources.push({ source, blocker: d!.blocker });
  }
  for (const { source, blocker } of sources) {
    assert.ok(SLO_CLIMBING_BLOCKERS.includes(blocker), `${source} (${blocker}) has no SLO rung`);
    const owner = PR_BLOCKER_OWNERS[blocker];
    const over = decideSloRung(input({ blocker, owner }));
    assert.notEqual(over.rung, "none", `${source} (${blocker}) takes no rung past its deadline`);
    assert.equal(over.deadlineMs, BLOCKER_SLO_MS, source);
    assert.equal(decideSloRung(input({ blocker, owner, blockerAgeMs: BLOCKER_SLO_MS - 1 })).rung, "none", `${source} under SLO`);
  }
  // Every owner-NONE blocker climbs, whether or not it is in the explicit set.
  for (const blocker of PR_BLOCKERS) {
    if (PR_BLOCKER_OWNERS[blocker] === "NONE") assert.notEqual(decideSloRung(input({ blocker, owner: "NONE" })).rung, "none", blocker);
  }
  // A blocker owned by a live lane that no blocked-ambiguous source carries does not climb.
  assert.equal(decideSloRung(input({ blocker: "awaiting-review", owner: "review-lane" })).rung, "none");
});

test("a no-op hold older than 45 minutes rebuilds without refreshing", () => {
  const noOp = input({ reasonClass: "no-op-hold" });
  assert.equal(decideSloRung(noOp).rung, "rebuild");
  assert.equal(decideSloRung({ ...noOp, blockerAgeMs: BLOCKER_SLO_MS - 1 }).rung, "none");
  // The same age with an ordinary blocker climbs from refresh.
  assert.equal(decideSloRung(input()).rung, "refresh");
  // A rebuild that cannot run falls to the digest, never back to refresh.
  assert.equal(decideSloRung({ ...noOp, unavailable: ["rebuild"] }).rung, "digest");
  // Rungs already taken at this head are skipped; a rung taken at another head is not.
  const taken = (rung: SloRungTaken["rung"], atThisHead: boolean): SloRungTaken => ({ rung, atThisHead, atMs: NOW - 90 * MIN });
  assert.equal(decideSloRung(input({ rungHistory: [taken("refresh", true)] })).rung, "rebuild");
  assert.equal(decideSloRung(input({ rungHistory: [taken("refresh", true), taken("rebuild", true)] })).rung, "digest");
  assert.equal(decideSloRung(input({ rungHistory: [taken("refresh", false)] })).rung, "refresh");
  assert.equal(decideSloRung(input({ rungHistory: [taken("digest", true), taken("refresh", true), taken("rebuild", true)] })).rung, "none");
});

test("a second rebuild for the same task on the same UTC day is refused", () => {
  const rebuild = (atMs: number): SloRungTaken => ({ rung: "rebuild", atMs, atThisHead: false });
  const noOp = input({ reasonClass: "no-op-hold" });
  const sameDay = decideSloRung({ ...noOp, rungHistory: [rebuild(NOW - 3 * 60 * MIN)] });
  assert.equal(sameDay.rung, "digest");
  assert.match(sameDay.reason, /one per task per day/);
  // 11:59 UTC the day before and 12:00 today are different UTC days.
  assert.equal(decideSloRung({ ...noOp, rungHistory: [rebuild(NOW - 24 * 60 * MIN)] }).rung, "rebuild");
  assert.equal(decideSloRung({ ...noOp, rungHistory: [rebuild(Date.parse("2026-10-03T23:59:59.000Z"))] }).rung, "rebuild");
  // The lifetime cap of 2 still holds when neither rebuild is from today.
  const spent = [rebuild(NOW - 3 * 24 * 60 * MIN), rebuild(NOW - 2 * 24 * 60 * MIN)];
  const lifetime = decideSloRung({ ...noOp, rungHistory: spent });
  assert.equal(lifetime.rung, "digest");
  assert.match(lifetime.reason, /lifetime cap of 2/);
});

test("a replay of #8954's hold rows yields a rung action within 45 minutes", () => {
  // 451 hold rows over 10.2 h (~1.36 min apart), each the `sweep.disposed` row a pass wrote.
  const rows: Record<string, unknown>[] = [];
  const start = Date.parse("2026-10-04T01:32:00.000Z");
  const span = 10.2 * 60 * MIN;
  const firstActionAt: { at?: number; rung?: string } = {};
  let actions = 0;
  for (let i = 0; i < 451; i++) {
    const now = start + Math.round((span * i) / 450);
    const fields = blockerFields("strikes-exhausted", priorBlockersFromLedger(rows).get(8954), now);
    const d = decideSloRung({
      blocker: fields.blocker, owner: fields.blocker_owner, reasonClass: "no-op-hold",
      blockerAgeMs: fields.blocker_age_ms, rungHistory: [], nowMs: now,
    });
    if (d.rung !== "none") { actions++; firstActionAt.at ??= now; firstActionAt.rung ??= d.rung; }
    rows.push({ step: "sweep.disposed", pr_number: 8954, acted: false, ts: new Date(now).toISOString(), ...fields });
  }
  assert.ok(firstActionAt.at !== undefined, "the replay yields no rung action at all");
  assert.equal(firstActionAt.rung, "rebuild");
  assert.ok(firstActionAt.at - start <= BLOCKER_SLO_MS + 2 * MIN, `first action ${(firstActionAt.at - start) / MIN} min in`);
  assert.ok(firstActionAt.at - start >= BLOCKER_SLO_MS, "never before the SLO");
  assert.ok(actions > 400, "once over the SLO every pass has a rung to take until one is recorded");
});

// ---- runSweep: the rung is applied and logged -------------------------------------------------

const MAIN = { sha: "main-tip", committedAt: stamp(-1000) };

function basePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 8954, prUrl: "https://github.com/acme/remudero/pull/8954", taskId: "W1-T4270",
    headSha: "old-head", headRefName: "run-W1-T4270-1", currentMergeBaseSha: "old-main",
    checksState: "red", reviewState: "success", unmetCriteria: [],
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap, lastActivityAt: stamp(), autoMergeArmed: false,
    ciFailures: [{ name: "coverage-shard (2/8)", logTail: "not ok 3 - a shard invariant\n" }],
    strikeHistory: [{ strike: 1, round: "fresh", unmetCount: 1, ciGreen: false }],
    ...over,
  };
}

function fixture(t: { after: (fn: () => void) => void }, ageMin: number, extraRows: Record<string, unknown>[] = []) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}slo-rung-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows: Record<string, unknown>[] = [
    { step: "fix.dispatch", task_id: "W1-T4270", head_sha: "old-head", ts: stamp(-2000), strike: 1 },
    { step: "sweep.disposed", pr_number: 8954, blocker: "strikes-exhausted", blocker_since: stamp(-ageMin * MIN), ts: stamp(-MIN) },
    ...extraRows,
  ];
  const calls: string[] = [];
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
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
    ledgerPath: join(root, "ledger.ndjson"), runId: "slo-test",
    log: () => undefined, issuesImpl: issues, ghRunImpl: () => undefined, nowMsImpl: () => NOW,
    readJsonImpl: async () => ({ user: { login: "remudero-fleet[bot]" } }),
  });
  const deps: SweepDeps = {
    strikeLadder: effects.strikeLadder,
    arm: () => { calls.push("arm"); },
    close: (candidate) => { calls.push("close"); closed.add(candidate.prNumber); },
    updateBranch: () => { calls.push("refresh"); return "updated"; },
    dispatchFix: () => { calls.push("fix"); }, escalate: () => { calls.push("escalate"); },
    readLiveState: (candidate) => ({ ok: true, state: closed.has(candidate.prNumber) ? "CLOSED" : "OPEN", headSha: candidate.headSha }),
    readMainRepair: () => MAIN, readMainTip: () => MAIN.sha,
    ledgerPath: join(root, "ledger.ndjson"), runId: "slo-test",
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: stamp(), ...row }); }, now: () => NOW,
    log: (step: string, extra: Record<string, unknown>) => { logs.push({ step, extra }); },
  } as SweepDeps;
  return { rows, calls, logs, open, deps, sweep: (prs: OpenPrView[]) => runSweep(prs, deps) };
}

test("runSweep: an aged no-op hold is closed and requeued without a refresh, and logs sweep.slo_rung", async (t) => {
  // Main has moved since the last attempt, so the plain ladder would refresh this head first.
  const f = fixture(t, 50);
  await f.sweep([basePr({ repeatedFixRefusal: "the worker changed nothing" })]);
  assert.deepEqual(f.calls, ["close"], "rebuild without a refresh");
  assert.ok(f.rows.some(r => r.step === "sweep.strike_ladder.requeued" && r.pr_number === 8954));
  assert.equal(f.rows.some(r => r.step === "sweep.strike_ladder.refreshed"), false);
  const slo = f.logs.filter(l => l.step === "sweep.slo_rung");
  assert.equal(slo.length, 1);
  assert.deepEqual(slo[0].extra, { pr: 8954, blocker: "strikes-exhausted", age_min: 50, rung: "rebuild" });
});

test("runSweep: the same no-op hold inside its SLO takes the ordinary ladder and logs no slo rung", async (t) => {
  const f = fixture(t, 10);
  await f.sweep([basePr({ repeatedFixRefusal: "the worker changed nothing" })]);
  assert.deepEqual(f.calls, ["refresh"]);
  assert.equal(f.logs.some(l => l.step === "sweep.slo_rung"), false);
});

test("runSweep: a second rebuild for the same task on the same UTC day opens the digest instead", async (t) => {
  const earlier = { step: "sweep.strike_ladder.requeued", task_id: "W1-T4270", pr_number: 8900,
    head_sha: "other-head", ts: stamp(-3 * 60 * MIN), rebuild: 1 };
  const f = fixture(t, 50, [earlier]);
  await f.sweep([basePr({ repeatedFixRefusal: "the worker changed nothing" })]);
  assert.equal(f.calls.includes("close"), false, "no second close today");
  assert.deepEqual(f.calls, ["create"]);
  assert.equal(f.logs.find(l => l.step === "sweep.slo_rung")?.extra.rung, "digest");
});
