import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot as findRepoRoot } from "./helpers/repo-root.js";

// scripts/** sits outside tsconfig's include, so the real module is loaded by a runtime import, as
// test/clock-sweep.test.ts does.
const ROOT = findRepoRoot();
const mod = (await import(pathToFileURL(join(ROOT, "scripts", "clock-sweep.mjs")).href)) as {
  SUITE_PRELOAD: string;
  runSuite: (
    suite: string,
    days: number,
    exec?: (file: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => string,
  ) => { failed: boolean; output: string };
  renderReport: (input: Record<string, unknown>) => string[];
};

test("W1-T9587: the clock sweep runs each suite under the tmp-hygiene preload", () => {
  // The preload is the one `npm test` and CI name, and it really exists.
  assert.equal(mod.SUITE_PRELOAD, "test/setup/tmp-hygiene.ts");
  assert.ok(existsSync(join(ROOT, mod.SUITE_PRELOAD)));

  let argv: string[] = [];
  mod.runSuite("emissions", 400, (_file, args) => {
    argv = args;
    return "";
  });
  const preload = argv.indexOf(join(ROOT, mod.SUITE_PRELOAD));
  const shift = argv.indexOf(join(ROOT, "scripts", "clock-shift.mjs"));
  assert.ok(preload > 0 && argv[preload - 1] === "--import", `the preload is an --import: ${argv.join(" ")}`);
  assert.ok(shift > preload, "the clock shift loads after the preload has set the harness up");
  assert.equal(argv[argv.length - 1], join("test", "emissions.test.ts"));

  // The printed reproduction runs the same harness that judged the suite.
  const report = mod.renderReport({
    drift: [{ suite: "emissions", fuse: 0, titles: ["a title"], detail: "" }],
    newDrift: [], staleExclusions: [], unreached: [], ceiling: 1, ok: true, runnable: ["emissions"],
  });
  const reproduce = report.find((line) => line.includes("reproduce"));
  assert.ok(reproduce?.includes("--import ./test/setup/tmp-hygiene.ts --import scripts/clock-shift.mjs"), String(reproduce));
});
