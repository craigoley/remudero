// test/did-the-lesson-work.test.ts — W1-T3055.
//
// The one question that settles whether the CI-learning loop is worth running, and nothing asked it.
//
// Every signal upstream measures something SHORT of the outcome. `cited_count` measured INJECTION —
// was the fact put in a prompt — and retro.ts's own comment calls it "a proxy standing in for a
// signal nothing produced", which ranked the least-INJECTED entry as least useful and fed the next
// injection. W1-T2760 added `LEARNINGS_USED`, which is better and is still a worker's own CLAIM
// that it used a lesson. A claim is not an outcome.
//
// The outcome is: after a lesson about gate G landed, did G go on refusing pull requests?

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectCiFailureCorpus, type CorpusPr } from "../src/lib/ci-failure-corpus.js";
import {
  CI_LEARNING_MINT_CEILING,
  judgeCiLessonEfficacy,
  parseFiledCiLesson,
} from "../src/lib/measurement-cadence.js";
import {
  readFiledCiLessons,
  summarizeCiLessonRecurrences,
  readCiLessonExposure,
} from "../src/lib/ci-lesson-recurrence.js";

const pair = (pr: number, gate: string) => ({ pr, gate, state: "repaired" as const, redSha: "a", repairFiles: [] });
const lesson = (gate: string, watermarkPr: number) => ({ findingId: `ci-learning:1:${gate}`, gate, watermarkPr });
const seen = (pr: number, gate: string) => ({ pr, gate });
const corpus = (pairs = [pair(1, "g"), pair(2, "g")], fullyObservedGatePrs = pairs.map((p) => seen(p.pr, p.gate))) => ({
  pairs,
  fullyObservedGatePrs,
});

const exposureWindow = { windowStart: "2026-10-01T12:00:00Z", asOf: "2026-10-02T12:00:00Z", complete: true, prsScanned: 3 };
const exposureSummary = (input: ReturnType<typeof corpus>, lessons = [lesson("g", 2)], ceiling = 3, complete = true) => {
  const result = summarizeCiLessonRecurrences(judgeCiLessonEfficacy(input, lessons), ceiling, { ...exposureWindow, complete });
  assert.equal(result.status, "observed");
  if (result.status !== "observed") throw new Error("missing summary");
  return result.exposure;
};

test("lesson exposure preserves a gate-specific PR denominator and observed recurrence rate", () => {
  const input = corpus([pair(9, "g"), pair(9, "g")], [seen(9, "g"), seen(11, "g"), seen(11, "g"), seen(12, "other")]);
  const result = exposureSummary(input);
  assert.equal(result.status, "observed");
  assert.deepEqual(result.lessons[0], { findingId: "ci-learning:1:g", gate: "g", watermarkPr: 2,
    exposedPrs: [9, 11], recurredPrs: [9], exposureCount: 2, recurrenceCount: 1, omittedPrCount: 0 });
  assert.equal(result.observedRecurrenceRate, 0.5);
  assert.equal(result.retention, "uncertified");
  assert.deepEqual(readCiLessonExposure(result, exposureWindow.asOf, true), result);
});

test("partial lesson history retains a definite recurrence but cannot certify a rate or held lesson", () => {
  const result = exposureSummary(corpus([pair(9, "g")], []), undefined, 3, false);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.lessons[0].exposedPrs, [9]);
  assert.deepEqual(result.lessons[0].recurredPrs, [9]);
  assert.equal(result.observedRecurrenceRate, null);
  assert.equal("heldCount" in result, false);
  assert.deepEqual(readCiLessonExposure(result, exposureWindow.asOf, true), result);
  const unrelated = exposureSummary(corpus([], [seen(12, "other")]));
  if (unrelated.status === "unavailable") throw new Error("missing exposure");
  assert.equal(unrelated.exposureCount, 0);
  assert.equal(unrelated.observedRecurrenceRate, null);
  const green = exposureSummary(corpus([], [seen(12, "g")]));
  if (green.status === "unavailable") throw new Error("missing exposure");
  assert.equal(green.observedRecurrenceRate, 0);
});

test("omitted lesson or PR identities make the bounded exposure partial without erasing named receipts", () => {
  const result = exposureSummary(corpus([pair(9, "g"), pair(11, "g"), pair(12, "g")]), undefined, 2);
  if (result.status === "unavailable") throw new Error("missing exposure");
  assert.equal(result.status, "partial");
  assert.deepEqual(result.lessons[0].exposedPrs, [11, 12]);
  assert.equal(result.lessons[0].omittedPrCount, 1);
  assert.equal(result.observedRecurrenceRate, null);
  const omitted = exposureSummary(corpus([], [seen(9, "g"), seen(10, "a")]), [lesson("g", 2), lesson("a", 2)], 1);
  if (omitted.status === "unavailable") throw new Error("missing exposure");
  assert.equal(omitted.omittedLessonCount, 1);
  assert.equal(omitted.status, "partial");
  assert.equal(omitted.observedRecurrenceRate, null);
});

test("repeated lesson snapshots preserve the newest watermark and count each lesson gate PR once", () => {
  const input = corpus([pair(9, "g")], [seen(9, "g"), seen(11, "g")]);
  const result = exposureSummary(input, [lesson("g", 2), lesson("g", 3), lesson("g", 2), lesson("g", 3)]);
  if (result.status === "unavailable") throw new Error("missing exposure");
  assert.equal(result.lessons.length, 1);
  assert.equal(result.lessons[0].watermarkPr, 3);
  assert.equal(result.exposureCount, 2);
  assert.equal(result.recurrenceCount, 1);
  // Equal latest PRs exercise deterministic identity ordering without merging distinct gates.
  const tied = exposureSummary(corpus([], [seen(11, "b"), seen(11, "a")]), [lesson("b", 1), lesson("a", 1)]);
  if (tied.status === "unavailable") throw new Error("missing exposure");
  assert.deepEqual(tied.lessons.map(row => row.gate), ["a", "b"]);
});

test("legacy, future, duplicate, and forged exposure records stay unavailable instead of inventing rates", () => {
  const valid = exposureSummary(corpus([pair(9, "g")], [seen(11, "g")]));
  if (valid.status === "unavailable") throw new Error("missing exposure");
  assert.deepEqual(readCiLessonExposure(undefined, exposureWindow.asOf, true), { status: "unavailable", reason: "producer-exposure-missing" });
  assert.deepEqual(readCiLessonExposure({ status: "unavailable", reason: "observation-window-missing" }, exposureWindow.asOf, true),
    { status: "unavailable", reason: "observation-window-missing" });
  const invalid = [
    {}, { ...valid, status: "held" }, { ...valid, basis: "pr" }, { ...valid, retention: "complete" },
    { ...valid, window: null }, { ...valid, lessons: null }, { ...valid, lessons: Array(101).fill(valid.lessons[0]) },
    { ...valid, window: { ...valid.window, asOf: "2026-10-03T12:00:00Z" } },
    { ...valid, window: { ...valid.window, windowStart: "invalid" } },
    { ...valid, window: { ...valid.window, windowStart: "2026-10-03T12:00:00Z" } },
    { ...valid, window: { ...valid.window, prsScanned: -1 } },
    { ...valid, window: { ...valid.window, complete: "true" } },
    { ...valid, omittedLessonCount: -1 }, { ...valid, lessons: [null] },
    { ...valid, lessons: [valid.lessons[0], valid.lessons[0]] },
    { ...valid, exposureCount: 99 }, { ...valid, recurrenceCount: 99 }, { ...valid, observedRecurrenceRate: 0 },
    { ...valid, status: "partial" },
    ...[ { findingId: "" }, { gate: "" }, { watermarkPr: 0 }, { omittedPrCount: -1 },
      { exposedPrs: null }, { recurredPrs: null }, { exposedPrs: [9, 9] }, { exposedPrs: [2] },
      { recurredPrs: [99] }, { recurredPrs: [9, 9] }, { exposureCount: 99 }, { recurrenceCount: 99 },
    ].map(change => ({ ...valid, lessons: [{ ...valid.lessons[0], ...change }] })),
  ];
  for (const value of invalid) assert.equal(readCiLessonExposure(value, exposureWindow.asOf, true).status, "unavailable");
  const unreadable = readCiLessonExposure(valid, exposureWindow.asOf, false);
  assert.equal(unreadable.status, "partial");
  assert.equal(unreadable.observedRecurrenceRate, null);
  assert.equal(unreadable.exposureCount, 2);
});

test("exposure refuses invalid observation bounds and keeps old recurrence callers explicitly unmeasured", () => {
  const efficacy = judgeCiLessonEfficacy(corpus(), [lesson("g", 2)]);
  const legacy = summarizeCiLessonRecurrences(efficacy, 3);
  if (legacy.status !== "observed") throw new Error("missing summary");
  assert.deepEqual(legacy.exposure, { status: "unavailable", reason: "observation-window-missing" });
  for (const ceiling of [0, 101, 1.5]) assert.throws(() => summarizeCiLessonRecurrences(efficacy, ceiling, exposureWindow), /ceiling/);
  for (const change of [{ windowStart: "bad" }, { asOf: "bad" }, { windowStart: "2026-10-03T12:00:00Z" }, { prsScanned: -1 }])
    assert.throws(() => summarizeCiLessonRecurrences(efficacy, 3, { ...exposureWindow, ...change }), /window/);
});
const pr = (number: number, commits: CorpusPr["commits"]): CorpusPr => ({ number, commits });
const run = (name: string, conclusion: string) => ({
  name,
  status: "COMPLETED",
  conclusion,
  startedAt: "2026-09-09T12:00:00Z",
});

test("W1-T3055: a gate that kept refusing after the lesson landed reads RECURRED, naming the PRs", () => {
  const input = corpus([pair(1, "g"), pair(2, "g"), pair(9, "g"), pair(11, "g")]);
  const [r] = judgeCiLessonEfficacy(input, [lesson("g", 2)]);
  assert.equal(r.verdict, "recurred");
  assert.deepEqual(r.recurredPrs, [9, 11], "the lesson did not take, and these are the receipts");
});

test("W1-T3055: all-green later exposures of the lesson's gate read HELD", () => {
  // Falsifier for the old denominator: neither later PR produces a failure pair, so counting only
  // corpus.pairs reports UNMEASURABLE even though the target gate ran and passed twice.
  const input = collectCiFailureCorpus({
    prs: [
      pr(9, [{ sha: "green9", rollup: [run("g", "SUCCESS")] }]),
      pr(11, [{ sha: "green11", rollup: [run("g", "SUCCESS")] }]),
    ],
  });
  const [r] = judgeCiLessonEfficacy(input, [lesson("g", 2)]);
  assert.equal(r.verdict, "held");
  assert.deepEqual(r.recurredPrs, []);
  assert.equal(r.laterPrsSeen, 2, "the denominator is carried, so `held` can be checked rather than believed");
});

test("W1-T3055: unrelated or unreadable later gates cannot manufacture a HELD verdict", () => {
  const input = collectCiFailureCorpus({
    prs: [
      pr(9, [{ sha: "other", rollup: [run("other", "FAILURE")] }]),
      pr(10, [{ sha: "pending", rollup: [run("g", "IN_PROGRESS")] }]),
      pr(11, [
        { sha: "green", rollup: [run("g", "SUCCESS")] },
        { sha: "blind" },
      ]),
      pr(12, []),
    ],
  });
  const [r] = judgeCiLessonEfficacy(input, [lesson("g", 2)]);
  assert.equal(r.verdict, "unmeasurable");
  assert.equal(r.laterPrsSeen, 0);
});

test("W1-T3055: NO later PRs is UNMEASURABLE, never held — a claim over an empty set is not a pass", () => {
  // The verdict that matters most. A lesson filed from the newest pull requests in a window has no
  // "after" yet; calling that success would be the vacuous pass this repo's coverage and ledger
  // sections already refuse, and it would accumulate silently as the loop's headline number.
  const [r] = judgeCiLessonEfficacy(corpus(), [lesson("g", 2)]);
  assert.equal(r.verdict, "unmeasurable");
  assert.equal(r.laterPrsSeen, 0);
  assert.deepEqual(r.recurredPrs, []);
});

test("W1-T3055: a gate is judged only against ITS OWN later failures, never another gate's", () => {
  const input = corpus(
    [pair(1, "g"), pair(9, "unrelated"), pair(10, "unrelated")],
    [seen(1, "g"), seen(9, "unrelated"), seen(10, "unrelated")],
  );
  const [r] = judgeCiLessonEfficacy(input, [lesson("g", 1)]);
  assert.equal(r.verdict, "unmeasurable", "another gate's noise is neither a recurrence nor exposure");
});

test("W1-T3055: one PR refusing twice on the same gate counts once", () => {
  const input = corpus([pair(1, "g"), pair(9, "g"), pair(9, "g")]);
  const [r] = judgeCiLessonEfficacy(input, [lesson("g", 1)]);
  assert.deepEqual(r.recurredPrs, [9], "a PR is one recurrence however many times it tripped");
});

test("W1-T3055: the watermark is read from the shard's own field, and its ABSENCE is unjudgeable", () => {
  const filed = [
    "- id: W1-T1",
    '  origin: "ci-learning:368:ci-gate"',
    "  ci_learning_prs: [368, 402, 511]",
  ].join("\n");
  assert.deepEqual(parseFiledCiLesson(filed), {
    findingId: "ci-learning:368:ci-gate",
    gate: "ci-gate",
    watermarkPr: 511,
    // The HIGHEST, not the origin's first: judging a lesson against pull requests it was derived
    // FROM would score it on its own evidence.
  });

  // Every lesson filed before this task carries no watermark. Undefined — unjudgeable — rather than
  // falling back to the origin's PR, which would do exactly that self-scoring.
  const older = ['- id: W1-T1', '  origin: "ci-learning:368:ci-gate"'].join("\n");
  assert.equal(parseFiledCiLesson(older), undefined);
});

test("the production reader finds filed lessons in plan shards and treats a missing shard directory as a measured empty set", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-lessons-"));
  const shards = join(root, "tasks.d");
  mkdirSync(shards);
  try {
    writeFileSync(
      join(shards, "W1-T1.yaml"),
      [
        "- id: W1-T1",
        '  title: "lesson"',
        "  repo: remudero",
        "  depends_on: []",
        "  type: implement",
        "  verify: human",
        "  risk: low",
        "  status: queued",
        "  attempts: 0",
        '  origin: "ci-learning:368:ci-gate"',
        "  ci_learning_prs: [368, 402, 511]",
      ].join("\n"),
    );
    writeFileSync(
      join(shards, "ordinary.yaml"),
      "- id: W1-T2\n  title: ordinary\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: low\n  status: queued\n  attempts: 0\n",
    );

    assert.deepEqual(readFiledCiLessons(shards), {
      status: "measured",
      lessons: [{ findingId: "ci-learning:368:ci-gate", gate: "ci-gate", watermarkPr: 511 }],
    });
    assert.deepEqual(readFiledCiLessons(join(root, "absent")), { status: "measured", lessons: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable candidate shard makes lesson recurrence input explicitly unreadable rather than scoring a partial plan", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-lessons-unreadable-"));
  const shards = join(root, "tasks.d");
  mkdirSync(join(shards, "broken.yaml"), { recursive: true });
  try {
    assert.deepEqual(readFiledCiLessons(shards), { status: "unreadable" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shard that PARSES AS A LESSON BUT NOT AS YAML is unreadable too — the lesson regexes are line-scoped and the document is not", () => {
  // A SECOND, DISTINCT UNREADABLE PATH from the case above, which fails at the READ (a directory
  // where a file should be). This one reads fine and its two lesson lines match: `parseFiledCiLesson`
  // is two line-anchored regexes, so it happily reports a lesson out of a document the YAML parser
  // cannot load at all. Without this arm the throwing branch is unexercised, and a shard corrupted
  // below its origin line would be silently DROPPED from the population rather than making the
  // whole measurement refuse — which is the failure this function's "unreadable" status exists for.
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-lessons-unparseable-"));
  const shards = join(root, "tasks.d");
  mkdirSync(shards, { recursive: true });
  writeFileSync(
    join(shards, "corrupt.yaml"),
    [
      "- id: W1-T0001",
      '  origin: "ci-learning:42:comment-load-ratchet"',
      "  ci_learning_prs: [42]",
      "  files: [unterminated",
    ].join("\n") + "\n",
  );
  try {
    // The lesson lines themselves are intact — this is not a case of the shard failing to look
    // like a lesson.
    const asLesson = parseFiledCiLesson(readFileSync(join(shards, "corrupt.yaml"), "utf8"));
    assert.deepEqual(asLesson, { findingId: "ci-learning:42:comment-load-ratchet", gate: "comment-load-ratchet", watermarkPr: 42 });

    assert.deepEqual(readFiledCiLessons(shards), { status: "unreadable" },
      "a shard whose YAML will not load must make the measurement REFUSE, never quietly shrink the population");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ledger observation is fixed-width: counts positive recurrences but never claims a partial window held", () => {
  const failurePairs = [
    pair(1, "a"),
    pair(10, "a"),
    pair(11, "a"),
    pair(12, "a"),
    pair(13, "a"),
    pair(1, "b"),
    pair(20, "b"),
    pair(1, "c"),
    pair(30, "c"),
    pair(1, "d"),
    pair(40, "d"),
  ];
  const efficacy = judgeCiLessonEfficacy(
    corpus(failurePairs, [...failurePairs.map((p) => seen(p.pr, p.gate)), seen(50, "held")]),
    [lesson("held", 1), lesson("empty", 99), lesson("a", 1), lesson("b", 1), lesson("c", 1), lesson("d", 1)],
  );
  const summary = summarizeCiLessonRecurrences(efficacy, CI_LEARNING_MINT_CEILING);

  assert.equal(summary.status, "observed");
  if (summary.status !== "observed") return;
  assert.deepEqual(
    {
      lessons: summary.lessonCount,
      recurred: summary.recurrenceCount,
      omitted: summary.omittedRecurrenceCount,
    },
    { lessons: 6, recurred: 4, omitted: 1 },
  );
  assert.equal("heldCount" in summary, false, "a one-day window never manufactures a lifetime success verdict");
  assert.equal(summary.recurrences.length, CI_LEARNING_MINT_CEILING);
  assert.deepEqual(summary.recurrences.map((r) => r.gate), ["d", "c", "b"], "newest recurrence first");
  assert.deepEqual(summary.recurrences[0].prs, [40]);

  const manyReceipts = summarizeCiLessonRecurrences(
    judgeCiLessonEfficacy(
      corpus([pair(1, "a"), pair(10, "a"), pair(11, "a"), pair(12, "a"), pair(13, "a")]),
      [lesson("a", 1)],
    ),
    CI_LEARNING_MINT_CEILING,
  );
  assert.equal(manyReceipts.status, "observed");
  if (manyReceipts.status !== "observed") return;
  assert.deepEqual(manyReceipts.recurrences[0].prs, [11, 12, 13]);
  assert.equal(manyReceipts.recurrences[0].omittedPrCount, 1);
});
