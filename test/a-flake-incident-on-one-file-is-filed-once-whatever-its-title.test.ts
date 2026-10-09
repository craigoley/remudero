// test/a-flake-incident-on-one-file-is-filed-once-whatever-its-title.test.ts — the flake-incident gardener
// keyed an incident by file AND title, so the same CI runs that red a whole file (title "") and one named
// test in it filed two tasks for one flake: W1-T7269 (file) and W1-T7270 (title), same three PRs and
// runs, both fixed by #10452. The duplicate (#10395) then sat stuck on lint-plan. One file, one incident.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { flakeIncidentOrigin, runFlakeIncidentGardener } from "../src/lib/flake-incident-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const FILE = "test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts";
const TITLE = "W1-T6123: no src file holds a raw git -C/cwd site beyond its widened reasoned exception";
const NOW = Date.parse("2026-10-09T18:00:00Z");

type Row = Record<string, unknown>;

function harness() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flake-one-file-`));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const ledger = join(root, "state", "ledger.ndjson");
  const log = (step: string, extra: Row = {}, ts = NOW) => {
    appendFileSync(ledger, JSON.stringify({ ts: new Date(ts).toISOString(), step, ...extra }) + "\n");
  };
  const landed: Array<{ paths: string[]; title: string }> = [];
  const deps = {
    stateDir: join(root, "state"), repoRoot: root, clock: fixedClock(NOW), log,
    openWorkspace: () => ({
      root, branch: "selector-shadow-garden-1",
      land: (opts: { paths: string[]; title: string; body: string }) => (landed.push(opts), `https://github.com/acme/remudero/pull/${30000 + landed.length}`),
      dispose: () => {},
    }),
  };
  let minted = 0;
  const evidence = (pr: number, titles: string[], ts = NOW) => log("test.flake_retry", {
    file: FILE, headline: "retry also failed", ci_run_id: pr * 10, shard: 3, source: "selector-shadow",
    retry_outcome: "also_failed", head_sha: `head-${pr}`, base_sha: `base-${pr}`, pr_numbers: [pr], titles,
  }, ts);
  const rows = (step: string): Row[] => readFileSync(ledger, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Row).filter((r) => r.step === step);
  const sources = (open: Array<{ id: string; origin?: string; status?: string }> = []) => ({
    mintTaskId: () => `W1-T95${String(++minted).padStart(2, "0")}`,
    readChangedPaths: () => ["src/lib/unrelated.ts"],
    planTasks: () => open,
    readSource: () => "",
  });
  return { deps, landed, evidence, rows, sources };
}

test("W1-T7270 dedupe: the same runs failing a file and a named test in it file ONE flake incident", async () => {
  const h = harness();
  for (const pr of [10203, 10310, 10377]) { h.evidence(pr, []); h.evidence(pr, [TITLE]); }
  // Two passes: one filing per pass, so the second pass is where a per-title duplicate would land.
  await runFlakeIncidentGardener(h.deps, h.sources());
  await runFlakeIncidentGardener(h.deps, h.sources());
  assert.equal(h.landed.length, 1, "one test file, one incident — not a file-level task plus a per-title task");
  assert.equal(h.rows("flake_incident.filed").length, 1);
});

test("W1-T7270 dedupe: an open incident on the file blocks a per-title incident on the same file", async () => {
  const h = harness();
  for (const pr of [10203, 10310, 10377]) h.evidence(pr, [TITLE]);
  await runFlakeIncidentGardener(h.deps, h.sources([{ id: "W1-T7269", origin: flakeIncidentOrigin(FILE, ""), status: "queued" }]));
  assert.equal(h.landed.length, 0, "the file's open incident already covers the titled test");
  assert.deepEqual(h.rows("flake_incident.skipped").map((r) => r.reason), ["open-task W1-T7269"]);
});

test("W1-T7270 dedupe: a different test file is still its own incident", async () => {
  const h = harness();
  for (const pr of [10203, 10310, 10377]) h.evidence(pr, [TITLE]);
  await runFlakeIncidentGardener(h.deps, h.sources([{ id: "W1-T9999", origin: flakeIncidentOrigin("test/some-other.test.ts", ""), status: "queued" }]));
  assert.equal(h.landed.length, 1, "an incident on another file does not suppress this one");
});
