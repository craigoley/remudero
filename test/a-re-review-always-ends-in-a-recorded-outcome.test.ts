import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { gitRepo } from "./helpers/git-repo.js";

import type { Config } from "../src/lib/config.js";
import { postReviewStatusGuarded } from "../src/lib/review.js";
import { reviewAttemptsForInput, reviewCommand, type ReviewRunResult } from "../src/run-task.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const CONTROLLER_HEAD = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

/** Seeds the managed checkout `<root>/repos/portal` from the shared git fixture (test/helpers). */
function seedTarget(root: string): string {
  const fixture = gitRepo({ kind: "review-confirmed" });
  const repoDir = fixture.dir;
  mkdirSync(join(repoDir, "plan", "tasks.d"), { recursive: true });
  fixture.addRemote("origin", "https://github.com/acme/portal.git");
  writeFileSync(
    join(repoDir, "plan", "tasks.yaml"),
    [
      "- id: W1-TARGET", "  title: t", "  repo: portal", "  type: implement", "  depends_on: []",
      "  verify: auto", "  risk: high", "  budget_usd: 12", "  status: queued", "  attempts: 0",
      "  acceptance:", '    - claim: "c"', '      proof: "grep: x in src/app.ts"',
    ].join("\n") + "\n",
  );
  writeFileSync(join(repoDir, "plan", "tasks.d", ".gitkeep"), "");
  fixture.git("add", "-A");
  fixture.git("commit", "--quiet", "-m", "seed");
  const head = fixture.git("rev-parse", "HEAD");
  // reviewCommand resolves the target at `<root>/repos/<repo>` and requires a real directory there.
  mkdirSync(join(root, "repos"), { recursive: true });
  renameSync(repoDir, join(root, "repos", "portal"));
  return head;
}

function verdict(head: string): ReviewRunResult {
  return {
    state: "success", headSha: head, reviewerOutcome: "test", keywordOnly: false, criteria: [],
    testTheater: false, summary: "test verdict", floorDegraded: false, capped: false, planOnly: false,
  };
}

test("a replayed decision whose live status already matches writes review.posted for the new input digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-confirmed-"));
  try {
    const head = seedTarget(root);
    const code = await reviewCommand("8", ["--repo", "acme/portal"], {
      enforceReviewSubjectCheckout: true,
      fetchView: (args) => {
        if (args[1]?.endsWith(`/commits/${head}/status`)) return { statuses: [{ context: "remudero-review", state: "success" }] };
        return {
          body: "Remudero-Task: W1-TARGET",
          html_url: "https://github.com/acme/portal/pull/8",
          head: { ref: "run-W1-TARGET-1789243954858", sha: head },
          updated_at: new Date(0).toISOString(),
          number: 8,
        };
      },
      loadConfig: () => ({ root, installRoot: REPO_ROOT }) as Config,
      fetchHead: () => {},
      postReviewPending: async () => ({ posted: false }) as never,
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "skip worktree" } }) as never,
      runReview: (async () => ({ ...verdict(head), decisionDisposition: "replayed", reviewDecisionDigest: "v2:prior" })) as never,
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: CONTROLLER_HEAD, originMainSha: CONTROLLER_HEAD, advance: "none" }),
      postStatus: (async (opts) => {
        assert.equal(opts.fetchCurrentStatus?.(), "success");
        return { posted: false, replayed: true };
      }) as typeof postReviewStatusGuarded,
    });
    assert.equal(code, 0);
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const posted = rows.filter((r) => r.step === "review.posted");
    assert.equal(posted.length, 1, "exactly one completed review row for the judged input");
    assert.equal(posted[0]?.status_confirmed, true);
    assert.equal(posted[0]?.review_decision_digest, "v2:prior");
    const digest = String(posted[0]?.review_input_digest);
    assert.ok(digest.length > 0);
    // The sweep's counter now sees a completed exact-input attempt, so a second pass does not re-run.
    const facts = reviewAttemptsForInput(rows, String(posted[0]?.task_id), String(posted[0]?.pr_url), head, digest);
    assert.equal(facts.attempts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
