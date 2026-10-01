import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(REPO_ROOT, "hooks", "pre-push");
const GATE_URL = pathToFileURL(join(REPO_ROOT, "scripts", "head-identity-gate.mjs")).href;
const ZERO = "0".repeat(40);

/**
 * W1-T4214: the hook refuses the TRANSITION from an admitted remote tip to a refused head, and only
 * that. A real git repo, because the hook reads both commit messages with git; the gate is the REAL
 * predicate, re-exported into the fixture so the hook's own import path resolves.
 */
function fixture(): string {
  const dir = gitRepo({ kind: "prepush-idt", seedCommit: false }).dir;
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "head-identity-gate.mjs"), `export * from ${JSON.stringify(GATE_URL)};\n`);
  return dir;
}

function commit(dir: string, message: string): string {
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", message],
    { cwd: dir },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

function push(dir: string, remoteRef: string, localSha: string, remoteSha: string): { status: number; stderr: string } {
  const res = spawnSync("sh", [HOOK], {
    cwd: dir,
    encoding: "utf8",
    input: `refs/heads/local ${localSha} refs/heads/${remoteRef} ${remoteSha}\n`,
    env: { PATH: process.env.PATH ?? "", HOME: dir, RMD_PREPUSH_GATES: "1" },
  });
  assert.equal(res.error, undefined, `the hook itself failed to launch: ${String(res.error)}`);
  return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

test("W1-T4214: a push that turns an admitted head refused is refused", () => {
  const dir = fixture();
  const admitted = commit(dir, "feat: a change\n\nRemudero-Task: W1-T1");
  const stripped = commit(dir, "feat: a change, trailer dropped");
  const { status, stderr } = push(dir, "ad-hoc-branch", stripped, admitted);

  assert.equal(status, 1, "an admitted-to-refused transition must stop the push");
  assert.match(stderr, /turns an admitted head into one head-identity-gate REFUSES/);
  assert.match(stderr, /identity LOST — the remote tip was identified via the head commit's Remudero-Task trailer/);
  assert.match(stderr, /pre-push REFUSED/);
});

test("W1-T4214: a first push of a branch that is refused is not a transition and goes through", () => {
  const dir = fixture();
  const unidentified = commit(dir, "feat: ad-hoc work with no trailer yet");
  const { status, stderr } = push(dir, "ad-hoc-branch", unidentified, ZERO);

  assert.equal(status, 0, "the first push of an ad-hoc branch cannot satisfy the gate and must not be refused");
  assert.doesNotMatch(stderr, /identity LOST/);
});

test("W1-T4214: a push that keeps an admitted head admitted is not refused", () => {
  const dir = fixture();
  const first = commit(dir, "feat: one\n\nRemudero-Task: W1-T1");
  const second = commit(dir, "feat: two\n\nRemudero-Task: W1-T1");
  const { status, stderr } = push(dir, "ad-hoc-branch", second, first);

  assert.equal(status, 0);
  assert.doesNotMatch(stderr, /identity LOST/);
});

test("W1-T4214: a head already refused stays a warning, not a new refusal", () => {
  const dir = fixture();
  const before = commit(dir, "feat: one, no trailer");
  const after = commit(dir, "feat: two, no trailer");
  const { status } = push(dir, "ad-hoc-branch", after, before);

  assert.equal(status, 0, "only the admitted-to-refused transition is refused");
});

test("W1-T4214: a run-shaped ref is admitted on both sides, so dropping the trailer is not a transition", () => {
  const dir = fixture();
  const before = commit(dir, "feat: one\n\nRemudero-Task: W1-T1");
  const after = commit(dir, "feat: two, trailer dropped");
  const { status } = push(dir, "run-W1-T1-1789528173134", after, before);

  assert.equal(status, 0, "the ref still identifies the head, so nothing was lost");
});

test("W1-T4214: a remote tip this clone does not hold is skipped and SAID, never counted as cleared", () => {
  const dir = fixture();
  const local = commit(dir, "feat: no trailer");
  const { status, stderr } = push(dir, "ad-hoc-branch", local, "1".repeat(40));

  assert.equal(status, 0, "an unknowable transition must not strand a push");
  assert.match(stderr, /remote tip not in this clone, skipped, NOT passed/);
});

test("W1-T4214: a gate that cannot be loaded is named as unjudgeable and does not block", () => {
  const dir = fixture();
  const admitted = commit(dir, "feat: a\n\nRemudero-Task: W1-T1");
  const stripped = commit(dir, "feat: b");
  writeFileSync(join(dir, "scripts", "head-identity-gate.mjs"), "export const nothing = 1;\n");
  const { status, stderr } = push(dir, "ad-hoc-branch", stripped, admitted);

  assert.equal(status, 0);
  assert.match(stderr, /head-identity transition could not be judged — not blocking/);
});
