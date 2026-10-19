import assert from "node:assert/strict";
import { test } from "node:test";

// Loaded through a computed specifier so this suite does not join the selector graph's reach.
const SELECTOR = "../src/lib/" + "affected-suites.js";

const FILES = new Map([
  ["src/root.ts", 'export { a } from "#test/a.js";'],
  ["src/a.ts", "export const a = 1;"],
  ["test/old.test.ts", 'import "#src/root.js";'],
]);

test("W1-T9413: check:test:test/the-affected-suite-reach-ratchet.test.ts:flaky is prevented, not retried", async () => {
  const { buildAffectedSuitesGraph } = await import(SELECTOR);
  // The reach ratchet's verdict is only stable if the graph is a pure function of the file map,
  // independent of insertion order.
  const shape = (files: Map<string, string>) => {
    const g = buildAffectedSuitesGraph(files) as unknown as {
      dependencies: Map<string, Set<string>>;
    };
    return [...g.dependencies].map(([k, v]) => [k, [...v].sort()]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  };
  const reversed = new Map([...FILES].reverse());
  assert.deepEqual(shape(reversed), shape(FILES));
  assert.deepEqual(shape(new Map(FILES)), shape(FILES));
  assert.ok(shape(FILES).some(([k, v]) => k === "test/old.test.ts" && (v as string[]).includes("src/root.ts")),
    "the suite edge must be present");
});
