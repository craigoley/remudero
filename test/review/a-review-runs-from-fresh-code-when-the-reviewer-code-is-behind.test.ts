// @census-reads: bin/rmd scripts/build-child-entries.mjs — copied into an executable fixture tree (criterion 7).
/**
 * W1-T12227: a review runs from fresh code when the reviewer code is behind at admission.
 *
 * Every path that starts a review (the sweep's gate, the run child's review, the fix rung's required review and the
 * fresh-tree child itself) reads the reviewer-code freshness ONCE, before any reviewer spend. A stale reading moves the
 * review to a fresh tree at origin/main; no reviewer starts on it in this process. The publication check stays the
 * fail-closed floor, and a verdict it refuses after a finished review is now counted: the target is 0.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { postReviewStatusGuarded, REVIEW_REFUSED_AFTER_FINISHED_REVIEW_STEP } from "#src/lib/review.js";
import { REVIEWER_SHADOW_FLAG } from "#src/lib/reviewer-health.js";
import { decideReviewPath, runDetachedReview, type DetachedWorkSpec, type FreshTreeReview } from "#src/lib/run-child.js";
import type { ReviewerCodeFreshness } from "#src/lib/self-sync.js";
import { readLedgerLines } from "#src/lib/status.js";
import type { StoreBuildResult } from "#src/lib/child-entry-store.js";
import {
  buildFreshTreeReviewRunner, buildRequiredFixReviewRunner, buildReviewerCodeFreshnessGate, gatedDetachedReviewCommand, reviewCommand,
  spawnRmdReviewForFreshTree, type FreshTreeStore, type ReviewRunResult,
} from "#src/run-task.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;
type Stale = Extract<ReviewerCodeFreshness, { status: "stale" }>;

const OLD = "a".repeat(40);
const FIRST_MAIN = "b".repeat(40);
const NEXT_MAIN = "d".repeat(40);
const THIRD_MAIN = "e".repeat(40);
const staleAt = (originMainSha: string): Stale =>
  ({ status: "stale", codeSha: OLD, originMainSha, changedPaths: ["src/lib/review.ts"] });
const FRESH: ReviewerCodeFreshness = { status: "fresh", codeSha: FIRST_MAIN, originMainSha: FIRST_MAIN, advance: "none" };
const UNREADABLE: ReviewerCodeFreshness = { status: "unreadable", reason: "git fetch origin failed: exit 128" };
const PR_URL = "https://github.com/acme/remudero/pull/7";
const FIX_ARGS = { owner: "acme", repo: "remudero", prUrl: PR_URL } as never;

/** A gate over a counting fake reviewer and a recording fresh-tree runner, as the sweep and the run child build it. */
function countingGate(readings: ReviewerCodeFreshness[], freshTree: FreshTreeReview | undefined, path?: "run-child") {
  const rows: Row[] = [];
  const reviewerStarts: Array<Record<string, unknown>> = [];
  let reads = 0;
  const gate = buildReviewerCodeFreshnessGate(
    () => readings[Math.min(reads++, readings.length - 1)]!,
    (step, extra) => { rows.push({ step, ...extra }); },
    async (_pr, _rest, deps) => { reviewerStarts.push(deps as Record<string, unknown>); return 0; },
    freshTree,
    path,
  );
  return { gate, rows, reviewerStarts, reads: () => reads };
}

const recordingFreshTree = (calls: Array<{ pr: string; rest: string[]; sha: string }>, code = 0): FreshTreeReview =>
  async (pr, rest, freshness) => { calls.push({ pr, rest, sha: freshness.originMainSha }); return code; };

test("W1-T12227 criterion 1: buildRequiredFixReviewRunner sends a stale start reading to the fresh tree and starts no reviewer in this process", async () => {
  const freshTreeCalls: Array<{ pr: string; rest: string[]; sha: string }> = [];
  const { gate, rows, reviewerStarts } = countingGate([staleAt(FIRST_MAIN)], recordingFreshTree(freshTreeCalls));
  let inProcess = 0;
  let reads = 0;
  const review = buildRequiredFixReviewRunner(async () => { inProcess++; return {} as never; },
    async () => { reads++; return staleAt(FIRST_MAIN); }, gate, () => "c".repeat(40));
  const result: ReviewRunResult = await review(FIX_ARGS);
  assert.equal(inProcess, 0, "no reviewer starts in this process on a stale reading");
  assert.equal(reviewerStarts.length, 0);
  assert.equal(reads, 1, "the fix review reads the freshness once, at its start");
  assert.deepEqual(freshTreeCalls.map((call) => [call.pr, call.sha]), [["7", FIRST_MAIN]], "the review ran from the fresh tree");
  assert.ok(freshTreeCalls[0]!.rest.includes("--judge-at-own-start"), JSON.stringify(freshTreeCalls[0]!.rest));
  assert.deepEqual(freshTreeCalls[0]!.rest.slice(0, 2), ["--repo", "acme/remudero"]);
  assert.match(String(result.verdictWithheld), /behind origin\/main/, "a withheld result: the fix rung stands down");
  assert.equal(result.headSha, "c".repeat(40));
  assert.equal(result.state, "pending");
  const ran = rows.find((row) => row.step === "review.ran_from_fresh_tree");
  assert.equal(ran?.admission_path, "required-fix", JSON.stringify(rows));
});

test("W1-T12227 criterion 2: runDetachedReview through buildReviewerCodeFreshnessGate starts no reviewer on a stale reading and runs from the fresh tree", async () => {
  const work: DetachedWorkSpec = { kind: "review", prNumber: 7, headSha: "c".repeat(40), inputs: { repo: "acme/remudero" } };
  const ctx = { runId: "review-7", taskId: "PR-7" };
  const freshTreeCalls: Array<{ pr: string; rest: string[]; sha: string }> = [];
  const stale = countingGate([staleAt(FIRST_MAIN)], recordingFreshTree(freshTreeCalls), "run-child");
  await runDetachedReview(work, ctx, (pr, rest, opts) => stale.gate.call(pr, rest, opts));
  assert.equal(stale.reviewerStarts.length, 0, "the run child starts no reviewer on a stale reading");
  assert.deepEqual(freshTreeCalls.map((call) => [call.pr, call.sha]), [["7", FIRST_MAIN]]);
  const ran = stale.rows.find((row) => row.step === "review.ran_from_fresh_tree");
  assert.equal(ran?.admission_path, "run-child", "the row names the path that admitted the review");

  // Production builds the run child's command over that same gate, naming its path, with no I/O until a review runs.
  assert.equal(typeof gatedDetachedReviewCommand(REPO_ROOT, () => {}), "function");

  const fresh = countingGate([FRESH], recordingFreshTree([]), "run-child");
  await runDetachedReview(work, ctx, (pr, rest, opts) => fresh.gate.call(pr, rest, opts));
  assert.equal(fresh.reviewerStarts.length, 1);
  assert.equal(fresh.reviewerStarts[0]!.admissionPath, "run-child");
  assert.deepEqual(fresh.reviewerStarts[0]!.reviewStartFreshness, FRESH);
});

/** Drive `rmd review` as a fresh-tree child would be driven, with GitHub and the reviewer replaced. */
async function childReview(readFreshness: () => ReviewerCodeFreshness, extraArgs: string[] = [],
  deps: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t12227-child-"));
  const exitFile = join(root, "cause");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const posts: string[] = [];
  let pendingPosts = 0;
  let reviewers = 0;
  let reads = 0;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const code = await reviewCommand("6011", ["--repo", "acme/remudero", "--judge-at-own-start", "--exit-cause-file", exitFile, ...extraArgs], {
      fetchView: () => ({
        number: 6011, html_url: "https://github.com/acme/remudero/pull/6011", head: { ref: "fixture", sha: head },
        updated_at: new Date(0).toISOString(), body: "## Acceptance\n- the fixture holds | manual fixture",
      }),
      loadConfig: () => ({ root, claudeBin: "/bin/true" }) as Config,
      fetchHead: () => {},
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "not needed" } }),
      postReviewPending: async () => { pendingPosts++; return { posted: false }; },
      reviewerCodeFreshness: () => { reads++; return readFreshness(); },
      runReview: async (args) => {
        reviewers++;
        const posted = await postReviewStatusGuarded({
          owner: "acme", repo: "remudero", sha: head, state: "success", taskId: "PR-6011", evidence: "no_evidence",
          ledgerPath: args.ledgerPath!, runId: args.runId!,
          reviewerCodeFreshness: await args.reviewerCodeFreshness!(),
          finishedReview: { admissionPath: args.admissionPath ?? "unrecorded", reviewerMs: 1 },
          fetchLifecycle: () => ({ merged: false, closed: false }),
          readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
          post: (o) => { posts.push(o.state); },
        });
        return {
          state: "success", criteria: [{ claim: "the fixture holds", proof: "proof", met: true, reason: "", proof_exec: "not_executable" }],
          testTheater: false, summary: "fixture", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
          headSha: head, reviewerOutcome: "success", ...(posted.posted ? {} : { verdictWithheld: posted.reason }),
        };
      },
      ...deps,
    });
    const cause = existsSync(exitFile) ? readFileSync(exitFile, "utf8").split("\t")[0]!.trim() : undefined;
    return { code, cause, posts, pendingPosts, reviewers, reads, rows: readLedgerLines(ledgerPathFor({ root } as Config)) };
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T12227 criterion 3: a fresh-tree child stale at its own start exits reviewer-stale-at-start before its pending status and reviewer, and the gate tries once more only", async () => {
  const child = await childReview(() => staleAt(FIRST_MAIN));
  assert.equal(child.code, 2);
  assert.equal(child.cause, "reviewer-stale-at-start");
  assert.equal(child.pendingPosts, 0, "no pending status is posted");
  assert.equal(child.reviewers, 0, "no reviewer starts");
  assert.deepEqual(child.posts, []);
  assert.equal(child.rows.some((row) => row.step === "review.post_refused"), false, "nothing reaches the publication check");

  // The gate runs the review one more time, from a tree at the new head of main, and never a third time.
  const trees: string[] = [];
  const staleChild: FreshTreeReview = async (_pr, _rest, freshness, _failure, _entry, onExit) => {
    trees.push(freshness.originMainSha);
    onExit?.({ cause: "reviewer-stale-at-start" });
    return 2;
  };
  const { gate, rows, reviewerStarts } = countingGate([staleAt(FIRST_MAIN), staleAt(NEXT_MAIN), staleAt(THIRD_MAIN)], staleChild);
  assert.equal(await gate.call("7", [], {}), 2);
  assert.deepEqual(trees, [FIRST_MAIN, NEXT_MAIN], "one retry at the new head of main, no third attempt");
  assert.equal(reviewerStarts.length, 0);
  assert.equal(rows.at(-1)?.retried_after, "reviewer-stale-at-start");
});

test("W1-T12227 criterion 3: a shadow review is exempt from the early exit, so calibration cases stay measured", async () => {
  const shadow = await childReview(() => staleAt(FIRST_MAIN), [REVIEWER_SHADOW_FLAG]);
  assert.equal(shadow.reviewers, 1, "the shadow reviewer still judges");
  assert.notEqual(shadow.cause, "reviewer-stale-at-start");
});

test("W1-T12227 criterion 4: when the fresh tree cannot run no reviewer starts and review.skipped_stale_reviewer_code gives the reason", async () => {
  const cannotRun: FreshTreeReview = async (_pr, _rest, _freshness, onFailure) => { onFailure?.("worktree add refused"); return undefined; };
  for (const path of ["sweep", "required-fix"] as const) {
    const { gate, rows, reviewerStarts } = countingGate([staleAt(FIRST_MAIN)], cannotRun);
    let inProcess = 0;
    if (path === "sweep") assert.equal(await gate.call("7", [], {}), 0);
    else {
      const review = buildRequiredFixReviewRunner(async () => { inProcess++; return {} as never; }, () => staleAt(FIRST_MAIN), gate, () => "c".repeat(40));
      assert.ok((await review(FIX_ARGS)).verdictWithheld, "the fix rung stands down");
    }
    assert.equal(reviewerStarts.length + inProcess, 0, `${path}: no reviewer starts on a stale reading`);
    const skipped = rows.find((row) => row.step === "review.skipped_stale_reviewer_code");
    assert.equal(skipped?.fresh_tree, "unavailable", path);
    assert.equal(skipped?.fresh_tree_reason, "worktree add refused", path);
    assert.equal(skipped?.admission_path, path);
  }
  // With no fresh-tree runner at all, the skip stands as today.
  const bare = countingGate([staleAt(FIRST_MAIN)], undefined);
  assert.equal(await bare.gate.call("7", [], {}), 0);
  assert.equal(bare.reviewerStarts.length, 0);
  assert.deepEqual(bare.rows.map((row) => row.step), ["review.skipped_stale_reviewer_code"]);
});

test("W1-T12227 criterion 5: a terminal verdict refused for stale reviewer code after a finished review writes one review.refused_after_finished_review row", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t12227-refused-"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const post = (freshness: ReviewerCodeFreshness, finishedReview?: { admissionPath: string; reviewerMs: number }) =>
    postReviewStatusGuarded({
      owner: "acme", repo: "remudero", sha: "c".repeat(40), state: "failure", taskId: "PR-7", evidence: "no_evidence",
      ledgerPath, runId: "run-1", prUrl: PR_URL, reviewerCodeFreshness: freshness,
      ...(finishedReview === undefined ? {} : { finishedReview }),
      fetchLifecycle: () => ({ merged: false, closed: false }), post: () => assert.fail("a refused verdict never posts"),
    });
  try {
    assert.equal((await post(staleAt(FIRST_MAIN), { admissionPath: "fresh-tree", reviewerMs: 390_000 })).posted, false);
    let rows = readLedgerLines(ledgerPath);
    assert.deepEqual(rows.map((row) => row.step), ["review.post_refused", REVIEW_REFUSED_AFTER_FINISHED_REVIEW_STEP],
      "review.post_refused stays as today, and the defect row follows it");
    const defect = rows[1]!;
    assert.equal(defect.step, "review.refused_after_finished_review");
    assert.equal(defect.pr_url, PR_URL);
    assert.equal(defect.head_sha, "c".repeat(40));
    assert.equal(defect.admission_path, "fresh-tree");
    assert.equal(defect.reviewer_ms, 390_000);
    assert.equal(defect.origin_main_sha, FIRST_MAIN);
    // No finished review (a restore or a reuse post) and an unreadable reading are not this defect.
    await post(staleAt(FIRST_MAIN));
    await post(UNREADABLE, { admissionPath: "sweep", reviewerMs: 5 });
    rows = readLedgerLines(ledgerPath);
    assert.equal(rows.filter((row) => row.step === "review.post_refused").length, 3);
    assert.equal(rows.filter((row) => row.step === REVIEW_REFUSED_AFTER_FINISHED_REVIEW_STEP).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T12227 criterion 5: the review command names the fresh-tree path on the defect row when its just-in-time read is stale", async () => {
  let reads = 0;
  const child = await childReview(() => (reads++ === 0 ? UNREADABLE : staleAt(FIRST_MAIN)));
  assert.equal(child.reviewers, 1, "an unreadable own start reading keeps today's just-in-time read");
  const defect = child.rows.find((row) => row.step === REVIEW_REFUSED_AFTER_FINISHED_REVIEW_STEP);
  assert.equal(defect?.admission_path, "fresh-tree");
  assert.equal(typeof defect?.reviewer_ms, "number");
});

test("W1-T12227 criterion 6: invariant fresh-reading-runs-as-today — a fresh reading at admission runs the review in this process and decides its publication", async () => {
  assert.deepEqual(await decideReviewPath(() => FRESH), { path: "in-process", startFreshness: FRESH });
  assert.deepEqual(await decideReviewPath(() => UNREADABLE), { path: "in-process", startFreshness: UNREADABLE });
  assert.deepEqual(await decideReviewPath(() => staleAt(FIRST_MAIN)), { path: "fresh-tree", freshness: staleAt(FIRST_MAIN) });

  const freshTreeCalls: Array<{ pr: string; rest: string[]; sha: string }> = [];
  const { gate, reviewerStarts } = countingGate([FRESH], recordingFreshTree(freshTreeCalls));
  assert.equal(await gate.call("7", [], {}), 0);
  assert.deepEqual(reviewerStarts.map((deps) => [deps.reviewStartFreshness, deps.admissionPath]), [[FRESH, "sweep"]]);

  let reads = 0;
  let decided: ReviewerCodeFreshness | undefined;
  const review = buildRequiredFixReviewRunner(async (args) => {
    assert.equal(args.admissionPath, "required-fix");
    decided = await args.reviewerCodeFreshness!();
    return { marker: "in-process" } as never;
  }, () => { reads++; return reads === 1 ? FRESH : staleAt(NEXT_MAIN); }, gate, () => assert.fail("a fresh review reads no head here"));
  assert.deepEqual(await review(FIX_ARGS), { marker: "in-process" });
  assert.deepEqual(decided, FRESH, "the start reading decides the publication, although main moved during the review");
  assert.equal(freshTreeCalls.length, 0, "no fresh tree on a fresh reading");

  // The fresh-tree child fresh at its own start publishes, as today.
  const child = await childReview(() => FRESH);
  assert.deepEqual(child.posts, ["success"]);
  assert.equal(child.code, 0);
});

function reviewerFixture() {
  const build = createRequire(import.meta.url)("#scripts/build-child-entries.mjs");
  const root = mkdtempSync(join(tmpdir(), "rmd-t12227-store-"));
  const tree = join(root, `reviewer-${FIRST_MAIN.slice(0, 12)}`);
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
  return { build, root, tree, store: join(root, "store") };
}

test("W1-T12227 criterion 7: a store miss for the shared fresh tree starts one unawaited build for its commit, and a later review of that commit runs the compiled entry", async () => {
  const f = reviewerFixture();
  try {
    const builds: Array<Promise<StoreBuildResult>> = [];
    const storeRows: Row[] = [];
    const fakeBuild = (tree: string): Promise<StoreBuildResult> => {
      const pass = (async (): Promise<StoreBuildResult> => {
        const hash = f.build.sourceHash(tree);
        await f.build.buildChildEntries({ root: tree, outDir: join(f.store, hash), layoutDir: f.build.OUT_DIR });
        return { kind: "built", hash, ms: 1, bytes: 1 };
      })();
      builds.push(pass);
      return pass;
    };
    const env = { ...process.env, NODE_V8_COVERAGE: "" };
    const stores: Array<FreshTreeStore | undefined> = [];
    const runner = buildFreshTreeReviewRunner("/repo", {
      git: () => "", addWorktree: () => {}, inspectExistingWorktree: () => "reusable", prepareWorktree: () => true,
      withWorktreeLease: async (_tree, action) => action(), worktreeRoot: f.root,
      storeLog: (step, extra) => { storeRows.push({ step, ...extra }); },
      spawnReview: (tree, args, failure, _env, entry, store, exit) => {
        stores.push(store);
        return spawnRmdReviewForFreshTree(tree, args, failure, env, entry,
          { ...store, storeRoot: f.store, daemonOwned: true, build: fakeBuild }, exit);
      },
    });
    const entries: string[] = [];
    // The review that missed runs tsx; only the wrapper's entry report is read, which it writes before tsx starts.
    await runner("7", [], { originMainSha: FIRST_MAIN }, undefined, (entry) => { entries.push(`${entry.kind}|${entry.reason}`); });
    assert.match(entries[0]!, /^tsx\|.*store-empty; store-fill-requested$/, "the review that missed runs tsx and asks for a build");
    assert.equal(builds.length, 1, "the miss started one build, and the review did not wait for it");
    assert.equal(existsSync(join(f.tree, "observed.json")) &&
      JSON.parse(readFileSync(join(f.tree, "observed.json"), "utf8")).bundled === true, false);
    await builds[0];
    const code = await runner("7", [], { originMainSha: FIRST_MAIN }, undefined, (entry) => { entries.push(`${entry.kind}|${entry.reason}`); });
    assert.equal(code, 0);
    assert.equal(builds.length, 1, "one build per commit");
    assert.equal(JSON.parse(readFileSync(join(f.tree, "observed.json"), "utf8")).bundled, true, "the later review runs the compiled entry");
    assert.match(entries[1]!, /^bundle\|.*store-hit$/);
    assert.deepEqual(storeRows.filter((row) => row.step === "child_entry.store_build_requested").map((row) => row.source), ["fresh-tree-review"]);
    assert.equal(stores[0]?.fillOnMiss, true, "the shared tree asks for a fill");

    // A per-attempt tree is removed when it settles, so it is never built.
    const perAttempt: Array<FreshTreeStore | undefined> = [];
    const own = buildFreshTreeReviewRunner("/repo", {
      git: () => "", addWorktree: () => {}, inspectExistingWorktree: (_repo, path) => (path.endsWith(FIRST_MAIN.slice(0, 12)) ? "unsafe" : "reusable"),
      prepareWorktree: () => true, withWorktreeLease: async (_tree, action) => action(), removeWorktree: () => {}, worktreeRoot: f.root,
      spawnReview: async (_tree, _args, _failure, _env, _entry, store) => { perAttempt.push(store); return 0; },
    });
    assert.equal(await own("7", [], { originMainSha: FIRST_MAIN }), 0);
    assert.deepEqual(perAttempt, [undefined]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T12227 criterion 7: a store build that cannot be requested leaves the review on its entry and says why", async () => {
  const f = reviewerFixture();
  const originalWrite = process.stderr.write.bind(process.stderr);
  const stderr: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr.push(String(chunk));
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    let entry = "";
    await spawnRmdReviewForFreshTree(f.tree, ["7"], undefined, { ...process.env, NODE_V8_COVERAGE: "" },
      (value) => { entry = `${value.kind}|${value.reason}`; },
      { storeRoot: f.store, fillOnMiss: true, daemonOwned: true, build: () => { throw new Error("build script unavailable"); } });
    assert.match(entry, /^tsx\|.*store-empty$/, "no fill is reported when none was requested");
    assert.ok(stderr.some((line) => /no store build requested for .*build script unavailable/.test(line)), stderr.join(""));
    assert.equal(existsSync(f.store), false, "nothing was built");
  } finally {
    process.stderr.write = originalWrite;
    rmSync(f.root, { recursive: true, force: true });
  }
});
