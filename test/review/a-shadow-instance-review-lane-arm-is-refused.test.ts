import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import type { WorkerResult } from "#src/lib/worker.js";
import * as runTask from "#src/run-task.js";
import { ghShim } from "#test/helpers/gh-shim.js";

// W1-T13698. A shadow instance reviews and posts exactly as a live one does, but it arms and merges
// nothing on ANY lane: the review lane's post-verdict arm is refused like the sweep's.

const HEAD_SHA = "13698aaabbbbccccddddeeeeffff000011112222";
const PR_URL = "https://github.com/acme/remudero/pull/13698";
const TASK_ID = "W1-T13698";
const DIFF = [
  "diff --git a/plan/tasks.d/W1-T13698.yaml b/plan/tasks.d/W1-T13698.yaml",
  "--- a/plan/tasks.d/W1-T13698.yaml",
  "+++ b/plan/tasks.d/W1-T13698.yaml",
  "@@ -1 +1 @@",
  "-status: queued",
  "+status: queued # noted",
].join("\n");
const CRITERION = { claim: "the shard carries its note", proof: "grep: noted plan/tasks.d/W1-T13698.yaml" };
const BODY = `Acceptance: ${CRITERION.claim} — ${CRITERION.proof} matched`;

async function driveReview(repoMode: "shadow" | "live"): Promise<{ ledger: Array<Record<string, unknown>>; armCalls: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-t13698-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const gh = ghShim([
    { when: "/statuses?", stdout: "[[]]" },
    { when: "headRefOid", stdout: JSON.stringify({ headRefOid: HEAD_SHA }) },
    { when: "pr diff", stdout: DIFF },
    {
      when: "pulls/",
      stdout: JSON.stringify({ number: 13698, html_url: PR_URL, updated_at: "t", body: BODY, state: "open", head: { ref: `run-${TASK_ID}-1`, sha: HEAD_SHA } }),
    },
    { when: "/status", stdout: JSON.stringify({ state: "success", statuses: [] }) },
  ]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${oldPath ?? ""}`;
  const armCalls: string[] = [];
  try {
    await runTask.runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: PR_URL,
      task: { id: TASK_ID, acceptance: [CRITERION] },
      report: BODY,
      settingsFile: join(root, "settings.json"),
      config: { claudeBin: "/bin/true", root } as Config,
      log: (step, extra = {}) => appendLedger(ledgerPath, { run_id: "r-13698", task_id: TASK_ID, step, lane: "review", ...extra }),
      say: () => {},
      account: (r: WorkerResult) => r,
      spawnReviewer: false,
      lintPlanForReviewFn: async () => ({ ran: true as const, label: "fixture", checked: 1, violations: [] }),
      disarm: () => "not-armed" as const,
      arm: (prUrl) => {
        armCalls.push(prUrl);
        return "armed" as const;
      },
      repoMode,
      ledgerPath,
      runId: "r-13698",
    });
    return { ledger: readLedgerLines(ledgerPath), armCalls };
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(gh.dir, { recursive: true, force: true });
  }
}

test("a shadow instance's review lane posts its review but never arms: automerge.shadow_refused is ledgered", async () => {
  const run = await driveReview("shadow");
  assert.ok(run.ledger.some((l) => l.step === "review.posted"), "the review is still posted under shadow");
  assert.deepEqual(run.armCalls, [], "the review lane's arm is never invoked under shadow");
  const refused = run.ledger.filter((l) => l.step === "automerge.shadow_refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.pr_url, PR_URL);
  const skipped = run.ledger.find((l) => l.step === "automerge.arm_skipped");
  assert.equal(skipped?.outcome, "shadow-refused");
  assert.ok(!run.ledger.some((l) => l.step === "automerge.armed"));
});

test("a live instance's review lane still arms after a passing verdict", async () => {
  const run = await driveReview("live");
  assert.deepEqual(run.armCalls, [PR_URL]);
  assert.ok(!run.ledger.some((l) => l.step === "automerge.shadow_refused"));
});
