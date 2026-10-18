import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { AffectedSelection } from "../src/lib/affected-suites.js";
import {
  coverageNarrowSuites,
  coveragePrecheck,
  coveragePushRefusal,
  PREFLIGHT_SCOPED_COVERAGE_SUITE_CEILING,
  type CoveragePrecheckPorts,
  type CoverageRunResult,
} from "../src/run-task.js";

// MEASURED 2026-10-14 (#11677): the reach selection for a diff touching src/run-task.ts was 2503 suites, far past
// the precheck's ceiling, so every real source diff read `unavailable` and a new module's uncovered error arms
// were learned from CI's coverage-ratchet a fix round later. The suites most likely to cover the diff are its OWN
// test files plus the direct importers of the changed src files; those run first.

const suites = (n: number) => Array.from({ length: n }, (_, i) => `test/s${i}.test.ts`);
const selectionOf = (n: number): AffectedSelection => ({ suites: suites(n), fullRun: false, reasons: [], recentOnly: { floor: [] } });
const BLOCKED = [
  "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests; cover each line:",
  "  - src/lib/new-module.ts:109",
  "  - src/lib/new-module.ts:114",
].join("\n");
const NARROW = ["test/new-module.test.ts", "test/importer.test.ts"];

function ports(reach: number, results: CoverageRunResult[], calls: string[][]): CoveragePrecheckPorts {
  return {
    changedFiles: () => ["src/lib/new-module.ts", "test/new-module.test.ts"],
    select: () => selectionOf(reach),
    narrow: () => NARROW,
    head: () => "abc123",
    manifest: () => ({ thresholdMs: 5000, files: {} }),
    run: (_wt, s) => {
      calls.push(s);
      return results.shift() ?? { status: 0, output: "", timedOut: false };
    },
  };
}

const ok: CoverageRunResult = { status: 0, output: "", timedOut: false };
const blocked: CoverageRunResult = { status: 1, output: BLOCKED, timedOut: false };

test("W1-T9483: a diff whose reach is over the ceiling is judged by its own and direct-importer suites", async () => {
  const calls: string[][] = [];
  const result = await coveragePrecheck("/w", ports(2503, [ok], calls));
  assert.equal(result.outcome, "covered");
  assert.deepEqual(calls, [NARROW], "only the narrow suites ran; the 2503-suite reach was never spawned");
  assert.ok(calls[0]!.length <= PREFLIGHT_SCOPED_COVERAGE_SUITE_CEILING);
});

test("W1-T9483: a narrow-pass gap over the ceiling is advisory, not a refusal", async () => {
  const calls: string[][] = [];
  const result = await coveragePrecheck("/w", ports(2503, [blocked], calls));
  assert.equal(result.outcome, "uncovered-narrow");
  assert.match((result as { text: string }).text, /new-module\.ts:109/);
  assert.match((result as { text: string }).text, /new-module\.ts:114/);
  assert.deepEqual(calls, [NARROW]);
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const refusal = coveragePushRefusal(result, (step, extra) => rows.push([step, extra]), "fallback_push");
  assert.equal(refusal, undefined, "an advisory never refuses the push");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]![0], "push.coverage_precheck");
  assert.equal(rows[0]![1]!.outcome, "uncovered-narrow");
  assert.match(String(rows[0]![1]!.lines), /new-module\.ts:109/);
  assert.equal(rows[0]![1]!.suites, NARROW.length);
});

test("a narrow-pass gap within the ceiling runs the reach passes, and only they can refuse", async () => {
  const covered = await coveragePrecheck("/w", ports(3, [blocked, ok], []));
  assert.equal(covered.outcome, "covered", "the wider reach covers what the narrow pass did not");
  const calls: string[][] = [];
  const refused = await coveragePrecheck("/w", ports(3, [blocked, blocked], calls));
  assert.equal(refused.outcome, "uncovered");
  assert.deepEqual(calls[1], suites(3));
  const rows: Array<Record<string, unknown> | undefined> = [];
  assert.ok(coveragePushRefusal(refused, (_s, extra) => rows.push(extra), "fallback_push"), "the reach-pass uncovered still refuses");
});

test("a narrow pass that cannot look defers to the reach selection exactly as before", async () => {
  const timedOut = await coveragePrecheck("/w", ports(2503, [{ status: null, output: "", timedOut: true }], []));
  assert.equal(timedOut.outcome, "unavailable");
  assert.match((timedOut as { reason: string }).reason, /too wide to precheck quickly/);
  const noSf = await coveragePrecheck("/w", ports(3, [{ status: 1, output: "diff-coverage: BLOCKED -- changed source file(s) have no SF record in the coverage report; x", timedOut: false }, ok], []));
  assert.equal(noSf.outcome, "covered");
  const throwing = await coveragePrecheck("/w", { ...ports(3, [], []), narrow: () => { throw new Error("listing exploded"); } });
  assert.equal(throwing.outcome, "covered", "an unreadable narrow listing falls back to the reach passes");
});

test("a diff with no narrow suites and an over-wide reach stays unavailable without spawning", async () => {
  const calls: string[][] = [];
  const result = await coveragePrecheck("/w", { ...ports(2503, [], calls), narrow: () => [] });
  assert.equal(result.outcome, "unavailable");
  assert.equal(calls.length, 0);
});

test("the default narrow selection is the diff's test files plus direct importers of its changed src files", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}narrow-suites-`));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "src/lib/a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "src/lib/b.ts"), "export const b = 1;\n");
    writeFileSync(join(dir, "test/a-direct.test.ts"), 'import { a } from "../src/lib/a.js";\nvoid a;\n');
    writeFileSync(join(dir, "test/a-commented.test.ts"), '// import { a } from "../src/lib/a.js";\nvoid 1;\n');
    writeFileSync(join(dir, "test/b-only.test.ts"), 'import { b } from "../src/lib/b.js";\nvoid b;\n');
    writeFileSync(join(dir, "test/own.test.ts"), "void 2;\n");
    git("add", "-A");
    const got = await coverageNarrowSuites(dir, ["src/lib/a.ts", "test/own.test.ts", "test/deleted.test.ts"]);
    assert.deepEqual(got, ["test/a-direct.test.ts", "test/own.test.ts"]);
    assert.deepEqual(await coverageNarrowSuites(dir, ["plan/x.yaml"]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reach pass the narrow run already contained is not run twice, and the narrow gap refuses", async () => {
  const calls: string[][] = [];
  const result = await coveragePrecheck("/w", { ...ports(2, [blocked], calls), select: () => ({ ...selectionOf(0), suites: [...NARROW] }) });
  assert.equal(result.outcome, "uncovered");
  assert.match((result as { text: string }).text, /new-module\.ts:109/);
  assert.equal(calls.length, 1, "the narrow run is the only run");
});

test("a forced full run with a narrow gap is advisory, and an unreadable narrow listing is named in the reason", async () => {
  const full = await coveragePrecheck("/w", { ...ports(2503, [blocked], []), select: () => ({ ...selectionOf(0), fullRun: true, reasons: ["a workflow changed"] }) });
  assert.equal(full.outcome, "uncovered-narrow");
  assert.equal((full as { head: string }).head, "abc123");
  const unreadable = await coveragePrecheck("/w", { ...ports(2503, [], []), narrow: () => { throw new Error("listing exploded"); } });
  assert.equal(unreadable.outcome, "unavailable");
  assert.match((unreadable as { reason: string }).reason, /narrow suite listing was unreadable: listing exploded/);
  const headless = await coveragePrecheck("/w", { ...ports(2503, [blocked], []), head: () => { throw new Error("no git"); } });
  assert.match((headless as { head: string }).head, /^unreadable: no git/);
});
