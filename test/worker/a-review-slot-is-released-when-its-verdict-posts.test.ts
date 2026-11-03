import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readOwnedChildPhase } from "#src/lib/run-child.js";
import { RUN_CHILD_SCHEMA, writeStatus, type RunChildStatus } from "#src/lib/run-child-contract.js";
import {
  reviewCommand as reviewCommandImpl, runReview as runReviewCommand, type ReviewCommandHost,
} from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import {
  adoptChildWork, buildSweepEffects, childWorkCount, childWorkHoldsReviewKey, childWorkLeftRunning,
  DEFAULT_SWEEP_POLICY, drainInFlightReviews, registerChildWork, resetChildWork,
  reportReviewPhase, reviewAdmissionBound, runSweep, runSweepLightPass, settleChildWork,
  type ChildWorkRegistration, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

function unexpected(): never { throw new Error("unexpected review fixture dependency"); }
const reviewHost: ReviewCommandHost = {
  GIT_UNTRACKED_FILES_ALL: "--untracked-files=all",
  JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
  acceptedReviewAttemptId: (value) => typeof value === "string" ? value : undefined,
  attributeWorkerStreamEvent: unexpected,
  ledgeredNonDispatchSpawn: unexpected,
  lintPlanForReview: unexpected,
  liveWorkerRunIds: new Set<string>(),
  materializeReviewWorktree: unexpected,
  readHeadShaRest: () => "a".repeat(40),
  readMainPlanTreeSha: unexpected,
  realDeps: () => ({ reviewWorktree: { fetch: unexpected } }) as unknown as ReturnType<ReviewCommandHost["realDeps"]>,
  reviewPostedDescription: (verdict) => verdict.summary,
  reviewWorkerLockId: (runId) => runId,
  reviewerClockBoundMs: unexpected,
  reviewSubjectGit: unexpected,
};
const runReview = runReviewCommand.bind(null, reviewHost);
const reviewCommand = reviewCommandImpl.bind(null, reviewHost);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await turn();
  }
  assert.ok(check(), "expected review state was not reached");
}
const child = (runId: string, readPhase?: () => string | undefined): ChildWorkRegistration => ({
  runId, taskId: "W1-T11151", kind: "review", headSha: runId, reviewKey: runId, readPhase,
});
function pr(n: number): OpenPrView {
  return {
    prNumber: n, prUrl: `https://github.com/o/r/pull/${n}`, taskId: `W1-T${n}`,
    headSha: `head-${n}`, reviewState: "none", checksState: "green", unmetCriteria: [],
    priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
  };
}
function deps(postReview: NonNullable<SweepDeps["postReview"]>): SweepDeps {
  return {
    ledgerPath: "/unused", runId: "W1-T11151", readLedger: () => [], appendLine: () => {},
    readActiveWorkerCount: () => 0, arm: () => {}, close: () => {}, dispatchFix: () => {},
    escalate: () => {}, postReview,
  };
}

describe("test/worker/a-review-slot-is-released-when-its-verdict-posts.test.ts", () => {
  test("the owned status reader accepts only a readable phase for this run", () => {
    const dir = mkdtempSync(join(tmpdir(), "rmd-review-phase-"));
    try {
      assert.equal(readOwnedChildPhase(dir, "owned"), undefined);
      writeFileSync(join(dir, "status.json"), "unreadable");
      assert.equal(readOwnedChildPhase(dir, "owned"), undefined);
      const status: RunChildStatus = {
        schema: RUN_CHILD_SCHEMA, runId: "owned", engineSha: "engine", entryKind: "bundle",
        identity: { pid: process.pid, startTicks: "1", containerGeneration: { containerId: "fixture", initStart: "1" } },
        phase: "review:posted", heartbeatAt: Date.now(), state: "running",
      };
      writeStatus(dir, status);
      assert.equal(readOwnedChildPhase(dir, "owned"), "review:posted");
      assert.equal(readOwnedChildPhase(dir, "other"), undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a posted child frees admission while retaining its mutex and restart inventory", () => {
    let phase = "review:proofs";
    resetChildWork();
    try {
      registerChildWork(child("first", () => phase));
      assert.deepEqual(reviewAdmissionBound(1), { bound: 0, inFlight: 1 });
      phase = "review:posted";
      assert.deepEqual(reviewAdmissionBound(1), { bound: 1, inFlight: 0 });
      assert.equal(childWorkHoldsReviewKey("first"), true);
      assert.equal(childWorkCount(), 1);
      assert.deepEqual(childWorkLeftRunning(), { review: 1 });
      assert.equal(settleChildWork("first"), true);
      assert.equal(childWorkHoldsReviewKey("first"), false);
    } finally { resetChildWork(); }
  });

  test("W1-T11151 criterion 2: unread and unposted children retain admission; settlement releases once", () => {
    resetChildWork();
    try {
      registerChildWork(child("unread", () => undefined));
      registerChildWork(child("unposted", () => "review:judge"));
      registerChildWork(child("posted", () => "review:posted"));
      assert.equal(childWorkCount("review"), 2);
      registerChildWork(child("next", () => "review:proofs"));
      assert.equal(settleChildWork("posted"), true);
      assert.equal(settleChildWork("posted"), false);
      assert.deepEqual(reviewAdmissionBound(4), { bound: 1, inFlight: 3 });
      assert.equal(settleChildWork("unread"), true);
      assert.equal(settleChildWork("unposted"), true);
      assert.deepEqual(reviewAdmissionBound(1), { bound: 0, inFlight: 1 });
    } finally { resetChildWork(); }
  });

  test("W1-T11151 criterion 3: a posted child's settlement records post_to_settle_ms", async () => {
    const held = gate();
    let phase = "review:proofs";
    const rows: Array<Record<string, unknown>> = [];
    resetChildWork();
    const work = adoptChildWork({
      runId: "adopted", taskId: "W1-T11151", work: child("adopted"),
      readPhase: () => phase, settled: held.promise,
    }, (step, extra) => rows.push({ step, ...extra }));
    try {
      assert.equal(childWorkCount("review"), 1);
      phase = "review:posted";
      assert.equal(childWorkCount("review"), 0);
      assert.equal(rows.length, 0, "posting is not settlement");
      await turn();
      held.resolve();
      await work;
      const row = rows.find((r) => r.step === "daemon.child_work_settled");
      assert.equal(typeof row?.post_to_settle_ms, "number");
      assert.ok(Number.isFinite(row?.post_to_settle_ms));
      assert.ok(Number(row?.post_to_settle_ms) >= 0);
    } finally { held.resolve(); await work; resetChildWork(); }
  });

  test("W1-T11151 criterion 2: a failed phase read retains the slot and names the read error", async () => {
    const held = gate();
    const rows: Array<Record<string, unknown>> = [];
    resetChildWork();
    const work = adoptChildWork({
      runId: "read-error", taskId: "W1-T11151", work: child("read-error"), settled: held.promise,
      readPhase: () => { throw new Error("status read failed"); },
    }, (step, extra) => rows.push({ step, ...extra }));
    try {
      assert.deepEqual(reviewAdmissionBound(1), { bound: 0, inFlight: 1 });
      held.resolve();
      await work;
      assert.match(String(rows[0]?.phase_read_error), /status read failed/);
      assert.equal(Object.hasOwn(rows[0]!, "post_to_settle_ms"), false);
      assert.deepEqual(reviewAdmissionBound(1), { bound: 1, inFlight: 0 });
    } finally { held.resolve(); await work; resetChildWork(); }
  });

  test("a child phase is observed without another admission query", async () => {
    const held = gate();
    const rows: Array<Record<string, unknown>> = [];
    let reads = 0;
    resetChildWork();
    const work = adoptChildWork({
      runId: "observed", taskId: "W1-T11151", work: child("observed"), settled: held.promise,
      readPhase: () => ++reads === 2 ? "review:posted" : undefined,
    }, (step, extra) => rows.push({ step, ...extra }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(reads, 2);
      held.resolve();
      await work;
      assert.equal(typeof rows[0]?.post_to_settle_ms, "number");
    } finally { held.resolve(); await work; resetChildWork(); }
  });

  test("W1-T11151 criterion 3: the production effect records post_to_settle_ms before return", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const phases: string[] = [];
    const effects = buildSweepEffects({
      owner: "o", repo: "r", config: { root: "/unused" } as Config,
      ledgerPath: "/unused", runId: "W1-T11151", plan: { tasks: [], byId: new Map() },
      log: (step, extra) => rows.push({ step, ...extra }),
      reviewCommandImpl: async (_pr, _rest, opts) => {
        assert.equal(typeof opts.onPhase, "function");
        opts.onPhase!("posted");
        await turn();
        return 0;
      },
    });
    await effects.postReview!(pr(1), undefined, "attempt", (phase) => phases.push(phase));
    assert.deepEqual(phases, ["posted"]);
    const done = rows.find((r) => r.step === "sweep.post_review.done");
    assert.equal(typeof done?.post_to_settle_ms, "number");
    assert.equal(done?.exit, 0);
  });

  test("a review adapter retains the observer across awaits when it omits the callback", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const phases: string[] = [];
    const effects = buildSweepEffects({
      owner: "o", repo: "r", config: { root: "/unused" } as Config,
      ledgerPath: "/unused", runId: "W1-T11151", plan: { tasks: [], byId: new Map() },
      log: (step, extra) => rows.push({ step, ...extra }),
      reviewRunner: async () => { await turn(); reportReviewPhase("posted"); return 0; },
    });
    await effects.postReview!(pr(1), undefined, "attempt", (phase) => phases.push(phase));
    assert.deepEqual(phases, ["posted"]);
    assert.equal(typeof rows.find((r) => r.step === "sweep.post_review.done")?.post_to_settle_ms, "number");
    reportReviewPhase("posted");
    assert.deepEqual(phases, ["posted"], "the completed review's observer is not global");
  });

  test("reviewCommand forwards the posted phase before worktree cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "rmd-review-command-phase-"));
    const head = "a".repeat(40);
    const events: string[] = [];
    const onPhase = (phase: string): void => { events.push(phase); };
    try {
      const exit = await reviewCommand("1", [], {
        resolveOwnerRepo: () => ({ owner: "o", repo: "r" }),
        fetchView: () => ({ number: 1, html_url: "https://github.com/o/r/pull/1",
          state: "open", head: { ref: "manual-review", sha: head }, body: "" }),
        loadConfig: () => ({ root }) as Config,
        fetchHead: () => {},
        postReviewPending: async () => ({ posted: true }),
        materialize: () => ({ worktreePath: join(root, "head") }),
        buildBaseProof: () => ({ baseCheckoutDir: undefined, baseIsCheckout: false,
          baseUnreadablePaths: new Set<string>(), addedTestFiles: new Set<string>() }),
        withMaterialized: async (path, _repo, body) => {
          try { return await body(); }
          finally { if (path) events.push("cleanup"); }
        },
        onPhase,
        runReview: async (args) => {
          assert.equal(args.onPhase, onPhase, "the command must retain the caller's phase observer");
          args.onPhase!("posted");
          return {
            state: "failure", headSha: head, reviewerOutcome: "test", criteria: [],
            testTheater: false, summary: "withheld fixture verdict", floorDegraded: false,
            capped: false, keywordOnly: false, planOnly: false, verdictWithheld: "fixture refusal",
          };
        },
      });
      assert.equal(exit, 2);
      assert.deepEqual(events, ["posted", "cleanup"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const publication of ["posted", "refused"] as const) {
    test(`runReview reports ${publication} before post-verdict work`, async () => {
      const root = mkdtempSync(join(tmpdir(), "rmd-review-terminal-"));
      const sha = "a".repeat(40);
      const prUrl = "https://github.com/o/r/pull/1";
      const shim = ghShim([
        { when: "headRefOid", stdout: JSON.stringify({ headRefOid: sha }) },
        { when: "pr diff", stdout: "diff --git a/plan/tasks.d/a.yaml b/plan/tasks.d/a.yaml\n+status: queued" },
        { when: "pulls/", stdout: JSON.stringify({ number: 1, html_url: prUrl,
          state: "open", head: { ref: "branch", sha } }) },
      ]);
      const oldPath = process.env.PATH;
      process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
      const events: string[] = [];
      try {
        const args: Parameters<typeof runReviewCommand>[1] = {
          owner: "o", repo: "r", prUrl, task: { id: "W1-T11151", acceptance: [
            { claim: "the plan is queued", proof: "grep: queued plan/tasks.d/a.yaml" },
          ] },
          report: "the plan is queued", settingsFile: join(root, "settings.json"),
          config: { root, claudeBin: "/bin/true" } as Config, spawnReviewer: false,
          log: (step) => events.push(step), say: () => {}, account: (r) => r,
          onPhase: (phase) => events.push(`phase:${phase}`),
          ...(publication === "refused" ? { reviewerCodeFreshness: () => ({
            status: "stale" as const, codeSha: sha, originMainSha: "b".repeat(40),
          }) } : {}),
          ledgerPath: join(root, "ledger.ndjson"), runId: `terminal-${publication}`,
          lintPlanForReviewFn: async () => ({ ran: true, label: "fixture", checked: 1, violations: [] }),
          disarm: () => "not-armed", arm: () => { events.push("arm"); return "armed"; },
        };
        await runReview(args);
        assert.equal(events.filter((event) => event === "phase:posted").length, 1);
        if (publication === "posted") {
          assert.ok(events.indexOf("phase:posted") < events.indexOf("review.posted"));
        } else {
          assert.equal(events.includes("review.posted"), false);
        }
      } finally {
        process.env.PATH = oldPath;
        rmSync(root, { recursive: true, force: true });
        rmSync(shim.dir, { recursive: true, force: true });
      }
    });
  }

  for (const surface of ["full", "light"] as const) {
    test(`${surface} in-process review frees admission at post and holds its key through cleanup`, async () => {
      const held = gate();
      const started: number[] = [];
      let posted: ((phase: string) => void) | undefined;
      const sweepDeps = deps(async (p, _mode, _attempt, onPhase) => {
        started.push(p.prNumber);
        if (p.prNumber === 1) { posted = onPhase; await held.promise; }
      });
      sweepDeps.detachReviewWait = () => {};
      sweepDeps.repairAdmissionSurface = surface;
      const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1 };
      const run = surface === "full" ? runSweep : runSweepLightPass;
      try {
        await run([pr(1)], sweepDeps, policy);
        await eventually(() => started.length === 1);
        assert.equal(reviewAdmissionBound(1).bound, 0);
        assert.equal(typeof posted, "function");
        posted!("posted");
        assert.deepEqual(reviewAdmissionBound(1), { bound: 1, inFlight: 0 });
        await run([pr(1)], sweepDeps, policy);
        assert.deepEqual(started, [1], "the posted review's key remains held");
        await run([pr(2)], sweepDeps, policy);
        await eventually(() => started.includes(2));
        assert.deepEqual(started, [1, 2]);
      } finally {
        held.resolve();
        await drainInFlightReviews({ boundMs: 1000 });
      }
      assert.deepEqual(reviewAdmissionBound(1), { bound: 1, inFlight: 0 });
    });
  }
});
