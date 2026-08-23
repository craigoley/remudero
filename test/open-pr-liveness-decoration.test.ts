// test/open-pr-liveness-decoration.test.ts — W1-T1240 (plan/tasks.d/
// W1-T1240-in-flight-decoration-rides-an-open-pr-alone.yaml).
//
// THE DEFECT: `phase`/`startedAt`/`elapsedMs`/`workerState` are attached to an in-flight row
// whenever `hasOpenPr || recentActivity || hasLiveLock` — but `hasOpenPr` alone is a REMOTE
// fact (the PR is still open) standing in for a LOCAL fact (a worker process is alive) nobody
// has actually observed. A run whose process died keeps a growing elapsed clock and a stale
// `workerState` word for as long as its PR stays open — the W1-T314 `running, 10h25m, $27.75`
// shape. The fix is NOT to reorder the disjunction (rationale (1): every operand is computed
// eagerly, so reordering `||` changes no rendered output for any input — a semantic no-op) and
// NOT to change the status word (rationale (2): W1-T179 already decided an open PR is
// authoritative for "running"). It is a new, SPARSE, additive marker — `processUnevidenced` —
// set when `hasOpenPr` is the ONLY thing backing the row, carried straight through onto the
// board row exactly as W1-T944 carried `workerState`.
//
// THE FIVE ACCEPTANCE BARS (the task shard's own `acceptance:` list):
//   1. an open-PR-only in-flight row is marked `processUnevidenced` and still renders "running".
//   2. recent ledger activity, and a live lock holder, each independently discriminate the mark
//      OFF — it does not fire on every open PR.
//   3. the disjunction itself is unchanged: the SAME rows render running before/after, and no
//      open-PR row flips to `orphaned`.
//   4. an ABSENT `inflightHolder` dep reports unevidenced, never "dead" — a skipped lock read is
//      never read as a corpse.
//   5. the marker reaches the BOARD row (board.ts), not just the projection (status.ts).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveStatus, type DeriveDeps, type GitHub, type PrRef } from "../src/lib/status.js";
import { computeBoardSnapshot, isRunningRow, type BoardDeps } from "../src/lib/board.js";
import type { Plan, Task } from "../src/lib/plan.js";

const PR_URL = "https://github.com/craigoley/remudero/pull/9314";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TOPD",
    title: "open-pr decoration fixture",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued", // decorative — deriveStatus must not trust this
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/** A gateway whose ONLY resolvable PR is `PR_URL`, at whatever state the caller supplies —
 *  every other rung (trailer search, branch corroboration) returns null/undefined, so `hasOpenPr`
 *  is driven purely by the ledger's own `pr.opened` line + this one PR's state, same shape
 *  `now-card-worker-state.test.ts`'s `fakeGitHub` already uses. */
function fakeGitHub(byRef: Record<string, PrRef> = {}): GitHub {
  return {
    prByRef: (ref) => byRef[String(ref)] ?? null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function openPrGithub(): GitHub {
  return fakeGitHub({ [PR_URL]: { number: 9314, url: PR_URL, state: "OPEN" } });
}

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-open-pr-decoration-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  return p;
}

// A dispatched run whose ledger evidence is STALE — `run.start` and `pr.opened` both 3h before
// `NOW_FAR` below, well past the 30-minute liveness bound — so `recentActivity` is false and the
// open PR is the ONLY thing that can back this row.
const OLD_TS = "2026-08-17T09:00:00.000Z";
const NOW_FAR = "2026-08-17T12:00:00.000Z"; // 3h later — past DEFAULT_LIVENESS_BOUND_MS (30m)

function staleOpenPrLines(taskId: string): Array<Record<string, unknown>> {
  return [
    { ts: OLD_TS, run_id: "r1", task_id: taskId, step: "run.start" },
    { ts: OLD_TS, run_id: "r1", task_id: taskId, step: "pr.opened", pr_url: PR_URL },
  ];
}

function depsFor(taskId: string, over: Partial<DeriveDeps> = {}): DeriveDeps {
  return {
    ledgerPath: "/nonexistent/ledger.ndjson",
    github: openPrGithub(),
    readLedger: () => staleOpenPrLines(taskId),
    now: () => Date.parse(NOW_FAR),
    ...over,
  };
}

// ── ACCEPTANCE 1: open-PR-only evidence ⇒ marked, and still renders "running" ────────────────

test("W1-T1240: an in-flight row whose ONLY liveness evidence is an open PR is marked processUnevidenced and still renders running", () => {
  const p = deriveStatus(task(), depsFor("W1-TOPD"));
  assert.equal(p.status, "running", "W1-T179: an open PR is still authoritative for the status word");
  assert.ok(p.phase, "the decoration itself is not deleted (design note v)");
  assert.equal(p.processUnevidenced, true);
});

// ── ACCEPTANCE 2: recent ledger activity, and a live lock, EACH independently discriminate ───

test("W1-T1240: recent ledger activity discriminates the mark OFF, even though hasOpenPr is also true", () => {
  const taskId = "W1-TOPD";
  const recentTs = "2026-08-17T11:58:00.000Z"; // 2 minutes before `now`, inside the 30m bound
  const lines = [...staleOpenPrLines(taskId), { ts: recentTs, run_id: "r1", task_id: taskId, step: "recon.done" }];
  const p = deriveStatus(task({ id: taskId }), depsFor(taskId, { readLedger: () => lines }));
  assert.equal(p.status, "running");
  assert.equal(p.processUnevidenced, undefined, "recentActivity alone is process evidence — no mark");
});

test("W1-T1240: a live lock holder discriminates the mark OFF, even with a stale ledger and an open PR", () => {
  const taskId = "W1-TOPD";
  const p = deriveStatus(
    task({ id: taskId }),
    depsFor(taskId, { inflightHolder: () => ({ pid: 4242 }), isPidAlive: (pid) => pid === 4242 }),
  );
  assert.equal(p.status, "running");
  assert.equal(p.processUnevidenced, undefined, "a live lock is process evidence — the marker discriminates rather than firing on every open PR");
});

// ── ACCEPTANCE 3: the disjunction itself is untouched — no open-PR row flips to orphaned ─────

test("W1-T1240: the marker rides ALONGSIDE the pre-existing disjunction result — status stays running, orphaned never fires, for the open-PR-only row", () => {
  const p = deriveStatus(task(), depsFor("W1-TOPD"));
  assert.equal(p.status, "running", "the falsifier this task must not trip: an open-PR row flipping to orphaned/queued");
  assert.notEqual(p.orphaned, true);
  assert.equal(p.processUnevidenced, true, "the mark is additive — it does not replace or gate the status word");
});

test("W1-T1240: recentActivity-only and hasLiveLock-only rows (no open PR at all) still render running exactly as before — the disjunction's other two arms are untouched", () => {
  const taskId = "W1-TOPD";
  const noPrGithub = fakeGitHub({}); // no PR resolves at all — hasOpenPr is false for both cases below

  const recentTs = "2026-08-17T11:58:00.000Z";
  const recentOnly = deriveStatus(
    task({ id: taskId }),
    depsFor(taskId, {
      github: noPrGithub,
      readLedger: () => [{ ts: recentTs, run_id: "r1", task_id: taskId, step: "run.start" }],
    }),
  );
  assert.equal(recentOnly.status, "running");
  assert.equal(recentOnly.processUnevidenced, undefined, "process evidence present — no mark, no orphaning");

  const liveLockOnly = deriveStatus(
    task({ id: taskId }),
    depsFor(taskId, {
      github: noPrGithub,
      readLedger: () => [{ ts: OLD_TS, run_id: "r1", task_id: taskId, step: "run.start" }],
      inflightHolder: () => ({ pid: 4242 }),
      isPidAlive: (pid) => pid === 4242,
    }),
  );
  assert.equal(liveLockOnly.status, "running");
  assert.equal(liveLockOnly.processUnevidenced, undefined);
});

// ── ACCEPTANCE 4: absent inflightHolder ⇒ unevidenced, never "dead" ──────────────────────────

test("W1-T1240: with NO inflightHolder dep wired at all, an open-PR-only row still just reports processUnevidenced — a skipped lock read is never read as a corpse", () => {
  // depsFor's base object passes no `inflightHolder` — the exact "dep omitted entirely" shape
  // test/inflight-liveness-anchor.test.ts already exercises for the disjunct itself.
  const p = deriveStatus(task(), depsFor("W1-TOPD"));
  assert.equal(p.processUnevidenced, true);
  assert.equal(p.status, "running");
  assert.notEqual(p.orphaned, true, "absent process evidence degrades to unevidenced, never to a dead/orphaned verdict");
});

test("W1-T1240: inflightHolder WIRED but resolving to null (a genuinely absent lock, not a skipped read) still reports unevidenced, identically", () => {
  const p = deriveStatus(task(), depsFor("W1-TOPD", { inflightHolder: () => null }));
  assert.equal(p.processUnevidenced, true, "an absent holder and an absent DEP must read the same — both are 'not evidenced', never 'dead'");
  assert.equal(p.status, "running");
});

// ── ACCEPTANCE 5: the marker reaches the BOARD row, not just the projection ──────────────────

test("W1-T1240: computeBoardSnapshot carries processUnevidenced onto BoardRow, gated by the SAME isRunningRow predicate as workerState", () => {
  const taskId = "A";
  const ledgerPath = ledgerFile(staleOpenPrLines(taskId));
  const deps: BoardDeps = {
    plan: planOf([task({ id: taskId })]),
    ledgerPath,
    github: openPrGithub(),
    now: () => Date.parse(NOW_FAR),
  };
  const row = computeBoardSnapshot(deps).tasks.find((t) => t.taskId === taskId)!;
  assert.equal(isRunningRow(row), true);
  assert.equal(row.processUnevidenced, true, "the mark must reach the board row, not stop at the bare projection");
});

test("W1-T1240: a board row backed by recent activity (not just an open PR) carries no mark", () => {
  const taskId = "A";
  const recentTs = "2026-08-17T11:58:00.000Z";
  const ledgerPath = ledgerFile([...staleOpenPrLines(taskId), { ts: recentTs, run_id: "r1", task_id: taskId, step: "recon.done" }]);
  const deps: BoardDeps = {
    plan: planOf([task({ id: taskId })]),
    ledgerPath,
    github: openPrGithub(),
    now: () => Date.parse(NOW_FAR),
  };
  const row = computeBoardSnapshot(deps).tasks.find((t) => t.taskId === taskId)!;
  assert.equal(row.processUnevidenced, undefined);
});

test("W1-T1240: no second ledger read — computeBoardSnapshot's processUnevidenced comes from the SAME already-parsed lines deriveStatus consumed", () => {
  const taskId = "A";
  const ledgerPath = ledgerFile(staleOpenPrLines(taskId));
  let readCount = 0;
  const deps: BoardDeps = {
    plan: planOf([task({ id: taskId })]),
    ledgerPath,
    github: openPrGithub(),
    now: () => Date.parse(NOW_FAR),
    readLedger: (p) => {
      readCount++;
      return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    },
  };
  const row = computeBoardSnapshot(deps).tasks.find((t) => t.taskId === taskId)!;
  assert.equal(row.processUnevidenced, true);
  assert.equal(readCount, 1, "computeBoardSnapshot must read the ledger exactly once");
});
