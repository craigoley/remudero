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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { git as spawnGit } from "./lib/git.mjs";

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

/** Files the fold follow-up, returning its id, or `null` when it could not be written. IDEMPOTENT:
 *  an entry already on disk for this file at this size is reported as filed rather than duplicated,
 *  so a gate running on every CI job opens one entry, not one per run. */
export function fileFoldDebt(file, actualBytes, ceiling, violations, deps = {}) {
  const dir = deps.dir ?? "plan/feedback";
  const exists = deps.exists ?? existsSync;
  const write = deps.write ?? writeFileSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const id = foldDebtEntryId(file, actualBytes);
  const path = `${dir}/${id}.yaml`;
  try {
    if (exists(path)) return id;
    mkdir(dir, { recursive: true });
    write(path, renderFoldDebtEntry(id, file, actualBytes, ceiling, violations, nowIso));
    return id;
  } catch {
    // FAIL CLOSED, and the caller turns this into a refusal: losing the follow-up is the one
    // routing failure that must not land silently.
    return null;
  }
}

/** W1-T3320 — THE FOLD-DEBT CEILING: the point at which routing stops and the run really refuses.
 *
 * The cap is no longer where work stops; it is where the gate starts FILING. This is the bound that
 * keeps that from being unlimited — "we can always take on some tech debt" is only true while the
 * debt is collected, and 45 parked `verify: human` shards (W1-T3206) are what an uncollected queue
 * looks like. Absent from the baseline, routing is DISABLED and the gate behaves exactly as it did
 * before this task: a missing bound must never read as an infinite one. */
export function foldDebtCeiling(baseline) {
  const v = baseline.foldDebtCeilingBytes;
  if (v === undefined || v === null) return null;
  if (typeof v !== "number") throw new Error(`'foldDebtCeilingBytes' must be a number, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * W1-T3320 — DECIDE THE CONSEQUENCE OF A FINDING, never whether the finding holds.
 *
 * The violations are computed exactly as before by `evaluateRatchet`/`evaluateNetBytes`; this only
 * decides what happens next. Operator ruling, 2026-09-10: a gate repairs, routes, or closes, and a
 * stop is for harm rather than incompleteness. An over-budget doctrine file is incompleteness — the
 * rule is right, the fold has not happened yet — so it LANDS and the fold is FILED.
 *
 * `stop` is reached ONLY past the fold-debt ceiling, and that is the whole safety property: without
 * it this converts a loud refusal into an unbounded silent one, which is the same defect wearing
 * the fix's clothes.
 *
 * FAIL CLOSED, TWICE OVER: no violations means no decision to make, and a ceiling that is absent or
 * already exceeded returns `stop` — so a misconfigured baseline can only ever restore today's
 * strictness, never relax past it.
 */
export function decideBudgetConsequence(violations, actualBytes, ceiling) {
  if (violations.length === 0) return { outcome: "clean", violations };
  if (ceiling === null) return { outcome: "stop", violations, reason: "no foldDebtCeilingBytes declared — routing disabled" };
  if (actualBytes > ceiling) {
    return {
      outcome: "stop",
      violations,
      reason: `${actualBytes} bytes is past the fold-debt ceiling ${ceiling} — the debt was never collected`,
    };
  }
  return { outcome: "route", violations, ceiling, headroom: ceiling - actualBytes };
}

/** The deterministic id for one file's outstanding fold debt. IDEMPOTENT BY CONSTRUCTION: the same
 *  file at the same size re-files nothing, so a gate that runs on every CI job does not open a new
 *  entry per run — an inbox filling at CI's rate is not a follow-up, it is a denial of service. */
export function foldDebtEntryId(file, actualBytes) {
  return `fold-debt-${file.replace(/[^A-Za-z0-9]+/g, "-")}-${actualBytes}`;
}

/** The feedback entry a routed finding files. Plain YAML on purpose: this script is self-contained
 *  (no `src/` import, same convention as every scripts/*.mjs), and the daemon's own
 *  `feedback.landing_sweep` already collects `plan/feedback/*.yaml` — so routing needs no new
 *  plumbing and no second inbox. */
export function renderFoldDebtEntry(id, file, actualBytes, ceiling, violations, nowIso) {
  const lines = [
    `id: ${id}`,
    `ts: ${nowIso}`,
    "origin: gate",
    "status: new",
    "raw: >-",
    `  ${file} is over its size budget and the fold has not happened yet. The change that tripped this`,
    `  LANDED — this is the follow-up, not a refusal (W1-T3320, operator ruling 2026-09-10).`,
    `  Size ${actualBytes} bytes; fold-debt ceiling ${ceiling}; headroom ${ceiling - actualBytes}.`,
    ...violations.map((v) => `  FINDING: ${v.replace(/\s+/g, " ")}`),
    `  Cheapest destinations, in order: a rule naming ONE concrete repo path belongs in learnings/*.yaml,`,
    `  whose files: glob delivers it to the task that governs that path; a rule with no single governing`,
    `  path stays and something else folds. Do NOT raise the cap: at 43685 against 44000 a +315-byte`,
    `  change passes the cap and is still refused by the per-PR net rule, so a raise buys nothing.`,
  ];
  return `${lines.join("\n")}\n`;
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
  // NEVER `gitOrThrow` here: it trims stdout, and this reads a file's CONTENT for an exact
  // `Buffer.byteLength` measurement -- a trimmed trailing newline would silently undercount.
  const result = spawnGit(args, { stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
  }
  return result.stdout;
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
      // W1-T3320: WHERE THE FOLD FOLLOW-UP IS FILED. A flag rather than a constant because this gate
      // now WRITES, and its own suite spawns it against fixture files — without an override, a
      // fixture run over budget files a real entry into the repo's real inbox. MEASURED: two
      // entries landed in plan/feedback/ from a single test run before this existed.
      "feedback-dir": { type: "string", default: "plan/feedback" },
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
  // W1-T3320: THE FINDING IS UNCHANGED; ONLY THE CONSEQUENCE IS DECIDED HERE. Everything above still
  // measures and still prints both operands on every run — routing must not cost the accounting,
  // because a router that stops measuring has removed the budget rather than routed around it.
  const decision = decideBudgetConsequence(violations, actualBytes, foldDebtCeiling(baseline));

  if (decision.outcome === "route") {
    console.error(`claude-md-budget-ratchet: OVER BUDGET -- ${values.file} does not fit, and the change LANDS anyway:`);
    for (const v of violations) console.error(`  - ${v}`);
    const filed = fileFoldDebt(values.file, actualBytes, decision.ceiling, violations, { dir: values["feedback-dir"] });
    if (filed === null) {
      // A ROUTER THAT CANNOT FILE ITS OWN ROUTING IS THE ORIGINAL DEFECT WITH EXTRA STEPS: the
      // change would land and the fold would be remembered by nobody. That is the one routing
      // failure that must still refuse.
      console.error("claude-md-budget-ratchet: BLOCKED -- the fold follow-up could not be filed, so nothing recorded the debt.");
      process.exitCode = 1;
      return;
    }
    console.error(
      `  ROUTED: fold filed as ${filed} (headroom to the fold-debt ceiling: ${decision.headroom} bytes). ` +
        `The rule is not lost and the PR is not blocked.`,
    );
    return;
  }

  if (decision.outcome === "stop") {
    console.error(`claude-md-budget-ratchet: BLOCKED -- ${values.file} fails its size contract:`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(`  ${decision.reason}`);
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
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
