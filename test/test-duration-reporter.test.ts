import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const REPORTER = join(process.cwd(), "scripts", "test-duration-reporter.mjs");
const mod = (await import(pathToFileURL(REPORTER).href)) as {
  durationReport: (
    source: AsyncIterable<Record<string, unknown>>,
    opts: { cwd: string },
  ) => AsyncGenerator<string>;
};

async function* events(items: Record<string, unknown>[]) {
  for (const item of items) yield item;
}

test("duration reporter keeps the file-wrapper wall time without double-counting top-level tests", async () => {
  const source = events([
    { type: "test:complete", data: { name: "/repo/test/a.test.ts", file: "/repo/test/a.test.ts", nesting: 0, details: { duration_ms: 1.2 } } },
    { type: "test:complete", data: { name: "nested test", file: "/repo/test/a.test.ts", nesting: 1, details: { duration_ms: 500 } } },
    { type: "test:complete", data: { name: "declared test", file: "/repo/test/a.test.ts", nesting: 0, details: { duration_ms: 500 } } },
    { type: "test:complete", data: { name: "/repo/test/a.test.ts", file: "/repo/test/a.test.ts", nesting: 0, details: { duration_ms: 9.2 } } },
    { type: "test:complete", data: { name: "/repo/test/b.test.ts", file: "/repo/test/b.test.ts", nesting: 0, details: { duration_ms: 8 } } },
    { type: "test:complete", data: { name: "/elsewhere/test/escape.test.ts", file: "/elsewhere/test/escape.test.ts", nesting: 0, details: { duration_ms: 99 } } },
    { type: "test:fail", data: { file: "/repo/test/ignored.test.ts", nesting: 0, details: { duration_ms: 50 } } },
  ]);
  const chunks: string[] = [];
  for await (const chunk of mod.durationReport(source, { cwd: "/repo" })) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.deepEqual(JSON.parse(chunks[0]!), {
    version: 1,
    files: { "test/a.test.ts": 10, "test/b.test.ts": 8 },
  });
});

test("duration reporter emits an empty, valid evidence document when the runner completes no tests", async () => {
  const chunks: string[] = [];
  for await (const chunk of mod.durationReport(events([]), { cwd: "/repo" })) chunks.push(chunk);
  assert.deepEqual(JSON.parse(chunks[0]!), { version: 1, files: {} });
});

test("duration reporter keeps only the selected physical wrapper when a real child imports another test file", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-duration-import-"));
  try {
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "test/imported.test.ts"), 'import { test } from "node:test"; test("imported real test", () => {});\n');
    writeFileSync(join(root, "test/selected.test.ts"), 'import "./imported.test.ts"; import { test } from "node:test"; test("selected real test", () => {});\n');
    const evidence = join(root, "durations.json");
    // A separately launched runner must not inherit the parent's test-child marker.
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const tap = execFileSync(process.execPath, ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout",
      `--test-reporter=${REPORTER}`, `--test-reporter-destination=${evidence}`, "test/selected.test.ts"],
    { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    assert.match(tap, /^# tests 2$/m); assert.match(tap, /^# pass 2$/m); assert.match(tap, /^# fail 0$/m);
    const observed = JSON.parse(readFileSync(evidence, "utf8")) as { version: number; files: Record<string, number> };
    assert.equal(observed.version, 1);
    assert.deepEqual(Object.keys(observed.files), ["test/selected.test.ts"]);
    assert.ok(Number.isFinite(observed.files["test/selected.test.ts"]) && observed.files["test/selected.test.ts"]! > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
