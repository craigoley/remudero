import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import {
  CI_FAILURE_EXCERPT_CAP,
  CI_FAILURE_TESTS_CAP,
  ciFailureLedgerEntry,
  ciFrictionRoundLines,
  ciFrictionRoundsFromLedger,
  ciFrictionShardYaml,
  remedyRoundsOf,
  testRunnerFailures,
  type CiFrictionDraft,
} from "../src/lib/ci-friction-gardener.js";
import type { LedgerRecord } from "../src/lib/retro.js";

const TS = "2026-10-13T00:00:00.000Z";
const PR_URL = "https://github.com/craigoley/remudero/pull/4242";
const LOG = [
  `2026-10-13T00:59:01.123Z TAP version 13`,
  `2026-10-13T00:59:02.000Z not ok 1 - the first failing title`,
  `2026-10-13T00:59:02.100Z   AssertionError: expected 1 to equal 2`,
  `2026-10-13T00:59:03.000Z not ok 2 - the second failing title`,
  `2026-10-13T00:59:04.000Z # fail 2`,
].join("\n");

test("W1-T9057: fix.dispatch ledgers each failure's titles and a bounded excerpt", () => {
  const entry = ciFailureLedgerEntry({ name: "coverage-shard (3/8)", logTail: LOG, tailSource: "log" });
  assert.equal(entry.check, "coverage-shard (3/8)");
  assert.deepEqual(entry.tests, ["the first failing title", "the second failing title"]);
  assert.equal(entry.tail_source, "log");
  assert.ok(entry.excerpt?.includes("not ok 1 - the first failing title"), "the excerpt opens at the first failure");
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(entry.excerpt ?? ""), "log timestamps are not stored");

  // Bounded: a flood of failures and a huge line keep a capped count and a capped excerpt.
  const flood = Array.from({ length: 20 }, (_, i) => `not ok ${i + 1} - title ${i + 1}`).join("\n") + `\nError: ${"x".repeat(5000)}`;
  assert.equal(testRunnerFailures(flood).length, CI_FAILURE_TESTS_CAP);
  const big = ciFailureLedgerEntry({ name: "x", logTail: `not ok 1 - a\n${"y".repeat(5000)}` });
  assert.ok((big.excerpt ?? "").length <= CI_FAILURE_EXCERPT_CAP);

  // A tail that is not a test runner's names no titles, and an empty tail stores no excerpt.
  const plain = ciFailureLedgerEntry({ name: "commitlint", logTail: "" });
  assert.deepEqual([plain.tests, plain.excerpt, plain.tail_source], [[], null, null]);
});

test("W1-T9057: a drafted rationale carries each round's PR link, failing test titles and a log excerpt", () => {
  const FILE = "test/x.test.ts";
  const log = LOG.replace("the first failing title", `the first failing title (${FILE})`).replace(
    "2026-10-13T00:59:02.100Z   AssertionError: expected 1 to equal 2",
    [
      "2026-10-13T00:59:02.100Z   ---",
      `2026-10-13T00:59:02.100Z   location: '${FILE}:1:1'`,
      "2026-10-13T00:59:02.100Z   failureType: 'testCodeFailure'",
      "2026-10-13T00:59:02.100Z   error: 'expected 1 to equal 2'",
      "2026-10-13T00:59:02.100Z   ...",
    ].join("\n"),
  );
  const records = [
    { step: "pr.opened", run_id: "run-1", pr_url: PR_URL, ts: TS },
    { step: "fix.dispatch", run_id: "run-1", round: 1, mode: "ci-log", head_sha: "aaa", elapsed_ms: 600_000, ts: "2026-10-13T01:00:00.000Z",
      ci_failures: [ciFailureLedgerEntry({ name: "coverage-shard (3/8)", logTail: log, tailSource: "log" })] },
  ] as unknown as LedgerRecord[];
  const rounds = ciFrictionRoundsFromLedger(records);
  assert.equal(rounds[0]?.cause.name, `test:${FILE}`, "the round is keyed by the test, not the shard");
  assert.equal(rounds[0]?.prUrl, PR_URL);

  // The gate-priced FAMILY key never equals a round's own key, so an exact match collected nothing.
  const key = "check:coverage-shard";
  const draft: CiFrictionDraft = {
    price: { cause: { kind: "check", name: "coverage-shard" }, minutes: 14.5, rounds: 3, prs: 2 },
    rung: 1,
    owner: { files: ["scripts/coverage-shard.mjs"], why: ["scripts/coverage-shard.mjs: names \"coverage-shard\" (1 line(s))"] },
    rounds: remedyRoundsOf(rounds),
  };
  const lines = ciFrictionRoundLines(draft.rounds, key);
  assert.ok(!lines.includes("- (none recorded)"), "a family key collects its member rounds");

  const task = (parse(ciFrictionShardYaml(draft, "W1-T9999")) as Array<{ rationale: string }>)[0]!;
  assert.match(task.rationale, new RegExp(`PR #4242 \\(${PR_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\)`));
  assert.match(task.rationale, /the first failing title/);
  assert.match(task.rationale, /the second failing title/);
  assert.match(task.rationale, /log excerpt:[\s\S]*\| not ok 1 - the first failing title/);
  assert.ok(!task.rationale.includes("(none recorded)"));
  assert.ok(!task.rationale.includes("fix round(s)") && !task.rationale.includes("seven-day half-life"), "a gate-priced cause is not described as recency-weighted fix rounds");
  assert.match(task.rationale, /3 red run\(s\) within the measured window on 2 pull request\(s\)/);

  // A round of another family is not collected.
  assert.deepEqual(ciFrictionRoundLines(draft.rounds, "check:commitlint"), ["- (none recorded)"]);
});

test("W1-T9057: a round with no titles of its own takes the titles of the PR's also_failed flake retry", () => {
  const records = [
    { step: "pr.opened", run_id: "run-2", pr_url: PR_URL, ts: TS },
    { step: "test.flake_retry", source: "selector-shadow", retry_outcome: "also_failed", file: "test/y.test.ts", titles: ["flaky title"], pr_numbers: [4242], ts: TS },
    { step: "fix.dispatch", run_id: "run-2", round: 1, mode: "ci-log", head_sha: "bbb", elapsed_ms: 600_000, ts: "2026-10-13T02:00:00.000Z",
      ci_failures: [{ check: "coverage-shard (1/8)", signature: null }] },
  ] as unknown as LedgerRecord[];
  const [round] = remedyRoundsOf(ciFrictionRoundsFromLedger(records));
  assert.deepEqual(round?.evidence?.[0]?.tests, ["flaky title"]);
  assert.equal(round?.prUrl, PR_URL);
});
