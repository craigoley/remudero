import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { FLAKE_INCIDENT_POLICY } from "#src/lib/flake-incident-gardener.js";
import {
  DURATION_WINDOW_RUNS, loadTestManifestProbe, manifestLastCommitMs,
  testGardenInventory, testManifestProposalHistoryPath,
} from "#src/lib/test-gardener.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

const NOW = Date.UTC(2026, 9, 13, 12);
const DAY = 24 * 3_600_000;
const FAST = "scripts/test-tier-manifest.json";
const COVERAGE = "scripts/test-tier-coverage-manifest.json";
const probe = await loadTestManifestProbe(fileURLToPath(new URL("..", import.meta.url)));

function fixture(t: TestContext, files: Record<string, number>) {
  const repo = gitRepo({ kind: "daily-test-garden" });
  t.after(() => repo.cleanup());
  for (const path of ["test", "scripts", "state"]) mkdirSync(join(repo.dir, path));
  for (const file of Object.keys(files)) writeFileSync(join(repo.dir, file), "export {};\n");
  for (const path of [FAST, COVERAGE]) writeFileSync(join(repo.dir, path), JSON.stringify({ thresholdMs: 5000, files }));
  const state = join(repo.dir, "state");
  const history = (rows: Record<string, number>) => writeFileSync(testManifestProposalHistoryPath(state),
    JSON.stringify({ runs: Array.from({ length: DURATION_WINDOW_RUNS }, (_, i) => ({ runId: i + 1, files: rows })), absent: [] }));
  const ledger = (rows: Record<string, unknown>[]) => writeFileSync(join(state, "ledger.ndjson"), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const inventory = (changedAt = NOW - 2 * DAY) => testGardenInventory(repo.dir, state, probe,
    { clock: fixedClock(NOW), manifestChangedAtMs: () => changedAt }).candidates;
  return { repo, state, history, ledger, inventory };
}

function retry(file: string, run: number, at = NOW - 1000, outcome = "recovered") {
  return { ts: new Date(at).toISOString(), step: "test.flake_retry", file, ci_run_id: run, retry_outcome: outcome };
}

test("W1-T9052: a retier waits behind the daily manifest cadence like an adoption", (t) => {
  const f = fixture(t, { "test/flaky.test.ts": 100 });
  f.ledger([1, 2, 3].map(id => retry("test/flaky.test.ts", id)));
  assert.deepEqual(f.inventory(NOW - 1000), []);
  assert.equal(f.inventory().filter(a => a.class === "retier-flaker").length, 1, "positive control: the same recovered runs qualify after the daily cadence");
});

test("W1-T9052: the cadence reads main's manifest history, not its own checkout", (t) => {
  const f = fixture(t, { "test/drift.test.ts": 100 });
  const commit = (at: number) => {
    f.repo.git("add", "scripts", "test");
    execFileSync("git", ["-C", f.repo.dir, "commit", "-qm", "manifest"], { env: {
      ...process.env, GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name, GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email, GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
      GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString(),
    } });
    return f.repo.git("rev-parse", "HEAD");
  };
  const old = commit(NOW - 30 * 3_600_000);
  writeFileSync(join(f.repo.dir, FAST), JSON.stringify({ thresholdMs: 5000, files: { "test/drift.test.ts": 110 } }));
  const fresh = commit(NOW - 3_600_000);
  f.repo.git("update-ref", "refs/remotes/origin/main", fresh);
  f.repo.git("reset", "--hard", old);
  f.history({ "test/drift.test.ts": 250 });
  assert.equal(manifestLastCommitMs(f.repo.dir, FAST), NOW - 30 * 3_600_000, "positive control: this checkout's manifest is old");
  assert.deepEqual(testGardenInventory(f.repo.dir, f.state, probe, { clock: fixedClock(NOW) }).candidates, []);
  assert.equal(manifestLastCommitMs(f.repo.dir, FAST, "origin/main"), NOW - 3_600_000);
});

test("W1-T9052: an urgent adoption carries only its urgent rows", (t) => {
  const drift = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`test/drift${i}.test.ts`, 100]));
  const f = fixture(t, { ...drift, "test/heavy.test.ts": 1000, "test/first.test.ts": 0 });
  const measured = { ...Object.fromEntries(Object.keys(drift).map(file => [file, 2500])), "test/heavy.test.ts": 120_000, "test/first.test.ts": 300 };
  f.history(measured);
  assert.deepEqual(f.inventory(NOW - 1000).map(a => a.edit.key).sort(), ["test/first.test.ts", "test/heavy.test.ts"]);
  assert.equal(f.inventory().length, 42, "the settled drift joins the ordinary daily PR");
  f.history({ ...measured, "test/heavy.test.ts": 30_000 });
  assert.deepEqual(f.inventory(NOW - 1000), [], "a sub-minute saving cannot open an urgent PR");
});

test("W1-T9052: a retiered file returns to measurement after a quiet window", (t) => {
  const file = "test/pinned.test.ts";
  const f = fixture(t, { [file]: 5000 });
  f.history({ [file]: 300 });
  f.ledger([retry(file, 1, NOW - FLAKE_INCIDENT_POLICY.windowMs - 1)]);
  assert.deepEqual(f.inventory().map(a => a.edit), [{ kind: "row", key: file, to: 300 }]);
  f.ledger([retry(file, 1)]);
  assert.deepEqual(f.inventory(), [], "a recent recovered retry keeps its pin");
  f.ledger([retry(file, 1, NOW - FLAKE_INCIDENT_POLICY.windowMs - 1), retry(file, 2, NOW - 1000, "also_failed")]);
  assert.deepEqual(f.inventory(), [], "an ongoing real failure is not a quiet window");
  f.ledger([{ ts: new Date(NOW - FLAKE_INCIDENT_POLICY.windowMs - 1).toISOString(), step: "test.flake_retry", file }]);
  assert.deepEqual(f.inventory().map(a => a.edit.to), [300], "legacy retries still establish the last non-quiet event");
  f.ledger([]);
  assert.deepEqual(f.inventory(), [], "no retry history does not prove a complete quiet window");
});

test("W1-T9052: retier counts distinct recovered runs in the flake window and names its incident", (t) => {
  const file = "test/flaky.test.ts";
  const f = fixture(t, { [file]: 100 });
  const rows = [retry(file, 1), { ...retry(file, 1), titles: ["second title"] }, retry(file, 2, NOW - 1000, "also_failed"),
    ...[10, 11, 12].map(id => retry(file, id, NOW - FLAKE_INCIDENT_POLICY.windowMs - 1))];
  f.ledger(rows);
  assert.deepEqual(f.inventory(), [], "duplicates, old retries and also-failed runs cannot create a retier");
  f.ledger([...rows, retry(file, 3), retry(file, 4), { ts: new Date(NOW - 1000).toISOString(), step: "flake_incident.filed", file, task_id: "W1-T6402" }]);
  const actions = f.inventory();
  assert.equal(actions.length, 1);
  assert.match(actions[0]!.reason, /W1-T6402/);
  f.ledger([1, 3, 4].map(id => retry(file, id)));
  assert.match(f.inventory()[0]!.reason, /eligible for flake-incident filing/);
});
