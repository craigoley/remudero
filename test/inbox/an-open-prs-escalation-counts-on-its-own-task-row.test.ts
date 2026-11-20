// W1-T13957: live 2026-11-20, open PRs #19691 (W1-T13785) and #19728 (W1-T13855) had escalations on task rows whose
// PR source was "none", so inboxBoardReferents knew each PR only from the open batch, gave it no escalation count,
// and the two board-review:escalation proposals kept the whole core Inbox partial all day.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxBoardReferents } from "#src/lib/inbox-board-referents.js";
import type { StatusProjection } from "#src/lib/status.js";

const row = (taskId: string, extra: Partial<StatusProjection> = {}): StatusProjection =>
  ({ taskId, status: "blocked", source: "none", merged: false, ...extra });
const projection = (...rows: StatusProjection[]) => new Map(rows.map((r) => [r.taskId, r]));
const open = (number: number, headRefName: string, body = "") => ({ number, state: "OPEN", headRefName, body });

test("W1-T13957 own task row: an open PR whose only row is its own task (source none) counts that row's escalation", () => {
  const read = inboxBoardReferents(projection(row("W1-T13785", { needsHuman: true })), [open(19691, "run-W1-T13785-1795095230170")]);
  assert.deepEqual(read.states.get("#19691"), { status: "open", unhandledEscalations: 1 });
  const byTrailer = inboxBoardReferents(projection(row("W1-T13855")), [open(19728, "feature/x", "Fix.\n\nRemudero-Task: W1-T13855\n")]);
  assert.deepEqual(byTrailer.states.get("#19728"), { status: "open", unhandledEscalations: 0 }, "the trailer names the task as well");
  const splitId = inboxBoardReferents(projection(row("W1-T1B", { needsHuman: true })), [open(11, "run-W1-T1B-1795095230170", "Remudero-Task: W1-T1B")]);
  assert.deepEqual(splitId.states.get("#11"), { status: "open", unhandledEscalations: 1 }, "a split task id such as W1-T1B is owned too");
});

test("W1-T13957 own task row: contradicting evidence stays unreadable", () => {
  const twoOwners = inboxBoardReferents(projection(row("W1-T1", { needsHuman: true }), row("W1-T2", { needsHuman: true })),
    [open(5, "run-W1-T1-1", "Remudero-Task: W1-T2")]);
  assert.deepEqual(twoOwners.states.get("#5"), { status: "open" }, "a branch and a trailer naming different tasks own nothing");
  const otherPr = inboxBoardReferents(projection(row("W1-T1", { needsHuman: true, prNumber: 6, prState: "CLOSED" })), [open(7, "run-W1-T1-2")]);
  assert.equal(otherPr.states.get("#7")?.unhandledEscalations, undefined, "the task's row names a different PR");
  const tabTrailer = inboxBoardReferents(projection(row("W1-T1"), row("W1-T2", { needsHuman: true })), [open(9, "run-W1-T1-1", "Remudero-Task:\tW1-T2")]);
  assert.deepEqual(tabTrailer.states.get("#9"), { status: "open" }, "a tab-separated trailer that names another task is still a conflict");
  const unreadBody = inboxBoardReferents(projection(row("W1-T1")), [{ number: 10, state: "OPEN", headRefName: "run-W1-T1-1" }]);
  assert.deepEqual(unreadBody.states.get("#10"), { status: "open" }, "an unread body may hold a conflicting trailer, so ownership is unknown");
  for (const extra of [{ escalationUnverified: true }, { indeterminate: true }, { githubUnobservableSince: "2026-11-20T00:00:00Z" }, { merged: true }] as const) {
    const read = inboxBoardReferents(projection(row("W1-T3", { needsHuman: true, ...extra })), [open(8, "run-W1-T3-3")]);
    assert.equal(read.states.get("#8")?.unhandledEscalations, undefined, `an unobservable or merged own row (${Object.keys(extra)[0]}) supplies no count`);
  }
});

test("W1-T13957 own task row: a PR seen only as an overlap entry on another task never takes that task's escalation", () => {
  const overlap = row("W1-T12224", { needsHuman: true, openSiblingBuild: { prNumber: 19691 } as unknown as StatusProjection["openSiblingBuild"] });
  const read = inboxBoardReferents(projection(overlap), [open(19691, "run-W1-T13785-1795095230170")]);
  assert.deepEqual(read.states.get("#19691"), { status: "open" }, "its own task has no row, so the escalation stays unverified");
  const unowned = inboxBoardReferents(projection(overlap), [open(19691, "dependabot/npm")]);
  assert.deepEqual(unowned.states.get("#19691"), { status: "open" });
});
