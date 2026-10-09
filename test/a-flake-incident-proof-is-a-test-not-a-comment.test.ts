// #10298 (2026-10-09): the flake-incident gardener filed `grep: <task id> in <test file>` as the proof. The only place a
// fix records a task id in a test file is a comment, and the reviewer refuses a comment-only match as non-discriminating,
// so every flake-incident PR came back CAPPED and waited on a person. The proof is now a test the fix adds, by title.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { runFlakeIncidentGardener } from "../src/lib/flake-incident-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const TEST_FILE = "test/the-census-roster-is-named-not-numbered.test.ts";
const TITLE = "runPreflightFast over ONLY the roster's admitted projection passes on a clean HEAD";
const NOW = Date.parse("2026-10-09T09:00:00Z");

test("a filed flake incident proves its fix with a test titled by the task id, never a grep a comment satisfies", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flake-proof-`));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  // The flaky test is in the filing checkout, as on main: lint-plan's admission reads the file a shard declares.
  mkdirSync(join(root, TEST_FILE, ".."), { recursive: true });
  writeFileSync(join(root, TEST_FILE), "");
  const rows: Array<Record<string, unknown>> = [];
  for (const pr of [10271, 10279, 10287]) {
    rows.push({
      ts: new Date(NOW).toISOString(), step: "test.flake_retry", file: TEST_FILE, headline: "recovered on retry", ci_run_id: pr * 10,
      shard: 2, source: "selector-shadow", retry_outcome: "recovered", head_sha: `head-${pr}`, base_sha: `base-${pr}`,
      pr_numbers: [pr], titles: [TITLE],
    });
  }
  writeFileSync(join(root, "state", "ledger.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const landed: Array<{ paths: string[] }> = [];
  await runFlakeIncidentGardener(
    {
      stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(NOW), log: () => {},
      openWorkspace: () => ({ root, branch: "selector-shadow-garden-1", land: (o: { paths: string[] }) => (landed.push(o), "https://github.com/acme/remudero/pull/1"), dispose: () => {} }),
    },
    { mintTaskId: () => "W1-T9884", readChangedPaths: () => ["src/lib/unrelated.ts"], planTasks: () => [], readSource: () => "" },
  );
  assert.equal(landed.length, 1);
  const shard = readFileSync(join(root, landed[0]!.paths[0]!), "utf8");
  const proofs = [...shard.matchAll(/proof: "?(.*?)"?$/gm)].map((m) => m[1]!);
  assert.equal(proofs.length, 1, shard);
  assert.match(proofs[0]!, /^unit test: W1-T9884 /, "the proof is a test the fix adds, named by the task id");
  assert.doesNotMatch(proofs[0]!, /^grep: W1-T9884 in /, "a bare id grep is satisfied only by a comment");
});
