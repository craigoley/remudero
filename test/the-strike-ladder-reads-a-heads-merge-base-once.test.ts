import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const MAIN = { sha: "main-tip", committedAt: new Date(NOW - 1000).toISOString() };
const PROOF = "test/the-strike-ladder-reads-a-heads-merge-base-once.test.ts";

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 5673, prUrl: "https://github.com/acme/remudero/pull/5673", taskId: "W1-T5673",
    headSha: "old-head", headRefName: "run-W1-T5673-1", checksState: "red",
    reviewState: "success", unmetCriteria: [], priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
    lastActivityAt: new Date(NOW).toISOString(), autoMergeArmed: false,
    ciFailures: [{ name: "coverage-shard (2/8)", logTail: "not ok 3 - invariant\n" }],
    strikeHistory: [{ strike: 1, round: "fresh", unmetCount: 1, ciGreen: false }], ...over,
  };
}

function fixture(t: { after: (fn: () => void) => void }, compare: () => unknown = () => ({ merge_base_commit: { sha: "old-main" } })) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}merge-base-once-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reads: string[] = [];
  const rows: Record<string, unknown>[] = [{ step: "fix.dispatch", task_id: "W1-T5673",
    head_sha: "old-head", ts: new Date(NOW - 2000).toISOString(), strike: 1 }];
  const makeEffects = () => buildSweepEffects({
    owner: "acme", repo: "remudero", repoRoot: root,
    config: { root, claudeBin: "/bin/true" } as Config,
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    ledgerPath: join(root, "ledger.ndjson"), runId: "merge-base-once",
    log: () => {}, ghRunImpl: () => undefined,
    readJsonImpl: async (args) => {
      if (args[1]?.includes("/compare/")) { reads.push(args.join(" ")); return compare(); }
      return { user: { login: "remudero-fleet[bot]" } };
    },
  }).strikeLadder;
  const deps: SweepDeps = {
    strikeLadder: makeEffects(), arm: () => {}, close: () => {},
    dispatchFix: () => {}, escalate: () => {}, updateBranch: () => "error",
    readLiveState: (candidate) => ({ ok: true, state: "OPEN", headSha: candidate.headSha }),
    readMainRepair: () => MAIN, readMainTip: () => MAIN.sha,
    ledgerPath: join(root, "ledger.ndjson"), runId: "merge-base-once",
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); }, now: () => NOW,
  };
  return { reads, deps, makeEffects, sweep: (prs: OpenPrView[] = [pr()]) => runSweep(prs, deps) };
}

test(`${PROOF}: two sweep passes over the same laddered head issue one compare read`, async (t) => {
  const f = fixture(t);
  await f.sweep();
  assert.equal(f.reads.length, 1);
  f.deps.strikeLadder = f.makeEffects();
  f.deps.readMainRepair = () => ({ ...MAIN, sha: "later-main" });
  await f.sweep();
  assert.deepEqual(f.reads, ["api repos/acme/remudero/compare/main...old-head"]);
});

test(`${PROOF}: a failed read is retried on the next pass`, async (t) => {
  for (const throws of [false, true]) {
    let attempts = 0;
    const f = fixture(t, () => {
      if (++attempts === 1) {
        if (throws) throw new Error("compare outage");
        return {};
      }
      return { merge_base_commit: { sha: "old-main" } };
    });
    const held = await f.sweep();
    assert.match(held.actions[0].reason, throws ? /compare outage/ : /merge base unreadable/);
    const retried = await f.sweep();
    assert.match(retried.actions[0].reason, /refresh did not take: error/);
    await f.sweep();
    assert.equal(attempts, 2);
  }
});

test(`${PROOF}: a changed head and a closed then reopened PR read again`, async (t) => {
  const f = fixture(t);
  await f.sweep();
  await f.sweep([pr({ headSha: "new-head" })]);
  assert.equal(f.reads.length, 2);
  await f.sweep([pr()]);
  assert.equal(f.reads.length, 3, "the superseded head was pruned");
  await f.sweep([]);
  await f.sweep();
  assert.equal(f.reads.length, 4, "the closed PR was pruned");
});

test(`${PROOF}: separate PRs and sweep ledgers do not share a cached base`, async (t) => {
  const f = fixture(t);
  await f.sweep([pr(), pr({ prNumber: 5674, prUrl: "https://github.com/acme/remudero/pull/5674" })]);
  assert.equal(f.reads.length, 2);
  const other = fixture(t);
  await other.sweep();
  assert.equal(other.reads.length, 1);
});

test(`${PROOF}: no main repair skips compare and hydration needs no compare`, async (t) => {
  const f = fixture(t);
  f.deps.readMainRepair = () => undefined;
  const held = await f.sweep();
  assert.match(held.actions[0].reason, /main tip unavailable/);
  assert.equal(f.reads.length, 0);
  f.deps.readMainRepair = () => MAIN;
  await f.sweep([pr({ currentMergeBaseSha: "old-main" })]);
  assert.equal(f.reads.length, 0);
  await f.sweep();
  assert.equal(f.reads.length, 1);
});

test(`${PROOF}: a light pass does not prune other open heads`, async (t) => {
  const f = fixture(t);
  const other = pr({ prNumber: 5674, prUrl: "https://github.com/acme/remudero/pull/5674" });
  await f.sweep([pr(), other]);
  f.deps.repairAdmissionSurface = "light";
  await f.sweep();
  f.deps.repairAdmissionSurface = undefined;
  await f.sweep([pr(), other]);
  assert.equal(f.reads.length, 2);
});
