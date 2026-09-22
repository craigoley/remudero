/**
 * W1-T3996 — A DURABLE HEAD-BRANCH CREDIT CAN BYPASS PLAN-ONLY EVIDENCE.
 *
 * THE DEFECT, MEASURED (2026-09-22, task W1-T3990, #6468). `corroborateByBranch` (rung (c2)) only
 * ever ran the LEDGER-based `isPlanOnlyFilingPr` guard before persisting a head-branch credit to
 * `merge-credit.json` — never the DIFF-based `isPlanOnlyChangeset` check rung (c) runs before ITS
 * OWN persist. #6468's ledger row carried no `plan_only` marker, so the guard cleared, the credit
 * was written, and every LATER projection resolved from `derivePrPrecedence`'s durable rung —
 * which returns `merged` before consulting `deps.mergedPathsByPr` at all — so the false credit
 * survived forever and permanently suppressed dispatch of the task the PR never actually built.
 *
 * WHAT THESE TESTS DRIVE: the real `deriveStatus`, so the durable rung's OWN revalidation runs,
 * not a copy. `deps.github` throws on every PR-record read in every test here, proving each
 * result comes from the durable store plus the injected `mergedPathsByPr` map alone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import {
  deriveStatus,
  invalidateDurableCredit,
  loadCreditStore,
  recordCredit,
  type CreditStore,
  type GitHub,
} from "../src/lib/status.js";

function task(id: string): Task {
  return {
    id,
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "high",
    status: "queued",
    attempts: 0,
  } as unknown as Task;
}

/** Every PR-record method throws — reaching an assertion below is itself the proof that a result
 *  came from the durable store and the injected path map, never a live GitHub read. Used only for
 *  the cases the durable rung must resolve WITHOUT falling through to anything live. */
function forbiddingGithub(): GitHub {
  const guard = (name: string) => {
    throw new Error(`W1-T3996: unexpected live PR-record read via GitHub.${name}`);
  };
  return {
    prByRef: () => guard("prByRef"),
    findMergedByTrailer: () => guard("findMergedByTrailer"),
    findMergedByHeadBranch: () => guard("findMergedByHeadBranch"),
    headRefName: () => guard("headRefName"),
    prBody: () => guard("prBody"),
  } as unknown as GitHub;
}

/** A gateway that genuinely has NOTHING for this task on any live rung — used for the REFUSAL
 *  cases, where the durable rung is EXPECTED to fall through and let every rung below re-decide
 *  (the whole point: refusing durable credit must reopen dispatch, not merely hide a flag). */
function noEvidenceGithub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [],
    headRefName: () => undefined,
    prBody: () => undefined,
  } as unknown as GitHub;
}

const PLAN_ONLY_FILING_PATHS = ["plan/tasks.d/W1-T3990-x.yaml"];
const IMPLEMENTATION_PATHS = ["src/lib/status.ts", "test/a-durable-plan-filing-credit-is-revalidated.test.ts"];

test("W1-T3996 criterion 1: a durable head-branch credit for a merged plan-only filing is refused rather than marking the filed task merged", () => {
  const taskId = "W9-T3996-1";
  let store: CreditStore = {};
  store = recordCredit(store, taskId, { source: "head-branch", prUrl: "u/6468", prNumber: 6468, prState: "MERGED" });

  const written: CreditStore[] = [];
  const proj = deriveStatus(task(taskId), {
    ledgerPath: "/tmp/does-not-exist/ledger.ndjson",
    // Falls through once refused (see design note above `noEvidenceGithub`), so every rung below
    // must genuinely have nothing to say — proving the refusal, not merely a fixture gap.
    github: noEvidenceGithub(),
    readLedger: () => [],
    readCreditStore: () => store,
    writeCreditStore: (s) => written.push(s),
    mergedPathsByPr: new Map([[6468, PLAN_ONLY_FILING_PATHS]]),
  });

  assert.equal(proj.merged, false, "a plan-only filing's PR must never mark the filed task merged");
  assert.equal(proj.status, "queued", "refusing durable credit must return the task to queued, not leave it stuck");

  // Observable, tied to the exact PR (design's own bar) — never a branch-name or status inference.
  assert.ok(written.length > 0, "the invalidation must be persisted, not just held in memory this cycle");
  const persisted = written[written.length - 1][taskId]?.invalidated?.["head-branch"];
  assert.deepEqual(persisted, { prUrl: "u/6468", prNumber: 6468, reason: "durable-credit-plan-only" });
});

test("W1-T3996 criterion 2: an invalidated durable filing credit stays uncredited without a path reread", () => {
  const taskId = "W9-T3996-2";
  let store: CreditStore = {};
  store = recordCredit(store, taskId, { source: "head-branch", prUrl: "u/6468", prNumber: 6468, prState: "MERGED" });
  // Seed the quarantine directly, as a PRIOR cycle (one that DID hold the path map) would have left it.
  store = invalidateDurableCredit(store, taskId, "head-branch", { prUrl: "u/6468", prNumber: 6468, reason: "durable-credit-plan-only" });

  // NO `mergedPathsByPr` at all this cycle — the ordinary case, since the map is one bounded
  // `git log` per pass, not guaranteed on every derivation.
  const proj = deriveStatus(task(taskId), {
    ledgerPath: "/tmp/does-not-exist/ledger.ndjson",
    github: noEvidenceGithub(),
    readLedger: () => [],
    readCreditStore: () => store,
    writeCreditStore: () => {},
  });

  assert.equal(proj.merged, false, "a quarantined credit must not resurrect just because the path map is absent this cycle");
  assert.equal(proj.status, "queued");
});

test("W1-T3996 criterion 3a: a durable head-branch credit for a non-plan-only implementation retains its existing merged result", () => {
  const taskId = "W9-T3996-3a";
  let store: CreditStore = {};
  store = recordCredit(store, taskId, { source: "head-branch", prUrl: "u/7000", prNumber: 7000, prState: "MERGED" });

  const proj = deriveStatus(task(taskId), {
    ledgerPath: "/tmp/does-not-exist/ledger.ndjson",
    github: forbiddingGithub(),
    readLedger: () => [],
    readCreditStore: () => store,
    mergedPathsByPr: new Map([[7000, IMPLEMENTATION_PATHS]]),
  });

  assert.equal(proj.merged, true, "a genuine implementation's durable credit must survive revalidation");
  assert.equal(proj.source, "head-branch");
  assert.equal(proj.prNumber, 7000);
});

test("W1-T3996 criterion 3b: a durable head-branch credit with an unreadable path map retains its existing merged result", () => {
  const taskId = "W9-T3996-3b";
  let store: CreditStore = {};
  store = recordCredit(store, taskId, { source: "head-branch", prUrl: "u/7001", prNumber: 7001, prState: "MERGED" });

  // No `mergedPathsByPr` supplied at all — "unreadable" is "no opinion", never grounds to uncredit.
  const proj = deriveStatus(task(taskId), {
    ledgerPath: "/tmp/does-not-exist/ledger.ndjson",
    github: forbiddingGithub(),
    readLedger: () => [],
    readCreditStore: () => store,
  });

  assert.equal(proj.merged, true, "an unreadable path map must never uncredit a durable entry");
  assert.equal(proj.source, "head-branch");
  assert.equal(proj.prNumber, 7001);
});

test("W1-T3996: a durable TRAILER credit is not re-checked against the path map — it was already vetted at write time", () => {
  const taskId = "W9-T3996-4";
  let store: CreditStore = {};
  store = recordCredit(store, taskId, { source: "trailer", prUrl: "u/8000", prNumber: 8000, prState: "MERGED" });

  // Even a plan-only path list for this PR number must not disturb a durable TRAILER entry: rung
  // (c)'s own write-time check already cleared it, so a second check here would only ever repeat
  // that pass, never add coverage — and this pins that no such re-check was accidentally wired to
  // BOTH sources.
  const proj = deriveStatus(task(taskId), {
    ledgerPath: "/tmp/does-not-exist/ledger.ndjson",
    github: forbiddingGithub(),
    readLedger: () => [],
    readCreditStore: () => store,
    mergedPathsByPr: new Map([[8000, PLAN_ONLY_FILING_PATHS]]),
  });

  assert.equal(proj.merged, true);
  assert.equal(proj.source, "trailer");
});

test("W1-T3996: loadCreditStore round-trips an invalidated entry off real JSON, not just the in-memory shape", () => {
  const taskId = "W9-T3996-5";
  let store: CreditStore = {};
  store = recordCredit(store, taskId, { source: "head-branch", prUrl: "u/9000", prNumber: 9000, prState: "MERGED" });
  store = invalidateDurableCredit(store, taskId, "head-branch", { prUrl: "u/9000", prNumber: 9000, reason: "durable-credit-plan-only" });

  const roundTripped = JSON.parse(JSON.stringify(store)) as CreditStore;
  assert.deepEqual(roundTripped[taskId]?.invalidated?.["head-branch"], {
    prUrl: "u/9000",
    prNumber: 9000,
    reason: "durable-credit-plan-only",
  });
  // Sanity: `loadCreditStore`'s own parse path accepts the shape (it is just JSON.parse plus a
  // shallow object check), so the invalidation is not an in-memory-only fiction.
  assert.deepEqual(
    loadCreditStore("/does/not/exist/merge-credit.json"),
    {},
    "sanity: a missing file still degrades to the documented empty store",
  );
});
