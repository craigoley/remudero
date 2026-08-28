import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ensureTaskTrailer } from "../src/run-task.js";

// ── THE DEFECT (W1-T2435) ────────────────────────────────────────────────────────────
// `ensureTaskTrailer` wrapped both its read (`gh pr view`) and its write (`gh pr edit`) in
// ONE bare `catch {}` and emitted zero ledger rows on either path — a failed stamp was
// invisible to the ledger, and `acceptanceGateBodyRepair`'s "structural no-op" reasoning
// (its own doc, run-task.ts) rests on that stamp having landed. This suite proves the
// `catch` now records exactly one diagnostic row per failure, naming the id it was HANDED
// and which of the two calls threw — while staying best-effort (never throwing) and never
// writing a row, or a trailer, when nothing needed to change.

const PR_URL = "https://github.com/craigoley/remudero/pull/999";
const TASK_ID = "W1-T2435";

/** Records every `log(step, extra)` call, mirroring arm-outcome-five-sites.test.ts's `recorder()`. */
function recorder() {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { rows, log: (step: string, extra?: Record<string, unknown>) => void rows.push({ step, extra }) };
}

function readReturning(body: string): (args: string[]) => unknown {
  return () => ({ body });
}
function readThrowing(message = "gh pr view: not found"): (args: string[]) => unknown {
  return () => {
    throw new Error(message);
  };
}
function writeThrowing(message = "gh pr edit: permission denied"): (args: string[]) => unknown {
  return () => {
    throw new Error(message);
  };
}
function writeCounting(): { write: (args: string[]) => unknown; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    write: (args) => {
      calls.push(args);
      return undefined;
    },
    calls,
  };
}

// ── 1: a stamp failure writes a row naming the task id it was handed ────────────────
test("ensureTaskTrailer: a failed read logs trailer_stamp.failed with the handed task id and PR url", () => {
  const { rows, log } = recorder();
  ensureTaskTrailer(PR_URL, TASK_ID, log, readThrowing(), writeCounting().write);
  assert.equal(rows.length, 1, "exactly one diagnostic row");
  assert.equal(rows[0].step, "trailer_stamp.failed");
  assert.equal(rows[0].extra?.task_id, TASK_ID, "the row names the id ensureTaskTrailer was handed");
  assert.equal(rows[0].extra?.pr_url, PR_URL);
});

// ── 2: the row distinguishes a failed read from a failed write ──────────────────────
test("ensureTaskTrailer: a failed read is recorded with phase 'read'", () => {
  const { rows, log } = recorder();
  const { write, calls } = writeCounting();
  ensureTaskTrailer(PR_URL, TASK_ID, log, readThrowing(), write);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extra?.phase, "read");
  assert.equal(calls.length, 0, "a read failure never reaches the write");
});

test("ensureTaskTrailer: a failed write is recorded with phase 'write', distinct from a failed read", () => {
  const { rows, log } = recorder();
  ensureTaskTrailer(PR_URL, TASK_ID, log, readReturning("some existing body"), writeThrowing());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extra?.phase, "write");
});

// ── 3: a successful stamp writes no row at all ───────────────────────────────────────
test("ensureTaskTrailer: a successful read+write logs nothing", () => {
  const { rows, log } = recorder();
  const { write, calls } = writeCounting();
  ensureTaskTrailer(PR_URL, TASK_ID, log, readReturning("some existing body"), write);
  assert.equal(rows.length, 0, "no diagnostic row on the success path");
  assert.equal(calls.length, 1, "the write did happen");
  assert.ok(String(calls[0][4]).includes(`Remudero-Task: ${TASK_ID}`), "the trailer that was written carries the handed id");
});

// ── 4: a body that already carries the trailer returns early and writes nothing ─────
test("ensureTaskTrailer: a body that already has the trailer writes no row and calls no write", () => {
  const { rows, log } = recorder();
  const { write, calls } = writeCounting();
  const bodyWithTrailer = `Some PR description.\n\nRemudero-Task: ${TASK_ID}\n`;
  ensureTaskTrailer(PR_URL, TASK_ID, log, readReturning(bodyWithTrailer), write);
  assert.equal(rows.length, 0, "no diagnostic row when nothing needed to change");
  assert.equal(calls.length, 0, "already-trailered body means the write is never attempted");
});

// ── 5: the stamp stays best effort — no caller fails because the trailer did not land ──
test("ensureTaskTrailer: never throws, even when both read and write fail", () => {
  assert.doesNotThrow(() => {
    ensureTaskTrailer(PR_URL, TASK_ID, () => {}, readThrowing(), writeThrowing());
  });
});

test("ensureTaskTrailer: never throws when the caller passes no log at all (every pre-existing call shape)", () => {
  assert.doesNotThrow(() => {
    ensureTaskTrailer(PR_URL, TASK_ID, undefined, readThrowing(), writeThrowing());
  });
});

// ── 6: no task id is derived from a branch name anywhere on this path ───────────────
test("ensureTaskTrailer: the logged task id is exactly the handed argument, not anything read off the PR/branch", () => {
  const { rows, log } = recorder();
  // A prUrl that could plausibly LOOK like it encodes a different task id — if any code path
  // derived the id from the PR/branch instead of the parameter, this would catch it drifting.
  const trickyPrUrl = "https://github.com/craigoley/remudero/pull/123";
  ensureTaskTrailer(trickyPrUrl, TASK_ID, log, readThrowing(), writeCounting().write);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extra?.task_id, TASK_ID, "the row carries the parameter, not anything derived from the PR/branch");
  assert.equal(rows[0].extra?.pr_url, trickyPrUrl, "the row still carries the actual prUrl for correlation, separately from task_id");
});

const SRC = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");

/** Isolates `ensureTaskTrailer`'s own function body (the doc comment through its closing brace),
 *  so this test fails loud if the mechanism it is asserting on is renamed or restructured, rather
 *  than silently passing against a stale anchor. */
function ensureTaskTrailerSource(): string {
  const start = SRC.indexOf("export function ensureTaskTrailer(");
  assert.ok(start > 0, "ensureTaskTrailer not found — this test's anchor is stale");
  const end = SRC.indexOf("\n/**", start + 1);
  assert.ok(end > start, "could not find the end of ensureTaskTrailer — this test's anchor is stale");
  return SRC.slice(start, end);
}

test("ensureTaskTrailer: source never resolves a branch name or head ref to derive an id", () => {
  const body = ensureTaskTrailerSource();
  assert.equal(body.includes("headRefName"), false, "no branch-head-ref lookup on this path");
  assert.equal(body.includes("taskIdFromRunBranch"), false, "no branch-name-to-task-id inference on this path");
  assert.equal(body.includes("ghPrHeadGateway"), false, "no branch resolution gateway on this path");
});
