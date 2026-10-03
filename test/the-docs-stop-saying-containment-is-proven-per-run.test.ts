import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// W1-T5408: W1-T5346 (#8820) moved the containment and isolation probes to once per boot and again
// on any change of their inputs, keyed by `probeVerdictKey`, and amended MASTER-PLAN §12 rule 11 to
// match. docs/architecture.md is hand-written, so it kept telling a reader the boundary is "PROVEN
// PER RUN". This suite holds the doc to the amended rule.

const ARCHITECTURE = join(import.meta.dirname, "..", "docs", "architecture.md");
const doc = () => readFileSync(ARCHITECTURE, "utf8");

/** The doc's bullet about containment and isolation, joined onto one line so wrapping is irrelevant. */
function containmentBullet(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^- \*\*Containment and isolation are PROVEN/i.test(line));
  assert.notEqual(start, -1, "docs/architecture.md has no bullet stating containment and isolation are PROVEN");
  const body = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("- ") || line.trim() === "") break;
    body.push(line.trim());
  }
  return body.join(" ").replace(/\s+/g, " ");
}

test("docs/architecture.md no longer says containment or isolation is proven per run", () => {
  assert.doesNotMatch(doc(), /proven\s+per\s+run/i);
});

test("the containment bullet states the once-per-boot-and-input-change rule naming probeVerdictKey", () => {
  const bullet = containmentBullet(doc());
  assert.match(bullet, /once per boot/i);
  assert.match(bullet, /any change of the probe's inputs/i);
  assert.match(bullet, /`probeVerdictKey`/);
  assert.match(bullet, /never assumed/i, "proven by probe, never assumed from configuration");
  assert.match(bullet, /failed probe is never cached/i, "a FAIL is never stored");
  for (const input of ["image build sha", "harness revision", "worker settings", "hook", "CLI version", "provider"]) {
    assert.match(bullet, new RegExp(input, "i"), `the bullet names the probe input "${input}"`);
  }
});
