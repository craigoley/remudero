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

// W1-T14888: MEASURED 2026-11-24 15Z to 11-25 23Z on the Azure host, each heavy-lane pass got one or two prepare steps,
// the projector moved every generation between passes, and passes landed more than 30 s apart under load. An instance
// refreshed early in the cycle fell due again before the last one was reached, so prepare never returned ready and the
// lane rebuilt an unread view at 0.55 cores.

const NOW = systemClock.now();
const INSTANCES = ["core", "console"] as const;
const scratchDirs: string[] = [];
after(async () => {
  await flushReadModelTransactions();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function plan(repo: string, id: string): string {
  return `- id: ${id}\n  title: t\n  repo: ${repo}\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/x.ts]\n  status: queued\n  acceptance:\n    - claim: c\n      proof: "grep: x in y"\n`;
}

/** Two instances, each with its own plan and ledger, projected once so each has a read model a prepare can step over. */
function fixture(): { stateDir: string; dbs: ReturnType<typeof openProjectorReadModel>[] } {
  const root = makeTempDir("repositories-cycle");
  scratchDirs.push(root);
  const stateDir = join(root, "state");
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(daemonInstanceRegistryPath(root), ["instances:", "  core:", "    repo: remudero", "    github_repo: craigoley/remudero", "    project: remudero",
    "  console:", "    repo: remudero-console", "    github_repo: craigoley/remudero-console", "    project: remudero", ""].join("\n"));
  const sources: RepositoriesSources["instances"] = INSTANCES.map((name) => {
    const dir = name === "core" ? root : join(root, "instances", name);
    const ledgerDir = name === "core" ? stateDir : join(dir, "state");
    mkdirSync(join(dir, "plan"), { recursive: true });
    mkdirSync(ledgerDir, { recursive: true });
    const repo = name === "core" ? "craigoley/remudero" : "craigoley/remudero-console";
    writeFileSync(join(dir, "plan", "tasks.yaml"), plan(repo, `${name}-T1`));
    const rows = [
      { ts: new Date(NOW - 3_600_000).toISOString(), step: "run.start", run_id: `${name}1`, task_id: `${name}-T1`, repo },
      { ts: new Date(NOW - 60_000).toISOString(), step: "daemon.tick" },
    ];
    writeFileSync(join(ledgerDir, "ledger.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    return { instanceId: name, options: { root: dir, ledgerPath: join(ledgerDir, "ledger.ndjson"), planPath: join(dir, "plan", "tasks.yaml"), controlRoot: dir, incidentsDir: ledgerDir,
      ...(name === "core" ? { repoRegistryPath: daemonInstanceRegistryPath(root), ownInstance: "core" } : { instanceRepository: repo }) } };
  });
  createRepositoriesSourcePublisher({ stateDir, instances: () => sources })();
  switchViewsOn(stateDir, ["repositories"], "shadow");
  const ticker = createReadModelTicker({
    stateDir, instances: INSTANCES.map((name) => ({ name, ledgerDir: name === "core" ? stateDir : join(stateDir, "..", "instances", name, "state") })),
    views: [createRepositoriesReadModelView<ReadModelInstanceState>(ledgerSource)], clock: systemClock, holder: "serve-a", post: () => {},
  });
  ticker.tick();
  ticker.release();
  return { stateDir, dbs: INSTANCES.map((name) => openProjectorReadModel(stateDir, name)) };
}

/** Passes 31 s apart, each with one prepare step and a moved generation, as the loaded host gave them. */
function steppedCycle(dbs: ReturnType<typeof openProjectorReadModel>[], view: ReturnType<typeof createRepositoriesReadModelView<ReadModelInstanceState>>, maxPasses: number) {
  let now = NOW;
  let generation = 1;
  let passes = 0;
  let ready = false;
  const at = () => dbs.map((db, i) => ({ state: { instance: INSTANCES[i], generation, lease: "held" as const, failures: 0, newestTs: null, tickedAt: now }, db }));
  while (!ready && passes < maxPasses) {
    passes++;
    now += 31_000;
    generation++;
    let allowed = true;
    ready = view.prepare({ now, instances: at() }, () => (allowed ? ((allowed = false), true) : false));
  }
  return { ready, passes, now, at };
}

test("W1-T14888 criterion 1: a stepped repositories build ends though its cycle outlasts the recompute floor and every generation moves", (t) => {
  const { dbs } = fixture();
  t.after(() => dbs.forEach((db) => db.close()));
  const view = createRepositoriesReadModelView<ReadModelInstanceState>(ledgerSource);
  const { ready, passes, now, at } = steppedCycle(dbs, view, 12);
  assert.equal(ready, true, `prepare returned ready within 12 one-step passes (took ${passes})`);
  assert.ok(passes <= 5, `two instances take at most a plan step and a summary step each, plus the closing pass (took ${passes})`);
  const names = view.materialize({ now, instances: at() })[0].data.instances.map((i) => i.instanceId).sort();
  assert.deepEqual(names, ["console", "core"], "the finished body names both instances");
});

test("W1-T14888 criterion 2: the build that follows a finished stepped cycle does not recompute what the cycle just summarized", (t) => {
  const { dbs } = fixture();
  t.after(() => dbs.forEach((db) => db.close()));
  const view = createRepositoriesReadModelView<ReadModelInstanceState>(ledgerSource);
  const { now, at } = steppedCycle(dbs, view, 12);
  const built = Object.fromEntries(view.materialize({ now, instances: at() })[0].sources
    .filter((source) => source.name.startsWith("repositories:")).map((source) => [source.name.slice("repositories:".length), source.asOf ?? undefined]));
  // Core was summarized passes before the cycle closed: 31 s or more ago, past the floor, with a moved generation.
  // The build right after the cycle publishes the cycle's summary instead of recomputing core a second time.
  assert.ok(built.core !== undefined && Date.parse(built.core) < now, `core's summary is the cycle's (${built.core}), not one recomputed at the closing build (${new Date(now).toISOString()})`);
  assert.ok(built.console !== undefined, "console's summary is published");
});
