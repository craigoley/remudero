import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// @ts-expect-error The production coverage merger is an executable .mjs module outside tsconfig.
import { scriptsTheSourceMapDescribes } from "../scripts/coverage-merge-ratchet.mjs";

/**
 * A FILE LOADED BY BOTH tsx LOADERS IN ONE PROCESS KEEPS EVERY OTHER PROCESS'S COVERAGE OF IT.
 *
 * An ESM import and a CJS require of one `.ts` compile it twice, so V8 reports two scripts under one
 * URL while `source-map-cache` holds one map. Mapping the other instance through that map put its
 * zero-count ranges on unrelated lines, and the range merge then erased real hits: #9835's
 * src/lib/worker-home.ts read 0 on lines its own suite ran 38 times, because the W1-T6138 pre-push
 * fixture's children load 31 src files both ways.
 *
 * FIXTURES ONLY: every file here is under a throwaway directory.
 */

const FUNCTIONS = 12;

function coverageEnv(directory: string): NodeJS.ProcessEnv {
  // NODE_V8_COVERAGE is set ON PURPOSE: the merge under test needs real reports to merge.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  return { ...env, NODE_V8_COVERAGE: directory };
}

function fixture(): { root: string; produce: (name: string, script: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-two-loader-coverage-"));
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  let probe = "";
  for (let i = 0; i < FUNCTIONS; i++) {
    probe += `export function f${i}(n: number): number {\n  let total = 0;\n  for (let i = 0; i < n; i++) total += i * ${i};\n  return total;\n}\n`;
  }
  writeFileSync(join(root, "probe.ts"), probe);
  const produce = (name: string, script: string) => {
    const raw = join(root, name);
    mkdirSync(raw);
    writeFileSync(join(root, `${name}.mjs`), script);
    execFileSync(process.execPath, ["--import", "tsx", `${name}.mjs`], { cwd: root, env: coverageEnv(raw), stdio: "pipe" });
    return raw;
  };
  return { root, produce };
}

function linesHit(root: string, ...rawDirectories: string[]): number {
  const output = join(root, `merged-${rawDirectories.map((d) => d.split("/").pop()).join("-")}.info`);
  execFileSync(
    process.execPath,
    ["--expose-internals", "scripts/coverage-merge-ratchet.mjs", "--output", output, "--shard-count", String(rawDirectories.length), ...rawDirectories],
    { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
  );
  const lcov = readFileSync(output, "utf8");
  const record = lcov.split("end_of_record").find((r) => /^SF:.*probe\.ts$/m.test(r));
  assert.ok(record, "the merged LCOV must carry the probe's record");
  return Number(/^LH:(\d+)$/m.exec(record!)![1]);
}

test("a process that loads a file through both tsx loaders erases no other process's hits on it", () => {
  const { root, produce } = fixture();
  try {
    const url = "new URL('./probe.ts', import.meta.url)";
    const callsAll = produce("calls-all", `const m = await import(${url}.href);\nfor (let i = 0; i < ${FUNCTIONS}; i++) m['f' + i](3);\n`);
    const loadsBoth = produce("loads-both", `import { createRequire } from 'node:module';\nawait import(${url}.href);\ncreateRequire(import.meta.url)('./probe.ts');\n`);
    const loadsOnce = produce("loads-once", `await import(${url}.href);\n`);

    const probeInstances = readdirSync(loadsBoth)
      .filter((n) => /^coverage-.*\.json$/.test(n))
      .map((n) => (JSON.parse(readFileSync(join(loadsBoth, n), "utf8")).result as Array<{ url: string }>).filter((s) => s.url.endsWith("/probe.ts")).length);
    assert.deepEqual(probeInstances.filter((n) => n > 0), [2], "the fixture must really compile the probe twice in one process");

    // Node's range merge is order-sensitive, so the control is the same merge with the probe loaded ONCE.
    for (const order of [[callsAll, loadsBoth], [loadsBoth, callsAll]] as const) {
      const control = linesHit(root, ...order.map((d) => (d === loadsBoth ? loadsOnce : d)));
      assert.ok(linesHit(root, ...order) >= control, `merging ${order.map((d) => d.split("/").pop()).join(" then ")} lost lines the single-load control keeps`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repeated URL keeps only the instance its cached source map describes", () => {
  const instance = (end: number) => ({ url: "file:///p.ts", functions: [{ ranges: [{ startOffset: 0, endOffset: end, count: 1 }] }] });
  const other = { url: "file:///q.ts", functions: [{ ranges: [{ startOffset: 0, endOffset: 9, count: 1 }] }] };
  const cache = { "file:///p.ts": { lineLengths: [3, 4] } }; // 3 + newline + 4 = 8 generated characters
  assert.deepEqual(scriptsTheSourceMapDescribes([instance(20), other, instance(8)], cache), [other, instance(8)]);
});

test("a report with no repeated URL, or a repeat with no cached map, passes through untouched", () => {
  const a = { url: "file:///p.ts", functions: [{ ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] }] };
  const b = { url: "file:///p.ts", functions: [{ ranges: [{ startOffset: 0, endOffset: 7, count: 1 }] }] };
  const single = [a];
  assert.equal(scriptsTheSourceMapDescribes(single, {}), single);
  assert.deepEqual(scriptsTheSourceMapDescribes([a, b], undefined), [a, b]);
});
