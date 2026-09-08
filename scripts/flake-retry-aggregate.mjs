#!/usr/bin/env node
// scripts/flake-retry-aggregate.mjs — per-test flake-retry counts across one CI run (W1-T2904).
//
// WHY: scripts/test-with-retry.mjs's `recordFlakeEvidence` already prints ONE greppable line per
// retried attempt — `FLAKE-RETRY: <headline> — <names>` — to stdout (and, in CI, appends it to
// $GITHUB_STEP_SUMMARY), but nothing ever COLLECTS those lines, so the fleet cannot say which
// test costs the most re-runs: today it is one line per shard's own log, read by a human or not
// at all. This script reads any number of log files carrying those lines (typically one per
// `ci` shard's own FLAKE-RETRY evidence, staged by ci.yml into $RUNNER_TEMP outside the tracked
// tree) and prints a per-test count, most-retried first.
//
// A test flaking on pass 1 AND flaking again on its own retry is counted TWICE — deliberately:
// the question this answers is "which test costs the fleet the most re-runs," not merely "which
// test is EVER unstable," and a test that fails its retry too costs strictly more than one that
// heals on the first try.
//
// Best-effort by design, matching test-with-retry.mjs's own posture: a line that does not match
// the exact shape recordFlakeEvidence emits is ignored rather than throwing, and a missing/
// unreadable input file contributes nothing rather than failing the whole aggregation — this
// runs as an INFORMATIONAL step in ci.yml's `ci-required` aggregator job and must never itself
// flip a required check's verdict.
//
// Why: recon-2026-09-05 R-45 ("nothing aggregates its FLAKE-RETRY lines") — plan/tasks.d/
// W1-T2904-*.yaml.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FLAKE_RETRY_LINE_RE = /^FLAKE-RETRY: (.+?) — (.+)$/;
export const NO_NAME_PLACEHOLDER = "(no test name parsed from output)";

/** One `FLAKE-RETRY:` line -> `{ headline, names[] }`, or `null` when `line` does not match the
 *  exact shape scripts/test-with-retry.mjs's `recordFlakeEvidence` emits. The placeholder name
 *  (an unparsed first attempt) yields an EMPTY `names` array — real evidence a retry happened,
 *  with no per-test row to credit it to. */
export function parseFlakeRetryLine(line) {
  const m = FLAKE_RETRY_LINE_RE.exec(line.trimEnd());
  if (!m) return null;
  const [, headline, label] = m;
  if (label === NO_NAME_PLACEHOLDER) return { headline, names: [] };
  const names = label
    .split(", ")
    .map((s) => s.trim())
    .filter(Boolean);
  return { headline, names };
}

/** Every `FLAKE-RETRY:` line in `text` (any other line ignored), counted per test name across
 *  every headline ("first attempt failed", "retry ALSO failed", "declined retry …",
 *  "tracked-tree dirt") — see the file header for why a double-flake counts twice. Rows are
 *  sorted by count desc, then name asc, for a deterministic report; `unnamedCount` tallies lines
 *  whose label was the "no test name parsed" placeholder. */
export function aggregateFlakeRetries(text) {
  const counts = new Map();
  let unnamedCount = 0;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseFlakeRetryLine(line);
    if (!parsed) continue;
    if (parsed.names.length === 0) {
      unnamedCount += 1;
      continue;
    }
    for (const name of parsed.names) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const rows = [...counts.entries()]
    .map(([test, count]) => ({ test, count }))
    .sort((a, b) => b.count - a.count || a.test.localeCompare(b.test));
  return { rows, unnamedCount };
}

/** The human-readable report `main` prints — a table, most-retried test first, or one line
 *  saying no retries were recorded at all. */
export function formatReport({ rows, unnamedCount }) {
  if (rows.length === 0 && unnamedCount === 0) {
    return "flake-retry-aggregate: no FLAKE-RETRY lines found in any input — no run retried.";
  }
  const lines = ["flake-retry-aggregate: per-test retry counts (most-retried first)"];
  for (const { test, count } of rows) lines.push(`  ${count}\t${test}`);
  if (unnamedCount > 0) lines.push(`  ${unnamedCount}\t${NO_NAME_PLACEHOLDER}`);
  return lines.join("\n");
}

/** Reads every path in `paths`, concatenated with a separating newline. A path that does not
 *  exist or cannot be read (a shard that recorded nothing, an unexpanded shell glob with no
 *  matches) contributes an empty string rather than throwing — this tool is informational and
 *  must never fail a required check over a shard with no evidence to give. */
function readInputs(paths, readFile) {
  return paths
    .map((p) => {
      try {
        return readFile(p, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

export function main(argv, { readFile = readFileSync } = {}) {
  if (argv.length === 0) {
    console.error("usage: flake-retry-aggregate.mjs <flake-retry-log-path>...");
    return 2;
  }
  console.log(formatReport(aggregateFlakeRetries(readInputs(argv, readFile))));
  return 0;
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
