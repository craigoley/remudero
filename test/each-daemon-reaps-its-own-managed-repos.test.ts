// The cadence controller owns each daemon's real managed stores and durable state.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { readMaintenanceState } from "../src/lib/object-reaper.js";
import { runRepositoryMaintenanceRung } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

async function rung(root: string) {
  const rows: Array<[string, Record<string, unknown>]> = [];
  await runRepositoryMaintenanceRung({ root } as never, (s, f) => rows.push([s, f]),
    { activeLanes: 0, disk: "unknown", queueBusy: false });
  return rows;
}

test("a console daemon maintains its own managed repo and daemon checkout with independent state", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}console-root-`));
  const consoleStore = gitRepo({ kind: "console-maintenance" });
  const daemonStore = gitRepo({ kind: "console-daemon-maintenance" });
  mkdirSync(join(root, "repos", "not-a-store"), { recursive: true });
  symlinkSync(consoleStore.dir, join(root, "repos", "remudero-console"), "dir");
  symlinkSync(daemonStore.dir, join(root, "remudero"), "dir");
  for (const store of [consoleStore, daemonStore]) writeFileSync(join(store.dir, ".git", "gc.log"), "prior failure\n");
  const rows = await rung(root);
  const completed = rows.filter(([s]) => s === "repository_maintenance.complete").map(([, f]) => f);
  assert.deepEqual(completed.map((f) => f.repo), [join(root, "repos", "remudero-console"), join(root, "remudero")]);
  assert.ok(completed.every((f) => f.kind === "gc" && f.gc_log_after === "absent"));
  const states = readdirSync(join(root, "state")).filter((name) => name.startsWith("repository-maintenance-"));
  assert.equal(states.length, 2, "each discovered store has its own durable cadence");
  for (const name of states) assert.equal(readMaintenanceState(join(root, "state", name)).lastOutcome, "complete");
  for (const store of [consoleStore, daemonStore]) assert.equal(existsSync(join(store.dir, ".git", "gc.log")), false);
  const repeated = await rung(root);
  assert.equal(repeated.length, 0, "both stores preserve the next daily window");
});

test("a site daemon maintains its managed store and handles absent repos without a phantom core store", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}site-root-`));
  const siteStore = gitRepo({ kind: "site-maintenance" });
  siteStore.git("maintenance", "run", "--task=gc");
  mkdirSync(join(root, "repos"));
  symlinkSync(siteStore.dir, join(root, "repos", "remudero-site"), "dir");
  const rows = await rung(root);
  assert.deepEqual(rows.filter(([s]) => s === "repository_maintenance.complete").map(([, f]) => f.repo),
    [join(root, "repos", "remudero-site")]);

  const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bare-root-`));
  assert.deepEqual(await rung(bare), [], "an absent store is never maintained");
  const daemonStore = gitRepo({ kind: "site-daemon-only" });
  daemonStore.git("maintenance", "run", "--task=gc");
  symlinkSync(daemonStore.dir, join(bare, "remudero"), "dir");
  assert.deepEqual((await rung(bare)).filter(([s]) => s === "repository_maintenance.complete").map(([, f]) => f.repo),
    [join(bare, "remudero")], "the daemon checkout still runs when repos is absent");
});
