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
import { readFileSync } from "node:fs";

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

/**
 * Every fixture stamp in `files` that a threshold will age past, within `marginDays` of `now`.
 *
 * Pure: callers supply the file list, the reader and the clock, so the suite drives it over a
 * fixture tree with a pinned clock and no repo state.
 */
export function censusExpiringFixtures({ files, readFile, now, thresholdDays, marginDays = MARGIN_DAYS }) {
  const reported = [];
  const exempt = [];
  const alreadyExpired = [];
  let population = 0;

  for (const file of files) {
    const lines = readFile(file).split("\n");
    for (const [index, line] of lines.entries()) {
      for (const row of AGED_FIELDS) {
        // The stamp as it is actually written in a fixture: `field: "2026-08-26T18:15:00Z"`.
        const m = new RegExp(`${row.field}\\s*:\\s*"(\\d{4}-\\d{2}-\\d{2}T[^"]*)"`).exec(line);
        if (!m) continue;
        population += 1;

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
  return { population, reported, exempt, alreadyExpired };
}

/** ISO day for a report line — the DATE IT GOES RED is the whole point of the output. */
export function expiryDay(expiresAt) {
  return new Date(expiresAt).toISOString().slice(0, 10);
}

export function formatReport({ population, reported, exempt, alreadyExpired = [] }, marginDays = MARGIN_DAYS) {
  const out = [];
  if (reported.length > 0) {
    out.push(`expiring-fixture-census: BLOCKED -- ${reported.length} fixture(s) CROSS their threshold within ${marginDays} day(s):`);
    for (const r of [...reported].sort((a, b) => a.daysLeft - b.daysLeft)) {
      out.push(`  - ${r.file}:${r.line}  ${r.field}="${r.stamp}" vs ${r.threshold}  --  goes red ${expiryDay(r.expiresAt)} (${r.daysLeft.toFixed(1)}d)`);
    }
    out.push(`  TO FIX: stamp the fixture from the clock (see test/stale-ci-gate-wiring.test.ts), or, if it must`);
    out.push(`  stay fixed, age it past the threshold, re-run, and if nothing fails say so: ${EXEMPT_MARKER} -- <why>.`);
    out.push(`  Moving the constant forward only re-arms the same bomb on a later date.`);
  } else {
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

function main() {
  assertFieldsStillAged();
  const files = execFileSync("git", ["ls-files", "test/*.test.ts"], { encoding: "utf8" }).split("\n").filter(Boolean);
  // The threshold comes from the policy the sweep actually loads, never a copy of the number here.
  const policy = JSON.parse(execFileSync("node", ["--import", "tsx", "-e", "import {loadDefaultPolicy} from './src/lib/policy.ts'; console.log(JSON.stringify(loadDefaultPolicy().values.sweep));"], { encoding: "utf8" }));
  const result = censusExpiringFixtures({
    files,
    readFile: (p) => readFileSync(p, "utf8"),
    now: Date.now(),
    thresholdDays: policy.staleDays,
  });
  console.log(formatReport(result));
  process.exit(result.reported.length > 0 ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("expiring-fixture-census.mjs")) main();
