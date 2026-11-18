import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { systemClock } from "#src/lib/clock.js";
import { daemonInstanceRegistryPath } from "#src/lib/deployer.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { flushReadModelTransactions } from "#src/lib/read-model-db.js";
import { createReadModelTicker, ledgerSource, type ReadModelInstanceState } from "#src/lib/read-model-worker.js";
import { createRepositoriesReadModelView, createRepositoriesSourcePublisher, type RepositoriesSources } from "#src/lib/repositories-view.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { switchViewsOn } from "#test/helpers/read-model-switches.js";

// W1-T13654: serve rebuilt the repositories body on every heavy-lane pass (293 builds in 10 min, 14 s of CPU, on
// 2026-11-18) though it changes only when a summary is recomputed or a file it reads moves. It now declares its inputs.

const NOW = systemClock.now();
const scratchDirs: string[] = [];
after(async () => {
  await flushReadModelTransactions();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function plan(repo: string, id: string): string {
  return `- id: ${id}\n  title: t\n  repo: ${repo}\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/x.ts]\n  status: queued\n  acceptance:\n    - claim: c\n      proof: "grep: x in y"\n`;
}

function registry(project: string): string {
  return ["instances:", "  core:", "    repo: remudero", "    github_repo: craigoley/remudero", `    project: ${project}`, ""].join("\n");
}

function fixture(): { root: string; stateDir: string; sources: RepositoriesSources["instances"] } {
  const root = makeTempDir("repositories-skip");
  scratchDirs.push(root);
  const stateDir = join(root, "state");
  mkdirSync(join(root, ".remudero"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(daemonInstanceRegistryPath(root), registry("remudero"));
  writeFileSync(join(root, "plan", "tasks.yaml"), plan("craigoley/remudero", "W1-T1"));
  const rows = [
    { ts: new Date(NOW - 3_600_000).toISOString(), step: "run.start", run_id: "r1", task_id: "W1-T1", repo: "craigoley/remudero" },
    { ts: new Date(NOW - 3_000_000).toISOString(), step: "verdict", run_id: "r1", task_id: "W1-T1", verdict: "merged" },
    { ts: new Date(NOW - 60_000).toISOString(), step: "daemon.tick" },
  ];
  writeFileSync(join(stateDir, "ledger.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const sources: RepositoriesSources["instances"] = [{ instanceId: "core", options: {
    root, repoRegistryPath: daemonInstanceRegistryPath(root), ownInstance: "core", controlRoot: root, incidentsDir: stateDir,
    ledgerPath: join(stateDir, "ledger.ndjson"), planPath: join(root, "plan", "tasks.yaml"),
  } }];
  createRepositoriesSourcePublisher({ stateDir, instances: () => sources })();
  return { root, stateDir, sources };
}

/** The real worker over one instance, counting the view's builds; `at` moves its clock. */
function worker(stateDir: string) {
  const view = createRepositoriesReadModelView<ReadModelInstanceState>(ledgerSource);
  let builds = 0;
  const counted = { ...view, materialize: (ctx: Parameters<typeof view.materialize>[0]) => { builds++; return view.materialize(ctx); } };
  let now = NOW;
  const clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  switchViewsOn(stateDir, ["repositories"], "shadow");
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views: [counted], clock, holder: "serve-a", post: () => {},
  });
  return { view, tick: (atMs: number) => { now = atMs; ticker.tick(); return builds; }, release: () => void ticker.release() };
}

test("W1-T13654 criterion 1: the worker skips the repositories build while nothing it reads moved, and rebuilds when a summary is recomputed or the registry moves", (t) => {
  const f = fixture();
  const w = worker(f.stateDir);
  t.after(() => w.release());
  let at = NOW;
  let builds = w.tick(at);
  assert.ok(builds >= 1, "the first pass builds the body");
  // The first would-be skip is audited (a rebuild), so settle past it, then ten more passes inside the cadence.
  for (let i = 0; i < 3; i++) builds = w.tick(at += 2_000);
  const settled = builds;
  for (let i = 0; i < 10; i++) builds = w.tick(at += 2_000);
  assert.equal(builds, settled, "an unchanged portfolio is skipped on every pass inside the recompute cadence");
  builds = w.tick(at += 61_000);
  assert.ok(builds > settled, "a pass past the 60 s cadence recomputes the summary, and the moved summary is rebuilt");
  for (let i = 0; i < 3; i++) builds = w.tick(at += 2_000);
  const before = builds;
  writeFileSync(daemonInstanceRegistryPath(f.root), registry("renamed"));
  builds = w.tick(at += 2_000);
  assert.ok(builds > before, "a registry rewrite moves the inputs, so the body is rebuilt");
});

test("W1-T13654 criterion 2: the fingerprint moves with the sources file, the registry and each recompute, and holds otherwise", (t) => {
  const f = fixture();
  const w = worker(f.stateDir);
  w.tick(NOW);
  w.release();
  const db = openProjectorReadModel(f.stateDir, "core");
  t.after(() => db.close());
  const view = createRepositoriesReadModelView<ReadModelInstanceState>(ledgerSource);
  const state = { instance: "core", generation: 1, lease: "held" as const, failures: 0, newestTs: null, tickedAt: NOW } as ReadModelInstanceState;
  const instances = [{ state, db }];
  const fingerprint = (now: number): string | undefined => {
    while (!view.prepare({ now, instances }, () => true)) { /* every step allowed */ }
    view.materialize({ now, instances });
    return view.inputsFingerprint({ now, instances });
  };
  assert.equal(view.inputsFingerprint({ now: NOW, instances: [{ state }] }), undefined, "with no store to locate the sources file, reuse is not certified");
  const first = fingerprint(NOW);
  assert.equal(typeof first, "string");
  assert.equal(fingerprint(NOW + 5_000), first, "inside the cadence with nothing moved, the inputs are unchanged");
  const recomputed = fingerprint(NOW + 61_000);
  assert.notEqual(recomputed, first, "a recompute past the 60 s cadence moves the inputs");
  writeFileSync(daemonInstanceRegistryPath(f.root), registry("renamed"));
  const reRegistered = fingerprint(NOW + 62_000);
  assert.notEqual(reRegistered, recomputed, "a registry rewrite moves the inputs");
  createRepositoriesSourcePublisher({ stateDir: f.stateDir, instances: () => [{ ...f.sources[0]!, options: { ...f.sources[0]!.options, ownInstance: "other" } }] })();
  assert.notEqual(fingerprint(NOW + 63_000), reRegistered, "a republished sources file moves the inputs");
});
