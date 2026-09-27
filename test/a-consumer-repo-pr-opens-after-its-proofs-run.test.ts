// W1-T4590: every console and site build since 2026-09-25 died at PR open. The checked opener's
// default proof runner spawned `node --import tsx src/run-task.ts check-proof ...` with cwd = the
// worktree being published, and a CONSUMER repository carries neither tsx nor src/run-task.ts:
// 19 runs failed with "Cannot find package 'tsx'" (CONSOLE-T75/T78/T80/T82/T84, PORTAL-T32..T36).
// The opener also parsed proofs with no target, so a consumer's own `unit test: tests/...` proof
// was refused as unexecutable before it could run.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultProofRunner, openPullRequestChecked, type OpenPullRequestProofRunner } from "../src/lib/pr-open.js";

const CONSOLE = { owner: "craigoley", repo: "remudero-console" } as const;
const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...IDENTITY } });
}

/** A consumer checkout: no node_modules, no src/run-task.ts — a base commit, then the PR's commit. */
function consumerCheckout(plan?: string): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t4590-consumer-"));
  git(dir, "init", "--quiet", "-b", "main");
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib", "reads.ts"), "export const x = 1;\n");
  if (plan) {
    mkdirSync(join(dir, "plan"));
    writeFileSync(join(dir, "plan", "tasks.yaml"), plan);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: seed");
  const base = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "update-ref", "refs/remotes/origin/main", base);
  writeFileSync(join(dir, "lib", "reads.ts"), "export const x = 1;\nexport const CONSUMER_READ_MARK = 2;\n");
  git(dir, "commit", "-qam", "feat: the PR's change");
  return { dir, base };
}

test("W1-T4590: the default runner checks a consumer checkout's proof from rmd's own install", () => {
  const { dir, base } = consumerCheckout();
  try {
    assert.equal(existsSync(join(dir, "node_modules")), false, "precondition: the consumer has no tsx");
    assert.equal(existsSync(join(dir, "src", "run-task.ts")), false, "precondition: nor rmd's CLI");
    const result = defaultProofRunner("grep: CONSUMER_READ_MARK in lib/reads.ts", base, dir, CONSOLE);
    assert.doesNotMatch(`${result.stderr}${result.stdout}`, /Cannot find package 'tsx'/);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout ?? "", /verdict:\s+pass/);
    assert.match(result.stdout ?? "", /discrimination:/, "the merge base was compared, so a stale proof cannot pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4590: a consumer's unit-test proof parses against its own suite roots and reaches the runner with its target", () => {
  const plan = [
    "- id: CONSOLE-T9",
    "  title: consumer fixture",
    "  repo: remudero-console",
    "  type: implement",
    "  acceptance:",
    "    - claim: the console suite covers it",
    '      proof: "unit test: tests/unit/reads.test.ts"',
  ].join("\n");
  const { dir } = consumerCheckout(plan);
  try {
    const seen: Array<{ proof: string; target: unknown }> = [];
    const recorder: OpenPullRequestProofRunner = (proof, _base, _root, target) => {
      seen.push({ proof, target });
      return { status: 0, stdout: "verdict:    pass", stderr: "" };
    };
    const body = openPullRequestChecked("", "run-CONSOLE-T9-1", dir, "origin/main", recorder, CONSOLE);
    assert.match(body, /^Remudero-Task: CONSOLE-T9$/m);
    assert.deepEqual(seen, [{ proof: "unit test: tests/unit/reads.test.ts", target: CONSOLE }]);

    // Without the target the same proof is core's, whose roots do not include tests/: refused.
    assert.throws(() => openPullRequestChecked("", "run-CONSOLE-T9-1", dir, "origin/main", recorder), /cannot execute/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
