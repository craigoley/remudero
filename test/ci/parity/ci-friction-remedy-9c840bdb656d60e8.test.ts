import assert from "node:assert/strict";
import { test } from "node:test";

import { censusPopulationDrift, discoverCensusCandidates } from "#src/lib/ci-parity.js";
import type { PreflightSpawn } from "#src/lib/commit-message.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const hit = (files: string[]): PreflightSpawn => () => ({ status: 0, stdout: files.join("\n"), stderr: "" });

test("W1-T10761: check:test:test/census-discovery-is-blind-to-a-second-idiom.test.ts is prevented, not retried", () => {
  const executing = "test/new-census.test.ts";
  const mentionOnly = "test/mention-only.test.ts";
  const files: Record<string, string> = {
    [executing]: `import { execFileSync } from "node:child_process";\nexecFileSync("git", ["ls-files", "src/"]);\n`,
    [mentionOnly]: `// talks about ls-files and readdirSync over src/ but executes neither\nconst s = "git ls-files src/ readdirSync";\n`,
  };
  const read = (p: string): string => files[p] ?? "";

  // A suite that EXECUTES an src-walk is discovered; one that merely mentions the idioms is not.
  const found = discoverCensusCandidates("/fake", hit([executing, mentionOnly]), read).map((c) => c.testFile);
  assert.deepEqual(found, [executing]);

  // The drift guard names the undisclosed suite by path, so the author sees it before CI does.
  const drift = censusPopulationDrift("/fake", hit([executing, mentionOnly]), read, (p) => ({ path: p }) as never);
  assert.ok(drift.unknown.includes(executing), "undisclosed executing suite is named");
  assert.ok(!drift.unknown.includes(mentionOnly), "mention-only suite is never a census");

  // And the live tree carries no undisclosed census suite today.
  const live = censusPopulationDrift(REPO_ROOT, (f, a, o) =>
    // real spawn through the repo's own default
    require_spawn(f, a, o));
  assert.deepEqual(live.unknown, []);
});

import { spawnSync } from "node:child_process";
function require_spawn(f: string, a: readonly string[], o?: { cwd?: string }) {
  const r = spawnSync(f, [...a], { cwd: o?.cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
