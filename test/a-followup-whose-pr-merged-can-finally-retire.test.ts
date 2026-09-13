/**
 * test/a-followup-whose-pr-merged-can-finally-retire.test.ts — W1-T3524.
 *
 * `retireSettledFollowups` matched its referent against a set of TASK ids. But a harvested
 * follow-up names whatever the run named, and most runs name a PULL REQUEST: the summary carries
 * `— from PR-3606 (run DAEMON-…, https://github.com/…/pull/3606)`. `merged.has("PR-3606")` is
 * false forever, so those proposals were unretirable BY CONSTRUCTION — the retirement arm ran on
 * every pass and could never see them.
 *
 * MEASURED 2026-09-13 against the live registry: 114 open follow-ups, 62 with a PR referent and 52
 * with a task one. The class had grown 63 → 114 in a few hours while the arm meant to drain it was
 * wired, running, and blind to more than half its population. With the PR arm: 58 retire, and 4 are
 * correctly KEPT because their PR never merged.
 *
 * THE MERGED-PR SET COSTS NO API CALLS, which is the other half of the design. This repo squash-
 * merges, so every landed PR leaves one commit on main whose subject ends `(#<n>)`; one local
 * `git log` yields all 4,160. The registry names 43 distinct PRs, and a per-pass burst of 43 reads
 * is exactly the request RATE GitHub's secondary limit counts. Validated against the API on a
 * 12-PR sample: the 11 it reports merged are present, the one it reports closed-unmerged is absent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  followupOriginatingPr,
  followupOriginatingTaskId,
  retireSettledFollowups,
  type FollowupReferentRead,
} from "../src/lib/retro.js";
import type { Proposal } from "../src/lib/inbox.js";
import { mergedPullRequestNumbers } from "../src/run-task.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeRegistry(initial: Proposal[] = []) {
  let state: Proposal[] = initial;
  return {
    state: () => state,
    updateRegistry: (_path: string, update: (current: Proposal[]) => Proposal[] | null) => {
      const next = update(state);
      if (next !== null) state = next;
      return next;
    },
  };
}

/** A routed follow-up in EXACTLY the shape `routeFollowupsToRegistry` mints, referent and all. */
function followup(referent: string, entry: string): Proposal {
  return {
    id: `followup:${entry}`,
    summary: `follow-up harvest [task]: some harvested thought — from ${referent} (run DAEMON-17, https://github.com/o/r/pull/9)`,
    evidenceAnchors: [],
  };
}

const PR_MERGED = followup("PR-3606", "e1");
const PR_UNMERGED = followup("PR-4012", "e2");
const TASK_MERGED = followup("W1-T9002", "e3");

function read(merged: string[], mergedPrs?: number[]): FollowupReferentRead {
  return { kind: "ok", merged: new Set(merged), ...(mergedPrs ? { mergedPrs: new Set(mergedPrs) } : {}) };
}

test("W1-T3524: a follow-up whose originating PR has merged is finally retired", () => {
  const reg = fakeRegistry([PR_MERGED]);
  const out = retireSettledFollowups(read([], [3606]), { registryPath: "/x", updateRegistry: reg.updateRegistry });
  assert.equal(out.length, 1, "the PR referent must now resolve — it never could before");
  assert.deepEqual(reg.state(), [], "and the registry actually SHRINKS, as the task arm already does");
  assert.match(out[0]!.reason, /originating pull request \(PR-3606\) has merged/);
  assert.match(out[0]!.reason, /FALSE-POSITIVE RISK/, "the stated risk carries over — a merged PR can leave work undone too");
});

test("W1-T3524: a follow-up whose PR did NOT merge is KEPT — the arm is not 'retire anything with a PR ref'", () => {
  const reg = fakeRegistry([PR_UNMERGED]);
  const out = retireSettledFollowups(read([], [3606]), { registryPath: "/x", updateRegistry: reg.updateRegistry });
  assert.deepEqual(out, [], "PR-4012 is closed unmerged; nothing settled it");
  assert.deepEqual(reg.state(), [PR_UNMERGED], "a PR that never landed leaves its follow-up live");
});

test("W1-T3524: with NO mergedPrs supplied the PR arm is silent — no predicate, no opinion", () => {
  const reg = fakeRegistry([PR_MERGED]);
  const out = retireSettledFollowups(read([]), { registryPath: "/x", updateRegistry: reg.updateRegistry });
  assert.deepEqual(out, [], "a caller that cannot observe PR state must not retire on that ignorance");
  assert.deepEqual(reg.state(), [PR_MERGED]);
});

test("W1-T3524: the TASK arm is untouched, and still names a task in its reason", () => {
  const reg = fakeRegistry([TASK_MERGED]);
  const out = retireSettledFollowups(read(["W1-T9002"], [3606]), { registryPath: "/x", updateRegistry: reg.updateRegistry });
  assert.equal(out.length, 1);
  assert.match(out[0]!.reason, /originating task \(W1-T9002\) has merged/, "a task referent must not be described as a pull request");
});

test("W1-T3524: the two readers agree on which token is the referent", () => {
  // followupOriginatingPr only CLASSIFIES the token the task reader already found, so the two can
  // never disagree about which word in the summary is the referent.
  assert.equal(followupOriginatingTaskId(PR_MERGED), "PR-3606");
  assert.equal(followupOriginatingPr(PR_MERGED), 3606);
  assert.equal(followupOriginatingPr(TASK_MERGED), undefined, "a task referent yields no PR number");
  assert.equal(followupOriginatingPr({ id: "adoption:x", summary: "— from PR-1 (run r)", evidenceAnchors: [] }), undefined,
    "a non-followup proposal is never given a referent at all");
});

test("W1-T3524: a mixed registry retires exactly the settled rows and leaves the rest", () => {
  const reg = fakeRegistry([PR_MERGED, PR_UNMERGED, TASK_MERGED]);
  const out = retireSettledFollowups(read(["W1-T9002"], [3606]), { registryPath: "/x", updateRegistry: reg.updateRegistry });
  assert.deepEqual(out.map((o) => o.proposalId).sort(), ["followup:e1", "followup:e3"]);
  assert.deepEqual(reg.state(), [PR_UNMERGED], "only the unmerged-PR row survives");
});

// ── the merged-PR set itself, against a REAL git repo built for the purpose ────────────────────

test("W1-T3524: mergedPullRequestNumbers reads squash subjects, and only the trailing (#n)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-mergedpr-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("commit", "-q", "--allow-empty", "-m", "feat: landed one (#101)");
    git("commit", "-q", "--allow-empty", "-m", "fix: landed two (#102)");
    // A number that is NOT a trailing squash marker must not be harvested: this is the whole
    // reason the pattern is anchored to end-of-subject rather than matched anywhere.
    git("commit", "-q", "--allow-empty", "-m", "chore: mentions (#999) mid-subject, not a merge");
    git("commit", "-q", "--allow-empty", "-m", "docs: no marker at all");
    const merged = mergedPullRequestNumbers(dir, "main");
    assert.deepEqual([...merged].sort((a, b) => a - b), [101, 102]);
    assert.ok(!merged.has(999), "a mid-subject reference is not a merge marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3524: an unreadable base ref FAILS CLOSED to an empty set, never a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-mergedpr-empty-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    // No commits and no such ref: the pass cannot observe merge state, so it must retire NOTHING.
    const merged = mergedPullRequestNumbers(dir, "origin/does-not-exist");
    assert.equal(merged.size, 0);
    const reg = fakeRegistry([PR_MERGED]);
    const out = retireSettledFollowups(
      { kind: "ok", merged: new Set(), mergedPrs: merged },
      { registryPath: "/x", updateRegistry: reg.updateRegistry },
    );
    assert.deepEqual(out, [], "an empty set from an unreadable ref must not read as 'nothing merged, retire freely'");
    assert.deepEqual(reg.state(), [PR_MERGED]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
