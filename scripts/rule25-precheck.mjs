#!/usr/bin/env node
/**
 * WILL THE REVIEWER REFUSE THIS DIFF UNDER STANDING RULE 25? Ask before pushing, not after CI.
 *
 * Rule 25 keeps the measurement INSTRUMENT isolated from the PRODUCT it measures: a diff touching
 * both a path on {@link INSTRUMENT_SURFACE} and a `src/` product path is refused, because a change
 * that moves the gate judging it can pass on its own terms. The sanctioned shape is an
 * instrument-only diff, optionally with its own `test/` falsifier or a `docs/` update.
 *
 * MEASURED 2026-09-07: #4493 carried a NEW `scripts/*-baseline.json` beside `src/lib/clock.ts` and
 * `src/lib/daemon.ts`. `remudero-review` refused it as `entangled`, and because that refusal lands
 * as a commit STATUS rather than a check run, the pull request read as green-but-stuck on the board
 * for an hour before anyone asked the commit for its status. The whole cycle was spent discovering
 * a fact the local tree could have answered in milliseconds.
 *
 * ONE PREDICATE, NEVER TWO — the same discipline `rule15-precheck.mjs` states beside it. This
 * imports the reviewer's OWN `detectInstrumentEntanglement`, which already subtracts
 * `ENTANGLEMENT_EXEMPT_INSTRUMENTS` and already applies W1-T2521's introduced-census-gate carve-out.
 * A local re-derivation would send an author to split a PR the reviewer would have passed.
 *
 */

/**
 * THE `diff` IS PASSED, NOT JUST THE FILE LIST, and that is load-bearing: with it the detector
 * requires the `src/` half to carry EXECUTABLE content and can apply the introduced-gate carve-out.
 * Passing paths alone would report entanglement on diffs the gate itself clears.
 *
 * REPORTS, NEVER REWRITES. Which half moves to its own PR is the author's call, and the remedy is
 * not always a split: a baseline that is a per-file LEDGER rather than a score FLOOR belongs in
 * `ENTANGLEMENT_EXEMPT_INSTRUMENTS` with a named reason, which is a reviewed decision and not one a
 * script may take. Both remedies are printed; neither is performed.
 */
import { execFileSync } from "node:child_process";
import { detectInstrumentEntanglement } from "../src/lib/review.js";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "origin/main";

function diffAgainstBase(base) {
  // Three-dot: the merge base, so a moving base never makes another branch's work read as this
  // diff's — the same boundary rule15-precheck and every ratchet here measure against.
  return execFileSync("git", ["diff", `${base}...HEAD`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function changedFiles(base) {
  return execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/** PURE: the reviewer's own verdict, unedited. Exported so its falsifier needs no git fixture. */
export function judgeRule25(diff, files) {
  const verdict = detectInstrumentEntanglement(files, diff);
  if (!verdict.entangled) {
    return { ok: true, reason: "no instrument path rides with a src/ product path", ...verdict };
  }
  return { ok: false, ...verdict };
}

function main() {
  let diff;
  let files;
  try {
    diff = diffAgainstBase(BASE);
    files = changedFiles(BASE);
  } catch (e) {
    // An unreadable diff is NOT a pass. Reporting clean here would be the vacuous-pass shape this
    // repo already names: a check that could not look, saying it found nothing.
    console.error(`rule25-precheck: could not read the diff against ${BASE} (${e.message}) — REFUSING to report clean`);
    return 2;
  }
  const verdict = judgeRule25(diff, files);
  if (verdict.ok) {
    console.log(`rule25-precheck: OK -- ${verdict.reason}`);
    return 0;
  }
  console.error(
    "rule25-precheck: THIS DIFF WILL BE REFUSED under Standing rule 25 -- it changes a measurement " +
      "INSTRUMENT and src/ PRODUCT code together, and remudero-review refuses that combination.",
  );
  console.error(`  instrument path(s): ${verdict.instrumentPaths.join(", ")}`);
  console.error(`  src/ product path(s): ${verdict.srcPaths.join(", ")}`);
  console.error(
    "  TO FIX, either: (1) split -- land the instrument alone (its own test/ falsifier and docs/ " +
      "may ride with it), then the product change; or (2) if the instrument is a per-file LEDGER " +
      "rather than a score FLOOR -- raising a row records debt and cannot make a failing falsifier " +
      "pass -- it belongs in ENTANGLEMENT_EXEMPT_INSTRUMENTS with a named reason, which is a " +
      "reviewed decision. Deciding now costs one command; after the push it costs a full CI cycle, " +
      "and the refusal lands as a commit STATUS that reads as green-but-stuck on the board.",
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
