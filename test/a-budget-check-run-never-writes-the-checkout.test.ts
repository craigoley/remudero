import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { type GitRepo, gitRepo } from "./helpers/git-repo.js";

// ── W1-T7841 — A BUDGET CHECK RUN NEVER WRITES THE CHECKOUT ───────────────────────────────────
//
// `claude-md-budget-ratchet.mjs` used to default `--feedback-dir` to the cwd's plan/feedback, so any
// test, preflight or hand run on a branch that grew CLAUDE.md dropped
// `plan/feedback/fold-debt-CLAUDE-md-<bytes>.yaml` into the working tree. Only a RECORDING run files
// now: an explicit `--feedback-dir`, or the real CI gate step (GITHUB_ACTIONS=true with no test-runner
// marker). Every test below runs the real script in a throwaway git repo whose CLAUDE.md grew against
// its merge base, and reads the tree back with `git status --porcelain`.

const SCRIPT = new URL("../scripts/claude-md-budget-ratchet.mjs", import.meta.url).pathname;

/** A repo whose CLAUDE.md grew against its merge base (origin/main), under the fold-debt ceiling.
 *  Built by the shared git-repo helper; the baseline and the explicit inbox live inside `.git`, which
 *  `git status` never reports, so the porcelain reads only what the script itself did. */
function fixture(): { repo: GitRepo; baseline: string; inbox: string } {
  const repo = gitRepo({ seedCommit: false, kind: "budget-check" });
  const baseline = join(repo.dir, ".git", "baseline.json");
  writeFileSync(baseline, JSON.stringify({ capBytes: 100_000, foldDebtCeilingBytes: 200_000 }));
  writeFileSync(join(repo.dir, "CLAUDE.md"), "x".repeat(1000));
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, "CLAUDE.md"), "x".repeat(1100)); // grew by 100 bytes in the working tree
  return { repo, baseline, inbox: join(repo.dir, ".git", "inbox") };
}

function run(
  f: { repo: GitRepo; baseline: string },
  extraArgs: string[],
  envOverrides: Record<string, string | undefined>,
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  delete env.GITHUB_ACTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.BASE_SHA;
  env.NODE_V8_COVERAGE = ""; // delete is a no-op under a coverage session; blank it so the child never enrols
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync(process.execPath, [SCRIPT, "--baseline", f.baseline, ...extraArgs], {
    cwd: f.repo.dir,
    env,
    encoding: "utf8",
  });
}

const porcelain = (repo: GitRepo) => repo.git("status", "--porcelain", "--untracked-files=all");
const feedbackFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

test("W1-T7841: a ratchet run outside CI files no fold debt into the checkout", () => {
  const f = fixture();
  try {
    const r = run(f, [], {});
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /OVER BUDGET/);
    assert.equal(feedbackFiles(join(f.repo.dir, "plan", "feedback")).length, 0);
    // The only dirty path is the CLAUDE.md the fixture grew; nothing was written beside it.
    assert.equal(porcelain(f.repo), "M CLAUDE.md");
  } finally {
    f.repo.cleanup();
  }
});

test("W1-T7841: a ratchet run under a test runner files no fold debt even in CI", () => {
  const f = fixture();
  try {
    const r = run(f, [], { GITHUB_ACTIONS: "true", NODE_TEST_CONTEXT: "child-v8" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /fold debt NOT filed/);
    assert.doesNotMatch(r.stderr, /ROUTED: fold filed as/);
    assert.equal(porcelain(f.repo), "M CLAUDE.md");
  } finally {
    f.repo.cleanup();
  }
});

test("W1-T7841: the CI gate step still files fold debt", () => {
  const f = fixture();
  try {
    const r = run(f, [], { GITHUB_ACTIONS: "true" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /ROUTED: fold filed as fold-debt-CLAUDE-md-1100/);
    assert.deepEqual(feedbackFiles(join(f.repo.dir, "plan", "feedback")), ["fold-debt-CLAUDE-md-1100.yaml"]);
  } finally {
    f.repo.cleanup();
  }
});

test("W1-T7841: an explicit feedback directory still files there", () => {
  const f = fixture();
  try {
    const inbox = f.inbox;
    const r = run(f, ["--feedback-dir", inbox], {});
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /ROUTED: fold filed as fold-debt-CLAUDE-md-1100/);
    assert.deepEqual(feedbackFiles(inbox), ["fold-debt-CLAUDE-md-1100.yaml"]);
    // And the checkout itself stays untouched by the recording.
    assert.equal(feedbackFiles(join(f.repo.dir, "plan", "feedback")).length, 0);
    assert.equal(porcelain(f.repo), "M CLAUDE.md");
  } finally {
    f.repo.cleanup();
  }
});

test("W1-T7841: a run that does not file still prints the finding and lands", () => {
  const f = fixture();
  try {
    const r = run(f, [], {});
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /CLAUDE\.md is 1100 bytes/);
    assert.match(r.stdout, /net bytes 100 \(base 1000/);
    assert.match(r.stderr, /CLAUDE\.md grew by 100 bytes/);
    assert.match(
      r.stderr,
      /fold debt NOT filed: not a recording run \(the CI gate step files it; pass --feedback-dir to file locally\)/,
    );
    assert.doesNotMatch(r.stderr, /ROUTED: fold filed as/);
  } finally {
    f.repo.cleanup();
  }
});
