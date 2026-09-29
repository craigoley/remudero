import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";
import {
  createDispatchBreakerCache,
  dispatchesWithoutNewOwnedPr,
  evaluateDispatchBreakerDetailed,
  readLedgerLines,
} from "../src/lib/status.js";
import { COMMANDS, main } from "../src/run-task.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// ── W1-T4691: A HALTED TASK CAN NEVER BE RELEASED — the dispatch circuit breaker's trip
// deliberately survives a rotation and a daemon restart (W1-T2425's own invariant), and the ONLY
// reset the breaker itself understands is a new owned `pr.opened` — which a task the breaker
// refuses to dispatch can never produce. `rmd release <task-id> --reason "<text>"` is the
// sanctioned way out: it appends one explicit, attributable `dispatch.breaker_released` ledger
// row that `seedCountFromCircuitBreak`/`dispatchStreakTally` (status.ts) read exactly like a new
// `pr.opened` reset — never an inference from silence, never an archive read (both were tried
// and rejected; see this task's own rationale). ──────────────────────────────────────────────

/** The row the breaker itself already writes at refusal time — the cross-restart seed
 *  `seedCountFromCircuitBreak` reads (W1-T2425). */
function circuitBrokenRow(taskId: string, freshCount: number): Record<string, unknown> {
  return { step: "dispatch.circuit_broken", task: taskId, freshCount };
}

/** The EXACT row `rmd release <task-id> --reason "<text>"` appends — design (i) of this task's
 *  own plan shard: `dispatch.breaker_released {task, reason, released_count}`. */
function releaseRow(taskId: string, reason: string, releasedCount: number): Record<string, unknown> {
  return {
    step: "dispatch.breaker_released",
    task_id: taskId,
    task: taskId,
    reason,
    released_count: releasedCount,
    actor: "operator",
  };
}

test("W1-T4691: a released task is dispatchable on the next tick", () => {
  const taskId = "W1-T9001";
  // The exact halted shape this task's own rationale measured (OBSERVED 2026-09-29): five
  // dispatches tripped the breaker, which wrote its own `dispatch.circuit_broken` row (the seed a
  // restarted process reads), and rotation later compacted the `run.start` rows themselves away —
  // leaving nothing live but the seed. A fresh process reading that ledger alone can never tell
  // "compacted away" apart from "the count actually dropped", so it reads `indeterminate` forever,
  // exactly as W1-T2425 intends.
  const ledger = writeLedger([circuitBrokenRow(taskId, 5)]);

  // Sanity: this is the falsifier this task names verbatim — "ignore the release row and the
  // first test finds the task still indeterminate."
  const before = evaluateDispatchBreakerDetailed(ledger.path, taskId, createDispatchBreakerCache());
  assert.equal(before.state, "indeterminate", "sanity: halted, and nothing but a release can move it");
  assert.equal(before.priorCount, 5, "sanity: the seed came from the breaker's own on-disk row");

  ledger.append([releaseRow(taskId, "fixed the underlying block, resuming", 5)]);

  // A FRESH cache (a new tick, or a restarted daemon) reads the released task as CLEAR, not
  // merely "no longer indeterminate" — dispatchable, the acceptance claim's own words.
  const after = evaluateDispatchBreakerDetailed(ledger.path, taskId, createDispatchBreakerCache());
  assert.equal(after.state, "clear");
  assert.equal(after.ledgerState, "clear");
  assert.equal(after.freshCount, 0, "the release resets the streak exactly like a new pr.opened");
  assert.equal(after.priorCount, undefined, "the release also clears the cross-restart seed W1-T2425 reads");
});

test("W1-T4691: a release is a recorded operator row and never an inference", () => {
  const taskId = "W1-T9002";
  const ledger = writeLedger([circuitBrokenRow(taskId, 5)]);

  // Silence never authorizes dispatch: an unrelated row, and even a release row FOR A DIFFERENT
  // TASK, must leave this task exactly as indeterminate as it was — the breaker never infers a
  // release from the absence of evidence, or from someone else's.
  ledger.append([{ step: "ci.polling", task_id: taskId }, releaseRow("W1-OTHER-TASK", "unrelated release", 3)]);
  const stillHalted = evaluateDispatchBreakerDetailed(ledger.path, taskId, createDispatchBreakerCache());
  assert.equal(stillHalted.state, "indeterminate", "no event but THIS task's own release row may clear it");

  // The release row names the count it is releasing — read from the live ledger BEFORE the
  // release, the same value `rmd release` itself prints — so the row is a RECORD of a decision,
  // not a value fabricated after the fact.
  const releasedCount = dispatchesWithoutNewOwnedPr(readLedgerLines(ledger.path), taskId);
  assert.equal(releasedCount, 0, "sanity: run.start rows were rotated away — the seed alone carries the count");
  const reason = "fixed the underlying block, resuming";
  ledger.append([releaseRow(taskId, reason, 5)]);

  const rows = readLedgerLines(ledger.path);
  const written = rows.find((l) => l.step === "dispatch.breaker_released" && l.task_id === taskId);
  assert.ok(written, "the release must land as one durable ledger row, not an in-memory-only flip");
  assert.equal(written?.reason, reason, "the row carries WHY, attributably, never a bare reset");
  assert.equal(written?.released_count, 5, "the row carries the count it releases");

  const released = evaluateDispatchBreakerDetailed(ledger.path, taskId, createDispatchBreakerCache());
  assert.equal(released.state, "clear", "the recorded row — and only the recorded row — releases the task");
});

// ── The CLI surface itself: `rmd release` exists, requires --reason (an attributable ask, never
// a silent flip), and its own registry text names the row this breaker mechanism reads. ────────

test("W1-T4691: `rmd release` is registered, requires --reason, and names the ledger row it writes", () => {
  const spec = COMMANDS.find((c) => c.name === "release");
  assert.ok(spec, "COMMANDS is missing a 'release' entry");
  assert.match(spec!.syntax, /<task-id>/);
  assert.match(spec!.syntax, /--reason/);
  assert.match(spec!.detail, /dispatch\.breaker_released/);
});

// ── The command itself, driven through the real `main()` — every arm `rmd release` has: argument
// refusals, the unknown-task refusal, the append, and the best-effort issue close (its success,
// its failure that must never block the release, and the already-released no-op). ──────────────

/** A throwaway HOME + `config.json` whose `root` holds this test's own ledger. */
function instance(seed: Array<Record<string, unknown>>): { home: string; ledgerPath: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-t4691-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, seed.map((l) => JSON.stringify(l)).join("\n") + (seed.length ? "\n" : ""));
  return { home, ledgerPath };
}

class ProcessExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

interface ReleaseRun {
  code: number | undefined;
  out: string;
  err: string;
  ghCalls: string[];
  rows: Array<Record<string, unknown>>;
}

async function runRelease(
  t: import("node:test").TestContext,
  args: string[],
  seed: Array<Record<string, unknown>>,
  ghRoutes: GhShimRoute[] = [],
): Promise<ReleaseRun> {
  const { home, ledgerPath } = instance(seed);
  const shim = ghShim([...ghRoutes, { when: "", stderr: "t4691 test: unexpected gh call", exit: 1 }], { kind: "t4691-gh" });
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(process, "exit", ((code?: number): never => {
    throw new ProcessExitCalled(code);
  }) as typeof process.exit);
  t.mock.method(console, "log", (...a: unknown[]) => out.push(a.join(" ")));
  t.mock.method(console, "error", (...a: unknown[]) => err.push(a.join(" ")));
  t.mock.method(console, "warn", () => {});
  const saved = { argv: process.argv, home: process.env.HOME, path: process.env.PATH, guard: process.env[SELF_SYNC_GUARD_ENV] };
  process.argv = ["node", "run-task.js", "release", ...args];
  process.env.HOME = home;
  process.env.PATH = `${shim.dir}:${saved.path}`;
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  try {
    let caught: unknown;
    await withLiveWritesAllowed(() =>
      main().catch((e) => {
        caught = e;
      }),
    );
    assert.ok(caught instanceof ProcessExitCalled, `main() must reach process.exit, not some other throw: ${String(caught)}`);
    return {
      code: (caught as ProcessExitCalled).code,
      out: out.join("\n"),
      err: err.join("\n"),
      ghCalls: shim.calls(),
      rows: readLedgerLines(ledgerPath) as Array<Record<string, unknown>>,
    };
  } finally {
    process.argv = saved.argv;
    process.env.HOME = saved.home;
    process.env.PATH = saved.path;
    if (saved.guard === undefined) delete process.env[SELF_SYNC_GUARD_ENV];
    else process.env[SELF_SYNC_GUARD_ENV] = saved.guard;
    rmSync(home, { recursive: true, force: true });
  }
}

const REAL_TASK = "W1-T143"; // a real plan/tasks.yaml id (repo: remudero)
const ISSUE_URL = "https://github.com/craigoley/remudero/issues/4242";
const released = (rows: Array<Record<string, unknown>>) => rows.filter((r) => r.step === "dispatch.breaker_released");
const escalated = (): Record<string, unknown> => ({
  step: "dispatch.circuit_broken.escalated",
  task_id: REAL_TASK,
  repo: "remudero",
  issue_url: ISSUE_URL,
});

test("W1-T4691: `rmd release` refuses a missing --reason before writing anything", async (t) => {
  const noReason = await runRelease(t, [REAL_TASK], []);
  assert.equal(noReason.code, 2);
  assert.match(noReason.err, /--reason <text> is required/);
  assert.equal(released(noReason.rows).length, 0, "a refused release writes no row");
});

test("W1-T4691: `rmd release` refuses an unknown flag", async (t) => {
  const r = await runRelease(t, [REAL_TASK, "--reason", "x", "--bogus"], []);
  assert.equal(r.code, 2);
  assert.match(r.err, /rmd release: unexpected argument '--bogus'/);
  assert.equal(released(r.rows).length, 0);
});

test("W1-T4691: `rmd release` with no task id prints the usage and exits 2", async (t) => {
  const r = await runRelease(t, [], []);
  assert.equal(r.code, 2);
  assert.match(r.err, /rmd release <task-id> --reason <text>/);
  assert.equal(released(r.rows).length, 0);
});

test("W1-T4691: `rmd release` refuses a task the plan does not name", async (t) => {
  const r = await runRelease(t, ["W1-NOT-A-TASK", "--reason", "x"], []);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown task 'W1-NOT-A-TASK'/);
  assert.equal(released(r.rows).length, 0);
});

test("W1-T4691: `rmd release` appends one attributable row naming the count it releases and touches no issue when none was raised", async (t) => {
  const r = await runRelease(t, [REAL_TASK, "--reason", "the block is fixed"], [{ step: "dispatch.circuit_broken", task: REAL_TASK, freshCount: 5 }]);
  assert.equal(r.code, 0);
  const rows = released(r.rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task_id, REAL_TASK);
  assert.equal(rows[0].reason, "the block is fixed");
  assert.equal(typeof rows[0].released_count, "number");
  assert.equal(typeof rows[0].actor, "string");
  assert.match(r.out, /circuit breaker released/);
  assert.deepEqual(r.ghCalls, [], "no escalation was raised, so no issue is touched");
});

test("W1-T4691: `rmd release` closes the open circuit-breaker escalation with a pointer to the release row", async (t) => {
  const r = await runRelease(t, [REAL_TASK, "--reason", "the block is fixed"], [escalated()], [{ when: "issue close", stdout: "" }]);
  assert.equal(r.code, 0);
  assert.equal(released(r.rows).length, 1);
  assert.equal(r.ghCalls.filter((c) => c.includes("issue close") && c.includes(ISSUE_URL)).length, 1);
  assert.match(r.out, /closed https:\/\/github\.com\/craigoley\/remudero\/issues\/4242/);
});

test("W1-T4691: a failed issue close is reported but never blocks the release row", async (t) => {
  const r = await runRelease(t, [REAL_TASK, "--reason", "the block is fixed"], [escalated()], [{ when: "issue close", stderr: "boom", exit: 1 }]);
  assert.equal(r.code, 0, "the ledger row is what dispatch reads — a close failure must not fail the verb");
  assert.equal(released(r.rows).length, 1, "the release row lands regardless");
  assert.match(r.err, /could not close .*4242/);
});

test("W1-T4691: an escalation an earlier release already retired is not closed a second time", async (t) => {
  const priorRelease = { step: "dispatch.breaker_released", task_id: REAL_TASK, task: REAL_TASK, repo: "remudero", reason: "earlier", released_count: 5, actor: "operator" };
  const r = await runRelease(t, [REAL_TASK, "--reason", "again"], [escalated(), priorRelease]);
  assert.equal(r.code, 0);
  assert.equal(released(r.rows).length, 2, "the second release is appended too");
  assert.deepEqual(r.ghCalls, [], "the earlier release already retired the escalation issue");
});
