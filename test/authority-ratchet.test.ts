// test/authority-ratchet.test.ts — W1-T2695: a new external write that names no gate fails CI
// by name.
//
// THE POPULATION, re-derived from source rather than carried from the filing rationale (which
// names src/lib/open-prs-rest.ts + src/lib/github-app.ts as "the gateway modules" — measured at
// this task's own HEAD, open-prs-rest.ts is REST-read-only by its own module header and contains
// zero write-verb argv, and github-app.ts contains exactly one, an internal token-exchange POST;
// neither is where armAutoMerge/openPlanPr/postReviewStatus/the escalation issue-filer/any push
// actually live). The real, mechanically-enumerable surface, run over every tracked
// `src/**/*.ts` file (excluding this ratchet's own two production modules) is FOUR detectable
// shapes:
//   (a) `assertLiveWriteAllowed("<boundary>", ...)` — the live-write guard's own closed
//       enumeration (lib/live-write-guard.ts), covering git-push/gh-pr-create/gh-pr-merge/
//       gh-pr-update-branch/gh-issue-create.
//   (b) a `gh api` REST call carrying an explicit non-GET verb: `"-X", "POST"|"PATCH"|"PUT"|
//       "DELETE"`.
//   (c) a `gh` subcommand argv literal known to write: `["pr"|"issue", "create"|"merge"|
//       "comment"|"close"]`.
//   (d) a raw `git push` argv literal: `["push", ...]`.
// Measured at this task's own HEAD: 14 files. AUTHORITY_TABLE (src/lib/authority.ts) names all
// 14 by `module`. The baseline is empty — this ratchet requires every detected file to be NAMED,
// never counted against an allowance, so a file entering the tree tomorrow with a brand-new
// write and no table row fails immediately, by name.
//
// GRANULARITY: per FILE, not per call site or boundary. A second write added to an
// ALREADY-tabled file does not independently trip this gate (same trade-off
// test/negative-reachability-ratchet.test.ts's own doc makes for its two surfaces: a named,
// mechanical, file-level census, not a parser). AUTHORITY_TABLE itself carries multiple rows per
// rich file for the report's own sake; this ratchet only requires at least one.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AUTHORITY_TABLE, authorityTableModules } from "../src/lib/authority.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// This ratchet's own two production modules are excluded: authority.ts's `AUTHORITY_TABLE`
// literal itself contains the strings this detector scans for (as data, in row `action`/`note`
// fields, e.g. "gh pr create"), and live-write-guard.ts is the guard's OWN definition site
// (`assertLiveWriteAllowed(` appears there as the function declaration, not a call).
const EXCLUDED_MODULES = new Set(["src/lib/authority.ts", "src/lib/live-write-guard.ts"]);

const SRC_TS_RE = /^src\/.*\.ts$/;

function trackedSrcFiles(): string[] {
  return execFileSync("git", ["-C", REPO_ROOT, "ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((p) => SRC_TS_RE.test(p) && !EXCLUDED_MODULES.has(p));
}

const ASSERT_LIVE_WRITE_RE = /assertLiveWriteAllowed\(\s*"([a-z-]+)"/g;
const GH_VERB_RE = /"-X"\s*,\s*"(POST|PATCH|PUT|DELETE)"/;
const GH_SUBCOMMAND_RE = /\[\s*"(pr|issue)"\s*,\s*"(create|merge|comment|close)"/;
const GIT_PUSH_ARGV_RE = /\[\s*"push"/;

/** Every reason this ratchet flagged `file`, e.g. `["assertLiveWriteAllowed:git-push", "gh-subcommand:pr:create"]`. */
function detectExternalWrites(file: string): string[] {
  const text = readFileSync(join(REPO_ROOT, file), "utf8");
  const reasons: string[] = [];
  for (const m of text.matchAll(ASSERT_LIVE_WRITE_RE)) reasons.push(`assertLiveWriteAllowed:${m[1]}`);
  const verbMatch = GH_VERB_RE.exec(text);
  if (verbMatch) reasons.push(`gh-verb:${verbMatch[1]}`);
  const subMatch = GH_SUBCOMMAND_RE.exec(text);
  if (subMatch) reasons.push(`gh-subcommand:${subMatch[1]}:${subMatch[2]}`);
  if (GIT_PUSH_ARGV_RE.test(text)) reasons.push("git-push-argv");
  return reasons;
}

function filesWithExternalWrites(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of trackedSrcFiles()) {
    const reasons = detectExternalWrites(file);
    if (reasons.length > 0) found.set(file, reasons);
  }
  return found;
}

// ── non-vacuity, first (the census pattern this house's other ratchets pin) ────────────────────

test("the detector is non-vacuous: it finds a real, known population at this HEAD", () => {
  const detected = filesWithExternalWrites();
  assert.ok(detected.size >= 10, `expected at least 10 files with a detectable external write, found ${detected.size}`);
  for (const known of ["src/run-task.ts", "src/lib/git-push.ts", "src/lib/escalate.ts", "src/lib/review.ts"]) {
    assert.ok(detected.has(known), `expected the detector to flag ${known}`);
  }
});

// ── the ratchet itself ───────────────────────────────────────────────────────────────────────

test("every tracked src file with a detectable external write is named in AUTHORITY_TABLE by module", () => {
  const detected = filesWithExternalWrites();
  const tabled = authorityTableModules();
  const missing = [...detected.keys()].filter((f) => !tabled.has(f));
  assert.deepEqual(
    missing,
    [],
    `AUTHORITY_TABLE (src/lib/authority.ts) is missing a row for: ${missing
      .map((f) => `${f} (${JSON.stringify(detected.get(f))})`)
      .join(", ")} — a new external write must name its gate before it can merge`,
  );
});

test("every AUTHORITY_TABLE row's module is a real tracked src file, not a stale or mistyped path", () => {
  const tracked = new Set(trackedSrcFiles().concat([...EXCLUDED_MODULES]));
  for (const row of AUTHORITY_TABLE) {
    assert.ok(tracked.has(row.module), `AUTHORITY_TABLE row "${row.id}" names module "${row.module}", which is not a tracked src file`);
  }
});

// ── the falsifier: prove the detector actually catches an ungated write, not merely that it is
// silent today (the same "prove the unhealthy arm" discipline
// test/negative-reachability-ratchet.test.ts's own header names as the defect five prior
// instruments shared) ────────────────────────────────────────────────────────────────────────

test("FALSIFIER: each detector shape matches its own known-write fixture text", () => {
  assert.match('assertLiveWriteAllowed("git-push", "pushing the run branch");', ASSERT_LIVE_WRITE_RE);
  assert.match('["api", "-X", "POST", `repos/${owner}/${repo}/pulls`]', GH_VERB_RE);
  assert.match('["pr", "create", "--fill"]', GH_SUBCOMMAND_RE);
  assert.match('["issue", "close", issueUrl]', GH_SUBCOMMAND_RE);
  assert.match('deps.run(["push", "origin", `${anchor}:${ref}`])', GIT_PUSH_ARGV_RE);
});

test("FALSIFIER: a synthetic new external write with no AUTHORITY_TABLE entry is caught, never silently accepted", () => {
  const syntheticFile = "src/lib/a-file-that-does-not-exist-in-authority-table.ts";
  const syntheticText = 'export function doSomething() {\n  assertLiveWriteAllowed("gh-pr-merge", "merging without a table row");\n}\n';
  const reasons: string[] = [];
  for (const m of syntheticText.matchAll(new RegExp(ASSERT_LIVE_WRITE_RE, "g"))) reasons.push(`assertLiveWriteAllowed:${m[1]}`);
  assert.ok(reasons.length > 0, "the detector must flag the synthetic write");
  const tabled = authorityTableModules();
  assert.ok(!tabled.has(syntheticFile), "the synthetic file must genuinely be absent from AUTHORITY_TABLE for this to be a real falsifier");
  // The shape a real CI failure would take: this file, once real, would fail the ratchet test
  // above exactly the way `missing` names it there — asserted here directly, over the synthetic
  // pair, so the falsifier does not depend on mutating the real tree.
  const wouldFail = reasons.length > 0 && !tabled.has(syntheticFile);
  assert.ok(wouldFail, "a new ungated write with no table row must be a ratchet failure, not a pass");
});

// ── AUTHORITY_TABLE self-consistency: the baseline is EMPTY (a hand-added allowance defeats the
// point of this ratchet, unlike the count-baseline ratchets this repo also carries) ────────────

test("AUTHORITY_TABLE carries no unused rows for files the detector no longer finds (drift in the other direction)", () => {
  const detected = filesWithExternalWrites();
  const tabledModules = [...authorityTableModules()];
  const stale = tabledModules.filter((m) => !detected.has(m));
  assert.deepEqual(
    stale,
    [],
    `AUTHORITY_TABLE names ${JSON.stringify(stale)}, which the detector no longer finds any external write in — ` +
      "either the write was removed (the row is now stale prose) or the detector's shapes need widening",
  );
});
