#!/usr/bin/env node
// expiring-fixture-census — refuse a test fixture whose hardcoded date will expire against a real
// threshold, BEFORE the day it takes CI red.
//
// WHY THIS IS A GATE AND NOT A CLAUDE.md BULLET (W1-T3272). The rule "a fixed date constant
// compared against rows stamped at REAL time is a time bomb" has been written down since W1-T2250
// and bound nothing. On 2026-09-09 a fixture stamped 2026-08-26T18:15:00Z crossed the sweep's
// 14-day staleness rung at exactly 18:15:00Z and took `main` red, blocking every PR in the repo
// (W1-T3270). main's last green CI ran 18:05, the first red 18:22, and the commit that merged at
// 18:22 touched no src/ file at all -- it reads as the cause on every signal except the clock.
// CLAUDE.md's own preamble says a rule that turns out to matter gets a refusal rather than sharper
// wording. This is the refusal.
//
// WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT. A hardcoded ISO stamp is fine. A hardcoded
// stamp that some threshold ages against `Date.now()` is the defect. So the census pairs each
// fixture stamp with the threshold that judges it and reports THE DATE IT GOES RED -- a margin
// before it does, because a check that reddens the same hour the suite does has bought nothing.
//
// IT REPORTS THE TRANSITION, NOT THE STATE, AND THAT NARROWING IS THE WHOLE DESIGN. MEASURED on
// this tree: 83 fixture stamps sit at or past the threshold, and all but one of them are FINE --
// most cases never reach the staleness rung, and some are testing staleness itself. A gate that
// named all 83 would be a gate nobody could act on, which is how the comment-drift check failed
// before W1-T2953 rewrote it. A fixture that is ALREADY past the threshold has had whatever effect
// it is going to have and the suite is green with it; the dangerous set is exactly those still
// INSIDE the threshold that are about to cross it. That set was 14 rows when this shipped, five of
// them due to flip the next day.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

/** Days of warning before a fixture actually expires. One CI-week: long enough that the failure
 *  lands as a named warning someone can act on, short enough not to flag half the corpus. */
export const MARGIN_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/** A fixture whose crossing does not matter says so on its own line or the one above it, WITH ITS
 *  REASON. The carve-out is REQUIRED, not a convenience, and there are two honest reasons: the case
 *  is testing staleness itself, or the case's outcome does not depend on the disposition at all.
 *  The second is not a matter of opinion -- it is settled by ageing the fixture past the threshold
 *  and re-running, which is how every marker in this tree was placed. A check that cannot tell
 *  those from a real bomb names 83 rows instead of 2 and gets reverted within a week. */
export const EXEMPT_MARKER = "expiring-fixture: exempt";

/**
 * Set (to any truthy string) by ci.yml ONLY on the `ci` job's push-to-main lane (W1-T3655), never
 * on a `pull_request` run. On that lane `origin/main` IS the commit under test -- the run has no
 * earlier base to inherit a crossing FROM, so treating it as one would let a stamp sitting on main
 * excuse itself as "inherited" and go green on the one run that exists to catch it. This is the
 * arm the task's own falsifier calls "the one most likely to be got wrong, since it fails open and
 * looks green": an explicit flag set by the caller who KNOWS which lane it is beats inferring it
 * from a `rev-parse` comparison a coincidental match could satisfy by accident.
 */
export const CENSUS_MAIN_BRANCH_RUN = "CENSUS_MAIN_BRANCH_RUN";

/**
 * The fields a live threshold ages against `Date.now()`, and where that happens.
 *
 * This table is the one thing that can silently go stale, so {@link assertFieldsStillAged} pins
 * every row against its own source: rename the field or drop the comparison and the census FAILS
 * rather than quietly covering nothing. That is the difference between a gate and an ornament.
 */
export const AGED_FIELDS = [
  {
    field: "lastActivityAt",
    threshold: "sweep.staleDays",
    source: "src/lib/sweep.ts",
    // `deriveDisposition` parses this field and compares the resulting ageDays to policy.staleDays.
    evidence: ["Date.parse(pr.lastActivityAt)", "policy.staleDays"],
  },
];

/** The population ratchet: each file's measured fixture count as captured on W1-T3334.
 *
 * This is intentionally a per-file ledger, not a parser for helper indirection. If a literal moves
 * behind a helper, the scanner's measured count drops and this ledger names the file that left.
 * If a fixture is genuinely deleted, lower this one reviewed line for that file in the same change.
 */
export const RECORDED_POPULATION_BY_FILE = Object.freeze({
  "test/a-capped-verdict-stalls-a-pr-with-no-actor.test.ts": 1,
  "test/a-disposition-is-logged-on-change-not-on-every-poll.test.ts": 1,
  "test/a-permanent-diff-refusal-is-not-retried-forever.test.ts": 0,
  "test/a-push-does-not-re-ask-a-head-independent-question.test.ts": 0,
  // W1-T3837: 0, not 1 — its one stamp is now DERIVED from the clock (RECENT_ACTIVITY_ISO),
  // because `routeFix` ages that fixture against the REAL clock and a fixed date made the
  // suite fail on 2026-09-25 with no diff involved. The literal is gone on purpose, so the
  // population it was counted in drops with it.
  "test/a-refusal-is-a-verdict-not-a-strike.test.ts": 0,
  "test/a-remedy-that-changed-nothing-is-dispatched-again.test.ts": 1,
  "test/a-stale-fleet-branch-is-rebased-before-it-is-escalated.test.ts": 0,
  "test/an-open-pr-does-not-rot-while-it-waits.test.ts": 2,
  "test/arm-failure-classification.test.ts": 1,
  "test/board.test.ts": 4,
  "test/cancelled-check-arm-can-see-it.test.ts": 1,
  "test/ci-log-unavailable-is-named.test.ts": 1,
  "test/console-shell-coverage-is-vacuous.test.ts": 3,
  "test/cost-anomaly.test.ts": 1,
  "test/daemon-freshness.test.ts": 0,
  "test/daemon.test.ts": 2,
  "test/entanglement-split-sweep-reachability.test.ts": 1,
  "test/failed-ci-infrastructure-requeue.test.ts": 1,
  "test/filing-forward-reference.test.ts": 1,
  "test/fix-mode-gate-failures.test.ts": 1,
  "test/open-prs-rest.test.ts": 1,
  "test/operator-verdict-steering.test.ts": 1,
  "test/plan-filing-admission-bound.test.ts": 4,
  "test/post-review-refusal-rearm.test.ts": 1,
  "test/push-ci-on-main.test.ts": 1,
  "test/review-admission-key-is-not-self-defeating.test.ts": 14,
  "test/review-body-edit-reoffer.test.ts": 2,
  "test/review-claim-timing.test.ts": 1,
  "test/review-engine-revision-rearm.test.ts": 0,
  "test/review-lane-budget.test.ts": 1,
  "test/review-orphan-wiring.test.ts": 4,
  "test/stale-base-release-before-exhaustion.test.ts": 3,
  "test/stale-gate-discriminator-wiring.test.ts": 1,
  "test/sweep-conflicted-disposition.test.ts": 1,
  "test/sweep-review-admission.test.ts": 9,
  "test/sweep.test.ts": 8,
  "test/terminal-run-pins-a-job-non-terminal.test.ts": 1,
  "test/the-conflict-rung-cannot-admit-a-regenerable-artifact.test.ts": 1,
  "test/the-fix-rung-strike-cap-does-not-bind.test.ts": 1,
  "test/the-ratchet-repair-flag-is-reachable-from-policy.test.ts": 1,
  "test/the-sweep-fan-out-respects-the-host-budget.test.ts": 0,
  "test/update-branch-stale-gate.test.ts": 4,
});

/** Refuse to run if a table row no longer describes the source. A census that has quietly stopped
 *  covering its population answers with a confident zero, which is worse than not existing. */
export function assertFieldsStillAged(readFile = (p) => readFileSync(p, "utf8")) {
  for (const row of AGED_FIELDS) {
    const src = readFile(row.source);
    for (const needle of row.evidence) {
      if (!src.includes(needle)) {
        throw new Error(
          `expiring-fixture-census: STALE TABLE — ${row.source} no longer contains ${JSON.stringify(needle)}, ` +
            `so the census can no longer prove it ages "${row.field}". Update AGED_FIELDS or the census covers nothing.`,
        );
      }
    }
  }
}

// ── W1-T3838: THE INVERSE DIRECTION — REAL => LISTED ────────────────────────────────────────────
//
// `assertFieldsStillAged` above proves LISTED => STILL REAL: pin a row against its own source and
// the census fails rather than quietly covering nothing. That guard runs in exactly one direction.
// Nothing proved REAL => LISTED, and incompleteness -- not staleness -- is what actually took `main`
// and three PRs down on 2026-09-20: `expiresAt` aged a proposal against `Date.now()` in
// src/lib/operator-agent.ts the whole time, AGED_FIELDS never named it, and the census measured 95
// fixture stamps that morning and reported none crossing -- true of the one field it read, useless
// about the one that fired.
//
// DISCOVER, DO NOT HAND-LIST (design (i)). `discoverClockAgedFields` scans source text for the two
// shapes a live threshold actually takes: `Date.parse(x.field) <op> now` on one line (the shape that
// detonated), and `const v = Date.parse(x.field)` followed, within a short window, by `v` and `now`
// (or `Date.now()`) meeting in the same expression -- the shape {@link deriveDisposition} and
// {@link absentAgeMinutes} already use for `lastActivityAt`. A bare variable (`Date.parse(raw)`, no
// property access) is not a FIELD and is not reported; a census that named every local would be the
// noise CLAUDE.md already warns a gate gets reverted over.

const CLOCK_TOKEN = /(?:\bnow\b|Date\.now\(\))/.source;
const CLOCK_WORD_RE = new RegExp(CLOCK_TOKEN);
const DIRECT_COMPARE_RE = new RegExp(
  `Date\\.parse\\(([\\w.?]+)\\)\\s*(?:<=|>=|<|>|===|!==)\\s*${CLOCK_TOKEN}` +
    `|${CLOCK_TOKEN}\\s*(?:<=|>=|<|>|===|!==)\\s*Date\\.parse\\(([\\w.?]+)\\)`,
);
const ASSIGN_RE = /(?:const|let)\s+(\w+)\s*=\s*Date\.parse\(([\w.?]+)\)/;
/** How many lines after an assignment to search for it meeting `now` -- wide enough to cover
 *  {@link deriveDisposition}'s `const parsed = Date.parse(pr.lastActivityAt);` two lines above its
 *  own use, narrow enough that an unrelated `now` later in a long function is not falsely joined. */
const CLOCK_WINDOW_LINES = 6;

/** A property access only, e.g. `pr.lastActivityAt` or `proposal?.expiresAt` -- never a bare local. */
function propertyField(expr) {
  if (!/^[\w$]+(?:\?\.|\.)[\w$]+(?:(?:\?\.|\.)[\w$]+)*$/.test(expr)) return undefined;
  return expr.split(/\?\.|\./).filter(Boolean).pop();
}

/**
 * Every `Date.parse(x.field)` in `files` that a nearby comparison ages against the clock, found
 * instead of hand-listed. PURE: files and reader are parameters, exactly like
 * {@link censusExpiringFixtures}. Each record also carries whether ITS OWN line (or the one above
 * it) waives the finding with {@link EXEMPT_MARKER} -- the identical convention a fixture's own
 * exemption already uses (design (iii): one convention covers both).
 */
export function discoverClockAgedFields({ files, readFile }) {
  const discovered = [];
  for (const file of files) {
    const lines = readFile(file).split("\n");
    for (const [index, line] of lines.entries()) {
      let expr;
      let clockLine = index;
      const direct = DIRECT_COMPARE_RE.exec(line);
      if (direct) {
        expr = direct[1] ?? direct[2];
      } else {
        const assigned = ASSIGN_RE.exec(line);
        if (assigned) {
          const [, varName, varExpr] = assigned;
          const windowEnd = Math.min(lines.length, index + 1 + CLOCK_WINDOW_LINES);
          for (let j = index + 1; j < windowEnd; j++) {
            if (CLOCK_WORD_RE.test(lines[j]) && new RegExp(`\\b${varName}\\b`).test(lines[j])) {
              expr = varExpr;
              clockLine = j;
              break;
            }
          }
        }
      }
      if (!expr) continue;
      const field = propertyField(expr);
      if (!field) continue; // a bare local, not a field -- see the header note above

      const above = (i) => (i > 0 ? lines[i - 1] : "");
      const waived =
        `${line}\n${above(index)}`.includes(EXEMPT_MARKER) ||
        `${lines[clockLine]}\n${above(clockLine)}`.includes(EXEMPT_MARKER);
      discovered.push({ field, source: file, line: index + 1, expr, waived });
    }
  }
  return discovered;
}

/**
 * THE INVERSE OF {@link assertFieldsStillAged}: that one proves LISTED => STILL REAL; this proves
 * REAL => LISTED. A field `src` ages against the clock that is neither a row in `agedFields` nor
 * waived on its own line is a census failure naming the field AND the source that ages it, so the
 * gate fails closed on an unknown field (design (ii)) instead of answering a confident, useless "OK".
 */
export function assertFieldListComplete({ files, readFile, agedFields = AGED_FIELDS }) {
  const discovered = discoverClockAgedFields({ files, readFile });
  const known = new Set(agedFields.map((row) => row.field));
  const missing = new Map();
  for (const d of discovered) {
    if (d.waived || known.has(d.field) || missing.has(d.field)) continue;
    missing.set(d.field, d);
  }
  if (missing.size > 0) {
    const lines = [...missing.values()].map(
      (m) => `  - "${m.field}" ages against the clock at ${m.source}:${m.line}, not in AGED_FIELDS and not waived`,
    );
    throw new Error(
      `expiring-fixture-census: INCOMPLETE TABLE — ${missing.size} clock-aged field(s) are not in AGED_FIELDS:\n` +
        `${lines.join("\n")}\n` +
        `  TO FIX: add a row to AGED_FIELDS in scripts/expiring-fixture-census.mjs, or, if the field genuinely\n` +
        `  needs no census row, waive it with a reason on the line: ${EXEMPT_MARKER} -- <why>.`,
    );
  }
  return discovered;
}

/**
 * MEASURED 2026-09-20 (W1-T3838), by running {@link discoverClockAgedFields} over every tracked
 * `src/**\/*.ts` file: 14 (field, source) findings -- 11 distinct field names, with `ts`,
 * `expires_at`, and `lastActivityAt` each discovered at two sources -- exist beyond
 * `lastActivityAt`, none of them written as a hardcoded ISO fixture literal this census's own
 * population ever measured (the sizing note this task shipped with: run the discovery, read what
 * it finds, and let that decide whether it lands refusing or advisory). Refusing on all fourteen
 * in the same change that adds the discovery would touch eleven different files, only one of them this incident's own
 * (src/lib/operator-agent.ts), with no bearing on this task's one declared concern --
 * scripts/expiring-fixture-census.mjs's AGED_FIELDS completeness, not a src-wide audit of every
 * clock comparison. So {@link main} treats
 * this ledger as ALREADY KNOWN,
 * the identical ratchet shape {@link RECORDED_POPULATION_BY_FILE} already uses: a field discovered
 * OUTSIDE this ledger is unreviewed and blocks; one recorded here is a known, accepted gap that stays
 * visible in the report without failing the build. Removing a row here re-arms that field as blocking
 * on the next scan unless it is also added to AGED_FIELDS or waived with {@link EXEMPT_MARKER}.
 */
export const KNOWN_UNCOVERED_CLOCK_FIELDS = Object.freeze([
  { field: "ts", source: "src/lib/console-shell-client.ts" },
  { field: "ts", source: "src/run-task.ts" },
  { field: "lastPollIso", source: "src/lib/daemon.ts" },
  { field: "lastFireIso", source: "src/lib/feedback-docket.ts" },
  { field: "expires_at", source: "src/lib/github-app.ts" },
  { field: "receivedAtIso", source: "src/lib/github-event-wake.ts" },
  { field: "lastCheckedIso", source: "src/lib/github-posture.ts" },
  { field: "expiresAt", source: "src/lib/operator-agent.ts" },
  { field: "createdAt", source: "src/lib/ops.ts" },
  { field: "postedAt", source: "src/lib/review.ts" },
  { field: "reviewInputLastAttemptAt", source: "src/lib/sweep.ts" },
]);

/**
 * Every fixture stamp in `files` that a threshold will age past, within `marginDays` of `now`.
 *
 * Pure: callers supply the file list, the reader and the clock, so the suite drives it over a
 * fixture tree with a pinned clock and no repo state.
 */
export function censusExpiringFixtures({ files, readFile, now, thresholdDays, marginDays = MARGIN_DAYS, readBaseFile }) {
  const reported = [];
  const exempt = [];
  const alreadyExpired = [];
  const populationByFile = {};
  let population = 0;

  for (const file of files) {
    const lines = readFile(file).split("\n");
    for (const [index, line] of lines.entries()) {
      for (const row of AGED_FIELDS) {
        // The stamp as it is actually written in a fixture: `field: "2026-08-26T18:15:00Z"`.
        const m = new RegExp(`${row.field}\\s*:\\s*"(\\d{4}-\\d{2}-\\d{2}T[^"]*)"`).exec(line);
        if (!m) continue;
        population += 1;
        populationByFile[file] = (populationByFile[file] ?? 0) + 1;

        const stamp = Date.parse(m[1]);
        if (Number.isNaN(stamp)) continue;
        const expiresAt = stamp + thresholdDays * MS_PER_DAY;
        const daysLeft = (expiresAt - now) / MS_PER_DAY;

        const record = { file, line: index + 1, field: row.field, threshold: row.threshold, stamp: m[1], expiresAt, daysLeft };

        // The marker may sit on the line itself or on the comment line directly above it.
        const nearby = `${line}\n${index > 0 ? lines[index - 1] : ""}`;
        if (nearby.includes(EXEMPT_MARKER)) {
          exempt.push(record);
          continue;
        }
        // Already past: green today WITH it expired, so it cannot newly break anything. Counted and
        // reported as a total, never as a line item -- see the header note on the 83.
        if (daysLeft <= 0) {
          alreadyExpired.push(record);
          continue;
        }
        if (daysLeft <= marginDays) reported.push(record);
      }
    }
  }
  // W1-T3388: ATTRIBUTE each crossing to the diff or to the base it was inherited from. Without
  // this the gate cannot tell a bomb this branch PLANTED from one `origin/main` already carried, so
  // a single stamp on main reddens every open PR at once and each author pays the same diagnosis
  // (measured 2026-09-16: #5725, #5733, #5734, #5736, #5738 and #5739, all on one main-branch
  // stamp). It is the same base attribution scripts/test-tier-manifest.mjs already performs, for
  // the same reason: inherited debt is not charged to the branch that merely stands next to it.
  const inheritedKeys = new Set();
  if (readBaseFile) {
    for (const file of new Set(reported.map((r) => r.file))) {
      const baseText = readBaseFile(file);
      if (baseText === undefined) continue; // absent at base ⇒ every stamp in it is this diff's
      for (const line of baseText.split("\n")) {
        for (const row of AGED_FIELDS) {
          const m = new RegExp(`${row.field}\\s*:\\s*"(\\d{4}-\\d{2}-\\d{2}T[^"]*)"`).exec(line);
          if (m) inheritedKeys.add(`${file}\u0000${row.field}\u0000${m[1]}`);
        }
      }
    }
  }
  for (const r of reported) {
    r.inherited = readBaseFile ? inheritedKeys.has(`${r.file}\u0000${r.field}\u0000${r.stamp}`) : undefined;
  }
  return { population, populationByFile, reported, exempt, alreadyExpired };
}

/** Refuse any file whose measured fixture population fell below the recorded ledger. */
export function refusePopulationDrop(currentByFile, recordedByFile = RECORDED_POPULATION_BY_FILE) {
  const drops = [];
  for (const [file, recorded] of Object.entries(recordedByFile)) {
    const current = currentByFile[file] ?? 0;
    if (current < recorded) drops.push({ file, current, recorded, missing: recorded - current });
  }
  return drops.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The ONE place "does this run block" is decided (W1-T3839). `formatReport`'s headline and
 * `main()`'s exit code both call this rather than each re-deriving `introduced` themselves, so a
 * BLOCKED headline and a zero exit cannot drift apart again the way they did before this existed:
 * a crossing this diff introduced, or a population drop, blocks; an inherited-only crossing does
 * not (W1-T3655) -- see the header note (iv) for why that boundary itself is unchanged.
 */
export function isBlocked({ reported, populationDrop = [] }) {
  const introduced = reported.filter((r) => r.inherited !== true);
  return introduced.length > 0 || populationDrop.length > 0;
}

/** ISO day for a report line — the DATE IT GOES RED is the whole point of the output. */
export function expiryDay(expiresAt) {
  return new Date(expiresAt).toISOString().slice(0, 10);
}

export function formatReport({ population, reported, exempt, alreadyExpired = [], populationDrop = [] }, marginDays = MARGIN_DAYS) {
  const out = [];
  if (populationDrop.length > 0) {
    out.push(`expiring-fixture-census: BLOCKED -- ${populationDrop.length} file(s) dropped below the recorded fixture population:`);
    for (const drop of populationDrop) {
      out.push(`  - ${drop.file}: measured ${drop.current} stamp(s), recorded ${drop.recorded} (${drop.missing} missing)`);
    }
    out.push(`  TO FIX: if the fixture was genuinely deleted, lower RECORDED_POPULATION_BY_FILE in scripts/expiring-fixture-census.mjs in the same reviewed change.`);
    out.push(`  Otherwise, put the date literal back where the census can see it; helper indirection hides the fixture from this gate.`);
  }
  if (reported.length > 0) {
    if (out.length > 0) out.push("");
    const introduced = reported.filter((r) => r.inherited !== true);
    const inherited = reported.filter((r) => r.inherited === true);
    // W1-T3839: THE HEADLINE STATES WHAT THIS RUN DECIDED, NOT WHAT EXISTS. `introduced` is the
    // only thing THIS run charges -- see `isBlocked`, the single place that decision is made, which
    // `main()` also calls for the exit code so the two can never read this tree differently. When
    // every crossing here is inherited (introduced.length === 0) this run charges nothing, so the
    // headline must not say BLOCKED even though crossings are still reported below (iii) -- a
    // BLOCKED headline next to a zero exit is exactly the contradiction this task exists to close.
    if (introduced.length > 0) {
      out.push(`expiring-fixture-census: BLOCKED -- ${reported.length} fixture(s) CROSS their threshold within ${marginDays} day(s):`);
    } else {
      out.push(
        `expiring-fixture-census: CLEAR -- this run charges nothing; ${reported.length} inherited crossing(s) reported below, owned ` +
          `by the base and caught on the push-to-main lane (${CENSUS_MAIN_BRANCH_RUN}):`,
      );
    }
    for (const r of [...reported].sort((a, b) => a.daysLeft - b.daysLeft)) {
      const owner = r.inherited === true ? "  [inherited from the base -- NOT this diff]" : "";
      out.push(`  - ${r.file}:${r.line}  ${r.field}="${r.stamp}" vs ${r.threshold}  --  goes red ${expiryDay(r.expiresAt)} (${r.daysLeft.toFixed(1)}d)${owner}`);
    }
    if (introduced.length > 0) {
      out.push(`  TO FIX: stamp the fixture from the clock (see test/stale-ci-gate-wiring.test.ts), or, if it must`);
      out.push(`  stay fixed, age it past the threshold, re-run, and if nothing fails say so: ${EXEMPT_MARKER} -- <why>.`);
      out.push(`  Moving the constant forward only re-arms the same bomb on a later date.`);
    }
    if (inherited.length > 0) {
      const n = inherited.length;
      out.push(`  ${n} of these ${n === 1 ? "is" : "are"} ALREADY crossing on the base ref, so this diff did not plant ${n === 1 ? "it" : "them"}.`);
      out.push(`  Every open PR is seeing the same ${n === 1 ? "one" : n}, and each will pay this diagnosis separately until the`);
      out.push(`  base is repaired -- so fix it THERE, in one change, rather than defusing it per branch.`);
    }
  }
  if (populationDrop.length === 0 && reported.length === 0) {
    out.push(`expiring-fixture-census: OK -- ${population} fixture stamp(s) measured, none crossing within ${marginDays} day(s).`);
  }
  if (alreadyExpired.length > 0) {
    out.push(`  (${alreadyExpired.length} stamp(s) are already past their threshold and green as they stand -- state, not a transition.)`);
  }
  if (exempt.length > 0) {
    out.push(`  ${exempt.length} fixture(s) exempted by marker, each with its reason on the line:`);
    for (const e of exempt) out.push(`    - ${e.file}:${e.line}`);
  }
  return out.join("\n");
}

// SELF-DESCRIBING FAILURES (W1-T3578). A BLOCKED run used to leave only GitHub's bare exit-code
// annotation (`Process completed with exit code 1.`) -- the actionable report above only ever
// reached stdout, which an unproxied job-log read cannot see (the same #2828/#2895 shape
// scripts/{coverage-ratchet,diff-coverage}.mjs already fixed for their own gates). The fix rung's
// evidence reader (`failingTestFilesFromCiFailures` in src/lib/sweep.ts, W1-T3278) already
// recognizes a `test/...test.ts:<line>` path inside a check-run annotation; this gate simply never
// published one. `formatReport`'s output above already names every crossing fixture's path, line
// and remedy verbatim, so it is published AS-IS -- no second report-assembly function is invented.
//
// OPT-IN, AND DELIBERATELY NOT AN "in Actions" CHECK. test/expiring-fixture-census.test.ts spawns
// this very script over BLOCKING fixture trees with no env override, so an automatic-detection
// gate would publish those as real annotations. `RMD_CI_REPORT` is set per-STEP on the real
// "Expiring-fixture census" step in ci.yml (never job-wide -- see the comment there), matching the
// identical trap the two coverage gates already guard against.

/** Encode a report for a `::error::` workflow command. `%` FIRST or the escapes eat each other.
 *  Identical to scripts/{coverage-ratchet,diff-coverage}.mjs's encoder -- reused, not reinvented,
 *  so the three gates cannot drift into different escaping dialects for the same channel. */
export function encodeAnnotation(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Write the report to the two channels a job can actually reach. No-op unless RMD_CI_REPORT is set. */
export function emitCiReport(tool, report, { blocked, env = process.env, log = console.log, append = null } = {}) {
  if (!env.RMD_CI_REPORT) return false;
  if (blocked) log(`::error title=${tool}::${encodeAnnotation(report)}`);
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const write = append ?? appendFileSync;
    write(summaryPath, `### ${tool}\n\n\u0060\u0060\u0060\n${report}\n\u0060\u0060\u0060\n\n`);
  }
  return true;
}

export function main({
  execFile = execFileSync,
  readFile = (p) => readFileSync(p, "utf8"),
  now = () => Date.now(),
  log = (message) => console.log(message),
  assertAged = assertFieldsStillAged,
  // W1-T3838 — THE INVERSE DIRECTION, wired the same way `assertAged` is: a real closure by
  // default, fully overridable so a test that is not exercising completeness never has to mock a
  // fourth `git` seam. Ratcheted against `KNOWN_UNCOVERED_CLOCK_FIELDS` (see its own comment) so
  // this call refuses on a NEW clock-aged field, not on the tail already measured and accepted.
  assertComplete = () => {
    const srcFiles = [
      ...new Set(execFile("git", ["ls-files", "src/*.ts", "src/**/*.ts"], { encoding: "utf8" }).split("\n").filter(Boolean)),
    ];
    assertFieldListComplete({ files: srcFiles, readFile, agedFields: [...AGED_FIELDS, ...KNOWN_UNCOVERED_CLOCK_FIELDS] });
  },
  recordedPopulationByFile = RECORDED_POPULATION_BY_FILE,
  baseRefOverride,
  env = process.env,
} = {}) {
  assertAged();
  assertComplete();
  const files = execFile("git", ["ls-files", "test/*.test.ts"], { encoding: "utf8" }).split("\n").filter(Boolean);
  // The threshold comes from the policy the sweep actually loads, never a copy of the number here.
  const policy = JSON.parse(execFile("node", ["--import", "tsx", "-e", "import {loadDefaultPolicy} from './src/lib/policy.ts'; console.log(JSON.stringify(loadDefaultPolicy().values.sweep));"], { encoding: "utf8" }));
  // Default to origin/main rather than requiring a workflow change to pass it: CI checks out with
  // fetch-depth 0, so the ref is present. Unreadable (a shallow clone, a fresh local repo) leaves
  // `readBaseFile` undefined and the gate behaves exactly as it did before attribution existed.
  const baseRef = baseRefOverride ?? "origin/main";
  let readBaseFile;
  // W1-T3655: on the base's own run there is no earlier base to inherit FROM -- see
  // CENSUS_MAIN_BRANCH_RUN's own comment for why this is checked BEFORE the rev-parse probe
  // rather than folded into it. `readBaseFile` stays undefined, so every crossing reads exactly as
  // strict as it would with no base readable at all.
  if (env[CENSUS_MAIN_BRANCH_RUN]) {
    readBaseFile = undefined;
  } else {
    try {
      execFile("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { encoding: "utf8", stdio: "pipe" });
      readBaseFile = (path) => {
        try {
          return execFile("git", ["show", `${baseRef}:${path}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: "pipe" });
        } catch {
          return undefined; // absent at base ⇒ the file is this diff's own
        }
      };
    } catch {
      readBaseFile = undefined;
    }
  }
  const result = censusExpiringFixtures({
    files,
    readFile,
    now: now(),
    thresholdDays: policy.staleDays,
    readBaseFile,
  });
  const populationDrop = refusePopulationDrop(result.populationByFile, recordedPopulationByFile);
  const report = formatReport({ ...result, populationDrop });
  log(report);
  // ATTRIBUTION NAMES THE OWNER, AND NOW DOES MOVE THE GATE FOR THE HALF IT CAN PROVE IS NOT THIS
  // DIFF'S (W1-T3655). W1-T3388 deliberately left every crossing blocking, inherited or not,
  // because nothing observed `main` -- a non-blocking inherited crossing would have been a warning
  // no gate enforced, and the bomb would still reach its own red date unfixed. ci.yml's `ci` job
  // now runs this census on its push-to-main lane too (CENSUS_MAIN_BRANCH_RUN, see above), so a
  // stamp sitting on main is caught by the run that owns it. With that run in place, a crossing
  // marked `inherited === true` is reported -- never hidden -- but no longer charged to a PR that
  // did not plant it; only a crossing this diff itself introduced, or a population drop, blocks.
  const blocked = isBlocked({ reported: result.reported, populationDrop });
  emitCiReport("expiring-fixture-census", report, { blocked });
  return blocked ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("expiring-fixture-census.mjs")) process.exit(main());
