import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// ── W1-T2897: THE CLOCK-SIGNATURE CENSUS — HOLDS THE DRIFT THE SWEEP ONLY COUNTS ────────────────
//
// Audit recon-2026-09-05 R-34 (re-verified 2026-09-07): `git grep -ohE '\bnow\??: \(\) =>
// (number|string|Date)' -- src | sort | uniq -c` found 92 sites across four incompatible shapes,
// up from 83 two days earlier — the count grows because nothing refuses growth. W1-T1128's
// `clock-sweep.yml` counts the SYMPTOM (wall-clock drift in tests); this census counts the CAUSE,
// per file, so a PR that touches a file can migrate it and lower its row, and a PR that adds a new
// incompatible shape (or a new bare `Date.now()`/`new Date(` site) to a file already in the
// baseline is refused rather than silently raising the ceiling.
//
// CALIBRATION, ON PURPOSE, NARROWER THAN THE RAW AUDIT REGEX: `now: () => Date.now()` and
// `now: () => new Date()` (found at src/lib/deployer.ts and src/lib/serve.ts) are VALUE
// implementations of some OTHER interface's declared shape, not themselves a declared clock-shape
// signature — the raw audit regex miscounts them into the `() => Date` bucket because it only
// checks the token immediately after `=>`. Excluding a call-chain (`.` or `(` right after the
// bare type keyword) fixes that miscount without changing what the audit actually found: run the
// raw command above yourself and diff it against `scanClockSignatures()` below to see the two
// sites this excludes, both real, both filed as W1-T2897 follow-up (see this task's REPORT).
//
// SCOPE: `src/` only, matching the audit's own `-- src` restriction — `test/`, `scripts/`,
// `apps/*/src`, and `packages/*/src` are not walked here.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_ROOT = join(REPO_ROOT, "src");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "clock-signature-baseline.json");

// The four incompatible signatures R-34 named, collapsed into one count per file: an optional or
// required `now` field whose value is a zero-arg arrow returning `number`, `Date`, or `string` —
// but NOT when that keyword is immediately followed by `.` or `(` (a call chain: an
// implementation of some other declared shape, never itself a signature declaration).
const LEGACY_CLOCK_SHAPE = /\bnow\??:\s*\(\)\s*=>\s*(?:number|string|Date)\b(?!\s*[.(])/g;
const DATE_NOW = /\bDate\.now\(\)/g;
const NEW_DATE = /\bnew Date\(/g;

export interface ClockSignatureRow {
  /** Sites matching one of the four incompatible `now`-shaped signatures declared in this file. */
  legacy: number;
  /** Bare `Date.now()` call sites in this file. */
  dateNow: number;
  /** Bare `new Date(` call sites in this file. */
  newDate: number;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function countAll(re: RegExp, text: string): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function toRepoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join("/");
}

/** Walks every `src/**\/*.ts` file and returns a row for every file carrying at least one of the
 *  three tracked counts — a file with all-zero counts is omitted, exactly as the baseline omits
 *  it, so an untouched file never needs a baseline entry. */
export function scanClockSignatures(): Record<string, ClockSignatureRow> {
  const result: Record<string, ClockSignatureRow> = {};
  for (const file of listTsFiles(SRC_ROOT)) {
    const text = readFileSync(file, "utf8");
    const row: ClockSignatureRow = {
      legacy: countAll(LEGACY_CLOCK_SHAPE, text),
      dateNow: countAll(DATE_NOW, text),
      newDate: countAll(NEW_DATE, text),
    };
    if (row.legacy > 0 || row.dateNow > 0 || row.newDate > 0) {
      result[toRepoRelative(file)] = row;
    }
  }
  return result;
}

function readBaseline(): Record<string, ClockSignatureRow> {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

// ═══ acceptance: "the count of legacy clock shapes and bare Date calls per file is recorded ═════
// ═══ and cannot grow" ═════════════════════════════════════════════════════════════════════════

test("scripts/clock-signature-baseline.json is valid JSON, keyed by repo-relative src path, every row carrying all three counts", () => {
  const baseline = readBaseline();
  assert.ok(Object.keys(baseline).length > 0, "the baseline must record at least one file");
  for (const [file, row] of Object.entries(baseline)) {
    assert.ok(file.startsWith("src/"), `${file}: baseline is scoped to src/ only`);
    assert.equal(typeof row.legacy, "number");
    assert.equal(typeof row.dateNow, "number");
    assert.equal(typeof row.newDate, "number");
  }
});

test("no src/ file's legacy-shape, Date.now(), or new Date( count exceeds its recorded baseline row — the ratchet this census exists to hold", () => {
  const baseline = readBaseline();
  const current = scanClockSignatures();
  const zero: ClockSignatureRow = { legacy: 0, dateNow: 0, newDate: 0 };
  const violations: string[] = [];

  for (const [file, row] of Object.entries(current)) {
    const base = baseline[file] ?? zero;
    if (row.legacy > base.legacy) violations.push(`${file}: legacy ${row.legacy} > baseline ${base.legacy}`);
    if (row.dateNow > base.dateNow) violations.push(`${file}: dateNow ${row.dateNow} > baseline ${base.dateNow}`);
    if (row.newDate > base.newDate) violations.push(`${file}: newDate ${row.newDate} > baseline ${base.newDate}`);
  }

  assert.deepEqual(
    violations,
    [],
    `growth beyond the recorded baseline — migrate the file onto src/lib/clock.ts's Clock port and ` +
      `lower its row, or record the growth deliberately in scripts/clock-signature-baseline.json:\n` +
      violations.join("\n"),
  );
});

test("src/lib/daemon.ts's legacy-shape row fell from 4 to 2 in this task — the named clock type's module actually migrated onto the Clock port", () => {
  const current = scanClockSignatures();
  const row = current["src/lib/daemon.ts"];
  assert.ok(row, "src/lib/daemon.ts must still be a tracked row (it retains two legacy-shaped public dependency fields on purpose)");
  assert.equal(row.legacy, 2, "DaemonDeps.now and crashLoopCheck.now keep their legacy shapes (many tests inject them directly); the headroom sampler's own now: () => number field was migrated onto Clock, dropping the file from 4 to 2");
});

test("src/lib/clock.ts declares zero legacy clock shapes of its own — it is the port the census exists to migrate files onto, not another shape to track", () => {
  const current = scanClockSignatures();
  assert.equal(current["src/lib/clock.ts"]?.legacy ?? 0, 0);
});
