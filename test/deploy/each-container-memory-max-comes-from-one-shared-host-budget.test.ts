/**
 * W1-T11130, operator ruling R1 (2026-10-27): every fleet container's memory.max comes from ONE shared
 * host budget. That is MemTotal less RMD_HOST_RESERVE_MIB less the OTHER containers' learned peaks.
 * Before this, each build daemon got total - 5120 - 2048 (24.3 GiB each for core, console and site on
 * the 32 GiB host) and serve got a fixed 7,680 MiB, so together they could overcommit the host.
 * These tests source the real deploy/resource-policy.sh against a fixture meminfo and state dir.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const POLICY = join(REPO_ROOT, "deploy", "resource-policy.sh");
const HOST_MIB = 32000;
const RESERVE_MIB = 2048;
const CORE = "remudero-daemon", SERVE = "remudero-serve", CONSOLE = "remudero-console-daemon", SITE = "remudero-site-daemon";
const FLEET = [CORE, SERVE, CONSOLE, SITE];
const FLOORS: Record<string, number> = { [CORE]: 8192, [SERVE]: 5632, [CONSOLE]: 2048, [SITE]: 2304 };

function host(t: TestContext, meminfo = `MemTotal:       ${HOST_MIB * 1024} kB\n`) {
  const { dir } = ownedFixtureDir(t, "shared-memory-budget");
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "meminfo"), meminfo);
  return dir;
}

/** The tuner's learned memory.high record and the recorded cgroup memory.peak, beside each other. */
function learn(dir: string, container: string, learned: { high?: number; peak?: number }) {
  if (learned.high !== undefined) {
    writeFileSync(join(dir, "state", `memory-high-tuned-${container}.json`),
      `{"container":"${container}","high_mib":${learned.high},"policy_mib":1,"reason":"grow"}\n`);
  }
  if (learned.peak !== undefined) {
    writeFileSync(join(dir, "state", `memory-peak-${container}.json`), `{"container":"${container}","peak_mib":${learned.peak}}\n`);
  }
}

/**
 * A RUNNING container whose cgroup memory.peak reads `peakMib`: a fake `docker inspect` answering with the
 * container's id, and the cgroup scope directory the production writer looks the id up in. A container
 * never passed here is not running, as on a real host.
 */
function running(dir: string, container: string, peakMib: number) {
  const id = String(FLEET.indexOf(container) + 1).repeat(64);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "ids"), { recursive: true });
  writeFileSync(join(dir, "bin", "docker"),
    `#!/bin/sh\n[ "$1" = inspect ] && [ -r "${dir}/ids/$4" ] && exec cat "${dir}/ids/$4"\nexit 1\n`, { mode: 0o755 });
  writeFileSync(join(dir, "ids", container), id);
  const scope = join(dir, "cgroup", "system.slice", `docker-${id}.scope`);
  mkdirSync(scope, { recursive: true });
  writeFileSync(join(scope, "memory.peak"), `${peakMib * 1048576}\n`);
  return scope;
}

/** Sources the policy in a clean environment and runs `script`; every RMD_* knob is at its default. */
function policy(dir: string, script: string, env: Record<string, string | undefined> = {}, source = POLICY) {
  const run = spawnSync("bash", ["-c", `source "$1"; ${script}`, "policy", source], {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, STATE_DIR: dir,
      // Set but empty: no instance registry, so the repo's own registry (host paths) is never read.
      RMD_INSTANCE_REGISTRY: "",
      RMD_MEMINFO_PATH: join(dir, "meminfo"), RMD_CGROUP_ROOT: join(dir, "cgroup"), ...env,
    },
  });
  assert.equal(run.status, 0, `the policy is never fatal: ${run.stderr}`);
  return run.stdout;
}

/** The --memory value (MiB) each launcher gets for `container`, and its policy note. */
function memoryMax(dir: string, container: string, env: Record<string, string | undefined> = {}, source = POLICY) {
  const script = container === SERVE
    ? 'resource_policy_serve_args; printf "%s\\n" "${RESOURCE_POLICY_SERVE_ARGS[@]}"; printf "note=%s\\n" "$RESOURCE_POLICY_NOTE"'
    : 'resource_policy_build_args "$2"; printf "%s\\n" "${RESOURCE_POLICY_BUILD_ARGS[@]}"; printf "note=%s\\n" "$RESOURCE_POLICY_NOTE"';
  const out = policy(dir, script.replace('"$2"', `"${container}"`), env, source);
  const flag = /^--memory=(\d+)m$/m.exec(out);
  return { mib: flag ? Number(flag[1]) : undefined, note: /^note=(.*)$/m.exec(out)?.[1] ?? "", out };
}

test("each container's memory.max is the host less the reserve less the OTHER containers' learned peaks, serve included", (t) => {
  const dir = host(t);
  // Peaks that fit the 29,952 MiB budget together, each learned a different way. The memory.peak values are
  // NOT written by the test into the policy's store: the running containers' cgroups report them and the
  // production writer (resource_policy_record_peak) records them.
  const peaks: Record<string, number> = { [CORE]: 12288, [SERVE]: 6144, [CONSOLE]: 3072, [SITE]: 2560 };
  learn(dir, CORE, { high: 11264 });
  running(dir, CORE, peaks[CORE]!); // memory.peak above the learned memory.high
  learn(dir, SERVE, { high: peaks[SERVE] });
  running(dir, SERVE, 5000); // the learned memory.high above memory.peak
  running(dir, CONSOLE, peaks[CONSOLE]!); // memory.peak alone
  learn(dir, SITE, { high: peaks[SITE] }); // the learned memory.high alone, and not running
  assert.equal(policy(dir, 'resource_policy_recorded_peak remudero-daemon || echo none'), "none\n", "nothing is recorded before the policy runs");
  const budget = HOST_MIB - RESERVE_MIB;
  const limits: Record<string, number> = {};
  for (const container of FLEET) {
    const others = FLEET.filter((c) => c !== container).reduce((sum, c) => sum + peaks[c]!, 0);
    const got = memoryMax(dir, container);
    limits[container] = got.mib!;
    assert.equal(got.mib, budget - others, `${container}: host ${HOST_MIB} - reserve ${RESERVE_MIB} - others ${others}\n${got.out}`);
    assert.match(got.note, new RegExp(`memory\\.max ${budget - others} MiB = shared budget: host ${HOST_MIB} - reserve ${RESERVE_MIB}`));
    for (const other of FLEET.filter((c) => c !== container)) assert.match(got.note, new RegExp(`- ${other} ${peaks[other]} \\(`), `the note names ${other}'s term`);
  }
  // THE INVARIANT the formula gives (not "the four limits sum to the host", which it never claimed): for EVERY
  // container, that container at its memory.max beside the other three at their learned peaks fills the host
  // less the reserve exactly. So no state the fleet can reach by one container growing exceeds the host.
  const sumPeaks = FLEET.reduce((sum, c) => sum + peaks[c]!, 0);
  for (const container of FLEET) {
    const usage = FLEET.reduce((sum, c) => sum + (c === container ? limits[c]! : peaks[c]!), 0);
    assert.equal(usage + RESERVE_MIB, HOST_MIB, `${container} at its limit, the rest at their peaks: ${usage} MiB used`);
    for (const grown of FLEET.filter((c) => c !== container)) {
      assert.ok(limits[container]! + peaks[grown]! + RESERVE_MIB <= HOST_MIB, `${container} at its limit and ${grown} at its peak fit the host`);
    }
  }
  // And no container is capped below what it has been measured to need: every limit is at least its own peak.
  for (const container of FLEET) assert.ok(limits[container]! >= peaks[container]!, `${container}: limit ${limits[container]} is not below its own peak ${peaks[container]}`);
  // The limits themselves are overlapping ceilings: together they exceed the budget by 3 x the measured peaks.
  assert.equal(FLEET.reduce((sum, c) => sum + limits[c]!, 0), 4 * budget - 3 * sumPeaks);
  // Serve is no longer the fixed 7,680 MiB, and no build daemon is the old total - 5120 - 2048.
  assert.notEqual(memoryMax(dir, SERVE).mib, 7680);
  assert.notEqual(memoryMax(dir, CORE).mib, HOST_MIB - 5120 - 2048);
  // The writer left the running containers' cgroup memory.peak where the policy reads it, and only theirs.
  assert.match(readFileSync(join(dir, "state", `memory-peak-${CORE}.json`), "utf8"), new RegExp(`"container":"${CORE}","peak_mib":12288`));
  assert.equal(policy(dir, `resource_policy_recorded_peak ${SERVE}`), "5000");
  assert.equal(policy(dir, `resource_policy_recorded_peak ${CONSOLE}`), "3072");
  assert.equal(existsSync(join(dir, "state", `memory-peak-${SITE}.json`)), false, "a container that is not running gets no record");
});

test("W1-T11130: the recorded memory.peak is a high-water mark that advances as a container grows", (t) => {
  const dir = host(t);
  const serveScope = running(dir, SERVE, 6144);
  running(dir, CONSOLE, 3072);
  // Core's limit: the budget less serve's and console's measured peaks, and site's floor (it is not running).
  const coreMax = (serve: number) => HOST_MIB - RESERVE_MIB - serve - 3072 - FLOORS[SITE]!;
  assert.equal(memoryMax(dir, CORE).mib, coreMax(6144), "serve's measured 6144 and console's 3072 replace their floors");
  // Serve grows to 9216 MiB: the next recycle of core gives that headroom back, from measured slack only.
  writeFileSync(join(serveScope, "memory.peak"), `${9216 * 1048576}\n`);
  assert.equal(memoryMax(dir, CORE).mib, coreMax(9216));
  assert.match(memoryMax(dir, CORE).note, new RegExp(`- ${SERVE} 9216 \\(memory\\.peak\\)`));
  // Serve restarts: its new cgroup's memory.peak starts low, but the learned peak is not forgotten.
  writeFileSync(join(serveScope, "memory.peak"), `${1024 * 1048576}\n`);
  assert.equal(memoryMax(dir, CORE).mib, coreMax(9216));
  assert.equal(policy(dir, `resource_policy_recorded_peak ${SERVE}`), "9216");
  // A non-numeric memory.peak never corrupts the record or fails the policy.
  writeFileSync(join(serveScope, "memory.peak"), "max\n");
  assert.equal(memoryMax(dir, CORE).mib, coreMax(9216));
});

test("W1-T11130 criterion 2: a container with no learned peak yet counts its policy floor as its peak", (t) => {
  const dir = host(t); // an empty state dir: nothing learned for anyone
  for (const container of FLEET) {
    const others = FLEET.filter((c) => c !== container).reduce((sum, c) => sum + FLOORS[c]!, 0);
    const got = memoryMax(dir, container);
    assert.equal(got.mib, HOST_MIB - RESERVE_MIB - others, got.out);
    for (const other of FLEET.filter((c) => c !== container)) {
      assert.match(got.note, new RegExp(`- ${other} ${FLOORS[other]} \\(floor, nothing learned\\)`));
    }
    // Each limit beside the others' floors (their peaks, nothing learned) fills the host less the reserve.
    assert.equal(got.mib! + others + RESERVE_MIB, HOST_MIB, `${container} at its limit beside the others' floors`);
  }
  // The old per-container arithmetic gave 24.3 GiB to each of three build daemons; no limit is that now.
  for (const container of [CORE, CONSOLE, SITE]) assert.ok(memoryMax(dir, container).mib! < HOST_MIB - 5120 - 2048);
});

test("W1-T11130 criterion 2: a learned peak is re-read at every recycle, so the budget follows measured use", (t) => {
  const dir = host(t);
  learn(dir, SERVE, { peak: 6144 });
  // Two recycles in ONE shell: the second must see the peak written between them, never a cached one.
  const out = policy(dir, [
    `resource_policy_build_args ${CORE}; printf "first=%s\\n" "\${RESOURCE_POLICY_BUILD_ARGS[*]}"`,
    `printf '{"container":"${SERVE}","peak_mib":9216}\\n' > "$STATE_DIR/state/memory-peak-${SERVE}.json"`,
    `resource_policy_build_args ${CORE}; printf "second=%s\\n" "\${RESOURCE_POLICY_BUILD_ARGS[*]}"; printf "note=%s\\n" "$RESOURCE_POLICY_NOTE"`,
  ].join("; "));
  const base = HOST_MIB - RESERVE_MIB - FLOORS[CONSOLE]! - FLOORS[SITE]!;
  assert.match(out, new RegExp(`^first=.*--memory=${base - 6144}m`, "m"));
  assert.match(out, new RegExp(`^second=.*--memory=${base - 9216}m`, "m"), "serve grew by 3 GiB, so core's limit gave back 3 GiB");
  assert.match(out, new RegExp(`- ${SERVE} 9216 \\(memory\\.peak\\)`));
});

test("W1-T11130: an overcommitted host still follows the shared-budget formula; no other arithmetic stands in", (t) => {
  // The reviewer's case: a readable MemTotal of 15988 MiB (the 15.6 GiB host). With nothing learned the
  // others' floors are the peaks, so core gets 15988 - 2048 - 5632 - 2048 - 2304, NOT total - 5120 - 2048.
  const small = host(t, `MemTotal:       ${15988 * 1024} kB\n`);
  const core = memoryMax(small, CORE);
  assert.equal(core.mib, 15988 - RESERVE_MIB - FLOORS[SERVE]! - FLOORS[CONSOLE]! - FLOORS[SITE]!, core.out);
  assert.equal(core.mib, 3956);
  assert.notEqual(core.mib, 15988 - 5120 - 2048, "today's 8820 is gone");
  assert.doesNotMatch(core.note, /today's arithmetic|OVERCOMMITTED/);
  assert.match(core.note, /memory\.max 3956 MiB = shared budget: host 15988 - reserve 2048 - remudero-serve 5632 \(floor, nothing learned\)/);

  // Peaks that together exceed the host. A container with NO learned peak of its own has nothing to be
  // raised to, so it gets the formula as it is: a negative limit is no ceiling, and the note names it.
  const crowded = host(t);
  learn(crowded, CORE, { high: 30000 });
  const noCeiling = memoryMax(crowded, CONSOLE);
  assert.equal(noCeiling.mib, undefined, `a negative limit is no ceiling, not today's arithmetic: ${noCeiling.out}`);
  assert.match(noCeiling.note, /NO memory ceiling — memory\.max -7984 MiB = shared budget: host 32000 - reserve 2048 - remudero-daemon 30000 \(learned memory\.high\) - remudero-serve 5632 \(floor, nothing learned\) - remudero-site-daemon 2304 \(floor, nothing learned\), under the 2048 MiB floor/);
  assert.match(noCeiling.out, /--annotation=org\.systemd\.property\.MemoryHigh=uint64 \d+/, "memory.high is still sized with no memory.max to stay under");
  assert.deepEqual(overcommitRows(crowded), [], "a floor is not a measurement, so a container with none learned is never overcommitted");
  // Console then LEARNS a 4608 MiB peak: its memory.max is the LARGER of the formula (still -7984 MiB, its own
  // peak is no term of it) and that peak, so it is never capped below what it has been measured to need.
  learn(crowded, CONSOLE, { peak: 4608 });
  const raised = memoryMax(crowded, CONSOLE);
  assert.equal(raised.mib, 4608, raised.out);
  assert.match(raised.note, /memory\.max 4608 MiB = its own learned peak \(memory\.peak\), larger than the shared-budget formula -7984 MiB: OVERCOMMITTED, deficit 12592 MiB; formula: host 32000 - reserve 2048 - remudero-daemon 30000/);
  assert.match(raised.out, /^--memory-swap=8704m$/m, "the swap rides the raised ceiling");
  // Core: the formula (29952 - console 4608 - serve 5632 - site 2304 = 17408) is below core's own 30000.
  const core = memoryMax(crowded, CORE);
  assert.equal(core.mib, 30000, core.out);
  assert.match(core.note, /memory\.max 30000 MiB = its own learned peak \(learned memory\.high\), larger than the shared-budget formula 17408 MiB: OVERCOMMITTED, deficit 12592 MiB/);
  // Its own peak grows: the limit follows it up, the formula does not move.
  learn(crowded, CORE, { high: 31000, peak: 31000 });
  const grown = memoryMax(crowded, CORE);
  assert.equal(grown.mib, 31000, "core's own learned peak is a floor under core's limit");
  assert.match(grown.note, /larger than the shared-budget formula 17408 MiB: OVERCOMMITTED, deficit 13592 MiB/);
  // Serve is sized the same way: with no peak of its own the formula's negative number means no ceiling,
  // and once it has measured 6144 MiB it keeps a 6144 MiB ceiling instead.
  const serve = memoryMax(crowded, SERVE);
  assert.equal(serve.mib, undefined, serve.out);
  assert.match(serve.note, /NO memory ceiling — -\d+ MiB \(memory\.max -\d+ MiB = shared budget: host 32000 - reserve 2048 - remudero-daemon 31000 \(/);
  learn(crowded, SERVE, { peak: 6144 });
  const serveRaised = memoryMax(crowded, SERVE);
  assert.equal(serveRaised.mib, 6144, serveRaised.out);
  assert.match(serveRaised.note, /memory ceiling 6144 MiB \(\+2048 MiB swap\) from memory\.max 6144 MiB = its own learned peak \(memory\.peak\), larger than the shared-budget formula -\d+ MiB: OVERCOMMITTED, deficit \d+ MiB/);
  // Own peak under the formula: the formula stands and nothing is overcommitted.
  const roomy = host(t);
  learn(roomy, CORE, { peak: 4096 });
  const fits = memoryMax(roomy, CORE);
  assert.equal(fits.mib, 29952 - FLOORS[SERVE]! - FLOORS[CONSOLE]! - FLOORS[SITE]!, fits.out);
  assert.doesNotMatch(fits.note, /OVERCOMMITTED|deficit/);
  assert.deepEqual(overcommitRows(roomy), []);
});

/** The host.memory_max.overcommitted rows in <dir>/state/ledger.ndjson (all containers, or just one). */
function overcommitRows(dir: string, container?: string): Array<Record<string, unknown>> {
  const file = join(dir, "state", "ledger.ndjson");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.step === "host.memory_max.overcommitted" && (container === undefined || row.container === container));
}

test("W1-T11130 criterion 3: a formula below the container's own peak appends one host.memory_max.overcommitted ledger row", (t) => {
  const dir = host(t);
  learn(dir, CORE, { high: 30000 });
  learn(dir, CONSOLE, { peak: 4608 });
  // Console: formula 29952 - 30000 - 5632 - 2304 = -7984, own peak 4608, so the deficit is 12592 MiB.
  const first = memoryMax(dir, CONSOLE);
  assert.equal(first.mib, 4608, first.out);
  assert.match(first.note, /OVERCOMMITTED, deficit 12592 MiB/);
  const rows = overcommitRows(dir, CONSOLE);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.deepEqual(
    [rows[0]!.container, rows[0]!.formula_mib, rows[0]!.own_peak_mib, rows[0]!.deficit_mib, rows[0]!.lane, rows[0]!.task_id],
    [CONSOLE, -7984, 4608, 12592, "host", "HOST"],
  );
  assert.match(String(rows[0]!.ts), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
  // The same formula and peak at the next recycle, or the next drift check, is not ledgered again.
  memoryMax(dir, CONSOLE);
  assert.equal(overcommitRows(dir, CONSOLE).length, 1, "an unchanged overcommit is one row, not one per tick");
  // The deficit moves (console measured more): that is a new fact, so a second row.
  learn(dir, CONSOLE, { peak: 5120 });
  memoryMax(dir, CONSOLE);
  const after = overcommitRows(dir, CONSOLE);
  assert.equal(after.length, 2);
  assert.deepEqual([after[1]!.formula_mib, after[1]!.own_peak_mib, after[1]!.deficit_mib], [-7984, 5120, 13104]);
  // Core, whose own 30000 is above ITS formula too, is ledgered under its own name; serve (nothing learned) is not.
  memoryMax(dir, CORE);
  memoryMax(dir, SERVE);
  const coreRows = overcommitRows(dir, CORE);
  assert.equal(coreRows.length, 1);
  assert.deepEqual([coreRows[0]!.formula_mib, coreRows[0]!.own_peak_mib, coreRows[0]!.deficit_mib], [29952 - 5120 - FLOORS[SERVE]! - FLOORS[SITE]!, 30000, 30000 - (29952 - 5120 - FLOORS[SERVE]! - FLOORS[SITE]!)]);
  assert.deepEqual(overcommitRows(dir, SERVE), []);
  // Nothing is ledgered while every formula holds.
  const calm = host(t);
  learn(calm, CORE, { peak: 4096 });
  memoryMax(calm, CORE);
  assert.equal(existsSync(join(calm, "state", "ledger.ndjson")), false, "no overcommit, so no ledger file is created");
});

test("W1-T11130 criterion 3: the overcommit row never fails the policy when the ledger cannot be written", (t) => {
  const dir = host(t);
  learn(dir, CORE, { high: 30000 });
  learn(dir, CONSOLE, { peak: 4608 });
  // A directory where the ledger file should be: the append fails, and the limit is still raised.
  mkdirSync(join(dir, "state", "ledger.ndjson"));
  const got = memoryMax(dir, CONSOLE);
  assert.equal(got.mib, 4608, got.out);
  assert.match(got.note, /OVERCOMMITTED, deficit 12592 MiB/);
});

test("W1-T11130 criterion 2: an unreadable host total keeps today's arithmetic and is never fatal", (t) => {
  const dir = host(t, "FixtureWithoutMemTotal: 0\n");
  learn(dir, CORE, { peak: 12288 });
  const serve = memoryMax(dir, SERVE);
  assert.equal(serve.mib, 7680, `serve keeps today's fixed ceiling: ${serve.out}`);
  assert.match(serve.out, /^--memory-swap=9728m$/m);
  assert.match(serve.note, /memory ceiling 7680 MiB \(\+2048 MiB swap\) from today's fixed 7680 MiB, host MemTotal unreadable/);
  const build = memoryMax(dir, CORE);
  assert.equal(build.mib, undefined, `a build daemon keeps today's no-ceiling: ${build.out}`);
  assert.match(build.note, /NO memory ceiling — host MemTotal unreadable/);
});

test("W1-T11130 criterion 2: an explicit RMD_SERVE_MEMORY_LIMIT_MIB stays an operator override, named in the policy note", (t) => {
  const dir = host(t);
  const override = memoryMax(dir, SERVE, { RMD_SERVE_MEMORY_LIMIT_MIB: "6144" });
  assert.equal(override.mib, 6144, override.out);
  assert.match(override.out, /^--memory-swap=8192m$/m);
  assert.match(override.note, /memory ceiling 6144 MiB \(\+2048 MiB swap\) from operator override RMD_SERVE_MEMORY_LIMIT_MIB=6144/);
  const off = memoryMax(dir, SERVE, { RMD_SERVE_MEMORY_LIMIT_MIB: "0" });
  assert.equal(off.mib, undefined, "0 still turns serve's ceiling off");
  assert.match(off.note, /NO memory ceiling — 0 MiB \(operator override RMD_SERVE_MEMORY_LIMIT_MIB=0\)/);
  // Unset, serve takes its share of the shared budget rather than a fixed number.
  const shared = memoryMax(dir, SERVE);
  assert.equal(shared.mib, HOST_MIB - RESERVE_MIB - FLOORS[CORE]! - FLOORS[CONSOLE]! - FLOORS[SITE]!);
  assert.doesNotMatch(shared.note, /operator override/);
});

/**
 * Production layout: every instance's tuner records under ITS OWN state root (the registry's state_dir),
 * never beside a peer's. Three roots, one registry; serve is no registry instance, so its records live in
 * the root of whoever launches it (here core's).
 */
function instances(dir: string) {
  const roots = { core: join(dir, "core-root"), site: join(dir, "site-root"), console: join(dir, "console-root") };
  for (const root of Object.values(roots)) mkdirSync(join(root, "state"), { recursive: true });
  const registry = join(dir, "daemon-instances.yaml");
  writeFileSync(registry, [
    "instances:",
    `  core:\n    repo: remudero\n    container_name: ${CORE}\n    state_dir: ${roots.core}`,
    `  site:\n    repo: remudero-site  # the site\n    container_name: ${SITE}\n    state_dir: ${roots.site}`,
    `  console:\n    repo: remudero-console\n    container_name: ${CONSOLE}\n    state_dir: ${roots.console}`,
  ].join("\n") + "\n");
  return { roots, registry, env: (root: string) => ({ RMD_INSTANCE_REGISTRY: registry, STATE_DIR: root }) };
}

test("W1-T11130 criterion 3: a learned peak is read from the peer's own state root, not only the caller's", (t) => {
  const dir = host(t);
  const fleet = instances(dir);
  // Each peer's tuner wrote its record under its own root; the caller (core's recycle) has none of them.
  learn(fleet.roots.console, CONSOLE, { high: 4096 });
  learn(fleet.roots.site, SITE, { peak: 3072 });
  learn(fleet.roots.core, SERVE, { peak: 6144 }); // serve: no registry row, so the launching root
  const budget = HOST_MIB - RESERVE_MIB;
  const split = memoryMax(dir, CORE, fleet.env(fleet.roots.core));
  assert.equal(split.mib, budget - 4096 - 3072 - 6144, split.out);
  assert.match(split.note, new RegExp(`- ${CONSOLE} 4096 \\(learned memory\\.high\\)`));
  assert.match(split.note, new RegExp(`- ${SITE} 3072 \\(memory\\.peak\\)`));
  assert.match(split.note, new RegExp(`- ${SERVE} 6144 \\(memory\\.peak\\)`));
  // Discriminating: with no registry the same records are invisible and the peers count their floors.
  const blind = memoryMax(dir, CORE, { STATE_DIR: fleet.roots.core });
  assert.equal(blind.mib, budget - FLOORS[CONSOLE]! - FLOORS[SITE]! - 6144, blind.out);
  assert.notEqual(blind.mib, split.mib);
  // Site's recycle reads console's record from console's root. Serve is no registry row and its record is in
  // core's root, which is not site's caller root, so site counts serve's floor.
  const site = memoryMax(dir, SITE, fleet.env(fleet.roots.site));
  assert.equal(site.mib, budget - FLOORS[CORE]! - 4096 - FLOORS[SERVE]!, site.out);
  assert.match(site.note, new RegExp(`- ${CONSOLE} 4096 \\(learned memory\\.high\\)`));
  // The drift check evaluates the same policy, so it follows the same roots and finds the same limit.
  const drift = policy(dir, `resource_policy_build_args ${CORE}; printf "%s\\n" "\${RESOURCE_POLICY_BUILD_ARGS[@]}"`, fleet.env(fleet.roots.core));
  assert.match(drift, new RegExp(`^--memory=${budget - 4096 - 3072 - 6144}m$`, "m"));
  // A registry row whose state_dir is not on this host is skipped, never fatal: the floor stands.
  const away = join(dir, "away.yaml");
  writeFileSync(away, `instances:\n  console:\n    container_name: ${CONSOLE}\n    state_dir: ${join(dir, "no-such-root")}\n`);
  assert.equal(memoryMax(dir, CORE, { RMD_INSTANCE_REGISTRY: away, STATE_DIR: fleet.roots.core }).mib, blind.mib);
});

test("W1-T11130 criterion 3: the recorded memory.peak lands in the peer's own root, where every recycle reads it", (t) => {
  const dir = host(t);
  const fleet = instances(dir);
  running(dir, CONSOLE, 3072);
  // Core's recycle probes every fleet container: console's peak is recorded beside console's tuner record.
  memoryMax(dir, CORE, fleet.env(fleet.roots.core));
  assert.match(readFileSync(join(fleet.roots.console, "state", `memory-peak-${CONSOLE}.json`), "utf8"), new RegExp(`"container":"${CONSOLE}","peak_mib":3072`));
  assert.equal(existsSync(join(fleet.roots.core, "state", `memory-peak-${CONSOLE}.json`)), false, "not duplicated into the caller's root");
  // Site's recycle, from its own root and with console no longer running, still reads console's peak.
  rmSync(join(dir, "ids", CONSOLE));
  const site = memoryMax(dir, SITE, fleet.env(fleet.roots.site));
  assert.match(site.note, new RegExp(`- ${CONSOLE} 3072 \\(memory\\.peak\\)`), site.note);
  assert.equal(site.mib, HOST_MIB - RESERVE_MIB - FLOORS[CORE]! - 3072 - FLOORS[SERVE]!);
});

test("W1-T11130 criterion 3: each peer's peak is read from its own root the same with the registry unset, legacy, or an active selection", (t) => {
  const dir = host(t);
  const fleet = instances(dir);
  learn(fleet.roots.console, CONSOLE, { high: 4096 });
  learn(fleet.roots.site, SITE, { peak: 3072 });
  learn(fleet.roots.core, SERVE, { peak: 6144 }); // serve: the root where core's tuner records it
  const budget = HOST_MIB - RESERVE_MIB;
  const coreWant = budget - 4096 - 3072 - 6144;
  const serveWant = budget - FLOORS[CORE]! - 4096 - 3072;

  // UNSET: the registry beside the policy's own checkout (.remudero/daemon-instances.yaml) is the one read.
  const checkout = join(dir, "checkout");
  mkdirSync(join(checkout, "deploy"), { recursive: true });
  mkdirSync(join(checkout, ".remudero"), { recursive: true });
  const checkoutPolicy = join(checkout, "deploy", "resource-policy.sh");
  copyFileSync(POLICY, checkoutPolicy);
  copyFileSync(fleet.registry, join(checkout, ".remudero", "daemon-instances.yaml"));
  // ACTIVE SELECTION: the selected registry the launcher binds (RMD_INSTANCE_REGISTRY plus its digest and instance name).
  const selected = join(dir, "config", "selected-registry.yaml");
  mkdirSync(join(dir, "config"), { recursive: true });
  copyFileSync(fleet.registry, selected);
  const active = { RMD_INSTANCE_REGISTRY: selected, RMD_INSTANCE_REGISTRY_DIGEST: "a".repeat(64), RMD_INSTANCE_NAME: "core", STATE_DIR: fleet.roots.core };

  const modes: Record<string, { core: ReturnType<typeof memoryMax>; serve: ReturnType<typeof memoryMax> }> = {
    unset: {
      core: memoryMax(dir, CORE, { RMD_INSTANCE_REGISTRY: undefined, STATE_DIR: fleet.roots.core }, checkoutPolicy),
      serve: memoryMax(dir, SERVE, { RMD_INSTANCE_REGISTRY: undefined, STATE_DIR: fleet.roots.core }, checkoutPolicy),
    },
    legacy: {
      core: memoryMax(dir, CORE, fleet.env(fleet.roots.core)),
      serve: memoryMax(dir, SERVE, fleet.env(fleet.roots.core)),
    },
    active: { core: memoryMax(dir, CORE, active), serve: memoryMax(dir, SERVE, active) },
  };
  for (const [mode, got] of Object.entries(modes)) {
    assert.equal(got.core.mib, coreWant, `${mode}: core reads console's, site's and serve's peaks from their own roots\n${got.core.out}`);
    assert.match(got.core.note, new RegExp(`- ${CONSOLE} 4096 \\(learned memory\\.high\\)`), mode);
    assert.match(got.core.note, new RegExp(`- ${SITE} 3072 \\(memory\\.peak\\)`), mode);
    assert.match(got.core.note, new RegExp(`- ${SERVE} 6144 \\(memory\\.peak\\)`), mode);
    assert.equal(got.serve.mib, serveWant, `${mode}: serve, launched from core's root, reads the same peaks\n${got.serve.out}`);
    assert.equal(got.core.note, modes.legacy!.core.note, `${mode}: the policy note is the same in every mode`);
  }
  // Discriminating: with the registry turned off the peers' records are invisible and their floors count instead.
  const blind = memoryMax(dir, CORE, { STATE_DIR: fleet.roots.core });
  assert.equal(blind.mib, budget - FLOORS[CONSOLE]! - FLOORS[SITE]! - 6144, blind.out);
  assert.notEqual(blind.mib, coreWant);
});
