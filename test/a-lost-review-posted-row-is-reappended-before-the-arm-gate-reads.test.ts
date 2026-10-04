import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { armAutoMergeDetailed, type ArmDeps } from "../src/lib/arm-auto-merge.js";
import type { Config } from "../src/lib/config.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { reappendLostReviewPosted, runReview } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

// W1-T5516. PR #8887's `review.posted` row was lost to a ledger rotation race on 2026-10-03
// (fixed at the source by W1-T5514). The arm gate (W1-T230) reads ONLY the ledger, so a lost row
// failed it closed and a correct review paid for a second review. `runReview` now re-reads the
// ledger for its own row before the gate reads, and re-appends it when it is gone. The gate keeps
// refusing GitHub's commit status as evidence: that surface is mutable (W1-T230, #449).

const HEAD_SHA = "5516aaaabbbbccccddddeeeeffff000011112222";
const PR_URL = "https://github.com/acme/remudero/pull/8887";
const TASK_ID = "W1-T5516";
// A plan-only diff: W1-T205's carve-out arms a structurally capped filing PR, so the run reaches
// the arm gate without executing a proof.
const DIFF = [
  "diff --git a/plan/tasks.d/W1-T5516.yaml b/plan/tasks.d/W1-T5516.yaml",
  "--- a/plan/tasks.d/W1-T5516.yaml",
  "+++ b/plan/tasks.d/W1-T5516.yaml",
  "@@ -1 +1 @@",
  "-status: queued",
  "+status: queued # noted",
].join("\n");

const CRITERION = { claim: "the shard carries its note", proof: "grep: noted plan/tasks.d/W1-T5516.yaml" };
// One line: the shim `echo`es its stdout, and dash's echo would expand a `\n` inside the JSON.
const BODY = `Acceptance: ${CRITERION.claim} — ${CRITERION.proof} matched`;

interface Run {
  ledger: Array<Record<string, unknown>>;
  gateOutcomes: string[];
  armedPrs: string[];
  ghCallsDuringGate: string[];
  said: string[];
}

/** Drives the real `runReview` against a real ledger file. `dropFirstPosted` loses the first
 *  `review.posted` write the way the rotation race did; the injected arm is the REAL W1-T230 gate
 *  (`armAutoMergeDetailed`), reading that same ledger file, with only the GitHub effectors faked. */
async function driveReview(opts: { dropFirstPosted: boolean; runId: string }): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), "rmd-t5516-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const gh = ghShim([
    { when: "headRefOid", stdout: JSON.stringify({ headRefOid: HEAD_SHA }) },
    { when: "pr diff", stdout: DIFF },
    {
      when: "pulls/",
      stdout: JSON.stringify({ number: 8887, html_url: PR_URL, updated_at: "t", body: BODY, state: "open", head: { ref: `run-${TASK_ID}-1`, sha: HEAD_SHA } }),
    },
    // GitHub's status says SUCCESS throughout. The gate must never consult it.
    { when: "/status", stdout: JSON.stringify({ state: "success", statuses: [{ context: "remudero-review", state: "success" }] }) },
  ]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${oldPath ?? ""}`;
  let dropped = !opts.dropFirstPosted;
  const gateOutcomes: string[] = [];
  const armedPrs: string[] = [];
  const ghCallsDuringGate: string[] = [];
  const said: string[] = [];
  const gate: ArmDeps = {
    headSha: () => HEAD_SHA,
    ledgerLines: () => readLedgerLines(ledgerPath),
    armAuto: (prUrl) => void armedPrs.push(prUrl),
    mergeDirect: () => {
      throw new Error("the fixture never merges directly");
    },
    disableAuto: () => {},
    say: (msg) => void said.push(msg),
  };
  try {
    await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: PR_URL,
      task: { id: TASK_ID, acceptance: [CRITERION] },
      report: BODY,
      settingsFile: join(root, "settings.json"),
      config: { claudeBin: "/bin/true", root } as Config,
      log: (step, extra = {}) => {
        if (step === "review.posted" && !dropped) {
          dropped = true;
          return;
        }
        appendLedger(ledgerPath, { run_id: opts.runId, task_id: TASK_ID, step, lane: "review", ...extra });
      },
      say: (msg) => void said.push(msg),
      account: (r: WorkerResult) => r,
      spawnReviewer: false,
      lintPlanForReviewFn: async () => ({ ran: true as const, label: "fixture", checked: 1, violations: [] }),
      disarm: () => "not-armed" as const,
      arm: (prUrl, taskId) => {
        const before = gh.calls().length;
        const result = armAutoMergeDetailed(prUrl, taskId, gate);
        ghCallsDuringGate.push(...gh.calls().slice(before));
        gateOutcomes.push(result.outcome);
        return result.outcome;
      },
      ledgerPath,
      runId: opts.runId,
    });
    return { ledger: readLedgerLines(ledgerPath), gateOutcomes, armedPrs, ghCallsDuringGate, said };
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(gh.dir, { recursive: true, force: true });
  }
}

test("a review.posted row lost after the status posts is re-appended before the arm gate reads", async () => {
  const run = await driveReview({ dropFirstPosted: true, runId: "RUN-T5516-LOST" });

  const posted = run.ledger.filter((l) => l.step === "review.posted");
  assert.equal(posted.length, 1, `exactly the re-appended row reached the ledger; ledger: ${JSON.stringify(run.ledger)}`);
  assert.equal(posted[0]?.run_id, "RUN-T5516-LOST");
  assert.equal(posted[0]?.head_sha, HEAD_SHA);
  assert.equal(typeof posted[0]?.review_decision_digest, "string");

  const reappended = run.ledger.filter((l) => l.step === "review.posted_reappended");
  assert.equal(reappended.length, 1, "the re-append is ledgered as review.posted_reappended");
  assert.equal(reappended[0]?.run_id, "RUN-T5516-LOST", "it names the run");
  assert.equal(reappended[0]?.head_sha, HEAD_SHA, "it names the head");
  assert.equal(reappended[0]?.pr_url, PR_URL, "it names the PR");
  assert.equal(reappended[0]?.review_decision_digest, posted[0]?.review_decision_digest);

  // ORDER: both rows precede the gate's own outcome row, so the gate read a ledger that held them.
  const steps = run.ledger.map((l) => l.step);
  assert.ok(steps.indexOf("review.posted_reappended") > 0, "the re-append row is present");
  assert.ok(steps.indexOf("automerge.armed") > steps.indexOf("review.posted_reappended"), `the re-append precedes the arm; steps: ${steps.join(",")}`);

  assert.deepEqual(run.gateOutcomes, ["armed"], "the ledger-only gate found the re-appended row and armed");
  assert.deepEqual(run.armedPrs, [PR_URL]);
});

test("the arm gate never reads GitHub's status — it reads the ledger and nothing else", async () => {
  const run = await driveReview({ dropFirstPosted: true, runId: "RUN-T5516-NOSTATUS" });
  assert.deepEqual(run.ghCallsDuringGate, [], "the gate made no gh call at all, so it cannot have read a commit status");

  // And GitHub's SUCCESS status is no substitute for the ledger row: the same gate over a ledger
  // with no `review.posted` refuses, though the shim would answer `success` to any status read.
  const said: string[] = [];
  const refused = armAutoMergeDetailed(PR_URL, TASK_ID, {
    headSha: () => HEAD_SHA,
    ledgerLines: () => run.ledger.filter((l) => l.step !== "review.posted"),
    armAuto: () => assert.fail("a gate without its ledger row must not arm"),
    mergeDirect: () => assert.fail("a gate without its ledger row must not merge"),
    disableAuto: () => {},
    say: (msg) => void said.push(msg),
  });
  assert.equal(refused.outcome, "ledger-refused");
  assert.match(said.join("\n"), /no ledgered review\.posted verdict found/);
});

test("a review.posted row that is present is not re-appended", async () => {
  const run = await driveReview({ dropFirstPosted: false, runId: "RUN-T5516-PRESENT" });
  assert.equal(run.ledger.filter((l) => l.step === "review.posted").length, 1, "no duplicate row");
  assert.equal(run.ledger.filter((l) => l.step === "review.posted_reappended").length, 0);
  assert.deepEqual(run.gateOutcomes, ["armed"]);
});

const ROW = { state: "success", head_sha: HEAD_SHA, review_decision_digest: "sha256:mine" };

function recheck(lines: Array<Record<string, unknown>> | Error) {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const said: string[] = [];
  const outcome = reappendLostReviewPosted(
    {
      ledgerPath: "/nonexistent/ledger.ndjson",
      runId: "RUN-A",
      headSha: HEAD_SHA,
      decisionDigest: "sha256:mine",
      prUrl: PR_URL,
      row: ROW,
      log: (step, extra) => void logged.push({ step, extra }),
      say: (msg) => void said.push(msg),
    },
    () => {
      if (lines instanceof Error) throw lines;
      return lines;
    },
  );
  return { outcome, logged, said };
}

test("only THIS run's row at THIS head and decision counts as present", () => {
  const other = [
    { step: "review.posted", run_id: "RUN-B", head_sha: HEAD_SHA, review_decision_digest: "sha256:mine" },
    { step: "review.posted", run_id: "RUN-A", head_sha: "0".repeat(40), review_decision_digest: "sha256:mine" },
    { step: "review.posted", run_id: "RUN-A", head_sha: HEAD_SHA, review_decision_digest: "sha256:other" },
    { step: "review.post_refused", run_id: "RUN-A", head_sha: HEAD_SHA, review_decision_digest: "sha256:mine" },
  ];
  const missing = recheck(other);
  assert.equal(missing.outcome, "reappended");
  assert.deepEqual(missing.logged.map((l) => l.step), ["review.posted", "review.posted_reappended"]);
  assert.deepEqual(missing.logged[0]?.extra, ROW, "the SAME row is appended again");

  const present = recheck([...other, { step: "review.posted", run_id: "RUN-A", head_sha: HEAD_SHA, review_decision_digest: "sha256:mine" }]);
  assert.equal(present.outcome, "present");
  assert.deepEqual(present.logged, []);
});

test("a re-read that fails appends nothing and names its cause — the gate decides as before", () => {
  const failed = recheck(new Error("EISDIR: illegal operation on a directory"));
  assert.equal(failed.outcome, "unreadable", "a failed re-read is its own outcome, never 'present'");
  assert.deepEqual(failed.logged, [], "nothing is appended on a re-read failure");
  assert.match(failed.said.join("\n"), /EISDIR/, "the cause is carried, not erased");
});
