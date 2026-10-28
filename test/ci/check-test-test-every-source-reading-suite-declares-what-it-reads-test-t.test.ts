import assert from "node:assert/strict";
import { test } from "node:test";
import { missingPopulationControls } from "#src/lib/source-text-readers.js";

test("W1-T10851: check:test:test/every-source-reading-suite-declares-what-it-reads.test.ts is prevented, not retried", () => {
  // Editing or removing any ONE named suite cannot redden the control: only the population matters.
  assert.deepEqual(missingPopulationControls([{ walks: ["src/x.ts"] }, { walks: ["test/"] }]), []);
  assert.deepEqual(missingPopulationControls([{ walks: ["src/y.ts"] }, { walks: ["src/z.ts", "test/"] }]), []);
  // A corpus the discovery did not see still fails the control.
  assert.deepEqual(missingPopulationControls([]), ["no suite reads a src/ path", "no suite walks test/"]);
  assert.deepEqual(missingPopulationControls([{ walks: ["src/x.ts"] }]), ["no suite walks test/"]);
});
