import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname } from "node:path";
import type { ArmReprobeFacts } from "../src/lib/arm-auto-merge.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { readLedgerLines } from "../src/lib/status.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const NOW = Date.now();
const HEAD = "6052".padEnd(40, "a");
function pending(): OpenPrView {
  return { prNumber: 6052, prUrl: "https://github.com/o/r/pull/6052", taskId: "W1-T6052",
    headSha: HEAD, checksState: "pending", reviewState: "success", autoMergeArmed: false,
    checksPendingSince: new Date(NOW - 90 * 60_000).toISOString(),
    lastActivityAt: new Date(NOW - 90 * 60_000).toISOString(), priorStrikes: 0, unmetCriteria: [] };
}
function facts(over: Partial<ArmReprobeFacts> = {}): ArmReprobeFacts {
  return { prNumber: 6052, headSha: HEAD, state: "open", checksGreen: true, reviewPublished: true,
    autoMergeArmed: false, mergeable: true, mergeableState: "clean", baseSha: "base", ...over };
}
function fixture(reader?: SweepDeps["readArmFacts"]) {
  const ledger = writeLedger();
  const armed: OpenPrView[] = [];
  const escalated: OpenPrView[] = [];
  const deps: SweepDeps = { ledgerPath: ledger.path, runId: "T6052", now: () => NOW,
    arm: pr => { armed.push(pr); return "armed"; }, escalate: pr => { escalated.push(pr); },
    close: () => {}, dispatchFix: () => {}, readArmFacts: reader,
    readLiveHeadSha: pr => pr.headSha, readLedgerUnion: () => ({ complete: false, lines: [] }) };
  return { deps, armed, escalated, rows: () => readLedgerLines(ledger.path) };
}

test("W1-T6052: flow-awaiting-ci-stale-pending clears without a person", async () => {
  const readHeads: string[] = [];
  const f = fixture(pr => { readHeads.push(pr.headSha); return facts(); });
  const snapshot = pending();
  const result = await runSweep([snapshot], f.deps, DEFAULT_SWEEP_POLICY);
  assert.ok(readHeads.length > 0);
  assert.ok(readHeads.every(head => head === HEAD), "reads belong to the exact snapshot head");
  assert.equal(f.escalated.length, 0);
  assert.equal(f.armed.length, 1);
  assert.equal(f.armed[0].checksState, "green");
  assert.equal(f.armed[0].checksPendingSince, undefined);
  assert.equal(snapshot.checksState, "pending", "refresh does not mutate the input snapshot");
  assert.equal(result.actions[0].disposition, "mergeable");
  const row = f.rows().findLast(row => row.step === "sweep.disposed");
  assert.notEqual(row?.blocker, "awaiting-ci");
  assert.doesNotMatch(String(row?.reason), /stale-pending/);
});

test("stale pending retains its escalation without positive exact-head completion", async t => {
  for (const [name, reader] of [
    ["unwired", undefined], ["unreadable", () => undefined],
    ["unfinished or failed CI", () => facts({ checksGreen: false })],
    ["different head", () => facts({ headSha: "other" })],
    ["different PR", () => facts({ prNumber: 6053 })],
    ["closed PR", () => facts({ state: "closed" })],
    ["read throws", () => { throw new Error("CI read unavailable"); }],
  ] as const) await t.test(name, async () => {
    const f = fixture(reader);
    await runSweep([pending()], f.deps);
    assert.equal(f.armed.length, 0);
    assert.equal(f.escalated.length, 1);
    const row = f.rows().findLast(row => row.step === "sweep.disposed");
    assert.equal(row?.blocker, "awaiting-ci");
    assert.match(String(row?.reason), /^stale-pending/);
  });
});

test("fresh pending avoids the completion reread and remains awaiting CI", async () => {
  let reads = 0;
  const f = fixture(() => { reads++; return facts(); });
  const pr = { ...pending(), checksPendingSince: new Date(NOW - 5 * 60_000).toISOString() };
  const result = await runSweep([pr], f.deps);
  assert.equal(reads, 0);
  assert.equal(result.actions[0].disposition, "wait");
  assert.equal(f.armed.length, 0);
  assert.equal(f.escalated.length, 0);
});

test("completed checks still respect a head that moves before the action", async () => {
  const f = fixture(() => facts());
  f.deps.readLiveHeadSha = () => "new-head";
  await runSweep([pending()], f.deps);
  assert.equal(f.armed.length, 0);
  assert.equal(f.escalated.length, 0);
  assert.equal(f.rows().some(row => row.step === "sweep.head_moved"), true);
});

test("production completion read requires the entire protected gate on the exact head", async () => {
  const f = fixture();
  const paths: string[] = [];
  let missing = true;
  const effects = buildSweepEffects({
    owner: "o", repo: "r", config: { root: dirname(f.deps.ledgerPath) } as Config,
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    ledgerPath: f.deps.ledgerPath, runId: "T6052-reader", log: () => {},
    readJsonImpl: async args => {
      const path = args[1];
      paths.push(path);
      if (path.endsWith("/pulls/6052")) return {
        number: 6052, state: "open", auto_merge: null, merged: false, draft: false,
        head: { sha: HEAD }, base: { sha: "base", ref: "main" }, mergeable: true, mergeable_state: "clean",
      };
      if (path.includes("/protection/")) return { contexts: ["ci", "coverage"] };
      if (path.includes("/check-runs?")) {
        const check_runs = [{ name: "ci", status: "completed", conclusion: "success", id: 1 },
          ...(missing ? [] : [{ name: "coverage", status: "completed", conclusion: "success", id: 2 }])];
        return { total_count: check_runs.length, check_runs };
      }
      if (path.endsWith("/status")) return { sha: HEAD, total_count: 1,
        statuses: [{ context: "remudero-review", state: "success" }] };
      throw new Error(`unexpected read: ${path}`);
    },
  });
  f.deps.readArmFacts = effects.readArmFacts;
  await runSweep([pending()], f.deps);
  assert.equal(f.armed.length, 0, "one successful check cannot hide an absent required check");
  assert.equal(f.escalated.length, 1);
  missing = false;
  await runSweep([pending()], f.deps);
  assert.equal(f.armed.length, 1, "completed protected gate clears even a previously escalated snapshot");
  assert.equal(f.escalated.length, 1);
  assert.ok(paths.some(path => path.includes(`/commits/${HEAD}/check-runs?`)));
});
