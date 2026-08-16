import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runReview } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";

/**
 * W1-T913 — THE PENDING-POST DEGRADATION ARM, driven rather than asserted from source.
 *
 * `runReview` wraps its `postReviewPending` call in a try whose catch ledgers
 * `review.pending_post.error` and carries on, because legibility is strictly additive: a
 * pending-post hiccup must never abort the review it exists to make visible. That arm looked
 * unreachable — `postReviewStatusGuarded` absorbs a failed POST and returns `{posted:false}`
 * rather than throwing — which is true of the post and NOT of everything around it.
 *
 * `postReviewPending`'s FIRST statement is `readLedgerLines(opts.ledgerPath)`, which guards
 * `existsSync` and wraps `JSON.parse` but not `readFileSync`. A ledger path that EXISTS and
 * cannot be read therefore throws out of `postReviewPending` before the guarded post is reached
 * — no network, no injected poster, and no seam: `ledgerPath` is already a parameter `runReview`
 * takes from every caller.
 *
 * Both directions are pinned here. The healthy control matters as much as the failure: without
 * it, an arm that fired unconditionally would pass the first assertion just as well.
 *
 * Its own file per CLAUDE.md's coverage rule.
 */

const HEAD_SHA = "deadbeefcafe01";
const PR_URL = "https://github.com/acme/remudero/pull/1995";

/** The `gh` the review path shells out to: a REST head-sha read and a diff, nothing else. */
function stubGh(binDir: string): void {
  writeFileSync(
    join(binDir, "gh"),
    `#!/bin/sh
case "$1 $2" in
  "api "*)
    case "$*" in
      *pulls/*) echo '{"number":1,"html_url":"${PR_URL}","updated_at":"t","body":"","head":{"ref":"b","sha":"${HEAD_SHA}"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr view")
    case "$*" in
      *headRefOid*) echo '{"headRefOid":"${HEAD_SHA}"}' ;;
      *state*) echo '{"state":"OPEN"}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") echo "diff --git a/README.md b/README.md" ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
}

/** Drive the real `runReview` once against `ledgerPath`, returning every step it ledgered.
 *  What the review does AFTER the arm is out of scope and deliberately not asserted: an
 *  unreadable ledger breaks every later write too, so "the review carried on" is not something
 *  this fixture can honestly show. A later throw is therefore caught and ignored. */
async function stepsFor(ledgerPath: string): Promise<Array<{ step: string; extra?: Record<string, unknown> }>> {
  const root = mkdtempSync(join(tmpdir(), "rmd-pending-degrade-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-pending-degrade-gh-"));
  const oldPath = process.env.PATH;
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  try {
    writeFileSync(join(root, "settings.json"), "{}", "utf8");
    stubGh(binDir);
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      await runReview({
        owner: "acme",
        repo: "remudero",
        prUrl: PR_URL,
        task: { id: "W1-T913" },
        report: "",
        settingsFile: join(root, "settings.json"),
        config: { claudeBin: "/bin/true", root } as Config,
        log: (step: string, extra?: Record<string, unknown>) => void steps.push({ step, extra }),
        say: () => {},
        account: (r: WorkerResult) => r,
        spawnReviewer: false,
        reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 },
        ledgerPath,
        runId: "REVIEW-PENDING-DEGRADE-1",
      });
    } catch {
      // The review's own later stages are out of scope; the arm has already run or not.
    }
    return steps;
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

test("W1-T913: a pending post that THROWS is ledgered with its cause", async () => {
  // A DIRECTORY at the ledger path: `existsSync` is true, so `readLedgerLines` proceeds to
  // `readFileSync` and gets EISDIR. This is the cheapest real instance of the class the arm's
  // own comment names — a read failure inside the pending post, distinct from the POST failure
  // that `postReviewStatusGuarded` already absorbs into `{posted:false}` without throwing.
  const root = mkdtempSync(join(tmpdir(), "rmd-pending-degrade-ledger-"));
  const unreadable = join(root, "ledger-is-a-directory");
  mkdirSync(unreadable);
  try {
    const steps = await stepsFor(unreadable);

    const arm = steps.find((s) => s.step === "review.pending_post.error");
    assert.ok(arm, `the degradation must be ledgered; steps were ${JSON.stringify(steps)}`);
    // AND IT CARRIES THE REAL CAUSE. A row that fired but recorded nothing usable would be the
    // blind-signal shape this repo has measured elsewhere — the arm's whole value is naming what
    // went wrong, so the message is asserted rather than only its existence.
    assert.match(
      String(arm!.extra?.error ?? ""),
      /EISDIR/,
      `the row must name the failure it caught; got ${JSON.stringify(arm!.extra)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FALSIFIER: a readable ledger path never reaches the arm", async () => {
  // Without this, an arm that fired unconditionally — or a `runReview` that ledgered the step
  // from somewhere else entirely — would satisfy the test above. The same harness, the same
  // stub `gh`, one thing changed: a ledger path that can actually be read.
  const root = mkdtempSync(join(tmpdir(), "rmd-pending-degrade-ok-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const healthy = join(root, "state", "ledger.ndjson");

    const steps = await stepsFor(healthy);

    assert.ok(
      !steps.some((s) => s.step === "review.pending_post.error"),
      `a healthy ledger path must not degrade; steps were ${JSON.stringify(steps)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
