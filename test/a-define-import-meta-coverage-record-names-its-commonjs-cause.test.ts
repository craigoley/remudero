import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// @ts-expect-error The production coverage merger is an executable .mjs module outside tsconfig.
import { mergeShardLineHits } from "#scripts/coverage-merge-ratchet.mjs";
import { makeTempDir } from "#src/lib/tmp.js";

/**
 * `SF:src/lib/<define:import.meta>` IS A COMMONJS COMPILE OF THE REAL src GRAPH, AND ITS REFUSAL SAYS SO.
 *
 * #11757 (W1-T9300) went red in coverage-ratchet on a diff that could not have caused it: coverage shard 3's
 * lcov carried `SF:src/lib/<define:import.meta>` with `DA:1,1`, a record the raw range merge never has, and
 * the shard-union step refused with nothing but that key. The record came from
 * test/the-pre-push-gate-runs-the-branch-s-own-checks-in-the-proof-sandbox.test.ts, whose harness wrote a
 * `.ts` wrapper of the real src/lib/git-push.ts into a tmp dir with no package.json.
 *
 * FIXTURES ONLY: every file this suite writes is under its own temp dir.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The `source-map-cache` sources of every report a `node --import tsx` run of `probe.ts` in `dir` wrote. */
function probeSources(dir: string): string[] {
  const coverage = join(dir, "coverage");
  writeFileSync(join(dir, "probe.ts"),
    `import { withFleetCashAllowanceLock } from ${JSON.stringify(join(REPO, "src", "lib", "cash-allowance-lock.ts"))};\n` +
    "console.log(typeof withFleetCashAllowanceLock);\n");
  // NODE_V8_COVERAGE is set ON PURPOSE: the record under test exists only in a coverage report.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const out = execFileSync(process.execPath, ["--enable-source-maps", "--import", "tsx", join(dir, "probe.ts")],
    { cwd: REPO, env: { ...env, NODE_V8_COVERAGE: coverage }, encoding: "utf8", timeout: 60_000 });
  assert.equal(out.trim(), "function", "the probe really imported the src module");
  const sources: string[] = [];
  for (const name of readdirSync(coverage)) {
    const report = JSON.parse(readFileSync(join(coverage, name), "utf8")) as
      { "source-map-cache"?: Record<string, { data?: { sources?: string[] } }> };
    for (const [url, entry] of Object.entries(report["source-map-cache"] ?? {})) {
      if (url.includes("cash-allowance-lock")) sources.push(...(entry.data?.sources ?? []));
    }
  }
  assert.ok(sources.length > 0, "the report mapped the imported src module, or this comparison saw nothing");
  return sources;
}

test("a .ts module outside an ESM package scope compiles the real src graph as CommonJS and plants <define:import.meta>; {\"type\":\"module\"} removes it", () => {
  const cjs = makeTempDir("define-meta-cjs");
  const esm = makeTempDir("define-meta-esm");
  try {
    writeFileSync(join(esm, "package.json"), JSON.stringify({ type: "module" }));
    assert.ok(probeSources(cjs).some((source) => source.endsWith("src/lib/%3Cdefine:import.meta%3E")),
      "a CommonJS-scope importer must produce the synthetic source, or the fix below proves nothing");
    assert.deepEqual(probeSources(esm).filter((source) => source.includes("define:")), [],
      "the same importer in an ESM scope must not");
  } finally {
    rmSync(cjs, { recursive: true, force: true });
    rmSync(esm, { recursive: true, force: true });
  }
});

test("the shard-union refusal of a <define:import.meta> record names its shard, its functions and the W1-T421 CommonJS cause", () => {
  const summary = {
    workingDirectory: "/repo",
    files: [{ path: "/repo/src/lib/review.ts", lines: [{ line: 1, count: 1 }], coveredLineCount: 1, totalLineCount: 1, coveredLinePercent: 100 }],
    totals: { coveredLineCount: 1, totalLineCount: 1, coveredLinePercent: 100 },
  };
  const clean = "SF:src/lib/review.ts\nDA:1,1\nend_of_record\n";
  // Shard 3's record from #11757's run 38637609131, verbatim but for its branch lines.
  const define = "SF:src/lib/<define:import.meta>\nFN:1,suiteRootFor\nFN:1,anonymous_1\nFNDA:7,suiteRootFor\n" +
    "FNDA:7,anonymous_1\nFNF:2\nFNH:2\nDA:1,1\nLH:1\nLF:1\nend_of_record\n";
  assert.throws(() => mergeShardLineHits(summary, [clean, clean, `${clean}${define}`]), (error: Error) => {
    assert.match(error.message, /positive line hits missing from the raw range merge: src\/lib\/<define:import\.meta>/);
    assert.match(error.message, /coverage shard 3; its functions: suiteRootFor, anonymous_1/);
    assert.match(error.message, /COMMONJS/);
    assert.match(error.message, /W1-T421/);
    assert.match(error.message, /"type":"module"/);
    return true;
  });
  // A real missing source keeps the plain refusal, now with its shard, and no W1-T421 diagnosis it does not earn.
  assert.throws(() => mergeShardLineHits(summary, [clean, "SF:src/missing.mjs\nDA:1,1\nend_of_record\n"]), (error: Error) => {
    assert.match(error.message, /missing from the raw range merge: src\/missing\.mjs \(coverage shard 2\)$/);
    return true;
  });
});
