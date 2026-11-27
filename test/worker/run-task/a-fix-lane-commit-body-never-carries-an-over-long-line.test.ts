// W1-T15109: the harness writes a fix-lane commit body whose every line fits commitlint's
// body-max-line-length. Fix round 4350982f0 carried a 244-character "Harness-derived subject:" line,
// and every later hand push on that branch was refused by preflight-author's commitlint step.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import conventional from "@commitlint/config-conventional";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { harnessCommitForShellLessWorker } from "#test/helpers/run-task-commit-seam.js";

// The limit commitlint itself enforces, read from the preset commitlint.config.mjs extends.
const BODY_MAX = conventional.rules["body-max-line-length"][2];

// The real reason text from 4350982f0, which landed as one 244-character line.
const REASON = "no COMMIT_MESSAGE; failing check A publish or disarm that gets HTTP 401 renews the GitHub "
  + "credential and retries once; a second 401 is a named token_unrenewable refusal that the next pass "
  + "retries instead of counting as a strike";

const IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
};
const saved: Record<string, string | undefined> = {};
// The code under test shells git with the inherited environment, so the identity must be ambient.
before(() => {
  for (const [key, value] of Object.entries(IDENTITY)) { saved[key] = process.env[key]; process.env[key] = value; }
});
after(() => {
  for (const key of Object.keys(IDENTITY)) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

const words = (text: string) => text.split(/\s+/).filter(Boolean);

test("W1-T15109 criterion 1: a harness-derived fix commit body has no line over the commitlint max", () => {
  assert.equal(typeof BODY_MAX, "number");
  const repo = gitRepo({ kind: "w1-t15109-fix-body" }).dir;
  writeFileSync(join(repo, "README.md"), "edited by the fix round\n");
  const count = harnessCommitForShellLessWorker(
    {
      harnessOwnsGit: true,
      commitCount: 0,
      report: "REPORT\nI repaired the check.\nRemudero-Task: W1-T15030",
      worktreePath: repo,
      declaredPaths: ["README.md"],
      derivedCommit: { subject: "fix: renew the credential before a post", reason: REASON },
      assignmentId: "asg-w1-t15109",
      log: () => {},
      say: () => {},
    },
    { ahead: () => 1 },
  );
  assert.equal(count, 1, "the harness committed the round");
  const message = execFileSync("git", ["-C", repo, "log", "-1", "--format=%B"], { encoding: "utf8" }).trimEnd();
  const lines = message.split("\n");
  assert.equal(lines[0], "fix: renew the credential before a post", "the subject is unchanged");
  const long = lines.slice(1).filter((line) => line.length > BODY_MAX);
  assert.deepEqual(long, [], `every body line fits ${BODY_MAX} characters`);
  // Wrapped, not truncated: every word of the reason survives, in order.
  const reasonStart = lines.findIndex((line) => line.startsWith("Harness-derived subject:"));
  assert.ok(reasonStart > 0, "the harness-derived reason is in the body");
  const paragraph = lines.slice(reasonStart, lines.indexOf("", reasonStart) === -1 ? undefined : lines.indexOf("", reasonStart));
  assert.deepEqual(words(paragraph.join(" ")), words(`Harness-derived subject: ${REASON}`));
  assert.ok(paragraph.length > 1, "the over-long reason was broken across lines");
  // The trailers are kept whole.
  assert.match(message, /^Remudero-Task: W1-T15030$/m);
  assert.match(message, /^Remudero-Assignment: asg-w1-t15109$/m);
});
