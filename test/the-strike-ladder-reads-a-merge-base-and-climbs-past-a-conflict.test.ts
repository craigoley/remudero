import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import { appendOperatorNote, loadOperatorNotesForTask } from "../src/lib/operator-notes.js";
import type { Plan } from "../src/lib/plan.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const stamp = (offset = 0) => new Date(NOW + offset).toISOString();
const MAIN = { sha: "main-tip", committedAt: stamp(-1000) };
const COMPARE = "api repos/acme/remudero/compare/main...old-head";

// A ladder-due PR OUTSIDE the review-orphan population: run-task.ts hydrates `currentMergeBaseSha`
// only for review-orphaned PRs, so this one arrives with the field absent — the shape of #9066.
function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9066, prUrl: "https://github.com/acme/remudero/pull/9066", taskId: "W1-T5532",
    headSha: "old-head", headRefName: "run-W1-T5532-1",
    checksState: "red", reviewState: "success", unmetCriteria: [],
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap, lastActivityAt: stamp(), autoMergeArmed: false,
    ciFailures: [{ name: "coverage-shard (2/8)", logTail: "not ok 3 - a shard invariant\n" }],
    strikeHistory: [{ strike: 1, round: "fresh", unmetCount: 1, ciGreen: false }],
    ...over,
  };
}

function fixture(t: { after: (fn: () => void) => void }, compare: () => unknown = () => ({ merge_base_commit: { sha: "old-main" } })) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}strike-ladder-merge-base-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows: Record<string, unknown>[] = [
    { step: "fix.dispatch", task_id: "W1-T5532", head_sha: "old-head", ts: stamp(-2000), strike: 1 },
    { step: "fix.commit_refused", task_id: "W1-T5532", head_sha: "old-head", reason: "the worker changed nothing", strike: 1 },
  ];
  const calls: string[] = [];
  const reads: string[] = [];
  const open: OpenIssue[] = [];
  const closed = new Set<number>();
  const issues: IssueGateway = {
    ensureLabel: () => true,
    listOpen: () => open,
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
    ledgerPath: join(root, "ledger.ndjson"), runId: "merge-base-test",
    log: (step, extra) => { rows.push({ step, ...extra }); },
    issuesImpl: issues, ghRunImpl: () => undefined, nowMsImpl: () => NOW,
    readJsonImpl: async (args) => {
      reads.push(args.join(" "));
      return args[1]?.includes("/compare/") ? compare() : { user: { login: "remudero-fleet[bot]" } };
    },
  });
  const deps: SweepDeps = {
    strikeLadder: effects.strikeLadder,
    arm: () => { calls.push("arm"); },
    close: (candidate) => { calls.push("close"); closed.add(candidate.prNumber); },
    updateBranch: () => { calls.push("refresh"); return "updated"; },
    dispatchFix: () => { calls.push("fix"); }, escalate: () => { calls.push("escalate"); },
    readLiveState: (candidate) => ({ ok: true, state: closed.has(candidate.prNumber) ? "CLOSED" : "OPEN", headSha: candidate.headSha }),
    readMainRepair: () => MAIN, readMainTip: () => MAIN.sha,
    ledgerPath: join(root, "ledger.ndjson"), runId: "merge-base-test",
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: stamp(), ...row }); }, now: () => NOW,
  };
  const spend = (n: number) => {
    for (let i = 0; i < n; i++) assert.equal(appendOperatorNote(root, { taskId: "W1-T5532", author: "strike-ladder", ts: stamp(), note: `prior rebuild ${i}` }), true);
  };
  return { root, rows, calls, reads, open, deps, spend, sweep: (prs: OpenPrView[] = [pr()]) => runSweep(prs, deps) };
}

test("W1-T5635: a ladder-due PR without a hydrated merge base reads one compare and refreshes", async (t) => {
  const f = fixture(t);
  const result = await f.sweep();
  assert.deepEqual(f.reads.filter(r => r.includes("/compare/")), [COMPARE]);
  assert.deepEqual(f.calls, ["refresh"]);
  assert.ok(f.rows.some(r => r.step === "sweep.strike_ladder.refreshed" && r.main_sha === MAIN.sha && r.pr_number === 9066));
  assert.doesNotMatch(result.actions[0].reason, /merge base unreadable/);
  const hydrated = fixture(t);
  await hydrated.sweep([pr({ currentMergeBaseSha: "old-main" })]);
  assert.equal(hydrated.reads.some(r => r.includes("/compare/")), false, "a hydrated merge base spends no compare");
  assert.deepEqual(hydrated.calls, ["refresh"]);
});

test("W1-T5635: an unreadable merge base stays a named hold", async (t) => {
  for (const [compare, reason] of [
    [() => ({}), /strike ladder hold: merge base unreadable/],
    [() => { throw new Error("compare outage"); }, /strike ladder hold: Error: compare outage/],
  ] as const) {
    const f = fixture(t, compare);
    const result = await f.sweep();
    assert.match(result.actions[0].reason, reason);
    assert.deepEqual(f.calls, []);
    assert.equal(f.rows.some(r => r.step === "sweep.strike_ladder.refreshed"), false);
  }
});

test("W1-T5635: a refresh that conflicts climbs to close-and-requeue in the same pass", async (t) => {
  const f = fixture(t);
  f.deps.updateBranch = () => { f.calls.push("refresh"); return "conflict"; };
  const result = await f.sweep();
  assert.deepEqual(f.calls, ["refresh", "close"]);
  assert.match(result.actions[0].reason, /strike ladder rebuild 1\/2/);
  assert.ok(f.rows.some(r => r.step === "sweep.strike_ladder.held" && r.refresh_outcome === "conflict" && r.main_sha === MAIN.sha));
  assert.ok(f.rows.some(r => r.step === "sweep.strike_ladder.requeued" && r.rebuild === 1));
  assert.equal(loadOperatorNotesForTask(f.root, "W1-T5532").length, 1);
  assert.equal(f.rows.some(r => r.step === "sweep.strike_ladder.refreshed"), false);
});

test("W1-T5635: a conflicting refresh with its rebuilds spent opens the digest and is not retried at that main tip", async (t) => {
  const f = fixture(t);
  f.spend(2);
  f.deps.updateBranch = () => { f.calls.push("refresh"); return "conflict"; };
  await f.sweep();
  assert.deepEqual(f.calls, ["refresh", "create"]);
  assert.equal(f.open.length, 1);
  await f.sweep();
  assert.deepEqual(f.calls, ["refresh", "create"], "the recorded conflict stands in for the refresh at this main tip");
  f.deps.readMainRepair = () => ({ sha: "later-main", committedAt: stamp(500) });
  await f.sweep();
  assert.equal(f.calls.filter(c => c === "refresh").length, 2, "a later main tip earns one more refresh");
});

test("W1-T5635: a refresh error other than a conflict still holds", async (t) => {
  const f = fixture(t);
  f.deps.updateBranch = () => { f.calls.push("refresh"); return "error"; };
  const result = await f.sweep();
  assert.deepEqual(f.calls, ["refresh"]);
  assert.match(result.actions[0].reason, /strike ladder hold: refresh did not take: error/);
  assert.equal(f.rows.some(r => r.step === "sweep.strike_ladder.requeued"), false);
});
