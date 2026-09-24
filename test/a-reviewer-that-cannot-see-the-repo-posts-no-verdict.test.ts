import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { postReviewStatusGuarded } from "../src/lib/review.js";
import { reviewCommand } from "../src/run-task.js";

// W1-T4410 — on 2026-09-23 an operator session ran `rmd review 1706 --repo remudero-console` on a Mac with no
// managed console checkout, and the refusal posted `remudero-review: FAIL — review-subject-missing` on the PR
// head. A refusal about the reviewer's machine judged nothing about the change, yet only a new commit cleared it.

const REPO_ROOT = join(import.meta.dirname, "..");

function restPull(head: string) {
  return {
    body: "Remudero-Task: W1-TPORTAL",
    html_url: "https://github.com/acme/portal/pull/8",
    head: { ref: "run-W1-TPORTAL-1790000000000", sha: head },
    updated_at: new Date(0).toISOString(),
    number: 8,
  };
}

type Posted = { state: string; description?: string };
const recordingPostStatus = (posted: Posted[]) =>
  (async (opts: Parameters<typeof postReviewStatusGuarded>[0]) => {
    posted.push({ state: opts.state, description: opts.description });
    return { posted: true };
  }) as never;

async function reviewWithoutCheckout(posted: Posted[]): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4410-missing-"));
  try {
    return await reviewCommand("8", ["--repo", "acme/portal"], {
      enforceReviewSubjectCheckout: true,
      fetchView: () => restPull("a".repeat(40)),
      loadConfig: () => ({ root, installRoot: REPO_ROOT }) as Config,
      postStatus: recordingPostStatus(posted),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a review whose target repo has no managed checkout posts no commit status and exits non-zero", async () => {
  const posted: Posted[] = [];
  const code = await reviewWithoutCheckout(posted);
  assert.equal(code, 1);
  assert.deepEqual(posted, [], "a refusal about the reviewer's machine never marks the PR");
});

test("the refusal tells the operator where to run the review instead", async () => {
  const posted: Posted[] = [];
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  try {
    await reviewWithoutCheckout(posted);
  } finally {
    console.error = original;
  }
  const refusal = errors.find((e) => e.startsWith("rmd review: REFUSED"));
  assert.ok(refusal, `a REFUSED line is printed (saw: ${JSON.stringify(errors)})`);
  assert.match(refusal!, /No status was posted on the PR/);
  assert.match(refusal!, /run the review where acme\/portal is checked out/);
});
