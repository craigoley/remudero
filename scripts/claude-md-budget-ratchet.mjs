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

import { execFileSync } from "node:child_process";
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
 *
 * `capBytes` ABSENT (undefined/null) is a legitimate, honest "no cap yet" contract and is left
 * alone -- the caller reports it as "cap unset" and exits 0. `capBytes` PRESENT but not a number
 * (e.g. a hand-edit that quotes the value, `"1000"` instead of `1000`) is a DIFFERENT thing: a
 * declared cap that cannot be compared against. That must REFUSE, not silently no-op -- a
 * required check that cannot determine its own threshold must not report OK. This throws rather
 * than returning a violation because it is a config defect, not a size-budget breach; the caller
 * is expected to catch it and fail the run before it prints anything claiming to enforce a cap.
 *
 * @returns {string[]} human-readable violations; empty means the ratchet is satisfied.
 * @throws {Error} if `capBytes` is present and not a number.
 */
export function evaluateRatchet(actualBytes, baseline) {
  const violations = [];
  if (baseline.capBytes !== undefined && baseline.capBytes !== null && typeof baseline.capBytes !== "number") {
    throw new Error(`'capBytes' must be a number, got ${JSON.stringify(baseline.capBytes)}`);
  }
  if (typeof baseline.capBytes === "number" && actualBytes > baseline.capBytes) {
    const overage = actualBytes - baseline.capBytes;
    violations.push(`CLAUDE.md is ${actualBytes} bytes > cap ${baseline.capBytes} bytes (${overage} bytes over)`);
  }
  return violations;
}

/**
 * W1-T2831 — THE CAP AND §8A ARE TWO DIFFERENT RULES, AND ONLY ONE OF THEM WAS ENFORCED.
 *
 * Everything above this line compares ONE number — the file's total size — against `capBytes`.
 * MASTER-PLAN §8A asks something else entirely: that each CHANGE pay for itself. A total-size
 * ceiling is silent about per-change discipline for as long as headroom lasts, and CLAUDE.md's own
 * preamble names what that means — a rule stated only in prose "can be violated silently and
 * repeatedly", and the fix is to make something refuse it rather than to sharpen the wording.
 *
 * MEASURED over 2026-08-14..2026-09-04, 32 commits touching CLAUDE.md. Only FOUR made the file
 * smaller. And the classification you reach for first is the wrong one:
 *
 *   by LINES:  5 add-with-no-deletion | 11 added <= removed | 16 partial
 *   by BYTES:  16 net additions       | 4 net folds         | 12 net-neutral rewrites
 *
 * Twelve are in-place rewrites a line count scores as folds — `22ba6cba` reads 27 added / 26
 * removed, and its first added and first removed lines are THE SAME SENTENCE REWORDED, for +14
 * bytes. So the gate compares BYTES on both sides or it enforces a different rule from the one it
 * claims.
 *
 * AND THE OBVIOUS PREDICATE IS WRONG. A gate refusing "an addition that carries no deletion" would
 * have PASSED ALL FOUR commits that consumed the live headroom — every one of them already deletes
 * something. That predicate is a proxy satisfied by exactly the failing cases: it would have
 * shipped a green gate and an unchanged trend. The predicate is NET BYTES.
 */

/** Resolve the ref to compare against, and say WHERE it came from — a gate that reports a delta
 *  without naming its two operands is the stale-operand shape (CLAUDE.md hazard (h)).
 *
 *  RUN-TIME RESOLUTION IS PREFERRED AND THE ENV VALUE IS THE DOCUMENTED FALLBACK. `BASE_SHA` is a
 *  GitHub EVENT-PAYLOAD SNAPSHOT: a re-run replays the same sha, so a poisoned base does not clear
 *  by re-running. `git merge-base` re-derives it against the tracking branch on every invocation.
 *  Returns `null` when neither path yields a ref — a run on `main` itself, a shallow clone, a
 *  detached head with no tracking branch. */
export function resolveBaseRef(deps = {}) {
  const git = deps.git ?? defaultGit;
  const env = deps.env ?? process.env;
  const remote = deps.remoteRef ?? "origin/main";
  try {
    const ref = git(["merge-base", "HEAD", remote]).trim();
    if (ref) return { ref, source: `git merge-base HEAD ${remote}` };
  } catch {
    // No tracking branch, a shallow clone, or not a repo at all: fall through to the env value.
    // Kept as a fall-through rather than a refusal — an unresolvable base is a SKIP, not a block.
  }
  const fromEnv = (env.BASE_SHA ?? "").trim();
  if (fromEnv) return { ref: fromEnv, source: "BASE_SHA (event-payload snapshot; a re-run replays it)" };
  return null;
}

/** The byte size of `file` AT `ref`, or `null` when the ref does not carry that path — a file the
 *  base did not have is not a comparand, and inventing 0 for it would report the whole file as
 *  growth on the commit that introduces it. */
export function measureBytesAtRef(file, ref, deps = {}) {
  const git = deps.git ?? defaultGit;
  try {
    return Buffer.byteLength(git(["show", `${ref}:${file}`]), "utf8");
  } catch {
    return null;
  }
}

/** The real git edge. Separate from the pure logic above so a falsifier can drive every arm
 *  without a repo, AND so this default is itself exercised by a test that really shells out —
 *  a seam every test fakes is a seam nothing covers. */
export function defaultGit(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * §8A AS A PREDICATE: a CLAUDE.md change must not be net-positive in bytes.
 *
 * THREE STATES ARE NOT VIOLATIONS, and each is reachable:
 *   - `baseBytes === null` — no resolvable base, or the base did not carry the file. The arm is
 *     SKIPPED with a stated reason. A check that cannot determine its own comparand must not claim
 *     to have enforced one, which is the posture `capBytes: null` already establishes above.
 *   - delta === 0 — the in-place reword, the twelve-commit shape the measurement found.
 *   - delta < 0 — a fold. A gate that refuses a sharpening is worse than no gate, because the
 *     sharpening is the behaviour §8A is trying to buy.
 *
 * THERE IS NO OVERRIDE, AND THAT IS A DESIGN CONSTRAINT RATHER THAN AN OMISSION. No `--allow-growth`,
 * no env bypass, no commit-message trailer, no per-PR exemption list: an escape hatch would be
 * reached for on the first inconvenient PR and the rule returns to prose with extra steps. If a
 * rule genuinely earns its bytes, the author folds first or files a compression task first — that
 * IS the discipline §8A names.
 */
export function evaluateNetBytes(headBytes, baseBytes, operands = {}) {
  if (baseBytes === null || baseBytes === undefined) return [];
  const delta = headBytes - baseBytes;
  if (delta <= 0) return [];
  const baseOperand =
    operands.baseRef === undefined
      ? `base ${baseBytes}`
      : `base ${baseBytes} at ${operands.baseRef}${operands.baseSource ? ` via ${operands.baseSource}` : ""}`;
  const headOperand =
    operands.headLabel === undefined ? `head ${headBytes}` : `head ${headBytes} at ${operands.headLabel}`;
  return [
    `CLAUDE.md grew by ${delta} bytes (${baseOperand} -> ${headOperand}) — MASTER-PLAN §8A: ` +
      `compression is a deliverable, not just accretion. Fold, sharpen or migrate something out in ` +
      `the SAME change so the diff is byte-neutral or smaller. Content that names a concrete repo ` +
      `path belongs in learnings/*.yaml, whose files: glob delivers it to the task that governs it.`,
  ];
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

  let capViolations;
  try {
    capViolations = evaluateRatchet(actualBytes, baseline);
  } catch (err) {
    // Refuse before printing anything about a cap -- a run that cannot determine its threshold
    // must never print "cap <n> bytes" as if it were enforcing one.
    console.error(`claude-md-budget-ratchet: ${values.baseline}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `claude-md-budget-ratchet: ${values.file} is ${actualBytes} bytes (cap ${baseline.capBytes ?? "unset"} bytes)`,
  );

  let netViolations = [];
  // W1-T2831 — THE NET-BYTE ARM, on the SAME invocation. Not a parallel checker: a second script
  // with its own notion of the same budget is a second thing to keep in step, and this repo has
  // already measured what happens when one predicate exists in two copies. A run that trips both
  // the cap and §8A reports both, in one list, and CI needs no new job.
  const base = resolveBaseRef();
  if (base === null) {
    console.log("claude-md-budget-ratchet: base unresolved, net-byte check skipped (no merge-base and no BASE_SHA)");
  } else {
    const baseBytes = measureBytesAtRef(values.file, base.ref, {});
    if (baseBytes === null) {
      console.log(
        `claude-md-budget-ratchet: base ${base.ref} does not carry ${values.file}, net-byte check skipped ` +
          `(via ${base.source})`,
      );
    } else {
      // BOTH OPERANDS AND THE BASE'S PROVENANCE, on every run and not only on a refusal — a delta
      // reported without naming what it was taken against is the stale-operand shape.
      console.log(
        `claude-md-budget-ratchet: net bytes ${actualBytes - baseBytes} (base ${baseBytes} at ${base.ref} ` +
          `via ${base.source} -> head ${actualBytes})`,
      );
      netViolations = evaluateNetBytes(actualBytes, baseBytes, {
        baseRef: base.ref,
        baseSource: base.source,
        headLabel: "working tree",
      });
    }
  }

  const violations = [...capViolations, ...netViolations];
  if (violations.length > 0) {
    console.error(`claude-md-budget-ratchet: BLOCKED -- ${values.file} fails its size contract:`);
    for (const v of violations) console.error(`  - ${v}`);
    // THE CAP'S REMEDY IS PRINTED ONLY FOR A CAP VIOLATION. It names raising capBytes, which for a
    // NET-BYTE refusal would read as the override §8A's whole design forbids — "raise the ceiling"
    // is not an answer to "this change did not pay for itself". The net-byte violation carries its
    // own remedy in its own text, and that remedy is fold, sharpen or migrate.
    if (capViolations.length > 0) {
      console.error(
        "  Fold, sharpen, or delete existing rules to bring it back under the cap, or -- if the growth is " +
          "deliberate and reviewed -- raise scripts/claude-md-budget-baseline.json's capBytes.",
      );
    }
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
