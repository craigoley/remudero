/**
 * W1-T6495 — the measurement-cadence child measures the config the daemon named, not $HOME's.
 *
 * The child entry used to call `buildMeasurementCadenceDaemonHooks()` with no config, so a daemon running
 * under any non-default config (an instance, an override, a test root) measured a different root out of
 * process than the one it measured in process.
 */
import assert from "node:assert/strict";
import { spawnSync, type spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { FIXTURE_CONFIG_PATH_SEGMENTS, type Config } from "../src/lib/config.js";
import {
  childMeasurementCadenceSpawn,
  MEASUREMENT_CADENCE_CHILD_CONFIG_ENV,
  MEASUREMENT_CADENCE_CHILD_FLAG,
  measurementCadenceChildMain,
  measurementCadenceChildRun,
  type MeasurementCadenceChildState,
  type MeasurementCadenceRunResult,
} from "../src/lib/measurement-cadence.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6495-`));
const configAt = (root: string): Config => ({ claudeBin: "/bin/true", root }) as Config;
const result = (): MeasurementCadenceRunResult => ({ ruleEfficacy: "SENTINEL" }) as unknown as MeasurementCadenceRunResult;

test("W1-T6495: the cadence child loads the config root it was spawned for", async () => {
  const daemonRoot = join(scratch(), "instance-root");
  const env = { [MEASUREMENT_CADENCE_CHILD_CONFIG_ENV]: JSON.stringify(configAt(daemonRoot)) };

  // The spawn carries the daemon's config to the child's environment.
  const launched: NodeJS.ProcessEnv[] = [];
  const fakeSpawn = ((_cmd: string, _argv: string[], o: { env: NodeJS.ProcessEnv }) => {
    launched.push(o.env);
    return { pid: 4242, unref: () => {} };
  }) as unknown as typeof spawn;
  childMeasurementCadenceSpawn({ entry: "entry.ts", execArgv: [], env: { HOME: "/home/other" }, config: configAt(daemonRoot), spawnChild: fakeSpawn, setPriority: () => {} })("RUN-1", "/s.json");
  assert.equal(launched[0]?.HOME, "/home/other", "the rest of the environment is preserved");
  assert.equal((JSON.parse(launched[0]?.[MEASUREMENT_CADENCE_CHILD_CONFIG_ENV] ?? "null") as Config).root, daemonRoot, "the child is handed the daemon's root");

  // The child builds its hooks over exactly that config and records a done row.
  const seen: (Config | undefined)[] = [];
  const statePath = join(scratch(), "state.json");
  const code = await measurementCadenceChildMain(statePath, "RUN-1", measurementCadenceChildRun(env, (config) => {
    seen.push(config);
    return { runMeasurementCadence: async () => result() };
  }));
  assert.equal(code, 0);
  assert.equal(seen[0]?.root, daemonRoot, "the hooks are built over the daemon's config root, not $HOME's");
  assert.equal((JSON.parse(readFileSync(statePath, "utf8")) as MeasurementCadenceChildState).status, "done");

  // With nothing named (a hand-run child) the hooks resolve their own config, as before.
  let unnamed: Config | undefined = configAt("sentinel");
  await measurementCadenceChildRun({}, (config) => { unnamed = config; return { runMeasurementCadence: async () => result() }; })();
  assert.equal(unnamed, undefined);
});

test("W1-T6495: a named config the child cannot read is a failed row, never a fallback to HOME", { timeout: 120_000 }, () => {
  // HOME holds a malformed config too, but a fallback to it would fail with a bare JSON error that never names the env var.
  const home = scratch();
  const homeConfig = join(home, ...FIXTURE_CONFIG_PATH_SEGMENTS);
  mkdirSync(dirname(homeConfig), { recursive: true });
  writeFileSync(homeConfig, "{not json");
  const statePath = join(scratch(), "state.json");
  const entry = fileURLToPath(new URL("../src/measurement-cadence-child.ts", import.meta.url));
  const child = spawnSync(process.execPath, ["--import", "tsx", entry, MEASUREMENT_CADENCE_CHILD_FLAG, statePath, "RUN-NAMED"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, HOME: home, USERPROFILE: home, [MEASUREMENT_CADENCE_CHILD_CONFIG_ENV]: "{named but broken" },
    encoding: "utf8",
    timeout: 110_000,
  });
  assert.equal(child.status, 1, `the child exits 1 (stderr: ${child.stderr})`);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as MeasurementCadenceChildState;
  assert.equal(state.status, "failed");
  assert.match(String(state.error), new RegExp(MEASUREMENT_CADENCE_CHILD_CONFIG_ENV), "the failure names the config the daemon handed over");
});
