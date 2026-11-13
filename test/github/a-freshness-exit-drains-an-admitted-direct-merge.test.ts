import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { attemptArmAsync } from "#src/lib/arm-auto-merge.js";
import { runDaemon } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { restartDrainInventory, runSweep, DEFAULT_SWEEP_POLICY, type OpenPrView } from "#src/lib/sweep.js";

const PR = "https://github.com/fixture/repo/pull/11503";
const HEAD = "a".repeat(40);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function pump() { for (let i = 0; i < 40; i++) await flush(); }

async function fixture(t: TestContext, boundary: "preflight" | "write" = "write", refusal?: string) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-direct-merge-drain-"));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, "[]\n");
  const gate = deferred();
  const epoch = Date.now();
  let now = epoch, stale = false, writes = 0, reads = 0, finished = false, moved = false;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const deps: Parameters<typeof attemptArmAsync>[1] = {
    armAuto: () => { throw new Error("Pull request is in clean status"); },
    headSha: () => moved ? "b".repeat(40) : HEAD,
    readMergeFacts: async () => {
      reads++;
      if (boundary === "preflight") await gate.promise;
      return { mergeable: "MERGEABLE", behindBy: 0, mergeableState: "clean" };
    },
    updateBranch: () => ({ ok: true }),
    mergeDirect: async () => {
      writes++;
      if (boundary === "write") await gate.promise;
      if (refusal) throw new Error(refusal);
    },
    isMerged: () => false,
    say: () => {},
  };
  let merge: ReturnType<typeof attemptArmAsync> | undefined;
  const pr: OpenPrView = { prNumber: 11503, prUrl: PR, taskId: "W1-T11503", headSha: HEAD,
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    autoMergeArmed: false, lastActivityAt: new Date(now).toISOString() };
  const daemon = runDaemon(loadPlan(file), {
    now: () => new Date(now), refreshMerged: () => () => true,
    runOne: async id => ({ taskId: id, runId: "fixture", merged: true, costUsd: 0, verdict: "merged" }),
    sleep: async () => { await flush(); },
    checkFreshness: () => stale ? { stale: true, oldSha: HEAD, newSha: "b".repeat(40) } : { stale: false },
    log: (step, extra = {}) => rows.push({ step, extra }),
    sweep: async () => {
      await runSweep([pr], {
        arm: async () => { merge ??= attemptArmAsync(PR, deps, HEAD); return await merge; },
        close: () => {}, dispatchFix: () => {}, escalate: () => {},
        ledgerPath: join(dir, "ledger.ndjson"), runId: "SWEEP-fixture",
        readLedger: () => [], appendLine: () => {}, now: () => now,
        readLiveState: () => ({ ok: true, state: "OPEN", headSha: HEAD }),
      }, DEFAULT_SWEEP_POLICY);
    },
  }, { freshnessMinLifetimeMs: 0, sweepWallClockBoundMs: 100 });
  void daemon.then(() => { finished = true; });
  const tick = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await pump(); };
  t.after(async () => {
    gate.resolve(); stale = true; await pump();
    await tick(1000); await daemon; await merge;
    t.mock.restoreAll(); t.mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  });
  await pump();
  return { daemon, rows, deps, gate, tick, finished: () => finished, writes: () => writes,
    reads: () => reads, move: () => { moved = true; }, merge: () => merge!,
    latch: async () => { stale = true; await tick(100); },
    row: (step: string) => rows.find(row => row.step === step)?.extra };
}

test("W1-T11503 criterion 1: an abandoned sweep's direct merge owns its freshness drain until settlement", async t => {
  const h = await fixture(t);
  assert.equal(h.writes(), 1);
  await h.latch();
  assert.ok(h.row("daemon.sweep.abandoned"));
  assert.equal(h.finished(), false);
  const item = restartDrainInventory().find(item => item.kind === "direct-merge");
  assert.equal(item?.pr, 11503);
  assert.equal(item?.head_sha, HEAD);
  assert.equal(item?.phase, "write-submitted");
  h.gate.resolve(); await pump();
  assert.equal((await h.daemon).stopReason, "stale");
  const completed = h.row("daemon.freshness_drain.completed")!;
  assert.equal(completed.unresolved_direct_merges, 0);
  assert.ok((completed.waited_on as Array<Record<string, unknown>>).some(item =>
    item.kind === "direct-merge" && item.outcome === "direct-merged" && typeof item.settled_after_ms === "number"));
  assert.equal(restartDrainInventory().length, 0);
});

test("W1-T11503 criterion 2: the latch cancels preflight and closes new merge admission", async t => {
  const h = await fixture(t, "preflight");
  assert.equal(h.reads(), 1);
  await h.latch();
  const late = await attemptArmAsync(PR.replace("11503", "11504"), h.deps, HEAD);
  assert.equal(late.outcome, "direct-merge-preflight-refused");
  h.gate.resolve(); await pump();
  assert.equal((await h.merge()).outcome, "direct-merge-failed");
  await h.daemon;
  assert.equal(h.writes(), 0);
  assert.match(String(h.row("daemon.direct_merge.settled")?.reason), /restart/);
  assert.equal(restartDrainInventory().length, 0);
});

test("W1-T11503 criterion 2: a submitted write at the bound stays unknown and cannot be submitted twice", async t => {
  const h = await fixture(t);
  await h.latch(); await h.tick(100);
  assert.equal((await h.daemon).stopReason, "stale");
  assert.equal(h.row("daemon.freshness_drain.completed")?.unresolved_direct_merges, 1);
  assert.equal(restartDrainInventory().find(item => item.kind === "direct-merge")?.phase, "write-unknown");
  const duplicate = await attemptArmAsync(PR, h.deps, HEAD);
  assert.equal(duplicate.outcome, "direct-merge-preflight-refused");
  assert.equal(h.writes(), 1);
  h.gate.resolve(); await h.merge(); await pump();
  assert.equal(restartDrainInventory().length, 0);
});

test("W1-T11503 criterion 2: changed heads and write refusals settle with reasons", async t => {
  for (const boundary of ["preflight", "write"] as const) {
    await t.test(boundary, async t => {
      const h = await fixture(t, boundary, boundary === "write" ? "HTTP 403: merge refused" : undefined);
      if (boundary === "preflight") h.move();
      h.gate.resolve(); await h.merge(); await pump();
      const result = await h.merge();
      assert.equal(result.outcome, "direct-merge-failed");
      assert.match(result.error!, boundary === "write" ? /403/ : /head moved/);
      assert.equal(h.writes(), boundary === "write" ? 1 : 0);
      assert.equal(restartDrainInventory().length, 0);
    });
  }
});

test("W1-T11503 criterion 2: a failed settlement lookup is reconciled before another write", async () => {
  const pr = PR.replace("11503", "11505");
  let writes = 0, readable = false;
  const deps: Parameters<typeof attemptArmAsync>[1] = {
    armAuto: () => { throw new Error("Pull request is in clean status"); },
    mergeDirect: () => { writes++; if (!readable) throw new Error("connection lost after submission"); },
    isMerged: () => { if (!readable) throw new Error("REST lookup failed"); return false; },
    say: () => {},
  };
  await assert.rejects(attemptArmAsync(pr, deps), /REST lookup failed/);
  await assert.rejects(attemptArmAsync(pr, deps), /REST lookup failed/);
  assert.equal(writes, 1, "an unreadable reconciliation never resubmits the write");
  readable = true;
  assert.equal((await attemptArmAsync(pr, deps)).outcome, "direct-merged");
  assert.equal(writes, 2, "a new write follows the successful PR-state lookup");
  assert.equal(restartDrainInventory().length, 0);
});

test("W1-T11503 criterion 2: preflight errors settle without a write", async () => {
  let writes = 0;
  const result = await attemptArmAsync(PR, {
    armAuto: () => { throw new Error("Pull request is in clean status"); },
    mergeDirect: () => { writes++; },
    readMergeFacts: () => { throw new Error("preflight REST denied"); },
    updateBranch: () => ({ ok: true }), say: () => {},
  });
  assert.equal(result.outcome, "direct-merge-preflight-refused");
  assert.equal(result.directMergePreflight?.error, "preflight REST denied");
  assert.equal(writes, 0);
  assert.equal(restartDrainInventory().length, 0);
});
