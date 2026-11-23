/**
 * W1-T12717 — AN UPDATE-BRANCH THAT CANNOT CURE A CROSSING IS NEVER REPEATED.
 *
 * 2026-11-14: the merge-time judge counted source-size from scripts/source-size-baseline.json, which CI
 * stopped reading at W1-T3140. Main was over many of its rows (src/lib/worker.ts 8354 lines against
 * 4000), so every pull request that added a line to such a file was a crossing, and the remedy was an
 * update-branch. An update lands the same merged tree and gives a new head, so the once-per-head guard
 * never fired: 280 updates on 22 pull requests that day (#18427 19 times). Each one dropped the
 * exact-head review and restarted CI. These tests replay that shape through the real merge-tree read,
 * the real judge, the arm path and the armed re-judge.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { attemptArm, logArmAttribution, type ArmDeps } from "#src/lib/arm-auto-merge.js";
import { runStepsSync } from "#src/lib/git-push.js";
import {
  COUNTED_RATCHET_GATES,
  RATCHET_JUDGE_ROWS_SHOWN,
  UNCOUNTED_RATCHET_GATES,
  judgeMergedRatchets,
  mergedRatchetReadSet,
  ratchetJudgeLedgerFields,
  readMergedRatchetInputsSteps,
  type MergedRatchetInputs,
  type MergedRatchetJudgement,
} from "#src/lib/merged-ratchet-verdict.js";
import { planSafetyGitSync } from "#src/lib/plan-pr-merge-safety.js";
import { runArmedRatchetRejudge, type ArmedStalledPr, type OpenPrView } from "#src/lib/sweep.js";
// @ts-expect-error -- plain .mjs script, no type declarations
import { CI_READS_BASELINE } from "#scripts/source-size-ratchet.mjs";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import * as sweepModule from "#test/helpers/sweep-test.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;
type Files = Record<string, string | null>;

const SIZE = "scripts/source-size-baseline.json";
const CLOCK = "scripts/clock-signature-baseline.json";
const WORKER = "src/lib/worker.ts";
const url = (n: number) => `https://github.com/craigoley/remudero/pull/${n}`;
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const numbered = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `export const ${prefix}${i} = ${i};\n`).join("");

function write(repo: GitRepo, files: Files, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    const abs = join(repo.dir, path);
    if (text === null) rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
  }
  repo.git("add", "-A");
  repo.git("commit", "-q", "--allow-empty", "-m", message);
  return repo.git("rev-parse", "HEAD");
}

function armDeps(calls: string[], judge: () => MergedRatchetJudgement, ledger: Row[]): ArmDeps {
  return {
    headSha: () => "head-sha",
    ledgerLines: () => ledger,
    armAuto: () => { calls.push("armAuto"); },
    mergeDirect: () => { calls.push("mergeDirect"); },
    disableAuto: () => { calls.push("disableAuto"); },
    readMergeFacts: () => ({ mergeable: "MERGEABLE", mergeableState: "clean", behindBy: 3 }),
    updateBranch: () => { calls.push("updateBranch"); return { ok: true }; },
    readPlanTouch: () => "untouched",
    readMergedRatchets: judge,
    say: () => {},
  };
}

/** One arm attempt, with its ledger rows appended the way the production arm site writes them. */
function armOnce(n: number, head: string, judge: MergedRatchetJudgement, ledger: Row[], calls: string[]) {
  const result = attemptArm(url(n), { ...armDeps(calls, () => judge, ledger), headSha: () => head }, head);
  logArmAttribution((step, extra = {}) => ledger.push({ step, ...extra }), result.outcome, url(n), "W1-T1", "review", {}, undefined,
    result.directMergePreflight, result.ratchetJudge);
  return result;
}

function sweepDeps(ledger: Row[], updates: ArmedStalledPr[], tip: () => string, judge: () => MergedRatchetJudgement) {
  return {
    ledgerPath: "/dev/null/ledger.ndjson",
    runId: "run-test",
    readLedger: () => ledger,
    appendLine: (_p: string, row: Row) => { ledger.push(row); },
    readMainTip: () => tip(),
    readMergedRatchets: async () => judge(),
    updateBranch: (t: ArmedStalledPr) => { updates.push(t); return "updated" as const; },
    now: () => Date.parse("2026-11-14T20:00:00.000Z"),
  };
}

function armedPr(n: number, head: string): OpenPrView {
  return { prNumber: n, prUrl: url(n), taskId: "unfiled", headSha: head, lastActivityAt: "2026-11-14T19:00:00.000Z", reviewState: "success",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: true, mergeState: "behind", changedFiles: [WORKER] };
}

/** Clock-signature trees in memory: each file holds `count` Date.now() calls, each baseline row is `row`. */
function clockInputs(merged: Record<string, { count: number; row: number }>, main: Record<string, { count: number; row: number }>): MergedRatchetInputs {
  const text = (n: number) => `${Array.from({ length: n }, (_, i) => `Date.now(); // l${i}`).join("\n")}\nexport const x = 1;\n`;
  const tree = (t: Record<string, { count: number; row: number }>) => (p: string) => p === CLOCK
    ? JSON.stringify(Object.fromEntries(Object.entries(t).map(([f, s]) => [f, { dateNow: s.row, legacy: 0, newDate: 0 }])))
    : t[p] ? text(t[p]!.count) : null;
  const files = Object.keys(merged);
  return { mainSha: "main-sha", headSha: "head-sha", changed: [...files, CLOCK], measuredFiles: [...files, CLOCK], populationFiles: files,
    readMerged: tree(merged), readMain: tree(main) };
}

const FILE = "src/lib/x.ts";
/** Main at its ceiling and the PR adding one: main and the PR cross together, which an update lets CI count. */
const TOGETHER = judgeMergedRatchets(clockInputs({ [FILE]: { count: 11, row: 10 } }, { [FILE]: { count: 10, row: 10 } }));
/** Main already over its ceiling (12 against 10) and the PR adding one: the PR's own diff. */
const OWN_DIFF = judgeMergedRatchets(clockInputs({ [FILE]: { count: 13, row: 10 } }, { [FILE]: { count: 12, row: 10 } }));

/** The #18427 shape in a real repository: main over its worker.ts row, a PR adding lines to it, and main moving. */
function overCeilingMain() {
  const origin = gitRepo({ kind: "ratchet-loop-origin" });
  const m0 = write(origin, { [SIZE]: json({ [WORKER]: 40 }), [WORKER]: numbered("w", 84) }, "m0: main 84 lines against a row of 40");
  origin.git("checkout", "-q", "-b", "pr", m0);
  const head = write(origin, { [WORKER]: `${numbered("w", 84)}${numbered("added", 6)}` }, "pr: six lines on worker.ts");
  origin.git("checkout", "-q", "main");
  origin.git("update-ref", "refs/pull/18427/head", head);
  const local = gitRepo({ cloneFrom: origin.dir, kind: "ratchet-loop-local" });
  let tip = m0;
  const moveMain = (i: number) => { tip = write(origin, { [`src/lib/other-${i}.ts`]: numbered(`o${i}`, 3) }, `main moves ${i}`); return tip; };
  const judge = (): MergedRatchetJudgement => {
    origin.git("update-ref", "refs/heads/judge-main", tip);
    return judgeMergedRatchets(runStepsSync(readMergedRatchetInputsSteps({ owner: "craigoley", repo: "remudero", prNumber: 18427 },
      () => ({ base: { ref: "judge-main" } }), planSafetyGitSync(local.dir))));
  };
  return { moveMain, judge, tip: () => tip };
}

test("W1-T12717 criterion 1: the judge counts only gates CI runs against the same baseline; source-size is a CI signal", () => {
  assert.equal(CI_READS_BASELINE, false);
  const scripts = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.match(scripts["source-size-signal"] ?? "", /scripts\/source-size-ratchet\.mjs/);
  assert.doesNotMatch(scripts["source-size-signal"] ?? "", /--baseline/, "CI's run of the gate reads no baseline");
  assert.ok(!COUNTED_RATCHET_GATES.includes("source-size"));
  assert.ok(UNCOUNTED_RATCHET_GATES.some((u) => u.gate === "source-size" && u.class === "ci-signal" && /CI_READS_BASELINE false/.test(u.reason ?? "")));
  // The judge never uses the source-size baseline, on either tree. Other gates may touch the path (the
  // affected-reach scan looks at every landing path), so the proof is that its text is never parsed: an
  // unparseable baseline would rule the gate `unread` if the source-size counter ran.
  const reader = (p: string) => (p === WORKER ? numbered("w", 90) : p === SIZE ? "{ this is not json" : null);
  const j = judgeMergedRatchets({ mainSha: "m", headSha: "h", changed: [WORKER, SIZE], measuredFiles: [], populationFiles: [WORKER], readMerged: reader, readMain: reader });
  assert.equal(j.verdict, "clean", j.reason);
  assert.equal(j.reason, undefined, "no gate was ruled unread");
  assert.ok(!j.counted.includes("source-size"));
  assert.ok(!mergedRatchetReadSet([WORKER], new Map(), [WORKER]).includes(SIZE));
});

test("W1-T12717 criterion 2: the #18427 replay: main over its worker.ts row and the PR adding lines is never updated, as main moves", async () => {
  const fx = overCeilingMain();
  const ledger: Row[] = [];
  const calls: string[] = [];
  const updates: ArmedStalledPr[] = [];
  for (let i = 1; i <= 3; i++) {
    fx.moveMain(i);
    const j = fx.judge();
    assert.equal(j.verdict, "clean", `main move ${i}: ${j.reason ?? JSON.stringify(j.rows)}`);
    assert.ok(j.uncounted.some((u) => u.gate === "source-size" && u.class === "ci-signal"));
    const arm = armOnce(18427, `head-${i}`, j, ledger, calls);
    assert.equal(arm.outcome, "armed", `main move ${i}`);
    assert.deepEqual(await runArmedRatchetRejudge([armedPr(18427, `head-${i}`)], sweepDeps(ledger, updates, fx.tip, fx.judge)), []);
  }
  assert.ok(!calls.includes("updateBranch"), calls.join(", "));
  assert.equal(updates.length, 0);
  assert.equal(ledger.filter((r) => r.step === "sweep.update_branch.attempted").length, 0);
  assert.ok(ledger.filter((r) => r.step === "sweep.ratchet_judge.decided").every((r) => r.remedy === "proceed"));
});

test("W1-T12717 criterion 3: a crossing from the PR's own diff on a CI-enforced gate is never answered with update-branch", async () => {
  assert.equal(OWN_DIFF.verdict, "crossing");
  assert.deepEqual(OWN_DIFF.rows.map((r) => [r.gate, r.merged, r.mainCeiling, r.prAdds]), [["clock-signature", 13, 10, 1]]);
  const ledger: Row[] = [];
  const calls: string[] = [];
  const said: string[] = [];
  const result = attemptArm(url(18501), { ...armDeps(calls, () => OWN_DIFF, ledger), say: (m: string) => { said.push(m); } }, "head-sha");
  assert.equal(result.outcome, "direct-merge-preflight-refused");
  assert.equal(result.directMergePreflight?.remedy, "fix-lane");
  assert.equal(result.directMergePreflight?.updateWithheld, "pr-diff");
  assert.deepEqual(calls, [], "neither updated, armed nor merged");
  assert.ok(said.some((m) => m.includes("W1-T12717") && m.includes("own diff") && m.includes(FILE)));
  logArmAttribution((step, extra = {}) => ledger.push({ step, ...extra }), result.outcome, url(18501), "W1-T1", "review", {}, undefined,
    result.directMergePreflight, result.ratchetJudge);
  const decided = ledger.find((r) => r.step === "sweep.ratchet_judge.decided");
  assert.equal(decided?.remedy, "fix-lane");
  assert.equal(decided?.update_withheld, "pr-diff");

  const swept: Row[] = [];
  const updates: ArmedStalledPr[] = [];
  assert.deepEqual(await runArmedRatchetRejudge([armedPr(18501, "head-a")], sweepDeps(swept, updates, () => "main-1", () => OWN_DIFF)), []);
  assert.equal(updates.length, 0);
  assert.equal(swept.filter((r) => r.step === "sweep.update_branch.attempted").length, 0);
  const row = swept.find((r) => r.step === "sweep.ratchet_judge.decided");
  assert.equal(row?.remedy, "fix-lane");
  assert.equal(row?.update_withheld, "pr-diff");
});

test("W1-T12717 criterion 4: a crossing main and the PR make together is updated once; the same crossing is not updated again", async () => {
  // The arm path: one update, then the same crossing on the next head and main is held without one.
  const ledger: Row[] = [];
  const calls: string[] = [];
  assert.equal(armOnce(18439, "head-1", TOGETHER, ledger, calls).outcome, "direct-merge-updated");
  const again = armOnce(18439, "head-2", { ...TOGETHER, mainSha: "main-2" }, ledger, calls);
  assert.equal(again.outcome, "direct-merge-preflight-refused");
  assert.equal(again.directMergePreflight?.remedy, "fix-lane");
  assert.equal(again.directMergePreflight?.updateWithheld, "repeat");
  assert.deepEqual(calls, ["updateBranch"]);
  assert.equal(ledger.filter((r) => r.step === "sweep.ratchet_judge.decided").at(-1)?.update_withheld, "repeat");
  // A crossing whose added count changed is a new crossing: it gets one update.
  const grown = judgeMergedRatchets(clockInputs({ [FILE]: { count: 12, row: 10 } }, { [FILE]: { count: 10, row: 10 } }));
  assert.equal(armOnce(18439, "head-3", grown, ledger, calls).outcome, "direct-merge-updated");
  assert.deepEqual(calls, ["updateBranch", "updateBranch"]);

  // The armed re-judge: the same rule, and it reads the arm path's rows too.
  const swept: Row[] = [];
  const updates: ArmedStalledPr[] = [];
  let tip = "main-1";
  const deps = sweepDeps(swept, updates, () => tip, () => TOGETHER);
  assert.deepEqual(await runArmedRatchetRejudge([armedPr(18424, "head-a")], deps), [18424]);
  tip = "main-2";
  assert.deepEqual(await runArmedRatchetRejudge([armedPr(18424, "head-b")], deps), [], "the head the update made is not updated again");
  assert.equal(updates.length, 1);
  const last = swept.filter((r) => r.step === "sweep.ratchet_judge.decided").at(-1);
  assert.equal(last?.remedy, "fix-lane");
  assert.equal(last?.update_withheld, "repeat");
  const shared = [...ledger];
  assert.deepEqual(await runArmedRatchetRejudge([armedPr(18439, "head-4")], sweepDeps(shared, updates, () => "main-4", () => grown)), []);
  assert.equal(updates.length, 1, "the arm path's update answered this crossing for the sweep too");
});

test("W1-T12717 criterion 5: the judge row carries a crossing key for every held row and each row carries prAdds", () => {
  const files = Array.from({ length: 12 }, (_, i) => `src/lib/f${i}.ts`);
  const many = judgeMergedRatchets(clockInputs(Object.fromEntries(files.map((f) => [f, { count: 3, row: 2 }])),
    Object.fromEntries(files.map((f) => [f, { count: 2, row: 2 }]))));
  assert.equal(many.rows.length, 12);
  assert.ok(many.rows.every((r) => r.prAdds === 1));
  const fields = ratchetJudgeLedgerFields(many);
  assert.equal((fields.rows as unknown[]).length, RATCHET_JUDGE_ROWS_SHOWN);
  assert.deepEqual(fields.crossing_keys, files.slice().sort().map((f) => `crossing:clock-signature:${f}#dateNow:+1`));
  assert.equal(ratchetJudgeLedgerFields(many, "repeat").update_withheld, "repeat");
  assert.equal("crossing_keys" in ratchetJudgeLedgerFields(judgeMergedRatchets({ upToDate: true, mainSha: "m", headSha: "h" })), false);
});

test("W1-T12717 criterion 6: invariant:an-update-never-repeats-for-one-crossing — ten main moves and new heads, one update", async () => {
  const ledger: Row[] = [];
  const calls: string[] = [];
  const updates: ArmedStalledPr[] = [];
  // One row only main and the PR make together, one the PR's own diff: the first is updated once; the second never.
  const mixed = judgeMergedRatchets(clockInputs({ [FILE]: { count: 11, row: 10 }, "src/lib/y.ts": { count: 13, row: 10 } },
    { [FILE]: { count: 10, row: 10 }, "src/lib/y.ts": { count: 12, row: 10 } }));
  assert.equal(mixed.rows.length, 2);
  for (let i = 1; i <= 10; i++) {
    const j = { ...mixed, mainSha: `main-${i}` };
    if (i % 2 === 0) armOnce(18305, `head-${i}`, j, ledger, calls);
    else await runArmedRatchetRejudge([armedPr(18305, `head-${i}`)], sweepDeps(ledger, updates, () => `main-${i}`, () => j));
  }
  assert.equal(calls.filter((c) => c === "updateBranch").length + updates.length, 1);
  assert.ok(!calls.includes("armAuto") && !calls.includes("mergeDirect"));
  const decided = ledger.filter((r) => r.step === "sweep.ratchet_judge.decided");
  assert.equal(decided.filter((r) => r.remedy === "update-branch").length, 1);
  assert.ok(decided.slice(1).every((r) => r.remedy === "fix-lane" && r.update_withheld === "repeat"));
});

test("W1-T12717 criterion 7: a withheld crossing is handed to the PR's fix lane with the crossing as its finding, never to the operator", async () => {
  const n = 18427;
  const head = "18427aaaa";
  const view: OpenPrView = { prNumber: n, prUrl: url(n), taskId: `W1-T${n}`, headRefName: `run-W1-T${n}-1794691624000`, reviewState: "success",
    checksState: "green", unmetCriteria: [], priorStrikes: 0, lastActivityAt: "2026-11-14T19:00:00Z", headSha: head, autoMergeArmed: false };
  // The arm path withheld the update on this head (main 12 against a ceiling of 10; the PR adds 1).
  const lines: Row[] = [];
  const result = attemptArm(url(n), { ...armDeps([], () => OWN_DIFF, lines), headSha: () => head }, head);
  logArmAttribution((step, extra = {}) => lines.push({ step, ...extra, head_sha: head }), result.outcome, url(n), `W1-T${n}`, "sweep", {}, undefined,
    result.directMergePreflight, result.ratchetJudge);
  assert.equal(lines.find((r) => r.step === "sweep.ratchet_judge.decided")?.remedy, "fix-lane");
  // W1-T14317: the head's live verdict; with no readable verdict history the sweep stops at the arm refusal.
  lines.push({ task_id: view.taskId, step: "review.posted", pr_url: view.prUrl, head_sha: head, capped: false, plan_only: false });
  const fixes: string[] = [];
  const armed: string[] = [];
  const escalated: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12717-`));
  try {
    const deps: sweepModule.SweepDeps = {
      arm: (p) => { armed.push(p.headSha); },
      close: () => {},
      dispatchFix: (_p, evidence) => { fixes.push(...(evidence as { ciFailures: Array<{ logTail: string }> }).ciFailures.map((f) => f.logTail)); },
      escalate: (_p, reason) => { escalated.push(reason); },
      ledgerPath: join(dir, "ledger.ndjson"),
      runId: "SWEEP-12717",
      now: () => Date.parse("2026-11-14T20:00:00Z"),
      readLedger: () => lines,
      appendLine: (_path, line) => { lines.push(line); },
      log: (step, extra = {}) => { lines.push({ run_id: "SWEEP-12717", step, ...extra }); },
      handedOffHeadJudgments: sweepModule.handedOffHeadJudgmentPool({ schedule: () => () => {} }),
    };
    await sweepModule.runSweep([view], deps);
    assert.equal(fixes.length, 1, "the fix lane was dispatched once");
    assert.match(fixes[0]!, /clock-signature src\/lib\/x\.ts#dateNow: main's count 12 \(ceiling 10\), this pull request's merged count 13, prAdds 1/);
    assert.match(fixes[0]!, /pr-diff/);
    assert.deepEqual(armed, [], "a held head is not armed");
    assert.deepEqual(escalated, [], "nothing reaches the operator");
    assert.ok(!lines.some((r) => r.remedy === "operator"));
    await sweepModule.runSweep([view], deps);
    assert.equal(fixes.length, 1, "an unchanged head dispatches no second fix");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
