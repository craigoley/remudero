import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { appendOperatorNote, loadOperatorNotesForTask } from "../src/lib/operator-notes.js";
import type { Plan } from "../src/lib/plan.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "./helpers/sweep-test.js";
import { ghShim } from "./helpers/gh-shim.js";
import { capStrikeLadderNote, decideStrikeLadderRung, hasUnspentLadderRefresh, latestStrikeLadderAttempt, strikeCauseKey } from "../src/lib/strike-ladder.js";

const NOW = Date.now();
const stamp = (offset = 0) => new Date(NOW + offset).toISOString();
const MAIN = { sha: "main-tip", committedAt: stamp(-1000) };

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 5536, prUrl: "https://github.com/acme/remudero/pull/5536", taskId: "W1-T5536",
    headSha: "old-head", headRefName: "run-W1-T5536-1", currentMergeBaseSha: MAIN.sha,
    checksState: "red", reviewState: "success", unmetCriteria: [],
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap, lastActivityAt: stamp(), autoMergeArmed: false,
    ciFailures: [{ name: "ci (3/8)", logTail: "not ok 7 - a broken invariant\n at test/ladder.test.ts:12:1" }],
    strikeHistory: [{ strike: 1, round: "fresh", unmetCount: 1, ciGreen: false }],
    ...over,
  };
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-strike-ladder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows: Record<string, unknown>[] = [
    { step: "fix.dispatch", task_id: "W1-T5536", head_sha: "old-head", ts: stamp(-2000), strike: 1 },
    { step: "fix.commit_refused", task_id: "W1-T5536", head_sha: "old-head", reason: "the worker changed nothing", strike: 1 },
  ];
  const calls: string[] = [];
  const open: OpenIssue[] = [];
  const commands: string[][] = [];
  let author: string | undefined = "remudero-fleet[bot]";
  let failList = false;
  let closeTakes = true;
  const closed = new Set<number>();
  const issues: IssueGateway = {
    ensureLabel: () => true,
    listOpen: () => { if (failList) throw new Error("issue list outage"); return open; },
    create: (title, body, labels) => {
      calls.push("create");
      assert.deepEqual(labels, ["needs-human", "strike-ladder-digest"]);
      const url = `https://github.com/acme/remudero/issues/${open.length + 1}`;
      open.push({ number: open.length + 1, url, title, body });
      return url;
    },
    comment: (_url, body) => { calls.push("comment"); commands.push(["comment", body]); },
  };
  const effects = buildSweepEffects({
    owner: "acme", repo: "remudero", repoRoot: root,
    config: { root, claudeBin: "/bin/true" } as Config,
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    ledgerPath: join(root, "ledger.ndjson"), runId: "ladder-test",
    log: (step, extra) => { rows.push({ step, ...extra }); },
    issuesImpl: issues, ghRunImpl: (_file, args) => { commands.push([...args]); },
    readJsonImpl: async () => ({ user: { login: author } }), nowMsImpl: () => NOW,
  });
  const deps: SweepDeps = {
    strikeLadder: effects.strikeLadder,
    arm: () => { calls.push("arm"); },
    close: (candidate, reason) => { calls.push(`close:${reason}`); if (closeTakes) closed.add(candidate.prNumber); },
    updateBranch: () => { calls.push("refresh"); return "updated"; },
    dispatchFix: () => { calls.push("fix"); }, escalate: () => { calls.push("escalate"); },
    readLiveState: (candidate) => {
      calls.push("live");
      return { ok: true, state: closed.has(candidate.prNumber) ? "CLOSED" : "OPEN", headSha: candidate.headSha };
    },
    readMainRepair: () => MAIN, readMainTip: () => MAIN.sha,
    ledgerPath: join(root, "ledger.ndjson"), runId: "ladder-test",
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: stamp(), ...row }); }, now: () => NOW,
  };
  const spend = (n: number, taskId = "W1-T5536") => {
    for (let i = 0; i < n; i++) assert.equal(appendOperatorNote(root, { taskId, author: "strike-ladder", ts: stamp(), note: `prior rebuild ${i}` }), true);
  };
  return { root, rows, calls, open, commands, deps, spend, effects, issues,
    author: (value: string | undefined) => { author = value; },
    failList: () => { failList = true; }, closeTakes: (value: boolean) => { closeTakes = value; },
    sweep: (prs: OpenPrView[] = [pr()]) => runSweep(prs, deps),
  };
}

test("W1-T5536: a moved base refreshes an exhausted branch once without a strike", async (t) => {
  const f = fixture(t);
  f.spend(2);
  const stale = pr({ currentMergeBaseSha: "old-main" });
  await f.sweep([stale]);
  assert.equal(f.calls.filter(c => c === "refresh").length, 1);
  assert.equal(f.calls.includes("fix"), false);
  assert.equal(f.calls.includes("escalate"), false);
  assert.equal(f.rows.findLast(r => r.step === "sweep.disposed")?.question, undefined);
  assert.ok(f.rows.some(r => r.step === "sweep.strike_ladder.refreshed" && r.old_head === stale.headSha && r.main_sha === MAIN.sha));
  await f.sweep([stale]);
  assert.equal(f.calls.filter(c => c === "refresh").length, 1);
  assert.equal(f.open.length, 1);
  f.deps.readMainRepair = () => ({ sha: "later-main", committedAt: stamp(1000) });
  await f.sweep([stale]);
  assert.equal(f.calls.filter(c => c === "refresh").length, 2, "a digest cannot suppress a later main repair");
});

test("W1-T5536: a ladder-refreshed head that goes red climbs, never earning fresh strikes", async (t) => {
  const f = fixture(t);
  await f.sweep([pr({ currentMergeBaseSha: "old-main" })]);
  await f.sweep([pr({ headSha: "refreshed-head", priorStrikes: 0 })]);
  assert.equal(f.calls.includes("fix"), false);
  assert.ok(f.calls.some(c => c.startsWith("close:")));
  const green = fixture(t);
  await green.sweep([pr({ currentMergeBaseSha: "old-main" })]);
  await green.sweep([pr({ headSha: "green-head", priorStrikes: 0, checksState: "green", ciFailures: [] })]);
  assert.ok(green.calls.includes("arm"));
  assert.equal(green.calls.some(c => c.startsWith("close:")), false);
});

test("W1-T5536: an unmoved base closes the PR and requeues its task with a failure digest", async (t) => {
  const f = fixture(t);
  await f.sweep();
  assert.deepEqual(f.calls.slice(0, 3).map(c => c.split(":")[0]), ["live", "close", "live"]);
  const notes = loadOperatorNotesForTask(f.root, "W1-T5536");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].author, "strike-ladder");
  for (const text of ["5536", "old-head", "check:ci#a broken invariant", "ci (3/8)", "strike", "the worker changed nothing"]) assert.ok(notes[0].note.includes(text), text);
  assert.deepEqual(loadOperatorNotesForTask(f.root, "W1-T9999"), []);
  assert.ok(f.rows.some(r => r.step === "sweep.strike_ladder.requeued" && r.rebuild === 1));
  const second = pr({ prNumber: 5537, prUrl: "https://github.com/acme/remudero/pull/5537", headSha: "second-build" });
  // W1-T5690: one rebuild per task per UTC day — the same day's second build gets the digest.
  await f.sweep([second]);
  assert.equal(loadOperatorNotesForTask(f.root, "W1-T5536").length, 1);
  f.deps.now = () => NOW + 24 * 60 * 60_000;
  await f.sweep([second]);
  assert.equal(loadOperatorNotesForTask(f.root, "W1-T5536").length, 2);
  assert.ok(f.rows.some(r => r.step === "sweep.strike_ladder.requeued" && r.rebuild === 2));
  const refused = fixture(t);
  refused.closeTakes(false);
  await refused.sweep();
  assert.deepEqual(loadOperatorNotesForTask(refused.root, "W1-T5536"), []);
  assert.equal(refused.rows.some(r => r.step === "sweep.strike_ladder.requeued"), false);
  refused.closeTakes(true);
  await refused.sweep();
  assert.equal(loadOperatorNotesForTask(refused.root, "W1-T5536").length, 1);
});

test("W1-T5536: a spent rebuild budget or an unrequeueable PR opens one assigned digest per cause", async (t) => {
  for (const over of [{}, { taskId: undefined }, { headRefName: "feature/foreign" }, { headRefName: "run-unfiled-1" }]) {
    const f = fixture(t);
    f.spend(2);
    const first = await f.sweep([pr(over)]);
    assert.equal(f.open.length, 1, JSON.stringify({ over, calls: f.calls, actions: first.actions,
      rows: f.rows.filter(row => String(row.step).includes("strike_ladder") || row.step === "sweep.disposed") }));
    assert.equal(f.calls.some(c => c.startsWith("close:")), false);
    assert.ok(f.commands.some(args => args.includes("--add-assignee") && args.includes("acme")));
    await f.sweep([pr(over)]);
    assert.equal(f.open.length, 1);
    assert.equal(f.calls.includes("comment"), false, "the first PR is already in the issue body");
  }
  const hand = fixture(t);
  hand.author("operator");
  await hand.sweep();
  assert.equal(hand.open.length, 1);
  assert.equal(hand.calls.some(c => c.startsWith("close:")), false);
  const rotated = fixture(t);
  rotated.spend(2);
  assert.equal(rotated.rows.some(r => r.step === "sweep.strike_ladder.requeued"), false);
  await rotated.sweep();
  assert.equal(rotated.open.length, 1, "operator notes survive ledger rotation");
});

test("W1-T5536: a second PR with the same cause key joins the open digest", async (t) => {
  const f = fixture(t);
  f.spend(2);
  const second = pr({ prNumber: 5537, prUrl: "https://github.com/acme/remudero/pull/5537" });
  await f.sweep([pr(), second]);
  assert.equal(f.open.length, 1);
  assert.equal(f.calls.filter(c => c === "comment").length, 1);
  assert.ok(f.commands.some(args => args[0] === "comment" && args[1].includes(second.prUrl)));
  await f.sweep([second]);
  assert.equal(f.calls.filter(c => c === "comment").length, 1);
  const unreadable = fixture(t);
  unreadable.spend(2);
  unreadable.failList();
  const result = await unreadable.sweep();
  assert.equal(unreadable.open.length, 0);
  assert.match(result.actions[0].reason, /issue list outage/);
});

test("W1-T5536: a laddered PR never opens a per-PR escalation issue", async (t) => {
  const f = fixture(t);
  f.rows.push({ step: "sweep.disposed", pr_number: 5536, head_sha: "old-head", disposition: "blocked-ambiguous", acted: true });
  await f.sweep();
  assert.equal(f.calls.includes("escalate"), false);
  assert.ok(f.calls.some(c => c.startsWith("close:")), "old escalation dedup cannot strand the ladder");
  for (const over of [
    { priorStrikes: 0, checksState: "green" as const, reviewState: "failure" as const },
    { priorStrikes: 0, checksState: "none" as const, isPlanFiling: true, lastActivityAt: stamp(-11 * 60_000) },
    { priorStrikes: 0, checksState: "green" as const, armRefusalIsTerminal: true },
    { priorStrikes: 0, checksState: "green" as const, mergeState: "dirty" as const },
    { priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap, checksState: "green" as const, reviewState: "failure" as const,
      unmetCriteria: [{ claim: "same unmet claim", proof: "proof", met: false, proof_exec: "executed_fail" as const, reason: "unmet" }],
      strikeHistory: Array.from({ length: DEFAULT_SWEEP_POLICY.strikeCap }, (_, i) => ({ strike: i + 1,
        round: "fresh" as const, unmetCount: 1, ciGreen: true, unmetClaims: ["same unmet claim"] })) },
  ]) {
    const other = fixture(t);
    const result = await other.sweep([pr(over)]);
    if (over.priorStrikes === DEFAULT_SWEEP_POLICY.strikeCap) {
      assert.equal(other.calls.includes("escalate"), false, JSON.stringify(result.actions));
      assert.match(result.actions[0]?.reason ?? "", /strike ladder/);
      assert.ok(other.calls.some(c => c.startsWith("close:")), "the ladder closes/requeues instead of filing a per-PR issue");
    } else {
      assert.equal(other.calls.includes("escalate"), true, JSON.stringify(result.actions));
      assert.equal(other.calls.some(c => c.startsWith("close:")), false);
    }
  }
});

test("W1-T5536: callers without ladder effects keep head-bound escalation and visible questions", async (t) => {
  const f = fixture(t);
  f.deps.strikeLadder = undefined;
  const first = await f.sweep();
  assert.equal(first.actionsTaken, 1);
  assert.equal(f.calls.filter(c => c === "escalate").length, 1);
  assert.ok(f.rows.findLast(r => r.step === "sweep.disposed")?.question);
  const repeated = await f.sweep();
  assert.equal(repeated.actionsTaken, 0);
  assert.equal(f.calls.filter(c => c === "escalate").length, 1);
  assert.ok(f.rows.findLast(r => r.step === "sweep.disposed")?.question);
  await f.sweep([pr({ headSha: "new-head" })]);
  assert.equal(f.calls.filter(c => c === "escalate").length, 2);
  assert.equal(f.calls.some(c => c.startsWith("close:")), false);
  assert.equal(f.open.length, 0);
  assert.deepEqual(loadOperatorNotesForTask(f.root, "W1-T5536"), []);
});

test("W1-T5536: missing-trailer repair precedes the configured exhaustion ladder", async (t) => {
  const f = fixture(t);
  const repairedBodies: string[] = [];
  f.deps.repairMissingTaskTrailer = (_pr, repair) => { repairedBodies.push(repair.repairedBody); };
  const missingTrailer = pr({
    taskId: undefined, body: "Implementation details only.\n", taskExistsOnMain: true,
    introducedTaskIds: [], changedFiles: ["src/lib/sweep.ts"], taskDeclaredFiles: ["src/lib/sweep.ts"],
    ciFailures: [{ name: "acceptance-author-gate", logTail: "REFUSED (no-header)" }],
  });
  const first = await f.sweep([missingTrailer]);
  assert.equal(repairedBodies.length, 1);
  assert.match(repairedBodies[0], /Remudero-Task: W1-T5536\n$/);
  assert.equal(first.actions[0].acted, false);
  assert.match(String(f.rows.findLast(r => r.step === "sweep.disposed")?.stand_down_reason), /missing trailer repaired/);
  await f.sweep([missingTrailer]);
  assert.equal(repairedBodies.length, 1, "the unchanged head waits for the edited-body gate result");
  assert.equal(f.calls.includes("escalate"), false);
  assert.equal(f.calls.some(c => c.startsWith("close:")), false);
  assert.equal(f.open.length, 0);
  assert.deepEqual(loadOperatorNotesForTask(f.root, "W1-T5536"), []);
});

test("W1-T5536: pure decisions preserve unreadable inputs, attempt history and cause identity", () => {
  const input = { mainTip: MAIN, lastAttemptAt: stamp(-2000), currentMergeBaseSha: "old-main", rebuildsSoFar: 0, requeueable: true, refreshedAtMainTip: false };
  assert.equal(decideStrikeLadderRung(input).rung, "refresh");
  for (const [mainTip, reason] of [
    [undefined, "main tip unavailable"],
    [{ ...MAIN, sha: "" }, "main tip sha unreadable"],
    [{ ...MAIN, committedAt: "bad" }, "main tip commit time unreadable"],
  ] as const) {
    assert.deepEqual(decideStrikeLadderRung({ ...input, mainTip }), {
      rung: "hold", reason: `strike ladder hold: ${reason}`,
    });
  }
  for (const over of [{ mainTip: undefined }, { mainTip: { ...MAIN, committedAt: "bad" } }, { currentMergeBaseSha: undefined }, { lastAttemptAt: undefined }, { lastAttemptAt: "bad" }, { rebuildsSoFar: -1 }, { rebuildsSoFar: 1.5 }, { requeueable: undefined }, { refreshedAtMainTip: undefined }]) {
    assert.equal(decideStrikeLadderRung({ ...input, ...over }).rung, "hold");
  }
  assert.equal(decideStrikeLadderRung({ ...input, refreshedAtMainTip: true }).rung, "rebuild");
  assert.equal(decideStrikeLadderRung({ ...input, lastAttemptAt: null, rebuildsSoFar: 2 }).rung, "digest");
  const rows = [
    { step: "fix.dispatch", task_id: "W1-T5536", head_sha: "other-head", ts: stamp(-500) },
    { step: "sweep.strike_ladder.refreshed", pr_number: 5536, ts: stamp(-1500) },
  ];
  assert.equal(latestStrikeLadderAttempt(rows, "W1-T5536", 5536), stamp(-500));
  assert.equal(latestStrikeLadderAttempt([], undefined, 5536), null);
  assert.equal(hasUnspentLadderRefresh(rows, "W1-T5536", 5536), false);
  assert.equal(hasUnspentLadderRefresh([{ step: "sweep.strike_ladder.refreshed", pr_number: 5536 }], "W1-T5536", 5536), true);
  assert.equal(strikeCauseKey(pr()), "check:ci#a broken invariant");
  assert.equal(strikeCauseKey(pr({ checksState: "green", redRequiredChecks: ["lint"], ciFailures: [{ name: "lint", logTail: "" }] })), "check:lint");
  assert.equal(strikeCauseKey(pr({ ciFailures: [{ name: "CI (1/8)", logTail: "" }] }), ["test/fail.test.ts"]), "check:ci#test/fail.test.ts");
  assert.equal(strikeCauseKey(pr({ ciFailures: [] })), "check:required");
  for (const cause of ["not-executed", "non-discriminating", "keyword-floor", "non-responsive", "unmet"]) {
    assert.equal(strikeCauseKey(pr({ checksState: "green", unmetCriteria: [{ claim: "claim", proof: "proof", met: false, reason: cause, proof_exec: "executed_fail" }] })), `review:${cause}`);
  }
  assert.equal(strikeCauseKey(pr({ ciFailures: [{ name: "X ".repeat(200), logTail: "" }] })).length, 160);
  assert.equal(capStrikeLadderNote("short"), "short");
  const note = capStrikeLadderNote("x".repeat(3000));
  assert.equal(note.length, 2000);
  assert.match(note, /truncated/);
});

test("W1-T5536: the default digest gateway shells out and assignment failure keeps its issue", async (t) => {
  const f = fixture(t);
  const shim = ghShim([
    { when: "api repos/acme/remudero/issues?", stdout: "[]" },
    { when: "issue create", stdout: "https://github.com/acme/remudero/issues/99" },
    { when: "--add-assignee", stderr: "owner cannot be assigned", exit: 1 },
  ]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(shim.dir, { recursive: true, force: true }); });
  const effects = buildSweepEffects({
    owner: "acme", repo: "remudero", repoRoot: f.root, config: { root: f.root, claudeBin: "/bin/true" } as Config,
    plan: { tasks: [], byId: new Map() } as unknown as Plan, ledgerPath: join(f.root, "ledger.ndjson"), runId: "default-ladder",
    log: (step, extra) => { f.rows.push({ step, ...extra }); },
  });
  const result = withLiveWritesAllowed(() => effects.strikeLadder!.digest(pr(), "check:ci#broken", 2, []));
  assert.equal(result.outcome, "opened");
  assert.equal(result.issueUrl, "https://github.com/acme/remudero/issues/99");
  assert.ok(shim.calls().some(call => call.includes("labels=strike-ladder-digest")));
  assert.ok(shim.calls().some(call => call.startsWith("issue edit") && call.includes("--add-assignee acme")));
  assert.ok(f.rows.some(row => row.step === "sweep.strike_ladder.assign_failed" && String(row.reason).includes("owner cannot be assigned")));
});

test("W1-T5536: failed refreshes, notes and ownership reads carry a retryable hold reason", async (t) => {
  for (const setup of [
    (f: ReturnType<typeof fixture>) => { f.deps.updateBranch = () => "error"; },
    (f: ReturnType<typeof fixture>) => { f.deps.updateBranch = undefined; },
    (f: ReturnType<typeof fixture>) => { f.deps.updateBranch = () => { throw new Error("refresh write failed"); }; },
    (f: ReturnType<typeof fixture>) => { f.effects.strikeLadder!.readAuthor = async () => { throw new Error("author read failed"); }; },
  ]) {
    const f = fixture(t);
    setup(f);
    const result = await f.sweep([pr({ currentMergeBaseSha: "old-main" })]);
    assert.match(result.actions[0].reason, /hold/);
    assert.equal(f.rows.some(row => row.step === "sweep.strike_ladder.refreshed"), false);
    assert.equal(f.calls.includes("escalate"), false);
  }
  const conflict = fixture(t);
  conflict.deps.updateBranch = () => "conflict";
  const climbed = await conflict.sweep([pr({ currentMergeBaseSha: "old-main" })]);
  assert.match(climbed.actions[0].reason, /strike ladder rebuild 1\/2/, "W1-T5635: a conflict climbs instead of holding");
  assert.ok(conflict.rows.some(row => row.step === "sweep.strike_ladder.held" && row.refresh_outcome === "conflict"));
  const note = fixture(t);
  note.effects.strikeLadder!.appendNote = () => false;
  const result = await note.sweep();
  assert.match(result.actions[0].reason, /durable failure note could not be written/);
  assert.equal(note.rows.some(row => row.step === "sweep.strike_ladder.requeued"), false);
  const moved = fixture(t);
  let reads = 0;
  moved.deps.readLiveState = () => ++reads === 1
    ? { ok: true, state: "OPEN", headSha: "old-head" }
    : { ok: true, state: "CLOSED", headSha: "unexpected-head" };
  await moved.sweep();
  assert.deepEqual(loadOperatorNotesForTask(moved.root, "W1-T5536"), []);
});

test("W1-T5536: unavailable digest effects and write failures remain visible without escalation", async (t) => {
  for (const setup of [
    (f: ReturnType<typeof fixture>) => { f.issues.listOpen = undefined; },
    (f: ReturnType<typeof fixture>) => { f.issues.ensureLabel = () => false; },
    (f: ReturnType<typeof fixture>) => { f.issues.create = () => { throw new Error("create outage"); }; },
    (f: ReturnType<typeof fixture>) => {
      f.open.push({ number: 1, url: "existing", title: "same cause", body: "**Cause-Key:** check:ci#a broken invariant" });
      f.issues.comment = undefined;
    },
  ]) {
    const f = fixture(t);
    f.spend(2);
    setup(f);
    const result = await f.sweep();
    assert.match(result.actions[0].reason, /hold/);
    assert.equal(f.calls.includes("escalate"), false);
    assert.equal(f.calls.includes("create"), false);
    assert.equal(f.calls.includes("comment"), false);
  }
  const dry = fixture(t);
  dry.deps.dryRun = true;
  await dry.sweep();
  assert.deepEqual(dry.calls, []);
  assert.deepEqual(loadOperatorNotesForTask(dry.root, "W1-T5536"), []);
  const released = fixture(t);
  released.deps.readRedBaseRefreshFacts = () => ({ behindBy: 3, baseChangedFiles: ["test/ladder.test.ts"] });
  await released.sweep([pr({ currentMergeBaseSha: "old-main" })]);
  assert.ok(released.rows.some(row => row.step === "sweep.update_branch.updated" && row.release_kind === "red-base"));
  assert.equal(released.rows.some(row => row.step === "sweep.strike_ladder.refreshed"), false, "the existing exact-path release wins");
});

test("W1-T5536: unreadable ladder inputs and moved live heads hold without action", async (t) => {
  for (const setup of [
    (f: ReturnType<typeof fixture>) => { f.deps.readMainRepair = () => undefined; },
    (f: ReturnType<typeof fixture>) => { f.deps.readMainRepair = () => { throw new Error("main read outage"); }; },
    (f: ReturnType<typeof fixture>) => { f.author(undefined); },
    (f: ReturnType<typeof fixture>) => { f.deps.readLiveState = () => ({ ok: false }); },
    (f: ReturnType<typeof fixture>) => { f.deps.readLiveState = () => ({ ok: true, state: "OPEN", headSha: "moved" }); },
    (f: ReturnType<typeof fixture>) => { mkdirSync(join(f.root, "plan")); writeFileSync(join(f.root, "plan/operator-notes.ndjson"), "corrupt\n"); },
    (f: ReturnType<typeof fixture>) => { mkdirSync(join(f.root, "plan", "operator-notes.ndjson"), { recursive: true }); },
    (f: ReturnType<typeof fixture>) => { mkdirSync(join(f.root, "plan")); writeFileSync(join(f.root, "plan/operator-notes.ndjson"), JSON.stringify({ taskId: "W1-T5536", author: "strike-ladder", note: "invalid stamp" })); },
  ]) {
    const f = fixture(t);
    setup(f);
    const result = await f.sweep();
    assert.equal(f.calls.some(c => ["refresh", "create", "escalate", "fix"].includes(c) || c.startsWith("close:")), false);
    assert.match(result.actions[0].reason, /hold|unreadable|head/i);
  }
});
