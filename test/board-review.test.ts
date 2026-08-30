import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BOARD_REVIEW_MIN_RED_COUNT,
  BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS,
  boardItemsInScope,
  boardReviewMarkerPath,
  buildBoardReview,
  decideBoardReviewCadence,
  decideBoardReviewTrigger,
  reconcileBoardReviewReferents,
  readBoardReviewMarker,
  recordBoardReviewFire,
  type BoardItem,
  type BoardReviewPolicy,
} from "../src/lib/board-review.js";
import { runMeasurementCadenceReport } from "../src/lib/measurement-cadence.js";
import type { Proposal } from "../src/lib/inbox.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

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

// ── the marker read/write shape — a deliberate, small duplication of measurement-cadence.ts's own
// marker functions (see this file's header doc) ─────────────────────────────────────────────────

test("boardReviewMarkerPath is state/last-board-review.json under the given root", () => {
  assert.equal(boardReviewMarkerPath("/some/root"), join("/some/root", "state", "last-board-review.json"));
});

test("readBoardReviewMarker resolves absent for a missing file", () => {
  const root = tmp("rmd-br-marker-absent-");
  try {
    const path = boardReviewMarkerPath(root);
    assert.deepEqual(readBoardReviewMarker(path), { kind: "absent" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBoardReviewMarker fails closed to corrupt on invalid JSON and on a wrong shape", () => {
  const root = tmp("rmd-br-marker-corrupt-");
  try {
    const path = boardReviewMarkerPath(root);
    mkdirSync(join(root, "state"), { recursive: true });

    writeFileSync(path, "{not json");
    assert.deepEqual(readBoardReviewMarker(path), { kind: "corrupt" });

    writeFileSync(path, JSON.stringify({ fires: [1, 2, 3] }));
    assert.deepEqual(readBoardReviewMarker(path), { kind: "corrupt" });

    writeFileSync(path, JSON.stringify(null));
    assert.deepEqual(readBoardReviewMarker(path), { kind: "corrupt" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordBoardReviewFire appends a fire, trims to the window, and round-trips through readBoardReviewMarker", () => {
  const root = tmp("rmd-br-marker-record-");
  try {
    const path = boardReviewMarkerPath(root);
    mkdirSync(join(root, "state"), { recursive: true });

    const windowMs = 24 * 60 * 60 * 1000;
    const stale = new Date(NOW.getTime() - windowMs - 1);
    const inWindow = new Date(NOW.getTime() - 1000);
    writeFileSync(path, JSON.stringify({ fires: [stale.toISOString(), inWindow.toISOString()] }));

    const marker = recordBoardReviewFire(path, NOW, windowMs);
    assert.deepEqual(marker.fires, [inWindow.toISOString(), NOW.toISOString()], "the stale fire is trimmed, the fresh one and the new one survive");

    const reread = readBoardReviewMarker(path);
    assert.equal(reread.kind, "ok");
    if (reread.kind === "ok") assert.deepEqual(reread.marker.fires, marker.fires);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── mining also drafts an escalation finding, not only a staleness one ─────────────────────────

test("an unhandled escalation is mined into its own proposal candidate, distinct from staleness", () => {
  const items = [item({ id: "pr-1", ageHours: 1, unhandledEscalations: 2 })];
  let registryState: Proposal[] = [];

  const report = buildBoardReview({
    policy: ON,
    marker: { kind: "absent" },
    items,
    now: NOW,
    reportPath: "/state/report.json",
    registryPath: "/state/inbox-proposals.json",
    writeReport: () => {},
    updateRegistry: (_p, update) => {
      const next = update(registryState);
      if (next !== null) registryState = next;
      return next;
    },
  });

  assert.equal(report.fire, true);
  assert.deepEqual(report.proposalIds, ["board-review:escalation:pr-1"]);
  assert.equal(registryState.length, 1);
  // W1-T2453: no title/url carried on this item, so the finding still fires but is honest that
  // the ask could not be read — never a bare "carries N unhandled escalation(s)" count.
  assert.match(registryState[0].summary, /carries an unhandled escalation whose ask could not be read/);
});

// ── W1-T2453 acceptance 1: a NAMED escalation is decidable from its own text ───────────────────

test("a named escalation's finding carries its own one-line ask and a direct link to its issue", () => {
  const items = [
    item({
      id: "pr-1",
      ageHours: 1,
      unhandledEscalations: 1,
      escalationTitle: "[fix] T2145: strike cap does not bind",
      escalationIssueUrl: "https://github.com/o/r/issues/3043",
    }),
  ];
  let registryState: Proposal[] = [];

  const report = buildBoardReview({
    policy: ON,
    marker: { kind: "absent" },
    items,
    now: NOW,
    reportPath: "/state/report.json",
    registryPath: "/state/inbox-proposals.json",
    writeReport: () => {},
    updateRegistry: (_p, update) => {
      const next = update(registryState);
      if (next !== null) registryState = next;
      return next;
    },
  });

  assert.equal(report.fire, true);
  // The finding id is UNCHANGED (design (ii)) — updateProposalRegistry's idempotence keys on it,
  // and an already-open candidate must not be re-minted as a duplicate by this change.
  assert.deepEqual(report.proposalIds, ["board-review:escalation:pr-1"]);
  assert.equal(registryState.length, 1);
  assert.match(registryState[0].summary, /\[fix\] T2145: strike cap does not bind/, "the summary names the ask");
  assert.match(registryState[0].summary, /https:\/\/github\.com\/o\/r\/issues\/3043/, "and links the issue directly");
  assert.doesNotMatch(registryState[0].summary, /carries 1 unhandled escalation\(s\)/, "never the old bare count");
});

// ── W1-T2453 acceptance 3: an unreadable ask is HONEST ABSENCE, never a dropped finding ────────

test("an escalation whose issue could not be read still produces its finding, stating the ask was unreadable", () => {
  const items = [item({ id: "pr-1", ageHours: 1, unhandledEscalations: 1, escalationUnverified: true })];
  let registryState: Proposal[] = [];

  const report = buildBoardReview({
    policy: ON,
    marker: { kind: "absent" },
    items,
    now: NOW,
    reportPath: "/state/report.json",
    registryPath: "/state/inbox-proposals.json",
    writeReport: () => {},
    updateRegistry: (_p, update) => {
      const next = update(registryState);
      if (next !== null) registryState = next;
      return next;
    },
  });

  assert.equal(report.fire, true, "still a finding, never silently dropped for being unverified");
  assert.deepEqual(report.proposalIds, ["board-review:escalation:pr-1"], "same id as the named case — no duplicate minting");
  assert.equal(registryState.length, 1);
  assert.match(registryState[0].summary, /could not be read/, "the summary says so honestly");
  assert.match(registryState[0].summary, /issue state unverified/);
  assert.doesNotMatch(registryState[0].summary, /carries 1 unhandled escalation\(s\)/, "never rendered as an ordinary bare count");
});

// ── W1-T2304's own producer wiring into measurement-cadence.ts's spine (design's own "Ownership"
// note): buildBoardReview is only reachable through runMeasurementCadenceReport when a caller
// actually opts in with opts.boardReview — an EXISTING caller that hasn't opted in is untouched ──

test("runMeasurementCadenceReport wires the board-review rung through when opts.boardReview is supplied", () => {
  const root = tmp("rmd-mc-boardreview-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const items = [item({ id: "pr-1", ageHours: BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS + 5 })];
    let rerunCalls = 0;

    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: process.cwd(),
      escalate: false,
      gitLog: () => ({ dump: "", ref: "test" }),
      boardReview: {
        policy: ON,
        marker: { kind: "absent" },
        items,
        reportPath: join(stateDir, "board-review-report.json"),
        registryPath: join(stateDir, "inbox-proposals.json"),
        rerunDeadCheck: () => {
          rerunCalls += 1;
        },
      },
    });

    assert.ok(result.boardReview, "the board-review report must actually be reachable off the cadence result");
    assert.equal(result.boardReview?.fire, true);
    assert.deepEqual(result.boardReview?.proposalIds, ["board-review:stale:pr-1"]);
    assert.equal(rerunCalls, 0, "no dead-before-test-body check on this board — no rerun fires");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMeasurementCadenceReport skips the board-review rung entirely when opts.boardReview is omitted", () => {
  const root = tmp("rmd-mc-noboardreview-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: process.cwd(),
      escalate: false,
      gitLog: () => ({ dump: "", ref: "test" }),
    });

    assert.equal(result.boardReview, undefined, "an existing caller that hasn't opted in gets no new report");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T2464: THE RECONCILER — a board-review finding must not outlive its referent forever ────
//
// `evidenceAnchors` is permanently `[]` on every board-review-minted proposal (a PR's open/closed
// state is not a git-grep-able fact), so nothing in the ordinary drift machinery can ever retire
// one. `reconcileBoardReviewReferents` is the separate mechanism this task adds, called from the
// daemon's `checkBoardReview` hook (run-task.ts) rather than from `buildBoardReview`, so it runs
// on every poll regardless of whether the depth trigger justifies a fire.

function proposal(overrides: Partial<Proposal> & { id: string }): Proposal {
  return { summary: overrides.id, evidenceAnchors: [], ...overrides };
}

function fakeRegistry(initial: Proposal[]) {
  let state = initial;
  let writes = 0;
  let calls = 0;
  const updateRegistry = (
    _registryPath: string,
    update: (current: Proposal[]) => Proposal[] | null,
  ): Proposal[] | null => {
    calls += 1;
    const next = update(state);
    if (next !== null) {
      state = next;
      writes += 1;
    }
    return next;
  };
  return {
    updateRegistry,
    get state() {
      return state;
    },
    get writes() {
      return writes;
    },
    get calls() {
      return calls;
    },
  };
}

// ── acceptance 1 ─────────────────────────────────────────────────────────────────────────────

test("a board-review finding whose referent PR has left the open board is retired on the next check, even on a tick that produces no findings of its own and does not fire", () => {
  const registry = fakeRegistry([proposal({ id: "board-review:stale:#3227", originatingItemId: "#3227" })]);
  // A quiet board — #3227 has merged and left it, and every remaining item is far under every
  // depth threshold, so this tick does not fire.
  const items = [item({ id: "#9001", ageHours: 0.1 })];

  assert.equal(decideBoardReviewTrigger({ items }).fire, false, "precondition: this tick does not fire");

  const result = reconcileBoardReviewReferents({ items, registryPath: "/state/inbox-proposals.json", updateRegistry: registry.updateRegistry });

  assert.deepEqual(result.retiredProposalIds, ["board-review:stale:#3227"]);
  assert.deepEqual(registry.state, [], "the row is gone from the registry, not merely reclassified");
});

test("an escalation finding whose PR has merged is retired the same way as a stale finding", () => {
  const registry = fakeRegistry([proposal({ id: "board-review:escalation:#3227", originatingItemId: "#3227" })]);
  const result = reconcileBoardReviewReferents({ items: [item({ id: "#1" })], registryPath: "/state/inbox-proposals.json", updateRegistry: registry.updateRegistry });
  assert.deepEqual(result.retiredProposalIds, ["board-review:escalation:#3227"]);
  assert.deepEqual(registry.state, []);
});

test("a legacy proposal minted before originatingItemId existed still retires, parsed off its own id", () => {
  const registry = fakeRegistry([proposal({ id: "board-review:stale:#3227" })]); // no originatingItemId
  const result = reconcileBoardReviewReferents({ items: [item({ id: "#1" })], registryPath: "/state/inbox-proposals.json", updateRegistry: registry.updateRegistry });
  assert.deepEqual(result.retiredProposalIds, ["board-review:stale:#3227"]);
});

// ── acceptance 2 ─────────────────────────────────────────────────────────────────────────────

test("an EMPTY board read retires nothing at all — an unreadable board is never read as every condition resolved", () => {
  const registry = fakeRegistry([proposal({ id: "board-review:stale:#3227", originatingItemId: "#3227" })]);
  const result = reconcileBoardReviewReferents({ items: [], registryPath: "/state/inbox-proposals.json", updateRegistry: registry.updateRegistry });
  assert.deepEqual(result.retiredProposalIds, []);
  assert.equal(registry.calls, 0, "an empty read never even touches the registry");
  assert.equal(registry.state.length, 1, "the row survives untouched");
});

// ── acceptance 3 ─────────────────────────────────────────────────────────────────────────────

test("an escalation finding whose referent PR is STILL on the open board survives, even when this tick mines no escalation finding for it", () => {
  const registry = fakeRegistry([proposal({ id: "board-review:escalation:#3227", originatingItemId: "#3227" })]);
  // #3227 is still open, but ITS escalation count reads zero this tick (the projection read
  // degraded, or the escalation really was handled) — either way, the PR itself is still on the
  // board, so this must survive.
  const items = [item({ id: "#3227", unhandledEscalations: 0 })];

  const result = reconcileBoardReviewReferents({ items, registryPath: "/state/inbox-proposals.json", updateRegistry: registry.updateRegistry });

  assert.deepEqual(result.retiredProposalIds, [], "the PR is still on the board — nothing retires");
  assert.equal(registry.state.length, 1);
});

// ── acceptance 4 ─────────────────────────────────────────────────────────────────────────────

test("retirement never reaches a proposal this rung did not mint — a P##, a rule-efficacy and a docket row all survive", () => {
  const untouched: Proposal[] = [
    proposal({ id: "P77" }),
    proposal({ id: "rule-efficacy:some-rule" }),
    proposal({ id: "FD-1" }),
  ];
  const registry = fakeRegistry([
    proposal({ id: "board-review:stale:#3227", originatingItemId: "#3227" }),
    ...untouched,
  ]);
  // #3227 has left the board — the board-review row retires, the other three do not, whatever
  // the board looks like (none of them names a referent this rung could resolve).
  const result = reconcileBoardReviewReferents({ items: [item({ id: "#1" })], registryPath: "/state/inbox-proposals.json", updateRegistry: registry.updateRegistry });

  assert.deepEqual(result.retiredProposalIds, ["board-review:stale:#3227"]);
  assert.deepEqual(
    registry.state.map((p) => p.id).sort(),
    untouched.map((p) => p.id).sort(),
    "exactly the three non-board-review rows remain",
  );
});

// ── acceptance 5 ─────────────────────────────────────────────────────────────────────────────

test("the reconciliation is idempotent — a second pass over unchanged state retires nothing further and writes nothing", () => {
  const registry = fakeRegistry([proposal({ id: "board-review:stale:#3227", originatingItemId: "#3227" })]);
  const items = [item({ id: "#1" })];

  const first = reconcileBoardReviewReferents({ items, registryPath: "/state/inbox-proposals.json", updateRegistry: registry.updateRegistry });
  assert.deepEqual(first.retiredProposalIds, ["board-review:stale:#3227"]);
  assert.equal(registry.writes, 1);

  const second = reconcileBoardReviewReferents({ items, registryPath: "/state/inbox-proposals.json", updateRegistry: registry.updateRegistry });
  assert.deepEqual(second.retiredProposalIds, [], "nothing left to retire");
  assert.equal(registry.writes, 1, "the second pass performs no registry write");
  assert.equal(registry.calls, 2, "it still reads — a real registry could have changed underneath it");
});

// ── W1-T2470: THE EXPIRY TASK'S OWN ACCEPTANCE, ON TOP OF W1-T2464'S RECONCILER ─────────────────
//
// `evidenceAnchors` is permanently `[]` on every board-review-minted proposal (W1-T2470's own
// rationale), which is why the reconciler above exists at all. The three tests below cover what
// W1-T2464 did not: an operator's `reframeHistory` outranks a departed referent (design (iii)'s
// second guard), retirement is observable by id AND REASON (design (iv)), and the mechanism
// actually drains the shape of registry this task's rationale measured, not just a one-row
// fixture.

// ── acceptance 3 (second guard) ─────────────────────────────────────────────────────────────────

test("a board-review proposal carrying a non-empty reframeHistory is NEVER retired, even though its referent has left the board", () => {
  const reframed = proposal({
    id: "board-review:stale:#3227",
    originatingItemId: "#3227",
    reframeHistory: [{ feedback: "still relevant, keep it open until I say otherwise" }],
  });
  const registry = fakeRegistry([reframed, proposal({ id: "board-review:stale:#9001", originatingItemId: "#9001" })]);
  // Neither #3227 nor #9001 is on the board — both referents have left — but only the un-reframed
  // row may retire.
  const result = reconcileBoardReviewReferents({ items: [item({ id: "#1" })], registryPath: "/state/inbox-proposals.json", updateRegistry: registry.updateRegistry });

  assert.deepEqual(result.retiredProposalIds, ["board-review:stale:#9001"]);
  assert.deepEqual(registry.state, [reframed], "the reframed row survives untouched, the operator's engagement preserved");
});

// ── acceptance 5 (observability) ────────────────────────────────────────────────────────────────

test("every retirement carries its own reason alongside its id — a silent retirement fails", () => {
  const registry = fakeRegistry([
    proposal({ id: "board-review:stale:#3227", originatingItemId: "#3227" }),
    proposal({ id: "board-review:escalation:#3043", originatingItemId: "#3043" }),
  ]);
  const result = reconcileBoardReviewReferents({ items: [item({ id: "#1" })], registryPath: "/state/inbox-proposals.json", updateRegistry: registry.updateRegistry });

  assert.deepEqual(
    result.retired.map((r) => r.id).sort(),
    ["board-review:escalation:#3043", "board-review:stale:#3227"],
    "the id half of the pairing matches retiredProposalIds",
  );
  for (const row of result.retired) {
    assert.equal(typeof row.reason, "string");
    assert.ok(row.reason.length > 0, `retirement of ${row.id} must carry a non-empty reason`);
    assert.match(row.reason, /no longer on the open board/, "the reason names WHY, not just THAT");
  }
});

test("an empty pass and a nothing-to-retire pass both report an empty retired[] alongside the empty id list", () => {
  const emptyItems = reconcileBoardReviewReferents({ items: [], registryPath: "/state/inbox-proposals.json", updateRegistry: fakeRegistry([]).updateRegistry });
  assert.deepEqual(emptyItems, { retiredProposalIds: [], retired: [] });

  const registry = fakeRegistry([proposal({ id: "board-review:stale:#3227", originatingItemId: "#3227" })]);
  const stillLive = reconcileBoardReviewReferents({ items: [item({ id: "#3227" })], registryPath: "/state/inbox-proposals.json", updateRegistry: registry.updateRegistry });
  assert.deepEqual(stillLive, { retiredProposalIds: [], retired: [] });
});

// ── acceptance 4 — the EXISTING accumulation, healed ────────────────────────────────────────────

test("the twelve-proposal registry shape this task's rationale measured on 2026-08-28 drains to only the findings the current board still supports", () => {
  // Every entry below mirrors the rationale's own measurement: twelve board-review proposals,
  // every one carrying `evidenceAnchors: []`, #3039 and #3043 doubled under both finding shapes,
  // and #3025 (a stale finding) provably dead — its PR merged the day before this fixture's read.
  const twelve: Proposal[] = [
    proposal({ id: "board-review:stale:#3025", originatingItemId: "#3025" }), // merged 2026-08-27
    proposal({ id: "board-review:stale:#2971", originatingItemId: "#2971" }),
    proposal({ id: "board-review:escalation:#3030", originatingItemId: "#3030" }),
    proposal({ id: "board-review:stale:#3039", originatingItemId: "#3039" }),
    proposal({ id: "board-review:escalation:#3039", originatingItemId: "#3039" }),
    proposal({ id: "board-review:stale:#3043", originatingItemId: "#3043" }),
    proposal({ id: "board-review:escalation:#3043", originatingItemId: "#3043" }),
    proposal({ id: "board-review:stale:#3054", originatingItemId: "#3054" }),
    proposal({ id: "board-review:escalation:#3059", originatingItemId: "#3059" }),
    proposal({ id: "board-review:stale:#3063", originatingItemId: "#3063" }),
    proposal({ id: "board-review:escalation:#3065", originatingItemId: "#3065" }),
    // The one entry whose PR is STILL open — the only row the current board still supports.
    proposal({ id: "board-review:stale:#3070", originatingItemId: "#3070" }),
  ];
  assert.equal(twelve.length, 12, "precondition: the fixture matches the rationale's own count");

  const registry = fakeRegistry(twelve);
  // The current board carries only #3070 open — every other referent named above has left it,
  // exactly the "registry whose entries all track currently-open PRs" the falsifier describes NOT
  // being the case pre-fix.
  const result = reconcileBoardReviewReferents({
    items: [item({ id: "#3070" })],
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: registry.updateRegistry,
  });

  assert.equal(result.retiredProposalIds.length, 11, "eleven of the twelve drain in one pass");
  assert.deepEqual(registry.state.map((p) => p.id), ["board-review:stale:#3070"], "only the still-open referent's finding survives");
});
