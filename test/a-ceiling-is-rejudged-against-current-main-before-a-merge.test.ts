/**
 * W1-T9962 — A RATCHET IS RE-JUDGED AGAINST CURRENT MAIN BEFORE THE SWEEP ARMS OR MERGES.
 *
 * 2026-10-16: #12428, #12388 (which lowered the src/run-task.ts row on a stale base) and #12437 each
 * originally used comment volume. Operator 2026-10-24 routes that to follow-up work; this replay now
 * uses clock signatures to preserve the remaining landing-tree protection. The replay
 * below rebuilds that shape in a real repository and judges each head on the main it would land on.
 */
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { attemptArm, logArmAttribution, readMergedRatchetsAsync, type ArmDeps } from "#src/lib/arm-auto-merge.js";
import { runStepsSync } from "#src/lib/git-push.js";
import {
  CLOCK_SCOPE_RE,
  judgeMergedRatchets,
  readMergedRatchetInputsSteps,
  type MergedRatchetInputs,
  type MergedRatchetJudgement,
} from "#src/lib/merged-ratchet-verdict.js";
import { planSafetyGitSync } from "#src/lib/plan-pr-merge-safety.js";
import { runArmedRatchetRejudge, type ArmedStalledPr, type OpenPrView } from "#src/lib/sweep.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const FILE = "src/run-task.ts";
const BASELINE = "scripts/clock-signature-baseline.json";
const N = 300;
const OWNER = "craigoley";
const REPO = "remudero";
const url = (n: number) => `https://github.com/${OWNER}/${REPO}/pull/${n}`;

function commit(repo: GitRepo, lines: string[], row: number, message: string): string {
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  mkdirSync(join(repo.dir, "scripts"), { recursive: true });
  writeFileSync(join(repo.dir, FILE), `${lines.map(line => `Date.now(); ${line}`).join("\n")}\nexport const x = 1;\n`);
  writeFileSync(join(repo.dir, BASELINE), `${JSON.stringify({ [FILE]: { dateNow: row, legacy: 0, newDate: 0 } }, null, 2)}\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", message);
  return repo.git("rev-parse", "HEAD");
}

function linesAt(repo: GitRepo): string[] {
  return repo.git("show", `HEAD:${FILE}`).split("\n").filter((l) => l.startsWith("Date.now(); //")).map(l => l.slice("Date.now(); ".length));
}

/** The incident: main at N comment lines and row N; #12402 adds one on main; A (#12428) adds one on the
 *  old base; B (#12388) trims one, merges main and records the shrunk row; C (#12437) adds one. */
function incident() {
  const origin = gitRepo({ kind: "ratchet-origin" });
  const c = Array.from({ length: N }, (_, i) => `// c${i + 1}`);
  const m0 = commit(origin, c, N, "m0: the recorded ceiling");
  origin.git("checkout", "-q", "-b", "a", m0);
  const a = commit(origin, [...c, "// a-bottom"], N + 1, "a: one line, row raised");
  origin.git("checkout", "-q", "-b", "c", m0);
  const cHead = commit(origin, [...c.slice(0, 100), "// c-mid", ...c.slice(100)], N + 1, "c: one line, row raised");
  origin.git("checkout", "-q", "main");
  const m1 = commit(origin, ["// main-top", ...c], N + 1, "m1: main grows the same file");
  origin.git("checkout", "-q", "-b", "b", m0);
  commit(origin, c.filter((l) => l !== "// c150"), N, "b: a worker trims a comment");
  origin.git("merge", "-q", "--no-ff", "-m", "Merge branch 'main'", m1);
  const b = commit(origin, linesAt(origin), N, "b: the ratchet records the shrunk row");
  origin.git("checkout", "-q", "main");
  origin.git("merge", "-q", "--no-ff", "-m", "merge a", "a");
  const m2 = origin.git("rev-parse", "HEAD");
  origin.git("merge", "-q", "--no-ff", "-m", "merge b", "b");
  const m3 = origin.git("rev-parse", "HEAD");
  for (const [n, sha] of [[12428, a], [12388, b], [12437, cHead]] as const) origin.git("update-ref", `refs/pull/${n}/head`, sha);
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "ratchet-clone" });
  return { origin, clone, m0, m1, m2, m3, a, b, c: cHead };
}

/** Judge PR `n` merged onto `mainSha`, through the production merge-tree read. */
function judgeOnto(fx: ReturnType<typeof incident>, n: number, mainSha: string): MergedRatchetJudgement {
  fx.origin.git("update-ref", "refs/heads/judge-main", mainSha);
  const rest = () => ({ base: { ref: "judge-main" } });
  return judgeMergedRatchets(runStepsSync(readMergedRatchetInputsSteps({ owner: OWNER, repo: REPO, prNumber: n }, rest, planSafetyGitSync(fx.clone.dir))));
}

/** The head's own tree against its own base tree, counted with no merge: what its CI measured. */
function judgeOwnTree(repo: GitRepo, base: string, head: string): MergedRatchetJudgement {
  const read = (rev: string) => (path: string) => (repo.git("ls-tree", "--name-only", rev, "--", path) ? repo.git("show", `${rev}:${path}`) : null);
  const changed = repo.git("diff", "--name-only", base, head).split("\n").filter(Boolean);
  const measuredFiles = repo.git("ls-tree", "-r", "--name-only", head, "--", "src", "scripts").split("\n").filter(Boolean);
  return judgeMergedRatchets({ mainSha: base, headSha: head, changed, measuredFiles, readMerged: read(head), readMain: read(base) });
}

function memoryInputs(merged: { count: number; row: number }, main: { count: number; row: number }): MergedRatchetInputs {
  const text = (n: number) => `${Array.from({ length: n }, (_, i) => `Date.now(); // l${i}`).join("\n")}\n`;
  const tree = (s: { count: number; row: number }) => (p: string) => (p === FILE ? text(s.count) : p === BASELINE ? JSON.stringify({ [FILE]: { dateNow: s.row, legacy: 0, newDate: 0 } }) : null);
  return { mainSha: "main-sha", headSha: "head-sha", changed: [FILE, BASELINE], measuredFiles: [FILE, BASELINE], readMerged: tree(merged), readMain: tree(main) };
}

const CROSSING = judgeMergedRatchets(memoryInputs({ count: N + 2, row: N + 1 }, { count: N + 1, row: N + 1 }));
const CLEAN = judgeMergedRatchets(memoryInputs({ count: N + 1, row: N + 1 }, { count: N, row: N + 1 }));

function armDeps(over: Partial<ArmDeps> & { calls: string[] }): ArmDeps {
  const { calls, ...rest } = over;
  return {
    headSha: () => "head-sha",
    ledgerLines: () => [],
    armAuto: () => { calls.push("armAuto"); },
    mergeDirect: () => { calls.push("mergeDirect"); },
    disableAuto: () => { calls.push("disableAuto"); },
    readMergeFacts: () => ({ mergeable: "MERGEABLE", mergeableState: "clean", behindBy: 7 }),
    updateBranch: () => { calls.push("updateBranch"); return { ok: true }; },
    readPlanTouch: () => "untouched",
    say: () => {},
    ...rest,
  };
}

test("W1-T9962: the three-merge replay still protects counted clock signatures against the landing tree", () => {
  const fx = incident();
  const a = judgeOnto(fx, 12428, fx.m1);
  assert.equal(a.verdict, "crossing");
  assert.deepEqual(a.rows.map((r) => [r.path, r.merged, r.prCeiling, r.mainCeiling]), [[FILE, N + 2, N + 1, N + 1]]);
  const b = judgeOnto(fx, 12388, fx.m2);
  assert.equal(b.verdict, "stale-lowering");
  assert.deepEqual(b.rows.map((r) => [r.path, r.merged, r.prCeiling, r.mainCeiling, r.rederived]), [[FILE, N + 1, N, N + 1, N + 1]]);
  const c = judgeOnto(fx, 12437, fx.m3);
  assert.equal(c.verdict, "crossing");
  assert.deepEqual(c.rows.map((r) => [r.path, r.merged, r.prCeiling, r.mainCeiling]), [[FILE, N + 2, N + 1, N]]);
  assert.equal(c.mainSha, fx.m3);
  assert.equal(c.headSha, fx.c);
  // Each head on its own base: the merge is the head (behind_by 0), and the head's own count passes.
  for (const [n, head, base] of [[12428, fx.a, fx.m0], [12388, fx.b, fx.m1], [12437, fx.c, fx.m0]] as const) {
    assert.equal(judgeOnto(fx, n, base).verdict, "clean", `#${n} on its own base`);
    const own = judgeOwnTree(fx.origin, base, head);
    assert.equal(own.verdict, "clean", `#${n}'s own tree`);
    assert.deepEqual(own.counted, ["clock-signature"]);
  }
});

test("W1-T9962: a PR that crosses a ceiling only on current main is refreshed, not armed or merged", () => {
  assert.equal(CROSSING.verdict, "crossing");
  // Green on its own base: the same head against the base it was cut from.
  assert.equal(judgeMergedRatchets(memoryInputs({ count: N + 1, row: N + 1 }, { count: N, row: N })).verdict, "clean");

  const calls: string[] = [];
  const result = attemptArm(url(12428), armDeps({ calls, readMergedRatchets: () => CROSSING }), "head-sha");
  assert.equal(result.outcome, "direct-merge-updated");
  assert.deepEqual(calls, ["updateBranch"], "updated once; never armed and never merged");
  assert.equal(result.directMergePreflight?.reason, "ratchet_collision");
  assert.equal(result.directMergePreflight?.remedy, "update-branch");

  const rows: Array<[string, Record<string, unknown>]> = [];
  logArmAttribution((step, extra = {}) => rows.push([step, extra]), result.outcome, url(12428), "W1-T9092", "sweep", {}, undefined,
    result.directMergePreflight, result.ratchetJudge);
  const updated = rows.find(([s]) => s === "automerge.direct_merge_updated")?.[1];
  assert.equal(updated?.reason, "ratchet_collision");
  assert.equal(updated?.prior_head_sha, "head-sha");
  const decided = rows.find(([s]) => s === "sweep.ratchet_judge.decided")?.[1];
  assert.equal(decided?.verdict, "crossing");
  assert.equal(decided?.remedy, "update-branch");
  assert.equal(decided?.rows_count, 1);

  // One update per (PR, head): the head already refreshed for a collision waits for its new head.
  const again: string[] = [];
  const held = attemptArm(url(12428), armDeps({ calls: again, readMergedRatchets: () => CROSSING,
    ledgerLines: () => [{ step: "automerge.direct_merge_updated", reason: "ratchet_collision", pr_url: url(12428), prior_head_sha: "head-sha" }] }), "head-sha");
  assert.equal(held.outcome, "direct-merge-preflight-refused");
  assert.deepEqual(again, []);

  // A behind plan PR whose merged plan is safe takes the direct merge: the count holds that merge too.
  const plan: string[] = [];
  const planResult = attemptArm(url(12500), armDeps({ calls: plan, readMergedRatchets: () => CROSSING, readPlanTouch: () => "touched",
    readPlanMergeSafety: () => ({ mergedTree: { state: "loads" }, prPlanPaths: ["plan/tasks.d/x.yaml"], mainPlanPaths: [] }) }), "head-sha");
  assert.equal(planResult.outcome, "direct-merge-updated");
  assert.equal(planResult.directMergePreflight?.reason, "ratchet_collision");
  assert.deepEqual(plan, ["updateBranch"]);
});

test("W1-T9962: a ceiling lowered on a stale base is re-derived against current main", () => {
  // #12388: the PR recorded N, main's row is N+1, and the merged tree counts N+1.
  const stale = judgeMergedRatchets(memoryInputs({ count: N + 1, row: N }, { count: N + 1, row: N + 1 }));
  assert.equal(stale.verdict, "stale-lowering");
  assert.deepEqual(stale.rows.map((r) => ({ verdict: r.verdict, merged: r.merged, prCeiling: r.prCeiling, mainCeiling: r.mainCeiling, rederived: r.rederived })),
    [{ verdict: "stale-lowering", merged: N + 1, prCeiling: N, mainCeiling: N + 1, rederived: N + 1 }]);
  // Above main's own ceiling it is a crossing, re-derived to the value the gate prints to record.
  const over = judgeMergedRatchets(memoryInputs({ count: N + 2, row: N }, { count: N + 1, row: N + 1 }));
  assert.equal(over.verdict, "crossing");
  assert.equal(over.rows[0]?.rederived, N + 2);
  // A crossing main already carried, and this merge did not grow, is main's to repair.
  assert.equal(judgeMergedRatchets(memoryInputs({ count: N + 2, row: N + 1 }, { count: N + 2, row: N + 1 })).verdict, "clean");
  // The clock-signature rows follow the same rule, inside CLOCK_SCOPE_RE only: a test file is never counted.
  const clockBaseline = "scripts/clock-signature-baseline.json";
  const twice = "export const a = Date.now() + Date.now();\n";
  const clockTree = (row: number) => (p: string) => p === clockBaseline ? JSON.stringify({ "src/lib/x.ts": { dateNow: row }, "test/x.test.ts": { dateNow: 0 } })
    : p === "src/lib/x.ts" || p === "test/x.test.ts" ? twice : null;
  const clock = judgeMergedRatchets({ mainSha: "m", headSha: "h", changed: ["src/lib/x.ts", "test/x.test.ts"], measuredFiles: [],
    readMerged: clockTree(1), readMain: clockTree(2) });
  assert.equal(CLOCK_SCOPE_RE.test("test/x.test.ts"), false);
  assert.equal(CLOCK_SCOPE_RE.test("src/lib/x.ts"), true);
  assert.deepEqual(clock.rows.map((r) => [r.gate, r.path, r.field, r.verdict, r.merged, r.prCeiling, r.mainCeiling, r.rederived]),
    [["clock-signature", "src/lib/x.ts", "dateNow", "stale-lowering", 2, 1, 2, 2]]);
  // The stale lowering holds the arm like a crossing does.
  const calls: string[] = [];
  const result = attemptArm(url(12388), armDeps({ calls, readMergedRatchets: () => stale }), "head-sha");
  assert.equal(result.outcome, "direct-merge-updated");
  assert.equal(result.directMergePreflight?.ratchetJudge?.rows[0]?.rederived, N + 1);
  assert.deepEqual(calls, ["updateBranch"]);
});

test("W1-T9962: an armed PR is re-judged once per main tip and refreshed when main moved it over a ceiling", async () => {
  const pr: OpenPrView = {
    prNumber: 12437, prUrl: url(12437), taskId: "unfiled", headSha: "head-c", lastActivityAt: "2026-10-16T21:35:51.000Z",
    reviewState: "success", checksState: "pending", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: true, mergeState: "behind",
    changedFiles: [FILE],
  };
  const unarmed: OpenPrView = { ...pr, prNumber: 12999, prUrl: url(12999), headSha: "head-x", autoMergeArmed: false };
  const ledger: Array<Record<string, unknown>> = [];
  let mainTip = "main-1";
  let verdict: MergedRatchetJudgement = CLEAN;
  const reads: string[] = [];
  const updates: ArmedStalledPr[] = [];
  const disarms: string[] = [];
  const deps = {
    ledgerPath: "/dev/null/ledger.ndjson",
    runId: "run-test",
    readLedger: () => ledger,
    appendLine: (_p: string, row: Record<string, unknown>) => { ledger.push(row); },
    readMainTip: () => mainTip,
    readMergedRatchets: async (p: OpenPrView) => { reads.push(`${p.prNumber}@${mainTip}`); return { ...verdict, mainSha: mainTip }; },
    updateBranch: (t: ArmedStalledPr) => { updates.push(t); return "updated" as const; },
    disarmAutoMerge: (u: string) => { disarms.push(u); return "disarmed" as const; },
    now: () => Date.parse("2026-10-16T22:00:00.000Z"),
  };

  assert.deepEqual(await runArmedRatchetRejudge([pr, unarmed], deps), []);
  assert.deepEqual(reads, ["12437@main-1"], "only the armed PR is judged");
  assert.equal(ledger.find((r) => r.step === "sweep.ratchet_judge.decided")?.remedy, "proceed");

  assert.deepEqual(await runArmedRatchetRejudge([pr], deps), []);
  assert.deepEqual(reads, ["12437@main-1"], "a quiet main costs nothing: the (head, main tip) pair is judged once");

  mainTip = "main-2";
  verdict = CROSSING;
  assert.deepEqual(await runArmedRatchetRejudge([pr], deps), [12437]);
  assert.deepEqual(reads, ["12437@main-1", "12437@main-2"]);
  assert.deepEqual(updates.map((u) => [u.prNumber, u.headSha, u.updateReason]), [[12437, "head-c", "ratchet-collision"]]);
  const decided = ledger.filter((r) => r.step === "sweep.ratchet_judge.decided");
  assert.deepEqual(decided.map((r) => [r.main_sha, r.verdict, r.remedy]), [["main-1", "clean", "proceed"], ["main-2", "crossing", "update-branch"]]);
  assert.equal(ledger.find((r) => r.step === "sweep.refresh.decided")?.forced_by, "ratchet-collision");
  assert.ok(ledger.some((r) => r.step === "sweep.update_branch.updated" && r.reason === "ratchet_collision"));
  assert.deepEqual(disarms, [], "never disarmed");

  mainTip = "main-3";
  assert.deepEqual(await runArmedRatchetRejudge([pr], deps), [], "one update per (PR, head)");
  assert.equal(updates.length, 1);
  assert.equal(ledger.filter((r) => r.step === "sweep.ratchet_judge.decided").at(-1)?.remedy, "retry-later");
});

test("W1-T9962: a refresh that fails or throws leaves the PR neither armed nor merged and names the failure", () => {
  for (const [label, updateBranch] of [
    ["throws", () => { throw new Error("update-branch exploded"); }],
    ["returns not-ok", () => ({ ok: false, error: "update-branch exploded" })],
  ] as const) {
    const calls: string[] = [];
    const said: string[] = [];
    const result = attemptArm(url(12700), armDeps({ calls, readMergedRatchets: () => CROSSING, updateBranch, say: (m: string) => { said.push(m); } }), "head-sha");
    assert.equal(result.outcome, "direct-merge-update-failed", label);
    assert.deepEqual(calls, [], `${label}: never armed and never merged`);
    assert.equal(result.directMergePreflight?.reason, "ratchet_collision", label);
    assert.equal(result.directMergePreflight?.error, "update-branch exploded", label);
    assert.ok(said.some((m) => m.startsWith("automerge.direct_merge_update_failed (W1-T9962)") && m.includes("update-branch exploded") && m.includes(FILE)), label);
  }
});

test("W1-T9962: a ratchet counter that throws, or a blob read that fails, is unread and not clean", () => {
  const counter = judgeMergedRatchets({ mainSha: "m", headSha: "h", changed: [FILE], measuredFiles: [FILE],
    readMerged: () => { throw new Error("counter blew up"); }, readMain: () => null });
  assert.equal(counter.verdict, "unread");
  assert.deepEqual(counter.rows, []);
  assert.match(counter.reason ?? "", /a ratchet counter threw: counter blew up/);

  const sha = (c: string) => c.repeat(40);
  let fetched = "";
  const run = (args: readonly string[]) => {
    const [verb] = args;
    if (verb === "rev-parse") return { status: 0, stdout: args[1] === "FETCH_HEAD" ? `${sha(fetched === "main" ? "a" : "b")}\n` : ".git\n" };
    if (verb === "fetch") { fetched = args[args.length - 1] === "main" ? "main" : "head"; return { status: 0, stdout: "" }; }
    if (verb === "merge-base") return { status: 0, stdout: `${sha("c")}\n` };
    if (verb === "merge-tree") return { status: 0, stdout: `${sha("d")}\n` };
    if (verb === "diff") return { status: 0, stdout: `${FILE}\n` };
    if (verb === "ls-tree") return { status: 0, stdout: `${FILE}\n` };
    return { status: 128, stdout: "", stderr: "fatal: bad object" };
  };
  const read = judgeMergedRatchets(runStepsSync(readMergedRatchetInputsSteps({ owner: OWNER, repo: REPO, prNumber: 7 }, () => ({ base: { ref: "main" } }), run)));
  assert.equal(read.verdict, "unread");
  assert.match(read.reason ?? "", /git cat-file --batch exited 128: fatal: bad object/);
});

test("W1-T9962: with no readable config the production reader is unread, never clean", async () => {
  const j = await readMergedRatchetsAsync(url(12701), () => { throw new Error("no config here"); });
  assert.equal(j.verdict, "unread");
  assert.match(j.reason ?? "", /no clone to merge in: no config here/);
});

test("W1-T9962: an armed re-judge whose read or refresh throws records unread and the error, and goes on", async () => {
  const pr: OpenPrView = {
    prNumber: 12800, prUrl: url(12800), taskId: "unfiled", headSha: "head-d", lastActivityAt: "2026-10-16T21:35:51.000Z",
    reviewState: "success", checksState: "pending", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: true, mergeState: "behind",
    changedFiles: [FILE],
  };
  const ledger: Array<Record<string, unknown>> = [];
  let judged = CROSSING;
  let readThrows = true;
  const deps = {
    ledgerPath: "/dev/null/ledger.ndjson",
    runId: "run-test",
    readLedger: () => ledger,
    appendLine: (_p: string, row: Record<string, unknown>) => { ledger.push(row); },
    readMainTip: () => "main-9",
    readMergedRatchets: async () => { if (readThrows) throw new Error("clone unreadable"); return judged; },
    updateBranch: () => { throw new Error("update refused"); },
    now: () => Date.parse("2026-10-16T22:00:00.000Z"),
  };
  assert.deepEqual(await runArmedRatchetRejudge([pr], deps), []);
  const unread = ledger.find((r) => r.step === "sweep.ratchet_judge.decided");
  assert.equal(unread?.verdict, "unread");
  assert.equal(unread?.remedy, "proceed");
  assert.match(String(unread?.reason), /clone unreadable/);

  ledger.length = 0;
  readThrows = false;
  assert.deepEqual(await runArmedRatchetRejudge([pr], deps), [12800]);
  const errored = ledger.find((r) => r.step === "sweep.update_branch.error");
  assert.equal(errored?.error, "update refused");
  assert.equal(errored?.reason, "ratchet_collision");
  assert.equal(errored?.pr_number, 12800);
});

test("W1-T9962: a clean merge arms as today, an unreadable merge records unread, and a run-derived gate is named", () => {
  const calls: string[] = [];
  const clean = attemptArm(url(12600), armDeps({ calls, readMergedRatchets: () => CLEAN }), "head-sha");
  assert.equal(clean.outcome, "armed");
  assert.deepEqual(calls, ["armAuto"]);
  assert.equal(clean.ratchetJudge?.verdict, "clean");

  const thrown: string[] = [];
  const unread = attemptArm(url(12601), armDeps({ calls: thrown, readMergedRatchets: () => { throw new Error("git merge-tree exited 128"); } }), "head-sha");
  assert.equal(unread.outcome, "armed");
  assert.deepEqual(thrown, ["armAuto"]);
  assert.equal(unread.ratchetJudge?.verdict, "unread");
  assert.match(unread.ratchetJudge?.reason ?? "", /merge-tree exited 128/);
  const rows: Array<[string, Record<string, unknown>]> = [];
  logArmAttribution((step, extra = {}) => rows.push([step, extra]), unread.outcome, url(12601), "W1-T1", "sweep", {}, undefined, undefined, unread.ratchetJudge);
  const decided = rows.find(([s]) => s === "sweep.ratchet_judge.decided")?.[1];
  assert.equal(decided?.verdict, "unread");
  assert.equal(decided?.remedy, "proceed");
  assert.match(String(decided?.reason), /merge-tree exited 128/);

  // The production read with no base ref to merge onto is unread, never clean.
  const noBase = judgeMergedRatchets(runStepsSync(readMergedRatchetInputsSteps({ owner: OWNER, repo: REPO, prNumber: 1 }, () => ({}), () => ({ status: 0, stdout: "" }))));
  assert.equal(noBase.verdict, "unread");
  assert.match(noBase.reason ?? "", /no base ref/);

  for (const j of [CLEAN, unread.ratchetJudge!]) {
    assert.ok(j.uncounted.some((g) => g.gate === "coverage" && g.class === "run-derived"));
    assert.ok(j.uncounted.some((g) => g.gate === "mutation" && g.class === "run-derived"));
    assert.ok(j.uncounted.some((g) => g.gate === "source-size" && g.class === "delta-only"));
  }
  assert.ok((decided?.uncounted_gates as string[]).includes("coverage:run-derived"));
});
