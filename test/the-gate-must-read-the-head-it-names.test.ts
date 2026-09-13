/**
 * test/the-gate-must-read-the-head-it-names.test.ts — W1-T3514.
 *
 * head-identity-gate OFFERS TWO CONFORMING FORMS AND ONE OF THEM COULD NEVER PASS. Its own refusal
 * names them: (1) a `run-<taskId>-<epochMs>` branch, or (2) "an anchored `Remudero-Task: <id>`
 * trailer on the head commit (either is enough)". Form 2 was unreachable in CI.
 *
 * `actions/checkout` with no `ref:` on a `pull_request` event checks out GitHub's SYNTHETIC MERGE
 * COMMIT, not the head. The gate then runs `git log -1 --format=%B` against that, reads
 * "Merge <head> into <base>", finds no trailer, and refuses. Captured verbatim from the job log on
 * PR #5369, whose head commit DID carry `Remudero-Task: W1-T3511`:
 *
 *   HEAD is now at d9e2382 Merge 09ac04e3484... into 721952180...
 *   head-identity-gate: REFUSED — ... carries no valid Remudero-Task trailer
 *
 * This is worse than a gate that simply lacks the feature: the fleet's own repair rung reads that
 * refusal, adds the trailer commit it asks for, and loses again — the advice is unfollowable, so a
 * PR on a non-`run-*` branch is unmergeable by any route the gate itself describes.
 *
 * Two assertions, because the defect has two halves:
 *   (i)  THE BEHAVIOUR — a merge commit's message defeats the trailer form even when the head has
 *        one. This is the pure unit fact that makes the pin load-bearing rather than cosmetic.
 *   (ii) THE WIRING — the workflow pins `ref: github.event.pull_request.head.sha`, so the gate
 *        actually reads the commit it names. Without (ii), (i) is what CI does every time.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "head-identity-gate.yml");
const SCRIPT = join(REPO_ROOT, "scripts", "head-identity-gate.mjs");

// `scripts/**` sits outside tsconfig's `include`, so a static import from the `.mjs` gate is a
// TS7016. Load the production module dynamically, matching the older head-identity suite.
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  evaluateHeadIdentityGate: (input: { headCommitMessage: string; headRef: string | undefined }) => {
    ok: boolean;
    message: string;
  };
};
const { evaluateHeadIdentityGate } = mod;

/** What a head commit built for a filed task actually looks like — the form the gate advertises. */
const HEAD_WITH_TRAILER = "fix(inbox): something real\n\nbody prose\n\nRemudero-Task: W1-T3511\n";
/** What `actions/checkout` leaves in the worktree when no `ref:` is pinned. */
const SYNTHETIC_MERGE_COMMIT = "Merge 09ac04e3484acd0d25c32eac354506aeac44e575 into 721952180f47167f\n";
/** A branch name that does NOT match form 1, so form 2 is the only thing under test. */
const NON_CONFORMING_REF = "fix/one-resolver-one-verdict";

test("W1-T3514: the trailer form passes when the gate reads the HEAD commit", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: HEAD_WITH_TRAILER,
    headRef: NON_CONFORMING_REF,
  });
  assert.equal(result.ok, true, "a non-conforming branch name is fine when the trailer is present");
});

test("W1-T3514: the SAME head is refused when the gate reads the synthetic merge commit instead", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: SYNTHETIC_MERGE_COMMIT,
    headRef: NON_CONFORMING_REF,
  });
  assert.equal(
    result.ok,
    false,
    "the merge commit carries no trailer, so form 2 is unreachable — this is what CI did on #5369",
  );
  assert.match(
    result.message,
    /Remudero-Task/,
    "and the refusal still advises the trailer the checkout made it impossible to see",
  );
});

test("W1-T3514: the workflow pins the checkout to the PR head sha, so the gate reads what it names", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");
  assert.match(
    yaml,
    /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/,
    "without this pin actions/checkout hands the gate the merge commit — see this file's header",
  );
  const checkoutIndex = yaml.indexOf("actions/checkout@");
  const refIndex = yaml.search(/ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha/);
  assert.ok(checkoutIndex >= 0, "the workflow still checks out a tree");
  assert.ok(
    refIndex > checkoutIndex,
    "the pin must belong to the checkout step's own `with:`, not to some later step",
  );
});

test("W1-T3514: the branch-name form still passes on its own, with no trailer anywhere", () => {
  const result = evaluateHeadIdentityGate({
    headCommitMessage: "chore: no trailer here at all\n",
    headRef: "run-W1-T3514-1789300000000",
  });
  assert.equal(result.ok, true, "form 1 is untouched — this change adds no new requirement");
});
