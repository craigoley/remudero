#!/usr/bin/env node
// scripts/claude-md-budget-ratchet.mjs
//
// CLAUDE.md SIZE AS A CI RATCHET (W1-T503, MASTER-PLAN §8A).
//
// CLAUDE.md is injected in FULL into every session on every lane -- its own header calls itself
// "a context tax paid per session" -- and until this ratchet it was the fleet's largest per-session
// injectable with no budget at all, while the learnings corpus at a fifth its weight already had a
// CI ceiling (scripts/learnings-budget-ratchet.mjs). Same ratchet shape as that sibling and as the
// coverage ratchet (scripts/coverage-ratchet.mjs): a byte-size CEILING. A PR that grows the file
// past the cap goes RED and names the overage in bytes; a healthy PR (at or under cap) exits clean.
//
// WHAT THE CAP IS FOR. This file is the WORKER PROMPT. It is injected in full on every run, so
// every byte in it is paid for in tokens by every lane, every time -- the cost is per-session and
// recurring, not one-off. The ratchet exists to make that growth DELIBERATE: a rule that earns its
// place gets added and the cap is raised on the record, while an unreviewed dump goes red. It is a
// forcing function for deliberation, never a prohibition on growth.
//
// THE CEILING CARRIED ZERO HEADROOM UNTIL 2026-08-22, AND NO LONGER DOES. It was originally set to
// the measured size at capture, on the charter's reasoning that every addition should be paid for
// by a fold ("compression is a deliverable, not just accretion"). THE OPERATOR RAISED IT ONCE, on
// 2026-08-22, to 65536 (64 KiB), after the file hit the cap with ONE BYTE of room TWICE THE SAME
// DAY and both lanes spent more effort folding prose than writing the rule they came to write. At
// that point the cheap folds were spent and the next one would have cost meaning rather than
// duplication. scripts/claude-md-budget-baseline.json's bumpRationale carries the full record.
//
// A LATER READER PROPOSING ANOTHER RAISE: this is the SECOND conversation about this number, not
// the first. "The folds are expensive now" is the argument that carried on 2026-08-22 and cannot
// carry a second time without new evidence -- say what changed. Never lower the cap to make a red
// PR pass, and never raise it just to silence this gate without folding, sharpening, or deleting
// something first.
//
// Unlike the learnings ratchet, there is no lifecycle/injectable-weight distinction to reproduce
// here -- CLAUDE.md is a single file injected verbatim, so the measured quantity is simply its raw
// byte length (`Buffer.length`, NOT `.length` on a decoded string -- multi-byte UTF-8 content must
// count its real injected weight, not its character count).
//
// This script is deliberately self-contained (no import from src/lib/*, which is TypeScript and
// outside plain `node scripts/*.mjs` execution) -- same convention as
// scripts/learnings-budget-ratchet.mjs and scripts/generate-learnings-index.mjs.
//
// Usage:
//   node scripts/claude-md-budget-ratchet.mjs [--file CLAUDE.md] [--baseline <path>]
//
// Defaults: --file CLAUDE.md, --baseline scripts/claude-md-budget-baseline.json
//
// The pure functions below (measureBytes, evaluateRatchet) are exported so the falsifier fixture
// test can exercise the CLI process directly (spawn + exit code) as well as the measurement/
// comparison logic in isolation, mirroring test/learnings-budget-ratchet.test.ts's convention.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/**
 * The injected weight of `path`, in BYTES (not characters) -- `readFileSync` with no encoding
 * returns a `Buffer`, whose `.length` is the raw byte count, so multi-byte UTF-8 content (e.g. an
 * em-dash) counts for its real injected weight instead of undercounting as one "character".
 */
export function measureBytes(path) {
  return readFileSync(path).length;
}

/**
 * Compare the measured byte size against a recorded cap.
 * @returns {string[]} human-readable violations; empty means the ratchet is satisfied.
 */
export function evaluateRatchet(actualBytes, baseline) {
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
    actualBytes = measureBytes(values.file);
  } catch (err) {
    console.error(`claude-md-budget-ratchet: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const baseline = JSON.parse(readFileSync(values.baseline, "utf8"));
  const violations = evaluateRatchet(actualBytes, baseline);

  console.log(
    `claude-md-budget-ratchet: ${values.file} is ${actualBytes} bytes (cap ${baseline.capBytes ?? "unset"} bytes)`,
  );

  if (violations.length > 0) {
    console.error(`claude-md-budget-ratchet: BLOCKED -- ${values.file} is over the recorded size budget:`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "  Fold, sharpen, or delete existing rules to bring it back under the cap, or -- if the growth is " +
        "deliberate and reviewed -- raise scripts/claude-md-budget-baseline.json's capBytes.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`claude-md-budget-ratchet: OK -- ${values.file} is at or under the size budget cap.`);
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/claude-md-budget-ratchet.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
