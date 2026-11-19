/**
 * W1-T13708 — an armed re-judge carries a clean verdict across a main move that changes no path a counted gate reads.
 *
 * 2026-11-16 to 2026-11-18: 844 armed judgements took 9.3 h and every one was clean. For 32% of the repeat judgements,
 * main had changed only paths no gate reads (most were plan filings), so the verdict could not differ. A further 91
 * repeats judged a tree a row already judged, because the row was keyed by an older main than the judge fetched.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import { mainChangedPathsReader } from "#src/lib/arm-auto-merge.js";
import {
  COUNTED_RATCHET_GATES,
  RATCHET_JUDGE_DECIDED_STEP,
  ratchetReadsAnyPath,
  type CountedRatchetGate,
  type MergedRatchetJudgement,
} from "#src/lib/merged-ratchet-verdict.js";
import type { Plan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import * as sweep from "#src/lib/sweep.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import { gitRepo, originWithClone, type GitRepo } from "#test/helpers/git-repo.js";

const url = (n: number) => `https://github.com/craigoley/remudero/pull/${n}`;
const HEAD = "a".repeat(40);
const OLD_MAIN = "1".repeat(40);
const FETCHED_MAIN = "2".repeat(40);
const TIP = "3".repeat(40);

const CLEAN: MergedRatchetJudgement = { verdict: "clean", rows: [], counted: [...COUNTED_RATCHET_GATES], uncounted: [] };

function armedPr(n = 13708, headSha = HEAD): OpenPrView {
  return {
    prNumber: n, prUrl: url(n), taskId: "W1-T13708", headSha, lastActivityAt: "2026-11-18T12:00:00.000Z",
    reviewState: "success", checksState: "pending", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: true, mergeState: "behind",
    changedFiles: ["src/lib/sweep.ts"],
  } as OpenPrView;
}

function judgedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "earlier", task_id: "W1-T13708", step: RATCHET_JUDGE_DECIDED_STEP, pr_number: 13708, lane: "sweep-armed",
    verdict: "clean", counted_gates: [...COUNTED_RATCHET_GATES], uncounted_gates: [], rows: [], rows_count: 0,
    head_sha: HEAD, main_sha: OLD_MAIN, remedy: "proceed", ...over,
  };
}

type ChangedPathsReader = (prUrl: string, fromSha: string, toSha: string) => Promise<string[] | undefined>;

function harness(ledger: Record<string, unknown>[], tip: string, reader?: ChangedPathsReader) {
  const judged: string[] = [];
  const asked: Array<[string, string]> = [];
  const deps = {
    ledgerPath: "/dev/null/ledger.ndjson",
    runId: "run-t13708",
    readLedger: () => ledger,
    appendLine: (_p: string, row: Record<string, unknown>) => { ledger.push(row); },
    readMainTip: () => tip,
    readMergedRatchets: async (pr: OpenPrView) => { judged.push(`${pr.prNumber}@${tip}`); return { ...CLEAN, mainSha: tip, headSha: pr.headSha }; },
    now: () => Date.parse("2026-11-18T18:00:00.000Z"),
    ...(reader === undefined ? {} : {
      readMainChangedPaths: () => async (prUrl: string, from: string, to: string) => { asked.push([from, to]); return reader(prUrl, from, to); },
    }),
  };
  return { deps, judged, asked };
}

const decided = (ledger: Record<string, unknown>[]) => ledger.filter((r) => r.step === RATCHET_JUDGE_DECIDED_STEP);

test("W1-T13708 criterion 1: a clean verdict carries across a main move that changes no path a counted gate reads", async () => {
  for (const [label, prior, judgedMain] of [
    ["keyed by main_sha", judgedRow(), OLD_MAIN],
    ["keyed by merged_main_sha", judgedRow({ merged_main_sha: FETCHED_MAIN }), FETCHED_MAIN],
  ] as const) {
    const ledger = [prior];
    const h = harness(ledger, TIP, async () => ["plan/tasks.d/W1-T1-a.yaml", "docs/glossary.md", "README.md"]);
    assert.deepEqual(await sweep.runArmedRatchetRejudge([armedPr()], h.deps), [], label);
    assert.equal(h.judged.length, 0, `${label}: readMergedRatchets is not called`);
    assert.deepEqual(h.asked, [[judgedMain, TIP]], `${label}: the paths are read from the judged main to the tip`);
    const rows = decided(ledger);
    assert.equal(rows.length, 2, `${label}: one carried row`);
    const carried = rows[1]!;
    assert.equal(carried.verdict, "clean");
    assert.equal(carried.remedy, "proceed");
    assert.equal(carried.main_sha, TIP);
    assert.equal(carried.head_sha, HEAD);
    assert.equal(carried.carried_from_main_sha, judgedMain);
    assert.equal(carried.rows_count, 0);
    assert.equal(carried.lane, "sweep-armed");
    assert.equal("merged_main_sha" in carried, false);
    assert.deepEqual(carried.counted_gates, [...COUNTED_RATCHET_GATES]);
    assert.equal(sweep.armedRatchetRejudgeTargets([armedPr()], ledger, TIP).length, 0, `${label}: the carried row answers this tip`);
  }
});

const GATE_PATHS: Record<CountedRatchetGate, string[]> = {
  "clock-signature": ["src/lib/new-module.ts", "scripts/clock-signature-baseline.json"],
  "source-size": ["src/lib/sweep.ts", "scripts/source-size-baseline.json"],
  "fixture-copy": ["test/sweep/a.test.ts", "scripts/fixture-copy-baseline.json"],
  "deps-interface": ["src/lib/daemon.ts", "scripts/deps-interface-baseline.json"],
  "claude-md-budget": ["CLAUDE.md", "scripts/claude-md-budget-baseline.json"],
  "learnings-budget": ["learnings/house.yaml", "learnings/house.d/one.yaml", "scripts/learnings-budget-baseline.json"],
  "affected-reach": ["scripts/affected-reach-count.mjs", "bin/rmd.mjs", "test/helpers/x.ts", "package.json", "scripts/affected-reach-baseline.json"],
  "house-layout": ["src/run-task.ts"],
};
const MEASURED_ROOT_PATHS = ["src/x.md", "scripts/x.txt", "deploy/x.sh", ".github/workflows/ci.yml", "bin/x", "hooks/pre-push"];

test("W1-T13708 criterion 2: a main move that changes one path a counted gate reads is judged again", async () => {
  for (const gate of COUNTED_RATCHET_GATES) assert.ok(GATE_PATHS[gate]?.length, `${gate} has paths in this test`);
  const paths = [...COUNTED_RATCHET_GATES.flatMap((g) => GATE_PATHS[g]), ...MEASURED_ROOT_PATHS, "test/fixtures/x.json", "learnings/x.md", ""];
  for (const path of paths) {
    assert.equal(ratchetReadsAnyPath(["plan/a.yaml", path]), true, `${JSON.stringify(path)} is read`);
    const ledger = [judgedRow()];
    const h = harness(ledger, TIP, async () => ["plan/a.yaml", path]);
    await sweep.runArmedRatchetRejudge([armedPr()], h.deps);
    assert.deepEqual(h.judged, [`13708@${TIP}`], `${JSON.stringify(path)}: judged as origin/main does`);
    assert.equal(decided(ledger).some((r) => "carried_from_main_sha" in r), false);
  }
  assert.equal(ratchetReadsAnyPath(["plan/a.yaml", "docs/x.md", "README.md", "operator/notes.md"]), false);
  assert.equal(ratchetReadsAnyPath([]), false);
});

test("W1-T13708 criterion 3: only a clean verdict with no rows and remedy proceed carries, and a failed read judges", async () => {
  const row = { gate: "clock-signature", path: "src/a.ts", field: "dateNow", verdict: "stale-lowering", merged: 2, mainCeiling: 2, prCeiling: 1, rederived: 2, prAdds: 0 };
  const plan = async () => ["plan/a.yaml"];
  const cases: Array<[string, Record<string, unknown>[], ChangedPathsReader]> = [
    ["unread", [judgedRow({ verdict: "unread", reason: "git merge-tree exited 128" })], plan],
    ["crossing", [judgedRow({ verdict: "crossing", rows: [{ ...row, verdict: "crossing" }], rows_count: 1, remedy: "update-branch" })], plan],
    ["stale-lowering", [judgedRow({ verdict: "stale-lowering", rows: [row], rows_count: 1, remedy: "retry-later" })], plan],
    ["clean with rows", [judgedRow({ rows: [row], rows_count: 1 })], plan],
    ["remedy unwired", [judgedRow({ remedy: "unwired" })], plan],
    ["no remedy", [judgedRow({ remedy: undefined })], plan],
    ["newest row not clean", [judgedRow(), judgedRow({ main_sha: FETCHED_MAIN, verdict: "unread" })], plan],
    ["no judged main", [judgedRow({ main_sha: undefined })], plan],
    ["reader fails", [judgedRow()], async () => undefined],
  ];
  for (const [label, ledger, reader] of cases) {
    const h = harness(ledger, TIP, reader);
    await sweep.runArmedRatchetRejudge([armedPr()], h.deps);
    assert.deepEqual(h.judged, [`13708@${TIP}`], `${label}: judged as origin/main does`);
    assert.equal(decided(ledger).some((r) => "carried_from_main_sha" in r), false, `${label}: nothing carried`);
  }
  const other = harness([judgedRow({ head_sha: "b".repeat(40) })], TIP, plan);
  await sweep.runArmedRatchetRejudge([armedPr()], other.deps);
  assert.deepEqual(other.judged, [`13708@${TIP}`], "a clean verdict at another head never carries");

  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13708-noclone-`));
  try {
    const { clone } = originWithClone(join(root, "repos", "remudero"), { seed: { "plan/a.yaml": "a\n" } });
    const tip = clone.git("rev-parse", "HEAD");
    const read = mainChangedPathsReader(() => ({ root } as Config));
    assert.equal(await read(url(1), "9".repeat(40), tip), undefined, "an unknown commit is a failed read");
    assert.equal(await read(url(1), tip, "not-a-sha"), undefined, "a name that is not a commit is a failed read");
    const missing = mainChangedPathsReader(() => ({ root: join(root, "absent") } as Config));
    assert.equal(await missing(url(1), tip, tip), undefined, "a git error (no clone) is a failed read");
    const noConfig = mainChangedPathsReader(() => { throw new Error("no config here"); });
    assert.equal(await noConfig(url(1), tip, tip), undefined, "an unreadable config is a failed read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T13708 criterion 4: a row whose merged_main_sha differs from its main_sha counts as judged for the merged_main_sha", () => {
  const ledger = [judgedRow({ main_sha: OLD_MAIN, merged_main_sha: FETCHED_MAIN })];
  assert.equal(sweep.armedRatchetRejudgeTargets([armedPr()], ledger, FETCHED_MAIN).length, 0, "the fetched main is judged");
  assert.equal(sweep.armedRatchetRejudgeTargets([armedPr()], ledger, OLD_MAIN).length, 0, "the keyed main is judged");
  assert.deepEqual(sweep.armedRatchetRejudgeTargets([armedPr()], ledger, TIP).map((p) => p.prNumber), [13708], "a newer tip is not");
  assert.deepEqual(sweep.armedRatchetRejudgeTargets([armedPr(13708, "c".repeat(40))], ledger, FETCHED_MAIN).map((p) => p.prNumber), [13708],
    "another head is not");
});

function commitFiles(repo: GitRepo, files: Record<string, string>, message: string): string {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, rel)), { recursive: true });
    writeFileSync(join(repo.dir, rel), text);
  }
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", message);
  repo.git("push", "--quiet", "origin", "main");
  return repo.git("rev-parse", "HEAD");
}

test("W1-T13708 criterion 5: the reader buildSweepEffects builds carries a plan-only move and judges a src move in a real repository", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13708-`));
  try {
    mkdirSync(join(root, "repos"), { recursive: true });
    const { origin, clone } = originWithClone(join(root, "repos", "remudero"), { seed: { "src/a.ts": "export const a = 1;\n", "plan/a.yaml": "a\n" } });
    const judgedMain = clone.git("rev-parse", "HEAD");
    const pusher = gitRepo({ cloneFrom: origin.dir, kind: "t13708-pusher" });
    const effects = sweep.buildSweepEffects({ owner: "craigoley", repo: "remudero", config: { root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(root, "ledger.ndjson"), runId: "W1-T13708-test", plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: () => {}, readJsonImpl: async () => ({}) });
    assert.equal(typeof effects.readMainChangedPaths, "function");

    const run = async (tip: string, ledger: Record<string, unknown>[]) => {
      const judged: string[] = [];
      await sweep.runArmedRatchetRejudge([armedPr()], {
        ledgerPath: join(root, "ledger.ndjson"), runId: "W1-T13708-test", readLedger: () => ledger,
        appendLine: (_p: string, row: Record<string, unknown>) => { ledger.push(row); },
        readMainTip: () => tip, now: () => Date.parse("2026-11-18T18:00:00.000Z"),
        readMergedRatchets: async (pr: OpenPrView) => { judged.push(`${pr.prNumber}@${tip}`); return { ...CLEAN, mainSha: tip, headSha: pr.headSha }; },
        readMainChangedPaths: effects.readMainChangedPaths,
      });
      return judged;
    };

    const planTip = commitFiles(pusher, { "plan/b.yaml": "b\n", "docs/b.md": "b\n" }, "docs(plan): file a task");
    const planLedger = [judgedRow({ main_sha: judgedMain })];
    assert.deepEqual(await run(planTip, planLedger), [], "a plan-only move is not judged");
    assert.equal(decided(planLedger).at(-1)?.carried_from_main_sha, judgedMain);
    assert.equal(decided(planLedger).at(-1)?.main_sha, planTip);

    const srcTip = commitFiles(pusher, { "src/a.ts": "export const a = 2;\n" }, "fix: change a");
    const srcLedger = [judgedRow({ main_sha: planTip })];
    assert.deepEqual(await run(srcTip, srcLedger), [`13708@${srcTip}`], "a src move is judged");

    renameSync(join(pusher.dir, "plan", "a.yaml"), join(pusher.dir, "src", "moved.ts"));
    const renameTip = commitFiles(pusher, {}, "chore: move a plan file into src");
    assert.deepEqual(await run(renameTip, [judgedRow({ main_sha: srcTip })]), [`13708@${renameTip}`], "a rename into src is judged");

    pusher.git("rm", "--quiet", "src/moved.ts");
    pusher.git("commit", "--quiet", "-m", "chore: delete it");
    pusher.git("push", "--quiet", "origin", "main");
    const deleteTip = pusher.git("rev-parse", "HEAD");
    assert.deepEqual(await run(deleteTip, [judgedRow({ main_sha: renameTip })]), [`13708@${deleteTip}`], "a delete in src is judged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
