/**
 * W1-T13184: a host.memory_max.overcommitted row is written once per change of its values, not on every
 * recompute. MEASURED 2026-11-16 on the core ledger: 623 identical rows in 14.5 hours, because the repeat
 * check read only the last 400 ledger lines and consecutive rows for one container were 420-426 lines
 * apart. The check now reads memory-overcommit-<container>.json beside memory-peak-<container>.json.
 * These tests source the real deploy/resource-policy.sh against a fixture meminfo, state dir, fake docker
 * and fake cgroup tree, the way each-container-memory-max-comes-from-one-shared-host-budget.test.ts does.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const POLICY = join(REPO_ROOT, "deploy", "resource-policy.sh");
const CORE = "remudero-daemon", SERVE = "remudero-serve", CONSOLE = "remudero-console-daemon", SITE = "remudero-site-daemon";
const FLEET = [CORE, SERVE, CONSOLE, SITE];
// THE LIVE HOST, 2026-11-16: MemTotal 32,086 MiB, the recorded peaks, and the limits the containers run with.
const LIVE_MIB = 32086;
const RESERVE_MIB = 2048;
const PEAKS: Record<string, number> = { [CORE]: 24827, [SERVE]: 7379, [CONSOLE]: 4071, [SITE]: 2448 };
const RUNNING: Record<string, number> = { [CORE]: 24827, [SERVE]: 7680, [CONSOLE]: 4071, [SITE]: 2448 };
// The values the live ledger repeated all day: formula, own peak, kept; the deficit was 8,687 MiB in every row.
const LIVE_ROWS: Record<string, [number, number, number, number]> = {
  [CORE]: [16140, 24827, 8687, 24827],
  [SERVE]: [-1308, 7379, 8687, 7680],
  [CONSOLE]: [-4616, 4071, 8687, 4071],
  [SITE]: [-6239, 2448, 8687, 2448],
};

/** A fixture host with every fleet container running at its live peak and running limit. */
function liveHost(t: TestContext) {
  const { dir } = ownedFixtureDir(t, "overcommit-row-once");
  mkdirSync(join(dir, "state"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "ids"), { recursive: true });
  writeFileSync(join(dir, "meminfo"), `MemTotal:       ${LIVE_MIB * 1024} kB\n`);
  writeFileSync(join(dir, "bin", "docker"),
    `#!/bin/sh\n[ "$1" = inspect ] && [ -r "${dir}/ids/$4" ] && exec cat "${dir}/ids/$4"\nexit 1\n`, { mode: 0o755 });
  const scopes: Record<string, string> = {};
  for (const container of FLEET) {
    const id = String(FLEET.indexOf(container) + 1).repeat(64);
    writeFileSync(join(dir, "ids", container), id);
    const scope = join(dir, "cgroup", "system.slice", `docker-${id}.scope`);
    mkdirSync(scope, { recursive: true });
    writeFileSync(join(scope, "memory.peak"), `${PEAKS[container]! * 1048576}\n`);
    writeFileSync(join(scope, "memory.max"), `${RUNNING[container]! * 1048576}\n`);
    scopes[container] = scope;
  }
  return { dir, scopes };
}

/** Sources the policy in a clean environment and runs `script`. */
function policy(dir: string, script: string) {
  const run = spawnSync("bash", ["-c", `source "$1"; ${script}`, "policy", POLICY], {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, STATE_DIR: dir,
      RMD_INSTANCE_REGISTRY: "", RMD_RESOURCE_POLICY_REGISTRY: join(dir, "no-registry.yaml"),
      RMD_MEMINFO_PATH: join(dir, "meminfo"), RMD_CGROUP_ROOT: join(dir, "cgroup"),
    },
  });
  assert.equal(run.status, 0, `the policy is never fatal: ${run.stderr}`);
  return run.stdout;
}

/** One recompute for `container`: the value resource_policy_shared_memory_max sets, as the tuner and recycles call it. */
function recompute(dir: string, container: string) {
  const out = policy(dir, `resource_policy_shared_memory_max ${container}; printf "max=%s unlimited=%s formula=%s deficit=%s\\n" "$RP_MAX" "$RP_MAX_UNLIMITED" "$RP_MAX_FORMULA" "$RP_MAX_DEFICIT"`);
  const m = /^max=(\S*) unlimited=(\S*) formula=(\S*) deficit=(\S*)$/m.exec(out);
  assert.ok(m, out);
  return { max: m[1]!, unlimited: m[2]!, formula: m[3]!, deficit: m[4]! };
}

const ledger = (dir: string) => join(dir, "state", "ledger.ndjson");
const record = (dir: string, container: string) => join(dir, "state", `memory-overcommit-${container}.json`);

function rows(dir: string, container: string): Array<Record<string, unknown>> {
  if (!existsSync(ledger(dir))) return [];
  return readFileSync(ledger(dir), "utf8").split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.step === "host.memory_max.overcommitted" && row.container === container);
}
const values = (row: Record<string, unknown>) => [row.formula_mib, row.own_peak_mib, row.deficit_mib, row.kept_mib];

/** `n` other ledger rows, as the tuner and the daemon write between two recomputes. */
function otherRows(dir: string, n: number) {
  let text = "";
  for (let i = 0; i < n; i += 1) text += `{"ts":"2026-11-16T12:00:00.000Z","run_id":"R${i}","task_id":"W1-T1","step":"tuner.tick","lane":"host"}\n`;
  appendFileSync(ledger(dir), text);
}

test("W1-T13184 criterion 1: an unchanged overcommit row is not appended again after more than 400 other ledger lines", (t) => {
  const { dir } = liveHost(t);
  for (const container of FLEET) recompute(dir, container);
  for (const container of FLEET) {
    assert.equal(rows(dir, container).length, 1, `${container}: the first recompute writes one row`);
    assert.deepEqual(values(rows(dir, container)[0]!), LIVE_ROWS[container], `${container}: the live 2026-11-16 values`);
  }
  // The live gap: 420 and 426 lines between two core rows, more than the 400 lines the old check read.
  for (const gap of [426, 420, 1000]) {
    otherRows(dir, gap);
    for (const container of FLEET) recompute(dir, container);
  }
  for (const container of FLEET) assert.equal(rows(dir, container).length, 1, `${container}: still one row after ${426 + 420 + 1000} other lines`);
});

test("W1-T13184 criterion 2: a recompute whose formula, own peak, deficit or kept limit differs from the newest row appends one row", (t) => {
  const { dir, scopes } = liveHost(t);
  recompute(dir, CONSOLE);
  assert.equal(rows(dir, CONSOLE).length, 1);
  // Kept limit changes alone: console now runs with 6,000 MiB, above its own peak.
  writeFileSync(join(scopes[CONSOLE]!, "memory.max"), `${6000 * 1048576}\n`);
  recompute(dir, CONSOLE);
  otherRows(dir, 450);
  recompute(dir, CONSOLE);
  assert.deepEqual(rows(dir, CONSOLE).map(values), [LIVE_ROWS[CONSOLE], [-4616, 4071, 8687, 6000]]);
  // Formula changes (site measured 100 MiB more), and so the deficit with it.
  writeFileSync(join(scopes[SITE]!, "memory.peak"), `${2548 * 1048576}\n`);
  recompute(dir, CONSOLE);
  recompute(dir, CONSOLE);
  assert.deepEqual(rows(dir, CONSOLE).map(values).at(-1), [-4716, 4071, 8787, 6000]);
  assert.equal(rows(dir, CONSOLE).length, 3);
  // Own peak changes (console measured 4,500 MiB), and so the deficit with it.
  writeFileSync(join(scopes[CONSOLE]!, "memory.peak"), `${4500 * 1048576}\n`);
  recompute(dir, CONSOLE);
  recompute(dir, CONSOLE);
  assert.deepEqual(rows(dir, CONSOLE).map(values).at(-1), [-4716, 4500, 9216, 6000]);
  assert.equal(rows(dir, CONSOLE).length, 4);
  // Each of the four values alone, through the row writer the policy calls: one row per change, none per repeat.
  const write = (args: string) => policy(dir, `resource_policy_overcommit_row ${SITE} ${args}`);
  write("-6239 2448 8687 2448");
  write("-6239 2448 8687 2448");
  write("-6000 2448 8687 2448"); // formula
  write("-6000 2500 8687 2448"); // own peak
  write("-6000 2500 8500 2448"); // deficit
  write("-6000 2500 8500 2600"); // kept limit
  write("-6000 2500 8500 unlimited"); // kept limit: no ceiling
  write("-6000 2500 8500 unlimited");
  assert.deepEqual(rows(dir, SITE).map(values), [
    [-6239, 2448, 8687, 2448], [-6000, 2448, 8687, 2448], [-6000, 2500, 8687, 2448],
    [-6000, 2500, 8500, 2448], [-6000, 2500, 8500, 2600], [-6000, 2500, 8500, "unlimited"],
  ]);
  // A return to earlier values is a change from the newest row, so it is written.
  write("-6239 2448 8687 2448");
  assert.equal(rows(dir, SITE).length, 7);
});

test("W1-T13184 criterion 3: invariant:limits-unchanged, memory.max is today's arithmetic for the same peaks, floors and running limits", (t) => {
  const { dir, scopes } = liveHost(t);
  const budget = LIVE_MIB - RESERVE_MIB;
  // Overcommitted (the live host): each container keeps the larger of its own peak and its running limit,
  // on the first recompute (no record), on a repeat (record matches) and after the record is removed.
  for (const pass of ["first", "repeat", "repeat after 500 lines", "record removed"]) {
    if (pass === "repeat after 500 lines") otherRows(dir, 500);
    if (pass === "record removed") for (const container of FLEET) rmSync(record(dir, container), { force: true });
    for (const container of FLEET) {
      const formula = budget - FLEET.filter((c) => c !== container).reduce((sum, c) => sum + PEAKS[c]!, 0);
      const got = recompute(dir, container);
      assert.equal(got.max, String(Math.max(PEAKS[container]!, RUNNING[container]!)), `${container} (${pass})`);
      assert.equal(got.formula, String(formula), `${container} (${pass})`);
      assert.equal(got.deficit, String(PEAKS[container]! - formula), `${container} (${pass})`);
    }
  }
  // A running "max" is still kept as no ceiling.
  writeFileSync(join(scopes[SERVE]!, "memory.max"), "max\n");
  assert.deepEqual(recompute(dir, SERVE), { max: "", unlimited: "1", formula: "-1308", deficit: "8687" });
  // A roomy host: the formula governs, and no row or record is written.
  writeFileSync(join(dir, "meminfo"), `MemTotal:       ${64000 * 1024} kB\n`);
  rmSync(ledger(dir));
  for (const container of FLEET) {
    rmSync(record(dir, container), { force: true });
    const want = 64000 - RESERVE_MIB - FLEET.filter((c) => c !== container).reduce((sum, c) => sum + PEAKS[c]!, 0);
    assert.deepEqual(recompute(dir, container), { max: String(want), unlimited: "", formula: String(want), deficit: "" });
    assert.equal(existsSync(record(dir, container)), false, `${container}: no overcommit, no record`);
  }
  assert.equal(existsSync(ledger(dir)), false);
});

test("W1-T13184 criterion 4: the repeat check reads memory-overcommit-<container>.json beside memory-peak-<container>.json, not the ledger", (t) => {
  const { dir } = liveHost(t);
  recompute(dir, CORE);
  // The record sits beside the peak record and holds the last written values.
  assert.ok(existsSync(join(dir, "state", `memory-peak-${CORE}.json`)));
  assert.equal(policy(dir, `resource_policy_overcommit_file ${CORE}`), record(dir, CORE));
  assert.equal(readFileSync(record(dir, CORE), "utf8"),
    `{"container":"${CORE}","formula_mib":16140,"own_peak_mib":24827,"deficit_mib":8687,"kept_mib":24827}\n`);
  // The ledger is not read: with the ledger gone, the record alone says nothing changed, so nothing is written.
  rmSync(ledger(dir));
  recompute(dir, CORE);
  assert.equal(existsSync(ledger(dir)), false, "an unchanged record appends no row, whatever the ledger holds");
  // The record is read: removed, the next recompute appends one row and writes the record again.
  writeFileSync(ledger(dir), "");
  rmSync(record(dir, CORE));
  recompute(dir, CORE);
  assert.equal(rows(dir, CORE).length, 1);
  assert.ok(existsSync(record(dir, CORE)));
  // An unreadable record (another container's, or garbage) appends one row and is rewritten.
  writeFileSync(record(dir, CORE), "not json\n");
  recompute(dir, CORE);
  recompute(dir, CORE);
  assert.equal(rows(dir, CORE).length, 2);
  assert.match(readFileSync(record(dir, CORE), "utf8"), /^\{"container":"remudero-daemon","formula_mib":16140,/);
  // No temp file is left beside the record.
  assert.deepEqual(readdirSync(join(dir, "state")).filter((name) => name.includes(".tmp.")), []);
  // A ledger that cannot be written leaves the record as it was, so the row is tried again next time.
  rmSync(record(dir, CORE));
  rmSync(ledger(dir));
  mkdirSync(ledger(dir));
  recompute(dir, CORE);
  assert.equal(existsSync(record(dir, CORE)), false, "no row written, so no record");
});

