import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as registry from "../src/lib/garden-registry.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// MEASURED 2026-10-02 (research/loop-stall.md §1a): two garden children at once held ~3.7 GB (backlog) and ~3.6 GB
// (ci-friction) of RSS plus swap on a 15 GiB host; the daemon's main thread spent 38% of its samples waiting on swap-in.
// Every child inherited the daemon's flags and no limit (a bare node there reports an 8,240 MB heap limit).

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-heap-cap-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rows() {
  const out: Array<{ step: string; extra: Record<string, unknown> }> = [];
  return { out, log: (step: string, extra: Record<string, unknown> = {}) => void out.push({ step, extra }) };
}

test("a garden child is spawned with a heap cap that overrides any inherited one and is lowered in priority", async (t) => {
  const dir = scratch(t);
  const probe = join(dir, "probe.json");
  const entry = join(dir, "probe-pass.mjs");
  writeFileSync(
    entry,
    'import { writeFileSync } from "node:fs"; import { getHeapStatistics } from "node:v8";\n' +
      "writeFileSync(process.env.GARDEN_PROBE_OUT, JSON.stringify({ pid: process.pid, execArgv: process.execArgv, " +
      "args: process.argv.slice(2), heapLimit: getHeapStatistics().heap_size_limit }));\n" +
      "await new Promise((r) => setTimeout(r, 300));\n",
  );
  const ioniceArgs = join(dir, "ionice-args");
  const ionice = join(dir, "fake-ionice");
  writeFileSync(ionice, `#!/bin/sh\necho "$@" > '${ioniceArgs}'\n`);
  chmodSync(ionice, 0o755);
  const priorities: Array<[number, number]> = [];
  const { out, log } = rows();
  const spawnPass = registry.childGardenPassSpawn({
    execPath: process.execPath,
    execArgv: ["--max-old-space-size=8192"],
    entry,
    env: { ...process.env, GARDEN_PROBE_OUT: probe },
    setPriority: (pid, priority) => void priorities.push([pid, priority]),
    ionice,
    log,
  });
  assert.equal(await spawnPass("plan", [], { stopped: false }), 0);
  const seen = JSON.parse(readFileSync(probe, "utf8")) as { pid: number; execArgv: string[]; args: string[]; heapLimit: number };
  const capFlag = `--max-old-space-size=${registry.GARDEN_CHILD_HEAP_LIMIT_MB}`;
  assert.equal(seen.execArgv.at(-1), capFlag, "the cap comes after the inherited flags, so it wins");
  assert.ok(seen.heapLimit / 1048576 < 8192, `the child's own heap limit is the cap, not the inherited 8192 MB (${seen.heapLimit})`);
  assert.ok(registry.GARDEN_CHILD_HEAP_LIMIT_MB < 8192, "the inherited value in this test must sit above the cap to discriminate");
  assert.deepEqual(seen.args, ["garden", "run", "plan"]);
  assert.deepEqual(priorities, [[seen.pid, registry.GARDEN_CHILD_NICENESS]], "the child's own pid is niced");
  assert.ok(registry.GARDEN_CHILD_NICENESS > 0, "niceness lowers priority");
  assert.equal(readFileSync(ioniceArgs, "utf8").trim(), `-c 3 -p ${seen.pid}`, "the child's IO runs in the idle class");
  assert.deepEqual(out, [], "a host that lowers both priorities logs nothing");
});

test("a priority call that throws neither fails the spawn nor the pass, and a child that exits non-zero resolves with its exit code", async (t) => {
  const dir = scratch(t);
  const entry = join(dir, "failing-pass.mjs");
  writeFileSync(entry, "process.exit(3);\n");
  const { out, log } = rows();
  const spawnPass = registry.childGardenPassSpawn({
    execPath: process.execPath,
    execArgv: [],
    entry,
    setPriority: () => {
      throw new Error("EPERM: operation not permitted");
    },
    ionice: join(dir, "no-such-ionice"),
    log,
  });
  assert.equal(await spawnPass("backlog", [], { stopped: false }), 3);
  assert.equal(await spawnPass("backlog", [], { stopped: false }), 3);
  const notes = out.filter((r) => r.step === registry.GARDEN_PRIORITY_DEGRADED_STEP);
  assert.deepEqual(notes.map((r) => r.extra.how).sort(), ["ionice", "nice"], "each refusal is logged once, not once per pass");
  assert.match(String(notes.find((r) => r.extra.how === "nice")?.extra.error), /EPERM/);
});

test("a garden child that runs out of its heap cap is ledgered as heap_exhausted, distinct from an ordinary failed pass", async (t) => {
  const dir = scratch(t);
  const hog = join(dir, "hog-pass.mjs");
  writeFileSync(hog, "const a = []; for (;;) a.push(new Array(1e5).fill(1));\n");
  const failing = join(dir, "failing-pass.mjs");
  writeFileSync(failing, "process.exit(1);\n");
  const passRow = async (entry: string, heapLimitMb?: number) => {
    const { out, log } = rows();
    const spawnPass = registry.childGardenPassSpawn({ execPath: process.execPath, execArgv: [], entry, cwd: dir, heapLimitMb, log });
    const garden = registry.startGardenOffLoop("config", 60 * 60 * 1000, { spawnPass, log });
    t.after(() => garden.stop());
    for (let waited = 0; !out.some((r) => r.step === registry.GARDEN_PASS_STEP) && waited < 30_000; waited += 25) await wait(25);
    return out.find((r) => r.step === registry.GARDEN_PASS_STEP)!.extra;
  };
  const oom = await passRow(hog, 32);
  assert.equal(oom.exit, null);
  assert.match(String(oom.error), new RegExp(`^${registry.GARDEN_HEAP_EXHAUSTED}: .*32 MB heap cap`));
  const ordinary = await passRow(failing);
  assert.equal(ordinary.exit, 1);
  assert.equal(ordinary.error, undefined, "an ordinary failure carries its exit code and no heap verdict");
});

test("with no log wired, a priority refusal is still noted, on stderr", async (t) => {
  const dir = scratch(t);
  const entry = join(dir, "ok-pass.mjs");
  writeFileSync(entry, "\n");
  const written: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => (written.push(String(chunk)), true));
  const spawnPass = registry.childGardenPassSpawn({
    execPath: process.execPath,
    execArgv: [],
    entry,
    setPriority: () => {
      throw new Error("EACCES");
    },
    ionice: join(dir, "no-such-ionice"),
  });
  assert.equal(await spawnPass("plan", [], { stopped: false }), 0);
  t.mock.restoreAll();
  assert.ok(written.some((w) => w.includes(registry.GARDEN_PRIORITY_DEGRADED_STEP) && w.includes("EACCES")), written.join(""));
});
