// test/board-review-wiring.test.ts — W1-T2304's rung, WIRED.
//
// THE DEFECT THIS PINS, MEASURED. #2952 merged 385 lines of correct, tested board-review code on
// 2026-08-26 at 13:54:59Z and it never fired once. Evidence, from the live host:
//
//   * ledger `board_review` rows: 0 all-time, against controls of 89 `measurement_cadence`,
//     519 `run.start` and 118 `digest` over the same union (33 archives, ok: true);
//   * `state/last-board-review.json`: ABSENT, beside five sibling markers including
//     `state/last-measurement-cadence.json` at 147 bytes — same directory, same spine, same shape.
//
// The ledger half of that is weak on its own, because `board-review.ts` has no `log()` hook: a
// fire would have written no row either way. The marker is the load-bearing evidence, and it is
// what the first test below asserts APPEARS.
//
// WHY IT COULD NOT FIRE, by symbol: `buildBoardReview` was reachable only through
// `runMeasurementCadenceReport`'s `opts.boardReview ? … : undefined`, and its one caller —
// `buildMeasurementCadenceDaemonHooks`'s `run` — passed four keys, none of them `boardReview`.
// `DaemonDeps` had no board-review pair. `plan/policy.yaml` had no `boardReview` row. And
// `recordBoardReviewFire`/`boardReviewMarkerPath` were referenced by nothing but their own test.
//
// THE TRIGGER ITSELF IS NOT UNDER TEST HERE AND IS NOT TOUCHED — `decideBoardReviewTrigger` and
// `BOARD_REVIEW_OLDEST_OPEN_AGE_HOURS` (8) are correct and stay as they are. What is under test is
// that a qualifying board now REACHES them from inside the real daemon tick, and that a
// non-qualifying one still produces nothing.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  boardItemsFromOpenPrs,
  boardReviewReportPath,
  buildBoardReviewDaemonHooks,
  defaultBoardReviewItems,
} from "../src/run-task.js";
import { boardReviewMarkerPath, readBoardReviewMarker, type BoardItem } from "../src/lib/board-review.js";
import type { Config } from "../src/lib/config.js";
import type { Policy } from "../src/lib/policy.js";
import type { OpenPrRest } from "../src/lib/open-prs-rest.js";

const NOW = new Date("2026-08-26T16:00:00Z");

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(d, "state"), { recursive: true });
  return d;
}

/** The rung's own policy row, at the values `plan/policy.yaml` now commits. */
const POLICY = { values: { boardReview: { enabled: true, minIntervalMinutes: 120, maxPerDay: 6 } } } as unknown as Policy;

/** A board that QUALIFIES on the age arm — #2895's real shape on 2026-08-26: opened 00:55:37Z,
 *  still open at 16:00Z, so 15.1h, past the 8h threshold. */
const QUALIFYING: BoardItem[] = [
  { id: "#2895", isDraft: false, status: "open", ageHours: 15.1, redCheckCount: 0, unhandledEscalations: 0 },
  { id: "#2971", isDraft: false, status: "open", ageHours: 6.0, redCheckCount: 0, unhandledEscalations: 0 },
];

/** The same board, young. Nothing here reaches any threshold. */
const QUIET: BoardItem[] = [
  { id: "#2971", isDraft: false, status: "open", ageHours: 6.0, redCheckCount: 0, unhandledEscalations: 0 },
];

function hooks(root: string, items: BoardItem[], now = NOW) {
  return buildBoardReviewDaemonHooks({
    config: { root } as unknown as Config,
    policy: POLICY,
    now: () => now,
    items: () => items,
  });
}

// ── THE HEADLINE: the marker that has never existed now appears ────────────────────────────────

void test("a qualifying board fires the rung and WRITES state/last-board-review.json", async () => {
  const root = tmp("rmd-br-fire-");
  try {
    const markerPath = boardReviewMarkerPath(root);
    assert.equal(existsSync(markerPath), false, "precondition: no marker, exactly today's state on the live host");

    const h = hooks(root, QUALIFYING);
    const decision = h.checkBoardReview();
    assert.equal(decision.fire, true, decision.reason);
    assert.match(decision.reason, /15\.1h/);

    const report = await h.runBoardReview();

    assert.equal(existsSync(markerPath), true, "THE MARKER APPEARS — the file whose absence proved the rung dead");
    const marker = readBoardReviewMarker(markerPath);
    assert.equal(marker.kind, "ok");
    assert.deepEqual(marker.kind === "ok" ? marker.marker.fires : [], [NOW.toISOString()]);
    assert.equal(report.fire, true, "and the report is stamped as a FIRE, not as the skip its own re-decision would compute");
    assert.equal(report.oldestOpenAgeHours, 15.1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("the report lands at state/board-review-latest.json, where the wiring says it does", async () => {
  const root = tmp("rmd-br-report-");
  try {
    const path = boardReviewReportPath(root);
    assert.equal(path, join(root, "state", "board-review-latest.json"));
    assert.equal(existsSync(path), false);

    const report = await hooks(root, QUALIFYING).runBoardReview();

    assert.equal(existsSync(path), true, "the artifact exists at the documented path, not at a path only a comment knows");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.fire, true);
    assert.equal(onDisk.oldestOpenAgeHours, 15.1);
    assert.equal(onDisk.generatedAt, report.generatedAt, "the file is the same report the caller was handed, not a second derivation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── THE MARKER BOUNDS THE SECOND FIRE ─────────────────────────────────────────────────────────

void test("the marker prevents a second fire inside minIntervalMinutes, and permits one after", async () => {
  const root = tmp("rmd-br-interval-");
  try {
    await hooks(root, QUALIFYING).runBoardReview();

    const at119 = new Date(NOW.getTime() + 119 * 60_000);
    const inside = hooks(root, QUALIFYING, at119).checkBoardReview();
    assert.equal(inside.fire, false, "119m < the 120m floor");
    assert.match(inside.reason, /119\.0m since the last run/);
    assert.match(inside.reason, /minInterval 120m/);

    const at121 = new Date(NOW.getTime() + 121 * 60_000);
    const outside = hooks(root, QUALIFYING, at121).checkBoardReview();
    assert.equal(outside.fire, true, "121m > the floor — the bound releases, it does not latch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("maxPerDay caps a board that qualifies all day", async () => {
  const root = tmp("rmd-br-cap-");
  try {
    // Six fires, each two hours apart, all inside one 24h window.
    for (let i = 0; i < 6; i += 1) {
      const at = new Date(NOW.getTime() + i * 121 * 60_000);
      const d = hooks(root, QUALIFYING, at).checkBoardReview();
      assert.equal(d.fire, true, `fire ${i + 1} of 6 should be permitted: ${d.reason}`);
      await hooks(root, QUALIFYING, at).runBoardReview();
    }
    const seventh = hooks(root, QUALIFYING, new Date(NOW.getTime() + 6 * 121 * 60_000)).checkBoardReview();
    assert.equal(seventh.fire, false);
    assert.match(seventh.reason, /daily cap reached \(6\/6/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── A NON-QUALIFYING BOARD PRODUCES NOTHING ───────────────────────────────────────────────────

void test("a board below every threshold does not fire and writes no marker", () => {
  const root = tmp("rmd-br-quiet-");
  try {
    const d = hooks(root, QUIET).checkBoardReview();
    assert.equal(d.fire, false);
    assert.match(d.reason, /board younger than every depth threshold/);
    assert.equal(existsSync(boardReviewMarkerPath(root)), false, "no fire, no marker — the zero this whole task is about");
    assert.equal(existsSync(boardReviewReportPath(root)), false, "and no report either: `check` alone writes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("the policy row can switch the rung off without touching code", () => {
  const root = tmp("rmd-br-off-");
  try {
    const off = buildBoardReviewDaemonHooks({
      config: { root } as unknown as Config,
      policy: { values: { boardReview: { enabled: false, minIntervalMinutes: 120, maxPerDay: 6 } } } as unknown as Policy,
      now: () => NOW,
      items: () => QUALIFYING,
    });
    const d = off.checkBoardReview();
    assert.equal(d.fire, false);
    assert.match(d.reason, /board review disabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── THE REAL DAEMON TICK, end to end ──────────────────────────────────────────────────────────

void test("runDaemon calls the pair and ledgers board_review.fired then board_review.ran", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-br-daemon-");
  try {
    const planFile = join(dir, "tasks.yaml");
    writeFileSync(planFile, "- id: T1\n  title: t1\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  files: [src/a.ts]\n");
    const h = hooks(dir, QUALIFYING);
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let stopChecks = 0;

    await runDaemon(
      loadPlan(planFile),
      {
        refreshMerged: () => () => true,
        runOne: async (id: string) => ({ taskId: id, ok: true, merged: true }) as never,
        checkStop: () => { stopChecks += 1; return stopChecks > 2 ? "test bound reached" : undefined; },
        sleep: async () => {},
        checkBoardReview: h.checkBoardReview,
        runBoardReview: h.runBoardReview,
        log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra: extra ?? {} }),
      } as never,
      { laneCount: 1 },
    );

    const steps = lines.map((l) => l.step);
    assert.ok(steps.includes("board_review.fired"), `the tick must reach the rung: ${JSON.stringify([...new Set(steps)])}`);
    assert.ok(steps.includes("board_review.ran"), "and must run it");
    const ran = lines.find((l) => l.step === "board_review.ran")!;
    assert.equal(ran.extra.oldestOpenAgeHours, 15.1, "the ledger row carries the counts, so 'has it fired' is a one-line read");
    assert.equal(existsSync(boardReviewMarkerPath(dir)), true);
    // The SECOND tick is inside the interval, so the rung reports a skip rather than firing twice.
    assert.ok(steps.filter((s) => s === "board_review.fired").length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a throwing rung costs one logged tick, never the daemon", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-br-throw-");
  try {
    const planFile = join(dir, "tasks.yaml");
    writeFileSync(planFile, "- id: T1\n  title: t1\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  files: [src/a.ts]\n");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let stopChecks = 0;
    const summary = await runDaemon(
      loadPlan(planFile),
      {
        refreshMerged: () => () => true,
        runOne: async (id: string) => ({ taskId: id, ok: true, merged: true }) as never,
        checkStop: () => { stopChecks += 1; return stopChecks > 2 ? "test bound reached" : undefined; },
        sleep: async () => {},
        checkBoardReview: () => { throw new Error("simulated board read failure"); },
        log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra: extra ?? {} }),
      } as never,
      { laneCount: 1 },
    );
    assert.ok(summary, "the daemon still returned");
    assert.ok(lines.some((l) => l.step === "board_review.check_failed"), "and the failure is named, not swallowed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── THE ITEMS READER: every field's fail direction ────────────────────────────────────────────

void test("boardItemsFromOpenPrs maps age, draft and reds, and fails in the safe direction", () => {
  const rows: OpenPrRest[] = [
    { number: 1, url: "u1", headRefName: "b1", headRefOid: "s1", updatedAt: "", body: "", autoMergeRequest: null,
      createdAt: "2026-08-26T00:55:37Z", isDraft: false,
      statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] as never },
    { number: 2, url: "u2", headRefName: "b2", headRefOid: "s2", updatedAt: "", body: "", autoMergeRequest: null,
      createdAt: "2026-08-26T15:00:00Z", isDraft: true, statusCheckRollup: [] },
    // NO createdAt, and an UNREADABLE rollup — both must fail toward silence.
    { number: 3, url: "u3", headRefName: "b3", headRefOid: "s3", updatedAt: "", body: "", autoMergeRequest: null,
      rollupUnreadable: true },
  ];
  const items = boardItemsFromOpenPrs(
    rows,
    NOW,
    new Map([[2, {
      title: "board-review: #2895 has sat open",
      issueUrl: "https://github.com/o/r/issues/9",
      openedAt: "2026-08-25T20:00:00Z",
    }]]),
  );

  assert.equal(items[0]!.ageHours.toFixed(1), "15.1", "#2895's real age on the day this rung stayed asleep");
  assert.equal(items[0]!.redCheckCount, 1);
  assert.equal(items[0]!.isDraft, false);
  assert.equal(items[1]!.isDraft, true);
  assert.equal(items[1]!.unhandledEscalations, 1, "joined from the projection by PR number");
  assert.equal(items[1]!.escalationTitle, "board-review: #2895 has sat open", "W1-T2453: the ask threads through, not just the count");
  assert.equal(items[1]!.escalationIssueUrl, "https://github.com/o/r/issues/9", "W1-T2453: the link threads through too");
  assert.equal(items[1]!.escalationOpenedAt, "2026-08-25T20:00:00Z", "W1-T2466: the escalation's own opened-at threads through too");
  assert.equal(items[2]!.ageHours, 0, "an unknown age is ZERO, never infinity — it must not manufacture a stale finding");
  assert.equal(items[2]!.redCheckCount, 0, "an unreadable rollup is not evidence of a red check");
  assert.equal(items[2]!.escalationTitle, undefined, "no escalation for #3 — no title manufactured either");
  assert.equal(items[2]!.escalationOpenedAt, undefined, "no escalation for #3 — no opened-at manufactured either");
});

// ── W1-T2453 acceptance 2: naming costs ZERO additional reads — the ask/url come from the SAME
// `projectPlan` call `unhandledEscalations` already consumed, never a second GitHub/ledger read ──

void test("defaultBoardReviewItems threads escalationTitle/escalationIssueUrl/escalationUnverified/escalationOpenedAt from the ONE projectPlan call, no second read", () => {
  const root = tmp("rmd-br-name-");
  try {
    let projectPlanCalls = 0;
    const items = defaultBoardReviewItems({ root } as unknown as Config, {
      resolveOwnerRepo: () => ({ owner: "o", repo: "r" }),
      fetchOpenPrs: () => [
        { number: 41, url: "u41", headRefName: "b41", headRefOid: "s41", updatedAt: "", body: "", autoMergeRequest: null,
          createdAt: "2026-08-26T15:00:00Z", isDraft: false, statusCheckRollup: [] },
        { number: 42, url: "u42", headRefName: "b42", headRefOid: "s42", updatedAt: "", body: "", autoMergeRequest: null,
          createdAt: "2026-08-26T15:00:00Z", isDraft: false, statusCheckRollup: [] },
      ],
      loadPlan: () => ({ tasks: [] }) as never,
      projectPlan: () => {
        projectPlanCalls += 1;
        return new Map([
          ["T1", { needsHuman: true, prNumber: 41, escalationTitle: "[fix] T1: red base check", escalationIssueUrl: "https://github.com/o/r/issues/41", escalationOpenedAt: "2026-08-26T10:00:00Z" }],
          ["T2", { needsHuman: true, prNumber: 42, escalationUnverified: true }],
        ]) as never;
      },
      now: () => NOW,
    });

    assert.equal(projectPlanCalls, 1, "ONE projection read serves both the count and the naming — no second read to name it");
    const named = items.find((it) => it.id === "#41")!;
    assert.equal(named.escalationTitle, "[fix] T1: red base check", "the ask threads through unread");
    assert.equal(named.escalationIssueUrl, "https://github.com/o/r/issues/41", "the link threads through unread");
    assert.equal(named.escalationOpenedAt, "2026-08-26T10:00:00Z", "W1-T2466: the escalation's own opened-at threads through unread too");
    const unverified = items.find((it) => it.id === "#42")!;
    assert.equal(unverified.unhandledEscalations, 1, "still a finding — never dropped for being unverified");
    assert.equal(unverified.escalationTitle, undefined, "no title could be read, so none is manufactured");
    assert.equal(unverified.escalationUnverified, true, "the honest-absence flag threads through unread");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("defaultBoardReviewItems degrades to an empty board rather than throwing the tick", () => {
  const root = tmp("rmd-br-io-");
  try {
    const items = defaultBoardReviewItems({ root } as unknown as Config, {
      resolveOwnerRepo: () => ({ owner: "o", repo: "r" }),
      fetchOpenPrs: () => { throw new Error("github is down"); },
      now: () => NOW,
    });
    assert.deepEqual(items, [], "an outage yields no items, which yields no fire — a missed report, never a dead loop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T2465: the recursion bound made REACHABLE from the production read path ──────────────────
//
// `originatesFromProposalId` (design (iv), `lib/board-review.ts`) had exactly three references
// in `src/` before this task — the doc, the interface member and `boardItemsInScope`'s reader —
// and zero writers. `boardItemsFromOpenPrs` is the only production `BoardItem` constructor, so
// the tests below drive it (and `defaultBoardReviewItems`, its one real caller) rather than
// building a `BoardItem` by hand, which is exactly the test-only seam the task's own falsifier
// rules out as proof.

function planWithOrigin(taskId: string, origin: string | undefined) {
  return { tasks: [], byId: new Map([[taskId, { id: taskId, origin }]]) } as never;
}

void test("boardItemsFromOpenPrs marks an item whose origin lookup names a board-review proposal, and boardItemsInScope excludes it while open", async () => {
  const { boardItemsInScope } = await import("../src/lib/board-review.js");
  const rows: OpenPrRest[] = [
    { number: 100, url: "u100", headRefName: "b100", headRefOid: "s100", updatedAt: "", body: "", autoMergeRequest: null,
      createdAt: "2026-08-26T00:00:00Z", isDraft: false, statusCheckRollup: [] },
  ];
  const items = boardItemsFromOpenPrs(rows, NOW, new Map(), new Map([[100, "board-review:escalation:#3227"]]));
  assert.equal(items[0]!.originatesFromProposalId, "board-review:escalation:#3227", "the field this rung's own report field depends on is now WRITTEN by production code");

  const inScope = boardItemsInScope(items);
  assert.deepEqual(inScope, [], "the pure filter — already unit-proven, untouched by this task — now has something real to exclude");
});

void test("defaultBoardReviewItems marks self-produced from the SAME projectPlan call the escalation arm already reads, no second read", () => {
  const root = tmp("rmd-br-self-");
  try {
    let projectPlanCalls = 0;
    const items = defaultBoardReviewItems({ root } as unknown as Config, {
      resolveOwnerRepo: () => ({ owner: "o", repo: "r" }),
      fetchOpenPrs: () => [
        { number: 200, url: "u200", headRefName: "b200", headRefOid: "s200", updatedAt: "", body: "", autoMergeRequest: null,
          createdAt: "2026-08-26T15:00:00Z", isDraft: false, statusCheckRollup: [] },
      ],
      loadPlan: () => planWithOrigin("T200", "board-review:stale:#100"),
      projectPlan: () => {
        projectPlanCalls += 1;
        return new Map([["T200", { taskId: "T200", prNumber: 200, needsHuman: false }]]) as never;
      },
      now: () => NOW,
    });

    assert.equal(projectPlanCalls, 1, "ONE projection read serves the escalation arm and the self-produced join both — no second read to join it");
    assert.equal(
      items[0]!.originatesFromProposalId,
      "board-review:stale:#100",
      "reachable from the production read path — no injected BoardItem fixture, no test-only constructor",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("an ordinary PR, and a PR whose task carries any other origin, are never marked self-produced", () => {
  const root = tmp("rmd-br-other-origin-");
  try {
    const items = defaultBoardReviewItems({ root } as unknown as Config, {
      resolveOwnerRepo: () => ({ owner: "o", repo: "r" }),
      fetchOpenPrs: () => [
        { number: 300, url: "u300", headRefName: "b300", headRefOid: "s300", updatedAt: "", body: "", autoMergeRequest: null,
          createdAt: "2026-08-26T15:00:00Z", isDraft: false, statusCheckRollup: [] },
        { number: 301, url: "u301", headRefName: "b301", headRefOid: "s301", updatedAt: "", body: "", autoMergeRequest: null,
          createdAt: "2026-08-26T15:00:00Z", isDraft: false, statusCheckRollup: [] },
      ],
      loadPlan: () =>
        ({
          tasks: [],
          byId: new Map([
            ["T300", { id: "T300", origin: "feedback#42" }],
            // No task at all for #301 — the join must degrade to unmarked, not throw.
          ]),
        }) as never,
      projectPlan: () =>
        new Map([
          ["T300", { taskId: "T300", prNumber: 300, needsHuman: false }],
          ["T301", { taskId: "T301", prNumber: 301, needsHuman: false }],
        ]) as never,
      now: () => NOW,
    });

    assert.equal(items[0]!.originatesFromProposalId, undefined, "an origin outside the board-review namespace is never read as this rung's own proposal");
    assert.equal(items[1]!.originatesFromProposalId, undefined, "a PR whose task cannot be resolved at all is left unmarked, not treated as self-produced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("an unreadable plan or projection leaves every item UNMARKED, never wrongly self-produced", () => {
  const root = tmp("rmd-br-degrade-");
  try {
    const rows: OpenPrRest[] = [
      { number: 400, url: "u400", headRefName: "b400", headRefOid: "s400", updatedAt: "", body: "", autoMergeRequest: null,
        createdAt: "2026-08-26T15:00:00Z", isDraft: false, statusCheckRollup: [] },
    ];
    const items = defaultBoardReviewItems({ root } as unknown as Config, {
      resolveOwnerRepo: () => ({ owner: "o", repo: "r" }),
      fetchOpenPrs: () => rows,
      loadPlan: () => { throw new Error("plan unreadable"); },
      now: () => NOW,
    });
    assert.equal(items.length, 1, "the open-PR read still succeeds — only the join degrades");
    assert.equal(items[0]!.originatesFromProposalId, undefined, "a degraded read leaves the item unmarked, the fail-open direction the task requires");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── READ-ONLY, and asserted rather than promised ──────────────────────────────────────────────

void test("the wiring passes no rerunDeadCheck, so the rung takes no action at all", async () => {
  const root = tmp("rmd-br-ro-");
  try {
    let sawRerun: unknown;
    await buildBoardReviewDaemonHooks({
      config: { root } as unknown as Config,
      policy: POLICY,
      now: () => NOW,
      items: () => [{ id: "#9", isDraft: false, status: "open", ageHours: 20, redCheckCount: 0, unhandledEscalations: 0, deadBeforeTestBody: true }],
      build: (opts) => { sawRerun = opts.rerunDeadCheck; return { generatedAt: "", fire: true, reason: "", oldestOpenAgeHours: 0, redCount: 0, unhandledEscalationCount: 0, itemsConsidered: 0, itemsExcludedAsSelfProduced: 0, proposalIds: [] }; },
    }).runBoardReview();
    assert.equal(sawRerun, undefined, "even with a dead-check item present, no action hook is supplied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── THE LINE WHOSE ABSENCE WAS THE WHOLE DEFECT ───────────────────────────────────────────────

void test("daemonCommand actually names the pair in its DaemonDeps literal", () => {
  // A SOURCE ASSERTION, DELIBERATELY, AND IT IS THE RIGHT SHAPE FOR THIS DEFECT. Every test above
  // passes the hooks in by hand, so all of them would still pass against a `daemonCommand` that
  // never constructs them — which is EXACTLY the state #2952 shipped in, and #1066 before it, and
  // the pre-merge `review.unwired_advisory` rows on W1-T2304 named it three times before merge.
  // The producer/consumer seam cannot be reached from a unit test without booting a real daemon
  // against a real GitHub, so the seam is pinned where it lives: in the text of the call site.
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  assert.match(src, /const boardReviewHooks = target\.isSelf \? buildBoardReviewDaemonHooks\(\{ config \}\) : undefined;/);
  assert.match(src, /checkBoardReview: boardReviewHooks\?\.checkBoardReview,/);
  assert.match(src, /runBoardReview: boardReviewHooks\?\.runBoardReview,/);
  const daemon = readFileSync(new URL("../src/lib/daemon.ts", import.meta.url), "utf8");
  assert.match(daemon, /if \(deps\.checkBoardReview\) \{/, "and the consumer half exists in the tick");
  assert.match(daemon, /log\("board_review\.ran"/, "and emits the row that makes 'has it fired' a ledger read");
});

void test("plan/policy.yaml commits the row the loader reads, at the derived values", () => {
  // The policy row is data, not code: without it the loader falls back to its default and the
  // committed file says nothing about why 120/6. Pinned so a future edit to either side is
  // visible rather than silently divergent.
  const yaml = readFileSync(new URL("../plan/policy.yaml", import.meta.url), "utf8");
  assert.match(yaml, /^boardReview:$/m);
  const row = yaml.slice(yaml.indexOf("\nboardReview:\n"));
  assert.match(row.slice(0, 400), /minIntervalMinutes:\n\s+value: 120/);
  assert.match(row.slice(0, 400), /maxPerDay:\n\s+value: 6/);
});
