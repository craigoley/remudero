import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitFetchError, syncPlanFromOrigin } from "../src/run-task.js";

// THE DISPATCH PATH READS plan/tasks.yaml AS A GIT BLOB, UNBUFFERED.
//
// `syncPlanFromOrigin` (src/run-task.ts) is how the fleet reads the plan in order to dispatch.
// It shells `git show origin/main:<relPath>` through execFileSync, which defaults to a 1 MiB
// stdout buffer. On 2026-08-01 that blob measured 977,168 bytes -- 93.2% of the limit -- and it
// grows with every task filed. Past 1 MiB the read fails ENOBUFS, the catch turns it into a
// GitFetchError, and dispatch stops. Not a degradation: a hard stop with no floor.
//
// THESE TESTS USE A REAL GIT REPO AND THE REAL DEFAULT RUNNER, DELIBERATELY. An injected runner
// that returns a big string proves nothing -- it bypasses the very execFileSync that overflows.
// Each test asserts its FIXTURE SIZE FIRST, so a fixture that silently stopped exceeding the
// limit fails loudly instead of passing vacuously.

const ONE_MIB = 1_048_576;

/** A real bare origin + clone whose `plan/tasks.yaml` is `padTasks` tasks long. */
function seedRepo(padTasks: number): { root: string; repoDir: string; blobBytes: number } {
  const root = mkdtempSync(join(tmpdir(), "rmd-planblob-"));
  const origin = join(root, "origin.git");
  const repoDir = join(root, "clone");
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", "-q", origin, repoDir], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "planblob@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "planblob"]);

  mkdirSync(join(repoDir, "plan"), { recursive: true });
  // schema v1 is a bare YAML LIST of entries; id/title/repo/type are required (lib/plan.ts).
  let yaml = "";
  for (let i = 0; i < padTasks; i++) {
    yaml +=
      `- id: W9-T${i}\n` +
      `  title: "padding task ${i} ${"x".repeat(90)}"\n` +
      `  repo: remudero\n` +
      `  depends_on: []\n` +
      `  type: implement\n` +
      `  verify: human\n`;
  }
  writeFileSync(join(repoDir, "plan", "tasks.yaml"), yaml);
  execFileSync("git", ["-C", repoDir, "add", "-A"]);
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "chore: seed plan"]);
  execFileSync("git", ["-C", repoDir, "push", "-q", "origin", "main"], { stdio: "pipe" });

  const sha = execFileSync("git", ["-C", repoDir, "rev-parse", "origin/main:plan/tasks.yaml"], {
    encoding: "utf8",
  }).trim();
  const blobBytes = Number(
    execFileSync("git", ["-C", repoDir, "cat-file", "-s", sha], { encoding: "utf8" }).trim(),
  );
  return { root, repoDir, blobBytes };
}

test("syncPlanFromOrigin reads a plan blob LARGER than Node's 1 MiB execFileSync default", () => {
  const { root, repoDir, blobBytes } = seedRepo(9000);
  try {
    // FIXTURE FIRST: without this the test could pass on a blob that never exceeded the limit.
    assert.ok(
      blobBytes > ONE_MIB,
      `fixture must exceed Node's 1 MiB default to be meaningful, got ${blobBytes}`,
    );

    const synced = syncPlanFromOrigin(repoDir, "plan/tasks.yaml", {});

    assert.equal(synced.plan.tasks.length, 9000, "every task in the oversized blob must load");
    assert.equal(synced.staleDispatch, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncPlanFromOrigin is unchanged for a normal-sized plan well under the limit", () => {
  const { root, repoDir, blobBytes } = seedRepo(20);
  try {
    assert.ok(blobBytes < ONE_MIB, `control fixture must be under the limit, got ${blobBytes}`);

    const synced = syncPlanFromOrigin(repoDir, "plan/tasks.yaml", {});

    assert.equal(synced.plan.tasks.length, 20);
    assert.equal(synced.staleDispatch, false, "a healthy fetch must not report a stale dispatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncPlanFromOrigin still throws GitFetchError when the blob genuinely cannot be read", () => {
  // The error contract must survive the buffer change: a missing path is still a hard failure,
  // not a silently empty plan.
  const { root, repoDir } = seedRepo(5);
  try {
    assert.throws(
      () => syncPlanFromOrigin(repoDir, "plan/does-not-exist.yaml", {}),
      GitFetchError,
      "an unreadable blob must still raise GitFetchError",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
