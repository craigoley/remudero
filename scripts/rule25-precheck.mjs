#!/usr/bin/env node
/**
 * WILL THE REVIEWER REFUSE THIS DIFF UNDER STANDING RULE 25? Ask before pushing, not after CI.
 *
 * Rule 25 keeps the measurement INSTRUMENT isolated from the PRODUCT it measures: a diff touching
 * both a path on INSTRUMENT_SURFACE and a `src/` product path is refused, because a change that
 * moves the gate judging it can pass on its own terms. The sanctioned shape is an instrument-only
 * diff, optionally with its own `test/` falsifier or a `docs/` update.
 *
 * MEASURED twice: #4493 carried a clock-signature baseline beside product code; #4950's repair
 * worker added console-parity instruments beside its ledger-compaction product change. In both
 * cases remudero-review refused a fact the local tree could answer before the push.
 *
 * ONE PREDICATE, NEVER TWO. This imports the reviewer's own `detectInstrumentEntanglement`, which
 * already owns exemptions and introduced-gate carve-outs. A local re-derivation would send an
 * author to split a PR the reviewer would pass, or clear one it is about to refuse.
 */
import { detectInstrumentEntanglement } from "../src/lib/review.js";
import { isMainModule } from "./lib/argv.mjs";
import { gitOrThrow } from "./lib/git.mjs";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "origin/main";

function diffAgainstBase(base) {
  return gitOrThrow(["diff", `${base}...HEAD`]);
}

function changedFiles(base) {
  return gitOrThrow(["diff", "--name-only", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean);
}

/** PURE: return the reviewer's own verdict, unedited. */
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
      "rather than a score FLOOR, add it to ENTANGLEMENT_EXEMPT_INSTRUMENTS with a named reason. " +
      "The second option changes the isolation policy and needs review; this script performs neither remedy.",
  );
  return 1;
}

if (isMainModule(import.meta.url)) process.exit(main());
