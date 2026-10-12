import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// @source-text-subject: this suite's subject IS the two run preflight comments' prose, not behaviour.
// W1-T5483: W1-T5346 (#8820) moved the containment and isolation probes to once per boot and again
// on any change of their inputs, keyed by `probeVerdictKey`; W1-T5411 fixed the module headers.
// src/run-task.ts's two preflight comment blocks kept saying "Once per run, empirically confirm".

const RUN_TASK = join(import.meta.dirname, "..", "src", "run-task.ts");
const HEADINGS = ["CONTAINMENT PREFLIGHT", "Isolation PREFLIGHT"] as const;

/** The `//` comment block whose first line carries `heading`, its lines joined so a wrapped phrase matches. */
function preflightComment(heading: string): string {
  const lines = readFileSync(RUN_TASK, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith("// ──") && line.includes(heading));
  assert.notEqual(start, -1, `src/run-task.ts has no "${heading}" comment block`);
  const block: string[] = [];
  for (let i = start; i < lines.length && lines[i].trimStart().startsWith("//"); i++) {
    block.push(lines[i].trimStart().replace(/^\/\/\s?/, ""));
  }
  return block.join(" ").replace(/\s+/g, " ");
}

for (const heading of HEADINGS) {
  test(`run-task.ts's ${heading} comment is read as its whole block, not the heading line alone`, () => {
    assert.match(preflightComment(heading), /FAIL CLOSED/);
  });

  test(`run-task.ts's ${heading} comment no longer says the probe runs once per run`, () => {
    assert.doesNotMatch(preflightComment(heading), /once\s+per\s+run/i);
  });

  test(`run-task.ts's ${heading} comment states the once-per-boot ruling and names W1-T5346`, () => {
    const comment = preflightComment(heading);
    assert.match(comment, /once per boot/i);
    assert.match(comment, /any change of its inputs/i);
    assert.match(comment, /`probeVerdictKey`/);
    assert.match(comment, /`reuseProof`/);
    assert.match(comment, /W1-T5346/);
    assert.match(comment, /never assumed from configuration/i, "still proven by probe, never from configuration");
  });
}
