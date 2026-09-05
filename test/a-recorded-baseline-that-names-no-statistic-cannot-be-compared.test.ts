import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "mount-headroom-sweep.mjs");

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a STATIC `import … from
// "../scripts/mount-headroom-sweep.mjs"` is a TS7016 — the same reason
// test/a-source-file-cannot-outgrow-its-baseline.test.ts reaches its script through a runtime
// import. A dynamic specifier is not statically resolved, so this loads the REAL module with no
// shadow copy that could drift from it.
const {
  ACCEPTED_STATISTICS,
  LANE_RESTORE_BASELINE,
  REQUIRED_BASELINE_FIELDS,
  compareToLaneRestoreBaseline,
  renderLaneRestoreComparison,
  renderMountHeadroomReport,
} = (await import(pathToFileURL(SCRIPT).href)) as {
  ACCEPTED_STATISTICS: readonly string[];
  LANE_RESTORE_BASELINE: {
    statistic: string;
    taskClass: string;
    costUsd: number;
    corpusNewestTs: string;
    corpusDistinctRuns: number;
    command: string;
  };
  REQUIRED_BASELINE_FIELDS: readonly string[];
  compareToLaneRestoreBaseline: (
    report: unknown,
    baseline?: Record<string, unknown>,
  ) => { statistic: string; taskClass: string; baselineUsd: number; currentUsd: number; down: boolean; deltaUsd: number; baselineCorpusNewestTs: string | null; currentCorpusNewestTs: string | null; command: string } | null;
  renderLaneRestoreComparison: (comparison: unknown) => string;
  renderMountHeadroomReport: (report: unknown) => string;
};

/**
 * test/a-recorded-baseline-that-names-no-statistic-cannot-be-compared.test.ts — W1-T2708.
 *
 * `dispatchLanes` holds the fleet at 2 and states its own release: "Restore to 3 once burn per run
 * is down, and record the measurement that justifies it rather than restoring on optimism." The
 * posture is right; what it lacked was a comparable left-hand side. The only per-run figures sat
 * one block over, in `reviewLanes` prose — "$0.63/run measured, against implement at $5.28",
 * 2026-09-01 — naming no STATISTIC, no CORPUS WINDOW and no COMMAND.
 *
 * THAT AMBIGUITY FLIPS THE ANSWER. Measured 2026-09-02 over 67 archives, all three rotation forms,
 * 801,987 raw rows deduped to 749 distinct runs: class `src` read cost p50 4.94 / p90 11.34 / max
 * 38.46. If $5.28 was a MEDIAN the condition reads MET (a 6.4% improvement); if it was a MEAN,
 * today's mean is necessarily above 4.94 — a p90 of 11.34 and a max of 38.46 guarantee it — and
 * burn may be UP. The same two numbers support opposite rulings. An operator session already came
 * within one step of comparing $5.28 against a p50 as though the statistics matched.
 *
 * So the deliverable is a COMPUTED CONDITION, not a better sentence: the baseline names all four
 * fields, the sweep prints the current reading against it in the same statistic, a baseline
 * missing a field is refused rather than compared anyway, and a mean on either side is refused.
 * The sweep still rules on nothing.
 */

/** A report shaped exactly as `buildMountHeadroomSweep` returns one, with the class row this
 *  comparison reads and a corpus stamp. */
function reportWith(costP50: number | null, taskClass = LANE_RESTORE_BASELINE.taskClass): unknown {
  return {
    corpus: { newestTs: "2026-09-05T00:00:00.000Z", stateDir: "/s", formsOpened: [], archiveCount: 0, liveFileRead: true, unread: [], rawRowsWithRunId: 0, distinctRunCount: 0, rowToRunRatio: 0 },
    classes: [{ taskClass, settledRuns: 10, totalRuns: 12, turnsP50: 1, turnsP90: 2, turnsMax: 3, costP50, costP90: 9, costMax: 20, outcomes: { passing: 1, blockedCi: 1, redispatched: 0 }, costPerCompletedTaskUsd: 1 }],
    cells: [],
  };
}

// ── acceptance 1: the baseline names its statistic, class, window and command ──────────────────

test("W1-T2708 (acceptance 1): the recorded baseline names its statistic, its class, its corpus window and the command that produced it", () => {
  assert.equal(LANE_RESTORE_BASELINE.statistic, "p50", "the field whose absence flipped the answer");
  assert.equal(LANE_RESTORE_BASELINE.taskClass, "src", "and which class row it is read from");
  assert.equal(typeof LANE_RESTORE_BASELINE.costUsd, "number");
  assert.match(LANE_RESTORE_BASELINE.corpusNewestTs, /^\d{4}-\d{2}-\d{2}T/, "the corpus WINDOW, not just a date in prose");
  assert.ok(LANE_RESTORE_BASELINE.corpusDistinctRuns > 0, "and how many distinct runs it was taken over");
  assert.match(
    LANE_RESTORE_BASELINE.command,
    /mount-headroom-sweep\.mjs/,
    "the exact command, so the reading is reproducible rather than asserted",
  );
  // The four REQUIRED fields are the exact list the 2026-09-01 figure was missing — pinned here so
  // a later edit cannot quietly drop one from the guard while leaving the guard looking intact.
  assert.deepEqual([...REQUIRED_BASELINE_FIELDS], ["statistic", "taskClass", "costUsd", "command"]);
});

// ── acceptance 2: the sweep prints the current reading against it, in the same statistic ───────

test("W1-T2708 (acceptance 2a): the comparison reads the CURRENT figure in the baseline's own statistic and reports whether burn is down", () => {
  const down = compareToLaneRestoreBaseline(reportWith(4.1));
  assert.ok(down);
  assert.equal(down.statistic, "p50");
  assert.equal(down.baselineUsd, LANE_RESTORE_BASELINE.costUsd);
  assert.equal(down.currentUsd, 4.1);
  assert.equal(down.down, true);
  assert.equal(down.deltaUsd, Number((4.1 - LANE_RESTORE_BASELINE.costUsd).toFixed(2)));

  const up = compareToLaneRestoreBaseline(reportWith(6.5));
  assert.ok(up);
  assert.equal(up.down, false, "the condition must be able to read NOT MET, or it decides nothing");
});

test("W1-T2708 (acceptance 2b): the sweep's own rendered report carries the comparison beside the table it is drawn from", () => {
  const text = renderMountHeadroomReport(reportWith(4.1) as never);
  assert.match(text, /lane-restore condition/, "printed by the sweep itself, not only reachable through a helper");
  assert.match(text, /p50 4\.1 vs baseline 4\.94/, "both figures, in the same statistic");
  assert.match(text, /burn per run reads DOWN/);
  assert.match(text, /Reproduce with: .*mount-headroom-sweep\.mjs/, "and the command, so a reader can re-take it");
  // BOTH corpus windows, because a comparison across two different windows is what this task exists
  // to make visible rather than to hide.
  assert.ok(text.includes(LANE_RESTORE_BASELINE.corpusNewestTs), "the baseline's window");
  assert.ok(text.includes("2026-09-05T00:00:00.000Z"), "and this corpus's own newest row");
});

test("W1-T2708 (acceptance 2c): an ABSENT class row is reported as not answerable — never as a reading of zero", () => {
  const none = compareToLaneRestoreBaseline(reportWith(4.1, "some-other-class"));
  assert.equal(none, null, "no src row to read — absent, not zero (the vacuous-pass shape)");
  assert.match(renderLaneRestoreComparison(none), /NOT ANSWERABLE/);
  assert.match(renderLaneRestoreComparison(none), /An absent reading is not a reading of zero/);
  // A class that exists but settled nothing is the same case, reached differently.
  assert.equal(compareToLaneRestoreBaseline(reportWith(null)), null);
});

// ── acceptance 3: a baseline missing any required field is REFUSED, loudly ─────────────────────

test("W1-T2708 (acceptance 3): a baseline missing ANY of the four fields is refused by name rather than compared anyway", () => {
  for (const field of REQUIRED_BASELINE_FIELDS) {
    const broken = { ...LANE_RESTORE_BASELINE, [field]: undefined };
    assert.throws(
      () => compareToLaneRestoreBaseline(reportWith(4.1), broken),
      (err: Error) => {
        assert.match(err.message, new RegExp(`missing \\\`${field}\\\``), `the refusal must NAME ${field}`);
        assert.match(err.message, /Refusing rather than comparing anyway/);
        return true;
      },
      `dropping ${field} must refuse`,
    );
  }
  // The BLOCKING CONTROL: the same call with every field present must NOT throw, or the loop above
  // would pass for a reason that has nothing to do with the missing field.
  assert.doesNotThrow(() => compareToLaneRestoreBaseline(reportWith(4.1), LANE_RESTORE_BASELINE));
});

// ── acceptance 4: a percentile on both sides — a mean on either side is refused ────────────────

test("W1-T2708 (acceptance 4): a MEAN on either side is refused — the exact ambiguity that made the 2026-09-01 figure unusable", () => {
  assert.throws(
    () => compareToLaneRestoreBaseline(reportWith(4.1), { ...LANE_RESTORE_BASELINE, statistic: "mean" }),
    /not one of p50\/p90/,
    "a mean is dragged by exactly the outlier a headroom sweep exists to find",
  );
  assert.throws(
    () => compareToLaneRestoreBaseline(reportWith(4.1), { ...LANE_RESTORE_BASELINE, statistic: "average" }),
    /PERCENTILES, NEVER A MEAN/,
  );
  // And the accepted set is a percentile set on BOTH sides: p90 reads the report's p90 column,
  // never silently falling back to p50 — a comparison across two statistics is the defect itself.
  assert.deepEqual([...ACCEPTED_STATISTICS], ["p50", "p90"]);
  const p90 = compareToLaneRestoreBaseline(reportWith(4.1), { ...LANE_RESTORE_BASELINE, statistic: "p90" });
  assert.ok(p90);
  assert.equal(p90.currentUsd, 9, "the report's p90 column (9), not its p50 (4.1)");
});

// ── acceptance 5: reports only — no lane count changes, no restore is ruled on ─────────────────

test("W1-T2708 (acceptance 5): the sweep changes no lane count and rules on no restore — it reports a reading", () => {
  const sweepSrc = readFileSync(join(REPO_ROOT, "scripts", "mount-headroom-sweep.mjs"), "utf8");
  const code = sweepSrc
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
  // No write of any kind to the policy the condition lives in, and no lane arithmetic.
  assert.doesNotMatch(code, /writeFileSync|appendFileSync|dispatchLanes\s*[:=]/, "the sweep is read-only about lanes");
  // The rendered text says so in as many words, so an operator reading the output cannot mistake a
  // reading for a ruling.
  const text = renderMountHeadroomReport(reportWith(4.1) as never);
  assert.match(text, /reports only, rules on nothing/);

  // CONTROL for the comment-stripping above: the file's prose DOES discuss lanes, so a whole-file
  // scan would have matched. If this reads 0 the filter is wrong rather than the source clean.
  const inComments = sweepSrc.split("\n").filter((l) => l.trim().startsWith("//") && /lane/i.test(l));
  assert.ok(inComments.length > 0, "the filter is doing real work — prose really does discuss lanes here");
});

// ── the two records cannot drift: policy.yaml's comment is pinned to the constant ──────────────

test("W1-T2708: plan/policy.yaml's dispatchLanes comment names the constant and agrees with it — a prose figure re-copied into the right row is the same defect one row over", () => {
  const policy = readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8");
  const idx = policy.indexOf("  dispatchLanes:");
  assert.ok(idx > 0, "the row exists");
  // UNFOLD THE COMMENT BLOCK BEFORE MATCHING. A YAML comment wraps at the file's line width, so the
  // mirroring clause below spans two physical lines and no contiguous substring of the raw text
  // contains it — the same one-physical-line hazard a `grep:` proof hits. Strip each line's `#`
  // and join, so the assertion is about the PROSE rather than about where it happened to wrap.
  const block = policy
    .slice(Math.max(0, idx - 4000), idx)
    .split("\n")
    .map((l) => l.replace(/^\s*#\s?/, "").trim())
    .join(" ")
    .replace(/\s+/g, " ");
  assert.match(block, /LANE_RESTORE_BASELINE/, "the comment POINTS at the constant rather than restating it loosely");
  assert.match(block, /mount-headroom-sweep\.mjs/, "and names the instrument that owns it");
  // PINNED ON ONE CONSTRUCTED PHRASE, not on "the number appears somewhere in the block". The
  // measured-2026-09-02 sentence a few lines up ALSO quotes 4.94, so a loose `includes` passed
  // even after the mirroring figure was changed to 9.99 — measured, and the reason this assertion
  // is built from the constant rather than searching for its parts.
  const mirrored =
    `the statistic (${LANE_RESTORE_BASELINE.statistic}), the class (${LANE_RESTORE_BASELINE.taskClass}), ` +
    `the figure ($${LANE_RESTORE_BASELINE.costUsd})`;
  assert.ok(
    block.includes(mirrored),
    `the comment's mirroring clause must read exactly "${mirrored}" — otherwise the prose and the ` +
      `constant have drifted, which is the same defect one row over`,
  );
  assert.ok(block.includes(LANE_RESTORE_BASELINE.corpusNewestTs), "and the corpus window");
  assert.match(block, /rules on nothing|did not reopen it/i, "and the comment states the sweep decides nothing");
});
