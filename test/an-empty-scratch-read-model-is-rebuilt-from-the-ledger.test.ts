/**
 * Scratch-disk mounts (deploy/scratch-mounts.sh): the read model's DB files move to the ephemeral
 * local NVMe, which a VM deallocate wipes. `RMD_READ_MODEL_DB_DIR=<stateDir>:<dir>` points one state
 * dir's DB files there. An empty or missing directory is a full rebuild from the ledger, and the
 * operator's switch file never moves off the persistent state disk.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { readModelCommand } from "../src/lib/read-model-cli.js";
import { READ_MODEL_DB_DIR_ENV, readModelDbDir } from "../src/lib/read-model-db.js";
import { createReadModelTicker, readModelSwitchesPath, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";

function scratch(t: { after: (fn: () => void) => void }, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withDbDir(t: { after: (fn: () => void) => void }, value: string): void {
  const saved = process.env[READ_MODEL_DB_DIR_ENV];
  process.env[READ_MODEL_DB_DIR_ENV] = value;
  t.after(() => {
    if (saved === undefined) delete process.env[READ_MODEL_DB_DIR_ENV];
    else process.env[READ_MODEL_DB_DIR_ENV] = saved;
  });
}

const ROWS = 40;

function ledgerDirWithRows(t: { after: (fn: () => void) => void }): string {
  const dir = scratch(t, "scratch-rm-ledger");
  let text = "";
  for (let i = 0; i < ROWS; i++) text += `${JSON.stringify({ ts: new Date(Date.parse("2026-10-01T00:00:00.000Z") + i).toISOString(), step: "run.start", task_id: `T${i}`, run_id: `r-${i}` })}\n`;
  writeFileSync(join(dir, "ledger.ndjson"), text);
  return dir;
}

test("a missing scratch read-model dir is rebuilt in full from the ledger and the switch file stays on the state disk", (t) => {
  const stateDir = scratch(t, "scratch-rm-state");
  const scratchRoot = scratch(t, "scratch-rm-nvme");
  const dbDir = join(scratchRoot, "rmd", "state2", "read-model");
  assert.equal(existsSync(dbDir), false, "the scratch disk was just wiped by a deallocate");
  withDbDir(t, `${stateDir}:${dbDir}`);
  const ledgerDir = ledgerDirWithRows(t);

  const out: string[] = [];
  assert.equal(readModelCommand(["switch", "projector", "on"], { stateDir, out: (l) => void out.push(l), error: (l) => void out.push(l) }), 0);
  assert.equal(readModelSwitchesPath(stateDir), join(stateDir, "read-model", "switches.json"));
  assert.ok(existsSync(readModelSwitchesPath(stateDir)), "the operator's switch file is written to the persistent state dir");
  assert.equal(readModelCommand(["status"], { stateDir, out: (l) => void out.push(l) }), 0);
  assert.ok(out.includes(`no read model under ${dbDir}`), out.join("\n"));

  const messages: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], post: (m) => void messages.push(m), oracle: "off" });
  t.after(() => void ticker.release());
  ticker.tick();
  assert.ok(existsSync(join(dbDir, "core.v1.sqlite")), "the worker created the scratch directory and a fresh DB in it");
  assert.deepEqual(readdirSync(join(stateDir, "read-model")).filter((f) => f.endsWith(".sqlite")), [], "no DB file is written to the state disk");
  const db = openProjectorReadModel(stateDir, "core");
  t.after(() => db.close());
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM seen").get()?.n), ROWS, "every ledger row was projected: a full rebuild");

  out.length = 0;
  assert.equal(readModelCommand(["status"], { stateDir, out: (l) => void out.push(l) }), 0);
  assert.match(out.join("\n"), /core v1: seen 40/, "status reads the DB where it now lives");
});

test("the DB dir mapping applies only to the state dir it names", () => {
  assert.equal(readModelDbDir("/home/node/Remudero/state", { [READ_MODEL_DB_DIR_ENV]: "/home/node/Remudero/state:/scratch/rm" }), "/scratch/rm");
  assert.equal(readModelDbDir("/home/node/Remudero/state/", { [READ_MODEL_DB_DIR_ENV]: "/home/node/Remudero/state:/scratch/rm" }), "/scratch/rm", "the same dir however it is spelled");
  assert.equal(readModelDbDir("/tmp/a-test-state", { [READ_MODEL_DB_DIR_ENV]: "/home/node/Remudero/state:/scratch/rm" }), "/tmp/a-test-state/read-model", "a test or worker with its own state dir is never redirected");
  assert.equal(readModelDbDir("/s", { [READ_MODEL_DB_DIR_ENV]: "/s:" }), "/s/read-model", "an empty target is ignored");
  assert.equal(readModelDbDir("/s", { [READ_MODEL_DB_DIR_ENV]: "/scratch/rm" }), "/s/read-model", "a value with no state dir is ignored");
  assert.equal(readModelDbDir("/s", {}), "/s/read-model");
});
