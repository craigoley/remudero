import assert from "node:assert/strict";
import test from "node:test";
import { ciFrictionRoundsFromLedger } from "../src/lib/ci-friction-gardener.js";
import type { LedgerRecord } from "../src/lib/retro.js";

const FILE = "test/x.test.ts";
const dispatch = (head: string, run: string, ts: string, ci_failures: Array<{ check: string; signature?: string }>): LedgerRecord =>
  ({ step: "fix.dispatch", run_id: run, round: "resume", mode: "ci-log", head_sha: head, elapsed_ms: 600_000, ts, ci_failures }) as LedgerRecord;
const pr = (head: string, n: number): LedgerRecord => ({ step: "sweep.disposed", run_id: "DAEMON-1", pr_number: n, head_sha: head, ts: "2026-10-13T00:00:00.000Z" }) as LedgerRecord;

test("W1-T9056: one round naming a failing test under a shard and its aggregator prices one test cause", () => {
  const rounds = ciFrictionRoundsFromLedger([
    pr("aaa", 1),
    dispatch("aaa", "DAEMON-1", "2026-10-13T01:00:00.000Z", [
      { check: "coverage-shard (3/8)", signature: FILE },
      { check: "coverage-ratchet" },
      { check: "ci-gate", signature: "red with no failing test" },
    ]),
  ]);
  assert.deepEqual(rounds.map((r) => [r.cause.kind, r.cause.name, r.minutes]), [["check", `test:${FILE}`, 10]]);
});

test("W1-T9056: the same failing test under two different checks is one cause", () => {
  const rounds = ciFrictionRoundsFromLedger([
    pr("aaa", 1),
    pr("bbb", 2),
    dispatch("aaa", "DAEMON-1", "2026-10-13T01:00:00.000Z", [{ check: "coverage-shard (3/8)", signature: FILE }]),
    dispatch("bbb", "DAEMON-1", "2026-10-13T02:00:00.000Z", [{ check: "ci-shard (2/8)", signature: FILE }]),
    // Within one round, two checks naming the same file are one cause, not two shares.
    dispatch("bbb", "DAEMON-1", "2026-10-13T03:00:00.000Z", [{ check: "ci-shard (2/8)", signature: FILE }, { check: "coverage-shard (1/8)", signature: FILE }]),
  ]);
  assert.deepEqual(new Set(rounds.map((r) => r.cause.name)), new Set([`test:${FILE}`]));
  assert.deepEqual(rounds.map((r) => r.minutes), [10, 10, 10]);
});

test("W1-T9056: an aggregator with no named producer keeps its key, and a non-test signature stays per-check", () => {
  const alone = ciFrictionRoundsFromLedger([pr("aaa", 1), dispatch("aaa", "DAEMON-1", "2026-10-13T01:00:00.000Z", [{ check: "coverage-ratchet" }, { check: "commitlint" }])]);
  assert.deepEqual(alone.map((r) => r.cause.name), ["ci-log:coverage-ratchet", "ci-log:commitlint"]);
  const named = ciFrictionRoundsFromLedger([pr("bbb", 2), dispatch("bbb", "DAEMON-1", "2026-10-13T01:00:00.000Z", [{ check: "coverage-ratchet" }, { check: "commitlint", signature: "subject too long" }])]);
  assert.deepEqual(named.map((r) => [r.cause.name, r.minutes]), [["ci-log:commitlint:subject-too-long", 10]]);
});
