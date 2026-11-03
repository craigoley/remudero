/**
 * W1-T11130, operator ruling R1 (2026-10-27): every fleet container's memory.max comes from ONE shared
 * host budget. That is MemTotal less RMD_HOST_RESERVE_MIB less the OTHER containers' learned peaks.
 * Before this, each build daemon got total - 5120 - 2048 (24.3 GiB each for core, console and site on
 * the 32 GiB host) and serve got a fixed 7,680 MiB, so together they could overcommit the host.
 * These tests source the real deploy/resource-policy.sh against a fixture meminfo and state dir.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
function policy(dir: string, script: string, env: Record<string, string> = {}) {
  const run = spawnSync("bash", ["-c", `source "$1"; ${script}`, "policy", POLICY], {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, STATE_DIR: dir,
      RMD_MEMINFO_PATH: join(dir, "meminfo"), RMD_CGROUP_ROOT: join(dir, "cgroup"), ...env,
    },
  });
  assert.equal(run.status, 0, `the policy is never fatal: ${run.stderr}`);
  return run.stdout;
}

/** The --memory value (MiB) each launcher gets for `container`, and its policy note. */
function memoryMax(dir: string, container: string, env: Record<string, string> = {}) {
  const script = container === SERVE
    ? 'resource_policy_serve_args; printf "%s\\n" "${RESOURCE_POLICY_SERVE_ARGS[@]}"; printf "note=%s\\n" "$RESOURCE_POLICY_NOTE"'
    : 'resource_policy_build_args "$2"; printf "%s\\n" "${RESOURCE_POLICY_BUILD_ARGS[@]}"; printf "note=%s\\n" "$RESOURCE_POLICY_NOTE"';
  const out = policy(dir, script.replace('"$2"', `"${container}"`), env);
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
  for (const container of FLEET) {
    const others = FLEET.filter((c) => c !== container).reduce((sum, c) => sum + peaks[c]!, 0);
    const got = memoryMax(dir, container);
    assert.equal(got.mib, budget - others, `${container}: host ${HOST_MIB} - reserve ${RESERVE_MIB} - others ${others}\n${got.out}`);
    // Any ONE container at its limit while the other three sit at their peaks still fits the host.
    assert.equal(got.mib! + others + RESERVE_MIB, HOST_MIB, `${container} at its memory.max beside the others' peaks fills the host exactly`);
    assert.match(got.note, new RegExp(`memory\\.max ${budget - others} MiB = shared budget: host ${HOST_MIB} - reserve ${RESERVE_MIB}`));
    for (const other of FLEET.filter((c) => c !== container)) assert.match(got.note, new RegExp(`- ${other} ${peaks[other]} \\(`), `the note names ${other}'s term`);
  }
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
  }
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
  // When the peaks alone overcommit the host, the share cannot hold console's own learned peak under its
  // 95% memory.high cap. Console then keeps today's arithmetic (total - 5120 - 2048), never a value from
  // its own learned peak, which would move every time the tuner gives memory back.
  learn(dir, CORE, { high: 20480 });
  learn(dir, CONSOLE, { peak: 4608 });
  const crowded = memoryMax(dir, CONSOLE);
  assert.equal(crowded.mib, HOST_MIB - 5120 - 2048, crowded.out);
  assert.match(crowded.note, new RegExp(`memory\\.max ${HOST_MIB - 5120 - 2048} MiB = today's arithmetic, OVERCOMMITTED: .* leaves -2048 MiB, under the 4851 MiB that holds its own learned peak 4608 MiB \\(memory\\.peak\\)`));
  learn(dir, CONSOLE, { peak: 4096 }); // a smaller own peak does not lower an overcommitted limit
  assert.equal(memoryMax(dir, CONSOLE).mib, HOST_MIB - 5120 - 2048);
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
