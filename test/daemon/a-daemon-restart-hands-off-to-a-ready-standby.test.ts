// W1-T14545: with state/daemon-handoff.on, a freshness restart starts a standby from the inactive daemon slot and,
// once it is ready, yields to it (successor pid file, promote marker, exit 79). Every unmet criterion is today's exit.
// The daemon loop here is the REAL runDaemon, driven stale from its first tick as the freshness-exit suites drive it.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import { DAEMON_EXIT_HANDED_OFF, DAEMON_EXIT_STALE, daemonExitCodeForSummary, runDaemon, type DaemonSummary } from "#src/lib/daemon.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { createDaemonHandoff, daemonHandoff, HANDOFF_HEADROOM_MARGIN_BYTES, handoffRecordPath, handoffSwitchPath, readHeadroom, spawnStandbyDaemon,
  successorPidPath, type DaemonHandoff, type HandoffPorts, type StandbyProcess } from "#src/lib/daemon-handoff.js";
import { standbyPromotePath, standbyReadyPath } from "#src/lib/daemon-standby.js";
import { DEPLOY_RESTART_SCORE_THRESHOLD, FRESHNESS_COALESCE_WINDOW_MS } from "#src/lib/deploy-judge.js";
import { loadPlan } from "#src/lib/plan.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const NEW_SHA = "b".repeat(40);
const stale = { stale: true as const, oldSha: "a".repeat(40), newSha: NEW_SHA,
  changes: Array.from({ length: DEPLOY_RESTART_SCORE_THRESHOLD.value }, (_, index) => ({
    sha: index === 0 ? NEW_SHA : String(index).padStart(40, "e"), subject: "fix: refresh", files: ["src/lib/daemon.ts"],
  })) };
type Row = { step: string; [key: string]: unknown };

function movingClock(): Clock & { advance(ms: number): void } {
  let ms = 1_800_000_000_000;
  return { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString(), advance: (by) => { ms += by; } };
}

interface Harness { state: string; rows: Row[]; spawned: { slot: string; runId: string }[]; killed: string[]; handoff: DaemonHandoff }

/** A handoff on real files in a fixture state dir; `standby` decides what the spawned standby does. */
function harness(t: TestContext, over: Partial<HandoffPorts> & { standby?: "ready" | "exits" | "silent" } = {}): Harness {
  const state = join(ownedFixtureDir(t, "daemon-handoff").dir, "state");
  mkdirSync(state, { recursive: true });
  const rows: Row[] = [];
  const spawned: { slot: string; runId: string }[] = [];
  const killed: string[] = [];
  const clock = movingClock();
  let runs = 0;
  const handoff = daemonHandoff({
    stateDir: state, log: (step, extra) => { rows.push({ step, ...extra }); }, clock,
    sleep: async (ms) => { clock.advance(ms); },
    switchOn: () => true,
    activeDir: "/srv/remudero", activeSha: "a".repeat(40),
    prepareSlot: async (activeDir) => ({ dir: join(state, "daemon-slots", activeDir === "/srv/remudero" ? "a" : "b"), sha: NEW_SHA, deps: "linked" }),
    headroom: () => ({ availableBytes: 8 * 1024 ** 3, source: "cgroup" }),
    peakBytes: () => 2 * 1024 ** 3,
    spawnStandby: (slot, runId): StandbyProcess => {
      spawned.push({ slot: slot.dir, runId });
      if ((over.standby ?? "ready") === "ready") {
        mkdirSync(join(state, "daemon-standby"), { recursive: true });
        writeFileSync(standbyReadyPath(state, runId), "{}\n");
      }
      let dead: number | undefined = over.standby === "exits" ? 1 : undefined;
      return { pid: 4242, exited: () => dead, kill: () => { killed.push(runId); dead = 143; } };
    },
    newRunId: () => `DAEMON-STANDBY-${++runs}`,
    readyBoundMs: 60_000, pollMs: 1_000,
    ...over,
  });
  return { state, rows, spawned, killed, handoff };
}

/** The real daemon loop, stale from its first tick, with no task runnable and no pass since the advance. */
async function freshnessExit(t: TestContext, handoff: DaemonHandoff | undefined): Promise<{ summary: DaemonSummary; rows: Row[]; sweeps: number }> {
  const path = join(ownedFixtureDir(t, "daemon-handoff-plan").dir, "tasks.yaml");
  writeFileSync(path, "[]\n");
  let nowMs = Date.now();
  let sweeps = 0;
  const rows: Row[] = [];
  const summary = await runDaemon(loadPlan(path), {
    ...hostIndependentDaemonDeps(),
    now: () => new Date(nowMs),
    checkFreshness: () => stale,
    refreshMerged: () => () => false,
    runOne: async () => assert.fail("no task is dispatchable"),
    sweep: async () => { sweeps++; },
    sleep: async () => { nowMs += FRESHNESS_COALESCE_WINDOW_MS.value; },
    log: (step, extra) => { rows.push({ step, ...extra }); },
    ...(handoff ? { handoff } : {}),
  }, { freshnessMinLifetimeMs: 0, laneCount: 1, max: 1, sweepRetriggerIntervalMs: 1 });
  return { summary, rows, sweeps };
}

test("W1-T14545 a restart decision with handoff on starts a standby from the inactive slot", async (t) => {
  const h = harness(t);
  const attempt = await h.handoff.begin(NEW_SHA);
  assert.ok(attempt, "the handoff started");
  assert.deepEqual(h.spawned, [{ slot: join(h.state, "daemon-slots", "a"), runId: "DAEMON-STANDBY-1" }], "the standby runs from the slot that is not the active tree");
  const requested = h.rows.find((r) => r.step === "daemon.handoff_requested");
  assert.ok(requested, "daemon.handoff_requested is ledgered");
  assert.equal(requested.sha, NEW_SHA);
  assert.equal(requested.slot, join(h.state, "daemon-slots", "a"));
  assert.deepEqual(requested.headroom, { available_bytes: 8 * 1024 ** 3, source: "cgroup", peak_bytes: 2 * 1024 ** 3,
    margin_bytes: HANDOFF_HEADROOM_MARGIN_BYTES });

  // The real spawn: `<slot>/bin/rmd daemon --standby <the active daemon's own arguments>`, under the new run id.
  const slot = join(ownedFixtureDir(t, "daemon-slot").dir, "a");
  mkdirSync(join(slot, "bin"), { recursive: true });
  const seen = join(slot, "seen.txt");
  writeFileSync(join(slot, "bin", "rmd"), `#!/bin/sh\nprintf '%s|%s|%s\\n' "$REMUDERO_RUN_ID" "$PWD" "$*" > "${seen}"\n`);
  chmodSync(join(slot, "bin", "rmd"), 0o755);
  const standby = spawnStandbyDaemon(h.state, ["--allow-self-target", "--standby", "--max", "3"])({ dir: slot, sha: NEW_SHA }, "DAEMON-REAL-1");
  assert.equal(typeof standby.pid, "number");
  const deadline = Date.now() + 20_000;
  while (standby.exited() === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(standby.exited(), 0);
  assert.equal(readFileSync(seen, "utf8"), `DAEMON-REAL-1|${slot}|daemon --standby --allow-self-target --max 3\n`,
    "one --standby, the run id, and the slot as its working tree");
  standby.kill(); // already exited: a no-op, never a throw

  // The runDaemon side: a freshness exit with the switch on begins one handoff for the new sha.
  const asked: string[] = [];
  await freshnessExit(t, { enabled: () => true, begin: async (sha) => { asked.push(sha); return undefined; } });
  assert.deepEqual(asked, [NEW_SHA]);
});

test("W1-T14545 a ready standby lets the active daemon yield between pull requests", async (t) => {
  const h = harness(t);
  const { summary, rows, sweeps } = await freshnessExit(t, h.handoff);
  assert.equal(summary.stopReason, "stale");
  assert.equal(summary.handedOff, true);
  assert.equal(daemonExitCodeForSummary(summary), DAEMON_EXIT_HANDED_OFF);
  assert.equal(sweeps, 1, "the exit starts no pre-exit pass of its own");
  assert.equal(rows.find((r) => r.step === "daemon_selfrestart_for_freshness")?.pre_exit_pass, "no_sweep_at_exit");
  assert.equal(readFileSync(successorPidPath(h.state), "utf8"), "4242 DAEMON-STANDBY-1\n", "the entrypoint can find the successor");
  assert.equal(existsSync(standbyPromotePath(h.state, "DAEMON-STANDBY-1")), true, "the standby is told to take over");
  const record = readFileSync(handoffRecordPath(h.state), "utf8");
  assert.match(record, new RegExp(`^predecessor_sha=${"a".repeat(40)}$`, "m"), "the record names the sha to roll back to");
  assert.match(record, /^predecessor_tree=\/srv\/remudero$/m);
  assert.match(record, new RegExp(`^successor_sha=${NEW_SHA}$`, "m"));
  const yielded = h.rows.find((r) => r.step === "daemon.handoff_yielded");
  assert.ok(yielded, "daemon.handoff_yielded is ledgered");
  assert.deepEqual(yielded.children_left_running, []);
  assert.equal(yielded.standby_run_id, "DAEMON-STANDBY-1");
  const order = rows.map((r) => r.step);
  assert.ok(order.indexOf("daemon.freshness_exit") >= 0, "it is still a freshness exit in the ledger");
  assert.deepEqual(h.killed, [], "a standby that took over is never killed");
});

test("W1-T14545 any failed handoff criterion falls back to the cold freshness exit", async (t) => {
  const cases: { name: string; over: Parameters<typeof harness>[1]; criterion: string; killed: boolean }[] = [
    { name: "too little memory", over: { headroom: () => ({ availableBytes: 2 * 1024 ** 3, source: "meminfo" }) }, criterion: "headroom", killed: false },
    { name: "no memory reading", over: { headroom: () => ({ availableBytes: undefined, source: "unreadable" }) }, criterion: "headroom", killed: false },
    { name: "a memory read that throws", over: { peakBytes: () => { throw new Error("no rusage"); } }, criterion: "headroom", killed: false },
    { name: "a slot that cannot be prepared", over: { prepareSlot: async () => { throw new Error("git fetch failed"); } }, criterion: "slot", killed: false },
    { name: "a spawn that throws", over: { spawnStandby: () => { throw new Error("EACCES"); } }, criterion: "spawn", killed: false },
    { name: "a standby that exits before ready", over: { standby: "exits" }, criterion: "standby_exited", killed: false },
    { name: "a standby that never gets ready", over: { standby: "silent" }, criterion: "ready_timeout", killed: true },
  ];
  for (const c of cases) {
    const h = harness(t, c.over);
    const { summary } = await freshnessExit(t, h.handoff);
    assert.equal(summary.handedOff, undefined, c.name);
    assert.equal(daemonExitCodeForSummary(summary), DAEMON_EXIT_STALE, `${c.name}: today's freshness exit`);
    assert.equal(h.rows.find((r) => r.step === "daemon.handoff_aborted")?.criterion, c.criterion, c.name);
    assert.equal(h.rows.some((r) => r.step === "daemon.handoff_yielded"), false, c.name);
    assert.equal(existsSync(successorPidPath(h.state)), false, `${c.name}: no successor for the entrypoint`);
    assert.equal(existsSync(handoffRecordPath(h.state)), false, c.name);
    assert.equal(h.killed.length > 0, c.killed, `${c.name}: a running standby is killed`);
  }
});

test("W1-T14545 with handoff off the freshness exit is unchanged", async (t) => {
  let begun = 0;
  const off = await freshnessExit(t, { enabled: () => false, begin: async () => { begun++; return undefined; } });
  assert.equal(begun, 0);
  assert.equal(off.summary.handedOff, undefined);
  assert.equal(daemonExitCodeForSummary(off.summary), DAEMON_EXIT_STALE);
  assert.equal(off.rows.some((r) => String(r.step).startsWith("daemon.handoff")), false, "no handoff row is written");
  const absent = await freshnessExit(t, undefined);
  assert.equal(daemonExitCodeForSummary(absent.summary), DAEMON_EXIT_STALE);

  // The real switch is the file, read at each decision.
  const state = join(ownedFixtureDir(t, "daemon-handoff-switch").dir, "state");
  mkdirSync(state, { recursive: true });
  const real = createDaemonHandoff({ stateDir: state, activeDir: state, activeSha: undefined, daemonArgs: [], log: () => {},
    prepareSlot: () => Promise.reject(new Error("not reached")) });
  assert.equal(real.enabled(), false);
  writeFileSync(handoffSwitchPath(state), "");
  assert.equal(real.enabled(), true);
});

test("W1-T14545 headroom is the smaller of the cgroup's room and MemAvailable", () => {
  const files = (map: Record<string, string>) => (path: string) => {
    if (path in map) return map[path]!;
    throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
  };
  const meminfo = "MemTotal:       32000000 kB\nMemAvailable:    4000000 kB\n";
  assert.deepEqual(readHeadroom(files({ "/sys/fs/cgroup/memory.max": "10000000000\n", "/sys/fs/cgroup/memory.current": "2000000000\n", "/proc/meminfo": meminfo })),
    { availableBytes: 4_000_000 * 1024, source: "meminfo" });
  assert.deepEqual(readHeadroom(files({ "/sys/fs/cgroup/memory.max": "5000000000\n", "/sys/fs/cgroup/memory.current": "2000000000\n", "/proc/meminfo": meminfo })),
    { availableBytes: 3_000_000_000, source: "cgroup" });
  assert.deepEqual(readHeadroom(files({ "/sys/fs/cgroup/memory.max": "max\n", "/sys/fs/cgroup/memory.current": "1\n", "/proc/meminfo": meminfo })),
    { availableBytes: 4_000_000 * 1024, source: "meminfo" }, "an unlimited cgroup gives no cgroup reading");
  assert.deepEqual(readHeadroom(files({})), { availableBytes: undefined, source: "unreadable" });
  const live = readHeadroom();
  assert.equal(typeof live.source, "string", "the real reader answers without throwing");
});
