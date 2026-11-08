import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readOwnedChildPhase, runDetachedReview, type DetachedReviewCommand, type DetachedWorkSpec } from "#src/lib/run-child.js";
import { childIdentity, readStatus, RUN_CHILD_SCHEMA, writeSpec, writeStatus, type RunChildStatus } from "#src/lib/run-child-contract.js";
import { runChildMain } from "#src/run-child-main.js";
import {
  reviewCommand as reviewCommandImpl, runReview as runReviewCommand, type ReviewCommandHost,
} from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { buildSweepEffects as commandEffects, type SweepCommandHost } from "#src/cli/commands/sweep.js";
import { judgeReview } from "#src/lib/review.js";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
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
  for (const kind of ["reuse", "discriminate-only"] as const) {
    for (const publication of ["posted", "refused", "failed", "fallback", "command-fallback"] as const) {
      test(`W1-T11151 criterion 2: production ${kind} releases only terminal publication (${publication})`, async () => {
        const root = mkdtempSync(join(tmpdir(), "rmd-reuse-phase-"));
        const ledgerPath = join(root, "ledger.ndjson");
        const held = gate();
        const subject = { ...pr(7), currentOwnDiffDigest: "own", currentMergeBaseSha: "base" };
        const diff = "diff --git a/src/subject.ts b/src/subject.ts\n+verdict-ready\n";
        const prior = judgeReview([{ claim: "verdict ready", proof: "grep: verdict-ready in src/subject.ts" }], {
          diff, report: "verdict ready", headCheckoutDir: "/head", execProof: () => "pass",
        });
        appendLedger(ledgerPath, { run_id: "prior", task_id: subject.taskId!, step: "review.posted",
          head_sha: "prior-head", pr_url: subject.prUrl,
          decision_verdict: publication.endsWith("fallback") ? { ...prior, state: "pending" } : prior });
        const shim = ghShim([
          // W1-T11443: a SUCCESS reads the head's status history first; this head has no prior FAILURE.
          { when: "/statuses?", stdout: "[[]]" },
          { when: "pr diff", stdout: diff },
          { when: "pulls/", stdout: JSON.stringify({ state: publication === "refused" ? "closed" : "open", merged: false }) },
          ...(publication === "failed" ? [{ when: "statuses/", stderr: "HTTP 422: invalid status", exit: 1 }] : []),
        ]);
        const oldPath = process.env.PATH;
        process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
        const rows: Array<Record<string, unknown>> = [];
        const phases: string[] = [];
        const fallbackReview = async (onPhase?: (phase: string) => void): Promise<number> => {
          fallback = true;
          await turn();
          onPhase?.("posted");
          await held.promise;
          return 0;
        };
        let cleaned = false;
        let fallback = false;
        const boundAtPublication: number[] = [];
        const host = {
          freshTreeGit: unexpected,
          realDeps: () => ({ reviewWorktree: { addWorktree: unexpected } }),
          buildFreshTreeReviewRunner: () => unexpected,
          buildReviewerCodeFreshnessGate: () => ({ call: unexpected, staleThisPass: () => undefined }),
          buildBaseReproductionProbe: () => unexpected, buildImportClosureRead: () => unexpected,
          buildRequiredFixReviewRunner: () => unexpected, readyDraftViaGh: () => unexpected,
          reviewPostedDescription: (verdict: { summary: string }) => verdict.summary,
        } as unknown as SweepCommandHost & Required<Pick<SweepCommandHost, "freshTreeGit">>;
        resetChildWork();
        registerChildWork(child("reuse-child", () => phases.at(-1)));
        const effects = commandEffects(host, {
          owner: "o", repo: "r", localRepoName: "r", config: { root } as Config,
          ledgerPath, runId: "W1-T11151", plan: { tasks: [], byId: new Map() },
          instanceRegistryTextImpl: () => undefined,
          log: (step, extra) => rows.push({ step, ...extra }),
          materializeReviewWorktreeImpl: () => ({ worktreePath: "/head" }),
          buildBaseProofDirImpl: () => ({ baseCheckoutDir: "/base", baseUnreadablePaths: new Set(),
            baseIsCheckout: true, addedTestFiles: new Set() }),
          reviewReuseExecProofImpl: (_proof: string, cwd: string) => cwd === "/head" ? "pass" : "fail",
          worktreeRemoveImpl: () => {
            cleaned = true;
            assert.equal(childWorkHoldsReviewKey("reuse-child"), true);
            assert.deepEqual(reviewAdmissionBound(1), { bound: publication === "failed" ? 0 : 1,
              inFlight: publication === "failed" ? 1 : 0 });
            assert.equal(rows.some((row) => row.step === "sweep.post_review.done"), false);
          },
          reviewRunner: publication === "command-fallback" ? undefined
            : (_pr, _plan, _attempt, onPhase) => fallbackReview(onPhase),
          reviewCommandImpl: (_pr, _rest, opts) => fallbackReview(opts.onPhase),
        });
        let work: Promise<unknown> | undefined;
        try {
          assert.deepEqual(reviewAdmissionBound(1), { bound: 0, inFlight: 1 });
          work = effects.postReview!(subject, { kind, judgedHeadSha: "prior-head" }, undefined, (phase) => {
            phases.push(`review:${phase}`);
            boundAtPublication.push(reviewAdmissionBound(1).bound);
          }) as Promise<unknown>;
          if (publication.endsWith("fallback")) {
            await eventually(() => fallback);
            await turn();
            assert.deepEqual(reviewAdmissionBound(1), { bound: 1, inFlight: 0 });
            assert.equal(childWorkHoldsReviewKey("reuse-child"), true);
            held.resolve();
          }
          await work;
          assert.equal(cleaned, kind === "discriminate-only" && !publication.endsWith("fallback"));
          const terminal = publication !== "failed";
          assert.deepEqual(phases, terminal ? ["review:posted"] : []);
          assert.deepEqual(boundAtPublication, terminal ? [1] : []);
          assert.equal(childWorkHoldsReviewKey("reuse-child"), true);
          const done = rows.find((row) => row.step === "sweep.post_review.done");
          assert.ok(done, JSON.stringify(rows));
          assert.equal(done.exit, publication === "failed" || publication === "refused" ? 1 : 0);
          // W1-T11151 criterion 3: the real reuse effect measures its post-to-settlement tail.
          assert.equal(typeof done.post_to_settle_ms, terminal ? "number" : "undefined");
          const ledger = readLedgerLines(ledgerPath);
          if (publication === "refused") assert.ok(ledger.some((row) => row.step === "review.post_refused"));
          if (publication === "failed") assert.ok(ledger.some((row) => row.step === "review.post_failed"));
          assert.equal(settleChildWork("reuse-child"), true);
          assert.equal(settleChildWork("reuse-child"), false);
          assert.equal(childWorkHoldsReviewKey("reuse-child"), false);
          assert.deepEqual(reviewAdmissionBound(1), { bound: 1, inFlight: 0 });
        } finally {
          held.resolve();
          await work;
          resetChildWork();
          process.env.PATH = oldPath;
          rmSync(shim.dir, { recursive: true, force: true });
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }

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

  // W1-T11151 design 1: a replay that restores or confirms its terminal status is terminal; a restore whose publication
  // threw (the guarded post ledgers review.post_failed) holds its slot until the review settles.
  for (const restore of ["confirmed", "failed"] as const) {
    test(`W1-T11151 criterion 2: a replayed review reports posted unless its restore publication failed (${restore})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "rmd-review-replay-phase-"));
      const head = "a".repeat(40);
      const shim = ghShim([{ when: "statuses/", stderr: "HTTP 422: Validation Failed", exit: 1 }]);
      const oldPath = process.env.PATH;
      process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
      const events: string[] = [];
      try {
        await reviewCommand("1", [], {
          resolveOwnerRepo: () => ({ owner: "o", repo: "r" }),
          fetchView: () => ({ number: 1, html_url: "https://github.com/o/r/pull/1",
            state: "open", head: { ref: "manual-review", sha: head }, body: "" }),
          loadConfig: () => ({ root }) as Config,
          fetchHead: () => {},
          postReviewPending: async () => ({ posted: true }),
          reviewerCodeFreshness: () => ({ status: "fresh" as const, codeSha: head, originMainSha: head, advance: "none" as const }),
          materialize: () => ({ worktreePath: join(root, "head") }),
          buildBaseProof: () => ({ baseCheckoutDir: undefined, baseIsCheckout: false,
            baseUnreadablePaths: new Set<string>(), addedTestFiles: new Set<string>() }),
          withMaterialized: async (_path, _repo, body) => body(),
          onPhase: (phase) => events.push(`phase:${phase}`),
          runReview: async () => ({
            state: "success", headSha: head, reviewerOutcome: "test", criteria: [],
            testTheater: false, summary: "replayed fixture verdict", floorDegraded: false,
            capped: false, keywordOnly: false, planOnly: false,
            decisionDisposition: "replayed", reviewDecisionDigest: "v2:fixture",
          }),
          // The guarded post's own contract: it calls its raw poster, and ledgers review.post_failed when that throws.
          postStatus: async (o) => {
            if (restore === "confirmed") return { posted: false, replayed: true };
            try {
              await o.post!({ owner: o.owner, repo: o.repo, sha: o.sha, state: o.state });
              return { posted: true };
            } catch (error) {
              return { posted: false, reason: `posting remudero-review failed and was not applied: ${String(error)}` };
            }
          },
        });
        if (restore === "confirmed") assert.deepEqual(events, ["phase:posted"]);
        else assert.deepEqual(events, [], "a restore whose publication threw holds its slot until it settles");
      } finally {
        process.env.PATH = oldPath;
        rmSync(root, { recursive: true, force: true });
        rmSync(shim.dir, { recursive: true, force: true });
      }
    });
  }

  // W1-T11151 design 1 / criteria 1 and 2: a terminal outcome reports `posted` before cleanup: a published status, a
  // refused publication (stale reviewer code, review.post_refused) or a withheld verdict (an unreadable task-id
  // reservation, review.post_refused). Only a publication that FAILED (the status POST errors, review.post_failed) ends
  // without a terminal outcome, so it alone holds its slot until the review settles.
  for (const publication of ["posted", "refused", "withheld", "failed"] as const) {
    test(`W1-T11151 criterion 2: runReview reports posted for a terminal outcome and holds a failed publication (${publication})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "rmd-review-terminal-"));
      const sha = "a".repeat(40);
      const prUrl = "https://github.com/o/r/pull/1";
      const shim = ghShim([
        { when: "/statuses?", stdout: "[[]]" },
        ...(publication === "failed" ? [{ when: "statuses/", stderr: "HTTP 422: Validation Failed", exit: 1 }] : []),
        { when: "headRefOid", stdout: JSON.stringify({ headRefOid: sha }) },
        { when: "pr diff", stdout: publication === "withheld"
          // A task id this diff declares, read against a head checkout git cannot read: its reservation is unknown.
          ? "diff --git a/plan/tasks.d/a.yaml b/plan/tasks.d/a.yaml\n--- a/plan/tasks.d/a.yaml\n+++ b/plan/tasks.d/a.yaml\n+- id: W1-T99991\n+  status: queued"
          : "diff --git a/plan/tasks.d/a.yaml b/plan/tasks.d/a.yaml\n+status: queued" },
        { when: "pulls/", stdout: JSON.stringify({ number: 1, html_url: prUrl,
          state: "open", head: { ref: "branch", sha } }) },
      ]);
      if (publication === "withheld") {
        // A head directory git cannot read (no origin), holding the shard so the verdict would pass but for its reservation.
        mkdirSync(join(root, "head", "plan", "tasks.d"), { recursive: true });
        writeFileSync(join(root, "head", "plan", "tasks.d", "a.yaml"), "- id: W1-T99991\n  status: queued\n");
      }
      const oldPath = process.env.PATH;
      process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
      const events: string[] = [];
      try {
        const args: Parameters<typeof runReviewCommand>[1] = {
          owner: "o", repo: "r", prUrl, task: { id: "W1-T11151", acceptance: [
            { claim: "the plan is queued", proof: publication === "withheld"
              // Executed against the head checkout, so the verdict passes but for the unreadable reservation.
              ? "grep: status: queued in plan/tasks.d/a.yaml" : "grep: queued plan/tasks.d/a.yaml" },
          ] },
          report: "the plan is queued", settingsFile: join(root, "settings.json"),
          config: { root, claudeBin: "/bin/true" } as Config, spawnReviewer: false,
          log: (step) => events.push(step), say: () => {}, account: (r) => r,
          onPhase: (phase) => events.push(`phase:${phase}`),
          ...(publication === "refused" ? { reviewerCodeFreshness: () => ({
            status: "stale" as const, codeSha: sha, originMainSha: "b".repeat(40),
          }) } : {}),
          ...(publication === "withheld" ? { headRefName: "branch", headCheckoutDir: join(root, "head") } : {}),
          ledgerPath: join(root, "ledger.ndjson"), runId: `terminal-${publication}`,
          lintPlanForReviewFn: async () => ({ ran: true, label: "fixture", checked: 1, violations: [] }),
          disarm: () => "not-armed", arm: () => { events.push("arm"); return "armed"; },
        };
        const result = await runReview(args);
        const ledger = (() => { try { return readFileSync(args.ledgerPath, "utf8"); } catch { return ""; } })();
        if (publication === "failed") {
          // Positive control: the status POST really failed through the production publication path.
          assert.match(ledger, /"step":"review\.post_failed"/);
          assert.equal(events.includes("phase:posted"), false, "a failed publication must hold its slot until it settles");
          assert.equal(events.includes("review.posted"), false);
          return;
        }
        assert.equal(events.filter((event) => event === "phase:posted").length, 1, `a ${publication} outcome is terminal`);
        if (publication === "posted") {
          assert.ok(events.indexOf("phase:posted") < events.indexOf("review.posted"));
        } else {
          assert.equal(events.includes("review.posted"), false);
          // Positive controls: each outcome is the terminal refusal it names, written by the production path.
          if (publication === "refused") assert.match(ledger, /"step":"review\.post_refused"/);
          if (publication === "withheld") {
            assert.ok(events.includes("review.post_refused"), "the withheld branch writes its review.post_refused row");
            assert.ok(result.verdictWithheld, "the verdict is withheld");
          }
          assert.doesNotMatch(ledger, /"step":"review\.post_failed"/);
        }
      } finally {
        process.env.PATH = oldPath;
        rmSync(root, { recursive: true, force: true });
        rmSync(shim.dir, { recursive: true, force: true });
      }
    });
  }

  for (const surface of ["full", "light"] as const) {
    test(`${surface} in-process plan-lane review frees its plan-lane count at post, once`, async () => {
      const held = gate();
      const started: number[] = [];
      let posted: ((phase: string) => void) | undefined;
      const sweepDeps = deps(async (p, _mode, _attempt, onPhase) => {
        started.push(p.prNumber);
        if (p.prNumber === 21) { posted = onPhase; await held.promise; }
      });
      sweepDeps.detachReviewWait = () => {};
      sweepDeps.repairAdmissionSurface = surface;
      // No capacity reading: the plan-lane bound is the review width, so one plan review fills the lane.
      const policy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 1 };
      const run = surface === "full" ? runSweep : runSweepLightPass;
      const plan = (n: number): OpenPrView => ({ ...pr(n), isPlanFiling: true });
      try {
        await run([plan(21)], sweepDeps, policy);
        await eventually(() => started.length === 1);
        // Positive control: the lane is full, so a second plan review waits.
        await run([plan(22)], sweepDeps, policy);
        assert.deepEqual(started, [21], "one plan review in flight fills a one-review plan lane");
        assert.equal(typeof posted, "function", "the plan lane's review receives the posted-phase callback");
        posted!("posted");
        await run([plan(22)], sweepDeps, policy);
        await eventually(() => started.includes(22));
        assert.deepEqual(started, [21, 22], "a posted plan review frees its lane before it settles");
      } finally {
        held.resolve();
        await drainInFlightReviews({ boundMs: 1000 });
      }
      // Settlement after post never releases a second time: the lane admits exactly one of two plan reviews again.
      const second = gate();
      started.length = 0;
      const after = deps(async (p) => { started.push(p.prNumber); await second.promise; });
      after.detachReviewWait = () => {};
      after.repairAdmissionSurface = surface;
      try {
        await run([plan(23), plan(24)], after, policy);
        await eventually(() => started.length >= 1);
        await turn();
        assert.equal(started.length, 1, "the plan-lane count was released once, not twice");
      } finally {
        second.resolve();
        await drainInFlightReviews({ boundMs: 1000 });
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

test("W1-T11151 criterion 1: a detached review child writes its posted phase to the owned status.json the registry reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-detached-review-phase-"));
  try {
    const dir = join(root, "runs", "child-review-1");
    writeSpec(dir, { schema: RUN_CHILD_SCHEMA, runId: "child-review-1", taskId: "W1-T11151", instance: "fixture",
      engine: { sha: "abc", sourceHash: "hash" }, planSnapshotPath: join(root, "plan.json"), reservationId: "", options: {} });
    const work: DetachedWorkSpec = { kind: "review", prNumber: 7, headSha: "h".repeat(40), reviewKey: "review-key-7" };
    const specPath = join(dir, "spec.json");
    writeFileSync(specPath, `${JSON.stringify({ ...JSON.parse(readFileSync(specPath, "utf8")) as object, work })}\n`);
    writeStatus(dir, { schema: RUN_CHILD_SCHEMA, runId: "child-review-1", identity: childIdentity(process.pid)!, engineSha: "abc",
      entryKind: "bundle", phase: "review", heartbeatAt: Date.now(), state: "running" });
    const seen: Array<string | undefined> = [];
    // The real review's own post-time call: `(args.onPhase ?? reportReviewPhase)("posted")` (src/cli/commands/review.ts).
    const review: DetachedReviewCommand = async (_pr, _rest, opts) => {
      (opts.onPhase ?? reportReviewPhase)("posted");
      seen.push(readOwnedChildPhase(dir, "child-review-1"));
      return 0;
    };
    const code = await runChildMain(["--run-dir", dir], { env: {}, stderr: () => {}, heartbeatMs: 60_000, loadRunPath: async () => ({}),
      signals: { on: () => undefined, off: () => undefined },
      runDetachedWork: (detached, ctx) => runDetachedReview(detached, ctx, review) });
    assert.equal(code, 0);
    assert.deepEqual(seen, ["review:posted"], "the child's own status.json says posted while the review is still settling");
    const settled = readStatus(dir);
    assert.ok(settled.ok && settled.value.state === "done");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
