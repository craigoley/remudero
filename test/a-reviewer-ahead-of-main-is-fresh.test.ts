import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { checkReviewerCodeFreshness, SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

function history(): { bare: GitRepo; seed: GitRepo; reviewer: GitRepo; dispose: () => void } {
  const bare = gitRepo({ bare: true, kind: "reviewer-ancestry-origin" });
  const seed = gitRepo({ kind: "reviewer-ancestry-seed" });
  seed.addRemote("origin", bare.dir);
  seed.git("push", "--quiet", "origin", "main");
  const reviewer = gitRepo({ cloneFrom: bare.dir, kind: "reviewer-ancestry-head" });
  return { bare, seed, reviewer, dispose: () => { reviewer.cleanup(); seed.cleanup(); bare.cleanup(); } };
}

function commit(repo: GitRepo, path: string, content: string): string {
  mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
  writeFileSync(join(repo.dir, path), content);
  repo.git("add", path);
  repo.git("commit", "--quiet", "-m", `fixture ${path}`);
  return repo.git("rev-parse", "HEAD");
}

test("reviewer ahead of main on review-path code is fresh", () => {
  const h = history();
  try {
    const main = h.seed.git("rev-parse", "HEAD");
    const ahead = commit(h.reviewer, "src/lib/review.ts", "export const reviewOnlyOnPr = true;\n");
    const result = checkReviewerCodeFreshness(h.reviewer.dir, { [SELF_SYNC_GUARD_ENV]: "1" });
    assert.deepEqual(result, { status: "fresh", codeSha: ahead, originMainSha: main, advance: "none" });
  } finally { h.dispose(); }
});

test("reviewer behind material main advance is withheld", () => {
  const h = history();
  try {
    const before = h.reviewer.git("rev-parse", "HEAD");
    const after = commit(h.seed, "src/lib/review.ts", "export const changedReview = true;\n");
    h.seed.git("push", "--quiet", "origin", "main");
    const result = checkReviewerCodeFreshness(h.reviewer.dir, { [SELF_SYNC_GUARD_ENV]: "1" });
    assert.deepEqual(result, { status: "stale", codeSha: before, originMainSha: after, changedPaths: ["src/lib/review.ts"] });
  } finally { h.dispose(); }
});

test("diverged reviewer compares only main-side advance", () => {
  const h = history();
  try {
    commit(h.reviewer, "src/lib/review.ts", "export const prReviewChange = true;\n");
    commit(h.seed, "docs/freshness.md", "main documentation only\n");
    h.seed.git("push", "--quiet", "origin", "main");
    const immaterial = checkReviewerCodeFreshness(h.reviewer.dir, { [SELF_SYNC_GUARD_ENV]: "1" });
    assert.equal(immaterial.status, "fresh", "the PR-only review hunk is not a main advance");
    const mainReview = commit(h.seed, "src/lib/review.ts", "export const mainReviewChange = true;\n");
    h.seed.git("push", "--quiet", "origin", "main");
    const material = checkReviewerCodeFreshness(h.reviewer.dir, { [SELF_SYNC_GUARD_ENV]: "1" });
    assert.equal(material.status, "stale");
    assert.equal(material.originMainSha, mainReview);
  } finally { h.dispose(); }
});

test("unreadable reviewer ancestry withholds verdict", () => {
  const h = history();
  try {
    commit(h.reviewer, "src/lib/review.ts", "export const prReviewChange = true;\n");
    const result = checkReviewerCodeFreshness(h.reviewer.dir, { [SELF_SYNC_GUARD_ENV]: "1" }, {
      git: (args) => {
        if (args[0] === "merge-base") throw new Error("ancestry unavailable");
        return h.reviewer.git(...args);
      },
    });
    assert.equal(result.status, "unreadable");
    if (result.status === "unreadable") assert.match(result.reason, /ancestry unavailable/);

    const emptyBase = checkReviewerCodeFreshness(h.reviewer.dir, { [SELF_SYNC_GUARD_ENV]: "1" }, {
      git: (args) => args[0] === "merge-base" ? "" : h.reviewer.git(...args),
    });
    assert.deepEqual(emptyBase, { status: "unreadable", reason: "could not inspect reviewer code ancestry: empty merge base" });

    const main = commit(h.seed, "docs/freshness.md", "main advance\n");
    h.seed.git("push", "--quiet", "origin", "main");
    const unreadableDiff = checkReviewerCodeFreshness(h.reviewer.dir, { [SELF_SYNC_GUARD_ENV]: "1" }, {
      git: (args) => {
        if (args[0] === "diff") throw new Error("changed files unavailable");
        return h.reviewer.git(...args);
      },
    });
    assert.deepEqual(unreadableDiff, { status: "unreadable", reason: "could not inspect reviewer code advance: Error: changed files unavailable" });

    const oldSha = h.reviewer.git("rev-parse", "HEAD");
    const knownBadDiff = checkReviewerCodeFreshness(h.reviewer.dir, {}, {
      checkServiceFreshness: () => ({ status: "assessed", dirty: false, behind: { oldSha, newSha: main, diffUnreadable: "service diff unavailable" } }),
    });
    assert.equal(knownBadDiff.status, "fresh", "a failed reverse diff does not matter when main-side diff is readable");

    const fork = h.reviewer.git("merge-base", oldSha, main);
    const behindBadDiff = checkReviewerCodeFreshness(h.reviewer.dir, {}, {
      checkServiceFreshness: () => ({ status: "assessed", dirty: false, behind: { oldSha: fork, newSha: main, diffUnreadable: "service diff unavailable" } }),
    });
    assert.deepEqual(behindBadDiff, { status: "unreadable", reason: "could not inspect reviewer code advance: service diff unavailable" });
  } finally { h.dispose(); }
});

test("production freshness paths use merge-base evidence", () => {
  const h = history();
  try {
    commit(h.reviewer, "src/lib/review.ts", "export const prReviewChange = true;\n");
    const guarded = checkReviewerCodeFreshness(h.reviewer.dir, { [SELF_SYNC_GUARD_ENV]: "1" });
    const service = checkReviewerCodeFreshness(h.reviewer.dir, {});
    assert.equal(guarded.status, "fresh");
    assert.equal(service.status, "fresh", "service assessment must not treat an ahead checkout as behind");
  } finally { h.dispose(); }
});
