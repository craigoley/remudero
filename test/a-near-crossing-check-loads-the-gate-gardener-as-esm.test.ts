import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir } from "../src/lib/tmp.js";

/**
 * W1-T9565 — THE FIXTURE CENSUS LOADS THE GATE GARDENER AS ESM.
 *
 * `main` in scripts/expiring-fixture-census.mjs loads src/lib/gate-gardener.ts whenever a reported fixture is
 * inside NEAR_CROSSING_HOURS (W1-T7812). It loaded it through `tsx/cjs/api`'s require, which compiles the gardener
 * and every src module it imports as COMMONJS and replaces `import.meta` through an esbuild define. Under
 * NODE_V8_COVERAGE each such module's source map gains a synthetic `<define:import.meta>` source, the shard lcov
 * carries `SF:src/lib/<define:import.meta>`, and scripts/coverage-merge-ratchet.mjs refuses whatever PR the shard
 * ran for (#11757, run 38637609131). Measured 2026-10-14: 26 such sources through tsx/cjs/api, 0 through tsImport.
 * The other producer, the pre-push harness's CommonJS-scope wrapper, is #11834's.
 *
 * FIXTURES ONLY: the child's runner and its coverage reports live under this suite's own temp dir, so the
 * child's NODE_V8_COVERAGE never reaches a shard's lcov.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CENSUS = join(REPO, "scripts", "expiring-fixture-census.mjs");

/** Runs the census `main` in a child under coverage with one fixture 0.5 days from crossing and an injected
 *  `runSuite`, and returns every `source-map-cache` source its reports mapped plus what the child printed.
 *  `loader` is the child's tsx flags: `--import tsx` as the suites run it, or none as ci.yml's bare `node` does. */
function nearCrossingCensusUnderCoverage(dir: string, loader: string[]) {
  const coverage = join(dir, "coverage");
  const runner = join(dir, "near-crossing-census.mjs");
  writeFileSync(runner, `import { main } from ${JSON.stringify(pathToFileURL(CENSUS).href)};
const NOW = Date.now();
const text = \`updated_at: "\${new Date(NOW + (0.5 - 14) * 86_400_000).toISOString()}",\\n\`;
const calls = [];
const code = await main({
  execFile: (command, args) => command === "node" ? JSON.stringify({ staleDays: 14 })
    : args[0] === "ls-files" ? "test/near.test.ts" : args[0] === "rev-parse" ? "base" : "",
  readFile: () => text, now: () => NOW, log: () => undefined,
  assertAged: () => undefined, assertComplete: () => undefined, recordedPopulationByFile: {},
  runSuite: (file, days) => { calls.push([file, days]); return { passed: true, pass: 1, tests: 1 }; },
});
console.log(JSON.stringify({ code, calls }));
`);
  // NODE_V8_COVERAGE is set ON PURPOSE: the record under test exists only in a coverage report.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const out = execFileSync(process.execPath, ["--enable-source-maps", ...loader, runner],
    { cwd: REPO, env: { ...env, NODE_V8_COVERAGE: coverage }, encoding: "utf8", timeout: 120_000 });
  const result = JSON.parse(out.trim().split("\n").at(-1)!) as { code: number; calls: Array<[string, number]> };
  const sources: string[] = [];
  for (const name of readdirSync(coverage)) {
    const report = JSON.parse(readFileSync(join(coverage, name), "utf8")) as
      { "source-map-cache"?: Record<string, { data?: { sources?: string[] } }> };
    for (const entry of Object.values(report["source-map-cache"] ?? {})) sources.push(...(entry.data?.sources ?? []));
  }
  return { ...result, sources };
}

test("W1-T9565: a near-crossing census run under coverage writes no define:import.meta source, while still mapping the gate gardener", async () => {
  // BOTH LOAD ARMS: under an active tsx resolver the census imports the gardener directly; from ci.yml's bare
  // `node scripts/expiring-fixture-census.mjs` it goes through tsImport. Either one compiling CommonJS is the defect.
  for (const loader of [["--import", "tsx"], []]) {
    const dir = makeTempDir("near-crossing-esm");
    try {
      const label = loader.length ? "under --import tsx" : "under bare node";
      const { code, calls, sources } = nearCrossingCensusUnderCoverage(dir, loader);
      // THE NEAR PATH RAN: the control and the shifted re-run both reached the injected runner, so the gardener
      // was loaded (its DEFUSE_CONTROL_SHIFT_DAYS is the control's shift) and this run is the one that matters.
      assert.equal(calls.length, 2, `${label}: the 0.5-day crossing must reach the near-crossing proof: ${JSON.stringify(calls)}`);
      assert.ok(calls.every(([file]) => file === "test/near.test.ts"), label);
      assert.equal(code, 0, `${label}: a near crossing whose shifted re-run stays green does not block`);
      // POSITIVE CONTROL: the reports mapped the gardener itself, so a zero below is a measurement, not a blind read.
      assert.ok(sources.some((source) => source.endsWith("src/lib/gate-gardener.ts")),
        `${label}: the coverage reports must map src/lib/gate-gardener.ts, or the comparison saw nothing (${sources.length} sources)`);
      assert.deepEqual(sources.filter((source) => source.includes("define:")), [],
        `${label}: a CommonJS compile of the src graph plants <define:import.meta> sources, which coverage-merge-ratchet refuses; ` +
          "load src modules from scripts/ through tsx's ESM api (tsImport), never tsx/cjs/api");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** A `tsx/cjs/api` import in module text: a static `from`, a dynamic `import()` or a `require()` of it. */
const CJS_API = /\bfrom\s*["']tsx\/cjs\/api["']|\bimport\(\s*["']tsx\/cjs\/api["']\s*\)|\brequire\(\s*["']tsx\/cjs\/api["']\s*\)/;

function scriptModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...scriptModules(path));
    else if (/\.m?js$/.test(entry.name)) out.push(path);
  }
  return out;
}

test("W1-T9565: no script loads a src module through tsx/cjs/api", () => {
  // BOTH DIRECTIONS: the base's own import line must fire; the ESM api and a prose mention must not.
  assert.ok(CJS_API.test('import { require as tsRequire } from "tsx/cjs/api";'), "the detector must fire on the #11757 shape");
  assert.ok(CJS_API.test('const { require } = await import("tsx/cjs/api");'));
  assert.ok(!CJS_API.test('import { tsImport } from "tsx/esm/api";'), "tsx's ESM api is the fix, not the defect");
  assert.ok(!CJS_API.test("`that imports src/, or a tsx/cjs/api require.`"), "a mention in prose is not an import");

  const files = scriptModules(join(REPO, "scripts"));
  assert.ok(files.some((file) => file.endsWith("expiring-fixture-census.mjs")), "the walk must reach the census, or it is vacuous");
  const offenders = files.filter((file) => CJS_API.test(readFileSync(file, "utf8"))).map((file) => file.slice(REPO.length));
  assert.deepEqual(offenders, [],
    "tsx/cjs/api compiles the src graph it loads as CommonJS and plants SF:src/lib/<define:import.meta> in coverage, " +
      `which coverage-merge-ratchet refuses; load it with tsImport from "tsx/esm/api" instead:\n${offenders.join("\n")}`);
});
