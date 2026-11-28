/**
 * W1-T12891 — A PULL REQUEST THE SWEEP CLOSED BECAUSE ITS TASK'S DEPENDENCY WAS UNMERGED IS REOPENED WHEN
 * THAT DEPENDENCY MERGES.
 *
 * MEASURED 2026-11-15: the sweep closed #18581 (W1-T12214) and #18570 (W1-T12213) as "unmet dependency in the
 * current plan: W1-T12209 — the plan resequenced after this PR was admitted". W1-T12209 merged at 02:41Z (#18534).
 * Neither pull request had a sweep row after its close, and both stayed closed 13.5 hours until an operator
 * reopened them by hand. Each fixture below drives real sweep passes over a real ledger in a private directory.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY,
  PLAN_RESEQUENCE_CLOSE_MARKER,
  createResequenceCloseReversalPort,
  deriveDisposition,
  keepResequenceClose,
  keptResequenceCloseFor,
  readKeptResequenceCloses,
  resequenceCloseLifecycleFrom,
  runSweep,
  type KeptResequenceClose,
  type OpenPrView,
  type ResequenceCloseLifecycle,
  type ResequenceCloseReversalPort,
  type ResequenceDependencyState,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";

const CLOSED_AT_MS = Date.parse("2026-11-14T23:03:00.000Z");
const LATER_MS = Date.parse("2026-11-15T02:50:00.000Z");
const PR_NUMBER = 18581;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
const TASK_ID = "W1-T12214";
const DEP_ID = "W1-T12209";
const HEAD_REF = "run-W1-T12214-1794700000000";
const REVERSED = "sweep.resequence_close_reversed";
const REVERSE_FAILED = "sweep.resequence_close_reverse_failed";

/** The #18581 shape as the producer hands it to the sweep: an implementation PR whose task the plan now
 *  holds behind an unmet dependency. */
function resequencedPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR_NUMBER,
    prUrl: PR_URL,
    taskId: TASK_ID,
    headRefName: HEAD_REF,
    headSha: "c".repeat(40),
    reviewState: "none",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(CLOSED_AT_MS - 60_000).toISOString(),
    autoMergeArmed: false,
    isPlanFiling: false,
    planFilingSource: "not-plan-only",
    planResequenceIneligible: `unmet dependency in the current plan: ${DEP_ID}`,
    planResequenceUnmetDependencies: [DEP_ID],
    ...over,
  };
}

/** Every row the fixture's ledger holds, parsed as the sweep wrote it. */
function readLedgerLines(ledgerPath: string): Array<Record<string, unknown>> {
  return readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface PortDouble {
  state: ResequenceCloseLifecycle["state"];
  events: Array<{ event: "closed" | "reopened"; at: string }>;
  head: boolean;
  reopenError?: Error;
  lifecycleError?: Error;
  headError?: Error;
  truncated?: boolean;
  open: Array<{ number: number; headRef: string }>;
  openError?: Error;
  reads: number;
  reopened: Array<{ prUrl: string; comment: string }>;
}

function reversalPort(over: Partial<PortDouble> = {}): PortDouble & { port: ResequenceCloseReversalPort } {
  const gh: PortDouble = { state: "closed", events: [{ event: "closed", at: new Date(CLOSED_AT_MS).toISOString() }], head: true,
    open: [], reads: 0, reopened: [], ...over };
  return Object.assign(gh, {
    port: {
      readLifecycle: async () => {
        gh.reads++;
        if (gh.lifecycleError) throw gh.lifecycleError;
        return { state: gh.state, events: gh.events, ...(gh.truncated ? { truncated: true } : {}) };
      },
      headExists: async () => {
        if (gh.headError) throw gh.headError;
        return gh.head;
      },
      openPullRequests: async () => {
        if (gh.openError) throw gh.openError;
        return gh.open;
      },
      reopen: async (kept: KeptResequenceClose, comment: string) => {
        if (gh.reopenError) throw gh.reopenError;
        gh.reopened.push({ prUrl: kept.prUrl, comment });
      },
    } satisfies ResequenceCloseReversalPort,
  });
}

function harness(gh: ReturnType<typeof reversalPort>, over: Partial<SweepDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12891-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  let clock = CLOSED_AT_MS;
  const closed: OpenPrView[] = [];
  const deps: SweepDeps = {
    ledgerPath,
    runId: "SWEEP-W1-T12891",
    now: () => clock,
    arm: () => {},
    close: (pr) => { closed.push(pr); },
    dispatchFix: () => {},
    escalate: () => {},
    log: () => {},
    resequenceCloseReversal: gh.port,
    ...over,
  };
  return {
    dir, ledgerPath, deps, closed,
    at: (ms: number) => { clock = ms; },
    merged: (taskId: string) => appendFileSync(ledgerPath, `${JSON.stringify({ step: "verdict.merged", task_id: taskId, ts: new Date(clock).toISOString() })}\n`),
    rows: (step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Pass one closes the PR for its unmet dependency; the returned harness is positioned after that close. */
async function closedForUnmetDependency(gh: ReturnType<typeof reversalPort>, over: Partial<SweepDeps> = {}) {
  const h = harness(gh, over);
  const pr = resequencedPr();
  assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, CLOSED_AT_MS).disposition, "stale", "precondition: the resequence row closes it");
  await runSweep([pr], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.closed.map((p) => p.prNumber), [PR_NUMBER], "precondition: pass one closed the PR");
  assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 1, "precondition: the close is kept");
  h.at(LATER_MS);
  return h;
}

test("W1-T12891 criterion 1: a resequence close is reopened once every named dependency reads merged, and one sweep.resequence_close_reversed row names it", async () => {
  const gh = reversalPort();
  const h = await closedForUnmetDependency(gh);
  try {
    // While W1-T12209 is unmerged nothing happens; once its merge credit lands the next full pass reopens.
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(gh.reopened.length, 0, "no reopen while the dependency is unmerged");
    h.merged(DEP_ID);
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(gh.reopened.map((r) => r.prUrl), [PR_URL], "the PR is reopened");
    assert.match(gh.reopened[0]!.comment, new RegExp(DEP_ID));
    const rows = h.rows(REVERSED);
    assert.equal(rows.length, 1, "exactly one reversal row");
    assert.equal(rows[0]!.pr_number, PR_NUMBER);
    assert.equal(rows[0]!.task_id, TASK_ID);
    assert.deepEqual(rows[0]!.dependencies, [DEP_ID]);
    assert.equal(rows[0]!.head_ref, HEAD_REF);
    // The entry is spent: a later pass neither reopens again nor writes another row.
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(gh.reopened.length, 1);
    assert.equal(h.rows(REVERSED).length, 1);
    assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 0);
  } finally {
    h.cleanup();
  }
});

test("W1-T12891 criterion 1: a light pass and a dry run never reverse a kept close", async () => {
  const gh = reversalPort();
  const h = await closedForUnmetDependency(gh);
  try {
    h.merged(DEP_ID);
    await runSweep([], { ...h.deps, repairAdmissionSurface: "light" }, DEFAULT_SWEEP_POLICY);
    await runSweep([], { ...h.deps, dryRun: true }, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(gh.reopened, []);
    assert.equal(gh.reads, 0);
    assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 1, "the close stays kept for the next full pass");
  } finally {
    h.cleanup();
  }
});

test("W1-T12891 criterion 2: invariant:only-a-resequence-close-is-reversed — a close for any other reason is never kept or reopened", async () => {
  const others: Array<[string, OpenPrView]> = [
    ["its task already merged", resequencedPr({ taskMergedBy: 18534 })],
    ["a retirement", resequencedPr({ planResequenceIneligible: "retired in the current plan (superseded)",
      planResequenceUnmetDependencies: undefined })],
    ["a blocked task", resequencedPr({ planResequenceIneligible: "blocked in the current plan",
      planResequenceUnmetDependencies: undefined })],
  ];
  for (const [why, pr] of others) {
    const gh = reversalPort();
    const h = harness(gh);
    try {
      assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, CLOSED_AT_MS).disposition, "stale", `${why}: precondition, it is closed`);
      await runSweep([pr], h.deps, DEFAULT_SWEEP_POLICY);
      assert.equal(h.closed.length, 1, `${why}: precondition, pass one closed it`);
      assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 0, `${why}: the close is not kept`);
      h.at(LATER_MS);
      h.merged(DEP_ID);
      await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
      assert.deepEqual(gh.reopened, [], `${why}: never reopened`);
      assert.equal(h.rows(REVERSED).length + h.rows(REVERSE_FAILED).length, 0, `${why}: nothing written`);
    } finally {
      h.cleanup();
    }
  }
});

test("W1-T12891 criterion 2: a close with no marker beside the ledger, or a person's close, is never reopened", async () => {
  // The sweep keeps only a close whose reason carries the marker and names its unmet dependencies.
  const pr = resequencedPr();
  assert.match(String(keptResequenceCloseFor(pr, "task W1-T12214 already merged by #18534", CLOSED_AT_MS)), /not a plan-resequence close/);
  assert.match(String(keptResequenceCloseFor({ ...pr, planResequenceUnmetDependencies: undefined },
    PLAN_RESEQUENCE_CLOSE_MARKER, CLOSED_AT_MS)), /names no unmet dependency/);
  assert.match(String(keptResequenceCloseFor({ ...pr, headRefName: undefined }, PLAN_RESEQUENCE_CLOSE_MARKER, CLOSED_AT_MS)), /no head branch/);
  assert.equal(typeof keptResequenceCloseFor(pr, PLAN_RESEQUENCE_CLOSE_MARKER, CLOSED_AT_MS), "object");
  const gh = reversalPort();
  const h = harness(gh);
  try {
    // A kept file can only come from the resequence close; a hand-written one for a PR the sweep never closed
    // finds no sweep close event on the PR (the person's close is the only one, long before), so it is dropped.
    keepResequenceClose(h.ledgerPath, { prNumber: PR_NUMBER, prUrl: PR_URL, taskId: TASK_ID, dependencies: [DEP_ID],
      headRef: HEAD_REF, closedAt: new Date(CLOSED_AT_MS).toISOString() });
    gh.events = [];
    h.at(LATER_MS);
    h.merged(DEP_ID);
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(gh.reopened, []);
    assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 0, "dropped without acting");
    assert.equal(h.rows(REVERSED).length + h.rows(REVERSE_FAILED).length, 0);
  } finally {
    h.cleanup();
  }
});

test("W1-T12891 criterion 2: a close the sweep made that a person later re-closed is left closed", async () => {
  const gh = reversalPort();
  const h = await closedForUnmetDependency(gh);
  try {
    // A person reopened the PR and closed it again after the sweep's close.
    gh.events.push({ event: "reopened", at: "2026-11-15T00:10:00Z" }, { event: "closed", at: "2026-11-15T00:30:00Z" });
    h.merged(DEP_ID);
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(gh.reopened, [], "the person's close stands");
    assert.equal(h.rows(REVERSED).length + h.rows(REVERSE_FAILED).length, 0);
    assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 0, "the entry is dropped");
    // An already reopened PR is dropped too: there is nothing left to reverse.
    const reopenedByHand = reversalPort({ state: "open" });
    const h2 = await closedForUnmetDependency(reopenedByHand);
    try {
      h2.merged(DEP_ID);
      await runSweep([], h2.deps, DEFAULT_SWEEP_POLICY);
      assert.deepEqual(reopenedByHand.reopened, []);
      assert.equal(readKeptResequenceCloses(h2.ledgerPath).kept.length, 0);
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test("W1-T12891 criterion 2: a task that merged by another PR is not revived", async () => {
  const gh = reversalPort();
  const h = await closedForUnmetDependency(gh);
  try {
    h.merged(DEP_ID);
    h.merged(TASK_ID);
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(gh.reopened, []);
    assert.equal(gh.reads, 0, "no GitHub read for a task already merged");
    assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 0);
  } finally {
    h.cleanup();
  }
});

test("W1-T12891 criterion 3: while a dependency is unmerged, unreadable or indeterminate the PR stays closed and nothing is written", async () => {
  const reads: Array<[string, SweepDeps["readTaskMergeStates"]]> = [
    ["unmerged", async (ids) => new Map(ids.map((id) => [id, "unmerged" as ResequenceDependencyState]))],
    ["indeterminate", async (ids) => new Map(ids.map((id) => [id, (id === DEP_ID ? "indeterminate" : "unmerged") as ResequenceDependencyState]))],
    ["unreadable", async () => { throw new Error("ledger union refused: incomplete"); }],
    ["absent from the read", async () => new Map()],
  ];
  for (const [why, readTaskMergeStates] of reads) {
    const gh = reversalPort();
    const h = await closedForUnmetDependency(gh, { readTaskMergeStates });
    try {
      const before = readLedgerLines(h.ledgerPath).length;
      await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
      assert.deepEqual(gh.reopened, [], `${why}: stays closed`);
      assert.equal(gh.reads, 0, `${why}: GitHub is not even read`);
      const written = readLedgerLines(h.ledgerPath).slice(before)
        .filter((row) => String(row.step).startsWith("sweep.resequence_close"));
      assert.deepEqual(written, [], `${why}: nothing is written`);
      assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 1, `${why}: still kept for a later pass`);
    } finally {
      h.cleanup();
    }
  }
  // An unreadable lifecycle or head read is also no attempt: kept, nothing written.
  for (const port of [
    { lifecycleError: new Error("HTTP 502") },
  ]) {
    const gh = reversalPort(port);
    const h = await closedForUnmetDependency(gh);
    try {
      h.merged(DEP_ID);
      await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
      assert.deepEqual(gh.reopened, []);
      assert.equal(h.rows(REVERSED).length + h.rows(REVERSE_FAILED).length, 0);
      assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 1);
    } finally {
      h.cleanup();
    }
  }
});

test("W1-T12891 criterion 4: a refused reopen writes one sweep.resequence_close_reverse_failed row with its cause and is not retried", async () => {
  const gh = reversalPort({ reopenError: new Error("GraphQL: Could not reopen the pull request") });
  const h = await closedForUnmetDependency(gh);
  try {
    h.merged(DEP_ID);
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    const failed = h.rows(REVERSE_FAILED);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.pr_number, PR_NUMBER);
    assert.match(String(failed[0]!.cause), /reopen refused: .*Could not reopen/);
    assert.equal(h.rows(REVERSED).length, 0);
    gh.reopenError = undefined;
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(gh.reopened, [], "not retried on a later pass");
    assert.equal(h.rows(REVERSE_FAILED).length, 1, "and no second row");
  } finally {
    h.cleanup();
  }
});

test("W1-T12891 criterion 4: a head branch that is gone writes one sweep.resequence_close_reverse_failed row and is not retried", async () => {
  const gh = reversalPort({ head: false });
  const h = await closedForUnmetDependency(gh);
  try {
    h.merged(DEP_ID);
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    const failed = h.rows(REVERSE_FAILED);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.cause, "head branch gone");
    assert.deepEqual(gh.reopened, []);
    assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 0, "the entry is spent");
  } finally {
    h.cleanup();
  }
});

test("W1-T12891 criterion 4: the production port reads GitHub fresh and reopens with gh pr reopen", async () => {
  const calls: string[][] = [];
  const refs = [{ ref: `refs/heads/${HEAD_REF}-other` }];
  const port = createResequenceCloseReversalPort({
    readJson: async (args) => {
      calls.push(args);
      const path = args[1] ?? "";
      if (path.endsWith(`/pulls/${PR_NUMBER}`)) return { state: "closed", merged: false };
      if (path.includes("/events")) return [{ event: "labeled", created_at: "x" }, { event: "closed", created_at: "2026-11-14T23:03:00Z" }];
      if (path.includes("/matching-refs/")) return refs;
      throw new Error(`unexpected read ${path}`);
    },
    ghRun: (file, args) => { calls.push([file, ...args]); },
  });
  const kept: KeptResequenceClose = { prNumber: PR_NUMBER, prUrl: PR_URL, taskId: TASK_ID, dependencies: [DEP_ID],
    headRef: HEAD_REF, closedAt: "2026-11-14T23:03:00.000Z" };
  assert.deepEqual(await port.readLifecycle(kept), { state: "closed", events: [{ event: "closed", at: "2026-11-14T23:03:00Z" }] });
  assert.equal(await port.headExists(kept), false, "a prefix match is not the head");
  refs.push({ ref: `refs/heads/${HEAD_REF}` });
  assert.equal(await port.headExists(kept), true);
  await port.reopen(kept, "why");
  assert.deepEqual(calls.at(-1), ["gh", "pr", "reopen", PR_URL, "--comment", "why"]);
  assert.ok(calls.slice(0, 2).every((c) => c[1]?.startsWith("repos/craigoley/remudero/")));
  // Shapes it cannot read throw, which the sweep holds as unreadable.
  assert.throws(() => resequenceCloseLifecycleFrom({ state: "weird" }, []), /state was unreadable/);
  assert.throws(() => resequenceCloseLifecycleFrom({ state: "closed" }, { message: "Not Found" }), /not a list/);
  assert.equal(resequenceCloseLifecycleFrom({ state: "closed", merged: true }, []).state, "merged");
  assert.equal(resequenceCloseLifecycleFrom({ state: "closed" }, Array.from({ length: 100 }, () => ({}))).truncated, true);
  await assert.rejects(() => createResequenceCloseReversalPort({ readJson: async () => ({}), ghRun: () => {} }).headExists(kept), /not a list/);
});

test("W1-T12891 criterion 2: the close comment that a kept close is matched on carries the resequence marker", () => {
  const reason = deriveDisposition(resequencedPr(), DEFAULT_SWEEP_POLICY, CLOSED_AT_MS).reason;
  assert.ok(reason.includes(PLAN_RESEQUENCE_CLOSE_MARKER));
});

test("W1-T12891 criterion 3: a task whose own merge state is indeterminate, or a head read that fails, holds the close and writes nothing", async () => {
  const taskIndeterminate: SweepDeps["readTaskMergeStates"] = async (ids) =>
    new Map(ids.map((id) => [id, (id === DEP_ID ? "merged" : "indeterminate") as ResequenceDependencyState]));
  for (const [why, gh, over] of [
    ["task indeterminate", reversalPort(), { readTaskMergeStates: taskIndeterminate }],
    ["head read failed", reversalPort({ headError: new Error("HTTP 502") }), {}],
  ] as const) {
    const h = await closedForUnmetDependency(gh, over);
    try {
      h.merged(DEP_ID);
      await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
      assert.equal(gh.reopened.length, 0, `${why}: stays closed`);
      assert.equal(h.rows(REVERSED).length + h.rows(REVERSE_FAILED).length, 0, `${why}: nothing written`);
      assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 1, `${why}: still kept`);
    } finally {
      h.cleanup();
    }
  }
});

test("W1-T12891 criterion 2: a lifecycle whose events exceed one page cannot rule out a later close, so it is never reopened", async () => {
  const gh = reversalPort({ truncated: true });
  const h = await closedForUnmetDependency(gh);
  try {
    h.merged(DEP_ID);
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(gh.reopened.length, 0);
    assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 0, "dropped without acting");
    assert.equal(h.rows(REVERSED).length + h.rows(REVERSE_FAILED).length, 0);
  } finally {
    h.cleanup();
  }
});

test("W1-T12891 criterion 4: a kept close the sweep cannot remove is not attempted, so no later pass repeats an attempt", async () => {
  // The claim's removal fails for every uid when the file is already gone: the double removes it mid-read, as a
  // concurrent sweep that claimed first would. (A permission denial would not hold under uid 0.)
  for (const personClosedAfter of [false, true]) {
    const gh = reversalPort();
    const h = await closedForUnmetDependency(gh);
    const logged: string[] = [];
    h.deps.log = (step) => { logged.push(step); };
    try {
      h.merged(DEP_ID);
      if (personClosedAfter) {
        // A drop that cannot remove its file holds the close too, rather than acting on it.
        gh.events.push({ event: "reopened", at: "2026-11-15T00:10:00Z" }, { event: "closed", at: "2026-11-15T00:30:00Z" });
      }
      const keptPath = readKeptResequenceCloses(h.ledgerPath).kept[0]!.path;
      const readLifecycle = gh.port.readLifecycle;
      gh.port.readLifecycle = async (kept) => {
        const lifecycle = await readLifecycle(kept);
        rmSync(keptPath);
        return lifecycle;
      };
      await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
      assert.equal(gh.reopened.length, 0, "no attempt without the claim");
      assert.ok(logged.includes("sweep.resequence_close.unclaimed"));
      assert.equal(h.rows(REVERSED).length + h.rows(REVERSE_FAILED).length, 0);
    } finally {
      h.cleanup();
    }
  }
});

test("W1-T12891 criterion 4: unreadable or unwritable bookkeeping is recorded and never stops the pass or reopens anything", async () => {
  const gh = reversalPort();
  const h = harness(gh);
  const logged: Array<{ step: string; reason: string }> = [];
  h.deps.log = (step, extra) => { logged.push({ step, reason: String(extra?.reason ?? "") }); };
  try {
    // A close that names no head is not kept, and says why.
    await runSweep([resequencedPr({ headRefName: undefined })], h.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(h.closed.length, 1, "precondition: it was closed");
    assert.match(logged.find((l) => l.step === "sweep.resequence_close.not_kept")?.reason ?? "", /no head branch/);
    assert.match(String(keptResequenceCloseFor(resequencedPr({ prUrl: "https://example.com/pr/1" }), PLAN_RESEQUENCE_CLOSE_MARKER, CLOSED_AT_MS)),
      /names no repository/);
    // Files beside the ledger that are not a kept close are named and skipped.
    const repoDir = join(h.dir, "resequence-closes", "craigoley", "remudero");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "PR1.json"), "{torn");
    writeFileSync(join(repoDir, "PR2.json"), JSON.stringify({ prNumber: 3, prUrl: PR_URL.replace(/\d+$/, "3"), taskId: TASK_ID,
      dependencies: [DEP_ID], headRef: HEAD_REF, closedAt: new Date(CLOSED_AT_MS).toISOString() }));
    writeFileSync(join(repoDir, "PR4.json"), JSON.stringify({ prNumber: 4 }));
    writeFileSync(join(repoDir, "notes.txt"), "not a kept close");
    h.merged(DEP_ID);
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(logged.filter((l) => l.step === "sweep.resequence_close.unreadable").length, 3);
    assert.equal(gh.reads, 0);
    assert.equal(gh.reopened.length, 0);
    // A kept-close path that is not a directory: the close cannot be kept, and the read names it.
    rmSync(join(h.dir, "resequence-closes"), { recursive: true });
    writeFileSync(join(h.dir, "resequence-closes"), "");
    logged.length = 0;
    await runSweep([resequencedPr({ prNumber: 18601, prUrl: PR_URL.replace(/\d+$/, "18601") })], h.deps, DEFAULT_SWEEP_POLICY);
    assert.match(logged.find((l) => l.step === "sweep.resequence_close.not_kept")?.reason ?? "", /could not be written/);
    assert.match(logged.find((l) => l.step === "sweep.resequence_close.unreadable")?.reason ?? "", /resequence-closes/);
  } finally {
    h.cleanup();
  }
});

test("W1-T12891 criterion 4: a reversal step that throws is recorded and the pass still disposes its open PRs", async () => {
  const gh = reversalPort();
  const h = await closedForUnmetDependency(gh);
  const logged: string[] = [];
  h.deps.log = (step) => { logged.push(step); };
  h.deps.appendLine = (path, line) => {
    if (String(line.step).startsWith("sweep.resequence_close")) throw new Error("disk full");
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  };
  try {
    h.merged(DEP_ID);
    await runSweep([resequencedPr({ prNumber: 18600, prUrl: PR_URL.replace(/\d+$/, "18600") })], h.deps, DEFAULT_SWEEP_POLICY);
    assert.ok(logged.includes("sweep.resequence_close.reversal_failed"));
    assert.ok(h.rows("sweep.disposed").some((row) => row.pr_number === 18600), "the pass went on to dispose its open PR");
    assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.some((k) => k.prNumber === PR_NUMBER), false, "the close was claimed: no second attempt");
  } finally {
    h.cleanup();
  }
});

const DROPPED = "sweep.resequence_close_dropped";
const NEWER_PR = 18690;
const NEWER_HEAD = "run-W1-T12214-1794800000000";

test("W1-T15185 criterion 1: a kept close whose task has a newer open PR on another head is dropped, not reopened, and one sweep.resequence_close_dropped row names that PR", async () => {
  // Closed for an unmet dependency; the task then has a newer open pull request on another head branch.
  const gh = reversalPort({ open: [{ number: 18700, headRef: "run-W1-T99999-1794800000000" }, { number: NEWER_PR, headRef: NEWER_HEAD }] });
  const h = await closedForUnmetDependency(gh);
  try {
    h.merged(DEP_ID);
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(gh.reopened, [], "the closed PR is not reopened beside the newer one");
    const dropped = h.rows(DROPPED);
    assert.equal(dropped.length, 1, "exactly one drop row");
    assert.equal(dropped[0]!.pr_number, PR_NUMBER);
    assert.equal(dropped[0]!.task_id, TASK_ID);
    assert.equal(dropped[0]!.open_pr_number, NEWER_PR);
    assert.equal(dropped[0]!.open_head_ref, NEWER_HEAD);
    assert.equal(h.rows(REVERSED).length + h.rows(REVERSE_FAILED).length, 0);
    assert.equal(readKeptResequenceCloses(h.ledgerPath).kept.length, 0, "the kept close is removed");
    // No later pass retries it, even once the newer PR is gone.
    gh.open = [];
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(gh.reopened, []);
    assert.equal(h.rows(DROPPED).length, 1, "and no second row");
  } finally {
    h.cleanup();
  }
});

test("W1-T15185 criterion 2: invariant:sole-pr-still-reopens — with no other open PR for the task the close is reopened, and an unreadable open-PR list holds it", async () => {
  // Open PRs that are not the task's, or are the closed PR's own number or head, do not stop the reopen.
  const sole = reversalPort({ open: [{ number: 18700, headRef: "run-W1-T99999-1794800000000" },
    { number: PR_NUMBER, headRef: HEAD_REF }, { number: 18701, headRef: HEAD_REF }, { number: 18702, headRef: "hand/W1-T12214" }] });
  const h = await closedForUnmetDependency(sole);
  try {
    h.merged(DEP_ID);
    await runSweep([], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(sole.reopened.map((r) => r.prUrl), [PR_URL], "reopened exactly as before");
    assert.equal(h.rows(REVERSED).length, 1);
    assert.equal(h.rows(DROPPED).length, 0);
  } finally {
    h.cleanup();
  }
  const unreadable = reversalPort({ openError: new Error("the open pull request list is incomplete") });
  const h2 = await closedForUnmetDependency(unreadable);
  try {
    h2.merged(DEP_ID);
    await runSweep([], h2.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(unreadable.reopened, [], "no reopen on an unreadable list");
    assert.equal(h2.rows(REVERSED).length + h2.rows(REVERSE_FAILED).length + h2.rows(DROPPED).length, 0, "nothing written");
    assert.equal(readKeptResequenceCloses(h2.ledgerPath).kept.length, 1, "held for a later pass, not dropped");
    unreadable.openError = undefined;
    await runSweep([], h2.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(unreadable.reopened.length, 1, "a later pass with a readable list reopens it");
  } finally {
    h2.cleanup();
  }
});

test("W1-T15185 criterion 2: the production port reads every open PR fresh and refuses an unreadable list", async () => {
  const kept: KeptResequenceClose = { prNumber: PR_NUMBER, prUrl: PR_URL, taskId: TASK_ID, dependencies: [DEP_ID],
    headRef: HEAD_REF, closedAt: new Date(CLOSED_AT_MS).toISOString() };
  const calls: Array<{ args: string[]; fresh: boolean }> = [];
  let pages: unknown[] = [[{ number: NEWER_PR, html_url: PR_URL.replace(/\d+$/, String(NEWER_PR)), state: "open",
    head: { ref: NEWER_HEAD, sha: "d".repeat(40) }, body: "", title: "t", updated_at: "2026-11-15T00:00:00Z" }]];
  const port = createResequenceCloseReversalPort({
    readJson: async (args, opts) => {
      calls.push({ args, fresh: opts?.fresh === true });
      return pages.shift() ?? [];
    },
    ghRun: () => {},
  });
  assert.deepEqual(await port.openPullRequests(kept), [{ number: NEWER_PR, headRef: NEWER_HEAD }]);
  assert.ok(calls.length >= 1 && calls.every((c) => c.fresh && c.args[1]!.startsWith("repos/craigoley/remudero/pulls?state=open")));
  pages = [[{ number: 5, html_url: PR_URL, state: "open", head: {}, body: "", title: "t", updated_at: "x" }]];
  await assert.rejects(() => port.openPullRequests(kept), /unreadable head ref/);
  pages = [{ message: "Bad credentials" }];
  await assert.rejects(() => port.openPullRequests(kept));
});

test("W1-T12891 criterion 4: the production port refuses a pull request url that names no repository", async () => {
  const port = createResequenceCloseReversalPort({ readJson: async () => [], ghRun: () => {} });
  const kept: KeptResequenceClose = { prNumber: 1, prUrl: "https://example.com/pr/1", taskId: TASK_ID, dependencies: [DEP_ID],
    headRef: HEAD_REF, closedAt: new Date(CLOSED_AT_MS).toISOString() };
  await assert.rejects(() => port.readLifecycle(kept), /names no repository/);
});
