// test/a-stale-held-run-branch-is-named-for-archive-and-reap.test.ts
//
// LIVE 2026-11-01: craigoley/remudero carried 506 branches. planBranchReap held 311 no-PR run branches of tasks
// already shipped by a sibling attempt as `named_task_credited` and 99 of unshipped tasks as `named_task_open`,
// pending an adjudication nothing performs, so they never left. The repo-hygiene shadow names the stale ones.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveStaleHoldsSteps, parseDispatchClaimTaskIds, planStaleHoldArchive, STALE_CREDITED_HOLD_MS, STALE_HOLD_ARCHIVE_CAP,
  STALE_UNSHIPPED_HOLD_MS, staleHoldRestoreCommand, type RemoteBranchTip, type StaleHoldCandidate, type StaleHoldFacts,
} from "#src/lib/branch-reaper.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStepsSync } from "#src/lib/git-push.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { loadPolicy } from "#src/lib/policy.js";
import { reapBranchesCommand } from "#src/run-task.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-11-01T13:00:00Z");
const DAY = 86_400_000;
const held = (name: string, taskId: string, over: Partial<StaleHoldFacts> = {}): StaleHoldFacts =>
  ({ name, prState: "none", tipInMain: false, namedInSource: false, namedTaskId: taskId, ...over });
const tip = (ageDays: number | undefined): RemoteBranchTip =>
  ({ sha: `sha-${ageDays}`, committedAtMs: ageDays === undefined ? undefined : NOW - ageDays * DAY });
/** The live `ls-remote` sha for every tip: what a fresh remote-tracking read agrees with. */
const liveOf = (tips: ReadonlyMap<string, RemoteBranchTip>) => new Map([...tips].map(([n, t]) => [n, t.sha]));

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
  const named = planStaleHoldArchive({ facts, reasons, tips, liveShaByName: liveOf(tips), nowMs: NOW, claimedTaskIds: new Set() });
  assert.deepEqual(named.map((c) => [c.name, c.reason]), [
    ["run-W1-T1-1", "credited_sibling_stale"],
    ["run-W1-T3-3", "orphan_unshipped_stale"],
  ]);
  assert.equal(named[0]!.sha, "sha-8");
  assert.ok(STALE_CREDITED_HOLD_MS === 7 * DAY && STALE_UNSHIPPED_HOLD_MS === 14 * DAY);
  // A live dispatch claim keeps its task's branch, and an unread claim list names nothing.
  assert.deepEqual(planStaleHoldArchive({ facts, reasons, tips, liveShaByName: liveOf(tips), nowMs: NOW, claimedTaskIds: new Set(["W1-T1"]) })
    .map((c) => c.name), ["run-W1-T3-3"]);
  assert.deepEqual(planStaleHoldArchive({ facts, reasons, tips, liveShaByName: liveOf(tips), nowMs: NOW, claimedTaskIds: undefined }), []);
});

test("a run branch the slug matcher never names is read from its run shape, credited or not", () => {
  const facts = [held("run-W1-T20-1", "W1-T20", { namedTaskId: undefined }), held("run-W1-T21-2", "W1-T21", { namedTaskId: undefined }),
    held("run-W1-T22-3", "W1-T22", { namedTaskId: undefined })];
  const reasons = { "run-W1-T20-1": "no_pr_ever", "run-W1-T21-2": "no_pr_ever", "run-W1-T22-3": "no_pr_ever" };
  const tips = new Map<string, RemoteBranchTip>([["run-W1-T20-1", tip(8)], ["run-W1-T21-2", tip(8)], ["run-W1-T22-3", tip(15)]]);
  const runTaskByBranch = new Map([["run-W1-T20-1", "W1-T20"], ["run-W1-T21-2", "W1-T21"], ["run-W1-T22-3", "W1-T22"]]);
  const input = { facts, reasons, tips, liveShaByName: liveOf(tips), nowMs: NOW, claimedTaskIds: new Set<string>(), runTaskByBranch };
  assert.deepEqual(planStaleHoldArchive({ ...input, creditedTaskIds: new Set(["W1-T20"]) }).map((c) => [c.name, c.reason]), [
    ["run-W1-T20-1", "credited_sibling_stale"],
    ["run-W1-T22-3", "orphan_unshipped_stale"],
  ]);
  assert.deepEqual(planStaleHoldArchive(input), [], "an unread merge credit names no no_pr_ever branch");
});

test("a stale remote-tracking tip names nothing: the live remote sha must match the tip it ages", () => {
  const facts = [held("run-W1-T30-1", "W1-T30"), held("run-W1-T31-2", "W1-T31")];
  const reasons = { "run-W1-T30-1": "named_task_open", "run-W1-T31-2": "named_task_open" };
  const tips = new Map<string, RemoteBranchTip>([["run-W1-T30-1", tip(30)], ["run-W1-T31-2", tip(30)]]);
  // The remote moved run-W1-T30-1 past the local tip, and run-W1-T31-2 is gone from the live listing.
  const liveShaByName = new Map([["run-W1-T30-1", "pushed-since"]]);
  assert.deepEqual(planStaleHoldArchive({ facts, reasons, tips, liveShaByName, nowMs: NOW, claimedTaskIds: new Set() }), []);
  assert.deepEqual(planStaleHoldArchive({ facts, reasons, tips, liveShaByName: liveOf(tips), nowMs: NOW, claimedTaskIds: new Set() })
    .map((c) => c.name), ["run-W1-T30-1", "run-W1-T31-2"], "the same branches are named once the live sha agrees");
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
  const pass = (claims: string, liveSha = "b2b2b2") => {
    const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reap-hygiene-`));
    const ledgerPath = join(dir, "ledger.ndjson");
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]): string => {
      calls.push([cmd, ...args]);
      if (args[0] === "ls-remote") return args.includes("refs/rmd-dispatch/*") ? claims : `a1\trefs/heads/main\n${liveSha}\trefs/heads/run-W1-T5-1700000000000\n`;
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
  assert.equal(pass("", "c3c3c3").row?.would_reap, 0, "a live remote sha past the local tracking tip names nothing");
});

test("an unreadable dispatch-claim listing names nothing and ledgers why", async () => {
  const { runStepsSync } = await import("#src/lib/git-push.js");
  const { readDispatchClaimTaskIdsSteps } = await import("#src/lib/branch-reaper.js");
  const read = runStepsSync(readDispatchClaimTaskIdsSteps(() => { throw new Error("origin unreachable"); }));
  assert.deepEqual(read, { error: "origin unreachable" });
});

// Act mode (operator ruling 2026-11-01, "Build act mode, flag off"), folded in from its own suite so this
// branch adds no new importer of src/run-task.ts (the affected-suite reach ratchet is at its ceiling):
// Operator ruling 2026-11-01: "Build act mode, flag off". The repo-hygiene shadow names stale held run
// branches; act mode, armed only by `sweep.armStaleBranchArchive`, archives each tip under
// refs/rmd-recovery/reaped/<name>/<sha> and deletes the branch in ONE atomic push leased on that sha, so
// both happen or neither does, and nothing happens if the branch moved.
const BRANCH = "run-W1-T5-1700000000000";
const SHA = "b2b2b2";
const ATOMIC_PUSH = ["git", "push", "--atomic", `--force-with-lease=refs/heads/${BRANCH}:${SHA}`, "origin",
  `${SHA}:refs/rmd-recovery/reaped/${BRANCH}/${SHA}`, `:refs/heads/${BRANCH}`];

/** One reap pass over a corpus holding one stale unshipped run branch (30 days, no PR, tip not in main). */
function pass(rest: string[], opts: { armed?: boolean; root?: string; pushFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reap-act-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (args[0] === "ls-remote") return args.includes("refs/rmd-dispatch/*") ? "" : `a1\trefs/heads/main\n${SHA}\trefs/heads/${BRANCH}\n`;
    if (args[0] === "for-each-ref") return args.includes("--merged=origin/main") ? "origin/main\n" : `origin/main\ta1\t1\norigin/${BRANCH}\t${SHA}\t${Math.floor((NOW - 30 * DAY) / 1000)}\n`;
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    if (args[0] === "rev-parse") return `${SHA}\n`;
    if (args[0] === "grep") throw Object.assign(new Error("exit 1"), { status: 1 });
    if (args[0] === "push" && opts.pushFails) throw new Error("! [rejected] (stale info)");
    return "";
  };
  const out: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  try {
    reapBranchesCommand(rest, { exec, ledgerPath, clock: { now: () => NOW }, loadPlan: () => ({ tasks: [{ id: "W1-T5" }] }) as never,
      ...(opts.root ? { root: opts.root } : {}), ...(opts.armed !== undefined ? { armStaleBranchArchive: opts.armed } : {}) });
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  rmSync(dir, { recursive: true, force: true });
  return {
    archived: rows.find((r) => r.step === "branch_reap.hygiene_archived"),
    shadow: rows.find((r) => r.step === "branch_reap.hygiene_shadow"),
    pushes: calls.filter((c) => c[1] === "push"),
    out,
  };
}

test("armed, a stale held branch is archived and deleted in ONE atomic push leased on its sha", () => {
  const { archived, shadow, pushes, out } = pass(["--archive-stale"], { armed: true });
  assert.deepEqual(pushes, [ATOMIC_PUSH]);
  assert.equal(archived?.mode, "act");
  assert.deepEqual(archived.archived, [{ name: BRANCH, sha: SHA, reason: "orphan_unshipped_stale",
    archive_ref: `refs/rmd-recovery/reaped/${BRANCH}/${SHA}` }]);
  assert.deepEqual(archived.failed, []);
  assert.equal(archived.capped, 0);
  assert.equal(archived.restore, "git fetch origin refs/rmd-recovery/reaped/<name>/<sha>:refs/rmd-recovery/reaped/<name>/<sha> && git push origin refs/rmd-recovery/reaped/<name>/<sha>:refs/heads/<name>");
  assert.equal(shadow, undefined, "act mode replaces the shadow row");
  const ref = `refs/rmd-recovery/reaped/${BRANCH}/${SHA}`;
  assert.ok(out.includes(`  restore: git fetch origin ${ref}:${ref} && git push origin ${ref}:refs/heads/${BRANCH}`));
});

test("unarmed, the stale held branch is only ledgered in shadow and nothing is pushed", () => {
  for (const run of [pass(["--archive-stale"], { armed: false }), pass([], { armed: true })]) {
    assert.deepEqual(run.pushes, []);
    assert.equal(run.archived, undefined);
    assert.equal(run.shadow?.mode, "shadow");
    assert.equal(run.shadow.would_reap, 1);
  }
});

test("a failed archive push is ledgered as failed and its branch is kept", () => {
  const { archived, pushes } = pass(["--archive-stale"], { armed: true, pushFails: true });
  assert.deepEqual(pushes, [ATOMIC_PUSH]);
  assert.deepEqual(archived.archived, []);
  assert.equal(archived.failed.length, 1);
  assert.equal(archived.failed[0].name, BRANCH);
  assert.match(archived.failed[0].error, /rejected/);
});

test("the stale-hold archive cap holds: 25 pushes per pass and the rest counted as capped", () => {
  assert.equal(STALE_HOLD_ARCHIVE_CAP, 25);
  const candidates: StaleHoldCandidate[] = Array.from({ length: 30 }, (_, i) =>
    ({ name: `run-W1-T${i}-1`, sha: `s${i}`, reason: "credited_sibling_stale", ageMs: 8 * DAY, taskId: `W1-T${i}` }));
  const pushes: string[][] = [];
  const outcome = runStepsSync(archiveStaleHoldsSteps(candidates, (_cmd, args) => { pushes.push(args); return ""; }));
  assert.equal(pushes.length, 25);
  assert.equal(outcome.archived.length, 25);
  assert.equal(outcome.capped, 5);
  assert.deepEqual(outcome.archived.map((a) => a.name), candidates.slice(0, 25).map((c) => c.name));
});

test("the policy default for sweep.armStaleBranchArchive is false, read from the checkout's policy", () => {
  const policy = loadPolicy(join(REPO_ROOT, "plan", "policy.yaml"));
  assert.equal(policy.values.sweep.armStaleBranchArchive, false);
  assert.equal(policy.origin["sweep.armStaleBranchArchive"]?.kind, "net-new");
  // The REAL default seam: no override, so the arm is read from <root>/plan/policy.yaml.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reap-act-policy-`));
  try {
    mkdirSync(join(root, "plan"));
    const yaml = readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8");
    writeFileSync(join(root, "plan", "policy.yaml"), yaml);
    assert.deepEqual(pass(["--archive-stale"], { root }).pushes, [], "the committed row (false) leaves it in shadow");
    const armedYaml = yaml.replace(/(armStaleBranchArchive:\n\s+value: )false/, "$1true");
    assert.notEqual(armedYaml, yaml);
    writeFileSync(join(root, "plan", "policy.yaml"), armedYaml);
    assert.deepEqual(pass(["--archive-stale"], { root }).pushes, [ATOMIC_PUSH], "flipping the row arms it");
    rmSync(join(root, "plan", "policy.yaml"));
    const unreadable = pass(["--archive-stale"], { root });
    assert.deepEqual(unreadable.pushes, [], "an unreadable policy fails closed to shadow");
    assert.ok(unreadable.out.some((l) => l.includes("plan/policy.yaml could not be read")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("against a real remote, the leased atomic push archives and deletes together, refuses a moved branch, and restores", () => {
  const origin = gitRepo({ bare: true, kind: "reap-act-origin" });
  const work = gitRepo({ kind: "reap-act-work" });
  try {
    work.addRemote("origin", origin.dir);
    work.git("push", "-q", "origin", "HEAD:refs/heads/main");
    for (const b of ["run-W1-T1-1", "run-W1-T2-2"]) {
      work.git("commit", "-q", "--allow-empty", "-m", b);
      work.git("push", "-q", "origin", `HEAD:refs/heads/${b}`);
    }
    const sha1 = origin.git("rev-parse", "refs/heads/run-W1-T1-1");
    const staleSha2 = origin.git("rev-parse", "refs/heads/run-W1-T2-2");
    // run-W1-T2-2 gains a commit after the planner read it: the lease must refuse it.
    work.git("commit", "-q", "--allow-empty", "-m", "new work");
    work.git("push", "-q", "origin", "HEAD:refs/heads/run-W1-T2-2");
    const movedSha2 = origin.git("rev-parse", "refs/heads/run-W1-T2-2");
    work.git("fetch", "-q", "origin");
    const exec = (cmd: string, args: string[]) => {
      assert.equal(cmd, "git");
      return work.git(...args);
    };
    const c = (name: string, sha: string): StaleHoldCandidate => ({ name, sha, reason: "credited_sibling_stale", ageMs: 8 * DAY, taskId: "W1-T1" });
    const outcome = runStepsSync(archiveStaleHoldsSteps([c("run-W1-T1-1", sha1), c("run-W1-T2-2", staleSha2)], exec));
    assert.deepEqual(outcome.archived.map((a) => a.name), ["run-W1-T1-1"]);
    assert.deepEqual(outcome.failed.map((f) => f.name), ["run-W1-T2-2"]);
    const refs = origin.git("for-each-ref", "--format=%(refname) %(objectname)");
    assert.ok(!refs.includes("refs/heads/run-W1-T1-1 "), "the archived branch is deleted");
    assert.ok(refs.includes(`refs/rmd-recovery/reaped/run-W1-T1-1/${sha1} ${sha1}`), "its tip is archived");
    assert.ok(refs.includes(`refs/heads/run-W1-T2-2 ${movedSha2}`), "the moved branch is untouched");
    assert.ok(!refs.includes("refs/rmd-recovery/reaped/run-W1-T2-2/"), "and nothing of it is archived");
    // The documented restore line, run as written from the reaping clone (which never had the archive ref).
    const restore = staleHoldRestoreCommand("run-W1-T1-1", sha1).split(" && ").map((cmd) => cmd.split(" "));
    assert.deepEqual(restore.map((argv) => argv.slice(0, 2)), [["git", "fetch"], ["git", "push"]]);
    for (const argv of restore) work.git(...argv.slice(1));
    assert.equal(origin.git("rev-parse", "refs/heads/run-W1-T1-1"), sha1);
  } finally {
    work.cleanup();
    origin.cleanup();
  }
});
