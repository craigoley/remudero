import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { lintFiledTasks } from "#src/lib/relint.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

/** A filed implement task whose design declares `declared` and whose one criterion proves `claimed`. */
const filed = (id: string, design: string, claim: string): string => [
  `- id: ${id}`,
  "  title: \"difficulty levels reach the match\"",
  "  repo: remudero",
  "  origin: \"operator-session#w1-t14737-fixture\"",
  "  depends_on: []",
  "  type: implement",
  "  verify: auto",
  "  status: queued",
  "  attempts: 0",
  "  files: [src/lib/relint.ts]",
  "  design: |",
  `    ${design}`,
  "  acceptance:",
  `    - claim: ${JSON.stringify(claim)}`,
  "      proof: \"unit test: lintFiledTasks lints ONLY the ids this run filed\"",
  "",
].join("\n");

test("W1-T14737 an orphaned invariant claim on a filed id blocks the plan lane's self-relint", (t) => {
  const root = ownedFixtureDir(t, "w1-t14737-self-relint").dir;
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  // wreckterra#46's shape: a parenthetical between the slug and its colon hides the declaration from review's parser.
  writeFileSync(join(root, "plan", "tasks.d", "W1-T900-orphan.yaml"),
    filed("W1-T900", "INVARIANT menus-start-play (WRECK-T15) still holds: choosing a level never starts a match.",
      "invariant:menus-start-play — the picker never starts a match"));
  writeFileSync(join(root, "plan", "tasks.d", "W1-T901-declared.yaml"),
    filed("W1-T901", "INVARIANT menus-start-play: choosing a level never starts a match.",
      "invariant:menus-start-play — the picker never starts a match"));

  const orphan = lintFiledTasks(root, ["W1-T900"]).filter((v) => v.check === "design-invariant-proof");
  assert.ok(orphan.length > 0 && orphan.every((v) => v.severity === "block"), "the orphaned claim is refused before a plan PR could open");
  assert.ok(orphan.some((v) => /invariant:menus-start-play has no matching `INVARIANT menus-start-play:` declaration/.test(v.message)),
    JSON.stringify(orphan.map((v) => v.message)));

  assert.deepEqual(lintFiledTasks(root, ["W1-T901"]).filter((v) => v.check === "design-invariant-proof"), [],
    "the same task with a well-formed declaration passes");
});
