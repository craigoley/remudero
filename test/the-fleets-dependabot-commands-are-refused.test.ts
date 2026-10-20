/**
 * W1-T9994 — THE FLEET'S @dependabot COMMANDS ARE REFUSED, AND THE LEDGER SAID DELIVERED.
 *
 * #11968, 2026-10-16: remudero-fleet[bot] posted "@dependabot rebase" at 20:45:13Z and Dependabot answered at
 * 20:45:17Z "Sorry, only users with push access can use that command." The ledger then read `refresh_unanswered`
 * with `delivered: true` for hours and the head was never refreshed. Pure tests: no src/run-task.ts import.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  DEPENDABOT_REBASE_COMMAND,
  dependabotCommandAnswer,
  reconcileDependabotRefresh,
  type DependabotIssueComment,
  type DepReviewResult,
} from "../src/lib/dep-review.js";

const HEAD = "676bed09".padEnd(40, "0");
const REQUESTED = Date.parse("2026-10-16T20:45:13.500Z");
const NOW = Date.parse("2026-10-17T02:20:00.000Z");
const REFUSAL = "Sorry, only users with push access can use that command.";
const HOLD: DepReviewResult = {
  decision: "hold", semverLevel: "patch", pinOnly: false, offendingFiles: [],
  redChecks: ["commitlint"], migrationBumps: [], reason: "checks are red",
};

function reply(over: Partial<DependabotIssueComment> = {}): DependabotIssueComment {
  return { user: { login: "dependabot[bot]" }, created_at: "2026-10-16T20:45:17Z", body: REFUSAL, ...over };
}

function fixture(t: TestContext, record: Record<string, unknown> | undefined) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9994-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "hold.json");
  const prior = record === undefined ? {} : { refreshes: [{
    headSha: HEAD, command: DEPENDABOT_REBASE_COMMAND, cause: "base-red-recovered", requestedAtMs: REQUESTED, delivered: true, ...record }] };
  writeFileSync(statePath, `${JSON.stringify({ headSha: HEAD, heldSinceMs: REQUESTED, asks: [], ...prior })}\n`);
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const updates: string[] = [];
  const reads: string[] = [];
  const escalations: string[] = [];
  let comments: DependabotIssueComment[] = [reply()];
  let updateError: string | undefined;
  const run = (cause: "base-red-recovered" | null = "base-red-recovered") => reconcileDependabotRefresh({
    statePath, prNumber: 11968, headSha: HEAD, result: HOLD, cause: cause ?? undefined, nowMs: NOW,
    updateBranch: (expected) => { updates.push(expected); return updateError === undefined ? { ok: true } : { ok: false, error: updateError }; },
    readComments: (since) => { reads.push(since); return comments; },
    escalate: (r) => { escalations.push(r.reply ?? ""); return "https://github.com/craigoley/remudero/issues/1"; },
    log: (step, extra) => { rows.push({ step, extra }); },
  });
  return { run, rows, updates, reads, escalations, state: () => JSON.parse(readFileSync(statePath, "utf8")),
    setComments: (c: DependabotIssueComment[]) => { comments = c; }, failUpdate: (e: string) => { updateError = e; } };
}

test("W1-T9994: dependabotCommandAnswer reads only Dependabot's refusal made after the request", () => {
  assert.deepEqual(dependabotCommandAnswer([reply()], REQUESTED), { kind: "refused", reply: REFUSAL });
  assert.deepEqual(dependabotCommandAnswer([reply({ body: `${REFUSAL}\n\nmore text` })], REQUESTED), { kind: "refused", reply: REFUSAL });
  assert.deepEqual(dependabotCommandAnswer([reply({ user: { login: "app/dependabot" } })], REQUESTED).kind, "refused");
  assert.equal(dependabotCommandAnswer([reply({ user: { login: "cao825" } })], REQUESTED).kind, "none", "a human quoting it is not Dependabot");
  assert.equal(dependabotCommandAnswer([reply({ user: null })], REQUESTED).kind, "none");
  assert.equal(dependabotCommandAnswer([reply({ created_at: "2026-10-16T20:45:12Z" })], REQUESTED).kind, "none", "before the request");
  assert.equal(dependabotCommandAnswer([reply({ created_at: "2026-10-16T20:45:13Z" })], REQUESTED).kind, "refused", "GitHub stamps whole seconds");
  assert.equal(dependabotCommandAnswer([reply({ created_at: "not a date" })], REQUESTED).kind, "none");
  assert.equal(dependabotCommandAnswer([reply({ body: "Looks good." })], REQUESTED).kind, "none");
  assert.equal(dependabotCommandAnswer([reply({ body: undefined })], REQUESTED).kind, "none");
  assert.equal(dependabotCommandAnswer([], REQUESTED).kind, "none");
});

test("W1-T9994: a refused Dependabot command is recorded as refused, not delivered and unanswered", (t) => {
  const f = fixture(t, {});
  f.failUpdate("HTTP 422: not mergeable");
  f.run();
  const refused = f.rows.filter((r) => r.step === "dep-review.refresh_refused");
  assert.equal(refused.length, 1, "ledgers dep-review.refresh_refused");
  assert.equal(refused[0].extra.reply, REFUSAL);
  assert.equal(refused[0].extra.command, DEPENDABOT_REBASE_COMMAND);
  assert.equal(refused[0].extra.head_sha, HEAD);
  assert.equal(refused[0].extra.pr_number, 11968);
  assert.equal(refused[0].extra.cause, "base-red-recovered");
  assert.equal(f.state().refreshes[0].answer, "refused");
  assert.equal(f.state().refreshes[0].reply, REFUSAL);
  assert.equal(f.reads[0], "2026-10-16T20:45:13.500Z", "the answer is read since the request");
  f.run();
  f.run();
  assert.equal(f.rows.filter((r) => r.step === "dep-review.refresh_unanswered").length, 0, "never reported unanswered again");
  assert.equal(f.rows.filter((r) => r.step === "dep-review.refresh_refused").length, 1, "the refusal is ledgered once");
  assert.equal(f.reads.length, 1, "a recorded answer is not read again");
});

test("W1-T9994: a head whose command was refused is refreshed through REST on the next pass", (t) => {
  const f = fixture(t, {});
  assert.equal(f.run(), "requested");
  assert.deepEqual(f.updates, [HEAD], "the update-branch carries the head as its expected head");
  const requested = f.rows.filter((r) => r.step === "dep-review.refresh_requested");
  assert.equal(requested.length, 1);
  assert.equal(requested[0].extra.via, "update-branch");
  assert.equal(f.state().refreshes[0].via, "update-branch");
  assert.equal(f.state().refreshes[0].answer, "refused");
  assert.equal(f.run(), "refused", "the head is refreshed once, not on every pass");
  assert.equal(f.rows.filter((r) => r.step === "dep-review.refresh_unanswered").length, 0);
  assert.deepEqual(f.updates, [HEAD]);
  assert.equal(f.escalations.length, 0, "a refresh that applied escalates nothing");
});

test("W1-T9994: an unanswered command is still reported unanswered, and an unreadable answer says so", (t) => {
  const f = fixture(t, {});
  f.setComments([reply({ body: "Looks good." })]);
  assert.equal(f.run(), "unanswered");
  assert.equal(f.rows.at(-1)?.step, "dep-review.refresh_unanswered");
  assert.equal(f.updates.length, 0, "no refusal, no REST refresh");
  const g = fixture(t, {});
  const read = (): never => { throw new Error("rate limited"); };
  g.setComments(new Proxy([], { get: read }));
  assert.equal(g.run(), "unanswered");
  assert.equal(g.rows.at(-1)?.extra.answer_read_error, "rate limited");
});

test("W1-T9994: a refused update-branch after a refused command escalates once, quoting the reply", (t) => {
  const f = fixture(t, {});
  f.failUpdate("HTTP 409: head changed");
  assert.equal(f.run(), "escalated");
  assert.deepEqual(f.escalations, [REFUSAL]);
  assert.equal(f.run(), "escalated");
  assert.equal(f.escalations.length, 1);
  assert.equal(f.updates.length, 1);
  assert.equal(f.state().refreshes[0].updateError, "HTTP 409: head changed");
});

test("W1-T9994: an interrupted update-branch record is retried and a thrown update is a refusal", (t) => {
  const f = fixture(t, { command: "update-branch", delivered: false });
  assert.equal(f.run(), "requested");
  assert.equal(f.updates.length, 1);
  const g = fixture(t, undefined);
  assert.equal(g.run(null), "none");
  assert.equal(g.run(), "requested", "no prior record: the base refresh is the update-branch");
  const h = fixture(t, undefined);
  const throwing = reconcileDependabotRefresh({
    statePath: join(tmpdir(), "nonexistent-w1-t9994"), prNumber: 1, headSha: HEAD, result: { ...HOLD, redChecks: [] }, cause: "fixed-on-main", nowMs: NOW,
    updateBranch: () => { throw new Error("unreachable"); }, readComments: () => [], escalate: () => null, log: () => {},
  });
  assert.equal(throwing, "none", "a hold on pending checks has nothing to refresh");
  assert.equal(h.run(), "requested");
});

test("W1-T9994: a throwing update-branch and an undelivered escalation are failures that retry", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9994-throw-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, "hold.json");
  const rows: string[] = [];
  let issue: string | null = null;
  const args = {
    statePath, prNumber: 7, headSha: HEAD, result: HOLD, cause: "fixed-on-main" as const, nowMs: NOW,
    updateBranch: () => { throw new Error("gh exploded"); }, readComments: () => [],
    escalate: () => { if (issue === "throw") throw new Error("issues down"); return issue; },
    log: (step: string) => { rows.push(step); },
  };
  assert.equal(reconcileDependabotRefresh(args), "failed", "the issue read returned nothing: not escalated yet");
  issue = "throw";
  assert.equal(reconcileDependabotRefresh(args), "failed");
  issue = "https://github.com/craigoley/remudero/issues/2";
  assert.equal(reconcileDependabotRefresh(args), "escalated");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).refreshes[0].updateError, "gh exploded");
  assert.equal(rows.filter((r) => r === "dep-review.refresh_escalated").length, 1);
});
