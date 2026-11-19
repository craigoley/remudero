// W1-T13787 — PR 19489's security-merge-policy status read `unknown: codeql-configuration-not-found` for 58 minutes after
// GitHub had re-judged its CodeQL check in place: no event ran the trusted producer again. When the sweep's fresh security
// read at the same head no longer shows the warning, it dispatches the producer once for that head. It never writes the
// status itself: the producer re-derives the decision from trusted metadata.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { MAX_RETAINED_LINES_PER_STEP, rotateLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import * as sweep from "#src/lib/sweep.js";
import type { OpenPrView, SecurityMergeObservation, SweepDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const REASON = "codeql-configuration-not-found";
const STEP = "security.producer_redispatched";
const HEAD = "41a67e1c0ffee0000000000000000000000000aa";
const NEXT = "52b78f2c0ffee0000000000000000000000000bb";
const PR = 19489;
const TASK = "W1-T13787";
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR}`;
const T1 = "2026-11-18T20:20:41Z";
const CLEARED: SecurityMergeObservation = { headSha: HEAD, decision: { state: "safe", mergeAllowed: true, reason: "no-new-high-or-critical-alert" },
  observation: { checksComplete: true, latest: { id: 3 } } };
const WARNING = { checkId: 2, headSha: HEAD, completedAt: T1, conclusion: "neutral", title: "1 configuration not found",
  summary: null, summarySha256: null, truncated: false, alertsLink: null };
const STILL_WARNS: SecurityMergeObservation = { headSha: HEAD, decision: { state: "unknown", mergeAllowed: false, reason: REASON },
  observation: { latest: { id: 2 }, configurationWarning: WARNING } };

const ROOT = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t13787-`));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const PR_ENDPOINT = `repos/craigoley/remudero/pulls/${PR}`;
const PR_METADATA = { head: { sha: HEAD }, base: { sha: NEXT, ref: "main", repo: { full_name: "craigoley/remudero" } },
  state: "open", changed_files: 1 };
const CLEARED_CHECK = { id: 3, name: "CodeQL", head_sha: HEAD, status: "completed", conclusion: "success",
  app: { id: 57789, slug: "github-advanced-security", owner: { login: "github" } },
  output: { title: "No new alerts in code changed by this pull request",
    summary: `[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A${PR}+tool%3ACodeQL+is%3Aopen).` } };
const CHECK_ENDPOINT = `repos/craigoley/remudero/commits/${HEAD}/check-runs?filter=all&per_page=100&page=1`;
const FILE_ENDPOINT = `${PR_ENDPOINT}/files?per_page=100&page=1`;

function productionEffects(readJsonImpl: NonNullable<Parameters<typeof sweep.buildSweepEffects>[0]["readJsonImpl"]>, writes: string[][]) {
  return sweep.buildSweepEffects({ owner: "craigoley", repo: "remudero", config: { claudeBin: "/usr/bin/true", root: ROOT } as never,
    ledgerPath: join(ROOT, "ledger.ndjson"), runId: "SWEEP-13787", plan: { tasks: [] } as never, log: () => {},
    readJsonImpl, ghRunImpl: (file, args) => { writes.push([file, ...args]); } });
}

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return { prNumber: PR, prUrl: PR_URL, taskId: TASK, reviewState: "none", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: T1, headSha: HEAD, headRefName: `run-${TASK}-1795067238000`, autoMergeArmed: false,
    ciFailures: [{ name: "security-merge-policy", logTail: "" }],
    securityMergePolicy: { state: "unknown", reason: REASON }, ...over };
}

/** A sweep pass's deps: every arm effect that could act on GitHub fails the test; the security seams record. */
function harness(prior: Record<string, unknown>[], answer: () => Promise<SecurityMergeObservation>,
  dispatch: (pr: OpenPrView) => Promise<void> = async () => {}) {
  const rows: Record<string, unknown>[] = [];
  const dispatched: number[] = [];
  const forbidden = (what: string) => () => assert.fail(`a configuration-not-found wait never ${what}`);
  const deps: SweepDeps = {
    arm: forbidden("arms"), close: forbidden("closes"), dispatchFix: forbidden("dispatches a fix round"),
    postReview: forbidden("posts a review status"), updateBranch: forbidden("updates the branch"),
    requeueCheck: forbidden("re-runs a check"), rerunFailedChecks: forbidden("re-runs failed checks"),
    readyDraft: forbidden("readies a draft"), disarmAutoMerge: forbidden("disarms"), escalate: forbidden("escalates"),
    readSecurityMergeObservation: answer,
    readCodeqlWorkflowRuns: async () => ({ workflow_runs: [] }),
    dispatchSecurityMergeProducer: async (pr) => { dispatched.push(pr.prNumber); await dispatch(pr); },
    ledgerPath: join(ROOT, "fixture.ndjson"), runId: "SWEEP-13787", now: () => Date.parse(T1) + 3_600_000,
    readLedger: () => [...prior, ...rows], appendLine: (_path, row) => { rows.push(row); },
    log: (step, extra = {}) => { rows.push({ run_id: "SWEEP-13787", step, ...extra }); },
  };
  return { deps, rows, dispatched };
}

test("W1-T13787 criterion 1: a cleared fresh read at the same head dispatches the producer once and writes one row", async () => {
  const h = harness([], async () => CLEARED);
  const reason = await sweep.observeCodeqlConfigurationWarning(h.deps, [], view(), "wait");
  assert.deepEqual(h.dispatched, [PR]);
  assert.deepEqual(h.rows, [{ run_id: "SWEEP-13787", task_id: TASK, pr_number: PR, pr_url: PR_URL, head_sha: HEAD, step: STEP,
    decision: "safe: no-new-high-or-critical-alert", posted_status: `unknown: ${REASON}` }]);
  assert.match(reason, /^wait — the fresh read answers safe: no-new-high-or-critical-alert, so the security-merge-policy producer was dispatched once for this head$/);
});

test("W1-T13787 criterion 1: safe same-head evidence does not need the optional checksComplete field", async () => {
  const h = harness([], async () => ({ ...CLEARED, observation: { latest: { id: 3 } } }));
  const reason = await sweep.observeCodeqlConfigurationWarning(h.deps, [], view(), "wait");
  assert.deepEqual(h.dispatched, [PR]);
  assert.match(reason, /fresh read answers safe: no-new-high-or-critical-alert/);
});

test("W1-T13787 criterion 2: the producer is re-run at most once per head, and a new head is re-run again", async () => {
  const first = harness([], async () => CLEARED);
  await sweep.observeCodeqlConfigurationWarning(first.deps, [], view(), "wait");
  const ledger = [...first.rows];
  const again = harness(ledger, async () => CLEARED);
  const reason = await sweep.observeCodeqlConfigurationWarning(again.deps, ledger, view(), "wait");
  assert.deepEqual([again.dispatched.length, again.rows.length], [0, 0]);
  assert.match(reason, /the security-merge-policy producer was already re-run at this head/);

  const moved = harness(ledger, async () => ({ ...CLEARED, headSha: NEXT }));
  await sweep.observeCodeqlConfigurationWarning(moved.deps, ledger, view({ headSha: NEXT }), "wait");
  assert.deepEqual(moved.dispatched, [PR], "a new head is its own dispatch");
  assert.deepEqual(moved.rows.map((r) => [r.step, r.head_sha]), [[STEP, NEXT]]);
  const otherPr = harness(ledger, async () => CLEARED);
  await sweep.observeCodeqlConfigurationWarning(otherPr.deps, ledger, view({ prNumber: PR + 1 }), "wait");
  assert.deepEqual(otherPr.dispatched, [PR + 1], "another PR at the same head is not covered by this PR's row");
});

test("W1-T13787 criterion 2: overlapping full passes share one redispatch receipt", { timeout: 10_000 }, async () => {
  let releaseReads!: () => void;
  const bothObserving = new Promise<void>((resolve) => { releaseReads = resolve; });
  let reads = 0;
  const read = async () => {
    if (++reads === 2) releaseReads();
    await bothObserving;
    return CLEARED;
  };
  const first = harness([], read);
  const second = harness([], read);
  const ledgerPath = join(ROOT, "overlap.ndjson");
  const passes = [first, second].map(({ deps }, index) =>
    ({ ...deps, runId: `OVERLAP-${index}`, ledgerPath, readLedger: undefined, appendLine: undefined }));
  const results = await Promise.all(passes.map((deps) => sweep.runSweep([view()], deps)));
  assert.equal(results.filter((result) => result.actions.some(({ reason }) =>
    reason.includes("could not record a producer dispatch at this head (database is locked)"))).length, 1);
  assert.equal(reads, 2);

  const nextPass = await sweep.runSweep([view()], passes[1]!);
  assert.match(nextPass.actions[0]!.reason, /producer was already re-run at this head/);
  assert.deepEqual([...first.dispatched, ...second.dispatched], [PR]);
  assert.equal(readLedgerLines(ledgerPath).filter((row) => row.step === STEP).length, 1);
});

test("W1-T13787 criterion 2: a competing ledger writer defers the dispatch until a later pass", async () => {
  const h = harness([], async () => CLEARED);
  h.deps.ledgerPath = join(ROOT, "locked.ndjson");
  const lock = new DatabaseSync(`${h.deps.ledgerPath}.security-producer.lock.sqlite`);
  try {
    lock.exec("BEGIN IMMEDIATE");
    const reason = await sweep.observeCodeqlConfigurationWarning(h.deps, [], view(), "wait");
    assert.match(reason, /could not record a producer dispatch at this head \(database is locked\)/);
    assert.deepEqual(h.dispatched, []);
    assert.equal(h.rows.length, 0);
  } finally {
    lock.close();
  }
  await sweep.observeCodeqlConfigurationWarning(h.deps, [], view(), "wait");
  assert.deepEqual(h.dispatched, [PR]);
  assert.equal(h.rows.filter((row) => row.step === STEP).length, 1);
});

test("W1-T13787 criterion 2: an archived receipt still suppresses a dispatch at the same head", async () => {
  const dir = join(ROOT, "rotation");
  mkdirSync(dir);
  const ledgerPath = join(dir, "ledger.ndjson");
  const receipts = Array.from({ length: MAX_RETAINED_LINES_PER_STEP + 1 }, (_, offset) =>
    JSON.stringify({ ts: T1, step: STEP, pr_number: PR + offset, head_sha: HEAD }));
  const content = `${receipts.join("\n")}\n`;
  writeFileSync(ledgerPath, content);
  assert.equal(rotateLedger(ledgerPath, { ceilingBytes: Buffer.byteLength(content) - 1 }).rotated, true);
  assert.ok(!readLedgerLines(ledgerPath).some((row) => row.step === STEP && row.pr_number === PR));
  const h = harness([], async () => CLEARED);
  const reason = await sweep.observeCodeqlConfigurationWarning({ ...h.deps, ledgerPath, readLedger: undefined }, [], view(), "wait");
  assert.deepEqual(h.dispatched, []);
  assert.match(reason, /producer was already re-run at this head/);
});

test("W1-T13787 criterion 3: no dispatch without a cleared read at this head; a failed dispatch is written once and keeps the wait", async () => {
  for (const [why, answer] of [
    ["the warning still stands", async () => STILL_WARNS],
    ["the reason still reads configuration-not-found", async () => ({ ...CLEARED, decision: { state: "unknown", mergeAllowed: false, reason: REASON } })],
    ["the read answered another head", async () => ({ ...CLEARED, headSha: NEXT })],
    ["the read failed", async () => { throw new Error("HTTP 502"); }],
  ] as Array<[string, () => Promise<SecurityMergeObservation>]>) {
    const h = harness([], answer);
    await sweep.observeCodeqlConfigurationWarning(h.deps, [], view(), "wait");
    assert.equal(h.dispatched.length, 0, why);
    assert.equal(h.rows.filter((r) => r.step === STEP).length, 0, why);
  }

  const refused = harness([], async () => CLEARED, async () => {
    assert.equal(refused.rows.filter((r) => r.step === STEP).length, 1, "the receipt precedes the dispatch");
    throw new Error("HTTP 422 workflow not dispatchable");
  });
  await sweep.runSweep([view()], refused.deps);
  assert.deepEqual(refused.dispatched, [PR]);
  assert.equal(refused.rows.filter((r) => r.step === STEP).length, 1, "the failed dispatch leaves one receipt");
  assert.equal(refused.rows.some((r) => String(r.step).startsWith("fix.") || r.step === "sweep.fix_dispatch"), false, "no fix round row");
  const disposed = refused.rows.filter((r) => r.step === "sweep.disposed");
  assert.equal(disposed.length, 1);
  assert.deepEqual([disposed[0]!.disposition, disposed[0]!.acted, disposed[0]!.blocker], ["wait", false, "security-unknown-hold"]);
  assert.match(String(disposed[0]!.reason), /the producer dispatch failed \(HTTP 422 workflow not dispatchable\) and is not repeated at this head/);
  const retry = harness(refused.rows, async () => CLEARED);
  await sweep.observeCodeqlConfigurationWarning(retry.deps, refused.rows, view(), "wait");
  assert.equal(retry.dispatched.length, 0, "a failed dispatch is not retried at this head");
});

test("W1-T13787 criterion 3: the real adapter's failed read and changed final head both keep waiting", async (t) => {
  for (const [name, problem] of [
    ["502 after the first PR read", "security-api-unavailable"],
    ["moved head on final recheck", "head-or-base-changed-during-observation"],
    ["incomplete check corpus", "check-corpus-incomplete"],
    ["duplicate check generation", "check-generation-ambiguous"],
  ] as const) {
    await t.test(name, async () => {
      const reads: string[] = [];
      const writes: string[][] = [];
      const effects = productionEffects(async ([method, path]) => {
        assert.equal(method, "api");
        reads.push(path!);
        switch (path) {
          case PR_ENDPOINT: return reads.length === 1 || problem !== "head-or-base-changed-during-observation"
            ? PR_METADATA : { ...PR_METADATA, head: { sha: NEXT } };
          case FILE_ENDPOINT:
            if (problem === "security-api-unavailable") throw new Error("HTTP 502");
            return [{ filename: "src/example.ts" }];
          case CHECK_ENDPOINT: return problem === "check-generation-ambiguous"
            ? { total_count: 2, check_runs: [CLEARED_CHECK, CLEARED_CHECK] }
            : { total_count: problem === "check-corpus-incomplete" ? 2 : 1, check_runs: [CLEARED_CHECK] };
          default: assert.fail(`unexpected metadata read ${path}`);
        }
      }, writes);
      const h = harness([], async () => CLEARED);
      const result = await sweep.runSweep([view()], { ...h.deps, readSecurityMergeObservation: effects.readSecurityMergeObservation,
        dispatchSecurityMergeProducer: effects.dispatchSecurityMergeProducer });
      assert.deepEqual(reads, problem === "security-api-unavailable" ? [PR_ENDPOINT, FILE_ENDPOINT]
        : [PR_ENDPOINT, FILE_ENDPOINT, CHECK_ENDPOINT, PR_ENDPOINT]);
      assert.deepEqual(writes, []);
      assert.equal(h.rows.filter((r) => r.step === STEP).length, 0);
      assert.deepEqual(result.actions.map(({ disposition, acted }) => [disposition, acted]), [["wait", false]]);
      assert.ok(result.actions[0]?.reason?.includes(problem));
    });
  }
});

test("W1-T13787 criterion 4: the production effects dispatch security-merge-policy.yml on main with the pr_number input", async () => {
  const calls: string[][] = [];
  const effects = productionEffects(async ([method, path]) => {
    assert.equal(method, "api");
    switch (path) {
      case PR_ENDPOINT: return PR_METADATA;
      case FILE_ENDPOINT: return [{ filename: "src/example.ts" }];
      case CHECK_ENDPOINT: return { total_count: 1, check_runs: [CLEARED_CHECK] };
      default: assert.fail(`unexpected metadata read ${path}`);
    }
  }, calls);
  const h = harness([], async () => CLEARED);
  const result = await sweep.runSweep([view()], { ...h.deps, readSecurityMergeObservation: effects.readSecurityMergeObservation,
    dispatchSecurityMergeProducer: effects.dispatchSecurityMergeProducer });
  assert.deepEqual(calls, [["gh", "api", "-X", "POST", "repos/craigoley/remudero/actions/workflows/security-merge-policy.yml/dispatches",
    "-f", "ref=main", "-f", `inputs[pr_number]=${PR}`]]);
  assert.equal(h.rows.filter((r) => r.step === STEP).length, 1);
  assert.match(String(result.actions[0]?.reason), /fresh read answers safe: trusted-complete-exact-head-no-new-alerts/);
});
