/**
 * W1-T13426: right after a push the required security-merge-policy status is ERROR
 * `unknown: trusted-exact-head-codeql-result-missing` until CodeQL reports. The CI wait read that as red,
 * so a fix child ended its wait on its own push and then stood down. A status that only waits for CodeQL
 * is pending; a real refusal, another red check and a foreign head behave as before.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import type { CiFailure, RollupCheckEntry } from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ciGateFromRollup, ciGateState, runFixRung, waitForCiGreen } from "#test/helpers/run-task-test.js";

const POLICY = "security-merge-policy";
const REQUIRED = ["ci-gate", POLICY];
const HEAD = "d".repeat(40);
const PR_URL = "https://github.com/craigoley/remudero/pull/13426";

const policy = (state: string, description?: string) =>
  ({ context: POLICY, state, ...(description === undefined ? {} : { description }), startedAt: "2026-11-17T04:43:30Z" });
const MISSING = policy("ERROR", "unknown: trusted-exact-head-codeql-result-missing");
const ANALYSIS_PENDING = policy("ERROR", "unknown: security-analysis-pending");
const SAFE = policy("SUCCESS", "safe: trusted-complete-exact-head-no-new-alerts");
const gate = (status: string, conclusion?: string) =>
  ({ name: "ci-gate", status, ...(conclusion === undefined ? {} : { conclusion }), startedAt: "2026-11-17T04:43:20Z" });

test("W1-T13426 criterion 1: a policy status that waits for CodeQL reads pending, not red", () => {
  for (const waiting of [MISSING, ANALYSIS_PENDING]) {
    assert.equal(ciGateFromRollup([waiting, gate("IN_PROGRESS")], REQUIRED), "pending", waiting.description);
    assert.equal(ciGateFromRollup([waiting, gate("COMPLETED", "SUCCESS")], REQUIRED), "pending", waiting.description);
  }
  assert.equal(ciGateFromRollup([SAFE, gate("COMPLETED", "SUCCESS")], REQUIRED), "green", "the later success still passes");
});

test("W1-T13426 criterion 2: a policy refusal stays red", () => {
  const refusals = [
    policy("FAILURE", "blocked: new-high-or-critical-security-alert"),
    policy("ERROR", "unknown: changed-file-corpus-incomplete"),
    policy("ERROR", "unknown: trusted-exact-head-codeql-result-missing-elsewhere"),
    policy("ERROR"),
    policy("ERROR", "trusted-exact-head-codeql-result-missing"),
  ];
  for (const refusal of refusals) {
    assert.equal(ciGateFromRollup([refusal, gate("COMPLETED", "SUCCESS")], REQUIRED), "red", String(refusal.description));
    assert.equal(ciGateFromRollup([refusal, { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]), "red",
      `${String(refusal.description)} with the required contexts unreadable`);
  }
});

function poller(polls: Array<Record<string, unknown>[]>) {
  let n = 0;
  return {
    count: () => n,
    deps: {
      readJson: async (args: string[]) => {
        const request = args.join(" ");
        if (request.includes("/pulls/13426")) {
          n++;
          return { number: 13426, state: "open", merged: false, merged_at: null, head: { sha: HEAD } };
        }
        const entries = polls[Math.min(n, polls.length) - 1]!;
        if (request.includes("/check-runs")) {
          return { check_runs: entries.filter((e) => "name" in e).map((e) => ({ name: e.name, status: String(e.status).toLowerCase(),
            conclusion: e.conclusion === undefined ? null : String(e.conclusion).toLowerCase() })) };
        }
        if (request.includes("/status")) {
          return { statuses: entries.filter((e) => "context" in e).map((e) => ({ context: e.context, state: String(e.state).toLowerCase(),
            description: e.description, created_at: e.startedAt })) };
        }
        throw new Error(`unexpected REST request: ${request}`);
      },
      sleep: async () => {},
      requiredContexts: () => REQUIRED,
    },
  };
}

test("W1-T13426 criterion 3: a policy status that waits for CodeQL is never green", async () => {
  assert.equal(ciGateFromRollup([MISSING, gate("COMPLETED", "SUCCESS")], REQUIRED), "pending");
  assert.equal(ciGateFromRollup([MISSING, { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]), "pending",
    "the unreadable-required fallback does not read green either");
  const p = poller([[MISSING, gate("COMPLETED", "SUCCESS")]]);
  const outcome = await waitForCiGreen(PR_URL, () => {}, 0, p.deps as never);
  assert.equal(ciGateState(outcome), "timeout");
  assert.ok(typeof outcome !== "string" && outcome.state === "timeout");
  assert.ok((outcome as { checks?: string[] }).checks?.includes(POLICY), "the policy status is named as pending");
  assert.ok(p.count() >= 5, "the wait polled the whole stall window");
});

test("W1-T13426 criterion 4: another red check still ends the wait", async () => {
  const rollup = [MISSING, gate("COMPLETED", "FAILURE")];
  assert.equal(ciGateFromRollup(rollup, REQUIRED), "red");
  const p = poller([rollup]);
  const outcome = await waitForCiGreen(PR_URL, () => {}, 0, p.deps as never);
  assert.deepEqual(outcome, { state: "red", sha: HEAD, checks: ["ci-gate"], checkCount: 1 });
  assert.equal(p.count(), 1, "the wait ends at that poll");
});

test("W1-T13426 criterion 5: the wait reads the checks that follow the policy status", async () => {
  const green = poller([[MISSING, gate("IN_PROGRESS")], [SAFE, gate("COMPLETED", "SUCCESS")]]);
  assert.deepEqual(await waitForCiGreen(PR_URL, () => {}, 0, green.deps as never), { state: "green", sha: HEAD });
  assert.equal(green.count(), 2, "green is read at the second poll, not the first");

  const red = poller([[MISSING, gate("IN_PROGRESS")], [MISSING, gate("COMPLETED", "FAILURE")]]);
  assert.deepEqual(await waitForCiGreen(PR_URL, () => {}, 0, red.deps as never),
    { state: "red", sha: HEAD, checks: ["ci-gate"], checkCount: 1 });
  assert.equal(red.count(), 2, "red is read at the second poll, not the first");
});

// ── the rung: a published head the round did not make ─────────────────────────────────────────────

const TASK = "W1-T13426X";
const BRANCH = `run-${TASK}-1794931694000`;
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
const RED: RollupCheckEntry[] = [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
type Row = { step: string } & Record<string, unknown>;

function worker(): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 0, numTurns: 1, text: "", blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: mount.model, effort: mount.effort,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false,
  };
}

async function foreignHeadRound(publishedFrom: (source: ReturnType<typeof gitRepo>) => string) {
  const source = gitRepo({ kind: "t13426-source" });
  const before = source.git("rev-parse", "HEAD");
  const clone = gitRepo({ kind: "t13426-round", cloneFrom: source.dir });
  clone.git("commit", "--quiet", "--allow-empty", "-m", "the round's own merge of main");
  const published = publishedFrom(source);
  const rows: Row[] = [];
  const prompts: string[] = [];
  const review = { state: "failure" as const, criteria: [], testTheater: false, summary: "sweep-reconstructed: required checks red",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: before, reviewerOutcome: "sweep-reconstructed-ci-log" };
  try {
    const outcome = await runFixRung({
      taskId: TASK, runId: "DAEMON-T13426", task: { id: TASK, title: "foreign head" }, prUrl: PR_URL, branch: BRANCH,
      worktreePath: clone.dir, initialSessionId: "implement-session", mount, settingsFile: join(clone.dir, "settings.json"),
      config: { root: clone.dir } as Config, budgetUsd: 5, strikeCap: 1, initialReview: review,
      ...{ requiredContexts: ["ci"] },
      ciFailures: [{ name: "ci", logTail: "failure read at the snapshot head" }],
      reviewBase: { owner: "o", repo: "fixture", headCheckoutDir: clone.dir, reviewerMount: mount },
      escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
      deps: {
        spawn: async (args) => { prompts.push(String(args.prompt)); return worker(); },
        harnessCommitForShellLessWorker: () => 1, commitsAhead: () => 1, worktreeHasUncommittedChanges: () => false,
        readLiveState: async () => ({ ok: true, state: "OPEN" }),
        readRemoteBranchHead: async () => published,
        readCiRollup: async () => RED,
        waitForCiGreen: async () => ({ state: "green", sha: "fixed-head" }),
        fetchCiFailures: async (): Promise<CiFailure[]> => [{ name: "ci", logTail: "failure read at the foreign head" }],
        runReview: async () => ({ ...review, state: "success", headSha: "fixed-head" }),
        fetchPrBody: async () => `## Summary\n\nfixture\n\nRemudero-Task: ${TASK}\n`,
        push: () => {},
        issues: { create: () => "https://github.com/o/fixture/issues/1", listOpen: () => [], comment: () => {} },
        ledgerPath: join(clone.dir, "ledger.ndjson"), ledgerLines: () => rows,
        log: (step, extra) => { rows.push({ step, ...extra }); }, say: () => {}, account: (r) => r,
      },
    });
    return { outcome, rows, prompts, before, published };
  } finally {
    clone.cleanup();
    source.cleanup();
  }
}

test("W1-T13426 criterion 6: a foreign published head still stands the fix round down", async () => {
  const handPush = (source: ReturnType<typeof gitRepo>) => {
    source.git("commit", "--quiet", "--allow-empty", "-m", "a hand push");
    return source.git("rev-parse", "HEAD");
  };
  const rewritten = (source: ReturnType<typeof gitRepo>) => {
    source.git("commit", "--quiet", "--amend", "--allow-empty", "-m", "a move that rewrote the snapshot");
    return source.git("rev-parse", "HEAD");
  };
  for (const [name, move] of [["hand push", handPush], ["rewritten history", rewritten]] as const) {
    const r = await foreignHeadRound(move);
    assert.notEqual(r.published, r.before, `${name}: the published head moved`);
    assert.equal(r.outcome.outcome, "stood_down", `${name}: the round stands down`);
    assert.equal(r.prompts.length, 0, `${name}: no worker starts`);
    assert.equal(r.rows.filter((row) => row.step === "fix.evidence_head_adopted").length, 0);
    assert.deepEqual(r.rows.filter((row) => row.step === "fix.stood_down").map((row) => [row.site, row.current_head_sha]),
      [["rung.evidence_head", r.published]], name);
  }
});
