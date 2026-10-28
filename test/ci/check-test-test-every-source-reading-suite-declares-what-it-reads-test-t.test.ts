// @census-reads: none — fixture source strings exercise the census through discovery.
import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverSourceTextReaders } from "#src/lib/source-text-readers.js";
import { assertSourceReaderCensus } from "#test/every-source-reading-suite-declares-what-it-reads.test.js";

function discover(files: Record<string, string>) {
  return discoverSourceTextReaders("/fixture", (args) => {
    if (args[0] === "grep") return Object.keys(files).join("\n");
    return [...Object.keys(files), "src/replacement.ts"].join("\n");
  }, (path) => {
    assert.ok(Object.hasOwn(files, path), `unexpected fixture read: ${path}`);
    return files[path]!;
  });
}

test("W1-T10851: check:test:test/every-source-reading-suite-declares-what-it-reads.test.ts is prevented, not retried", () => {
  const source = 'readFileSync("src/replacement.ts", "utf8");';
  const tests = '// @census-reads: test/ — census population';
  const healthy = {
    "test/replacement-source.test.ts": source,
    "test/replacement-tests.test.ts": tests,
  };
  // Neither incident suite exists: discovery and the actual census still accept the population.
  const readers = discover(healthy);
  assert.equal(readers.length, 2, "the positive control must actually discover both replacement suites");
  assert.doesNotThrow(() => assertSourceReaderCensus(readers));
  // Either historical suite may also remain after changing its subject to fixture behaviour.
  for (const name of ["a-generic-route-has-an-explicit-tool-bound", "a-wall-clock-bound-declares-itself"]) {
    assert.doesNotThrow(() => assertSourceReaderCensus(discover({
      ...healthy,
      [`test/${name}.test.ts`]: '// @census-reads: none — fixture behaviour',
    })));
  }
  assert.throws(() => assertSourceReaderCensus(discover({})), /no suite reads a src\/ path/);
  assert.throws(() => assertSourceReaderCensus(discover({ "test/only-tests.test.ts": tests })), /no suite reads a src\/ path/);
  assert.throws(() => assertSourceReaderCensus(discover({ "test/only-source.test.ts": source })), /no suite walks test\//);
  assert.throws(() => assertSourceReaderCensus(discover({
    ...healthy,
    "test/unplaced.test.ts": '// @source-text-subject: dynamic input\nreadFileSync(dynamicPath(), "utf8");',
  })), /these suites declare source text as their subject but name no path/);
});
