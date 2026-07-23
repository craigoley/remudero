/**
 * W1-T130 acceptance: A CORRECTION IS SUPREME OFFLINE — ledger-local credit is
 * authoritative with NO GitHub read, so no throttle or error can demote settled
 * work into a spend event.
 *
 * LIVE INCIDENT, 2026-07-19: under GitHub quota exhaustion, `derivePrPrecedence`'s
 * correction rung re-resolved the correction's own `actual_pr_url` via `prByRef`
 * on EVERY derivation. A throttled/errored read there fell through to `queued`,
 * so the daemon re-dispatched a task already SATISFIED by a merged PR — sixty
 * distinct run ids, 76 spends, $206.15 notional, self-reinforcing (each
 * re-dispatch burned more quota, deepening the exhaustion that caused it).
 *
 * These tests prove the fix structurally, not just behaviorally: an injected
 * gateway that THROWS if invoked at all still lets a corrected task derive
 * merged and non-dispatchable — the read is off the path, not merely tolerant.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { nextRunnable } from "../src/lib/drain.js";
import { deriveStatus, type GitHub } from "../src/lib/status.js";

/** A minimal task; fields not under test get sensible defaults. */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T1",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(t: Task): Plan {
  return { tasks: [t], byId: new Map([[t.id, t]]) };
}

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "correction-supremacy-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

/** A gateway that THROWS on every method — proves a correction-credited task
 *  never even reaches the gateway, rather than merely surviving a failure it
 *  DID reach. Any test that hits this and does NOT throw has proven the read
 *  is genuinely off the path. */
function throwingGithub(): GitHub {
  const boom = (name: string): never => {
    throw new Error(`gateway must never be consulted for a correction-credited task (called ${name})`);
  };
  return {
    prByRef: () => boom("prByRef"),
    findMergedByTrailer: () => boom("findMergedByTrailer"),
    headRefName: () => boom("headRefName"),
    prBody: () => boom("prBody"),
    readFailed: () => boom("readFailed"),
    readFailureReason: () => boom("readFailureReason"),
    issueByUrl: () => boom("issueByUrl"),
    issueReadFailed: () => boom("issueReadFailed"),
    autoMergeArmed: () => boom("autoMergeArmed"),
  };
}

/** A gateway that answers every call WITHOUT error, but every answer
 *  CONTRADICTS the correction (closed/absent target, no trailer match) — the
 *  "healthy-but-contradicting" read the acceptance criteria name explicitly.
 *  Records every call so a test can assert it was never made. */
function contradictingGithub(): GitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prByRef(ref) {
      calls.push(`prByRef:${ref}`);
      return null; // "cannot resolve" — would demote under the pre-W1-T130 behavior
    },
    findMergedByTrailer(taskId) {
      calls.push(`trailer:${taskId}`);
      return null;
    },
    headRefName(url) {
      calls.push(`headRefName:${url}`);
      return undefined;
    },
    prBody(url) {
      calls.push(`prBody:${url}`);
      return undefined;
    },
    readFailed() {
      calls.push("readFailed");
      return false; // a HEALTHY read — the failure mode is contradiction, not throttling
    },
  };
}

/** A gateway that reports every read as FAILED (rate-limited) but never throws —
 *  the "throttled" shape W1-T119 introduced (`readFailed(): true`). */
function throttledGithub(): GitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prByRef(ref) {
      calls.push(`prByRef:${ref}`);
      return null;
    },
    findMergedByTrailer(taskId) {
      calls.push(`trailer:${taskId}`);
      return null;
    },
    headRefName() {
      return undefined;
    },
    prBody() {
      return undefined;
    },
    readFailed() {
      calls.push("readFailed");
      return true;
    },
    readFailureReason() {
      return "rate_limit";
    },
  };
}

const CORRECTED_LEDGER = (taskId: string, actualPrUrl: string) =>
  ledgerFile([
    { step: "pr.opened", task_id: taskId, pr_url: "https://github.com/o/r/pull/2" },
    { step: "correction.provenance", task_id: taskId, claimed_pr_url: "https://github.com/o/r/pull/2", actual_pr_url: actualPrUrl },
  ]);

test("acceptance 1: a correction-credited task is honoured with ZERO gateway calls — a gateway that throws if invoked at all still derives merged", () => {
  const t = task();
  const ledgerPath = CORRECTED_LEDGER(t.id, "https://github.com/o/r/pull/2");
  const proj = deriveStatus(t, { ledgerPath, github: throwingGithub() });
  assert.equal(proj.source, "correction");
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, 2);
});

test("prNumber decoration degrades to undefined (never the merged verdict) when the correction's own URL text has no trailing digits", () => {
  const t = task();
  // A shorthand ref with no trailing digit at all — `prNumberFromRef` must return
  // `undefined` rather than a bogus number; this must NEVER affect `merged`, which
  // is unconditional and decided before `prNumberFromRef` is ever called.
  const ledgerPath = CORRECTED_LEDGER(t.id, "https://github.com/o/r/settled-elsewhere");
  const proj = deriveStatus(t, { ledgerPath, github: throwingGithub() });
  assert.equal(proj.source, "correction");
  assert.equal(proj.merged, true);
  assert.equal(proj.prNumber, undefined);
});

test("acceptance 2a: a correction-credited task stays non-dispatchable under a THROTTLED read", () => {
  const t = task();
  const ledgerPath = CORRECTED_LEDGER(t.id, "https://github.com/o/r/pull/2");
  const github = throttledGithub();
  const proj = deriveStatus(t, { ledgerPath, github });
  assert.equal(proj.merged, true);
  assert.deepEqual(github.calls, [], "throttling must never even be OBSERVED for a corrected task");

  const plan = planOf(t);
  const isMerged = (id: string) => deriveStatus(plan.byId.get(id)!, { ledgerPath, github }).merged;
  assert.equal(nextRunnable(plan, isMerged), undefined, "the only task in the plan is credited — nothing to dispatch");
});

test("acceptance 2b: a correction-credited task stays non-dispatchable under an ERRORED read", () => {
  const t = task();
  const ledgerPath = CORRECTED_LEDGER(t.id, "https://github.com/o/r/pull/2");
  const github = throwingGithub();
  const plan = planOf(t);
  const isMerged = (id: string) => deriveStatus(plan.byId.get(id)!, { ledgerPath, github }).merged;
  assert.equal(nextRunnable(plan, isMerged), undefined, "an erroring gateway never even gets the chance to throw");
});

test("acceptance 2c: a correction-credited task stays non-dispatchable under a HEALTHY-BUT-CONTRADICTING read", () => {
  const t = task();
  const ledgerPath = CORRECTED_LEDGER(t.id, "https://github.com/o/r/pull/2");
  const github = contradictingGithub();
  const proj = deriveStatus(t, { ledgerPath, github });
  assert.equal(proj.merged, true);
  assert.deepEqual(github.calls, [], "a healthy gateway that WOULD contradict the correction is never even asked");

  const plan = planOf(t);
  const isMerged = (id: string) => deriveStatus(plan.byId.get(id)!, { ledgerPath, github }).merged;
  assert.equal(nextRunnable(plan, isMerged), undefined);
});

test("acceptance 3: an indeterminate derivation with NO applicable correction DEFERS rather than dispatching — cannot-observe means wait, never spend", () => {
  const t = task();
  const ledgerPath = ledgerFile([{ step: "run.start", task_id: t.id }]);
  const github = throttledGithub();
  const proj = deriveStatus(t, { ledgerPath, github });
  assert.equal(proj.indeterminate, true);
  assert.equal(proj.merged, false); // indeterminate is NOT the same as merged

  const plan = planOf(t);
  let deferred: string | undefined;
  const isMerged = (id: string) => deriveStatus(plan.byId.get(id)!, { ledgerPath, github }).merged;
  const isIndeterminate = (id: string) => deriveStatus(plan.byId.get(id)!, { ledgerPath, github }).indeterminate === true;
  const picked = nextRunnable(plan, isMerged, {
    isIndeterminate,
    onIndeterminate: (task) => {
      deferred = task.id;
    },
  });
  assert.equal(picked, undefined, "an indeterminate read must never be dispatched");
  assert.equal(deferred, t.id, "the deferral is legible, not a silent skip");
});

test("acceptance 4: replaying the W1-T1 incident fixture under an exhausted-quota gateway across many poll cycles yields ZERO dispatches and ZERO gateway calls throughout", () => {
  // The fixture: W1-T1, already SATISFIED by a merged PR (#2), credited via a
  // correction — exactly the recorded incident shape (rationale: "60 distinct
  // W1-T1 run ids across 363 poll cycles ... every one of them re-dispatching a
  // task SATISFIED BY PR #2, MERGED 2026-07-14").
  const t = task({ id: "W1-T1" });
  const ledgerPath = CORRECTED_LEDGER(t.id, "https://github.com/o/r/pull/2");
  const plan = planOf(t);
  // A gateway that throws on every call, standing in for the exhausted-quota
  // GraphQL rate-limit errors the incident logs recorded on every single cycle.
  const github = throwingGithub();
  const isMerged = (id: string) => deriveStatus(plan.byId.get(id)!, { ledgerPath, github }).merged;

  let dispatches = 0;
  // Replay well past the incident's 60 recorded run ids / 363 poll cycles.
  for (let cycle = 0; cycle < 400; cycle++) {
    const picked = nextRunnable(plan, isMerged);
    if (picked) dispatches++;
  }
  assert.equal(dispatches, 0, "zero dispatches across 400 simulated poll cycles under exhausted quota");
});
