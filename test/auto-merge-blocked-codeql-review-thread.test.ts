import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildOpenPrViews } from "../src/run-task.js";
import { reviewInputDigest } from "../src/lib/review.js";
import {
  classifyScannerBlocker,
  hydrateMergeStateObservations,
  hydrateScannerBlockerObservations,
  isScannerBlockerCandidate,
  observeScannerBlocker,
  reviewCommentsRestArgs,
  scannerAlertsRestArgs,
  SCANNER_BLOCKER_HYDRATION_CAP,
  SCANNER_DIAGNOSTIC_MAX_CHARS,
  type ScannerBlockerCandidate,
  type ScannerBlockerObservation,
} from "../src/lib/open-prs-rest.js";
import {
  CODEQL_BLOCKER_DISPATCH_STEP,
  codeqlBlockerCiFailure,
  codeqlBlockerDedupeKey,
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  repairableCodeqlBlocker,
  runSweep,
  scannerBlockerAmbiguity,
  type ArmedStalledPr,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";

/*
 * W1-T3980 — core PR #7495 (2026-09-27): every required context green, `mergeable: true`, auto-merge
 * armed, and still `mergeable_state: "blocked"` because one CodeQL review thread
 * (`js/file-system-race`) stayed open under a conversation-resolution rule. The sweep read the PR as
 * `mergeable`, re-arming changed nothing, and it waited forever. These tests drive the REAL
 * producer (`buildOpenPrViews` over an injected REST fetch) into the REAL disposition table and
 * `runSweep`, then walk every negative arm the shard names.
 */

const OWNER = "craigoley";
const REPO = "remudero";
const PR = 7495;
const TASK = "W1-T3980";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const MERGE = "f0e1d2c3b4a5968778695a4b3c2d1e0f98765432";
const BRANCH = `run-${TASK}-1790553732270`;
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR}`;
const BODY = `Remudero-Task: ${TASK}`;
const ALERT = 42;
const NOW = Date.parse("2026-09-27T12:00:00Z");

function codeqlAlert(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: ALERT,
    rule: { id: "js/file-system-race" },
    tool: { name: "CodeQL" },
    most_recent_instance: {
      ref: `refs/pull/${PR}/merge`,
      commit_sha: MERGE,
      message: { text: "The file may have changed since it was checked." },
      location: { path: "src/lib/state.ts", start_line: 88 },
    },
    ...over,
  };
}

function botThread(alertNumber: number = ALERT): Record<string, unknown> {
  return {
    body: `## Potential file system race condition\n[Show more details](https://github.com/${OWNER}/${REPO}/security/code-scanning/${alertNumber})`,
    user: { login: "github-advanced-security[bot]", type: "Bot" },
  };
}

const CANDIDATE: ScannerBlockerCandidate = {
  number: PR,
  headSha: HEAD,
  merge: { mergeable: true, mergeableState: "blocked", state: "clean", mergeCommitSha: MERGE, headSha: HEAD },
};

/** A REST fetch answering every read the producer makes, from one declared scene. */
function sceneFetch(over: {
  aheadBy?: number;
  alerts?: unknown;
  comments?: unknown;
  seen?: string[];
} = {}): (args: string[]) => unknown {
  return (args) => {
    const path = args[args.length - 1] ?? "";
    over.seen?.push(path);
    if (/pulls\?state=open/.test(path)) {
      return [
        {
          number: PR,
          html_url: PR_URL,
          head: { ref: BRANCH, sha: HEAD },
          updated_at: "2026-09-27T11:00:00.000Z",
          body: BODY,
          auto_merge: { merge_method: "squash" },
          draft: false,
          state: "open",
        },
      ];
    }
    if (path.includes("/check-runs")) {
      return {
        check_runs: [
          { name: "ci-gate", status: "completed", conclusion: "success", started_at: "2026-09-27T10:00:00Z", completed_at: "2026-09-27T10:05:00Z" },
        ],
      };
    }
    if (path.endsWith(`/commits/${HEAD}/status`)) {
      return { statuses: [{ context: "remudero-review", state: "success", created_at: "2026-09-27T10:10:00Z", updated_at: "2026-09-27T10:10:00Z" }] };
    }
    if (path.endsWith(`/pulls/${PR}`)) {
      return { mergeable: true, mergeable_state: "blocked", merge_commit_sha: MERGE, head: { sha: HEAD } };
    }
    if (path.includes("/compare/")) return { ahead_by: over.aheadBy ?? 0 };
    if (path.includes("/code-scanning/alerts")) return over.alerts ?? [codeqlAlert()];
    if (path.includes(`/pulls/${PR}/comments`)) return over.comments ?? [botThread()];
    return [];
  };
}

/** Build the real views over a temp ledger that already carries this exact input's verdict. */
function producedViews(fetch: (args: string[]) => unknown): { views: OpenPrView[]; rows: Record<string, unknown>[] } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-codeql-thread-"));
  try {
    const rows: Record<string, unknown>[] = [
      {
        ts: "2026-09-27T10:11:00.000Z",
        step: "review.posted",
        task_id: TASK,
        head_sha: HEAD,
        pr_url: PR_URL,
        review_input_digest: reviewInputDigest(HEAD, BODY),
      },
    ];
    const path = join(dir, "rows.ndjson");
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const views = buildOpenPrViews(OWNER, REPO, path, {
      fetch,
      requiredContexts: () => ["ci-gate"],
      readMainPlan: () => ({ tasks: [], byId: new Map() }),
    });
    return { views, rows };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function blockedPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR,
    prUrl: PR_URL,
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-27T11:00:00Z", // expiring-fixture: exempt -- compared only against this suite's INJECTED now (NOW), never the wall clock; 13/13 pass with Date.now shifted +30d
    headSha: HEAD,
    headRefName: BRANCH,
    autoMergeArmed: true,
    isDraft: false,
    mergeState: "clean",
    mergeable: true,
    mergeableState: "blocked",
    scannerBlocker: classifyScannerBlocker(CANDIDATE, [codeqlAlert()], [botThread()]),
    ...over,
  };
}

interface Recorded {
  events: string[];
  rows: Record<string, unknown>[];
  dispatched: FixDispatchEvidence[];
  escalated: string[];
}

function sweepDeps(prior: Record<string, unknown>[], over: Partial<SweepDeps> = {}): { deps: SweepDeps; rec: Recorded } {
  const rec: Recorded = { events: [], rows: [], dispatched: [], escalated: [] };
  const deps: SweepDeps = {
    arm: () => {
      rec.events.push("arm");
    },
    close: () => {},
    dispatchFix: (_pr, evidence) => {
      rec.events.push("dispatch");
      rec.dispatched.push(evidence);
    },
    escalate: (_pr, reason) => {
      rec.escalated.push(reason);
    },
    ledgerPath: "/nonexistent/rmd-w1-t3980/rows.ndjson",
    runId: "SWEEP-W1-T3980",
    now: () => NOW,
    readLedger: () => [...prior, ...rec.rows],
    appendLine: (_path, row) => {
      rec.events.push(`row:${String(row.step)}`);
      rec.rows.push(row);
    },
    ...over,
  };
  return { deps, rec };
}

test("the producer hydrates one current CodeQL thread and the sweep dispatches exactly one repair on that PR branch", async () => {
  const { views, rows } = producedViews(sceneFetch());
  assert.equal(views.length, 1);
  const view = views[0];
  assert.equal(view.scannerBlocker?.kind, "codeql-singleton");
  assert.equal(deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-fixable");

  const { deps, rec } = sweepDeps(rows);
  await runSweep([view], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(rec.dispatched.length, 1, "exactly one constrained fix worker");
  assert.deepEqual(rec.dispatched[0].unmetCriteria, []);
  const failure = rec.dispatched[0].ciFailures?.[0];
  assert.equal(failure?.name, `CodeQL alert #${ALERT} (js/file-system-race)`);
  assert.match(failure?.logTail ?? "", /UNTRUSTED SCANNER EVIDENCE/);
  assert.match(failure?.logTail ?? "", /location: src\/lib\/state\.ts:88/);
  assert.match(failure?.logTail ?? "", /Do not resolve review threads, dismiss alerts/);
  assert.equal(rec.events.includes("arm"), false, "a re-arm is not the remedy");

  const dispatchRow = rec.rows.find((row) => row.step === CODEQL_BLOCKER_DISPATCH_STEP);
  assert.equal(dispatchRow?.dedupe_key, `${PR}@${HEAD}#${ALERT}`);
  assert.equal(dispatchRow?.rule_id, "js/file-system-race");
  assert.ok(
    rec.events.indexOf(`row:${CODEQL_BLOCKER_DISPATCH_STEP}`) < rec.events.indexOf("dispatch"),
    "the identity and dedupe key are ledgered before the worker starts",
  );
  const disposed = rec.rows.find((row) => row.step === "sweep.disposed");
  assert.equal(disposed?.disposition, "blocked-fixable");
  assert.equal(disposed?.acted, true);
  assert.equal(disposed?.codeql_blocker_dedupe_key, `${PR}@${HEAD}#${ALERT}`);
});

test("a second unchanged pass over the same PR, head and alert starts no second worker", async () => {
  const { views, rows } = producedViews(sceneFetch());
  const first = sweepDeps(rows);
  await runSweep(views, first.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(first.rec.dispatched.length, 1);

  const second = sweepDeps([...rows, ...first.rec.rows]);
  await runSweep(views, second.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(second.rec.dispatched.length, 0);
  const disposed = second.rec.rows.find((row) => row.step === "sweep.disposed");
  assert.equal(disposed?.acted, false);
  assert.match(String(disposed?.stand_down_reason), /already dispatched for 7495@a1b2c3d/);

  const moved = sweepDeps([...rows, ...first.rec.rows]);
  const newHead = "9".repeat(40);
  const movedView = blockedPr({
    headSha: newHead,
    scannerBlocker: classifyScannerBlocker({ ...CANDIDATE, headSha: newHead, merge: { ...CANDIDATE.merge, headSha: newHead } }, [codeqlAlert()], [botThread()]),
  });
  await runSweep([movedView], moved.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(moved.rec.dispatched.length, 1, "a new head re-earns exactly one repair");
});

test("a human-authored thread beside the CodeQL alert is named blocked-ambiguous and never repaired", async () => {
  const human = { body: "Please rename this.", user: { login: "craigoley", type: "User" } };
  const observed = classifyScannerBlocker(CANDIDATE, [codeqlAlert()], [botThread(), human]);
  assert.equal(observed.kind, "ambiguous");
  assert.equal(observed.kind === "ambiguous" ? observed.cause : undefined, "human-thread");

  const pr = blockedPr({ scannerBlocker: observed });
  assert.equal(repairableCodeqlBlocker(pr), undefined);
  const result = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /human-thread/);
  assert.match(result.reason, /no thread is resolved and no alert dismissed/);

  const { deps, rec } = sweepDeps([]);
  await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(rec.dispatched.length, 0);
  assert.equal(rec.escalated.length, 1);
});

test("a CodeQL alert observed on a mismatched merge ref is stale evidence, not a repair", () => {
  const observed = classifyScannerBlocker(
    CANDIDATE,
    [codeqlAlert({ most_recent_instance: { ...(codeqlAlert().most_recent_instance as object), ref: "refs/heads/main" } })],
    [botThread()],
  );
  assert.deepEqual(
    observed.kind === "ambiguous" ? observed.cause : observed.kind,
    "stale",
  );
  const result = deriveDisposition(blockedPr({ scannerBlocker: observed }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /stale: alert #42 was observed on refs\/heads\/main/);
});

test("an old merge commit, a moved head, or unobserved merge facts are each stale", () => {
  const cause = (o: ScannerBlockerObservation): string => (o.kind === "ambiguous" ? o.cause : o.kind);
  const oldMerge = codeqlAlert({ most_recent_instance: { ...(codeqlAlert().most_recent_instance as object), commit_sha: "0".repeat(40) } });
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [oldMerge], [botThread()])), "stale");
  assert.equal(cause(classifyScannerBlocker({ ...CANDIDATE, merge: undefined }, [codeqlAlert()], [botThread()])), "stale");
  const moved = { ...CANDIDATE, merge: { ...CANDIDATE.merge, headSha: "b".repeat(40) } };
  assert.equal(cause(classifyScannerBlocker(moved, [codeqlAlert()], [botThread()])), "stale");

  const singletonElsewhere = blockedPr({ headSha: "c".repeat(40) });
  assert.match(scannerBlockerAmbiguity(singletonElsewhere, DEFAULT_SWEEP_POLICY) ?? "", /^stale: the CodeQL alert was observed at a different head/);
  assert.equal(deriveDisposition(singletonElsewhere, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
});

test("non-CodeQL alerts, other bots' threads, several alerts and unthreaded alerts all refuse the route", () => {
  const cause = (o: ScannerBlockerObservation): string => (o.kind === "ambiguous" ? o.cause : o.kind);
  const otherTool = codeqlAlert({ number: 43, tool: { name: "Semgrep" } });
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [codeqlAlert(), otherTool], [botThread()])), "non-codeql");
  const copilot = { body: "Consider a guard.", user: { login: "copilot-pull-request-reviewer[bot]", type: "Bot" } };
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [codeqlAlert()], [botThread(), copilot])), "non-codeql");
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [codeqlAlert(), codeqlAlert({ number: 44 })], [botThread()])), "multiple");
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [codeqlAlert()], [])), "unthreaded");
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [codeqlAlert()], [botThread(420)])), "unthreaded", "#420 does not cite #42");
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [codeqlAlert()], [{ user: { login: "github-advanced-security[bot]", type: "Bot" } }])), "unthreaded");
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [codeqlAlert()], [botThread(420), botThread()])), "codeql-singleton");
  for (const observed of [
    classifyScannerBlocker(CANDIDATE, [codeqlAlert(), otherTool], [botThread()]),
    classifyScannerBlocker(CANDIDATE, [codeqlAlert(), codeqlAlert({ number: 44 })], [botThread()]),
  ]) {
    assert.equal(deriveDisposition(blockedPr({ scannerBlocker: observed }), DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
  }
});

test("unreadable or truncated scanner reads are named unreadable, never an absent blocker", () => {
  const cause = (o: ScannerBlockerObservation): string => (o.kind === "ambiguous" ? o.cause : o.kind);
  const page = Array.from({ length: 100 }, () => botThread());
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, { message: "Not Found" }, [botThread()])), "unreadable");
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [codeqlAlert()], page)), "unreadable");
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [codeqlAlert()], null)), "unreadable");
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [codeqlAlert({ rule: null })], [botThread()])), "unreadable");
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [codeqlAlert({ most_recent_instance: null })], [botThread()])), "unreadable");
  const unlocated = codeqlAlert({ most_recent_instance: { ...(codeqlAlert().most_recent_instance as object), location: { path: "x.ts" } } });
  assert.equal(cause(classifyScannerBlocker(CANDIDATE, [unlocated], [botThread()])), "unreadable");

  const failing = (target: string) => (args: string[]): unknown => {
    if ((args[1] ?? "").includes(target)) throw new Error("HTTP 403");
    return sceneFetch()(args);
  };
  assert.equal(cause(observeScannerBlocker(OWNER, REPO, CANDIDATE, failing("/compare/"))), "unreadable");
  assert.equal(cause(observeScannerBlocker(OWNER, REPO, CANDIDATE, failing("/code-scanning/"))), "unreadable");
  assert.equal(cause(observeScannerBlocker(OWNER, REPO, CANDIDATE, failing("/comments"))), "unreadable");
  assert.equal(cause(observeScannerBlocker(OWNER, REPO, CANDIDATE, () => null)), "unreadable");

  const unreadable = blockedPr({ scannerBlocker: observeScannerBlocker(OWNER, REPO, CANDIDATE, failing("/code-scanning/")) });
  const result = deriveDisposition(unreadable, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /unreadable: the code-scanning alert read failed/);
});

test("a positive-distance stale-blocked PR stays with the branch refresh and never reaches this route", async () => {
  const seen: string[] = [];
  const observed = observeScannerBlocker(OWNER, REPO, CANDIDATE, sceneFetch({ aheadBy: 3, seen }));
  assert.deepEqual(observed, { kind: "base-behind", behindBy: 3 });
  assert.deepEqual(seen, [`repos/${OWNER}/${REPO}/compare/${HEAD}...main`], "one read, no scanner read on a stale merge ref");

  const pr = blockedPr({ scannerBlocker: observed });
  assert.equal(scannerBlockerAmbiguity(pr, DEFAULT_SWEEP_POLICY), undefined);
  assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW).disposition, "mergeable");

  const updates: ArmedStalledPr[] = [];
  const { deps, rec } = sweepDeps([], {
    behindMainByPr: new Map([[PR, 3]]),
    updateBranch: (target) => {
      updates.push(target);
      return "updated";
    },
  });
  await runSweep([pr], deps, { ...DEFAULT_SWEEP_POLICY, reviewWaitingBranchRefreshEnabled: true, reviewWaitingBranchRefreshThreshold: 10 });
  assert.equal(updates[0]?.updateReason, "stale-blocked");
  assert.equal(rec.dispatched.length, 0);
});

test("no alert, a non-candidate PR, a foreign branch and an exhausted budget each leave the singleton route closed", () => {
  const none = blockedPr({ scannerBlocker: classifyScannerBlocker(CANDIDATE, [], [botThread()]) });
  assert.deepEqual(none.scannerBlocker, { kind: "no-scanner-alert" });
  assert.equal(deriveDisposition(none, DEFAULT_SWEEP_POLICY, NOW).disposition, "mergeable");

  const clean = blockedPr({ mergeableState: "clean" });
  assert.equal(isScannerBlockerCandidate(clean), false);
  assert.equal(repairableCodeqlBlocker(clean), undefined);
  assert.equal(scannerBlockerAmbiguity(clean, DEFAULT_SWEEP_POLICY), undefined);
  assert.equal(deriveDisposition(clean, DEFAULT_SWEEP_POLICY, NOW).disposition, "mergeable");
  assert.equal(isScannerBlockerCandidate(blockedPr()), true);

  const foreign = blockedPr({ headRefName: "feature/human-branch" });
  assert.equal(repairableCodeqlBlocker(foreign), undefined);
  assert.match(deriveDisposition(foreign, DEFAULT_SWEEP_POLICY, NOW).reason, /foreign-branch/);
  assert.equal(repairableCodeqlBlocker(blockedPr({ taskId: undefined })), undefined);

  // W1-T7096 (ruling 2026-10-09: "an llm judge should determine if more fix attempts should be made"): the count makes
  // a judgment DUE; the strikes-exhausted route is taken once the progress judge rules the rounds a loop.
  const exhausted = blockedPr({ priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap, progressEscalation: { loop: "fix rounds repeat without progress", reason: "the progress judge ruled the rounds a loop", judged: true } });
  assert.notEqual(repairableCodeqlBlocker(exhausted), undefined);
  assert.equal(deriveDisposition(blockedPr({ priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap }), DEFAULT_SWEEP_POLICY, NOW).disposition,
    "blocked-fixable", "an unjudged repair at the former ceiling is a judgment due, not a closed route");
  const result = deriveDisposition(exhausted, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /exhausted: fix strikes/);
});

test("the producer hydrates only the candidate population, at most the per-pass cap", () => {
  const seen: string[] = [];
  const candidates = Array.from({ length: SCANNER_BLOCKER_HYDRATION_CAP + 2 }, (_, i) => ({ ...CANDIDATE, number: 100 + i }));
  const observed = hydrateScannerBlockerObservations(OWNER, REPO, candidates, sceneFetch({ seen }));
  assert.equal(observed.size, SCANNER_BLOCKER_HYDRATION_CAP);
  assert.equal(seen.filter((p) => p.includes("/compare/")).length, SCANNER_BLOCKER_HYDRATION_CAP);

  const { views } = producedViews(sceneFetch());
  assert.equal(views[0].scannerBlocker?.kind, "codeql-singleton");
  const quiet: string[] = [];
  const cleanFetch = sceneFetch({ seen: quiet });
  const notBlocked = (args: string[]): unknown =>
    (args[1] ?? "").endsWith(`/pulls/${PR}`) ? { mergeable: true, mergeable_state: "clean", merge_commit_sha: MERGE, head: { sha: HEAD } } : cleanFetch(args);
  const cleanViews = producedViews(notBlocked).views;
  assert.equal(cleanViews[0].scannerBlocker, undefined);
  assert.equal(quiet.some((p) => p.includes("/code-scanning/") || p.includes("/compare/")), false, "a non-candidate costs no scanner read");
});

test("the merge-fact read retains the merge commit and head the singleton is pinned to", () => {
  const observations = hydrateMergeStateObservations(OWNER, REPO, [PR], () => ({
    mergeable: true,
    mergeable_state: "blocked",
    merge_commit_sha: MERGE,
    head: { sha: HEAD },
  }));
  assert.deepEqual(observations.get(PR), { state: "clean", mergeable: true, mergeableState: "blocked", mergeCommitSha: MERGE, headSha: HEAD });
  assert.deepEqual(scannerAlertsRestArgs(OWNER, REPO, PR), [
    "api",
    `repos/${OWNER}/${REPO}/code-scanning/alerts?ref=refs/pull/${PR}/merge&state=open&per_page=100`,
  ]);
  assert.deepEqual(reviewCommentsRestArgs(OWNER, REPO, PR), ["api", `repos/${OWNER}/${REPO}/pulls/${PR}/comments?per_page=100`]);
});

test("the scanner diagnostic is size-bounded and the repair evidence never asks for a thread or alert action", () => {
  const long = codeqlAlert({ most_recent_instance: { ...(codeqlAlert().most_recent_instance as object), message: { text: "x".repeat(5000) } } });
  const observed = classifyScannerBlocker(CANDIDATE, [long], [botThread()]);
  assert.equal(observed.kind === "codeql-singleton" ? observed.alert.message.length : -1, SCANNER_DIAGNOSTIC_MAX_CHARS);
  const silent = classifyScannerBlocker(
    CANDIDATE,
    [codeqlAlert({ most_recent_instance: { ...(codeqlAlert().most_recent_instance as object), message: null } })],
    [botThread()],
  );
  assert.equal(silent.kind === "codeql-singleton" ? silent.alert.message : undefined, "");

  const failure = codeqlBlockerCiFailure({ alertNumber: 7, ruleId: "js/unused-local-variable", path: "a.tsx", line: 40, message: "Unused variable x." });
  assert.equal(failure.name, "CodeQL alert #7 (js/unused-local-variable)");
  assert.match(failure.logTail, /Change this branch's code so the finding no longer applies/);
  assert.equal(codeqlBlockerDedupeKey({ prNumber: 1579, headSha: "h" }, { alertNumber: 7 }), "1579@h#7");
});

test("the repair shares the fix rung's hold, claim, host admission and detached wait", async () => {
  const pr = blockedPr();
  const held = sweepDeps([], { workerAdmissionHold: () => "fleet hold: paused" });
  await runSweep([pr], held.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(held.rec.dispatched.length, 0);
  assert.equal(held.rec.rows.some((row) => row.step === CODEQL_BLOCKER_DISPATCH_STEP), false, "no key is spent on a hold");

  const strikes = Array.from({ length: DEFAULT_SWEEP_POLICY.strikeCap }, () => ({ step: "fix.dispatch", task_id: TASK, head_sha: HEAD }));
  const claimed = sweepDeps([], { readLedger: () => strikes });
  await runSweep([pr], claimed.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(claimed.rec.dispatched.length, 0);
  assert.match(String(claimed.rec.rows.find((row) => row.step === "sweep.disposed")?.stand_down_reason), /strikes exhausted under the claim/);

  const refused = sweepDeps([], { claimFixAdmission: () => ({ admitted: false, reason: "host slots full" }) });
  await runSweep([pr], refused.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(refused.rec.dispatched.length, 0);
  assert.equal(refused.rec.rows.find((row) => row.step === "sweep.disposed")?.stand_down_reason, "host slots full");

  const detached = sweepDeps([], { detachFixWait: true });
  await runSweep([pr], detached.deps, DEFAULT_SWEEP_POLICY);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detached.rec.dispatched.length, 1);

  const unspent = sweepDeps([], { dispatchFix: () => false });
  await runSweep([pr], unspent.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(unspent.rec.rows.find((row) => row.step === "sweep.disposed")?.spent, false);
});
