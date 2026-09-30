// W1-T4688: the first skill approval (#7090) opened its PR, printed "ci timeout — PR left OPEN" and
// exited 1 — a hand-off reported as a failure — and ledgered approve.skill_written before the commit
// that then failed. These pin the exit mapping and the ledger ordering.
import assert from "node:assert/strict";
import { test } from "node:test";

import { RETRO_HANDOFF_EXIT_CODES } from "../src/lib/retro-subprocess.js";
import { approveCiNotGreenExit, approveExitWhenCiNotGreen, commitThenLedgerSkillWrite } from "../src/run-task.js";

test("W1-T4688: an approve whose PR is left for the sweep exits with the hand-off code", () => {
  assert.equal(approveExitWhenCiNotGreen("timeout"), 3);
  assert.equal(approveExitWhenCiNotGreen("freshness_handoff"), 3);
  assert.equal(RETRO_HANDOFF_EXIT_CODES[3], "ci_not_concluded", "the code is the named hand-off, not a bare number");
  assert.equal(approveExitWhenCiNotGreen("red"), 1, "a red CI is still a failure");
});

test("W1-T4688: the shared not-green tail reports the PR, releases the worktree and exits honestly", (t) => {
  const printed: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]) => printed.push(a.join(" ")));
  let released = 0;
  const release = () => {
    released += 1;
  };
  assert.equal(approveCiNotGreenExit("timeout", "https://x/pull/1", release), 3);
  assert.equal(approveCiNotGreenExit("red", "https://x/pull/2", release), 1);
  assert.equal(released, 2, "each non-green exit releases the worktree");
  assert.deepEqual(printed, ["ci timeout — PR left OPEN: https://x/pull/1", "ci red — PR left OPEN: https://x/pull/2"]);
  assert.equal(approveCiNotGreenExit("green", "https://x/pull/3", release), undefined, "green proceeds to review");
  assert.equal(released, 2, "a green CI releases nothing here");
});

test("W1-T4688: the skill write is ledgered only after its commit", () => {
  const events: string[] = [];
  commitThenLedgerSkillWrite(
    () => events.push("commit"),
    () => events.push("ledger"),
  );
  assert.deepEqual(events, ["commit", "ledger"]);

  const failed: string[] = [];
  assert.throws(
    () =>
      commitThenLedgerSkillWrite(
        () => {
          failed.push("commit");
          throw new Error("commitlint refused");
        },
        () => failed.push("ledger"),
      ),
    /commitlint refused/,
  );
  assert.deepEqual(failed, ["commit"], "a commit that fails ledgers no write");
});
