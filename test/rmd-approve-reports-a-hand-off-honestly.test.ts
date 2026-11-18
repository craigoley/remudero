// W1-T4688: the first skill approval (#7090) opened its PR, printed "ci timeout — PR left OPEN" and
// exited 1 — a hand-off reported as a failure — and ledgered approve.skill_written before the commit
// that then failed. These pin the exit mapping and the ledger ordering.
import assert from "node:assert/strict";
import { test } from "node:test";

import { RETRO_HANDOFF_EXIT_CODES } from "../src/lib/retro-subprocess.js";
import { approveCiNotGreenExit, approveExitWhenCiNotGreen, commitThenLedgerSkillWrite, mergedBeforeGate } from "../src/run-task.js";

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

// 2026-11-18: the W1-T12032 approve filed its task in remudero-ops#127, which the ops repository merged on its own
// before review ran. Review declined the closed PR (exit 2), the arm found no review row, and the approve exited 2
// although the filing had landed.
const OPS_PR = "https://github.com/craigoley/remudero-ops/pull/127";
const row = (fields: Record<string, unknown>) => async () => ({ number: 127, html_url: OPS_PR, head: { sha: "a".repeat(40) }, ...fields });

test("a plan PR its repository merged before review is the lane's success, ledgered once", async () => {
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const asked: string[][] = [];
  const merged = await mergedBeforeGate(OPS_PR, 2, (step, extra) => rows.push([step, extra]), async (args) => {
    asked.push(args);
    return await row({ state: "closed", merged_at: "2026-11-18T10:55:43Z" })();
  });
  assert.equal(merged, true);
  assert.equal(asked.length, 1, "one live read of the PR");
  assert.ok(asked[0]!.some((arg) => arg.includes("remudero-ops/pulls/127")), asked[0]!.join(" "));
  assert.deepEqual(rows, [["gate.merged_before_review", { merged_pr: OPS_PR, review_code: 2, merged_at: "2026-11-18T10:55:43Z" }]]);
});

test("only a merge excuses a failed review: open, closed unmerged and unreadable PRs keep the review's code", async () => {
  const rows: string[] = [];
  const log = (step: string) => void rows.push(step);
  assert.equal(await mergedBeforeGate(OPS_PR, 2, log, row({ state: "closed", merged_at: null })), false);
  assert.equal(await mergedBeforeGate(OPS_PR, 1, log, row({ state: "open", merged_at: null })), false);
  assert.equal(await mergedBeforeGate(OPS_PR, 2, log, async () => { throw new Error("gh: 502"); }), false);
  assert.equal(await mergedBeforeGate(OPS_PR, 0, log, async () => assert.fail("a passed review needs no read")), false);
  assert.equal(await mergedBeforeGate(OPS_PR, 0, log), false, "the real async default is never called for a passed review");
  assert.deepEqual(rows, []);
});
