import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { INSTRUMENT_SURFACE, INSTRUMENT_SURFACE_EXCLUSIONS, detectInstrumentEntanglement, judgeReview } from "../src/lib/review.js";

// ── W1-T402: "INSTRUMENT_SURFACE was hand-enumerated against one day's tree and missed the rule
// files of five REQUIRED jobs ... and the only thing asking anyone to re-check membership is a
// comment" (RECON guard-reach-2026-08-07). INSTRUMENT_SURFACE stays the DECLARED, sole BLOCKING
// authority (never touched here) — this file is the completeness ALARM the design's clause (ii)
// calls for: it derives candidate gate-rule paths from the LIVE TREE, the same way every run, and
// fails the moment a derived candidate is neither covered by INSTRUMENT_SURFACE nor excused by a
// REASONED entry in INSTRUMENT_SURFACE_EXCLUSIONS (review.ts). A bare exclusion (no reason, or a
// blank one) does not count — that would rebuild the exact silent gap this alarm exists to close.
// ──────────────────────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

// Extension alternation ordered LONGEST-FIRST and anchored at the token's end (`\b`). W1-T402's
// design recorded the trap directly: an alternation ordered `js` before `json` truncates
// `.jscpd.json` to `.jscpd.js` — untracked, and silently dropped by the tracked-file filter below
// — so the first hand-derivation reported the clearest instrument in the repo as underivable.
const EXT_RE = "(?:cjs|mjs|json|yaml|yml|ts|sh|js)";
const TOKEN_RE = new RegExp(`[A-Za-z0-9_./-]+\\.${EXT_RE}\\b`, "g");

/** Path-like tokens ending in a rule/config extension, in declaration order, longest-ext-first. */
function harvestTokens(text: string): string[] {
  return [...text.matchAll(TOKEN_RE)].map((m) => m[0].replace(/^\.\//, ""));
}

/** Under `src/`, `apps/`, `packages/`, or `test/` — the product/test halves, never a candidate. */
function isProductOrTestPath(path: string): boolean {
  return /^(src|apps|packages|test)\//.test(path);
}

/**
 * Derives candidate gate-rule paths from the live tree (W1-T402 design clause (i), "declared-
 * plus-derived"): harvest path-like tokens out of every workflow file plus package.json's
 * `scripts` values, restrict to tracked, non-product/non-test paths, then follow ONE level into
 * any harvested script's own source for the sibling config files it reads (this is how
 * `scripts/mutation-nightly-scope.json` — never itself named in a `run:` line, only reached via
 * `scripts/mutation-ratchet.mjs`'s own `join(__dirname, ...)` default) is recovered without an
 * unbounded, over-eager recursive harvest (the design's own rejected alternative — it pulled in
 * `src/run-task.ts` and `src/lib/review.ts`, which would fire this alarm on nearly every PR).
 */
function deriveInstrumentCandidates(): string[] {
  const tracked = new Set(git(["ls-files"]).split("\n").filter(Boolean));
  const workflowFiles = [...tracked].filter((f) => f.startsWith(".github/workflows/") && /\.ya?ml$/.test(f));

  const stageA = new Set<string>();
  for (const f of workflowFiles) {
    for (const t of harvestTokens(readFileSync(join(REPO_ROOT, f), "utf8"))) stageA.add(t);
  }
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  for (const t of harvestTokens(Object.values(pkg.scripts ?? {}).join("\n"))) stageA.add(t);

  const candidates = new Set([...stageA].filter((f) => tracked.has(f) && !isProductOrTestPath(f)));

  const STRING_LIT_RE = /["']([A-Za-z0-9_./-]+\.(?:json|ya?ml))["']/g;
  const scriptCandidates = [...candidates].filter((f) => /\.(mjs|cjs|ts|sh)$/.test(f));
  for (const s of scriptCandidates) {
    const abs = join(REPO_ROOT, s);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, "utf8");
    const dir = s.split("/").slice(0, -1).join("/");
    for (const m of src.matchAll(STRING_LIT_RE)) {
      const rel = m[1].replace(/^\.\//, "");
      for (const c of [rel, dir ? `${dir}/${rel}` : rel]) {
        if (tracked.has(c) && !isProductOrTestPath(c)) candidates.add(c);
      }
    }
  }
  return [...candidates].sort();
}

/**
 * THE ALARM ITSELF, pure: a derived candidate is unexplained when it matches neither
 * `declaredRe` (the BLOCKING authority) nor carries a non-blank reason in `exclusions`. Never
 * consults anything but its three arguments, so it is exercised directly against fabricated
 * fixtures below (proving the mechanism in isolation) and against the real tree's own derivation
 * (proving today's repo is clean) without duplicating the check's logic between the two.
 */
function findUnexplainedGaps(
  candidates: string[],
  declaredRe: RegExp,
  exclusions: Readonly<Record<string, string>>,
): string[] {
  return candidates.filter((c) => {
    if (declaredRe.test(c)) return false;
    const reason = exclusions[c];
    return typeof reason !== "string" || reason.trim().length === 0;
  });
}

const DECLARED_RE = new RegExp(INSTRUMENT_SURFACE.join("|"));

// ── the tokeniser trap, regression-pinned ───────────────────────────────────────────────────

test("harvestTokens: an extension alternation ordered longest-first never truncates .jscpd.json to .jscpd.js", () => {
  const tokens = harvestTokens("run: jscpd src --config .jscpd.json");
  assert.deepEqual(tokens, [".jscpd.json"]);
});

// ── acceptance claim 1: an uncovered, unexcused derived candidate is REPORTED ──────────────────

test("findUnexplainedGaps: a derived candidate with no declared coverage and no exclusion is reported, not silently passed", () => {
  const gaps = findUnexplainedGaps(["some/newly-added-gate.json"], DECLARED_RE, {});
  assert.deepEqual(gaps, ["some/newly-added-gate.json"]);
});

test("findUnexplainedGaps: a candidate already covered by the declared INSTRUMENT_SURFACE is never reported", () => {
  const gaps = findUnexplainedGaps([".github/workflows/ci.yml", "scripts/coverage-baseline.json"], DECLARED_RE, {});
  assert.deepEqual(gaps, []);
});

// ── acceptance claim 2: an exclusion is honoured ONLY when it carries a recorded reason ────────

test("findUnexplainedGaps: a bare exclusion (empty or whitespace-only reason) does not silence the alarm", () => {
  assert.deepEqual(findUnexplainedGaps(["x/gate.json"], DECLARED_RE, { "x/gate.json": "" }), ["x/gate.json"]);
  assert.deepEqual(findUnexplainedGaps(["x/gate.json"], DECLARED_RE, { "x/gate.json": "   " }), ["x/gate.json"]);
});

test("findUnexplainedGaps: an exclusion with an actual recorded reason silences the alarm", () => {
  const gaps = findUnexplainedGaps(["x/gate.json"], DECLARED_RE, { "x/gate.json": "not gate logic, verified" });
  assert.deepEqual(gaps, []);
});

test("INSTRUMENT_SURFACE_EXCLUSIONS: every real exclusion in review.ts carries a substantive, non-blank reason", () => {
  const entries = Object.entries(INSTRUMENT_SURFACE_EXCLUSIONS);
  assert.ok(entries.length > 10, "sanity: the real exclusion map is not empty/trivial");
  for (const [path, reason] of entries) {
    assert.equal(typeof reason, "string", `${path}: reason must be a string`);
    assert.ok(reason.trim().length >= 10, `${path}: reason "${reason}" is too short to be a real explanation`);
  }
});

test("W1-T2843: the entrypoint path trigger has a reasoned instrument-surface exclusion", () => {
  const reason = INSTRUMENT_SURFACE_EXCLUSIONS["deploy/entrypoint.sh"];
  assert.equal(typeof reason, "string", "the baked entrypoint must be classified explicitly");
  assert.match(reason, /container image asset/i);
  assert.match(reason, /push\.paths/);
  assert.match(reason, /not (?:CI )?gate(?:-rule)? logic/i);
});

// ── acceptance claim 3: the declared list is the SOLE blocking authority — the derivation/
// exclusions can never themselves refuse a PR, however wrong or incomplete they are ────────────

test("judgeReview: a diff touching a KNOWN, real instrument-surface gap (.jscpd.json, excused above pending a widening decision) plus a src/ file is NOT reported as entangled", () => {
  // .jscpd.json is a genuine gate-rule file (the jscpd-gate job's duplication threshold) that
  // INSTRUMENT_SURFACE_EXCLUSIONS records as a known gap with widening deliberately deferred
  // (W1-T402 design clause v). If the completeness alarm's derivation/exclusions fed the BLOCKING
  // verdict, this diff would wrongly refuse the PR the moment that exclusion looked wrong; instead
  // only INSTRUMENT_SURFACE decides, and .jscpd.json is not on it.
  assert.ok(
    ".jscpd.json" in INSTRUMENT_SURFACE_EXCLUSIONS,
    "fixture assumption: .jscpd.json is a recorded (excused) gap, not a made-up path",
  );
  const diff = `
diff --git a/.jscpd.json b/.jscpd.json
+++ b/.jscpd.json
@@
-  "threshold": 2
+  "threshold": 5
diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
+export function frobnicate() {}
`.trim();
  const v = judgeReview([{ claim: "the change is safe", proof: "widget frobnicate implemented" }], {
    diff,
    report: "REPORT\n- widget frobnicate implemented and verified.\nPR_URL: https://github.com/o/r/pull/1",
  });
  assert.equal(
    v.instrumentEntangled,
    false,
    "a derived-but-not-DECLARED gate-rule path must never trip the binding entanglement verdict",
  );
});

// ── the completeness check itself, run for real against the live tree ──────────────────────────

test("instrument-surface completeness: every gate-rule-like path this tree's own workflows/package.json reference is either declared or has a recorded, reasoned exclusion", () => {
  const candidates = deriveInstrumentCandidates();
  assert.ok(candidates.length > 15, "sanity: the derivation is actually finding real candidates, not running vacuously");

  const gaps = findUnexplainedGaps(candidates, DECLARED_RE, INSTRUMENT_SURFACE_EXCLUSIONS);
  assert.deepEqual(
    gaps,
    [],
    `derived candidate(s) neither in INSTRUMENT_SURFACE nor excused in INSTRUMENT_SURFACE_EXCLUSIONS ` +
      `(src/lib/review.ts): ${gaps.join(", ")} — a diff can touch these to change what a CI gate ` +
      `measures with nothing flagging it`,
  );
});

// ── AN INSTRUMENT PATH UNDER `src/` MUST BE EXPRESSIBLE ──────────────────────────────────────
//
// `isProductPath` is unconditionally `src/` and not `test/`, so before the subtraction in
// `detectInstrumentEntanglement` a `src/` file named by INSTRUMENT_SURFACE landed in BOTH the
// instrument set and the product set, and `entangled` was true on that ONE file plus a workflow.
// Adding any `src/` path to the surface could therefore never change a verdict — the exemption was
// inexpressible. These pin the fix in BOTH directions: it must become expressible, and it must not
// quietly neuter the rule, which is the failure shape a green suite would otherwise hide.

const WORKFLOW = ".github/workflows/ci.yml";
const RATCHET = "scripts/claude-md-budget-ratchet.mjs";

test("a workflow shipped beside genuine product code still entangles", () => {
  // THE FALSIFIER. If this ever reads false, the subtraction has disabled the rule rather than
  // narrowed it, and every other assertion here would still pass.
  const r = detectInstrumentEntanglement([WORKFLOW, RATCHET, "src/lib/dispatch-overlap.ts"]);
  assert.equal(r.entangled, true, "a real product path beside an instrument must still fail the PR");
  assert.deepEqual(r.srcPaths, ["src/lib/dispatch-overlap.ts"], "and the product path is named");
});

test("the reviewer's own module is never treated as an instrument", () => {
  // `src/lib/review.ts` is NOT on the surface, so it must still count as product — otherwise the
  // reviewer would be exempt from the rule it enforces.
  const r = detectInstrumentEntanglement([WORKFLOW, "src/lib/review.ts"]);
  assert.equal(r.entangled, true, "review.ts is product code and must stay subject to Rule 25");
  assert.ok(r.srcPaths.includes("src/lib/review.ts"));
});

test("a surface path under src is subtracted from the product set", () => {
  // THE EXEMPTION, EXPRESSIBLE. Driven with a path the LIVE surface already matches so the test
  // needs no hypothetical: a `-ratchet.mjs` under `src/` matches `^scripts/...` only from `scripts/`,
  // so this uses the surface's own membership test rather than inventing a pattern.
  const surfaced = INSTRUMENT_SURFACE.some((p) => new RegExp(p).test(RATCHET));
  assert.equal(surfaced, true, "control: the ratchet really is on the surface");
  const r = detectInstrumentEntanglement([WORKFLOW, RATCHET]);
  assert.equal(r.entangled, false, "an instrument-only diff is the sanctioned shape");
  assert.deepEqual(r.srcPaths, [], "and nothing instrument-shaped leaks into the product set");
});

test("a diff carrying no instrument path never entangles whatever else it holds", () => {
  const r = detectInstrumentEntanglement(["src/lib/dispatch-overlap.ts", "src/run-task.ts", "test/x.test.ts"]);
  assert.equal(r.entangled, false, "product-only is a sanctioned shape too");
  assert.deepEqual(r.instrumentPaths, [], "control: the instrument set really is empty here");
});
