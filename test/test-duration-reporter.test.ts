import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

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
    { type: "test:complete", data: { file: "/repo/test/a.test.ts", nesting: 0, details: { duration_ms: 1.2 } } },
    { type: "test:complete", data: { file: "/repo/test/a.test.ts", nesting: 1, details: { duration_ms: 500 } } },
    { type: "test:complete", data: { file: "/repo/test/a.test.ts", nesting: 0, details: { duration_ms: 2.1 } } },
    { type: "test:complete", data: { file: "/repo/test/a.test.ts", nesting: 0, details: { duration_ms: 9.2 } } },
    { type: "test:complete", data: { file: "/repo/test/b.test.ts", nesting: 0, details: { duration_ms: 8 } } },
    { type: "test:complete", data: { file: "/elsewhere/test/escape.test.ts", nesting: 0, details: { duration_ms: 99 } } },
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
