import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// @source-text-subject: this suite's subject IS the two module headers' prose, not behaviour.
// W1-T5411: W1-T5346 (#8820) moved the containment and isolation probes to once per boot and again
// on any change of their inputs, keyed by `probeVerdictKey`, and amended MASTER-PLAN §12 rule 11.
// The module headers of containment.ts and isolation.ts kept saying the probes are PROVEN PER RUN.

const LIB = join(import.meta.dirname, "..", "src", "lib");
const MODULES = ["containment.ts", "isolation.ts"] as const;

/** The module header: the first `/** … *\/` block that opens at the start of a line. */
function moduleHeader(file: string): string {
  const text = readFileSync(join(LIB, file), "utf8");
  const start = text.search(/^\/\*\*/m);
  assert.notEqual(start, -1, `${file} has no module header block`);
  return text.slice(start, text.indexOf("*/", start) + 2).replace(/\s*\n\s*\*\s?/g, " ");
}

for (const file of MODULES) {
  test(`${file}'s module header no longer says the probe is proven or called once per run`, () => {
    const header = moduleHeader(file);
    assert.doesNotMatch(header, /proven\s+per\s+run/i);
    assert.doesNotMatch(header, /once\s+per\s+run/i);
  });

  test(`${file}'s module header states the once-per-boot ruling and names probeVerdictKey and W1-T5346`, () => {
    const header = moduleHeader(file);
    assert.match(header, /once per boot/i);
    assert.match(header, /any change of (?:its|the probe's) inputs/i);
    assert.match(header, /`probeVerdictKey`/);
    assert.match(header, /W1-T5346/);
    assert.match(header, /never assumed from configuration/i, "still proven by probe, never from configuration");
  });
}
