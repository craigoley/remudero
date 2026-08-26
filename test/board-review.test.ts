import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOARD_REVIEW_MIN_RED_COUNT,
  BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS,
  boardItemsInScope,
  buildBoardReview,
  decideBoardReviewCadence,
  decideBoardReviewTrigger,
  type BoardItem,
  type BoardReviewPolicy,
} from "../src/lib/board-review.js";
import type { Proposal } from "../src/lib/inbox.js";

// ── W1-T2304: NO RUNG'S UNIT IS THE BOARD. The sweep and the fix rung read one PR, the retro
// reads runs since a marker, auto-triage reads queue capacity — nothing reads the whole open
// board as a board. This file proves the board-review rung's depth trigger fires and refuses on
// the thresholds this task's own rationale derived, that its only writes are its report and its
// registry proposals, and that it never reports on work its own proposals produced until that
// work has left the open state — the six unit-test acceptance criteria on this task's own shard,
// in that order, plus the pacing bound it shares in shape with every other cadence in this fleet.

const NOW = new Date("2026-08-26T12:00:00.000Z");

const ON: BoardReviewPolicy = { enabled: true, minIntervalMinutes: 360, maxPerDay: 4 };

function item(overrides: Partial<BoardItem> & { id: string }): BoardItem {
  return {
    isDraft: false,
    status: "open",
    ageHours: 1,
    redCheckCount: 0,
    unhandledEscalations: 0,
    ...overrides,
  };
}

// ── acceptance 1: a board younger than every depth threshold produces no fire ──────────────────

test("a board younger than every depth threshold produces no fire", () => {
  const items = [
    item({ id: "pr-1", ageHours: 0.5 }),
    item({ id: "pr-2", ageHours: 2, redCheckCount: 1 }),
  ];
  const d = decideBoardReviewTrigger({ items });
  assert.equal(d.fire, false);
  assert.match(d.reason, /younger than every depth threshold/);
});

// ── acceptance 2: an oldest-open age past the threshold fires the trigger ──────────────────────

test("an oldest-open age past the threshold fires the trigger", () => {
  const items = [item({ id: "pr-1", ageHours: BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS + 1 })];
  const d = decideBoardReviewTrigger({ items });
  assert.equal(d.fire, true);
  assert.match(d.reason, /oldest open non-draft item/);
});

test("age just under the threshold does not fire on age alone", () => {
  const items = [item({ id: "pr-1", ageHours: BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS - 0.01 })];
  const d = decideBoardReviewTrigger({ items });
  assert.equal(d.fire, false);
});

test("a draft never counts toward the age signal, however old", () => {
  const items = [item({ id: "pr-1", isDraft: true, ageHours: 1000 })];
  const d = decideBoardReviewTrigger({ items });
  assert.equal(d.fire, false);
});

test("open count alone is never a signal — a wide board under every other threshold does not fire", () => {
  const items = Array.from({ length: 50 }, (_, i) => item({ id: `pr-${i}`, ageHours: 1 }));
  const d = decideBoardReviewTrigger({ items });
  assert.equal(d.fire, false);
});

// ── acceptance 3: a red count below two does not by itself fire the trigger ────────────────────

test("a red count below two does not by itself fire the trigger", () => {
  const items = [item({ id: "pr-1", redCheckCount: 1, ageHours: 1 })];
  const d = decideBoardReviewTrigger({ items });
  assert.equal(d.fire, false);
  assert.match(d.reason, /red count 1/);
});

test("a red count of zero does not fire", () => {
  const items = [item({ id: "pr-1", redCheckCount: 0, ageHours: 1 })];
  assert.equal(decideBoardReviewTrigger({ items }).fire, false);
});

test("a red count at the threshold fires — structural, mirrors baseCausedCheckName's own floor", () => {
  const items = Array.from({ length: BOARD_REVIEW_MIN_RED_COUNT }, (_, i) =>
    item({ id: `pr-${i}`, redCheckCount: 1, ageHours: 1 }),
  );
  const d = decideBoardReviewTrigger({ items });
  assert.equal(d.fire, true);
  assert.match(d.reason, new RegExp(`${BOARD_REVIEW_MIN_RED_COUNT} PR\\(s\\) carry a red check`));
});

// ── acceptance 4: an unhandled escalation fires the trigger ────────────────────────────────────

test("an unhandled escalation fires the trigger", () => {
  const items = [item({ id: "pr-1", ageHours: 1, unhandledEscalations: 1 })];
  const d = decideBoardReviewTrigger({ items });
  assert.equal(d.fire, true);
  assert.match(d.reason, /unhandled escalation/);
});

test("a threshold above one would re-erase the signal — one is enough", () => {
  const items = [item({ id: "pr-1", ageHours: 1, unhandledEscalations: 1, redCheckCount: 0 })];
  assert.equal(decideBoardReviewTrigger({ items }).fire, true);
});

// ── acceptance 5: the rung's only writes are its report and its registry proposals ─────────────

test("the rung's only writes are its report and its registry proposals", () => {
  const items = [item({ id: "pr-1", ageHours: BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS + 5 })];

  let reportWrites = 0;
  let reportPathWritten: string | undefined;
  let registryCalls = 0;
  let registryPathCalled: string | undefined;
  let rerunCalls = 0;
  let registryState: Proposal[] = [];

  const report = buildBoardReview({
    policy: ON,
    marker: { kind: "absent" },
    items,
    now: NOW,
    reportPath: "/state/board-review-report.json",
    registryPath: "/state/inbox-proposals.json",
    writeReport: (path) => {
      reportWrites += 1;
      reportPathWritten = path;
    },
    updateRegistry: (registryPath, update) => {
      registryCalls += 1;
      registryPathCalled = registryPath;
      const next = update(registryState);
      if (next !== null) registryState = next;
      return next;
    },
    rerunDeadCheck: () => {
      rerunCalls += 1;
    },
  });

  assert.equal(report.fire, true);
  assert.equal(reportWrites, 1, "the report artifact is written exactly once");
  assert.equal(reportPathWritten, "/state/board-review-report.json");
  assert.equal(registryCalls, 1, "the registry is the only OTHER write path this rung has");
  assert.equal(registryPathCalled, "/state/inbox-proposals.json");
  assert.equal(rerunCalls, 0, "no dead-before-test-body check on the board — no rerun fires");
  assert.deepEqual(report.proposalIds, [`board-review:stale:pr-1`]);
  assert.equal(registryState.length, 1);
});

test("a no-fire tick still writes its report and nothing else", () => {
  const items = [item({ id: "pr-1", ageHours: 0.1 })];
  let reportWrites = 0;
  let registryCalls = 0;

  const report = buildBoardReview({
    policy: ON,
    marker: { kind: "absent" },
    items,
    now: NOW,
    reportPath: "/state/board-review-report.json",
    registryPath: "/state/inbox-proposals.json",
    writeReport: () => {
      reportWrites += 1;
    },
    updateRegistry: () => {
      registryCalls += 1;
      return null;
    },
  });

  assert.equal(report.fire, false);
  assert.equal(reportWrites, 1);
  assert.equal(registryCalls, 0, "no findings to mine on a no-fire tick — the registry is never touched");
});

test("the rung's own sanctioned action fires at most once, even with two dead checks on the board", () => {
  const items = [
    item({ id: "pr-1", ageHours: BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS + 1, deadBeforeTestBody: true }),
    item({ id: "pr-2", ageHours: BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS + 1, deadBeforeTestBody: true }),
  ];
  let rerunCalls = 0;
  const report = buildBoardReview({
    policy: ON,
    marker: { kind: "absent" },
    items,
    now: NOW,
    reportPath: "/state/report.json",
    registryPath: "/state/inbox-proposals.json",
    writeReport: () => {},
    updateRegistry: () => null,
    rerunDeadCheck: () => {
      rerunCalls += 1;
    },
  });
  assert.equal(rerunCalls, 1, "at most once per fire — design (ii)'s own bound");
  assert.ok(report.rerunAttempted);
});

// ── acceptance 6: work born from the rung's own proposals is excluded until merged or dead ─────

test("work born from the rung's own proposals is excluded until merged or dead", () => {
  const bornOpen: BoardItem = item({
    id: "pr-child",
    ageHours: BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS + 10,
    originatesFromProposalId: "board-review:stale:pr-parent",
    status: "open",
  });
  const control = item({ id: "pr-control", ageHours: 1 });

  // Still open: the age signal it carries is NOT counted — the board reads as young.
  const whileOpen = decideBoardReviewTrigger({ items: [bornOpen, control] });
  assert.equal(whileOpen.fire, false, "an in-flight self-produced item must not inflate the signal");

  const scoped = boardItemsInScope([bornOpen, control]);
  assert.deepEqual(
    scoped.map((it) => it.id),
    ["pr-control"],
    "the self-produced open item is dropped from scope entirely",
  );

  // Once merged, it is an ordinary board item again and its signal counts.
  const merged: BoardItem = { ...bornOpen, status: "merged" };
  const scopedAfterMerge = boardItemsInScope([merged, control]);
  assert.deepEqual(
    scopedAfterMerge.map((it) => it.id).sort(),
    ["pr-control", "pr-child"].sort(),
    "merged, it is back in scope",
  );

  // A dead (closed, unmerged) child is likewise back in scope.
  const dead: BoardItem = { ...bornOpen, status: "dead" };
  const scopedAfterDeath = boardItemsInScope([dead, control]);
  assert.deepEqual(scopedAfterDeath.map((it) => it.id).sort(), ["pr-control", "pr-child"].sort());
});

test("an item born from a proposal is never mined into a fresh finding while still open", () => {
  const bornOpen: BoardItem = item({
    id: "pr-child",
    ageHours: BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS + 10,
    originatesFromProposalId: "board-review:stale:pr-parent",
    status: "open",
  });
  const control = item({ id: "pr-control", ageHours: BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS + 10 });

  const report = buildBoardReview({
    policy: ON,
    marker: { kind: "absent" },
    items: [bornOpen, control],
    now: NOW,
    reportPath: "/state/report.json",
    registryPath: "/state/inbox-proposals.json",
    writeReport: () => {},
    updateRegistry: (_p, update) => update([]),
  });

  assert.equal(report.fire, true);
  assert.deepEqual(report.proposalIds, ["board-review:stale:pr-control"]);
  assert.equal(report.itemsExcludedAsSelfProduced, 1);
});

// ── the pacing bound: this rung's own policy row, same shape as every other cadence ─────────────

test("DEFAULT OFF: with the flag false the cadence never fires, whatever the board looks like", () => {
  const items = [item({ id: "pr-1", ageHours: 1000 })];
  const d = decideBoardReviewCadence({ policy: { ...ON, enabled: false }, marker: { kind: "absent" }, now: NOW, items });
  assert.equal(d.fire, false);
  assert.match(d.reason, /disabled/);
});

test("CORRUPT MARKER FAILS CLOSED — never fires on unreadable state even with a hot board", () => {
  const items = [item({ id: "pr-1", ageHours: 1000 })];
  const d = decideBoardReviewCadence({ policy: ON, marker: { kind: "corrupt" }, now: NOW, items });
  assert.equal(d.fire, false);
  assert.match(d.reason, /unreadable/);
});

test("a cold board never fires regardless of pacing", () => {
  const items = [item({ id: "pr-1", ageHours: 0.1 })];
  const d = decideBoardReviewCadence({ policy: ON, marker: { kind: "absent" }, now: NOW, items });
  assert.equal(d.fire, false);
});

test("minIntervalMinutes holds even when the depth trigger would otherwise fire", () => {
  const items = [item({ id: "pr-1", ageHours: 1000 })];
  const recentFire = new Date(NOW.getTime() - 5 * 60_000).toISOString();
  const d = decideBoardReviewCadence({
    policy: ON,
    marker: { kind: "ok", marker: { fires: [recentFire] } },
    now: NOW,
    items,
  });
  assert.equal(d.fire, false);
  assert.match(d.reason, /minInterval/);
});

test("maxPerDay holds even when the depth trigger would otherwise fire", () => {
  const items = [item({ id: "pr-1", ageHours: 1000 })];
  // Spaced past minIntervalMinutes (360m) so the interval gate never masks the cap gate, all
  // still inside the rolling 24h window.
  const fires = [7, 13, 19, 23].slice(0, ON.maxPerDay).map((h) => new Date(NOW.getTime() - h * 3600_000).toISOString());
  const d = decideBoardReviewCadence({ policy: ON, marker: { kind: "ok", marker: { fires } }, now: NOW, items });
  assert.equal(d.fire, false);
  assert.match(d.reason, /daily cap reached/);
});

test("a first run with an absent marker fires immediately once the depth trigger justifies it", () => {
  const items = [item({ id: "pr-1", ageHours: 1000 })];
  const d = decideBoardReviewCadence({ policy: ON, marker: { kind: "absent" }, now: NOW, items });
  assert.equal(d.fire, true);
});
