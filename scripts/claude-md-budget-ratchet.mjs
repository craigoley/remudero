#!/usr/bin/env node
// scripts/claude-md-budget-ratchet.mjs
//
// CLAUDE.md BUDGET AS A CI RATCHET (W1-T503).
//
// CLAUDE.md is injected in full into every session on every lane -- its own header calls itself
// "a context tax paid per session" -- and until this instrument landed it was the fleet's
// LARGEST per-session injectable and the only one without a budget, while the learnings corpus
// (which CLAUDE.md itself names as where knowledge actually lives, and which is roughly a fifth
// CLAUDE.md's weight) already carries a CI ceiling: scripts/learnings-budget-ratchet.mjs. This
// script is that same CEILING instrument, mirrored onto CLAUDE.md: a PR that grows the file past
// the recorded cap in scripts/claude-md-budget-baseline.json goes CI-red and names the overage in
// bytes; a healthy PR (at or under cap) exits clean. Raising the cap is a deliberate, reviewed
// change (like the coverage floor and the learnings cap) -- never lower it to make a red PR pass.
//
// UNLIKE the learnings baseline, THE CAP CARRIES NO HEADROOM. The learnings baseline carries
// headroom for near-term retro growth because retros APPEND there by design. CLAUDE.md's own
// charter is the opposite -- "compression is a deliverable, not just accretion: a retro that adds
// a rule must also fold, sharpen, or delete the ones it supersedes" -- so the cap is the measured
// figure at capture, with zero headroom: a PR that grows CLAUDE.md goes red until the same PR
// folds something back out, or a reviewed cap raise says why growth is right this time.
//
// Measured in BYTES, not characters (unlike the learnings ratchet's char-based injectable-line
// sum) -- CLAUDE.md is injected as a single file, so its on-disk byte length IS the injectable
// weight; there is no per-entry rendering step to reproduce.
//
// This script is deliberately self-contained (no import from src/, plain `node scripts/*.mjs`
// execution -- same convention as scripts/learnings-budget-ratchet.mjs and
// scripts/coverage-ratchet.mjs).
//
// Usage:
//   node scripts/claude-md-budget-ratchet.mjs [--file CLAUDE.md] [--baseline <path>]
//
// Defaults: --file CLAUDE.md, --baseline scripts/claude-md-budget-baseline.json
//
// The pure functions below (measure, evaluate) are exported so the falsifier fixture test can
// exercise the CLI process directly (spawn + exit code) as well as the measurement/comparison
// logic in isolation -- the same split scripts/learnings-budget-ratchet.mjs's
// computeActiveChars/evaluateRatchet pair uses.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/**
 * Measure a file's INJECTABLE weight in bytes -- its raw on-disk byte length, exactly what a
 * per-session injection costs. Reads without an encoding (a Buffer, not a string) so multi-byte
 * UTF-8 characters count as the bytes they actually are, not as one JS string code unit each.
 */
export function measure(path) {
  return readFileSync(path).length;
}

/**
 * Compare the measured byte size against a recorded cap.
 * @returns {string[]} human-readable violations; empty means the ratchet is satisfied.
 */
export function evaluate(actualBytes, baseline) {
  const violations = [];
  if (typeof baseline.capBytes === "number" && actualBytes > baseline.capBytes) {
    const overage = actualBytes - baseline.capBytes;
    violations.push(`CLAUDE.md is ${actualBytes} bytes > cap ${baseline.capBytes} bytes (${overage} bytes over)`);
  }
  return violations;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string", default: "CLAUDE.md" },
      baseline: { type: "string", default: "scripts/claude-md-budget-baseline.json" },
    },
  });

  let actualBytes;
  try {
    actualBytes = measure(values.file);
  } catch (err) {
    console.error(`claude-md-budget-ratchet: could not read ${values.file}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const baseline = JSON.parse(readFileSync(values.baseline, "utf8"));
  const violations = evaluate(actualBytes, baseline);

  console.log(`claude-md-budget-ratchet: ${values.file} is ${actualBytes} bytes (cap ${baseline.capBytes ?? "unset"} bytes)`);

  if (violations.length > 0) {
    console.error("claude-md-budget-ratchet: BLOCKED -- the file is over the recorded budget:");
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "  Fold, sharpen, or delete existing rules to bring the file back under the cap, or -- if the growth is " +
        "deliberate and reviewed -- raise scripts/claude-md-budget-baseline.json's capBytes.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("claude-md-budget-ratchet: OK -- the file is at or under the recorded budget cap.");
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/claude-md-budget-ratchet.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
