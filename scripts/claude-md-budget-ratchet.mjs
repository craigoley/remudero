#!/usr/bin/env node
// scripts/claude-md-budget-ratchet.mjs — CLAUDE.md size as a CI ratchet (W1-T503, MASTER-PLAN §8A).
//
// INVARIANT: CLAUDE.md is injected in full into every session, so its byte size is a recurring
//   per-session context tax. This gate refuses a file over scripts/claude-md-budget-baseline.json's
//   capBytes (measured as Buffer.length, the real UTF-8 weight, not a decoded string's character
//   count), and separately refuses a net-positive diff against the merge base (see evaluateNetBytes
//   below). Never lower the cap to pass a red PR, and never raise it without folding something
//   first — CLAUDE.md's own preamble already carried zero headroom once. Falsifiers:
//   test/claude-md-budget-ratchet.test.ts, test/a-net-positive-claude-md-diff-is-not-refused.test.ts.
// Self-contained (no src/ import): scripts/*.mjs runs outside tsconfig's TypeScript build, same
//   convention as scripts/learnings-budget-ratchet.mjs.
// A gate run from a checkout behind origin/main answers about a file and a cap that both moved,
//   silently — CLAUDE.md hazard (h). Always run this against a fresh origin/main.
//
// Usage: node scripts/claude-md-budget-ratchet.mjs [--file CLAUDE.md] [--baseline <path>]
// Defaults: --file CLAUDE.md, --baseline scripts/claude-md-budget-baseline.json
//
// Why: the cap's zero-headroom history and the 2026-08-22 raise are archived in
//   docs/forensics/claude-md-budget-ratchet.md#module-header.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** The injected weight of `path`, in bytes (not characters) — a raw `Buffer.length`, so multi-byte
 *  UTF-8 content counts its real injected weight instead of undercounting as one "character". */
export function measureBytes(path) {
  return readFileSync(path).length;
}

/**
 * Compares `actualBytes` against `baseline.capBytes`. `capBytes` absent is a legitimate "no cap
 * yet" and returns no violations. `capBytes` present but not a number (e.g. a hand-edit that
 * quotes the value) must REFUSE by throwing, not silently pass — a required check that cannot
 * read its own threshold must not report OK; the caller fails the run before printing anything
 * claiming to enforce a cap. Why: the malformed-cap incident is archived in
 * docs/forensics/claude-md-budget-ratchet.md#evaluateratchet.
 *
 * @returns {string[]} violations; empty means the ratchet is satisfied.
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
 * W1-T2831 — INVARIANT: the cap above and §8A are two different rules, and this file enforces
 * both from one run. The cap compares the file's total size; §8A asks that each CHANGE pay for
 * itself, which a total-size ceiling stays silent about for as long as headroom lasts. The
 * predicate is NET BYTES, not "added lines <= removed" — a byte count catches the in-place reword
 * a line count scores as a fold. Why: the 32-commit classification behind that choice is archived
 * in docs/forensics/claude-md-budget-ratchet.md#8a-vs-the-cap.
 */

/** The ref to diff against, with its provenance — a delta with no named operand is the stale-
 *  operand shape (CLAUDE.md hazard (h)). Prefers a live `git merge-base`; falls back to `BASE_SHA`
 *  (a GitHub event-payload snapshot, so a re-run replays a poisoned base rather than clearing it).
 *  Returns `null` with neither — a run on `main` itself, a shallow clone, or a detached head. */
export function resolveBaseRef(deps = {}) {
  const git = deps.git ?? defaultGit;
  const env = deps.env ?? process.env;
  const remote = deps.remoteRef ?? "origin/main";
  try {
    const ref = git(["merge-base", "HEAD", remote]).trim();
    if (ref) return { ref, source: `git merge-base HEAD ${remote}` };
  } catch {
    // Fall through to BASE_SHA — no tracking branch, shallow clone, or not a repo; unresolvable is a SKIP, not a refusal.
  }
  const fromEnv = (env.BASE_SHA ?? "").trim();
  if (fromEnv) return { ref: fromEnv, source: "BASE_SHA (event-payload snapshot; a re-run replays it)" };
  return null;
}

/** The byte size of `file` at `ref`, or `null` if the ref lacks that path — inventing 0 would
 *  report the whole file as growth on the commit that introduces it. */
export function measureBytesAtRef(file, ref, deps = {}) {
  const git = deps.git ?? defaultGit;
  try {
    return Buffer.byteLength(git(["show", `${ref}:${file}`]), "utf8");
  } catch {
    return null;
  }
}

/** The real git edge, kept separate from the pure logic above so a falsifier can drive every arm
 *  without a repo, and this default is still exercised by a test that really shells out — a seam
 *  every test fakes is a seam nothing covers. */
export function defaultGit(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * §8A as a predicate: a CLAUDE.md change must not be net-positive in bytes.
 *
 * INVARIANT: `baseBytes === null` (no resolvable base, or the base lacked the file — the arm
 *   SKIPS rather than inventing a comparand) and `delta <= 0` (a byte-neutral reword or a fold)
 *   are NOT violations; only `delta > 0` is. There is deliberately no override — no flag, env
 *   read, or per-PR exemption — because an escape hatch would be reached for on the first
 *   inconvenient PR. Why: the three-state reasoning is archived in
 *   docs/forensics/claude-md-budget-ratchet.md#evaluatenetbytes.
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
  // The net-byte arm runs in this SAME invocation, not a parallel script — a run that trips both
  // the cap and §8A reports both, in one list.
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
      // Both operands and the base's provenance print on every run, not only on a refusal — a
      // delta with no named comparand is the stale-operand shape.
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
    // The cap's remedy prints only for a cap violation — "raise the ceiling" would read as the
    // override §8A's design forbids. The net-byte violation carries its own remedy in its text.
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
