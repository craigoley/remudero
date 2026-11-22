import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MATERIAL_ADVANCE_PATHS,
  REVIEW_MATERIAL_ADVANCE_PATHS,
  advanceIsMaterial,
  reviewAdvanceIsMaterial,
  checkReviewerCodeFreshness,
} from "#src/lib/self-sync.js";

// W1-T3735. The reviewer computed PASS and threw it away: 200 `review.post_refused` rows on the
// live fleet, every one `attempted_state: "success"`, `evidence: "executed"`. Cause: the RESTART
// materiality list ("would a different module graph load?") was reused to answer "could this
// verdict have changed?". Any src/ merge invalidated every pending verdict, and main moves faster
// than the daemon can sync — so nothing could post, and nothing merged.

test("an unrelated source merge no longer invalidates a verdict", () => {
  const unrelated = ["src/lib/cash-actuals.ts"];
  assert.equal(advanceIsMaterial(unrelated), true, "it still forces a RESTART — that part is right");
  assert.equal(reviewAdvanceIsMaterial(unrelated), false, "but it cannot change a review verdict");
});

test("a change to the review path DOES still invalidate a verdict", () => {
  // THE LOAD-BEARING HALF. Narrowing is only safe if the paths that decide a verdict still count.
  for (const p of ["src/lib/review.ts", "src/run-task.ts", "src/lib/plan.ts", "src/lib/task-linter.ts", "package.json"]) {
    assert.equal(reviewAdvanceIsMaterial([p]), true, `${p} must remain material to a review`);
  }
});

test("review materiality is a STRICT SUBSET of restart materiality, never a superset", () => {
  // If this ever inverts, something is material to a verdict but not to a restart — which would
  // mean a reviewer trusting code the process would not even reload.
  for (const p of REVIEW_MATERIAL_ADVANCE_PATHS) {
    assert.equal(advanceIsMaterial([p]), true, `${p} must also force a restart`);
  }
  assert.ok(
    REVIEW_MATERIAL_ADVANCE_PATHS.length > 0 && MATERIAL_ADVANCE_PATHS.length > 0,
    "both lists must be non-empty, or the comparison proves nothing",
  );
});

test("it still FAILS TOWARD REFUSING — an unreadable advance is material", () => {
  // Narrowing WHICH paths count must never narrow what "I cannot tell" means.
  assert.equal(reviewAdvanceIsMaterial(undefined), true);
  assert.equal(reviewAdvanceIsMaterial([]), true);
  assert.equal(reviewAdvanceIsMaterial(["   "]), true);
});

test("the freshness check reports FRESH for an immaterial advance, so the verdict can post", () => {
  // End to end through the real function: a behind service whose diff touches nothing on the
  // review path must come back fresh, which is what lets postReviewStatusGuarded publish.
  const freshness = checkReviewerCodeFreshness("/unused", {}, {
    git: (args: string[]) => {
      if (args[0] === "merge-base") return "a".repeat(40);
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
    checkServiceFreshness: () => ({
      status: "loaded",
      behind: { oldSha: "a".repeat(40), newSha: "b".repeat(40), changedPaths: ["src/lib/cash-actuals.ts", "plan/tasks.yaml"] },
    }),
  } as never);
  assert.equal(freshness.status, "fresh");
  assert.equal((freshness as { advance: string }).advance, "immaterial");
});

test("and STALE when the advance really did touch the review path", () => {
  const freshness = checkReviewerCodeFreshness("/unused", {}, {
    git: (args: string[]) => {
      if (args[0] === "merge-base") return "a".repeat(40);
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
    checkServiceFreshness: () => ({
      status: "loaded",
      behind: { oldSha: "a".repeat(40), newSha: "b".repeat(40), changedPaths: ["src/lib/review.ts"] },
    }),
  } as never);
  assert.equal(freshness.status, "stale");
});

/** W1-T12824: a reviewer `git` that serves two blobs of each path and the -U0 diff of src/run-task.ts. */
function servedGit(blobs: Record<string, [string, string]>, runTaskDiff = ""): (args: string[]) => string {
  return (args) => {
    if (args[0] === "merge-base") return "a".repeat(40);
    if (args[0] === "diff") return runTaskDiff;
    const [sha, path] = args[0] === "show" ? args[1].split(":") : [];
    const pair = path === undefined ? undefined : blobs[path];
    if (pair) return sha === "a".repeat(40) ? pair[0] : pair[1];
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

function freshnessOver(changedPaths: string[], git: (args: string[]) => string) {
  return checkReviewerCodeFreshness("/unused", {}, {
    git,
    checkServiceFreshness: () => ({ status: "loaded", behind: { oldSha: "a".repeat(40), newSha: "b".repeat(40), changedPaths } }),
  } as never);
}

test("W1-T12824: the 8b221c208 shape, a comment-only compression of src/lib/task-linter.ts, lets the verdict post", () => {
  const before = "// Proof dialect.\n/**\n * Parses one line.\n */\nexport const parse = (s: string) => s.trim(); // trims\n";
  const after = "/** Proof dialect: parses one line. */\nexport const parse = (s: string) => s.trim();\n";
  const freshness = freshnessOver(["src/lib/task-linter.ts"], servedGit({ "src/lib/task-linter.ts": [before, after] }));
  assert.equal(freshness.status, "fresh");
  const changed = freshnessOver(["src/lib/task-linter.ts"], servedGit({ "src/lib/task-linter.ts": [before, after.replace("trim()", "trimEnd()")] }));
  assert.equal(changed.status, "stale", "a code token change still withholds");
});

test("W1-T12824: the c79f9fd5b shape, an unused name added to a used import line of src/run-task.ts, lets the verdict post", () => {
  const roots = "async function runReview() {\n  return worktreeRemove;\n}\nasync function reviewCommand() {\n  return runReview();\n}\n" +
    "function buildFreshTreeReviewRunner() {}\nfunction spawnRmdReviewForFreshTree() {}\nfunction garden() {\n  return 1;\n}\n";
  const before = `import { worktreeRemove } from "lib/worker.js";\n${roots}`;
  const after = `import { worktreeRemove, worktreeRemoveIfPresent } from "lib/worker.js";\n${roots.replace("return 1;", "return 2;")}`;
  const diff = "@@ -1 +1 @@\n-x\n+y\n@@ -12 +12 @@\n-x\n+y\n";
  assert.equal(freshnessOver(["src/run-task.ts"], servedGit({ "src/run-task.ts": [before, after] }, diff)).status, "fresh");
  const used = after.replace("return worktreeRemove;", "return worktreeRemoveIfPresent;");
  const usedDiff = "@@ -1 +1 @@\n-x\n+y\n@@ -3 +3 @@\n-x\n+y\n";
  assert.equal(freshnessOver(["src/run-task.ts"], servedGit({ "src/run-task.ts": [before, used] }, usedDiff)).status, "stale",
    "a new name the review path uses still withholds");
});

test("W1-T14152 criterion 5: the lease file is not a material path, and the verdict paths still are", () => {
  const listed = new Set<string>(REVIEW_MATERIAL_ADVANCE_PATHS);
  assert.equal(listed.has("src/lib/reviewer-worktree-lease.ts"), false, "the lease decides which tree a child runs in, never a verdict");
  for (const p of ["src/lib/review.ts", "src/run-task.ts", "src/lib/plan.ts", "src/lib/task-linter.ts", "package.json", "package-lock.json"]) {
    assert.ok(listed.has(p), `${p} must stay listed`);
  }
  assert.equal(reviewAdvanceIsMaterial(["src/lib/reviewer-worktree-lease.ts"]), false);
  assert.equal(reviewAdvanceIsMaterial(["src/lib/reviewer-worktree-lease.ts", "src/lib/review.ts"]), true);
});
