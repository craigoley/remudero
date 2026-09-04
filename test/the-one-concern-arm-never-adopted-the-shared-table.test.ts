// test/the-one-concern-arm-never-adopted-the-shared-table.test.ts — W1-T2823.
//
// The rubric's ONE-CONCERN arm fired on 83.7% of judged PRs because it never adopted the
// companion table W1-T2547 extracted so that "BOTH task-linter.ts and review.ts can read it".
// `review.ts` already imported `isCompanionPath`; every call site was inside `checkDocsAwareness`,
// against the SIBLING table `GENERATED_LEDGER_CLASSES`. This suite pins the arm onto
// `COMPANION_PATH_CLASSES` — the table, not a fourth private basename rule — and pins the
// two-pass shape `subsystemsOf` already uses so the discount can never empty the tally.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { COMPANION_PATH_CLASSES, type CompanionPathClass } from "../src/lib/companion-paths.js";
import { checkOneConcern, judgeRubric } from "../src/lib/review.js";

const REVIEW_SRC = "src/lib/review.ts";

/** A minimal unified diff touching `files` — `checkOneConcern` reads only the changed paths. */
function diffOf(files: readonly string[]): string {
  return files
    .flatMap((f) => [`diff --git a/${f} b/${f}`, `+++ b/${f}`, "@@", "+const x = 1;"])
    .join("\n");
}

const stems = (r: { reason: string }): string[] => {
  const m = /\((.+?)\)/.exec(r.reason);
  return m ? m[1].split(", ").filter((s) => s !== "") : [];
};

// ─────────────────────────────────────────────────────────────────────────────
// The real corpus. Concern-bearing paths ONLY (`src/` and `test/`), captured with
// `git show --format= --name-only` over `git log origin/main --format=%H -80` at
// origin/main = e5841b91 — this repo SQUASH-merges, so one commit is one PR. The 37
// commits carrying no concern-bearing path are the ones the arm does not judge at all.
// `checkOneConcern` reads nothing but the changed paths, so a path list replays a real
// PR exactly.
const JUDGED_COMMITS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["e5841b91", ["src/lib/worker.ts", "src/run-task.ts", "test/fix-rung-birth-snapshot.test.ts"]],
  ["351dd92f", ["src/lib/worker-provider.ts", "src/lib/worker.ts", "test/a-codex-reviewer-scratch-directory-is-not-a-repository.test.ts", "test/a-codex-worker-starts-outside-a-git-repository.test.ts", "test/a-codex-worker-uses-a-private-temporary-root.test.ts", "test/codex-model-console.test.ts", "test/codex-worker-home-redirection.test.ts", "test/worker-provider.test.ts"]],
  ["40f12818", ["test/a-mount-comparison-across-unmatched-populations-is-not-a-measurement.test.ts"]],
  ["2695b603", ["test/the-wipe-test-can-only-ask-about-learnings.test.ts"]],
  ["7795f63d", ["src/lib/daemon.ts", "src/lib/drain.ts", "src/lib/panel-graph.ts", "src/lib/status-board.ts", "src/run-task.ts", "test/a-merged-tasks-shard-still-reads-queued-so-the-fleet-rebuilds-it.test.ts", "test/queue-head-breaker-refusal-reaches-the-rendered-board.test.ts", "test/queue-head-dispatch-parity.test.ts", "test/queue-head-names-a-circuit-broken-refusal.test.ts"]],
  ["0c7c195b", ["test/captured-console-names-the-reason.test.ts", "test/helpers/captured-console.ts", "test/the-wipe-test-can-only-ask-about-learnings.test.ts"]],
  ["caa9287c", ["src/lib/review.ts", "test/a-modified-test-line-reads-as-added-test-code.test.ts", "test/fixtures/test-theater-planted/planted.ts"]],
  ["84ed0b8b", ["src/lib/status-board.ts", "test/status-board-operator-message.test.ts"]],
  ["11c88ed4", ["src/lib/ci-parity.ts", "src/run-task.ts", "test/a-gate-verdict-names-its-own-context.test.ts"]],
  ["f5275938", ["src/run-task.ts", "test/a-task-trailer-redirects-review-to-an-unrelated-shard.test.ts"]],
  ["563e6d83", ["src/lib/commit-message.ts", "src/lib/plan-pr-emitter.ts", "test/generated-text-message-standard.test.ts"]],
  ["6bc4db09", ["src/lib/ci-parity.ts", "test/the-census-roster-is-named-not-numbered.test.ts"]],
  ["504ecafa", ["src/lib/escalate.ts", "src/run-task.ts", "test/fix-rung-open-escalation-stand-down.test.ts"]],
  ["393dfa99", ["src/lib/ci-parity.ts", "test/host-caused-suite-reds.test.ts"]],
  ["6a7e6d0a", ["src/lib/review.ts", "test/a-new-ci-yml-job-cannot-ship-its-own-registration.test.ts"]],
  ["923a346b", ["src/lib/measurement-cadence.ts", "src/lib/serve.ts", "test/serve-self-measurement.test.ts"]],
  ["3a7c20a5", ["src/lib/plan-coherence.ts", "src/lib/retro.ts", "src/run-task.ts", "test/plan-coherence.test.ts"]],
  ["3bc15420", ["src/run-task.ts", "test/a-worker-may-not-apply-the-edit-its-gate-printed.test.ts"]],
  ["e2a8947b", ["src/lib/review.ts", "src/run-task.ts", "test/a-growing-task-cannot-record-its-own-ceiling.test.ts"]],
  ["f0df8e0c", ["test/citation-anchor-census.test.ts"]],
  ["fa7438ac", ["src/lib/ci-parity.ts", "test/census-population-is-derived-not-counted.test.ts"]],
  ["8bbdeab8", ["src/run-task.ts", "test/preflight-help-is-derived-not-retyped.test.ts"]],
  ["0ece27cf", ["src/lib/retro.ts", "test/followup-settled-question-arm.test.ts"]],
  ["78b24125", ["src/lib/ci-parity.ts", "test/the-census-admission-set-is-derived-not-enumerated.test.ts"]],
  ["f7a62b20", ["src/lib/review.ts", "src/lib/sweep.ts", "test/event-driven-semantic-review.test.ts", "test/two-readers-cannot-disagree-about-one-sha.test.ts"]],
  ["8be8dd95", ["src/lib/dispatch-claim.ts", "src/run-task.ts", "test/a-claim-minted-before-this-namespace-booted-has-no-claimant.test.ts", "test/dispatch-claim-evidence-reachability.test.ts", "test/dispatch-claim.test.ts", "test/sandbox-subject-generator.test.ts"]],
  ["e4174dfd", ["src/run-task.ts", "test/the-proof-debt-producer-reaches-production.test.ts"]],
  ["502809bd", ["src/lib/sweep.ts", "src/run-task.ts", "test/base-caused-release.test.ts", "test/stale-base-release-before-exhaustion.test.ts"]],
  ["2aaabd25", ["src/lib/ci-parity.ts", "src/run-task.ts", "test/a-source-file-cannot-outgrow-its-baseline.test.ts", "test/preflight-coverage-mode.test.ts", "test/preflight-fast-mode.test.ts"]],
  ["08b1054a", ["test/mkdtemp-allowlist-rekey.test.ts", "test/mkdtemp-callsite-check.test.ts"]],
  ["367e1569", ["src/lib/sweep.ts", "test/event-review-backlog-drain.test.ts", "test/light-pass-tick-is-not-bounded-by-ci.test.ts", "test/plan-filing-admission-bound.test.ts", "test/review-admission-dedup.test.ts", "test/review-admission-key-is-not-self-defeating.test.ts", "test/sweep-review-admission.test.ts", "test/sweep.test.ts"]],
  ["1eb3b6ea", ["test/a-source-file-cannot-outgrow-its-baseline.test.ts"]],
  ["4e871cde", ["test/claims-check.test.ts", "test/fixtures/claims-check/plan-format-covers-shards-amended.md", "test/fixtures/claims-check/plan-format-covers-shards-pre-amendment.md", "test/fixtures/claims-check/plan-format-covers-shards.yaml"]],
  ["bdaf6491", ["src/lib/sweep.ts", "src/run-task.ts", "test/body-repair-strike-counts.test.ts", "test/fix-strikes-reset-on-new-head.test.ts", "test/the-fix-rung-strike-cap-does-not-bind.test.ts"]],
  ["f27f0793", ["src/lib/ci-parity.ts", "test/host-caused-suite-reds.test.ts", "test/host-parity-azure-pole.test.ts"]],
  ["95efe298", ["src/lib/worker-provider.ts", "test/a-codex-reviewer-scratch-directory-is-not-a-repository.test.ts"]],
  ["5bc8505f", ["test/mkdtemp-callsite-ci-wiring.test.ts"]],
  ["4b753682", ["src/run-task.ts", "test/a-red-branch-behind-its-base-spends-a-strike-first.test.ts"]],
  ["0a392541", ["src/lib/isolation.ts", "test/a-failed-probe-is-not-a-parse-failure.test.ts"]],
  ["1d71fb15", ["src/lib/github-event-wake.ts", "src/lib/main-health-rung.ts", "src/run-task.ts", "test/main-health-event-wake.test.ts", "test/main-health-wiring.test.ts"]],
  ["6b872f96", ["test/console-token-refresh.test.ts"]],
  ["aa20d5e0", ["src/lib/plan.ts", "test/plan.test.ts"]],
  ["5bbf4f0d", ["test/open-prs-rest.test.ts", "test/retro.test.ts"]],
];

test("W1-T2823 NARROWS: a source module plus this PR's own task-named falsifier is ONE concern", () => {
  // The dominant shape in this repo, and the one the arm flagged six times in seven: a suite is
  // named after the CLAIM it proves, so its basename matches no module and `concernStem` scored
  // it as a second concern.
  const r = checkOneConcern(diffOf(["src/lib/foo.ts", "test/a-claim-about-foo.test.ts"]));
  assert.equal(r.pass, true, "source + its own falsifier must read one concern");
  assert.deepEqual(stems(r), ["foo"], "the falsifier is discounted; the source stem survives");
});

test("W1-T2823 PRESERVES: two real concerns still read two, so the fix narrows without blinding", () => {
  // 563e6d83 on origin/main — `src/lib/commit-message.ts` + `src/lib/plan-pr-emitter.ts` plus one
  // suite. TWO genuine source modules, so the arm must still fire. This is the named regression
  // fixture; W1-T2823's own shard proposed 84ed0b8b for this role, but that commit is
  // `src/lib/status-board.ts` + `test/status-board-operator-message.test.ts` — one source module
  // and its falsifier, which is precisely the shape this task discounts. Reading it as "both
  // stems are real source modules" was wrong, so it cannot serve as the regression fixture.
  const r = checkOneConcern(
    diffOf([
      "src/lib/commit-message.ts",
      "src/lib/plan-pr-emitter.ts",
      "test/generated-text-message-standard.test.ts",
    ]),
  );
  assert.equal(r.pass, false, "two source modules must still be reported as two concerns");
  assert.deepEqual(stems(r), ["commit-message", "plan-pr-emitter"]);

  // And the shard's own rejected fixture, pinned so the correction cannot silently regress.
  const t2547 = checkOneConcern(
    diffOf(["src/lib/status-board.ts", "test/status-board-operator-message.test.ts"]),
  );
  assert.equal(t2547.pass, true, "84ed0b8b is one source module plus its falsifier, not two concerns");
});

test("W1-T2823 VACUITY: companions alone never empty the tally", () => {
  // `subsystemsOf`'s two-pass shape, mirrored rather than re-derived: companions are collected
  // SEPARATELY and folded in only when nothing else survives. A test-only diff must still score
  // its stems — collapsing to zero concerns and passing vacuously is a worse answer than the one
  // being fixed.
  const one = checkOneConcern(diffOf(["test/only-a-suite.test.ts"]));
  assert.equal(one.pass, true);
  assert.deepEqual(stems(one), ["only-a-suite"], "a lone companion is still counted, not erased");

  const two = checkOneConcern(diffOf(["test/one-suite.test.ts", "test/another-suite.test.ts"]));
  assert.equal(two.pass, false, "two unrelated test-only stems still span two concerns");
  assert.deepEqual(stems(two), ["another-suite", "one-suite"]);
});

test("W1-T2823 the discount reads the shared table not a third rule private to the rubric", () => {
  // EXECUTED, not asserted from the source text: an INJECTED class list changes the answer, which
  // is only possible if the arm consults the table it was passed. W1-T457's standing instruction
  // — give the consumer the rule the other gate already has, never invent one.
  const srcIsCompanion: ReadonlyArray<CompanionPathClass> = [
    { tag: "src-as-companion", pathPattern: /^src\// },
  ];
  const injected = checkOneConcern(
    diffOf(["src/lib/foo.ts", "test/a-claim-about-foo.test.ts"]),
    srcIsCompanion,
  );
  assert.deepEqual(
    stems(injected),
    ["a-claim-about-foo"],
    "with src/ declared the companion class, the SOURCE stem is the one discounted",
  );

  // The default really is the shared table, not a copy of its contents.
  assert.equal(COMPANION_PATH_CLASSES.length, 1);
  assert.equal(COMPANION_PATH_CLASSES[0].tag, "test-suite");
  const byDefault = checkOneConcern(diffOf(["src/lib/foo.ts", "test/a-claim-about-foo.test.ts"]));
  assert.deepEqual(stems(byDefault), ["foo"]);

  // And no FOURTH basename/path heuristic was added alongside it. `TEST_PATH_EXACT_RE` is the one
  // pre-existing `^test/` literal in this file and answers a different question (proof-path
  // validation); a second one would be the drift W1-T2790 ranks a shared definition above.
  const src = readFileSync(REVIEW_SRC, "utf8");
  const testPathLiterals = src.match(/\^test\\\//g) ?? [];
  assert.equal(
    testPathLiterals.length,
    1,
    "review.ts must not gain a private test-path rule beside the shared table",
  );
});

test("W1-T2823 measured firing rate recorded over the real corpus, before and after", () => {
  assert.equal(JUDGED_COMMITS.length, 43, "the sample must be non-empty before any rate is believed");

  // BEFORE — the rule this task replaces, frozen here as a measurement baseline rather than
  // re-derived: every concern-bearing stem counted, with no companion discount at all.
  const stemOf = (p: string): string =>
    (p.split("/").pop() ?? p).replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "").replace(/\.[cm]?[jt]sx?$/, "");
  let before = 0;
  for (const [, files] of JUDGED_COMMITS) if (new Set(files.map(stemOf)).size > 1) before += 1;

  // AFTER — the shipped predicate, run over the same real corpus.
  let after = 0;
  for (const [, files] of JUDGED_COMMITS) if (!checkOneConcern(diffOf(files)).pass) after += 1;

  assert.equal(before, 36, "83.7% of 43 judged PRs — the rate that made the arm unreadable");
  assert.equal(after, 19, "44.2% — the arm now fires on fewer than half");
  assert.ok(after < before, "the fix must be judged on movement, not on plausibility");
});

test("W1-T2823 LOOSE beats TIGHT on this corpus, which is why the trailer is not read", () => {
  // W1-T2823's design left the choice open and required both be MEASURED. TIGHT is W1-T2525's
  // `ownFalsifierSlug` narrowing: discount only the falsifier whose stem equals the task's own
  // shard slug. Over the same 43 commits: TODAY 36 (83.7%), LOOSE 19 (44.2%), TIGHT 33 (76.7%).
  // They differ on 6 commits and TIGHT is wrong on every one, because a shard slug is derived
  // from the TITLE and truncated while a falsifier is named after the CLAIM — 3bc15420's slug is
  // `a-fix-worker-is-forbidden-by-its-own-prompt-from-applying-the-one-edit-i` while its suite is
  // `a-worker-may-not-apply-the-edit-its-gate-printed`, so TIGHT flags the PR's OWN falsifier.
  // LOOSE also needs no `Remudero-Task:` trailer, a dependency this arm does not have.
  const tightDisagrees: ReadonlyArray<readonly string[]> = [
    ["src/lib/review.ts", "test/a-modified-test-line-reads-as-added-test-code.test.ts", "test/fixtures/test-theater-planted/planted.ts"],
    ["src/lib/status-board.ts", "test/status-board-operator-message.test.ts"],
    ["src/lib/ci-parity.ts", "test/the-census-roster-is-named-not-numbered.test.ts"],
    ["src/lib/ci-parity.ts", "test/host-caused-suite-reds.test.ts"],
    ["src/run-task.ts", "test/a-worker-may-not-apply-the-edit-its-gate-printed.test.ts"],
    ["src/lib/ci-parity.ts", "test/census-population-is-derived-not-counted.test.ts"],
  ];
  for (const files of tightDisagrees) {
    assert.equal(
      checkOneConcern(diffOf(files)).pass,
      true,
      `${files[0]}: one source module plus its own suite is one concern under the shared table`,
    );
  }
});

test("W1-T2823 the arm still reports — narrowed, not deleted", () => {
  const rubric = judgeRubric({
    diff: diffOf(["src/lib/commit-message.ts", "src/lib/plan-pr-emitter.ts"]),
  });
  const arm = rubric.items.find((r) => r.key === "one-concern");
  assert.ok(arm, "judgeRubric must still consult the one-concern arm");
  assert.equal(arm.pass, false, "a genuinely two-module PR still reaches the operator through the rubric");
});
