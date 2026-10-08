// #10092 (2026-10-08): a diff touching one test file took the TEST_ONLY lane, which ran only that file.
// The file was a member of the W1-T2811 wall-clock declaration census (which enumerates test/ with
// `git grep`), so the census's recorded population went stale and main stayed red until #10102.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error diff-class is an executable .mjs module outside tsconfig.
import { censusSuiteFiles, enumeratesPopulation, testOnlyRun } from "../scripts/diff-class.mjs";

const CENSUS = "test/a-wall-clock-bound-declares-itself.test.ts";
const MEMBER = "test/a-review-proof-run-keeps-the-daemon-loop-responsive.test.ts";

test("#10092: a test-only diff also runs the censuses that walk the test tree, git grep included", () => {
  assert.equal(enumeratesPopulation('gitGrepLines(["grep", "-lF", HELPER_IMPORT, "--", "test/*.test.ts"])'), true,
    "a git grep argv enumerates the files it matches");
  assert.equal(enumeratesPopulation('execFileSync("git", ["commit", "-m", "x"]); writeFileSync(f, "x");'), false,
    "shelling git for something else is not a population walk");
  assert.ok((censusSuiteFiles([MEMBER]) as string[]).includes(CENSUS), "the git-grep census is listed for a change to its member");
  const run = testOnlyRun([MEMBER]) as { mode: string; files: string[] };
  assert.equal(run.mode, "files");
  assert.equal(run.files[0], MEMBER, "the changed suite leads");
  assert.ok(run.files.includes(CENSUS), "the census #10092 skipped now runs");
});
