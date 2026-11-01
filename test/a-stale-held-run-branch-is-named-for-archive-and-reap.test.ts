// test/a-stale-held-run-branch-is-named-for-archive-and-reap.test.ts
//
// LIVE 2026-11-01: craigoley/remudero carried 506 branches. planBranchReap held 311 no-PR run branches of tasks
// already shipped by a sibling attempt as `named_task_credited` and 99 of unshipped tasks as `named_task_open`,
// pending an adjudication nothing performs, so they never left. The repo-hygiene shadow names the stale ones.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDispatchClaimTaskIds, planStaleHoldArchive, STALE_CREDITED_HOLD_MS, STALE_UNSHIPPED_HOLD_MS,
  type RemoteBranchTip, type StaleHoldFacts,
} from "#src/lib/branch-reaper.js";

const NOW = Date.parse("2026-11-01T13:00:00Z");
const DAY = 86_400_000;
const held = (name: string, taskId: string, over: Partial<StaleHoldFacts> = {}): StaleHoldFacts =>
  ({ name, prState: "none", tipInMain: false, namedInSource: false, namedTaskId: taskId, ...over });
const tip = (ageDays: number | undefined): RemoteBranchTip =>
  ({ sha: `sha-${ageDays}`, committedAtMs: ageDays === undefined ? undefined : NOW - ageDays * DAY });

test("a held run branch is named only once it is stale for its kind, with every fact read", () => {
  const facts = [
    held("run-W1-T1-1", "W1-T1"), held("run-W1-T2-2", "W1-T2"), held("run-W1-T3-3", "W1-T3"),
    held("run-W1-T4-4", "W1-T4"), held("run-W1-T5-5", "W1-T5"), held("run-W1-T6-6", "W1-T6", { tipInMain: "unknown" }),
    held("run-W1-T7-7", "W1-T7", { prState: "unknown" }), held("run-W1-T8-8", "W1-T8"), held("probe-W1-T9", "W1-T9"),
    held("run-W1-T10-10", "W1-T10", { namedInSource: true }),
  ];
  const reasons: Record<string, string> = {
    "run-W1-T1-1": "named_task_credited", "run-W1-T2-2": "named_task_credited", "run-W1-T3-3": "named_task_open",
    "run-W1-T4-4": "named_task_open", "run-W1-T5-5": "named_task_credited", "run-W1-T6-6": "named_task_credited",
    "run-W1-T7-7": "named_task_credited", "run-W1-T8-8": "no_pr_ever", "probe-W1-T9": "named_task_credited",
    "run-W1-T10-10": "named_task_credited",
  };
  const tips = new Map<string, RemoteBranchTip>([
    ["run-W1-T1-1", tip(8)], ["run-W1-T2-2", tip(6)], ["run-W1-T3-3", tip(15)], ["run-W1-T4-4", tip(10)],
    ["run-W1-T5-5", tip(undefined)], ["run-W1-T6-6", tip(30)], ["run-W1-T7-7", tip(30)], ["run-W1-T8-8", tip(30)],
    ["probe-W1-T9", tip(30)], ["run-W1-T10-10", tip(30)],
  ]);
  const named = planStaleHoldArchive({ facts, reasons, tips, nowMs: NOW, claimedTaskIds: new Set() });
  assert.deepEqual(named.map((c) => [c.name, c.reason]), [
    ["run-W1-T1-1", "credited_sibling_stale"],
    ["run-W1-T3-3", "orphan_unshipped_stale"],
  ]);
  assert.equal(named[0]!.sha, "sha-8");
  assert.ok(STALE_CREDITED_HOLD_MS === 7 * DAY && STALE_UNSHIPPED_HOLD_MS === 14 * DAY);
  // A live dispatch claim keeps its task's branch, and an unread claim list names nothing.
  assert.deepEqual(planStaleHoldArchive({ facts, reasons, tips, nowMs: NOW, claimedTaskIds: new Set(["W1-T1"]) })
    .map((c) => c.name), ["run-W1-T3-3"]);
  assert.deepEqual(planStaleHoldArchive({ facts, reasons, tips, nowMs: NOW, claimedTaskIds: undefined }), []);
});

test("a run branch the slug matcher never names is read from its run shape, credited or not", () => {
  const facts = [held("run-W1-T20-1", "W1-T20", { namedTaskId: undefined }), held("run-W1-T21-2", "W1-T21", { namedTaskId: undefined }),
    held("run-W1-T22-3", "W1-T22", { namedTaskId: undefined })];
  const reasons = { "run-W1-T20-1": "no_pr_ever", "run-W1-T21-2": "no_pr_ever", "run-W1-T22-3": "no_pr_ever" };
  const tips = new Map<string, RemoteBranchTip>([["run-W1-T20-1", tip(8)], ["run-W1-T21-2", tip(8)], ["run-W1-T22-3", tip(15)]]);
  const runTaskByBranch = new Map([["run-W1-T20-1", "W1-T20"], ["run-W1-T21-2", "W1-T21"], ["run-W1-T22-3", "W1-T22"]]);
  const input = { facts, reasons, tips, nowMs: NOW, claimedTaskIds: new Set<string>(), runTaskByBranch };
  assert.deepEqual(planStaleHoldArchive({ ...input, creditedTaskIds: new Set(["W1-T20"]) }).map((c) => [c.name, c.reason]), [
    ["run-W1-T20-1", "credited_sibling_stale"],
    ["run-W1-T22-3", "orphan_unshipped_stale"],
  ]);
  assert.deepEqual(planStaleHoldArchive(input), [], "an unread merge credit names no no_pr_ever branch");
});

test("the dispatch-claim listing yields the claimed task ids", () => {
  assert.deepEqual([...parseDispatchClaimTaskIds("abc\trefs/rmd-dispatch/W1-T42\nfff\trefs/rmd-dispatch/W1-T7\n\n")],
    ["W1-T42", "W1-T7"]);
  assert.deepEqual([...parseDispatchClaimTaskIds("")], []);
});

test("a reap pass ledgers the stale held run branch in shadow and deletes nothing", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { reapBranchesCommand } = await import("#src/run-task.js");
  const { RMD_TMP_PREFIX } = await import("#src/lib/tmp.js");
  const pass = (claims: string) => {
    const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reap-hygiene-`));
    const ledgerPath = join(dir, "ledger.ndjson");
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]): string => {
      calls.push([cmd, ...args]);
      if (args[0] === "ls-remote") return args.includes("refs/rmd-dispatch/*") ? claims : "a1\trefs/heads/main\nb2\trefs/heads/run-W1-T5-1700000000000\n";
      if (args[0] === "for-each-ref") return args.includes("--merged=origin/main") ? "origin/main\n" : `origin/main\ta1\t1\norigin/run-W1-T5-1700000000000\tb2b2b2\t${Math.floor((NOW - 30 * DAY) / 1000)}\n`;
      if (args[0] === "merge-base") throw new Error("not an ancestor");
      if (args[0] === "rev-parse") return "b2b2b2\n";
      if (args[0] === "grep") throw Object.assign(new Error("exit 1"), { status: 1 });
      if (cmd === "gh") return "";
      return "";
    };
    const realLog = console.log;
    console.log = () => {};
    try {
      reapBranchesCommand([], { exec, ledgerPath, clock: { now: () => NOW }, loadPlan: () => ({ tasks: [{ id: "W1-T5" }] }) as never });
    } finally { console.log = realLog; }
    const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    rmSync(dir, { recursive: true, force: true });
    return { row: rows.find((r) => r.step === "branch_reap.hygiene_shadow"), calls };
  };
  const { row, calls } = pass("");
  assert.equal(row?.mode, "shadow");
  assert.equal(row.claims_read, true);
  assert.equal(row.would_reap, 1);
  assert.equal(row.orphan_unshipped_stale, 1);
  assert.deepEqual(row.candidates, [{ name: "run-W1-T5-1700000000000", sha: "b2b2b2", reason: "orphan_unshipped_stale", age_days: 30 }]);
  assert.ok(!calls.some((c) => c.includes("--delete") || c.includes("update-ref")), "shadow deletes and archives nothing");
  assert.equal(pass("ff\trefs/rmd-dispatch/W1-T5\n").row?.would_reap, 0, "a live dispatch claim keeps the branch");
});
