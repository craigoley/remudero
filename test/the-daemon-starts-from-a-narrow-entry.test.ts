import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { childGardenPassSpawn, GARDEN_CHILD_HEAP_LIMIT_MB } from "#src/lib/garden-registry.js";
import { childMeasurementCadenceSpawn, MEASUREMENT_CADENCE_CHILD_FLAG } from "#src/lib/measurement-cadence.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("W1-T9091: garden and cadence children start their own entries", async (t) => {
  const fixture = ownedFixtureDir(t, "t9091-child-entries");
  const launches: string[][] = [];
  const spawn = childProcess.spawn;
  const spy = t.mock.method(childProcess, "spawn", (file: string, args: string[], options: SpawnOptions) => {
    if (file !== process.execPath) return spawn(file, args, options);
    launches.push(args);
    const child = spawn(file, ["-e", "process.exit(0)"], options);
    child.once("spawn", () => child.ref());
    fixture.until(new Promise<void>((done) => child.once("close", () => done())));
    return child;
  });
  const parentFlags = [...process.execArgv];
  const parentEntry = process.argv[1];
  process.execArgv.push("--import", "/daemon-only-preload.mjs");
  process.argv[1] = "/daemon-main.ts";
  syncBuiltinESMExports();
  try {
    const garden = childGardenPassSpawn({ root: fixture.dir, reserve: () => undefined, setPriority: () => {}, log: () => {} });
    assert.equal(await garden("plan", ["--hourly"], { stopped: false }), 0);

    const statePath = join(fixture.dir, "cadence.json");
    const cadenceEntry = join(REPO_ROOT, "src", "measurement-cadence-child.ts");
    const cadence = childMeasurementCadenceSpawn({
      entry: relative(fixture.dir, cadenceEntry), cwd: fixture.dir, heapLimitMb: 512, setPriority: () => {},
    });
    assert.ok(cadence("CADENCE-RUN", statePath) > 0);

    assert.equal(launches.length, 2);
    assert.ok(launches.every((args) => !args.includes("/daemon-only-preload.mjs")));
    const gardenArgs = launches[0]!;
    assert.ok(gardenArgs.includes(`--max-old-space-size=${GARDEN_CHILD_HEAP_LIMIT_MB}`));
    const gardenEntry = gardenArgs.at(-5);
    assert.ok(gardenEntry === join(REPO_ROOT, "src", "run-task.ts") || gardenEntry?.endsWith("/run-task.mjs"), gardenEntry);
    assert.deepEqual(gardenArgs.slice(-4), ["garden", "run", "plan", "--hourly"]);
    assert.deepEqual(launches[1]!.slice(-4), [cadenceEntry, MEASUREMENT_CADENCE_CHILD_FLAG, statePath, "CADENCE-RUN"]);
    assert.deepEqual(launches[1]!.slice(0, 2), ["--max-old-space-size=512", "--import"]);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
    process.execArgv.splice(0, process.execArgv.length, ...parentFlags);
    if (parentEntry === undefined) delete process.argv[1];
    else process.argv[1] = parentEntry;
  }
});
