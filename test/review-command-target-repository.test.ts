import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { postReviewStatusGuarded } from "../src/lib/review.js";
import { buildBaseProofDir, reviewCommand, runReview, type BaseProofDir, type ReviewRunResult } from "../src/run-task.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const CONTROLLER_HEAD = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function taskYaml(id: string, claim: string, repo = "portal"): string {
  return [
    `- id: ${id}`,
    `  title: ${id.toLowerCase()}`,
    `  repo: ${repo}`,
    "  type: implement",
    "  depends_on: []",
    "  verify: auto",
    "  risk: high",
    "  budget_usd: 12",
    "  status: queued",
    "  attempts: 0",
    "  acceptance:",
    `    - claim: "${claim}"`,
    "      proof: \"grep: target-only-marker in src/app.ts\"",
  ].join("\n");
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initTargetRepo(root: string, owner = "acme", repo = "portal", taskId = "W1-TARGET"): { repoDir: string; head: string } {
  const repoDir = join(root, "repos", repo);
  mkdirSync(join(repoDir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  git(repoDir, ["init", "--quiet", "-b", "main"]);
  git(repoDir, ["config", "user.email", "review-target@example.invalid"]);
  git(repoDir, ["config", "user.name", "Review Target"]);
  git(repoDir, ["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
  writeFileSync(join(repoDir, "plan", "tasks.yaml"), taskYaml(taskId, "target-only criteria") + "\n");
  writeFileSync(join(repoDir, "plan", "tasks.d", ".gitkeep"), "");
  writeFileSync(join(repoDir, "src", "app.ts"), "export const targetOnly = true;\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "--quiet", "-m", "seed target plan"]);
  return { repoDir, head: git(repoDir, ["rev-parse", "HEAD"]) };
}

function restPull(body: string, head: string, repo = "portal") {
  return {
    body,
    html_url: `https://github.com/acme/${repo}/pull/8`,
    head: { ref: "run-W1-TARGET-1789243954858", sha: head },
    updated_at: new Date(0).toISOString(),
    number: 8,
  };
}

function verdict(head: string): ReviewRunResult {
  return {
    state: "success",
    headSha: head,
    reviewerOutcome: "test",
    keywordOnly: false,
    criteria: [],
    testTheater: false,
    summary: "test verdict",
    floorDegraded: false,
    capped: false,
    planOnly: false,
  };
}

test("target review uses only the target checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-target-root-"));
  try {
    const target = initTargetRepo(root);
    const calls: Record<string, string[]> = { fetchHead: [], materialize: [] };
    let reviewedClaims: string[] = [];

    await reviewCommand("8", ["--repo", "acme/portal"], {
      enforceReviewSubjectCheckout: true,
      fetchView: () => restPull("Remudero-Task: W1-TARGET", target.head),
      loadConfig: () => ({ root }) as Config,
      fetchHead: (repoDir) => calls.fetchHead.push(repoDir),
      postReviewPending: async () => ({ posted: true }) as never,
      materialize: (_config, repoDir) => {
        calls.materialize.push(repoDir);
        return { worktreePath: undefined, failure: { errorClass: "test", message: "skip worktree" } } as never;
      },
      runReview: (async (args: Parameters<typeof runReview>[0]) => {
        reviewedClaims = (args.task.acceptance ?? []).map((c) => c.claim);
        return verdict(target.head);
      }) as never,
    });

    assert.deepEqual(calls.fetchHead, [target.repoDir]);
    assert.deepEqual(calls.materialize, [target.repoDir]);
    assert.deepEqual(reviewedClaims, ["target-only criteria"]);
    assert.ok(!calls.fetchHead.includes(REPO_ROOT), "the controller checkout must not supply target review data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("target proof worktrees use and clean only the target checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-target-worktree-"));
  try {
    const target = initTargetRepo(root);
    const headWorktree = join(root, "worktrees", "head");
    const baseWorktree = join(root, "worktrees", "base");
    const removed: Array<{ repoDir: string; worktreePath: string }> = [];
    let headCheckoutDir: string | undefined;

    await reviewCommand("8", ["--repo", "acme/portal"], {
      enforceReviewSubjectCheckout: true,
      fetchView: () => restPull("Remudero-Task: W1-TARGET", target.head),
      loadConfig: () => ({ root }) as Config,
      fetchHead: () => {},
      postReviewPending: async () => ({ posted: true }) as never,
      materialize: (_config, repoDir) => {
        assert.equal(repoDir, target.repoDir);
        return { worktreePath: headWorktree } as never;
      },
      buildBaseProof: ((_criteria: Parameters<typeof buildBaseProofDir>[0], checkoutDir: string) => {
        headCheckoutDir = checkoutDir;
        return {
          baseCheckoutDir: baseWorktree,
          baseUnreadablePaths: new Set<string>(),
          baseIsCheckout: true,
          addedTestFiles: new Set<string>(),
        } satisfies BaseProofDir;
      }) as never,
      withMaterialized: (async <T>(worktreePath: string | undefined, repoDir: string, body: () => Promise<T>): Promise<T> => {
        try {
          return await body();
        } finally {
          if (worktreePath) removed.push({ repoDir, worktreePath });
        }
      }) as never,
      runReview: (async () => verdict(target.head)) as never,
    });

    assert.equal(headCheckoutDir, headWorktree);
    assert.deepEqual(removed, [
      { repoDir: target.repoDir, worktreePath: headWorktree },
      { repoDir: target.repoDir, worktreePath: baseWorktree },
    ]);
    assert.ok(removed.every((r) => r.repoDir !== REPO_ROOT));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self review retains the controller checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-self-root-"));
  try {
    const subjectDirs: string[] = [];
    await reviewCommand("8", [], {
      enforceReviewSubjectCheckout: true,
      fetchView: () => restPull("## Acceptance\n- self body criteria | grep: self in src/run-task.ts", CONTROLLER_HEAD, "remudero"),
      loadConfig: () => ({ root }) as Config,
      fetchHead: (repoDir) => subjectDirs.push(repoDir),
      postReviewPending: async () => ({ posted: true }) as never,
      materialize: (_config, repoDir) => {
        subjectDirs.push(repoDir);
        return { worktreePath: undefined, failure: { errorClass: "test", message: "skip worktree" } } as never;
      },
      runReview: (async () => verdict(CONTROLLER_HEAD)) as never,
    });

    assert.deepEqual(subjectDirs, [REPO_ROOT, REPO_ROOT]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid explicit target refuses before controller access", async () => {
  const cases: Array<{ name: string; prepare: (root: string) => void; reason: string }> = [
    { name: "missing", prepare: () => {}, reason: "review-subject-missing" },
    {
      name: "non-repository",
      prepare: (root) => mkdirSync(join(root, "repos", "portal"), { recursive: true }),
      reason: "review-subject-not-git",
    },
    {
      name: "origin mismatch",
      prepare: (root) => {
        const dir = join(root, "repos", "portal");
        mkdirSync(dir, { recursive: true });
        git(dir, ["init", "--quiet", "-b", "main"]);
        git(dir, ["remote", "add", "origin", "https://github.com/acme/wrong.git"]);
      },
      reason: "review-subject-origin-mismatch",
    },
  ];

  for (const c of cases) {
    const root = mkdtempSync(join(tmpdir(), `rmd-review-target-${c.name}-`));
    try {
      c.prepare(root);
      const posted: Array<{ state: string; description?: string }> = [];
      const code = await reviewCommand("8", ["--repo", "acme/portal"], {
        enforceReviewSubjectCheckout: true,
        fetchView: () => restPull("Remudero-Task: W1-TARGET", "target-head-sha"),
        loadConfig: () => ({ root }) as Config,
        postStatus: (async (opts: Parameters<typeof postReviewStatusGuarded>[0]) => {
          posted.push({ state: opts.state, description: opts.description });
          return { posted: true };
        }) as never,
        fetchHead: () => {
          throw new Error("fetchHead must not run after an invalid target checkout");
        },
        postReviewPending: async () => {
          throw new Error("pending status must not post before subject validation");
        },
        materialize: (() => {
          throw new Error("materialize must not run after an invalid target checkout");
        }) as never,
        runReview: (() => {
          throw new Error("runReview must not run after an invalid target checkout");
        }) as never,
      });

      assert.equal(code, 1);
      assert.deepEqual(posted, [{ state: "failure", description: `remudero-review: FAIL — ${c.reason}` }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("target policy stays controller-owned", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-target-policy-"));
  try {
    const target = initTargetRepo(root);
    mkdirSync(join(target.repoDir, ".remudero"), { recursive: true });
    writeFileSync(join(target.repoDir, ".remudero", "mounts.yaml"), "this is not valid mounts yaml: [");
    let captured: { spawnReviewer: boolean | undefined; settingsFile: string; reviewerMount: unknown } | undefined;

    await reviewCommand("8", ["--repo", "acme/portal"], {
      enforceReviewSubjectCheckout: true,
      executionMode: "semantic",
      fetchView: () => restPull("Remudero-Task: W1-TARGET", target.head),
      loadConfig: () => ({ root }) as Config,
      fetchHead: () => {},
      postReviewPending: async () => ({ posted: true }) as never,
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "skip worktree" } }) as never,
      runReview: (async (args: Parameters<typeof runReview>[0]) => {
        captured = {
          spawnReviewer: args.spawnReviewer,
          settingsFile: args.settingsFile,
          reviewerMount: args.reviewerMount,
        };
        return verdict(target.head);
      }) as never,
    });

    assert.equal(captured?.spawnReviewer, true, "semantic target review must use controller mounts, not target .remudero");
    assert.ok(captured?.reviewerMount, "controller-owned reviewer mount reaches runReview");
    assert.ok(captured?.settingsFile.startsWith(join(root, "tmp")), "worker settings stay rooted in controller config");
    assert.equal(existsSync(captured!.settingsFile), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
