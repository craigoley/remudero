// test/baseline-monotonic-against-origin-main.test.ts — W1-T2906: nothing compared a
// `scripts/*-baseline.json` SCORE against `origin/main` before scripts/baseline-monotonic-check.mjs
// existed, so a PR could edit the JSON to a lower floor (or higher ceiling) and pass its own
// ratchet by construction — every ratchet reads its baseline from the PR's OWN tree. This suite
// drives the real script both as pure functions and as a subprocess against an isolated fixture
// remote, mirroring test/cycle-ratchet.test.ts's and test/a-source-file-cannot-outgrow-its-
// baseline.test.ts's own conventions for their sibling gates.
//
// EVERY FIXTURE IS WRITTEN UNDER `mkdtemp`, NEVER INTO THE TRACKED TREE (W1-T2291).

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "baseline-monotonic-check.mjs");

// scripts/**/* sits outside tsconfig's `include` (see tsconfig.json) so a static import is a
// TS7016 — the same reason test/a-source-file-cannot-outgrow-its-baseline.test.ts reaches its
// script through a runtime import. A dynamic specifier loads the REAL module, with no shadow copy.
const { SCORE_TABLE, isRegression, bumpRationaleNamesAPr, evaluateRow } = (await import(
  pathToFileURL(SCRIPT).href
)) as {
  SCORE_TABLE: Array<{ path: string; field: string; direction: "increase" | "decrease" }>;
  isRegression: (oldValue: number, newValue: number, direction: "increase" | "decrease") => boolean;
  bumpRationaleNamesAPr: (rationale: unknown) => boolean;
  evaluateRow: (
    entry: { path: string; field: string; direction: "increase" | "decrease" },
    oldJson: Record<string, unknown> | undefined,
    newJson: Record<string, unknown>,
  ) => { status: string; ok: boolean; detail: string };
};

// ── pure classification: isRegression / bumpRationaleNamesAPr ──────────────────────────────────

test("isRegression: a FLOOR (direction increase) regresses only when the new value is LOWER", () => {
  assert.equal(isRegression(90, 85, "increase"), true);
  assert.equal(isRegression(90, 95, "increase"), false);
  assert.equal(isRegression(90, 90, "increase"), false);
});

test("isRegression: a CEILING (direction decrease) regresses only when the new value is HIGHER", () => {
  assert.equal(isRegression(13, 20, "decrease"), true);
  assert.equal(isRegression(13, 8, "decrease"), false);
  assert.equal(isRegression(13, 13, "decrease"), false);
});

test("bumpRationaleNamesAPr: requires a non-empty string naming a PR (#<n>) or a task (W1-T<n>)", () => {
  assert.equal(bumpRationaleNamesAPr("Raised 20000 -> 42000 by W1-T2507: ..."), true);
  assert.equal(bumpRationaleNamesAPr("Reviewed and bumped in #4201"), true);
  assert.equal(bumpRationaleNamesAPr("because it seemed fine"), false, "no PR/task reference");
  assert.equal(bumpRationaleNamesAPr(""), false, "empty string");
  assert.equal(bumpRationaleNamesAPr("   "), false, "whitespace-only");
  assert.equal(bumpRationaleNamesAPr(undefined), false, "absent field");
  assert.equal(bumpRationaleNamesAPr(42), false, "not a string");
});

// ── pure verdict: evaluateRow ────────────────────────────────────────────────────────────────────

const CEILING_ENTRY = { path: "scripts/cycle-baseline.json", field: "maxCycles", direction: "decrease" as const };
const FLOOR_ENTRY = { path: "scripts/coverage-baseline.json", field: "linesPct", direction: "increase" as const };

test("evaluateRow: a brand-new baseline (absent at origin/main) always passes — nothing to regress against", () => {
  const verdict = evaluateRow(CEILING_ENTRY, undefined, { maxCycles: 999 });
  assert.equal(verdict.status, "new");
  assert.equal(verdict.ok, true);
});

test("evaluateRow: a ceiling moving DOWN (or unchanged) against origin/main is not a regression", () => {
  assert.equal(evaluateRow(CEILING_ENTRY, { maxCycles: 13 }, { maxCycles: 10 }).status, "ok");
  assert.equal(evaluateRow(CEILING_ENTRY, { maxCycles: 13 }, { maxCycles: 13 }).status, "ok");
});

test("evaluateRow: a ceiling moving UP against origin/main with no bumpRationale is REFUSED (acceptance criterion 1)", () => {
  const verdict = evaluateRow(CEILING_ENTRY, { maxCycles: 13 }, { maxCycles: 20 });
  assert.equal(verdict.status, "regressed");
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /maxCycles moved 13 -> 20/);
  assert.match(verdict.detail, /bumpRationale/);
});

test("evaluateRow: a ceiling moving UP against origin/main WITH a fresh, PR-naming bumpRationale is ACCEPTED (acceptance criterion 2)", () => {
  const verdict = evaluateRow(
    CEILING_ENTRY,
    { maxCycles: 13 },
    { maxCycles: 20, bumpRationale: "Raised 13 -> 20 by W1-T9999: a deliberate, reviewed widening." },
  );
  assert.equal(verdict.status, "reviewed-bump");
  assert.equal(verdict.ok, true);
});

test("evaluateRow: a REUSED bumpRationale (byte-identical to origin/main's) does not cover a fresh regression", () => {
  const stale = "Raised 13 -> 20 by W1-T1: an earlier, unrelated bump.";
  const verdict = evaluateRow(CEILING_ENTRY, { maxCycles: 20, bumpRationale: stale }, { maxCycles: 27, bumpRationale: stale });
  assert.equal(verdict.status, "regressed", "the same text cannot silently re-cover a second, later regression");
});

test("evaluateRow: a floor moving DOWN against origin/main with no bumpRationale is REFUSED", () => {
  const verdict = evaluateRow(FLOOR_ENTRY, { linesPct: 95.62 }, { linesPct: 80 });
  assert.equal(verdict.status, "regressed");
  assert.match(verdict.detail, /linesPct moved 95\.62 -> 80/);
});

test("evaluateRow: retiring a floor against origin/main with no bumpRationale is REFUSED", () => {
  const verdict = evaluateRow(FLOOR_ENTRY, { linesPct: 95.62 }, {});
  assert.equal(verdict.status, "regressed");
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /"linesPct" was removed/);
  assert.match(verdict.detail, /bumpRationale/);
});

test("evaluateRow: retiring a floor WITH a fresh, PR-naming bumpRationale is ACCEPTED", () => {
  const verdict = evaluateRow(
    FLOOR_ENTRY,
    { linesPct: 95.62 },
    { bumpRationale: "Retired linesPct by #5117 / W1-T3380: coverage levels no longer block." },
  );
  assert.equal(verdict.status, "reviewed-bump");
  assert.equal(verdict.ok, true);
  assert.match(verdict.detail, /linesPct retired from 95\.62/);
});

test("evaluateRow: a floor moving UP (or unchanged) against origin/main is not a regression", () => {
  assert.equal(evaluateRow(FLOOR_ENTRY, { linesPct: 95.62 }, { linesPct: 96 }).status, "ok");
  assert.equal(evaluateRow(FLOOR_ENTRY, { linesPct: 95.62 }, { linesPct: 95.62 }).status, "ok");
});

test("evaluateRow: a non-numeric field at either end is a MEASUREMENT error, never a silent pass", () => {
  assert.equal(evaluateRow(FLOOR_ENTRY, { linesPct: "95" }, { linesPct: 96 }).status, "error");
  assert.equal(evaluateRow(FLOOR_ENTRY, { linesPct: 95.62 }, { linesPct: null }).status, "error");
});

// ── SCORE_TABLE is drawn from the LEDGER/FLOOR distinction, not from every *-baseline.json ──────

test("SCORE_TABLE names only SCALAR score floors/ceilings, never a per-file LEDGER", () => {
  const paths = SCORE_TABLE.map((e) => e.path);
  assert.ok(paths.includes("scripts/coverage-baseline.json"));
  assert.ok(paths.includes("scripts/mutation-baseline.json"));
  // The per-file ledgers src/lib/review.ts's ENTANGLEMENT_EXEMPT_INSTRUMENTS already names as
  // grading no falsifier — raising one row there records debt on that row alone.
  for (const ledger of [
    "scripts/source-size-baseline.json",
    "scripts/comment-load-baseline.json",
    "scripts/clock-signature-baseline.json",
    "scripts/knowledge-budget-baseline.json",
    "scripts/bound-kind-baseline.json",
  ]) {
    assert.ok(!paths.includes(ledger), `${ledger} is a per-file ledger, not a scalar score`);
  }
});

// ── wiring: the real CLI, driven as a subprocess against an isolated fixture remote ─────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A `scripts/cycle-baseline.json`-shaped fixture pair: `origin/main` records `maxCycles: 13`, and
 *  the working tree (an unpushed local commit, exactly like an open PR's branch) carries `after`
 *  plus an optional `bumpRationale`. `--table` points the real CLI at this ONE row, so the
 *  fixture never needs the other four production baseline files this check also reads by default. */
function ceilingFixture(after: number, bumpRationale?: string): { repo: string; table: string } {
  const outer = mkdtempSync(join(tmpdir(), "rmd-baseline-monotonic-"));
  const remote = join(outer, "origin.git");
  const repo = join(outer, "repo");
  git(outer, "init", "--bare", remote);
  git(outer, "init", "-b", "main", repo);
  git(repo, "config", "user.name", "RMD Baseline Monotonic Test");
  git(repo, "config", "user.email", "baseline-monotonic@example.invalid");
  writeFileSync(join(repo, "cycle-baseline.json"), JSON.stringify({ maxCycles: 13 }));
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");

  const body: Record<string, unknown> = { maxCycles: after };
  if (bumpRationale !== undefined) body.bumpRationale = bumpRationale;
  writeFileSync(join(repo, "cycle-baseline.json"), JSON.stringify(body));
  git(repo, "add", ".");
  git(repo, "commit", "-m", "open PR: touch the ceiling");

  const table = join(outer, "table.json");
  writeFileSync(table, JSON.stringify([{ path: "cycle-baseline.json", field: "maxCycles", direction: "decrease" }]));
  return { repo, table };
}

function run(root: string, table: string, base = "origin/main") {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, "--base", base, "--table", table], {
    cwd: root,
    encoding: "utf8",
  });
}

test("THE FALSIFIER: a baseline decrease against origin/main is refused (acceptance criterion: proof for test/baseline-monotonic-against-origin-main.test.ts)", () => {
  const { repo, table } = ceilingFixture(20); // 13 -> 20, no bumpRationale
  const result = run(repo, table);
  assert.notEqual(result.status, 0, "a regressed ceiling with no reviewed bump must BLOCK");
  assert.match(result.stderr, /baseline-monotonic-check: BLOCKED/);
  assert.match(result.stderr, /maxCycles moved 13 -> 20/);
  assert.match(result.stderr, /bumpRationale/);
});

test("THE FALSIFIER'S OTHER HALF: a rationalised bump against origin/main passes", () => {
  const { repo, table } = ceilingFixture(20, "Raised 13 -> 20 by W1-T9999: reviewed, deliberate.");
  const result = run(repo, table);
  assert.equal(result.status, 0, "a regression with a fresh, PR-naming bumpRationale must pass");
  assert.match(result.stdout, /baseline-monotonic-check: OK/);
});

test("a non-regressing change against origin/main passes with no bumpRationale needed", () => {
  const { repo, table } = ceilingFixture(9); // 13 -> 9: tightened, the ratchet's own healthy direction
  const result = run(repo, table);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /baseline-monotonic-check: OK/);
});

test("an unreadable --table argument fails closed (exit 2), never a silent OK", () => {
  const outer = mkdtempSync(join(tmpdir(), "rmd-baseline-monotonic-badtable-"));
  const result = spawnSync(process.execPath, [SCRIPT, "--root", outer, "--table", join(outer, "missing.json")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /MEASUREMENT FAILED/);
});

// ── measurement failures: readJsonAtRef / readJsonFromWorkingTree's own throw arms, and the ──────
// ── per-entry catch in main() that turns any of them into a fail-closed exit 2 ───────────────────

/** Same repo/table shape as {@link ceilingFixture}, but lets each commit's `cycle-baseline.json`
 *  content be set directly (raw, possibly non-JSON, text) at `origin/main` and, independently, in
 *  the working tree — `workingTreeText === undefined` removes the file from the working tree
 *  commit entirely instead. This is the shape needed to drive readJsonAtRef's and
 *  readJsonFromWorkingTree's own MEASUREMENT-FAILED throws (corrupt JSON at either end, or a file
 *  origin/main can read but the working tree cannot), which main()'s per-entry try/catch turns
 *  into a fail-closed exit 2 — never a silent OK. */
function rawContentFixture(originText: string, workingTreeText: string | undefined): { repo: string; table: string } {
  const outer = mkdtempSync(join(tmpdir(), "rmd-baseline-monotonic-raw-"));
  const remote = join(outer, "origin.git");
  const repo = join(outer, "repo");
  git(outer, "init", "--bare", remote);
  git(outer, "init", "-b", "main", repo);
  git(repo, "config", "user.name", "RMD Baseline Monotonic Test");
  git(repo, "config", "user.email", "baseline-monotonic@example.invalid");
  writeFileSync(join(repo, "cycle-baseline.json"), originText);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");

  if (workingTreeText === undefined) {
    git(repo, "rm", "cycle-baseline.json");
  } else {
    writeFileSync(join(repo, "cycle-baseline.json"), workingTreeText);
    git(repo, "add", ".");
  }
  git(repo, "commit", "-m", "open PR: touch the ceiling file");

  const table = join(outer, "table.json");
  writeFileSync(table, JSON.stringify([{ path: "cycle-baseline.json", field: "maxCycles", direction: "decrease" }]));
  return { repo, table };
}

test("origin/main's baseline JSON is corrupt: MEASUREMENT FAILED (exit 2), never a silent pass", () => {
  const { repo, table } = rawContentFixture("{ not valid json", JSON.stringify({ maxCycles: 10 }));
  const result = run(repo, table);
  assert.equal(result.status, 2, "corrupt JSON at origin/main must fail closed, never silently pass");
  assert.match(result.stderr, /is not valid JSON/);
});

test("the working tree's baseline JSON is corrupt: MEASUREMENT FAILED (exit 2)", () => {
  const { repo, table } = rawContentFixture(JSON.stringify({ maxCycles: 13 }), "{ not valid json");
  const result = run(repo, table);
  assert.equal(result.status, 2, "corrupt JSON in the working tree must fail closed, never silently pass");
  assert.match(result.stderr, /is not valid JSON/);
});

test("a baseline file readable at origin/main but missing from the working tree fails closed (exit 2)", () => {
  const { repo, table } = rawContentFixture(JSON.stringify({ maxCycles: 13 }), undefined);
  const result = run(repo, table);
  assert.equal(result.status, 2, "a file origin/main can read but the working tree cannot must fail closed");
  assert.match(result.stderr, /cannot read/);
});

test("an unrecognised CLI argument fails closed (exit 2), never a silent OK", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--this-flag-does-not-exist"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid arguments/);
});

// ── the real gate, as it runs against this repo's own SCORE_TABLE and its own origin/main ───────

test("PROPERTY: this repo's own SCORE_TABLE reads clean against its own origin/main (no baseline in this diff regresses)", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--root", REPO_ROOT], { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `expected a clean run against origin/main; got:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
});
