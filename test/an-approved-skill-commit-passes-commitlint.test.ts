// test/an-approved-skill-commit-passes-commitlint.test.ts — the first real `rmd approve` of a skill
// draft (skill-draft:8aa4458eb462b9a1, 2026-09-24) died at `git commit`: commitlint's commit-msg hook
// refused a body line of 120 characters, because the message embedded a full proposal id and a
// 38-character skill path on one line. The unit test beside the builder used `skill-draft:proc-1`, so
// it never saw a real-length line. These use the values that failed.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkCommitMessage } from "../src/lib/commit-message.js";
import { skillFileApproveCommitMessage, skillLifecycleApproveCommitMessage } from "../src/run-task.js";

const REAL_ID = "skill-draft:8aa4458eb462b9a1";
const REAL_NAME = "implement-clean-single-strike-8aa4458e";
const REAL_PATH = `.claude/skills/${REAL_NAME}/SKILL.md`;

test("an approved skill's commit passes commitlint at real id and path lengths", () => {
  const message = skillFileApproveCommitMessage(REAL_ID, REAL_PATH);
  assert.deepEqual(checkCommitMessage(message), []);
  assert.ok(message.includes(REAL_PATH), "the one file it adds is still named, unbroken");
  assert.match(message.replace(/\n/g, " "), /adds exactly \.claude\/skills\/implement-clean-single-strike-8aa4458e\/SKILL\.md/);
});

test("a retired skill's commit passes commitlint at real id and name lengths", () => {
  const message = skillLifecycleApproveCommitMessage(
    { kind: "skill-retirement", skillName: REAL_NAME, skillPath: REAL_PATH, evidenceFingerprint: "a".repeat(64) },
    REAL_ID,
  );
  assert.deepEqual(checkCommitMessage(message), []);
  assert.match(message, new RegExp(`Evidence fingerprint: ${"a".repeat(64)}`));
});
