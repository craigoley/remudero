import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSweep, type HandedOffHeadJudgment, type OpenPrView, type SweepDeps, type SweepSummary } from "./helpers/sweep-test.js";
// Read off the module namespaces, never named imports: at a base without this task the suite must
// still LOAD and fail subtest by subtest, which is what makes the proof discriminate.
import * as sweepModule from "./helpers/sweep-test.js";
import * as runTaskModule from "../src/run-task.js";
import type { RiskJudgeChangeView, RiskJudgeVerdict } from "../src/lib/risk-judge.js";
import type { WorkerResult } from "../src/lib/worker.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T5523 — W1-T5403's sweep judged a handed-off head by AWAITING a model call inside the
// `mergeable` arm, once per head, serially, with no wall-clock bound, after a synchronous change-view
// read. A pass over N handed-off heads therefore held the whole sweep for N model calls. The judgment
// now leaves the pass: it is started in the background (deduped per `pr@head`, capped), the arm is
// held with a named in-flight reason, and the first pass after its decision lands acts on it.

/** THE DECLARED BOUND, in event-loop turns rather than milliseconds — no wall clock is read. A pass
 *  that awaits a never-resolving judge never settles at all, so any finite bound discriminates. */
const PASS_TURN_BOUND = 500;
const NOW = Date.parse("2026-10-04T12:00:00Z");
const RECENT = "2026-10-04T11:00:00Z";

type Outcome<T> = { done: true; value: T } | { done: false };

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Settle `pending` within `turns` event-loop turns, or report that it did not. */
async function withinTurns<T>(pending: Promise<T>, turns = PASS_TURN_BOUND): Promise<Outcome<T>> {
  let outcome: Outcome<T> = { done: false };
  let failure: { error: unknown } | undefined;
  pending.then(
    (value) => {
      outcome = { done: true, value };
    },
    (error: unknown) => {
      failure = { error };
    },
  );
  for (let i = 0; i < turns && !outcome.done && failure === undefined; i++) await nextTurn();
  if (failure !== undefined) throw failure.error;
  return outcome;
}

async function boundedPass(prs: OpenPrView[], deps: SweepDeps): Promise<SweepSummary> {
  const outcome = await withinTurns(runSweep(prs, deps));
  assert.equal(outcome.done, true, `the sweep pass completed within its declared bound of ${PASS_TURN_BOUND} turns`);
  return (outcome as { done: true; value: SweepSummary }).value;
}

function prUrl(n: number): string {
  return `https://github.com/craigoley/remudero/pull/${n}`;
}

function greenPr(n: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: n,
    prUrl: prUrl(n),
    taskId: `W1-T${n}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: `${n}aaaa`,
    autoMergeArmed: false,
    ...over,
  };
}

function handedOff(n: number): Record<string, unknown> {
  return {
    ts: "2026-10-04T10:00:00.000Z",
    run_id: `RUN-${n}`,
    task_id: `W1-T${n}`,
    step: "verdict",
    verdict: "handed_off",
    pr_url: prUrl(n),
    reason: "pr_open_yield",
    head_sha: `${n}aaaa`,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The pool's timer seam, driven by hand: nothing fires until the test says so. */
function fakeTimers() {
  const timers: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];
  return {
    timers,
    schedule: (ms: number, fire: () => void) => {
      const timer = { ms, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    fireAll: () => {
      for (const t of timers) if (!t.cancelled) t.fire();
    },
  };
}

interface Harness {
  deps: SweepDeps;
  lines: Array<Record<string, unknown>>;
  armed: string[];
  started: string[];
  ledgerPath: string;
  dir: string;
}

function harness(
  judgeHandedOffHead: SweepDeps["judgeHandedOffHead"],
  lines: Array<Record<string, unknown>>,
  started: string[],
  pool: sweepModule.HandedOffHeadJudgmentPool,
): Harness {
  const armed: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5523-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  const log = (step: string, extra: Record<string, unknown> = {}) => {
    lines.push({ ts: "2026-10-04T11:30:00.000Z", run_id: "SWEEP-5523", step, ...extra });
  };
  return {
    lines,
    armed,
    started,
    ledgerPath,
    dir,
    deps: {
      arm: (pr) => {
        armed.push(`${pr.prNumber}@${pr.headSha}`);
      },
      close: () => {},
      dispatchFix: () => {},
      escalate: () => {},
      ledgerPath,
      runId: "SWEEP-5523",
      now: () => NOW,
      readLedger: () => lines,
      log,
      judgeHandedOffHead,
      handedOffHeadJudgments: pool,
    },
  };
}

/** The REAL `riskJudgeHandedOffHead` orchestrator with only the LLM verdict deferred, so the
 *  `risk_judge.decision` row a resolved judgment lands is the one production writes. */
function orchestratedJudge(
  verdicts: Map<number, Deferred<RiskJudgeVerdict>>,
  started: string[],
  lines: Array<Record<string, unknown>>,
): SweepDeps["judgeHandedOffHead"] {
  return sweepModule.riskJudgeHandedOffHead((pr) => ({
    input: { change: { description: pr.prUrl }, gatesState: {}, planContext: { taskId: pr.taskId } },
    orchestrator: {
      judge: () => {
        started.push(`${pr.prNumber}@${pr.headSha}`);
        const d = deferred<RiskJudgeVerdict>();
        verdicts.set(pr.prNumber, d);
        return d.promise;
      },
      escalate: () => "https://github.com/craigoley/remudero/issues/1",
      log: (step, extra) => {
        lines.push({ ts: "2026-10-04T11:40:00.000Z", run_id: "SWEEP-5523", step, ...extra });
      },
    },
  }));
}

function disposedRows(ledgerPath: string): Array<Record<string, unknown>> {
  return readLedgerLines(ledgerPath).filter((l) => l.step === "sweep.disposed");
}

const LOW: RiskJudgeVerdict = { verdict: "low", confidence: 0.95, reasons: ["a contained change"] };

test("W1-T5523: a sweep pass over handed-off heads whose judge never resolves completes under a declared bound, holds each arm with an in-flight reason, starts at most the declared number of judgments, and arms a head on the first pass after its proceed decision lands", async () => {
  const limit = sweepModule.HANDED_OFF_HEAD_JUDGMENT_CONCURRENCY_LIMIT;
  assert.ok(Number.isInteger(limit) && limit >= 1, "the concurrency cap is a declared positive constant");
  const heads = Array.from({ length: limit + 2 }, (_, i) => 55230 + i);
  const lines = heads.map(handedOff);
  const started: string[] = [];
  const verdicts = new Map<number, Deferred<RiskJudgeVerdict>>();
  const timers = fakeTimers();
  const pool = sweepModule.handedOffHeadJudgmentPool({ schedule: timers.schedule });
  const h = harness(orchestratedJudge(verdicts, started, lines), lines, started, pool);
  try {
    const prs = heads.map((n) => greenPr(n));

    const first = await boundedPass(prs, h.deps);
    assert.equal(started.length, limit, "no more than the declared cap of judgments was started");
    assert.deepEqual(h.armed, [], "no handed-off head is armed while its judgment is in flight");
    assert.equal(first.actions.filter((a) => a.acted).length, 0);
    const reasons = disposedRows(h.ledgerPath).map((r) => String(r.stand_down_reason));
    assert.equal(reasons.length, heads.length);
    for (const reason of reasons) assert.match(reason, /risk judgment .*in flight/, "each arm is held with an in-flight reason");
    assert.ok(reasons.some((r) => /not started/.test(r)), "a head over the cap names that it waits for a slot");
    assert.ok(timers.timers.every((t) => t.ms === pool.timeoutMs), "each judgment carries its wall-clock bound");

    await boundedPass(prs, h.deps);
    assert.equal(started.length, limit, "an in-flight judgment is never started twice across passes");
    assert.deepEqual(h.armed, []);

    // The first judgment lands a proceed decision; the next pass arms that head and fills its slot.
    verdicts.get(heads[0])!.resolve(LOW);
    for (let i = 0; i < 10; i++) await nextTurn();
    const decision = lines.find((l) => l.step === "risk_judge.decision" && l.pr_number === heads[0]);
    assert.equal(decision?.action, "proceed", "the proceed decision landed in the ledger");
    assert.equal(timers.timers[0].cancelled, true, "a settled judgment cancels its wall-clock bound");

    await boundedPass(prs, h.deps);
    assert.deepEqual(h.armed, [`${heads[0]}@${heads[0]}aaaa`], "the head arms on the first pass after its decision lands");
    assert.equal(started.length, limit + 1, "the freed slot starts the next waiting head's judgment");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("W1-T5523: a judgment that outlives its wall-clock bound is ledgered sweep.risk_judge_unavailable, frees its slot, and a late answer is ignored", async () => {
  const lines = [handedOff(55240)];
  const started: string[] = [];
  const answers: Array<Deferred<HandedOffHeadJudgment>> = [];
  const timers = fakeTimers();
  const pool = sweepModule.handedOffHeadJudgmentPool({ schedule: timers.schedule, limit: 1, timeoutMs: 1234 });
  const h = harness(
    (pr) => {
      started.push(`${pr.prNumber}@${pr.headSha}`);
      answers.push(deferred<HandedOffHeadJudgment>());
      return answers[answers.length - 1].promise;
    },
    lines,
    started,
    pool,
  );
  try {
    const pr = greenPr(55240);
    await boundedPass([pr], h.deps);
    assert.deepEqual(timers.timers.map((t) => t.ms), [1234]);
    assert.equal(pool.flights.size, 1, "the judgment holds its slot while it runs");
    timers.fireAll();
    const unavailable = lines.filter((l) => l.step === "sweep.risk_judge_unavailable");
    assert.equal(unavailable.length, 1, "the overrun is ledgered as unavailable, never swallowed");
    assert.equal(unavailable[0].pr_number, 55240);
    assert.match(String(unavailable[0].reason), /outlived its 1234ms bound/);
    assert.equal(pool.flights.size, 0, "the overrun frees its slot");

    answers[0].resolve({ action: "proceed", reason: "late" });
    for (let i = 0; i < 5; i++) await nextTurn();
    assert.equal(lines.filter((l) => l.step === "sweep.risk_judge_unavailable").length, 1, "the late answer changes nothing");

    const held = await boundedPass([pr], h.deps);
    assert.deepEqual(h.armed, [], "a late proceed is never read as a judgment once the bound has fired");
    assert.equal(held.actions[0].acted, false);
    assert.equal(started.length, 2, "the next pass asks again");
    assert.match(String(disposedRows(h.ledgerPath).at(-1)?.stand_down_reason), /risk judgment in flight/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("W1-T5523: a background judgment that rejects, or a judge dep that throws synchronously, is ledgered sweep.risk_judge_unavailable and never read as proceed", async () => {
  for (const shape of ["rejects", "throws"] as const) {
    const lines = [handedOff(55250)];
    const started: string[] = [];
    const answer = deferred<HandedOffHeadJudgment>();
    const pool = sweepModule.handedOffHeadJudgmentPool({ schedule: fakeTimers().schedule });
    const h = harness(
      (pr) => {
        started.push(`${pr.prNumber}@${pr.headSha}`);
        if (shape === "throws") throw new Error("judge wiring exploded synchronously");
        return answer.promise;
      },
      lines,
      started,
      pool,
    );
    try {
      const pr = greenPr(55250);
      await boundedPass([pr], h.deps);
      if (shape === "rejects") {
        assert.equal(lines.filter((l) => l.step === "sweep.risk_judge_unavailable").length, 0, `${shape}: in flight, not yet failed`);
        answer.reject(new Error("model spawn crashed in the background"));
        for (let i = 0; i < 5; i++) await nextTurn();
      }
      const unavailable = lines.filter((l) => l.step === "sweep.risk_judge_unavailable");
      assert.equal(unavailable.length, 1, `${shape}: the failure is ledgered once`);
      assert.match(String(unavailable[0].reason), shape === "rejects" ? /model spawn crashed/ : /exploded synchronously/);
      if (shape === "rejects") await boundedPass([pr], h.deps);
      assert.deepEqual(h.armed, [], `${shape}: a failed judgment never arms`);
      assert.match(String(disposedRows(h.ledgerPath).at(-1)?.stand_down_reason), /risk judge unavailable/);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  }
});

test("W1-T5523: the default pool declares the cap and bound and schedules a real, unref'd, cancellable timer", () => {
  const pool = sweepModule.handedOffHeadJudgmentPool();
  assert.equal(pool.limit, sweepModule.HANDED_OFF_HEAD_JUDGMENT_CONCURRENCY_LIMIT);
  assert.equal(pool.timeoutMs, sweepModule.HANDED_OFF_HEAD_JUDGMENT_TIMEOUT_MS);
  let fired = false;
  const cancel = pool.schedule(pool.timeoutMs, () => {
    fired = true;
  });
  cancel();
  assert.equal(fired, false, "a cancelled bound never fires");
});

test("W1-T5523: the daemon's judge reads the change view through the async transport inside the background judgment, so a hung read holds no pass", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5523-daemon-`));
  try {
    const n = 55260;
    const task = { id: `W1-T${n}`, title: "a handed-off head", type: "implement", files: ["src/lib/sweep.ts"] } as unknown as Task;
    const plan: Plan = { tasks: [task], byId: new Map([[task.id, task]]) };
    const config = { claudeBin: "/bin/true", root, installRoot: process.cwd() } as unknown as Parameters<typeof runTaskModule.handedOffHeadRiskJudge>[2];
    const reads: string[] = [];
    const hung = deferred<RiskJudgeChangeView>();
    const spawns: string[] = [];
    const judge = runTaskModule.handedOffHeadRiskJudge(
      "craigoley",
      "remudero",
      config,
      plan,
      join(root, "ledger.ndjson"),
      "SWEEP-5523",
      () => {},
      async (args) => {
        spawns.push(String(args.prompt));
        return { text: "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.95", costUsd: 0, numTurns: 1 } as unknown as WorkerResult;
      },
      () => "https://github.com/craigoley/remudero/issues/1",
      (url) => {
        reads.push(url);
        return hung.promise;
      },
    );
    const lines = [handedOff(n)];
    const pool = sweepModule.handedOffHeadJudgmentPool({ schedule: fakeTimers().schedule });
    const h = harness(judge, lines, [], pool);
    try {
      await boundedPass([greenPr(n)], h.deps);
      assert.deepEqual(reads, [prUrl(n)], "the change view was requested once, from the background judgment");
      assert.deepEqual(spawns, [], "the model is not spawned before the change view arrives");
      assert.match(String(disposedRows(h.ledgerPath).at(-1)?.stand_down_reason), /in flight/);
      hung.resolve({ files: [{ path: "src/lib/sweep.ts", additions: 3, deletions: 1 }], truncated: false });
      for (let i = 0; i < 20; i++) await nextTurn();
      assert.equal(spawns.length, 1, "the judgment continued off the pass once the read returned");
      assert.ok(String(spawns.at(0)).includes("src/lib/sweep.ts"), "the judge was shown the asynchronously read change view");
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5523: changeViewAsync reads the PR's REST file list through an async reader and refuses an unparseable URL before any read", async () => {
  const calls: string[][] = [];
  const view = await runTaskModule.changeViewAsync(prUrl(55270), async (args) => {
    calls.push(args);
    return [{ filename: "src/lib/sweep.ts", additions: 2, deletions: 1 }, { additions: 9 }];
  });
  assert.deepEqual(calls, [["api", "repos/craigoley/remudero/pulls/55270/files?per_page=100"]]);
  assert.deepEqual(view.files, [{ path: "src/lib/sweep.ts", additions: 2, deletions: 1 }]);
  await assert.rejects(
    runTaskModule.changeViewAsync("not a pr url", async () => {
      throw new Error("must not be read");
    }),
    /cannot resolve owner\/repo\/number/,
  );
});
