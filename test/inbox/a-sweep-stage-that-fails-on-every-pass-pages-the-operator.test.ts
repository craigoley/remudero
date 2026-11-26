// W1-T13255: from 2026-11-10 to 2026-11-16 the full sweep's escalation-answers stage failed on every pass, so no
// operator answer was applied for six days, and the only sign was a ledger row per pass. These suites drive the real
// `buildSweepHook` and the real async issue gateway over a `gh` stand-in, and the watch itself over a recording
// gateway. FIXTURES ONLY: the ledger, the state root and `gh` live in throwaway directories.
import "#src/lib/live-analytics-snapshot-cache.js";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildSweepHook } from "#src/cli/commands/sweep.js";
import type { Clock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import type { AsyncIssueGateway } from "#src/lib/escalate.js";
import type { EscalationAnswerGateway } from "#src/lib/escalation-answers.js";
import {
  createSweepStageWatch, sweepStageStreakBound, sweepStageStreakState, SWEEP_STAGE_CLEARED_STEP, SWEEP_STAGE_ESCALATED_STEP,
  SWEEP_STAGE_FAILED_STEP, SWEEP_STAGE_RECOVERED_STEP, SWEEP_STAGE_STREAK_FALLBACK_PASSES, SWEEP_STAGE_STREAK_MIN_SAMPLES,
  SWEEP_STAGE_STREAK_SLICE, SWEEP_STAGE_STREAK_WINDOW_MS,
} from "#src/lib/escalation-catalogue.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { readLedgerLines } from "#src/lib/status.js";
import { withGhShim, type GhShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
// W1-T14998: an escalation files in the host's escalation repository; this suite's gh fixture answers for fixture/repo.
process.env.RMD_ESCALATION_REPOSITORY ??= "fixture/repo";

const ISSUE_URL = "https://github.com/fixture/repo/issues/77";
/** What the real reader rethrows when an issue body cannot be read (W1-T11405 names the stage and the kind). */
const ANSWERS_ERROR = "escalation answers failed at stage answer_parse: Error";
const WATCH_STEPS: readonly string[] = SWEEP_STAGE_STREAK_SLICE.steps;

type Row = Record<string, unknown>;
/** A row's own fields, without the envelope every ledger row carries. */
function fields(row: Row | undefined): Row {
  const { ts: _ts, host: _host, actor_pid: _pid, actor: _actor, gardener_origin: _origin, run_id: _run, task_id: _task, pass_id: _pass, ...own } = row ?? {};
  return own;
}

// ── the real sweep hook ───────────────────────────────────────────────────────────────────────────────────────────

type AnswersMode = "fail" | "clean" | "unreadable";

/** The real full-pass hook over a private root. Only unrelated sibling ports are fake; an unreadable PR snapshot ends
 *  each pass after its prelude, so one pass costs milliseconds. */
function sweepFixture(t: TestContext) {
  const root = ownedFixtureDir(t, "sweep-stage-watch").dir;
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const logs: Array<{ step: string; extra: Row }> = [];
  const f = {
    root, ledgerPath, logs, drafts: 0,
    answers: "clean" as AnswersMode,
    mainHealth: undefined as (() => Promise<void>) | undefined,
    rows: (step?: string): Row[] => readLedgerLines(ledgerPath).filter((r) => step === undefined ? WATCH_STEPS.includes(String(r.step)) : r.step === step),
    logged: (step: string): Row[] => logs.filter((l) => l.step === step).map((l) => l.extra),
    /** A daemon start: a new hook, so nothing but the ledger carries over. */
    boot: (): (() => Promise<unknown>) => {
      const hook = buildSweepHook(host as never, "fixture", "repo", { root, claudeBin: "/bin/true" } as Config, ledgerPath, "W13255-SWEEP",
        { tasks: [], byId: new Map() }, (step, extra = {}) => { logs.push({ step, extra }); }, undefined, board as never, undefined, undefined,
        f.mainHealth === undefined ? undefined : () => f.mainHealth!(), undefined, undefined, undefined, undefined, root, undefined, gateway, undefined,
        (() => ({ openPrError: "fixture-board-unreadable" })) as never);
      return () => withLiveWritesAllowed(() => hook());
    },
  };
  const host = {
    buildInboxDraftHook: () => async () => { f.drafts++; },
    createPlanFilingClassificationTelemetry: () => () => {},
    buildEscalationTriageRuntime: () => ({}),
  };
  const board = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined, listOpenHeadBranches: () => [] };
  const gateway: EscalationAnswerGateway = {
    listOpen: () => {
      if (f.answers === "unreadable") throw new Error("fixture list unreadable");
      return f.answers === "clean" ? []
        : [{ number: 41, url: "fixture-issue", get body(): string { throw new Error("fixture stage failure"); } }];
    },
    listComments: () => [],
    reactPlusOne: () => {},
  };
  return f;
}

/** `gh` answers an empty issue list and one issue URL; every other call succeeds quietly. */
function withGh<T>(body: (shim: GhShim) => Promise<T>): Promise<T> {
  return withGhShim([{ when: "issue create", stdout: ISSUE_URL }, { when: "issues?", stdout: "[]" }], body, { kind: "sweep-stage-gh" });
}
const ghCalls = (shim: GhShim, verb: string): string[] => shim.calls().filter((call) => call.startsWith(verb));

async function passes(pass: () => Promise<unknown>, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await pass();
}

test("W1-T13255 criterion 1: a stage that fails on every pass for longer than its derived bound opens one needs-human issue naming the stage, the error, the first failure and the pass count", async (t) => {
  await t.test("with no recovered streaks the named fallback applies, and the streak is read back across a restart", async (s) => {
    await withGh(async (shim) => {
      const f = sweepFixture(s);
      f.answers = "fail";
      await passes(f.boot(), 3);
      const afterRestart = f.boot();
      await afterRestart();
      assert.equal(f.rows(SWEEP_STAGE_FAILED_STEP).length, SWEEP_STAGE_STREAK_FALLBACK_PASSES, "control: four failing passes are on the ledger");
      assert.deepEqual(shim.calls(), [], "a streak inside the fallback bound reaches GitHub not at all");
      await afterRestart();
      const failed = f.rows(SWEEP_STAGE_FAILED_STEP);
      const opened = f.rows(SWEEP_STAGE_ESCALATED_STEP);
      assert.equal(opened.length, 1);
      assert.deepEqual(fields(opened[0]), {
        step: SWEEP_STAGE_ESCALATED_STEP, stage: "escalation_answers", first_failure_ts: failed[0].ts, passes: 5, error: ANSWERS_ERROR,
        bound_passes: SWEEP_STAGE_STREAK_FALLBACK_PASSES, bound_basis: "fallback", bound_samples: 0, history_read: true, issue_url: ISSUE_URL, delivered: true,
      });
      assert.equal(ghCalls(shim, "issue create").length, 1, "one issue");
      const sent = shim.calls().join("\n");
      assert.ok(sent.includes("--label needs-human"), "on the needs-human queue");
      assert.ok(sent.includes("--label escalation-hard-stop"), "in a class the triage never digests");
      for (const named of ["sweep stage escalation_answers fails on every pass", `Its last error: ${ANSWERS_ERROR}.`,
        `failed on 5 passes since ${String(failed[0].ts)}`, "SWEEP_STAGE_STREAK_FALLBACK_PASSES"]) {
        assert.ok(sent.includes(named), `the issue names: ${named}`);
      }
    });
  });

  await t.test("with five recovered streaks the bound is their p90, not the fallback", async (s) => {
    await withGh(async (shim) => {
      const f = sweepFixture(s);
      const pass = f.boot();
      for (let streak = 0; streak < SWEEP_STAGE_STREAK_MIN_SAMPLES; streak++) {
        f.answers = "fail";
        await pass();
        f.answers = "clean";
        await pass();
      }
      assert.deepEqual(f.rows(SWEEP_STAGE_RECOVERED_STEP).map((r) => r.passes), [1, 1, 1, 1, 1], "control: five one-pass streaks recovered");
      f.answers = "fail";
      await pass();
      assert.deepEqual(shim.calls(), [], "a one-pass streak is one the stage has recovered from");
      await pass();
      const opened = f.rows(SWEEP_STAGE_ESCALATED_STEP);
      assert.equal(opened.length, 1, "the second failing pass outlasts every streak it recovered from");
      assert.deepEqual([opened[0].passes, opened[0].bound_passes, opened[0].bound_basis, opened[0].bound_samples], [2, 1, "p90", 5]);
      const sent = shim.calls().join("\n");
      assert.ok(sent.includes("the p90 length (1 passes) of the 5 failure streaks"), "the issue says which bound applied");
      assert.ok(!sent.includes("SWEEP_STAGE_STREAK_FALLBACK_PASSES"));
    });
  });
});

test("W1-T13255 criterion 2: the issue is opened once per streak and closed by the stage's next success, with a ledger row for each", async (t) => {
  await withGh(async (shim) => {
    const f = sweepFixture(t);
    const pass = f.boot();
    f.answers = "fail";
    await passes(pass, 7);
    assert.equal(ghCalls(shim, "issue create").length, 1, "three more failing passes open nothing more");
    assert.equal(f.rows(SWEEP_STAGE_ESCALATED_STEP).length, 1, "one row for the open");
    assert.equal(ghCalls(shim, "issue close").length, 0, "control: nothing closes while the stage fails");

    f.answers = "unreadable";
    await pass();
    assert.equal(ghCalls(shim, "issue close").length, 0, "a pass that read nothing is not a success");
    assert.equal(f.rows(SWEEP_STAGE_CLEARED_STEP).length, 0);

    f.answers = "clean";
    await passes(pass, 2);
    const closes = ghCalls(shim, "issue close");
    assert.equal(closes.length, 1, "closed once, by the first clean pass");
    assert.ok(closes[0].startsWith(`issue close ${ISSUE_URL} `), closes[0]);
    const cleared = f.rows(SWEEP_STAGE_CLEARED_STEP);
    assert.equal(cleared.length, 1, "one row for the close");
    assert.deepEqual(fields(cleared[0]), {
      step: SWEEP_STAGE_CLEARED_STEP, stage: "escalation_answers", first_failure_ts: f.rows(SWEEP_STAGE_FAILED_STEP)[0].ts, passes: 7,
      issue_url: ISSUE_URL, delivered: true,
    });

    f.answers = "fail";
    await passes(pass, 5);
    assert.equal(ghCalls(shim, "issue create").length, 2, "a new streak past its bound is a new issue");
    assert.deepEqual(f.rows(SWEEP_STAGE_ESCALATED_STEP).map((r) => [r.passes, r.bound_basis, r.bound_samples]), [[5, "fallback", 0], [5, "fallback", 0]],
      "a streak that paged teaches no bound");
  });
});

test("W1-T13255 criterion 3: a passing or flickering stage opens nothing, and the sweep continues past a failing stage as before", async (t) => {
  await t.test("a stage that succeeds writes no row and reaches GitHub not at all", async (s) => {
    await withGh(async (shim) => {
      const f = sweepFixture(s);
      await passes(f.boot(), 3);
      assert.deepEqual(f.rows(), []);
      assert.deepEqual(shim.calls(), []);
      assert.deepEqual(f.logged("escalation_answers.error"), []);
    });
  });

  await t.test("a streak no longer than the bound recovers with one row and no issue", async (s) => {
    await withGh(async (shim) => {
      const f = sweepFixture(s);
      const pass = f.boot();
      for (let flicker = 0; flicker < 3; flicker++) {
        f.answers = "fail";
        await passes(pass, SWEEP_STAGE_STREAK_FALLBACK_PASSES);
        f.answers = "clean";
        await pass();
      }
      assert.deepEqual(f.rows(SWEEP_STAGE_RECOVERED_STEP).map((r) => r.passes), [4, 4, 4]);
      assert.equal(f.rows(SWEEP_STAGE_FAILED_STEP).length, 12, "control: the failing passes were seen");
      assert.deepEqual(f.rows(SWEEP_STAGE_ESCALATED_STEP), []);
      assert.deepEqual(shim.calls(), []);
    });
  });

  await t.test("a failing stage is logged as before and the pass goes on to its end", async (s) => {
    await withGh(async () => {
      const f = sweepFixture(s);
      f.answers = "fail";
      await assert.doesNotReject(f.boot()());
      assert.deepEqual(f.logged("escalation_answers.error"), [{ error: ANSWERS_ERROR }], "the stage's own error row is unchanged");
      assert.deepEqual(f.logged("sweep.error"), [{ error: "fixture-board-unreadable" }], "the pass went on past its prelude");
      assert.equal(f.logged("sweep.full_prelude").length, 1);
      assert.equal(f.drafts, 1, "and finished its cycle");
      assert.deepEqual(f.logged("sweep.stage_watch.error"), []);
    });
  });

  await t.test("a watch that cannot write its row is named and the pass still goes on", async (s) => {
    await withGh(async (shim) => {
      const f = sweepFixture(s);
      mkdirSync(f.ledgerPath, { recursive: true });
      f.answers = "fail";
      await assert.doesNotReject(f.boot()());
      const errors = f.logged("sweep.stage_watch.error");
      assert.equal(errors.length, 1);
      assert.equal(errors[0].stage, "escalation_answers");
      assert.match(String(errors[0].error), /EISDIR/);
      assert.deepEqual(f.logged("escalation_answers.error"), [{ error: ANSWERS_ERROR }]);
      assert.deepEqual(f.logged("sweep.error"), [{ error: "fixture-board-unreadable" }]);
      assert.equal(f.drafts, 1);
      assert.deepEqual(shim.calls(), []);
    });
  });
});

test("W1-T13255: the main-health stage is watched the same way, and a stage that did not run is not", async (t) => {
  await withGh(async (shim) => {
    const f = sweepFixture(t);
    await f.boot()();
    assert.deepEqual(f.rows(), [], "no main-health rung: nothing observed");
    f.mainHealth = async () => { throw new Error("fixture observer exploded"); };
    const pass = f.boot();
    await pass();
    assert.deepEqual(f.logged("main.health.error"), [{ error: "fixture observer exploded" }]);
    assert.deepEqual(f.rows().map(fields), [{ step: SWEEP_STAGE_FAILED_STEP, stage: "main_health", error: "fixture observer exploded" }]);
    f.mainHealth = async () => {};
    await pass();
    const recovered = f.rows(SWEEP_STAGE_RECOVERED_STEP);
    assert.deepEqual(recovered.map(fields), [{ step: SWEEP_STAGE_RECOVERED_STEP, stage: "main_health",
      first_failure_ts: f.rows(SWEEP_STAGE_FAILED_STEP)[0].ts, passes: 1 }]);
    assert.deepEqual(shim.calls(), []);
  });
});

// ── the watch itself ──────────────────────────────────────────────────────────────────────────────────────────────

const BASE_MS = Date.UTC(2026, 10, 16, 12);
const PASS_MS = 15 * 60_000;

/** The watch over a recording gateway and a clock that steps one pass per observation. */
function watchFixture(t: TestContext, close: "works" | "absent" | "throws" = "works") {
  const root = ownedFixtureDir(t, "sweep-stage-catalogue").dir;
  const ledgerPath = join(root, "state", "ledger.ndjson");
  let ms = BASE_MS;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const created: Array<{ title: string; body: string; labels: string[] }> = [];
  const closed: Array<{ url: string; comment: string }> = [];
  const issues: AsyncIssueGateway = {
    create: (title, body, labels) => {
      created.push({ title, body, labels });
      if (f.createFails) throw new Error("fixture create refused");
      return ISSUE_URL;
    },
    ...(close === "absent" ? {} : { closeWithComment: (url: string, comment: string) => {
      closed.push({ url, comment });
      if (close === "throws") throw new Error("fixture close refused");
    } }),
  };
  /** A daemon start: a new watch over the same ledger, knowing nothing but what it can read. */
  const start = () => createSweepStageWatch({
    owner: "fixture", repo: "repo", ledgerPath, runId: "W13255-WATCH", clock, issues,
    history: async (stateDir) => {
      assert.equal(stateDir, join(root, "state"), "the history is read from the ledger's own directory");
      f.reads++;
      return { ok: f.historyOk, rows: f.historyOk ? readLedgerLines(ledgerPath) : [] };
    },
  });
  let watch = start();
  const observe = async (count: number, outcome: Parameters<typeof watch>[1]): Promise<void> => {
    for (let i = 0; i < count; i++) { ms += PASS_MS; await watch("fixture_stage", outcome); }
  };
  const f = {
    historyOk: true, createFails: false, reads: 0, created, closed,
    rows: (step?: string): Row[] => readLedgerLines(ledgerPath).filter((r) => step === undefined ? WATCH_STEPS.includes(String(r.step)) : r.step === step),
    state: () => sweepStageStreakState(readLedgerLines(ledgerPath), "fixture_stage", ms),
    restart: (): void => { watch = start(); },
    fail: (count = 1): Promise<void> => observe(count, { error: "fixture stage error" }),
    clean: (count = 1): Promise<void> => observe(count, { clean: true }),
    unobserved: (): Promise<void> => observe(1, { clean: false }),
  };
  return f;
}

const FIRST_FAILURE_TS = new Date(BASE_MS + PASS_MS).toISOString();

test("W1-T13255: with its streak history unreadable the watch pages from the passes this process saw, and closes what it opened", async (t) => {
  const f = watchFixture(t);
  f.historyOk = false;
  await f.fail(SWEEP_STAGE_STREAK_FALLBACK_PASSES);
  assert.equal(f.created.length, 0, "control: four failing passes are inside the fallback");
  await f.fail();
  assert.equal(f.created.length, 1, "an unreadable history does not silence the page");
  assert.deepEqual(f.rows(SWEEP_STAGE_ESCALATED_STEP).map((r) => [r.passes, r.first_failure_ts, r.bound_basis, r.history_read, r.delivered]),
    [[5, FIRST_FAILURE_TS, "fallback", false, true]]);
  assert.match(f.created[0].body, /streak history could not be read, so the count is only the passes this daemon process saw/);
  await f.fail(2);
  assert.equal(f.created.length, 1, "once per streak, read or not");
  await f.clean();
  assert.deepEqual(f.closed.map((c) => c.url), [ISSUE_URL], "the issue this process opened is closed without the history");
  assert.equal(f.rows(SWEEP_STAGE_CLEARED_STEP).length, 1);
  const reads = f.reads;
  await f.clean();
  assert.equal(f.reads, reads + 1, "not settled until a clean pass can read what an earlier process may have left");
  f.historyOk = true;
  await f.clean(3);
  assert.equal(f.reads, reads + 2, "then a settled stage's clean passes read nothing");
  assert.equal(f.rows().length, 7 + 1 + 1, "and no clean pass after the close wrote a row");
});

test("W1-T13255: a streak an earlier process left is counted, and its issue closed, once the history reads", async (t) => {
  const f = watchFixture(t);
  await f.fail(3);
  f.restart();
  f.historyOk = false;
  await f.fail(2);
  assert.equal(f.created.length, 0, "unread, the count is this process's own two passes");
  f.historyOk = true;
  await f.fail();
  assert.equal(f.created.length, 1, "read, the streak is all six");
  const opened = f.rows(SWEEP_STAGE_ESCALATED_STEP);
  assert.deepEqual([opened[0].passes, opened[0].first_failure_ts, opened[0].history_read], [6, FIRST_FAILURE_TS, true]);
  assert.equal(f.created[0].title, "[HARD_STOP] daemon: sweep stage fixture_stage fails on every pass");
  assert.match(f.created[0].body, /failed on 6 passes since 2026-11-16T12:15:00\.000Z/);
  assert.match(f.created[0].body, /Its last error: fixture stage error\./);

  f.restart();
  f.historyOk = false;
  await f.clean();
  assert.equal(f.closed.length, 0, "an issue an earlier process opened waits for a clean pass that can read it");
  assert.equal(f.rows(SWEEP_STAGE_CLEARED_STEP).length, 0);
  f.historyOk = true;
  await f.clean();
  assert.deepEqual(f.closed.map((c) => c.url), [ISSUE_URL]);
  assert.match(f.closed[0].comment, /fixture_stage stage completed a clean pass/);
  assert.deepEqual(f.rows(SWEEP_STAGE_CLEARED_STEP).map((r) => [r.passes, r.first_failure_ts, r.delivered]), [[6, FIRST_FAILURE_TS, true]]);
});

test("W1-T13255: an undelivered page is retried on the next failing pass, and a streak that tried to page teaches no bound", async (t) => {
  await t.test("retried until delivered, then once per streak", async (s) => {
    const f = watchFixture(s);
    f.createFails = true;
    await f.fail(5);
    assert.deepEqual(f.rows(SWEEP_STAGE_ESCALATED_STEP).map((r) => [r.passes, r.issue_url, r.delivered]), [[5, null, false]]);
    f.createFails = false;
    await f.fail(2);
    assert.deepEqual(f.rows(SWEEP_STAGE_ESCALATED_STEP).map((r) => [r.passes, r.issue_url, r.delivered]), [[5, null, false], [6, ISSUE_URL, true]]);
    assert.equal(f.created.length, 2, "one refused attempt and one delivery, none after");
  });
  await t.test("a streak whose page never arrived is not a recovered sample", async (s) => {
    const f = watchFixture(s);
    f.createFails = true;
    await f.fail(5);
    await f.clean();
    assert.deepEqual(f.rows(SWEEP_STAGE_RECOVERED_STEP).map((r) => r.passes), [5], "control: it ended with no issue to close");
    assert.deepEqual(f.state().recovered, []);
    assert.equal(f.closed.length, 0);
  });
});

test("W1-T13255: a gateway that cannot close, or whose close throws, costs one undelivered cleared row and no throw", async (t) => {
  for (const [close, failure] of [["absent", "issue gateway cannot close issues"], ["throws", "fixture close refused"]] as const) {
    await t.test(close, async (s) => {
      const f = watchFixture(s, close);
      await f.fail(5);
      await assert.doesNotReject(f.clean(2));
      assert.deepEqual(f.rows(SWEEP_STAGE_CLEARED_STEP).map(fields), [{ step: SWEEP_STAGE_CLEARED_STEP, stage: "fixture_stage",
        first_failure_ts: FIRST_FAILURE_TS, passes: 5, issue_url: ISSUE_URL, delivered: false, failure }]);
      assert.equal(f.closed.length, close === "throws" ? 1 : 0, "one attempt, never repeated");
    });
  }
});

test("W1-T13255: a pass that did not observe the stage reads nothing, and the first clean pass after a start reconciles once", async (t) => {
  const f = watchFixture(t);
  await f.unobserved();
  assert.equal(f.reads, 0);
  await f.clean(3);
  assert.equal(f.reads, 1, "one read after a start, in case the last process died mid-streak");
  assert.deepEqual(f.rows(), []);
});

test("W1-T13255: the bound is the p90 of the stage's own recovered streaks inside the window, else the named fallback", () => {
  assert.deepEqual(sweepStageStreakBound([]), { passes: SWEEP_STAGE_STREAK_FALLBACK_PASSES, basis: "fallback", samples: 0 });
  assert.deepEqual(sweepStageStreakBound([9, 9, 9, 9]), { passes: SWEEP_STAGE_STREAK_FALLBACK_PASSES, basis: "fallback", samples: 4 });
  assert.deepEqual(sweepStageStreakBound([1, 3, 2, 1, 2]), { passes: 3, basis: "p90", samples: 5 });
  assert.deepEqual(sweepStageStreakBound([1, 1, 1, 1, 1, 1, 1, 1, 2, 7]), { passes: 2, basis: "p90", samples: 10 });

  const now = BASE_MS;
  const at = (agoMs: number): string => new Date(now - agoMs).toISOString();
  const recovered = (agoMs: number, passes: unknown, stage = "fixture_stage"): Row => ({ ts: at(agoMs), step: SWEEP_STAGE_RECOVERED_STEP, stage, passes });
  const state = sweepStageStreakState([
    recovered(SWEEP_STAGE_STREAK_WINDOW_MS + 60_000, 9),
    recovered(SWEEP_STAGE_STREAK_WINDOW_MS - 60_000, 2),
    recovered(5_000, 8, "another_stage"),
    recovered(4_000, null),
    { ts: at(3_000), step: SWEEP_STAGE_FAILED_STEP, stage: "another_stage", error: "not this stage" },
    { ts: at(2_000), step: SWEEP_STAGE_FAILED_STEP, stage: "fixture_stage", error: "first" },
    { ts: at(1_000), step: SWEEP_STAGE_FAILED_STEP, stage: "fixture_stage", error: "second" },
    { ts: at(500), step: "sweep.pass", stage: "fixture_stage" },
  ], "fixture_stage", now);
  assert.deepEqual(state, { passes: 2, firstFailureTs: at(2_000), lastError: "second", recovered: [2] },
    "a streak outside the window, another stage's rows and a row with no length teach nothing");
  assert.deepEqual(sweepStageStreakState([], "fixture_stage", now), { passes: 0, recovered: [] });
});
