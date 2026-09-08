// test/flake-retry-aggregate.test.ts — W1-T2904: three FLAKE-RETRY lines naming the same test
// aggregate to one row with count three, the acceptance this file exists to prove.
//
// scripts/flake-retry-aggregate.mjs is a plain .mjs file outside tsconfig's `include` (same
// convention as test/test-with-retry.test.ts), so its pure functions are imported directly and
// its CLI surface is driven as a real subprocess against throwaway log files under `mkdtemp`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "flake-retry-aggregate.mjs");

// scripts/flake-retry-aggregate.mjs sits outside tsconfig's `include` (a plain .mjs file), so —
// same convention as test/a-shard-that-produced-no-summary-is-not-a-failure-set.test.ts's import
// of scripts/test-with-retry.mjs — it is reached here via a dynamic `import()` off a
// `pathToFileURL`, never a static import that TS7016s.
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  parseFlakeRetryLine: (line: string) => { headline: string; names: string[] } | null;
  aggregateFlakeRetries: (text: string) => { rows: Array<{ test: string; count: number }>; unnamedCount: number };
  formatReport: (result: { rows: Array<{ test: string; count: number }>; unnamedCount: number }) => string;
  main: (argv: string[], opts?: { readFile?: (path: string, enc: string) => string }) => number;
};
const { parseFlakeRetryLine, aggregateFlakeRetries, formatReport, main } = mod;

function writeLog(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flake-retry-aggregate-`));
  const path = join(dir, "flake-retry.log");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

// ── parseFlakeRetryLine ──────────────────────────────────────────────────────────────────────

test("parseFlakeRetryLine: parses the exact shape recordFlakeEvidence emits", () => {
  const parsed = parseFlakeRetryLine("FLAKE-RETRY: first attempt failed — a flaky test, another one");
  assert.deepEqual(parsed, { headline: "first attempt failed", names: ["a flaky test", "another one"] });
});

test("parseFlakeRetryLine: the unparsed-name placeholder yields an EMPTY names array, not a fabricated test", () => {
  const parsed = parseFlakeRetryLine("FLAKE-RETRY: retry ALSO failed — (no test name parsed from output)");
  assert.deepEqual(parsed, { headline: "retry ALSO failed", names: [] });
});

test("parseFlakeRetryLine: an unrelated line is ignored, not a crash", () => {
  assert.equal(parseFlakeRetryLine("ok 1 - some other test"), null);
  assert.equal(parseFlakeRetryLine(""), null);
});

// ── the acceptance criterion itself: three lines naming one test aggregate to count 3 ──────────

test("W1-T2904 acceptance: three retry lines naming the same test aggregate to one row with count 3", () => {
  const text = [
    "FLAKE-RETRY: first attempt failed — test/foo.test.ts flaky case",
    "FLAKE-RETRY: first attempt failed — test/foo.test.ts flaky case",
    "FLAKE-RETRY: retry ALSO failed — test/foo.test.ts flaky case",
  ].join("\n");
  const { rows, unnamedCount } = aggregateFlakeRetries(text);
  assert.deepEqual(rows, [{ test: "test/foo.test.ts flaky case", count: 3 }]);
  assert.equal(unnamedCount, 0);
});

test("aggregateFlakeRetries: multiple distinct tests sort by count desc, then name asc", () => {
  const text = [
    "FLAKE-RETRY: first attempt failed — b test",
    "FLAKE-RETRY: first attempt failed — a test",
    "FLAKE-RETRY: first attempt failed — a test",
  ].join("\n");
  const { rows } = aggregateFlakeRetries(text);
  assert.deepEqual(rows, [
    { test: "a test", count: 2 },
    { test: "b test", count: 1 },
  ]);
});

test("aggregateFlakeRetries: a single retry line naming two tests credits BOTH once", () => {
  const text = "FLAKE-RETRY: first attempt failed — test one, test two";
  const { rows } = aggregateFlakeRetries(text);
  assert.deepEqual(rows, [
    { test: "test one", count: 1 },
    { test: "test two", count: 1 },
  ]);
});

test("aggregateFlakeRetries: unnamed placeholders are counted separately, never invented as a test row", () => {
  const text = [
    "FLAKE-RETRY: first attempt failed — (no test name parsed from output)",
    "FLAKE-RETRY: first attempt failed — (no test name parsed from output)",
  ].join("\n");
  const { rows, unnamedCount } = aggregateFlakeRetries(text);
  assert.deepEqual(rows, []);
  assert.equal(unnamedCount, 2);
});

test("aggregateFlakeRetries: no FLAKE-RETRY lines at all yields an empty, non-throwing result", () => {
  const { rows, unnamedCount } = aggregateFlakeRetries("ok 1 - fine\nok 2 - also fine\n");
  assert.deepEqual(rows, []);
  assert.equal(unnamedCount, 0);
});

// ── formatReport ─────────────────────────────────────────────────────────────────────────────

test("formatReport: renders the aggregate as a most-retried-first table", () => {
  const report = formatReport({ rows: [{ test: "a test", count: 3 }], unnamedCount: 1 });
  assert.match(report, /3\s+a test/);
  assert.match(report, /1\s+\(no test name parsed from output\)/);
});

test("formatReport: says plainly when nothing retried", () => {
  const report = formatReport({ rows: [], unnamedCount: 0 });
  assert.match(report, /no FLAKE-RETRY lines found/);
});

// ── CLI / main: best-effort over real files, never throws on a missing one ─────────────────────

test("CLI: aggregates across MULTIPLE log files (the shape ci-required's per-shard artifacts take)", () => {
  const shard1 = writeLog([
    "FLAKE-RETRY: first attempt failed — test/foo.test.ts flaky case",
  ]);
  const shard2 = writeLog([
    "FLAKE-RETRY: first attempt failed — test/foo.test.ts flaky case",
    "FLAKE-RETRY: retry ALSO failed — test/foo.test.ts flaky case",
  ]);
  const result = spawnSync(process.execPath, [SCRIPT, shard1, shard2], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3\s+test\/foo\.test\.ts flaky case/);
});

test("CLI: a missing/unreadable input file contributes nothing rather than failing the run", () => {
  const shard1 = writeLog(["FLAKE-RETRY: first attempt failed — test/foo.test.ts flaky case"]);
  const result = spawnSync(process.execPath, [SCRIPT, shard1, "/no/such/path/flake-retry.log"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\s+test\/foo\.test\.ts flaky case/);
});

test("CLI: with no arguments at all, prints usage and exits non-zero rather than hanging on stdin", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage/);
});

test("main(): programmatic entry point mirrors the CLI over an injectable readFile", () => {
  const code = main(["a.log", "b.log"], {
    readFile: (p: string) =>
      p === "a.log"
        ? "FLAKE-RETRY: first attempt failed — x\n"
        : "FLAKE-RETRY: first attempt failed — x\n",
  });
  assert.equal(code, 0);
});
