import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ciFrictionRoundsFromLedger, gitCiFrictionOwnerSearch, withoutBirthRounds } from "../src/lib/ci-friction-gardener.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { gitRepo } from "./helpers/git-repo.js";

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

test("W1-T9823: a test's red on the pull request that added the test is that PR's own development, not friction", () => {
  const rounds = ciFrictionRoundsFromLedger([
    pr("aaa", 12294),
    pr("bbb", 7),
    dispatch("aaa", "DAEMON-1", "2026-10-16T12:47:58.000Z", [{ check: "ci-shard (1/8)", signature: FILE }]),
    dispatch("bbb", "DAEMON-1", "2026-10-17T01:00:00.000Z", [{ check: "ci-shard (1/8)", signature: FILE }]),
    dispatch("bbb", "DAEMON-1", "2026-10-17T02:00:00.000Z", [{ check: "commitlint", signature: "subject too long" }]),
  ]);
  const addedByPr = (file: string) => file === FILE ? 12294 : undefined;
  assert.deepEqual(withoutBirthRounds(rounds, { addedByPr }).map((r) => [r.pr, r.cause.name]),
    [[7, `test:${FILE}`], [7, "ci-log:commitlint:subject-too-long"]]);
  // A flaky-keyed cause is the same test file, so its birth round goes too.
  const flaky = [{ pr: 12294, cause: { kind: "check" as const, name: `test:${FILE}:flaky` }, minutes: 1 }];
  assert.deepEqual(withoutBirthRounds(flaky, { addedByPr }), []);
  // No provenance, from an absent seam or a test with no adding pull request, keeps every round.
  assert.equal(withoutBirthRounds(rounds, {}).length, rounds.length);
  assert.equal(withoutBirthRounds(rounds, { addedByPr: () => undefined }).length, rounds.length);
});

test("W1-T9823: the git owner search names the pull request whose merge added a file", (t) => {
  const repo = gitRepo({ kind: "added-by-pr" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "test"), { recursive: true });
  writeFileSync(join(repo.dir, FILE), "a\n");
  repo.git("add", FILE);
  repo.git("commit", "-qm", "test(x): add the x suite (#12294)");
  writeFileSync(join(repo.dir, FILE), "b\n");
  repo.git("commit", "-qam", "fix(x): a later edit (#12400)");
  writeFileSync(join(repo.dir, "test/y.test.ts"), "y\n");
  repo.git("add", "test/y.test.ts");
  repo.git("commit", "-qm", "a direct commit with no pull request");
  const search = gitCiFrictionOwnerSearch((args) => repo.git(...args), "HEAD");
  assert.equal(search.addedByPr?.(FILE), 12294);
  assert.equal(search.addedByPr?.(FILE), 12294, "a second read answers from the same pinned history");
  assert.equal(search.addedByPr?.("test/y.test.ts"), undefined);
  assert.equal(search.addedByPr?.("test/absent.test.ts"), undefined);
});


test("retry evidence cannot turn another head or an unsuccessful retry into a flaky cause", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  for (const [extra, recovered] of [
    [{ head_sha: head, pr_numbers: [1], retry_outcome: "recovered" }, true],
    [{ head_sha: other, pr_numbers: [1], retry_outcome: "recovered" }, false],
    [{ head_sha: head, pr_numbers: [2], retry_outcome: "recovered" }, false],
    [{ head_sha: head, pr_numbers: [1], retry_outcome: "also_failed" }, false],
    [{ head_sha: head, pr_numbers: [1] }, false],
    [{ retry_outcome: "recovered" }, false],
    [{}, false],
  ] as const) {
    const rounds = ciFrictionRoundsFromLedger([
      pr(head, 1),
      { step: "test.flake_retry", file: FILE, ts: "2026-10-13T00:30:00.000Z", ...extra } as LedgerRecord,
      dispatch(head, "DAEMON-1", "2026-10-13T01:00:00.000Z", [{ check: "coverage-shard (3/8)", signature: FILE }]),
    ]);
    assert.deepEqual(rounds.map(r => [r.pr, r.cause.name, r.minutes]), [[1, `test:${FILE}${recovered ? ":flaky" : ""}`, 10]], JSON.stringify(extra));
  }
});

test("retry failure titles stay with the recorded PR head instead of contaminating later evidence", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  for (const recordedHead of [head, other, undefined]) {
    const [round] = ciFrictionRoundsFromLedger([
      pr(head, 1),
      { step: "test.flake_retry", retry_outcome: "also_failed", file: FILE, titles: ["recorded failure"], pr_numbers: [1], head_sha: recordedHead, ts: "2026-10-13T00:30:00.000Z" } as LedgerRecord,
      dispatch(head, "DAEMON-1", "2026-10-13T01:00:00.000Z", [{ check: "coverage-shard (3/8)" }]),
    ]);
    assert.deepEqual(round?.evidence?.flatMap(e => e.tests ?? []) ?? [], recordedHead === head ? ["recorded failure"] : []);
    assert.equal(round?.minutes, 10);
  }
});
