import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { OpsCatalogApi } from "#src/lib/ops-catalog-source.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { originWithClone } from "#test/helpers/git-repo.js";
import {
  opsReviewCommentBody, opsReviewRecord, opsReviewRecordForHead, opsReviewRecordPath, readOpsReviewRecord, reviewCommand,
  runReview, writeOpsReviewRecord, type OpsReviewRecord, type ReviewCommandHost,
} from "#src/cli/commands/review.js";
import { readLedgerLines } from "#src/lib/status.js";
import type { WorkerResult } from "#src/lib/worker.js";

// Invented fixture task: an ops-catalog task with two claims, one the head meets and one it does not.
const id = "W1-T900581", repository = "fixture-private/ops";
const passClaim = "the ready marker is present", failClaim = "the finished marker is present";
const reason = "the finished marker never appears in the changed file";
const mechanism = "the changed file writes only the ready marker";
const remedy = "write the finished marker beside the ready one";
const catalog = `- id: ${id}
  title: Invented marker fixture
  repo: remudero
  depends_on: []
  type: implement
  priority: 0
  risk: low
  budget_usd: 0.25
  files: [src/marker.ts]
  design: invented design narrative
  acceptance:
    - claim: ${passClaim}
      proof: "grep: READY in src/marker.ts"
    - claim: ${failClaim}
      proof: "grep: FINISHED in src/marker.ts"
`;

function pinnedApi(): OpsCatalogApi {
  const hash = (text: string) => createHash("sha1").update(text).digest("hex");
  const commit = hash(catalog), tree = hash("root"), plan = hash("plan");
  const blob = hash(`blob ${Buffer.byteLength(catalog)}\0${catalog}`), base = `repos/${repository}`;
  return async path => {
    if (path === base) return { id: 42, full_name: repository, default_branch: "main" };
    if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
    assert.equal(path, `${base}/git/blobs/${blob}`);
    return { sha: blob, encoding: "base64", size: Buffer.byteLength(catalog), content: Buffer.from(catalog).toString("base64") };
  };
}

const cleanups: Array<() => void> = [];
after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });

type OpsFailRun = { root: string; head: string; prUrl: string; rows: Array<Record<string, unknown>>; published: string; comment: string };
let opsFail: Promise<OpsFailRun> | undefined;

/** One real `rmd review` of the ops task's failing head, through the real status, comment and evidence writers. */
function reviewOpsFail(): Promise<OpsFailRun> {
  return opsFail ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "rmd-ops-fail-marks-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "repos"));
    const scope = { after: (fn: () => void) => { cleanups.push(fn); } };
    const subject = originWithClone(join(root, "repos", "subject"), { scope: scope as never, seed: {
      "plan/tasks.yaml": "[]\n", "src/marker.ts": "READY\n",
    } }).clone;
    const head = subject.git("rev-parse", "HEAD"), prUrl = "https://github.com/fixture/subject/pull/42";
    mkdirSync(join(root, "state"));
    writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify({ repository, kinds: [] }));
    const view = { number: 42, state: "open", merged: false, html_url: prUrl, body: `Remudero-Task: ${id}`,
      head: { ref: `run-${id}-1`, sha: head }, updated_at: new Date().toISOString() };
    const shim = ghShim([
      { when: "/statuses?", stdout: "[[]]" },
      { when: "pr diff", stdout: "diff --git a/src/marker.ts b/src/marker.ts\n--- /dev/null\n+++ b/src/marker.ts\n@@ -0,0 +1 @@\n+READY\n" },
      { when: "pulls/42", stdout: JSON.stringify(view) },
      { when: "api", stdout: "{}" },
    ]);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
    cleanups.push(() => { rmSync(shim.dir, { recursive: true, force: true }); });
    const finding = JSON.stringify({ criterion: 2, category: "missing", severity: "high", mechanism, remedy,
      anchor: { path: "src/marker.ts", line: 1, kind: "changed" } });
    const host = {
      GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
      reviewWorktreeAsync: { fetch: () => {} }, acceptedReviewAttemptId: () => undefined, liveWorkerRunIds: new Set<string>(),
      reviewWorkerLockId: (runId: string) => runId,
      reviewSubjectGit: (_dir: string, args: string[]) => args[0] === "config" ? "https://github.com/fixture/subject.git" : subject.git(...args),
      readHeadShaRest: () => head, reviewPostedDescription: () => "invented status description", reviewerClockBoundMs: () => 60_000,
    } as unknown as ReviewCommandHost;
    try {
      const code = await reviewCommand(host, "42", ["--repo", "subject"], {
        loadConfig: () => ({ root }) as never,
        resolveOwnerRepo: () => ({ owner: "fixture", repo: "controller" }), fetchView: () => view,
        fetchHead: () => {}, taskLookup: { api: pinnedApi() },
        materialize: () => ({ worktreePath: subject.dir }) as never,
        withMaterialized: async (_path, _repo, body) => body(), buildBaseProof: async () => undefined as never,
        reviewerCodeFreshness: () => ({ status: "unreadable", reason: "fixture has no deployment identity" }),
        readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
        runReview: async args => runReview(host, { ...args, reviewerCodeFreshness: undefined, spawnReviewer: true,
          reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 },
          reviewerSpawnWorker: async () => ({ sessionId: "ops-marks-reviewer",
            text: `REVIEW_VERDICT 1: PASS\nREVIEW_VERDICT 2: FAIL — ${reason}\nREVIEW_FINDING ${finding}`, blocks: [],
            stderr: "", exit: { kind: "exit", code: 0 }, costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [],
            model: "sonnet", effort: "medium", provider: "claude", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            modelUsage: {}, compactionEvents: [], qualitySuspect: false, subtype: "success", isError: false, apiError: false }) as WorkerResult,
          readReviewReuseFacts: () => undefined, disarm: () => "not-armed", arm: () => "ledger-refused" }),
      });
      assert.equal(code, 1, "the ops head fails review");
    } finally {
      process.env.PATH = oldPath;
    }
    const calls = readFileSync(join(shim.dir, "calls.log"), "utf8");
    const comments = [...calls.matchAll(/api -X POST [^\n]*\/reviews -f body=([\s\S]*?) -f event=COMMENT/g)].map(m => m[1]!);
    assert.equal(comments.length, 1, "the real review comment writer ran");
    // Every argument the run handed GitHub — review comments, evidence comments and commit statuses among them.
    return { root, head, prUrl, rows: readLedgerLines(join(root, "state", "ledger.ndjson")), published: calls, comment: comments[0]! };
  })();
}

test("W1-T14581: an ops task fail comment marks each claim pass or fail with claim text only", async () => {
  const run = await reviewOpsFail();
  assert.match(run.comment, /\*\*remudero-review=failure\*\*/);
  assert.ok(run.comment.includes(`- PASS: ${passClaim}`), run.comment);
  assert.ok(run.comment.includes(`- FAIL: ${failClaim}`), run.comment);
  const bullets = run.comment.split("\n").filter(line => line.startsWith("- "));
  assert.deepEqual(bullets, [`- PASS: ${passClaim}`, `- FAIL: ${failClaim}`], "each line is a mark and the claim, nothing else");

  // A proof that reached no conclusion, a claim the verdict never judged, and a holdout are never marked PASS or FAIL.
  const acceptance = [{ claim: "a", proof: "grep: a in x" }, { claim: "b", proof: "grep: b in x" },
    { claim: "c", proof: "grep: c in x" }, { claim: "hidden", proof: "grep: h in x", holdout: true }];
  const body = opsReviewCommentBody("failure", acceptance, [
    { claim: "b", met: false, proof_exec: "inconclusive_load" }, { claim: "a", met: true, proof_exec: "executed_pass" }]);
  assert.deepEqual(body.split("\n").slice(2), ["- PASS: a", "- UNDETERMINED: b", "- UNDETERMINED: c"]);
});

test("W1-T14581: the fix lane reads the host review record for an ops task fail", async () => {
  const run = await reviewOpsFail();
  const posted = run.rows.filter(row => row.step === "review.posted" && row.head_sha === run.head).at(-1);
  assert.equal(typeof posted?.review_record_path, "string", "the ledger row links the head's host record");
  assert.equal(posted!.review_record_path, opsReviewRecordPath(join(run.root, "state"),
    { owner: "fixture", repo: "subject", prNumber: 42, headSha: run.head }));
  const read = opsReviewRecordForHead(run.rows, run.prUrl, run.head);
  assert.equal(read.status, "found");
  const record = (read as { record: OpsReviewRecord }).record;
  assert.equal(record.state, "failure");
  assert.equal(record.task_id, id);
  const failed = record.criteria.find(criterion => criterion.claim === failClaim)!;
  assert.equal(failed.met, false);
  // The floor decided this criterion: its full reason names the proof that failed, which the PR may not show.
  assert.ok(failed.reason.includes("grep: FINISHED in src/marker.ts"), failed.reason);
  assert.equal(failed.proof, "grep: FINISHED in src/marker.ts");
  assert.ok(record.reasons.some(text => text.includes(failed.reason)), "the full criterion reason reaches the record");
  assert.equal(record.findings.length, 1);
  assert.deepEqual({ ...record.findings[0], anchor: { path: record.findings[0]!.anchor.path, line: record.findings[0]!.anchor.line } },
    { criterion_index: 2, category: "missing", severity: "high", mechanism, remedy, anchor: { path: "src/marker.ts", line: 1 } });

  // No link, an older head, a missing file, a torn file and a record for another head are distinct answers.
  assert.deepEqual(opsReviewRecordForHead(run.rows, run.prUrl, "f".repeat(40)), { status: "absent" });
  assert.deepEqual(opsReviewRecordForHead([...run.rows, { ...posted, review_record_path: undefined }], run.prUrl, run.head), { status: "absent" });
  assert.deepEqual(readOpsReviewRecord(join(run.root, "state", "missing.json")), { status: "absent" });
  assert.equal(readOpsReviewRecord(join(run.root, "state")).status, "unreadable", "a directory is not a record");
  assert.equal(readOpsReviewRecord("x", () => "{").status, "unreadable");
  assert.equal(readOpsReviewRecord("x", () => "{}").status, "unreadable");
  const moved = opsReviewRecordForHead(run.rows, run.prUrl, run.head, () => JSON.stringify({ ...record, head_sha: "e".repeat(40) }));
  assert.equal(moved.status, "unreadable");
});

test("W1-T14581: an ops task pr shows no reason or path", async () => {
  const run = await reviewOpsFail();
  const recordPath = String(run.rows.filter(row => row.step === "review.posted").at(-1)?.review_record_path);
  assert.ok(run.published.includes("detailed evidence retained on host"), "the published surface was captured");
  for (const forbidden of [reason, mechanism, remedy, "src/marker.ts", "grep:", "FINISHED", recordPath, "review-records"]) {
    assert.ok(!run.published.includes(forbidden), `an ops PR must not show ${forbidden}`);
  }

  // The writer refuses a segment that could escape the record tree, and reports a failed write rather than throwing.
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-ops-record-"));
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
  const record = opsReviewRecord({ taskId: id, prUrl: run.prUrl, headSha: run.head, state: "failure", decisionDigest: "d",
    criteria: [{ claim: "hidden", proof: "grep: h in x", met: false, reason: "secret", proof_exec: "executed_fail", holdout: true },
      { claim: "seen", proof: "grep: s in x", met: false, reason: "why", proof_exec: "executed_fail", proofFailureOutput: "tail" }],
    reasons: ["why"], findings: [
      { id: "1", lineageKey: "1", criterion: 1, category: "missing", severity: "low", mechanism: "secret", remedy: null,
        anchor: { path: "x", line: 1, kind: "changed", status: "verified", evidenceDigest: "0".repeat(64) } }] });
  assert.deepEqual(record.criteria.map(c => [c.index, c.claim, c.proof_failure_output]), [[2, "seen", "tail"]], "holdouts stay out");
  assert.equal(record.findings.length, 0, "a holdout's findings stay out");
  assert.ok("error" in writeOpsReviewRecord(stateDir, { owner: "..", repo: "r", prNumber: 1, headSha: run.head }, record));
  assert.ok("error" in writeOpsReviewRecord(stateDir, { owner: "o", repo: "r", prNumber: undefined, headSha: run.head }, record));
  writeFileSync(join(stateDir, "review-records"), "not a directory");
  assert.ok("error" in writeOpsReviewRecord(stateDir, { owner: "o", repo: "r", prNumber: 1, headSha: run.head }, record));
  rmSync(join(stateDir, "review-records"));
  const written = writeOpsReviewRecord(stateDir, { owner: "o", repo: "r", prNumber: 1, headSha: run.head }, record);
  assert.ok("path" in written && readOpsReviewRecord(written.path).status === "found");
});
