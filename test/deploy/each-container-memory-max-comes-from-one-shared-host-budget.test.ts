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

/** The memory.max a RUNNING container's cgroup reports now: MiB, the literal "max", or any raw text. */
function runningLimit(scope: string, limit: number | "max" | string) {
  writeFileSync(join(scope, "memory.max"), typeof limit === "number" ? `${limit * 1048576}\n` : `${limit}\n`);
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

test("W1-T11130 criterion 1: an overcommitted host keeps each container's running limit, never below its own peak", (t) => {
  // THE LIVE HOST, 2026-11-04: MemTotal 32086 MiB, the measured peaks, and the limits each container runs with
  // today. Every formula is below its container's own peak, so the host is overcommitted: each container keeps
  // the larger of its own peak and the limit it runs with (operator ruling 2026-11-04, "keep today's limit").
  const LIVE_MIB = 32086;
  const dir = host(t, `MemTotal:       ${LIVE_MIB * 1024} kB\n`);
  const peaks: Record<string, number> = { [CORE]: 17027, [SERVE]: 7309, [CONSOLE]: 4977, [SITE]: 2051 };
  const today: Record<string, number> = { [CORE]: 24918, [SERVE]: 7680, [CONSOLE]: 24918, [SITE]: 24918 };
  for (const container of FLEET) runningLimit(running(dir, container, peaks[container]!), today[container]!);
  const budget = LIVE_MIB - RESERVE_MIB;
  for (const container of FLEET) {
    const formula = budget - FLEET.filter((c) => c !== container).reduce((sum, c) => sum + peaks[c]!, 0);
    assert.ok(formula < peaks[container]!, `${container}: the live host is overcommitted (formula ${formula} < peak ${peaks[container]})`);
    const got = memoryMax(dir, container);
    t.diagnostic(`${container}: own peak ${peaks[container]}, formula ${formula}, runs with ${today[container]} -> memory.max ${got.mib}`);
    assert.equal(got.mib, today[container], `${container} keeps the limit it runs with\n${got.out}`);
    assert.ok(got.mib! >= peaks[container]!, `${container} is never below its own peak`);
    assert.match(got.note, new RegExp(`memory\\.max ${today[container]} MiB kept = the ${today[container]} MiB it runs with now, above its own peak ${peaks[container]} \\(memory\\.peak\\): OVERCOMMITTED, the shared-budget formula ${formula} MiB is ${peaks[container]! - formula} MiB under its own peak`));
    const rows = overcommitRows(dir, container);
    assert.equal(rows.length, 1, `${container}: one overcommit row`);
    assert.deepEqual([rows[0]!.formula_mib, rows[0]!.own_peak_mib, rows[0]!.deficit_mib, rows[0]!.kept_mib],
      [formula, peaks[container], peaks[container]! - formula, today[container]]);
  }
  // Pin-at-peak (the superseded rule) would have cut core from 24918 to 17027 MiB with no room to learn more.
  assert.notEqual(memoryMax(dir, CORE).mib, peaks[CORE], "core is not pinned at its peak");
});

test("W1-T11130 criterion 1: an overcommitted container whose running limit is below its peak, or unknown, gets its own peak", (t) => {
  const dir = host(t, `MemTotal:       ${32086 * 1024} kB\n`);
  const peaks: Record<string, number> = { [CORE]: 17027, [SERVE]: 7309, [CONSOLE]: 4977, [SITE]: 2051 };
  const scopes: Record<string, string> = {};
  for (const container of FLEET) scopes[container] = running(dir, container, peaks[container]!);
  // Running below its own peak: never below measured need, so the own peak wins.
  runningLimit(scopes[CORE]!, 12000);
  const below = memoryMax(dir, CORE);
  assert.equal(below.mib, 17027, below.out);
  assert.match(below.note, /kept = its own peak 17027 \(memory\.peak\), at or above the 12000 MiB it runs with now: OVERCOMMITTED/);
  // An unreadable running limit: the own peak, and the note says it could not be read.
  runningLimit(scopes[CORE]!, "not-a-number");
  const unread = memoryMax(dir, CORE);
  assert.equal(unread.mib, 17027, unread.out);
  assert.match(unread.note, /its own peak 17027 \(memory\.peak\); the running container's memory\.max could not be read: OVERCOMMITTED/);
  // Not running (no container, no cgroup scope): the own peak.
  rmSync(join(dir, "ids", CORE));
  const stopped = memoryMax(dir, CORE);
  assert.equal(stopped.mib, 17027, stopped.out);
  assert.match(stopped.note, /its own peak 17027 \(memory\.peak\); no running container to keep a limit from: OVERCOMMITTED/);
  // A running "max" is a real no-ceiling: kept, and named.
  runningLimit(scopes[CONSOLE]!, "max");
  const open = memoryMax(dir, CONSOLE);
  assert.equal(open.mib, undefined, `a kept "max" is no ceiling: ${open.out}`);
  assert.match(open.note, /NO memory ceiling kept — the no-ceiling \(memory\.max "max"\) it runs with now: OVERCOMMITTED/);
  assert.match(open.out, /--annotation=org\.systemd\.property\.MemoryHigh=uint64 \d+/, "memory.high is still sized");
  assert.deepEqual(overcommitRows(dir, CONSOLE).at(-1)!.kept_mib, "unlimited");
  // Serve runs with "max" too: no --memory, and the note says why.
  runningLimit(scopes[SERVE]!, "max");
  const serveOpen = memoryMax(dir, SERVE);
  assert.equal(serveOpen.mib, undefined, serveOpen.out);
  assert.match(serveOpen.note, /NO memory ceiling kept — the no-ceiling/);
});

test("W1-T11130 criterion 1: a container with nothing learned counts its floor as its own peak, so a small host never leaves it under it", (t) => {
  // The 15.6 GiB host with nothing learned: core's formula is 15988 - 2048 - 5632 - 2048 - 2304 = 3956, below
  // core's 8192 floor (its own peak, criterion 2), so the host is overcommitted and, with no container running,
  // core gets its floor, never today's 8820 and never 3956.
  const small = host(t, `MemTotal:       ${15988 * 1024} kB\n`);
  const core = memoryMax(small, CORE);
  assert.equal(core.mib, FLOORS[CORE], core.out);
  assert.notEqual(core.mib, 15988 - 5120 - 2048, "today's 8820 is gone");
  assert.match(core.note, /memory\.max 8192 MiB kept = its own peak 8192 \(floor, nothing learned\); no running container to keep a limit from: OVERCOMMITTED, the shared-budget formula 3956 MiB is 4236 MiB under its own peak 8192/);
  // A roomy host: every formula covers its container's peak, so the formula governs and nothing is ledgered.
  const roomy = host(t, `MemTotal:       ${64000 * 1024} kB\n`);
  for (const container of FLEET) {
    const want = 64000 - RESERVE_MIB - FLEET.filter((c) => c !== container).reduce((sum, c) => sum + FLOORS[c]!, 0);
    runningLimit(running(roomy, container, FLOORS[container]!), 24918);
    const got = memoryMax(roomy, container);
    assert.equal(got.mib, want, `${container}: the formula wins on a roomy host\n${got.out}`);
    assert.doesNotMatch(got.note, /OVERCOMMITTED|kept/);
  }
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
  // Console: formula 29952 - 30000 - 5632 - 2304 = -7984, own peak 4608, so the deficit is 12592 MiB. Console is
  // not running, so it keeps its own peak.
  const first = memoryMax(dir, CONSOLE);
  assert.equal(first.mib, 4608, first.out);
  assert.match(first.note, /OVERCOMMITTED, the shared-budget formula -7984 MiB is 12592 MiB under its own peak 4608/);
  const rows = overcommitRows(dir, CONSOLE);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.deepEqual(
    [rows[0]!.container, rows[0]!.formula_mib, rows[0]!.own_peak_mib, rows[0]!.deficit_mib, rows[0]!.kept_mib, rows[0]!.lane, rows[0]!.task_id],
    [CONSOLE, -7984, 4608, 12592, 4608, "host", "HOST"],
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
  // Core, whose own 30000 is above ITS formula too, is ledgered under its own name. Serve has nothing learned,
  // so its floor is its own peak (criterion 2), and its formula is below that too: it is ledgered as well.
  memoryMax(dir, CORE);
  const serve = memoryMax(dir, SERVE);
  const coreRows = overcommitRows(dir, CORE);
  assert.equal(coreRows.length, 1);
  assert.deepEqual([coreRows[0]!.formula_mib, coreRows[0]!.own_peak_mib, coreRows[0]!.deficit_mib], [29952 - 5120 - FLOORS[SERVE]! - FLOORS[SITE]!, 30000, 30000 - (29952 - 5120 - FLOORS[SERVE]! - FLOORS[SITE]!)]);
  assert.equal(serve.mib, FLOORS[SERVE], serve.out);
  assert.deepEqual(overcommitRows(dir, SERVE).map((row) => row.kept_mib), [FLOORS[SERVE]]);
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
  assert.match(got.note, /OVERCOMMITTED, the shared-budget formula -7984 MiB is 12592 MiB under its own peak 4608/);
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
 * never beside a peer's. Three roots, one registry; serve is no registry instance: the primary instance's
 * watchdog tunes it, so its records live in the `primary: true` row's root (core's).
 */
function instances(dir: string) {
  const roots = { core: join(dir, "core-root"), site: join(dir, "site-root"), console: join(dir, "console-root") };
  for (const root of Object.values(roots)) mkdirSync(join(root, "state"), { recursive: true });
  const registry = join(dir, "daemon-instances.yaml");
  writeFileSync(registry, [
    "instances:",
    `  core:\n    repo: remudero\n    primary: true\n    container_name: ${CORE}\n    state_dir: ${roots.core}`,
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
  // Site's recycle reads console's record from console's root, and serve's from the PRIMARY's root (core's),
  // where core's tuner records it, although that is not site's caller root (criterion 3).
  const site = memoryMax(dir, SITE, fleet.env(fleet.roots.site));
  assert.equal(site.mib, budget - FLOORS[CORE]! - 4096 - 6144, site.out);
  assert.match(site.note, new RegExp(`- ${CONSOLE} 4096 \\(learned memory\\.high\\)`));
  assert.match(site.note, new RegExp(`- ${SERVE} 6144 \\(memory\\.peak\\)`), "serve's record is read from the primary's root");
  // A retired row is skipped: its root is never read.
  const retired = join(dir, "retired.yaml");
  writeFileSync(retired, readFileSync(fleet.registry, "utf8").replace(`container_name: ${CONSOLE}`, `retired: true\n    container_name: ${CONSOLE}`));
  assert.equal(memoryMax(dir, CORE, { RMD_INSTANCE_REGISTRY: retired, STATE_DIR: fleet.roots.core }).mib, budget - FLOORS[CONSOLE]! - 3072 - 6144);
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

test("W1-T11130 criterion 1: a formula that covers serve's own peak governs even below the old 5120 MiB reserve line", (t) => {
  // The reviewer's probe: host 15988 MiB, reserve 2048, peaks core 8192 / serve 1024 / console 2048 / site 2304.
  const dir = host(t, `MemTotal:       ${15988 * 1024} kB\n`);
  for (const [container, peak] of [[CORE, 8192], [SERVE, 1024], [CONSOLE, 2048], [SITE, 2304]] as const) learn(dir, container, { peak });
  const serve = memoryMax(dir, SERVE);
  assert.equal(serve.mib, 15988 - RESERVE_MIB - 8192 - 2048 - 2304, `serve's 1396 MiB formula covers its 1024 MiB peak, so it applies: ${serve.out}`);
  assert.doesNotMatch(serve.note, /NO memory ceiling/);
  // The operator override keeps its own meaning (0 = none), untouched by the shared-budget rule.
  assert.equal(memoryMax(dir, SERVE, { RMD_SERVE_MEMORY_LIMIT_MIB: "0" }).mib, undefined);
});

test("W1-T11130 criterion 1: a build daemon's formula that covers its own peak governs even below the old 2048 MiB build floor", (t) => {
  // Console learned only 1000 MiB; the formula left for it is 1800 MiB, under the old build floor.
  const hostMib = 1800 + RESERVE_MIB + 8192 + 1024 + 2304;
  const dir = host(t, `MemTotal:       ${hostMib * 1024} kB\n`);
  for (const [container, peak] of [[CORE, 8192], [SERVE, 1024], [CONSOLE, 1000], [SITE, 2304]] as const) learn(dir, container, { peak });
  const console = memoryMax(dir, CONSOLE);
  assert.equal(console.mib, 1800, `the 1800 MiB formula covers console's 1000 MiB peak, so it applies: ${console.out}`);
  // Only a container with neither a learned peak nor a floor keeps the build floor as its stand-in.
  const unknown = memoryMax(dir, "remudero-unknown-daemon", { RMD_MEMORY_HIGH_FLOORS: "", RMD_MEMORY_WEIGHTS: `${CORE}=4 ${SERVE}=2 ${CONSOLE}=1 ${SITE}=1 remudero-unknown-daemon=1` });
  assert.ok(unknown.mib === undefined || unknown.mib >= 2048, `nothing known: no ceiling under the build floor: ${unknown.out}`);
});
