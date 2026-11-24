/**
 * W1-T14628 — after each landed fix-lane push, one PR comment, edited in place, says what the round changed and
 * gives the exact revert command.
 *
 * OBSERVED 2026-11-24: no fix-* or CI-remedy module posted a PR comment. A fix round pushed a commit and recorded it
 * only in the ledger, so a person reading the PR could not see what the round changed or how to undo it. These tests
 * drive the real runFixRung, handed the real comment writer, with `gh` answered by the shared PATH shim and the
 * changed files read by real `git` from a fixture repository.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung } from "#src/cli/commands/fix.js";
import { sweepFixRungDeps } from "#src/cli/commands/sweep.js";
import { fixCommandHost, FixRoundPushError, harnessCommitForShellLessWorker } from "#src/run-task.js";
import { captureCiRemedyComponent, recordCiRemedyExecution, upsertCiRemedyRoundComment } from "#src/lib/ci-remedy-execution.js";
import type { ImportedModuleEvidence } from "#src/lib/prevention-source-evidence.js";
import {
  FIX_ROUND_COMMENT_AUTHOR, FIX_ROUND_COMMENT_MARKER, fixRoundChangedFiles, fixRoundRevertCommand, upsertFixRoundComment,
} from "#src/lib/fix-round-comment.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { Config } from "#src/lib/config.js";
import type { Mount } from "#src/lib/mounts.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { withGhShim, type GhShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const TASK = "W1-T14628X";
const BRANCH = "run-W1-T14628X-1";
const PR_URL = "https://github.com/craigoley/remudero/pull/14628";
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
type Row = Record<string, unknown> & { step: string };
interface StoredComment { id: number; body: string; user: { login: string } }

/** A fixture repository with three heads: the PR's head before the rounds, round 1 (adds src/fix.ts) and round 2
 *  (adds src/a.ts and a path holding a pipe). */
function rounds() {
  const repo = gitRepo({ kind: "w1-t14628-rounds" });
  const commit = (files: string[], message: string) => {
    for (const file of files) {
      mkdirSync(join(repo.dir, "src"), { recursive: true });
      writeFileSync(join(repo.dir, file), `// ${message}\n`);
      repo.git("add", "--", file);
    }
    repo.git("commit", "--quiet", "-m", message);
    return repo.git("rev-parse", "HEAD");
  };
  const prior = repo.git("rev-parse", "HEAD");
  const round1 = commit(["src/fix.ts"], "round 1");
  const round2 = commit(["src/a.ts", "src/b|c.ts"], "round 2");
  /** The worktree sits on the head a round was dispatched on, as a fix worktree does. */
  const at = (sha: string) => { repo.git("checkout", "--quiet", "--detach", sha); return repo.dir; };
  return { dir: repo.dir, at, prior, round1, round2 };
}

/**
 * The PR's conversation as the shared gh shim answers it. The list read prints a file this helper rewrites from the
 * writes the shim recorded, so a second round reads what the first one wrote. The shim logs each call's raw argv, so
 * a multi-line body spans log lines (blank ones dropped); each call starts with `api `.
 */
function prThread(shim: GhShim, initial: StoredComment[] = []) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14628-thread-`));
  const comments = initial.map((c) => ({ ...c }));
  const listFile = join(dir, "comments.json"), postFile = join(dir, "post.json");
  let nextId = 900, applied = 0;
  const save = () => {
    writeFileSync(listFile, JSON.stringify([comments]));
    writeFileSync(postFile, JSON.stringify({ id: nextId }));
  };
  save();
  shim.addRoute({ when: "issues/14628/comments?per_page=100", stdoutFile: listFile });
  shim.addRoute({ when: "--method PATCH", stdout: "{}" });
  shim.addRoute({ when: "--method POST", stdoutFile: postFile });
  const invocations = () => shim.calls().join("\n").split(/\n(?=api )/).filter((call) => call !== "");
  const writes = () => invocations().filter((call) => call.startsWith("api --method "));
  return {
    comments, writes, invocations,
    /** Apply the writes since the last sync, as GitHub would. */
    sync() {
      const all = invocations();
      for (const call of all.slice(applied)) {
        const write = /^api --method (POST|PATCH) (\S+) -f body=([\s\S]*)$/.exec(call);
        if (!write) continue;
        if (write[1] === "POST") comments.push({ id: nextId++, body: write[3]!, user: { login: FIX_ROUND_COMMENT_AUTHOR } });
        else comments.find((c) => write[2]!.endsWith(`/issues/comments/${c.id}`))!.body = write[3]!;
      }
      applied = all.length;
      save();
    },
  };
}

function worker(text: string): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false, provider: "claude",
  } as WorkerResult;
}

function review(headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return { state: "failure", headSha, reviewerOutcome: "failure", testTheater: false, summary: "blocked",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    criteria: [{ claim: "the fix lands", proof: "unit test: the fix lands", met: false, reason: "still blocked", proof_exec: "not_executable" }] };
}

/** One real fix round (W1-T9618's harness) whose worker reports FIXED. `comment` hands it the real writer. */
async function round(opts: {
  worktree: string; dispatchedHead: string; committed: string; comment: boolean;
  push: (wt: string, branch: string, sha?: string, prior?: string) => unknown;
  readRemoteBranchHead?: (wt: string, branch: string) => Promise<string | undefined>;
  ciFailures?: { name: string; logTail: string }[];
}) {
  const rows: Row[] = [];
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14628-`));
  const outcome = await runFixRung({
    taskId: TASK, runId: "DAEMON-14628", task: { id: TASK, title: "the fix lands", files: ["src/fix.ts"] },
    prUrl: PR_URL, branch: BRANCH, worktreePath: opts.worktree,
    initialSessionId: "initial-session", mount: MOUNT, settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review(opts.dispatchedHead),
    ...(opts.ciFailures ? { ciFailures: opts.ciFailures } : {}),
    reviewBase: { owner: "craigoley", repo: "remudero", headCheckoutDir: opts.worktree, reviewerMount: MOUNT },
    deps: {
      spawn: async () => worker("REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(ci): repair the red"),
      waitForCiGreen: async () => "green" as const,
      runReview: async () => review(opts.dispatchedHead),
      fetchPrBody: async () => "REPORT",
      push: opts.push,
      ...(opts.readRemoteBranchHead ? { readRemoteBranchHead: opts.readRemoteBranchHead } : {}),
      ...(opts.comment ? { upsertFixRoundComment } : {}),
      issues: { create: () => "https://github.com/craigoley/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ ts: new Date().toISOString(), task_id: TASK, step, ...extra }); },
      say: () => {}, account: (result) => result,
      worktreeHasUncommittedChanges: () => true,
      harnessCommitForShellLessWorker: (input) => harnessCommitForShellLessWorker(input,
        { commit: () => ({ committed: true, sha: opts.committed, undeclared: [] }), ahead: () => 1 }),
    },
  }, fixCommandHost());
  return { outcome, rows, done: rows.filter((r) => r.step === "fix.done"), steps: (step: string) => rows.filter((r) => r.step === step) };
}

const landedRound = (worktree: string, dispatchedHead: string, committed: string, ciFailures?: { name: string; logTail: string }[]) =>
  round({ worktree, dispatchedHead, committed, comment: true, push: () => {}, readRemoteBranchHead: async () => committed, ciFailures });

test("W1-T14628: a second round edits the one fix-round comment", async () => {
  const heads = rounds();
  await withGhShim([], async (shim) => {
    const thread = prThread(shim);
    const first = await landedRound(heads.at(heads.prior), heads.prior, heads.round1);
    thread.sync();
    assert.equal(first.done[0]!.fix_outcome, "FIXED");
    assert.equal(thread.comments.length, 1, "the first landed round creates the comment");
    assert.equal(first.steps("fix.round_comment")[0]!.action, "created");
    const id = thread.comments[0]!.id;

    const second = await landedRound(heads.at(heads.round1), heads.round1, heads.round2);
    thread.sync();
    assert.equal(second.done[0]!.fix_outcome, "FIXED");
    assert.equal(thread.comments.length, 1, "the second landed round adds no comment");
    const row = second.steps("fix.round_comment")[0]!;
    assert.deepEqual({ action: row.action, comment_id: row.comment_id, pr_number: row.pr_number, pushed_head_sha: row.pushed_head_sha },
      { action: "edited", comment_id: id, pr_number: 14628, pushed_head_sha: heads.round2 });
    assert.equal(thread.writes().length, 2, "one write per landed round");
    assert.ok(thread.writes()[1]!.startsWith(`api --method PATCH repos/craigoley/remudero/issues/comments/${id} `));

    const body = thread.comments[0]!.body;
    assert.ok(body.startsWith(`${FIX_ROUND_COMMENT_MARKER}\n`));
    const newest = body.indexOf(`| \`${heads.round1}\` | \`${heads.round2}\``), older = body.indexOf(`| \`${heads.prior}\` | \`${heads.round1}\``);
    assert.ok(newest > 0 && older > newest, `both rounds are listed, newest first:\n${body}`);

    // The same pushed head again replaces its own row rather than listing it twice.
    await upsertFixRoundComment({ prUrl: PR_URL, branch: BRANCH, cwd: heads.dir,
      round: { site: "rung.strike", priorHead: heads.round1, pushedHead: heads.round2, redChecks: [] } }, () => {});
    thread.sync();
    assert.equal(thread.comments[0]!.body.split(`| \`${heads.round2}\` |`).length - 1, 1);
    assert.equal(thread.comments.length, 1);
  });
});

test("W1-T14628: the comment gives the exact revert command for the newest round", async () => {
  const heads = rounds();
  await withGhShim([], async (shim) => {
    const thread = prThread(shim);
    const logs: Row[] = [];
    const log = (step: string, extra?: Record<string, unknown>) => { logs.push({ step, ...extra }); };
    await upsertFixRoundComment({ prUrl: PR_URL, branch: BRANCH, cwd: heads.dir,
      round: { site: "rung.strike", priorHead: heads.prior, pushedHead: heads.round1, redChecks: ["ci-gate", "coverage"] } }, log);
    thread.sync();
    await upsertFixRoundComment({ prUrl: PR_URL, branch: BRANCH, cwd: heads.dir,
      round: { site: "rung.generator_fix", priorHead: heads.round1, pushedHead: heads.round2, redChecks: [] } }, log);
    thread.sync();
    const body = thread.comments[0]!.body;
    const command = `git fetch origin ${BRANCH} && git checkout ${BRANCH} && git revert --no-edit ${heads.round1}..${heads.round2} && git push origin HEAD:${BRANCH}`;
    assert.equal(fixRoundRevertCommand(BRANCH, heads.round1, heads.round2), command);
    assert.ok(body.includes(`\`\`\`sh\n${command}\n\`\`\``), body);
    assert.ok(!body.includes(`--no-edit ${heads.prior}..${heads.round1}`), "only the newest round carries the revert command");
    assert.ok(body.includes(`| rung.strike | \`${heads.prior}\` | \`${heads.round1}\` | \`src/fix.ts\` | \`ci-gate\`, \`coverage\` |`), body);
    assert.ok(body.includes(`| rung.generator_fix | \`${heads.round1}\` | \`${heads.round2}\` | \`src/a.ts\`, \`src/b\\|c.ts\` | (none) |`), body);
    assert.deepEqual(logs.map((r) => r.action), ["created", "edited"]);
    assert.deepEqual(await fixRoundChangedFiles(heads.dir, heads.prior, heads.round2), ["src/a.ts", "src/b|c.ts", "src/fix.ts"]);

    // A diff that cannot be read still posts the heads and the revert command; the row says so.
    const unreadLogs: Row[] = [];
    const missing = "d4".repeat(20);
    await upsertFixRoundComment({ prUrl: PR_URL, branch: BRANCH, cwd: heads.dir,
      round: { site: "rung.strike", priorHead: heads.round2, pushedHead: missing, redChecks: [] } },
    (step, extra) => { unreadLogs.push({ step, ...extra }); });
    thread.sync();
    assert.ok(thread.comments[0]!.body.includes(`| \`${missing}\` | (unread) |`));
    assert.deepEqual(unreadLogs.map((r) => r.step), ["fix.round_comment_files_unread", "fix.round_comment"]);
  });

  // A CI-remedy round names the remedy component in its site, and its rows join the remedy execution.
  await withGhShim([], async (shim) => {
    const thread = prThread(shim);
    const caller: ImportedModuleEvidence = { state: "observed", source: "module-import-git", path: "src/run-task.ts",
      blob: "b".repeat(40), revision: "a".repeat(40), capturedAt: "1970-01-01T00:00:00.000Z" };
    const component = captureCiRemedyComponent(caller, () => {}, () => {}, () => {}, { ...caller, path: "src/lib/ci-remedy-execution.ts" });
    const execution = recordCiRemedyExecution(component, "DAEMON-14628", { failingChecks: 1, matchedPaths: 0, reachablePaths: 0, ownership: "compared" });
    assert.equal(execution.state, "observed");
    const remedyLogs: Row[] = [];
    const remedyLog = (step: string, extra?: Record<string, unknown>) => { remedyLogs.push({ step, ...extra }); };
    await upsertCiRemedyRoundComment(execution, { prUrl: PR_URL, branch: BRANCH, cwd: heads.dir,
      round: { site: "rung.strike", priorHead: heads.prior, pushedHead: heads.round1, redChecks: ["ci-gate"] } }, remedyLog, upsertFixRoundComment);
    thread.sync();
    assert.ok(thread.comments[0]!.body.includes(`| rung.strike (ci-log-named-source-paths) | \`${heads.prior}\``));
    assert.equal(remedyLogs[0]!.remedy_invocation_id, execution.state === "observed" ? execution.invocationId : undefined);
    await upsertCiRemedyRoundComment({ state: "unavailable", reason: "qualifying-component-execution-not-recorded" }, { prUrl: PR_URL, branch: BRANCH,
      cwd: heads.dir, round: { site: "rung.strike", priorHead: heads.round1, pushedHead: heads.round2, redChecks: [] } }, remedyLog, upsertFixRoundComment);
    thread.sync();
    assert.equal(remedyLogs[1]!.remedy_execution, "qualifying-component-execution-not-recorded");
    assert.equal(remedyLogs[1]!.action, "edited");
  });

  // In the fix round, a strike that answered red CI checks reports through the CI remedy execution.
  await withGhShim([], async (shim) => {
    const thread = prThread(shim);
    const ran = await landedRound(heads.at(heads.prior), heads.prior, heads.round1, [{ name: "lint", logTail: "error: lint failed" }]);
    thread.sync();
    assert.equal(ran.steps("fix.round_comment").length, 1, JSON.stringify(ran.rows.map((r) => r.step)));
    assert.ok(thread.comments[0]!.body.includes(
      `| rung.strike (ci-log-named-source-paths) | \`${heads.prior}\` | \`${heads.round1}\` | \`src/fix.ts\` | \`lint\` |`), thread.comments[0]!.body);
  });
});

test("W1-T14628: a refused push posts no comment and a failed write keeps the round", async () => {
  const heads = rounds();
  await withGhShim([], async (shim) => {
    const thread = prThread(shim);
    // A census-refused push, a failed push, and a push that left the remote on the old head: nothing read or written.
    const refused = await round({ worktree: heads.at(heads.prior), dispatchedHead: heads.prior, committed: heads.round1, comment: true,
      push: () => { throw new FixRoundPushError("census-refused-push", { text: "census refused", censuses: ["c"], offeredBaselines: [] }, "census refused"); },
      readRemoteBranchHead: async () => heads.round1 });
    assert.ok(refused.steps("fix.push_refused").length > 0);
    await round({ worktree: heads.at(heads.prior), dispatchedHead: heads.prior, committed: heads.round1, comment: true,
      push: () => { throw new FixRoundPushError("git-push-failed", undefined, "could not read Username"); } });
    await round({ worktree: heads.at(heads.prior), dispatchedHead: heads.prior, committed: heads.round1, comment: true, push: () => {},
      readRemoteBranchHead: async () => heads.prior });
    assert.equal(thread.invocations().length, 0, "a push that did not land posts nothing");

    // A round handed no writer posts nothing: the comment is a dependency only production wires. The sweep's
    // production fix rounds are handed the real writer, unless their caller handed its own.
    const own = async () => ({ action: "failed" as const, reason: "own" });
    assert.equal(sweepFixRungDeps({}).upsertFixRoundComment, upsertFixRoundComment);
    assert.equal(sweepFixRungDeps({ upsertFixRoundComment: own }).upsertFixRoundComment, own);
    const sweepDeps: { log: typeof own; writeFixCensusSnapshot: typeof own; upsertFixRoundComment?: typeof own } = { log: own, writeFixCensusSnapshot: own };
    assert.deepEqual(Object.keys(sweepFixRungDeps(sweepDeps)).sort(), ["log", "upsertFixRoundComment", "writeFixCensusSnapshot"]);
    const unwired = await round({ worktree: heads.at(heads.prior), dispatchedHead: heads.prior, committed: heads.round1, comment: false,
      push: () => {}, readRemoteBranchHead: async () => heads.round1 });
    assert.equal(unwired.done[0]!.fix_outcome, "FIXED");
    assert.equal(unwired.rows.filter((r) => r.step.startsWith("fix.round_comment")).length, 0);
    assert.equal(thread.invocations().length, 0);

    // A landed round whose comment write fails is still FIXED, and the failure is logged.
    shim.addRoute({ when: "--method POST", stderr: "HTTP 502", exit: 1 });
    const landed = await landedRound(heads.at(heads.prior), heads.prior, heads.round1);
    assert.equal(landed.done[0]!.fix_outcome, "FIXED");
    assert.equal(landed.done[0]!.push_outcome, "landed");
    assert.notEqual(landed.outcome.outcome, "stood_down");
    const failed = landed.steps("fix.round_comment_failed");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0]!.reason), /Command failed: gh api --method POST/);
    assert.equal(failed[0]!.pr_number, 14628);
    assert.equal(landed.steps("fix.round_comment").length, 0);

    // The writer never throws: a non-PR URL and a write that names no id each return failed and log it.
    const logs: Row[] = [];
    const log = (step: string, extra?: Record<string, unknown>) => { logs.push({ step, ...extra }); };
    const round1 = { site: "rung.strike", priorHead: heads.prior, pushedHead: heads.round1, redChecks: [] };
    assert.equal((await upsertFixRoundComment({ prUrl: "not-a-pr", branch: BRANCH, cwd: heads.dir, round: round1 }, log)).action, "failed");
    shim.addRoute({ when: "--method POST", stdout: "{}" });
    assert.equal((await upsertFixRoundComment({ prUrl: PR_URL, branch: BRANCH, cwd: heads.dir, round: round1 }, log)).action, "failed");
    assert.deepEqual(logs.map((r) => r.step), ["fix.round_comment_failed", "fix.round_comment_failed"]);
    assert.match(String(logs[1]!.reason), /no comment id/);
  });
});

test("W1-T14628: a marker comment by another author is left alone", async () => {
  const heads = rounds();
  const foreign = { id: 5, body: `${FIX_ROUND_COMMENT_MARKER}\nsomeone else's table`, user: { login: "someone-else" } };
  const unmarked = { id: 6, body: "a fleet comment with no marker", user: { login: FIX_ROUND_COMMENT_AUTHOR } };
  await withGhShim([], async (shim) => {
    const thread = prThread(shim, [foreign, unmarked]);
    const first = await landedRound(heads.at(heads.prior), heads.prior, heads.round1);
    thread.sync();
    assert.equal(first.steps("fix.round_comment")[0]!.action, "created");
    assert.equal(thread.comments.length, 3, "the fleet creates its own comment beside the foreign one");
    assert.equal(thread.comments[0]!.body, foreign.body, "the foreign marker comment is unchanged");
    assert.equal(thread.comments[1]!.body, unmarked.body, "an unmarked fleet comment is unchanged");
    assert.ok(!thread.writes().some((call) => /\/issues\/comments\/[56] /.test(call)), "neither is ever PATCHed");

    const second = await landedRound(heads.at(heads.round1), heads.round1, heads.round2);
    thread.sync();
    assert.equal(second.steps("fix.round_comment")[0]!.action, "edited");
    assert.equal(second.steps("fix.round_comment")[0]!.comment_id, thread.comments[2]!.id);
    assert.equal(thread.comments[0]!.body, foreign.body);
    assert.equal(thread.comments.length, 3);
  });
});
