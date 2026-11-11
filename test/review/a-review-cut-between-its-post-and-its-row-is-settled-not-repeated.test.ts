/**
 * W1-T12251 — A REVIEW CUT BETWEEN ITS POST AND ITS ROW IS SETTLED, NOT REPEATED.
 *
 * A restart drain tells every review still running at its time limit to stop, and the exit does not wait for them.
 * A review in its posting step can end after GitHub has its status and before the ledger has its `review.posted`
 * row. The outbox of W1-T11928 kept a verdict only when the post threw, so the next boot found a status with no
 * row and ran the reviewer again.
 *
 * The fixtures end a real child process at that point with SIGKILL. Every status goes through the real `gh` call of
 * the post path, to the shared `gh` shim on PATH. The calls that the shim records are the statuses that reached GitHub.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { runReview, type ReviewCommandHost } from "#src/cli/commands/review.js";
import { readHeadShaRest } from "#src/lib/arm-auto-merge.js";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import type { Mount } from "#src/lib/mounts.js";
import {
  REVIEW_CONTEXT, REVIEWER_TOKEN_ENV, claimReviewDecision, postReviewPending, postReviewStatus, postReviewStatusGuarded, reviewInputDigest,
  reviewOutboxDir, reviewOutboxEntryPath, type PostReviewStatusGuardedOpts, type PrLifecycleState, type ReviewVerdict,
} from "#src/lib/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TASK = "W1-T17494";
const PR_URL = "https://github.com/o/r/pull/17494";
const HEAD = `f38aea2263e8${"0".repeat(28)}`;
const MOVED_HEAD = `0b5e1d9a77c4${"1".repeat(28)}`;
const BODY = "## Acceptance\n- the verdict survives the end of its process";
const INPUT = reviewInputDigest(HEAD, BODY);
const DECISION = `sha256:${"d".repeat(64)}`;
const DESCRIPTION = "remudero-review: PASS - 3 criteria substantiated, no test theater";
const COMMENT = `**remudero-review=success** — ${DESCRIPTION}`;
const SECRET = "ghs_W1T12251doNotWriteThisToDisk";
const CHILD_RUN = "review-PR17494-cut";

const VERDICT: ReviewVerdict = {
  state: "success",
  criteria: [1, 2, 3].map((n) => ({
    claim: `criterion ${n}`, proof: `grep: criterion ${n} in test/x.test.ts`, met: true, reason: "substantiated",
    proof_exec: "executed_pass" as const,
  })),
  testTheater: false, summary: DESCRIPTION, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
};

const lifecycle = (sha: string): PrLifecycleState => ({ merged: false, closed: false, reviewInputDigest: reviewInputDigest(sha, BODY) });

function terminal(ledgerPath: string, post: PostReviewStatusGuardedOpts["post"]): PostReviewStatusGuardedOpts {
  return {
    owner: "o", repo: "r", sha: HEAD, state: "success", description: DESCRIPTION, verdict: VERDICT, taskId: TASK,
    evidence: "executed", ledgerPath, runId: CHILD_RUN, prUrl: PR_URL, reviewInputDigest: INPUT,
    reviewDecisionDigest: DECISION, outboxBeforePost: true,
    readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
    fetchLifecycle: () => lifecycle(HEAD), post,
  };
}

/** The statuses that reached the shim, in order, read from the `gh` calls it recorded. */
function statusesPosted(calls: readonly string[]): Array<{ sha: string; state: string; description: string }> {
  return calls.flatMap((call) => {
    const post = /-X POST repos\/o\/r\/statuses\/([0-9a-f]+) .*state=(\w+)(?: -f description=(.*))?$/s.exec(call);
    return post ? [{ sha: post[1]!, state: post[2]!, description: post[3] ?? "" }] : [];
  });
}

/** Writes the combined status that the next read gets: the newest status posted for `sha`. */
function showCombinedStatus(path: string, calls: readonly string[], sha: string): void {
  const newest = statusesPosted(calls).filter((status) => status.sha === sha).at(-1);
  writeFileSync(path, JSON.stringify({ statuses: newest
    ? [{ context: REVIEW_CONTEXT, state: newest.state, description: newest.description, created_at: new Date().toISOString() }] : [] }));
}

// ── the child process ─────────────────────────────────────────────────────────────────────────────
// The review claims the input, then posts its verdict through the production post path. Its post step writes a
// marker file and never returns, so the parent can end the process between the post and the row.
async function reviewUntilThePost(dir: string, reachesTheHost: boolean): Promise<void> {
  const ledgerPath = join(dir, "ledger.ndjson");
  setInterval(() => {}, 1000);
  await postReviewPending({
    owner: "o", repo: "r", sha: HEAD, taskId: TASK, runId: CHILD_RUN, ledgerPath, prUrl: PR_URL, reviewInputDigest: INPUT,
    fetchLifecycle: () => lifecycle(HEAD),
  });
  await postReviewStatusGuarded(terminal(ledgerPath, async (o) => {
    if (reachesTheHost) await postReviewStatus(o);
    writeFileSync(join(dir, "in-the-post"), "");
    await new Promise<void>(() => {});
  }));
}

const CHILD_DIR = process.env.RMD_T12251_CHILD_DIR;
if (CHILD_DIR !== undefined) {
  await reviewUntilThePost(CHILD_DIR, process.env.RMD_T12251_REACHES === "1");
}

// ── the parent ────────────────────────────────────────────────────────────────────────────────────

function fixture(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${name}-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  const combined = join(dir, "combined-status.json");
  writeFileSync(combined, JSON.stringify({ statuses: [] }));
  // The shared shim answers a status post with nothing and a combined-status read with the file above.
  const shim: GhShim = ghShim([{ when: "-X POST" }, { when: "/status", stdoutFile: combined }]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  const comments: Array<{ url: string; body: string }> = [];
  const steps = (step: string) => readLedgerLines(ledgerPath).filter((line) => line.step === step);
  const entries = () => (existsSync(reviewOutboxDir(ledgerPath)) ? readdirSync(reviewOutboxDir(ledgerPath)) : []);
  const entry = () => JSON.parse(readFileSync(reviewOutboxEntryPath(ledgerPath, PR_URL, INPUT), "utf8")) as Record<string, unknown>;
  const posted = () => statusesPosted(shim.calls());
  /** The next pass for the pull request, as the review command starts it. It posts and reads through `gh`. */
  const nextPass = (sha = HEAD, runId = "review-next-pass") => {
    showCombinedStatus(combined, shim.calls(), sha);
    return postReviewPending({
      owner: "o", repo: "r", sha, taskId: TASK, runId, ledgerPath, prUrl: PR_URL,
      reviewInputDigest: reviewInputDigest(sha, BODY), fetchLifecycle: () => lifecycle(sha),
      readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
      commentDeps: { fetchNewestReview: () => undefined, postReview: (url, body) => { comments.push({ url, body }); } },
    });
  };
  /** Runs a review in a child process and ends the process with SIGKILL while its post step is open. */
  const cutAtThePost = async (reachesTheHost: boolean): Promise<void> => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
      cwd: REPO_ROOT, stdio: "ignore",
      env: { ...process.env, RMD_T12251_CHILD_DIR: dir, RMD_T12251_REACHES: reachesTheHost ? "1" : "0" },
    });
    const ended = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    for (let waited = 0; waited < 60_000 && !existsSync(join(dir, "in-the-post")); waited += 20) await sleep(20);
    assert.equal(existsSync(join(dir, "in-the-post")), true, "the review in the child process reached its post step");
    child.kill("SIGKILL");
    assert.equal(await ended, "SIGKILL", "the process ended between the post and the row");
  };
  const close = (): void => {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  };
  return { dir, ledgerPath, comments, steps, entries, entry, posted, nextPass, cutAtThePost, close };
}

if (CHILD_DIR === undefined) {
  test("W1-T12251 criterion 1: a review writes its outbox entry before it posts, and the entry holds no credential", async () => {
    const f = fixture("t12251-before");
    const saved = { reviewer: process.env[REVIEWER_TOKEN_ENV], gh: process.env.GH_TOKEN };
    process.env[REVIEWER_TOKEN_ENV] = SECRET;
    process.env.GH_TOKEN = SECRET;
    try {
      let atPost: string | undefined;
      const result = await postReviewStatusGuarded(terminal(f.ledgerPath, async (o) => {
        atPost = readFileSync(reviewOutboxEntryPath(f.ledgerPath, PR_URL, INPUT), "utf8");
        await postReviewStatus(o);
      }));
      assert.equal(result.posted, true);
      assert.ok(atPost !== undefined, "the entry is on disk when the post starts");
      const entry = JSON.parse(atPost) as Record<string, unknown>;
      assert.equal(entry.posting, true);
      assert.equal(entry.state, "success");
      assert.equal(entry.description, DESCRIPTION);
      assert.equal(entry.head_sha, HEAD);
      assert.equal(entry.input_key, INPUT);
      assert.equal(entry.comment_body, COMMENT);
      assert.equal(atPost.includes(SECRET), false, "no credential reaches the outbox");
      assert.deepEqual(Object.keys(entry).sort(), [
        "comment_body", "decision_verdict", "description", "evidence", "head_sha", "input_key", "owner", "posting", "pr_url", "repo",
        "review_decision_digest", "run_id", "state", "task_id", "version", "written_at",
      ]);
      // A caller that does not ask for the entry gets none, as before.
      const plain = fixture("t12251-plain");
      try {
        const { outboxBeforePost: _unused, ...withoutTheEntry } = terminal(plain.ledgerPath, undefined);
        assert.equal((await postReviewStatusGuarded(withoutTheEntry)).posted, true);
        assert.equal(existsSync(reviewOutboxDir(plain.ledgerPath)), false);
      } finally {
        plain.close();
      }
    } finally {
      if (saved.reviewer === undefined) delete process.env[REVIEWER_TOKEN_ENV]; else process.env[REVIEWER_TOKEN_ENV] = saved.reviewer;
      if (saved.gh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.gh;
      f.close();
    }
  });

  test("W1-T12251 criterion 2: the review command keeps the entry until its review.posted row is written, then removes it", async () => {
    // The real review command with a `gh` on PATH that answers from a table. Its status post takes 1 s.
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12251-command-root-`));
    const checkout = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12251-command-head-`));
    const head = "abc1234def5678abc1234def5678abc1234def56";
    const prUrl = "https://github.com/craigoley/remudero-site/pull/7";
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const oldPath = process.env.PATH;
    const oldHome = process.env.HOME;
    const gh = ghShim([
      { when: "state=success", delaySeconds: 1 },
      { when: "/statuses?", stdout: "[[]]" },
      { when: "headRefOid", stdout: `{"headRefOid":"${head}"}` },
      { when: "state", stdout: '{"state":"OPEN"}' },
      { when: "pulls/", stdout: `{"number":1,"html_url":"${prUrl}","updated_at":"t","body":"","head":{"ref":"b","sha":"${head}"}}` },
      { when: "pr diff", stdout: [
        "diff --git a/tests/site-target.test.ts b/tests/site-target.test.ts", "+++ b/tests/site-target.test.ts", "@@",
        "+import { test, expect } from 'vitest';", "+test('the proof runs', () => {", "+  expect(1 + 1).toBe(2);", "+});",
      ].join("\n") },
    ]);
    const seen: Array<{ entries: string[]; rows: number }> = [];
    const watch = setInterval(() => {
      const outbox = reviewOutboxDir(ledgerPath);
      seen.push({ entries: existsSync(outbox) ? readdirSync(outbox).filter((name) => name.endsWith(".json")) : [],
        rows: existsSync(ledgerPath) ? readLedgerLines(ledgerPath).filter((line) => line.step === "review.posted").length : 0 });
    }, 20);
    try {
      mkdirSync(join(root, "state"), { recursive: true });
      mkdirSync(join(checkout, "tests"), { recursive: true });
      writeFileSync(join(root, "settings.json"), "{}", "utf8");
      writeFileSync(join(checkout, "package.json"), '{"type":"module"}\n', "utf8");
      mkdirSync(join(checkout, "node_modules", "vitest"), { recursive: true });
      writeFileSync(join(checkout, "node_modules", "vitest", "vitest.mjs"),
        'process.stdout.write("TAP version 13\\n1..1\\nok 1 - the proof runs\\n");\n', "utf8");
      writeFileSync(join(checkout, "tests", "site-target.test.ts"),
        "import { test, expect } from 'vitest';\ntest('the proof runs', () => {\n  expect(1 + 1).toBe(2);\n});", "utf8");
      process.env.PATH = `${gh.dir}:${oldPath}`;
      process.env.HOME = root;
      // The host carries what the review command takes from its caller. None of it is on the post path.
      const host = {
        attributeWorkerStreamEvent: (event: unknown) => event,
        ledgeredNonDispatchSpawn: (_lane: string, raw: unknown) => raw,
        lintPlanForReview: async () => ({ ran: false, reason: "the fixture changes no plan file" }),
        readHeadShaRest,
        reviewPostedDescription: (posted: ReviewVerdict) => posted.summary,
      } as unknown as ReviewCommandHost;
      const verdict = await runReview(host, {
        owner: "craigoley", repo: "remudero-site", prUrl,
        task: { id: "W1-T3529", acceptance: [{ claim: "the proof runs", proof: "unit test: tests/site-target.test.ts" }],
          files: ["tests/site-target.test.ts"] },
        report: "The body has no proof keywords.",
        settingsFile: join(root, "settings.json"), config: { claudeBin: "/bin/true", root } as Config,
        log: (step, extra = {}) => appendLedger(ledgerPath, { run_id: "REVIEW-T12251", task_id: "W1-T3529", step, ...extra }),
        say: () => {}, account: (r: WorkerResult) => r, spawnReviewer: false,
        reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 } as Mount,
        headCheckoutDir: checkout, ledgerPath, runId: "REVIEW-T12251", disarm: () => "not-armed" as const, arm: () => "armed" as const,
      });
      clearInterval(watch);
      assert.equal(verdict.state, "success");
      const rows = readLedgerLines(ledgerPath).filter((line) => line.step === "review.posted");
      assert.equal(rows.length, 1, "the review wrote its row");
      const held = seen.filter((sample) => sample.entries.length === 1);
      assert.ok(held.length >= 5, `the entry was on disk while the status post ran (${held.length} samples)`);
      assert.ok(held.every((sample) => sample.rows === 0), "the entry is from before the row");
      assert.equal(readdirSync(reviewOutboxDir(ledgerPath)).filter((name) => name.endsWith(".json")).length, 0,
        "after the row the entry is removed");
    } finally {
      clearInterval(watch);
      process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      for (const dir of [root, checkout, gh.dir]) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("W1-T12251 criterion 3: a verdict that reached GitHub before its process ended is settled with one review.posted row and no second post", async () => {
    const f = fixture("t12251-reached");
    try {
      await f.cutAtThePost(true);
      assert.deepEqual(f.posted().map((status) => status.state), ["pending", "success"], "GitHub has the verdict");
      assert.equal(f.steps("review.posted").length, 0, "the ledger has no row for it");
      assert.equal(f.entry().posting, true, "the entry of the dead process is on disk");

      const pass = await f.nextPass();
      assert.equal(pass.outbox, "posted", "the next pass settles the entry and starts no review");
      assert.deepEqual(f.posted().map((status) => status.state), ["pending", "success"], "no second status");
      const rows = f.steps("review.posted");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.state, "success");
      assert.equal(rows[0]!.head_sha, HEAD);
      assert.equal(rows[0]!.review_input_digest, INPUT);
      assert.equal(rows[0]!.outbox_run_id, CHILD_RUN);
      assert.equal(f.steps("review.outbox_posted")[0]?.status, "already_on_github");
      assert.deepEqual(f.comments, [{ url: PR_URL, body: COMMENT }], "one comment");
      assert.deepEqual(f.entries(), [], "the entry is removed");
      assert.equal(f.steps("review.pending_posted").length, 1, "only the dead review claimed the input");

      // The reviewer is not admitted: the decision has its terminal.
      const claim = await claimReviewDecision({ ledgerPath: f.ledgerPath, taskId: TASK, prUrl: PR_URL, digest: DECISION });
      if (claim.kind === "owned") claim.release();
      assert.equal(claim.kind, "replay");
      // A later pass changes nothing.
      await f.nextPass(HEAD, "review-later-pass");
      assert.equal(f.steps("review.posted").length, 1);
      assert.equal(f.posted().length, 2);
      assert.equal(f.comments.length, 1);
    } finally {
      f.close();
    }
  });

  test("W1-T12251 criterion 4: a verdict that did not reach GitHub before its process ended is posted once", async () => {
    const f = fixture("t12251-not-reached");
    try {
      await f.cutAtThePost(false);
      assert.deepEqual(f.posted().map((status) => status.state), ["pending"], "GitHub has only the claim of the dead review");
      assert.equal(f.entry().posting, true);

      const pass = await f.nextPass();
      assert.equal(pass.outbox, "posted");
      const statuses = f.posted();
      assert.deepEqual(statuses.map((status) => status.state), ["pending", "success"], "the verdict is posted once, with no new claim");
      assert.equal(statuses[1]!.description, DESCRIPTION);
      assert.equal(f.steps("review.posted").length, 1);
      assert.equal(f.steps("review.outbox_posted")[0]?.status, undefined);
      assert.deepEqual(f.comments, [{ url: PR_URL, body: COMMENT }]);
      assert.deepEqual(f.entries(), []);
      await f.nextPass(HEAD, "review-later-pass");
      assert.equal(f.posted().length, 2, "a later pass posts nothing more");
      assert.equal(f.steps("review.posted").length, 1);
    } finally {
      f.close();
    }
  });

  test("W1-T12251 criterion 5: an entry for a head that has moved is discarded with a row", async () => {
    const f = fixture("t12251-moved");
    try {
      await f.cutAtThePost(true);
      const before = f.posted().length;
      await f.nextPass(MOVED_HEAD);
      const discarded = f.steps("review.outbox_discarded");
      assert.equal(discarded.length, 1);
      assert.match(String(discarded[0]!.reason), /the head moved/);
      assert.equal(discarded[0]!.head_sha, HEAD);
      assert.equal(discarded[0]!.current_head_sha, MOVED_HEAD);
      assert.deepEqual(f.entries(), [], "the entry is removed");
      assert.equal(f.steps("review.posted").length, 0, "the verdict of the old head gets no row");
      assert.ok(f.posted().slice(before).every((status) => status.state === "pending" && status.sha === MOVED_HEAD),
        "the old verdict is not posted for the new head");
      assert.equal(f.comments.length, 0);
    } finally {
      f.close();
    }
  });

  test("W1-T12251 criterion 6: an entry whose review.posted row is already written is removed, and nothing is posted", async () => {
    const f = fixture("t12251-rowed");
    try {
      // The process ended after it wrote the row and before it removed the entry.
      assert.equal((await postReviewStatusGuarded(terminal(f.ledgerPath, undefined))).posted, true);
      appendFileSync(f.ledgerPath, `${JSON.stringify({ ts: new Date().toISOString(), run_id: CHILD_RUN, task_id: TASK,
        step: "review.posted", context: REVIEW_CONTEXT, state: "success", head_sha: HEAD, pr_url: PR_URL, review_input_digest: INPUT,
        review_decision_digest: DECISION, decision_verdict: VERDICT })}\n`);
      assert.equal(f.entries().length, 1);

      await f.nextPass();
      assert.deepEqual(f.entries(), []);
      assert.match(String(f.steps("review.outbox_discarded")[0]?.reason), /already has its review\.posted row/);
      assert.equal(f.steps("review.posted").length, 1, "no second row");
      assert.equal(f.posted().length, 1, "no second status");
      assert.equal(f.comments.length, 0);
    } finally {
      f.close();
    }
  });
}
