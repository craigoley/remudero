/**
 * W1-T12227: a review runs from fresh code when the reviewer code is behind at admission.
 *
 * One function decides the path of a review before any reviewer spend (`decideReviewPath`, src/lib/run-child.ts). The
 * sweep gate, the fix pipeline's required review and the run child's detached review all call it, so no path starts a
 * reviewer on a stale reading. The tests drive the production gate, runner and command with GitHub, git and the
 * reviewer replaced.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { buildIntoStore, type BuildIntoStoreOptions, type StoreBuildResult } from "#src/lib/child-entry-store.js";
import type { Config } from "#src/lib/config.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { postReviewStatusGuarded } from "#src/lib/review.js";
import { runDetachedReview, type FreshTreeReview } from "#src/lib/run-child.js";
import type { ReviewerCodeFreshness } from "#src/lib/self-sync.js";
import { readLedgerLines } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { runInWorkerSpawnScope, WorkerSpawnRetiredError, type WorkerSpawnScope } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import {
  buildFreshTreeReviewRunner, buildRequiredFixReviewRunner, buildReviewerCodeFreshnessGate, reviewCommand, spawnRmdReviewForFreshTree,
} from "#test/helpers/run-task-test.js";

const build = createRequire(import.meta.url)("#scripts/build-child-entries.mjs");
type Row = Record<string, unknown>;
type Stale = Extract<ReviewerCodeFreshness, { status: "stale" }>;

const OLD = "a".repeat(40);
const MAIN = "b".repeat(40);
const NEXT_MAIN = "d".repeat(40);
const HEAD = "c".repeat(40);
const PR_URL = "https://github.com/acme/remudero/pull/7";
const staleAt = (originMainSha: string): Stale => ({ status: "stale", codeSha: OLD, originMainSha, changedPaths: ["src/lib/review.ts"] });
const FRESH: ReviewerCodeFreshness = { status: "fresh", codeSha: MAIN, originMainSha: MAIN, advance: "none" };
const FIX_ARGS = { prUrl: PR_URL, owner: "acme", repo: "remudero" } as never;

/** A fresh-tree runner that records each call and ends as `ends` says for the sha of its tree. */
function recordingRunner(ends: (sha: string) => { code: number | undefined; cause?: string; failure?: string }) {
  const calls: Array<{ prArg: string; rest: string[]; sha: string }> = [];
  const runner = async (prArg: string, rest: string[], read: { originMainSha: string }, onFailure?: (why: string) => void,
    _onEntry?: unknown, onExit?: (exit: { cause: string }) => void) => {
    calls.push({ prArg, rest, sha: read.originMainSha });
    const end = ends(read.originMainSha);
    if (end.failure !== undefined) onFailure?.(end.failure);
    if (end.cause !== undefined) onExit?.({ cause: end.cause });
    return end.code;
  };
  return { calls, runner };
}

function gateWith(readings: ReviewerCodeFreshness[], runner?: FreshTreeReview) {
  const rows: Row[] = [];
  const inProcess: Array<{ prArg: string; start?: ReviewerCodeFreshness }> = [];
  let read = 0;
  const gate = buildReviewerCodeFreshnessGate(() => readings[Math.min(read++, readings.length - 1)]!,
    (step, extra) => { rows.push({ step, ...extra }); },
    async (prArg, _rest, deps) => { inProcess.push({ prArg, start: deps.reviewStartFreshness }); return 0; }, runner);
  return { gate, rows, inProcess, reads: () => read };
}

test("W1-T12227 criterion 1: a required fix review on a stale reading runs from the fresh tree and starts no reviewer here", async () => {
  const fresh = recordingRunner(() => ({ code: 0 }));
  const { gate, rows } = gateWith([staleAt(MAIN)], fresh.runner);
  let reviewed = 0;
  const review = buildRequiredFixReviewRunner(async () => { reviewed++; return {} as never; }, () => staleAt(MAIN),
    { gate, readHead: () => HEAD });
  const result = await review(FIX_ARGS);
  assert.equal(reviewed, 0, "no reviewer starts in this process");
  assert.equal(fresh.calls.length, 1);
  assert.equal(fresh.calls[0]!.prArg, "7");
  assert.deepEqual(fresh.calls[0]!.rest.slice(0, 2), ["--repo", "acme/remudero"]);
  assert.ok(fresh.calls[0]!.rest.includes("--judge-at-own-start"));
  assert.deepEqual(fresh.calls[0]!.rest.slice(fresh.calls[0]!.rest.indexOf("--execution-mode"), -1), ["--execution-mode", "semantic"]);
  assert.equal(rows.filter((row) => row.step === "review.ran_from_fresh_tree").length, 1);
  assert.equal(result.headSha, HEAD);
  assert.match(String(result.verdictWithheld), /ran from a fresh tree/, "the rung stands down; the fresh tree posts the verdict");
  assert.deepEqual(gate.staleThisPass(), { oldSha: OLD, newSha: MAIN }, "the pass still counts the stale reading");
});

test("W1-T14916: a drain lock release during the freshness read starts no in-process review, from the gate or a fix rung", async () => {
  for (const reading of [FRESH, { status: "unreadable", reason: "fetch failed" } as ReviewerCodeFreshness]) {
    const scope: WorkerSpawnScope = {};
    const read = () => { scope.retiredBy = "released"; return reading; };
    let reviewed = 0;
    const gate = buildReviewerCodeFreshnessGate(read, () => {}, async () => { reviewed++; return 0; });
    await assert.rejects(runInWorkerSpawnScope(scope, () => gate.call("7", [], {})), WorkerSpawnRetiredError);
    const review = buildRequiredFixReviewRunner(async () => { reviewed++; return {} as never; }, read, { gate, readHead: () => HEAD });
    const result = await runInWorkerSpawnScope(scope, () => review(FIX_ARGS));
    assert.equal(result.verdictWithheld, "retired: released; no reviewer started", "the rung stands down");
    assert.equal(result.reviewerOutcome, "admission_abandoned");
    assert.equal(result.headSha, HEAD);
    assert.equal(reviewed, 0);
  }
  const { gate } = gateWith([FRESH]);
  const failing = buildRequiredFixReviewRunner(async () => { throw new Error("review broke"); }, () => FRESH, { gate, readHead: () => HEAD });
  await assert.rejects(failing(FIX_ARGS), /review broke/, "any other failure still reaches the rung");
});

test("W1-T12227 criterion 2: the run child's detached review on a stale reading runs from the fresh tree, not in the child", async () => {
  const fresh = recordingRunner(() => ({ code: 0 }));
  const { gate, inProcess } = gateWith([staleAt(MAIN)], fresh.runner);
  const result = await runDetachedReview({ kind: "review", prNumber: 7, inputs: { repo: "acme/remudero", reviewAttemptId: "review-PR7-00000000-0000-4000-8000-000000000000" } },
    { runId: "run-1", taskId: "PR-7" }, (prArg, rest, opts) => gate.call(prArg, rest, opts));
  assert.equal(result.verdict, "no_pr");
  assert.equal(inProcess.length, 0, "the child starts no reviewer of its own");
  assert.equal(fresh.calls.length, 1);
  assert.ok(fresh.calls[0]!.rest.includes("--judge-at-own-start"));
  assert.ok(fresh.calls[0]!.rest.includes("--review-attempt-id"), "the detached inputs reach the fresh-tree child");
});

/** `rmd review` as a fresh-tree child: no start reading handed, `--judge-at-own-start`, its own reading `own`. */
async function childReview(own: () => ReviewerCodeFreshness, extra: string[] = []) {
  const root = makeTempDir("t12227-child");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const exitFile = join(root, "cause");
  const seen = { pending: 0, reviewed: 0, admission: undefined as unknown };
  const originalLog = console.log;
  console.log = () => {};
  try {
    const code = await reviewCommand("6011", ["--repo", "acme/remudero", "--judge-at-own-start", "--exit-cause-file", exitFile, ...extra], {
      fetchView: () => ({ number: 6011, html_url: "https://github.com/acme/remudero/pull/6011", head: { ref: "fixture", sha: head },
        updated_at: new Date(0).toISOString(), body: "## Acceptance\n- the fixture holds | manual fixture" }),
      loadConfig: () => ({ root, claudeBin: "/bin/true" }) as Config,
      fetchHead: () => {},
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "not needed" } }),
      postReviewPending: async () => { seen.pending++; return { posted: false }; },
      reviewerCodeFreshness: own,
      runReview: async (args) => {
        seen.reviewed++;
        seen.admission = args.admission;
        return { state: "success", criteria: [], testTheater: false, summary: "fixture", floorDegraded: false, capped: false,
          keywordOnly: false, planOnly: false, headSha: head, reviewerOutcome: "success" };
      },
    });
    return { code, ...seen, cause: existsSync(exitFile) ? readFileSync(exitFile, "utf8").trim() : undefined,
      rows: readLedgerLines(ledgerPathFor({ root } as Config)) as Row[] };
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T12227 criterion 3: a fresh-tree child stale at its own start exits before its pending status and its reviewer", async () => {
  const run = await childReview(() => staleAt(MAIN));
  assert.equal(run.code, 2);
  assert.equal(run.cause, "reviewer-stale-at-start");
  assert.equal(run.pending, 0, "no pending status");
  assert.equal(run.reviewed, 0, "no reviewer");
  assert.equal(run.rows.some((row) => row.step === "review.post_refused"), false, "nothing was judged, so nothing is refused");
});

test("W1-T12227 criterion 3: the gate runs that review once more from a tree at the new head of main, and not a third time", async () => {
  const fresh = recordingRunner(() => ({ code: 2, cause: "reviewer-stale-at-start" }));
  const { gate, rows, inProcess } = gateWith([staleAt(MAIN), staleAt(NEXT_MAIN), staleAt("f".repeat(40))], fresh.runner);
  assert.equal(await gate.call("7", ["--repo", "acme/remudero"], {}), 2);
  assert.deepEqual(fresh.calls.map((call) => call.sha), [MAIN, NEXT_MAIN], "one retry, at the newer main");
  assert.equal(inProcess.length, 0);
  const row = rows.find((r) => r.step === "review.ran_from_fresh_tree");
  assert.deepEqual([row?.exit_cause, row?.retried_after, row?.origin_main_sha], ["reviewer-stale-at-start", "reviewer-stale-at-start", NEXT_MAIN]);
});

test("W1-T12227 criterion 4: when the fresh tree cannot run, no reviewer starts and review.skipped_stale_reviewer_code says why", async () => {
  const fresh = recordingRunner(() => ({ code: undefined, failure: "worktree add refused" }));
  const { gate, rows } = gateWith([staleAt(MAIN)], fresh.runner);
  let reviewed = 0;
  const review = buildRequiredFixReviewRunner(async () => { reviewed++; return {} as never; }, () => staleAt(MAIN),
    { gate, readHead: () => HEAD });
  const result = await review(FIX_ARGS);
  assert.equal(reviewed, 0);
  assert.match(String(result.verdictWithheld), /no reviewer started/);
  const skipped = rows.find((row) => row.step === "review.skipped_stale_reviewer_code");
  assert.deepEqual([skipped?.fresh_tree, skipped?.fresh_tree_reason], ["unavailable", "worktree add refused"]);

  // With no runner wired, the sweep gate skips as before; no in-process reviewer either.
  const bare = gateWith([staleAt(MAIN)]);
  assert.equal(await bare.gate.call("7", [], {}), 0);
  assert.equal(bare.inProcess.length, 0);
  assert.equal(bare.rows[0]?.step, "review.skipped_stale_reviewer_code");
});

test("W1-T12227 criterion 5: a terminal verdict refused for stale code after a reviewer ran writes review.refused_after_finished_review", async () => {
  const root = makeTempDir("t12227-refused");
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    const post = (state: "success" | "pending", reviewerCodeFreshness: ReviewerCodeFreshness, finished?: boolean) => postReviewStatusGuarded({
      owner: "acme", repo: "remudero", sha: HEAD, state, taskId: "PR-7", evidence: "no_evidence", ledgerPath, runId: "run-1",
      prUrl: PR_URL, reviewerCodeFreshness, fetchLifecycle: () => ({ merged: false, closed: false }),
      readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }), post: () => assert.fail("a refused verdict is not posted"),
      ...(finished ? { finishedReview: { admission: "operator" as const, reviewerMs: 390_000 } } : {}),
    });
    assert.equal((await post("success", staleAt(MAIN), true)).posted, false);
    const steps = readLedgerLines(ledgerPath).map((row) => row.step);
    assert.deepEqual(steps, ["review.post_refused", "review.refused_after_finished_review"], "post_refused stays, then the defect row");
    const row = readLedgerLines(ledgerPath).at(-1)!;
    assert.deepEqual([row.pr_url, row.head_sha, row.admission, row.reviewer_ms], [PR_URL, HEAD, "operator", 390_000]);

    // An unreadable reading, or a caller whose reviewer did not run, keeps only review.post_refused.
    await post("success", { status: "unreadable", reason: "fetch failed" }, true);
    await post("success", staleAt(MAIN), false);
    assert.equal(readLedgerLines(ledgerPath).filter((r) => r.step === "review.refused_after_finished_review").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // The review command names its admission path to the review it runs.
  const operator = await childReview(() => FRESH);
  assert.deepEqual([operator.code, operator.reviewed, operator.admission], [0, 1, "fresh-tree-child"]);
});

test("W1-T12227 criterion 6: a fresh reading at admission reviews in this process, and that reading decides the publication", async () => {
  const fresh = recordingRunner(() => assert.fail("a fresh reading never uses the fresh tree"));
  const { gate, inProcess } = gateWith([FRESH], fresh.runner);
  assert.equal(await gate.call("7", [], {}), 0);
  assert.deepEqual(inProcess, [{ prArg: "7", start: FRESH }]);

  let reads = 0;
  let seen: { admission?: unknown; publication?: ReviewerCodeFreshness } = {};
  const review = buildRequiredFixReviewRunner(async (args) => {
    seen = { admission: args.admission, publication: await args.reviewerCodeFreshness?.() };
    return { marker: "in-process" } as never;
  }, () => { reads++; return reads === 1 ? FRESH : staleAt(NEXT_MAIN); }, { gate, readHead: () => assert.fail("no head read here") });
  assert.deepEqual(await review(FIX_ARGS), { marker: "in-process" });
  assert.deepEqual(seen, { admission: "required-fix", publication: FRESH }, "a main that moves during the review does not withhold it");
  assert.equal(reads, 1);
});

function reviewerTreeFixture() {
  const root = makeTempDir("t12227-store");
  const tree = join(root, `reviewer-${MAIN.slice(0, 12)}`);
  mkdirSync(tree);
  writeFileSync(join(tree, "package.json"), '{"type":"module"}');
  for (const source of [...build.CHILD_ENTRIES.map((entry: { source: string }) => entry.source), ...build.WORKER_ENTRIES]) {
    mkdirSync(dirname(join(tree, source)), { recursive: true });
    writeFileSync(join(tree, source), source === "src/run-task.ts" ? [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(new URL('../observed.json', import.meta.url), JSON.stringify({ bundled: globalThis.__rmd_bundled === true }));",
    ].join("\n") : "export const fixture = true;\n");
  }
  mkdirSync(join(tree, "bin"));
  mkdirSync(join(tree, "scripts"));
  copyFileSync(join(REPO_ROOT, "bin/rmd"), join(tree, "bin/rmd"));
  copyFileSync(join(REPO_ROOT, "scripts/build-child-entries.mjs"), join(tree, "scripts/build-child-entries.mjs"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(tree, "node_modules"));
  return { root, tree, store: join(root, "store") };
}

test("W1-T12227 criterion 7: a store miss starts one unawaited build for the commit, and a later review runs the compiled entry", async () => {
  const f = reviewerTreeFixture();
  try {
    const rows: Row[] = [];
    const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); };
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let builds = 0;
    const slowBuild = async (tree: string, opts: BuildIntoStoreOptions): Promise<StoreBuildResult> => {
      builds++;
      await held;
      return buildIntoStore(tree, opts);
    };
    const env = { ...process.env, NODE_V8_COVERAGE: "" };
    const runner = buildFreshTreeReviewRunner("/repo", {
      git: () => "", addWorktree: () => {}, inspectExistingWorktree: () => "reusable", prepareWorktree: () => true,
      withWorktreeLease: async (_tree, action) => action(), worktreeRoot: f.root, storeFill: { log, build: slowBuild },
      spawnReview: (tree, args, failure, _env, entry, store, exit) =>
        spawnRmdReviewForFreshTree(tree, args, failure, env, entry, { ...store, storeRoot: f.store }, exit),
    });
    const { gate, rows: gateRows } = gateWith([staleAt(MAIN)], runner);
    const entryOf = () => gateRows.filter((row) => row.step === "review.ran_from_fresh_tree").at(-1);

    assert.equal(await gate.call("7", [], {}), 0, "the review ends while its build is still held: nothing waits for it");
    assert.deepEqual([entryOf()?.entry_kind, builds], ["tsx", 1]);
    assert.equal(await gate.call("7", [], {}), 0);
    assert.equal(builds, 1, "one build per commit");
    assert.equal(rows.filter((row) => row.step === "child_entry.store_build_requested" && row.source === "fresh-tree-review").length, 1);

    release();
    for (let i = 0; i < 600 && !rows.some((row) => row.step === "child_entry.store_built"); i++) await delay(100);
    assert.ok(rows.some((row) => row.step === "child_entry.store_built"), `the build ledgers its result: ${JSON.stringify(rows)}`);
    assert.equal(await gate.call("7", [], {}), 0);
    assert.equal(entryOf()?.entry_kind, "bundle", "a later review of the same commit runs the compiled entry");
    assert.match(String(entryOf()?.entry_reason), /store-hit/);
    assert.equal(JSON.parse(readFileSync(join(f.tree, "observed.json"), "utf8")).bundled, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
