import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GARDEN_PRIORITY_DEGRADED_STEP, type GardenPassSpawn } from "../src/lib/garden-registry.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import * as runTask from "../src/run-task.js";

// W1-T5475: the daemon built its garden spawn with `childGardenPassSpawn()` and no options, so a refused
// `nice` (W1-T5365's garden.priority_degraded note) went to daemon stderr, where no ledger query sees it.

type Builder = (
  log: (step: string, extra?: Record<string, unknown>) => void,
  injected?: GardenPassSpawn,
  childOpts?: Record<string, unknown>,
) => GardenPassSpawn;
const build = (runTask as unknown as { daemonGardenPassSpawn?: Builder }).daemonGardenPassSpawn;

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-priority-ledger-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the daemon's garden spawn writes a refused nice through the ledger log, not to stderr", async (t) => {
  assert.equal(typeof build, "function", "run-task exports daemonGardenPassSpawn");
  const dir = scratch(t);
  const entry = join(dir, "pass.mjs");
  writeFileSync(entry, "process.exit(0);\n");
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = write;
  });
  const spawnPass = build!((step, extra) => void rows.push({ step, extra }), undefined, {
    execPath: process.execPath,
    execArgv: [],
    entry,
    setPriority: () => {
      throw new Error("EPERM: operation not permitted");
    },
    ionice: "true",
  });
  assert.equal(await spawnPass("backlog", [], { stopped: false }), 0);
  process.stderr.write = write;
  const notes = rows.filter((r) => r.step === GARDEN_PRIORITY_DEGRADED_STEP);
  assert.equal(notes.length, 1, `one note reaches the ledger log (rows: ${JSON.stringify(rows)})`);
  assert.equal(notes[0]!.extra?.how, "nice");
  assert.match(String(notes[0]!.extra?.error), /EPERM/);
  assert.ok(!stderr.join("").includes(GARDEN_PRIORITY_DEGRADED_STEP), "the note is not written to stderr");
});

test("an injected pass spawn is used as-is, bounded, and never reaches the child spawn", async () => {
  assert.equal(typeof build, "function", "run-task exports daemonGardenPassSpawn");
  const calls: string[] = [];
  const injected: GardenPassSpawn = async (name) => (calls.push(name), 7);
  const spawnPass = build!(() => {}, injected, { entry: join(tmpdir(), "never-spawned.mjs") });
  assert.equal(await spawnPass("plan", [], { stopped: false }), 7);
  assert.deepEqual(calls, ["plan"]);
});
