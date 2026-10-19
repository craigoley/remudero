/**
 * A FIXED memory.high EVICTED HOT FILES THAT WERE THEN RE-READ FROM THE SLOW DISK.
 *
 * OBSERVED 2026-10-09 on the 15.6 GiB fleet host (cgroup files, read-only, one 121 s window):
 * console-daemon took 124 memory.high events and refaulted 28.9 MiB of file pages while reading
 * 28.7 MiB from /mnt/rmd — the refaults were its disk reads — with 6-11 GB of host MemAvailable
 * unused. deploy/memory-high-tuner.sh grows a squeezed container's memory.high by what it refaulted,
 * bounded by host headroom, and gives it back under host pressure, never below the policy value.
 * These drive the SHIPPED shell through real bash; only docker, sudo and systemctl are faked.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MEMORY_HIGH_ANNOTATION, readResourcePolicyDrift, type ResourcePolicyDrift } from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const TUNER = join(REPO_ROOT, "deploy", "memory-high-tuner.sh");
const MIB = 1024 * 1024;
const HOST_KB = 16371996; // the fleet host's MemTotal, read 2026-10-09 (15988 MiB)
const CONSOLE = "remudero-console-daemon";
const CONSOLE_MAX_MIB = 15988 - 5120 - 2048; // the build memory.max the policy already sets (8820)

/** One decision through the shipped shell: MH_* inputs in, "<action> <target>" out. */
function decide(inputs: Record<string, string | number>): { action: string; target: number; reason: string } {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, RMD_MEMINFO_PATH: "/nonexistent" };
  const base = {
    MH_LIVE_MIB: 2048, MH_POLICY_MIB: 2048, MH_MAX_MIB: CONSOLE_MAX_MIB, MH_LEARNED_MIB: "",
    MH_HIGH_EVENTS: 0, MH_REFAULT_MIB: 0, MH_FURTHEST: 1,
    MH_AVAIL_MIB: 9000, MH_RESERVE_MIB: 2048, MH_ALLOCSTALL: 0, MH_SWAPIN_RATE: 0, MH_PREV_SWAPIN_RATE: 0, MH_PSI_FULL10: 0,
  };
  for (const [k, v] of Object.entries({ ...base, ...inputs })) env[k] = String(v);
  const out = execFileSync("bash", ["-c", 'source "$1"; memory_high_decide; printf "%s\\n%s\\n%s" "$MH_ACTION" "$MH_TARGET_MIB" "$MH_REASON"', "t", TUNER], {
    encoding: "utf8",
    env,
  });
  const [action, target, reason] = out.split("\n");
  return { action: action!, target: Number(target), reason: reason ?? "" };
}

test("the tuner grows a throttled, refaulting container's memory.high when the host has headroom, bounded by that headroom", () => {
  // The console window above, per 5 min: 124 high events, ~71 MiB refaulted, 9 GB MemAvailable.
  const g = decide({ MH_HIGH_EVENTS: 124, MH_REFAULT_MIB: 71 });
  assert.equal(g.action, "grow", g.reason);
  assert.equal(g.target, 2048 + 256, "one 256 MiB quantum covers 71 MiB of refaults");
  // A heavy squeeze asks for more than the host can spare: half the headroom above two reserves.
  const heavy = decide({ MH_HIGH_EVENTS: 683, MH_REFAULT_MIB: 3000 });
  assert.equal(heavy.action, "grow", heavy.reason);
  assert.equal(heavy.target, 2048 + 2304, "(9000 - 2 x 2048) / 2 = 2452, rounded down to 2304");
  // ...and never reaches the container's own memory.max.
  const capped = decide({ MH_LIVE_MIB: 8192, MH_POLICY_MIB: 8192, MH_HIGH_EVENTS: 50, MH_REFAULT_MIB: 900 });
  assert.equal(capped.target, Math.floor((CONSOLE_MAX_MIB * 95) / 100));
  // Throttled without refaulting (anon growth), or refaulting without throttling: no squeeze to relieve.
  assert.equal(decide({ MH_HIGH_EVENTS: 124, MH_REFAULT_MIB: 0 }).action, "hold");
  assert.equal(decide({ MH_HIGH_EVENTS: 0, MH_REFAULT_MIB: 71 }).action, "hold");
});

test("the tuner holds a squeezed container when the host has no headroom to give", () => {
  // MemAvailable under two reserves with nothing else wrong: tier 1, watch.
  const thin = decide({ MH_HIGH_EVENTS: 124, MH_REFAULT_MIB: 71, MH_AVAIL_MIB: 3500 });
  assert.equal(thin.action, "hold");
  assert.match(thin.reason, /tier 1/);
  // Calm, but half the headroom above two reserves rounds to nothing.
  const none = decide({ MH_HIGH_EVENTS: 124, MH_REFAULT_MIB: 71, MH_AVAIL_MIB: 4200 });
  assert.equal(none.action, "hold");
  assert.equal(none.target, 2048);
  // Swap-in, PSI and global reclaim alone are the squeeze itself, not host pressure: still grows.
  const busy = decide({ MH_HIGH_EVENTS: 124, MH_REFAULT_MIB: 71, MH_SWAPIN_RATE: 4000, MH_PREV_SWAPIN_RATE: 100, MH_PSI_FULL10: 283, MH_ALLOCSTALL: 6 });
  assert.equal(busy.action, "grow", busy.reason);
});

test("host pressure shrinks the container furthest above its policy, and severe pressure shrinks every one", () => {
  const pressure = { MH_LIVE_MIB: 3072, MH_AVAIL_MIB: 3000, MH_SWAPIN_RATE: 500, MH_PREV_SWAPIN_RATE: 100 };
  const furthest = decide({ ...pressure, MH_FURTHEST: 1, MH_HIGH_EVENTS: 124, MH_REFAULT_MIB: 71 });
  assert.equal(furthest.action, "shrink", furthest.reason);
  assert.equal(furthest.target, 3072 - 256, "tier 2 gives back one quantum");
  assert.match(furthest.reason, /swap-in rising/);
  const other = decide({ ...pressure, MH_FURTHEST: 0 });
  assert.equal(other.action, "hold", "tier 2: only the furthest above policy gives back first");
  // MemAvailable under one reserve and global reclaim: tier 3, every container gives back half its excess.
  const severe = decide({ MH_LIVE_MIB: 3072, MH_AVAIL_MIB: 1500, MH_ALLOCSTALL: 4, MH_FURTHEST: 0 });
  assert.equal(severe.action, "shrink", severe.reason);
  assert.equal(severe.target, 3072 - 512);
  assert.match(severe.reason, /tier 3/);
});

test("the tuner never sets memory.high below the policy value", () => {
  const severe = { MH_AVAIL_MIB: 1000, MH_ALLOCSTALL: 5, MH_PSI_FULL10: 400 };
  assert.equal(decide({ ...severe, MH_LIVE_MIB: 2304 }).target, 2048, "a step past the floor stops at the floor");
  const atPolicy = decide({ ...severe, MH_LIVE_MIB: 2048 });
  assert.equal(atPolicy.action, "hold");
  assert.equal(atPolicy.target, 2048);
  // A live value under the policy (written by something else) is raised to it, even under pressure.
  const under = decide({ ...severe, MH_LIVE_MIB: 1536 });
  assert.equal(under.action, "floor");
  assert.equal(under.target, 2048);
  // A learned value lost to a revive from policy is restored, within headroom.
  const restore = decide({ MH_LIVE_MIB: 2048, MH_LEARNED_MIB: 2560 });
  assert.equal(restore.action, "restore", restore.reason);
  assert.equal(restore.target, 2560);
});

/** A host with one console container on a systemd-driver cgroup tree, and fake docker/sudo/systemctl. */
function host(container = CONSOLE): { root: string; env: NodeJS.ProcessEnv; cg: string; calls: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}memory-high-tuner-`));
  const id = "c0ffee".padEnd(64, "0");
  const cg = join(root, "cg", "system.slice", `docker-${id}.scope`);
  mkdirSync(cg, { recursive: true });
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "cfg", "state"), { recursive: true });
  writeFileSync(join(cg, "memory.high"), `${2048 * MIB}\n`);
  writeFileSync(join(cg, "memory.max"), `${CONSOLE_MAX_MIB * MIB}\n`);
  writeFileSync(join(cg, "memory.events"), "low 0\nhigh 1124\nmax 0\noom 0\n");
  writeFileSync(join(cg, "memory.stat"), "anon 1\nfile 2\nworkingset_refault_anon 9\nworkingset_refault_file 25000\n");
  writeFileSync(join(root, "meminfo"), `MemTotal:       ${HOST_KB} kB\nMemAvailable:    9216000 kB\n`);
  writeFileSync(join(root, "vmstat"), "pswpin 5000\npswpout 9000\nallocstall_normal 10\nallocstall_movable 20\n");
  writeFileSync(join(root, "psi"), "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n");
  const calls = join(root, "calls.log");
  const fake = (name: string, body: string) => {
    writeFileSync(join(root, "bin", name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> '${calls}'\n${body}\n`);
    chmodSync(join(root, "bin", name), 0o755);
  };
  fake("docker", `case "$1" in inspect) echo ${id} ;; ps) echo "${container} ${id}" ;; esac`);
  fake("systemctl", `[ "$1" = set-property ] && [ "$2" = --runtime ] && printf '%s\\n' "\${4#MemoryHigh=}" > '${join(root, "cg", "system.slice")}'/"$3"/memory.high`);
  return {
    root,
    cg,
    calls,
    env: {
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      RMD_CGROUP_ROOT: join(root, "cg"),
      RMD_MEMINFO_PATH: join(root, "meminfo"),
      RMD_VMSTAT_PATH: join(root, "vmstat"),
      RMD_HOST_PSI_MEMORY_PATH: join(root, "psi"),
      RMD_MEMORY_HIGH_SUDO: "env",
    },
  };
}

test("serve tuning honors its canonical hard-capped policy instead of the build ceiling on larger hosts", () => {
  const container = "remudero-serve";
  for (const totalMiB of [Math.floor(HOST_KB / 1024), 32768]) {
    const h = host(container);
    try {
      const policyMiB = totalMiB === 32768 ? 7296 : 5632;
      writeFileSync(join(h.root, "meminfo"), `MemTotal: ${totalMiB * 1024} kB\nMemAvailable: 9216000 kB\n`);
      writeFileSync(join(h.cg, "memory.max"), `${7680 * MIB}\n`);
      writeFileSync(join(h.cg, "memory.high"), `${policyMiB * MIB}\n`);
      const then = Math.floor(Date.now() / 1000) - 300;
      const id = "c0ffee".padEnd(64, "0");
      writeFileSync(join(h.root, "cfg", "state", `memory-high-sample-${container}.txt`),
        `v1 ${then} ${id} 1124 25000 5000 30 0\n`);
      const run = spawnSync("bash", [TUNER, "--container", container, "--state-dir", join(h.root, "cfg")],
        { encoding: "utf8", env: h.env });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, new RegExp(`hold at ${policyMiB} MiB \\(policy ${policyMiB}\\)`));
      assert.equal(readFileSync(join(h.cg, "memory.high"), "utf8").trim(), String(policyMiB * MIB));
      assert.equal(readFileSync(join(h.cg, "memory.max"), "utf8").trim(), String(7680 * MIB), "the hard limit is unchanged");
      assert.doesNotMatch(readFileSync(h.calls, "utf8"), /systemctl/);
      assert.equal(existsSync(join(h.root, "cfg", "state", `memory-high-tuned-${container}.json`)), false);
      assert.equal(existsSync(join(h.root, "cfg", "state", "ledger.ndjson")), false, "a hold must not claim an adjustment");
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  }
});

test("a tick writes the grown memory.high through the container's systemd scope, records it, and ledgers the step", () => {
  const h = host();
  try {
    const id = "c0ffee".padEnd(64, "0");
    // The previous tick's sample, 300 s ago: 124 high events and 18,000 refaulted pages (~70 MiB) since.
    const then = Math.floor(Date.now() / 1000) - 300;
    writeFileSync(join(h.root, "cfg", "state", `memory-high-sample-${CONSOLE}.txt`), `v1 ${then} ${id} 1000 7000 5000 30 0\n`);
    const run = spawnSync("bash", [TUNER, "--container", CONSOLE, "--state-dir", join(h.root, "cfg")], { encoding: "utf8", env: h.env });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /grow 2048 -> 2304 MiB via systemd/);
    assert.match(readFileSync(h.calls, "utf8"), new RegExp(`systemctl set-property --runtime docker-${id}\\.scope MemoryHigh=${2304 * MIB}`));
    assert.equal(readFileSync(join(h.cg, "memory.high"), "utf8").trim(), String(2304 * MIB), "read back from the cgroup");
    const learned = JSON.parse(readFileSync(join(h.root, "cfg", "state", `memory-high-tuned-${CONSOLE}.json`), "utf8"));
    assert.equal(learned.container, CONSOLE);
    assert.equal(learned.high_mib, 2304);
    assert.equal(learned.policy_mib, 2048);
    const rows = readFileSync(join(h.root, "cfg", "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].step, "host.memory_high.adjusted");
    assert.deepEqual([rows[0].action, rows[0].before_mib, rows[0].after_mib, rows[0].policy_mib, rows[0].write], ["grow", 2048, 2304, 2048, "systemd"]);
    assert.match(rows[0].reason, /124 high events/);

    // The next tick with no new squeeze holds and writes nothing.
    const again = spawnSync("bash", [TUNER, "--container", CONSOLE, "--state-dir", join(h.root, "cfg")], { encoding: "utf8", env: h.env });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /hold/);
    assert.equal(readFileSync(join(h.root, "cfg", "state", "ledger.ndjson"), "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a first sample, or a recycled container, holds until it has a delta", () => {
  const h = host();
  try {
    const run = spawnSync("bash", [TUNER, "--container", CONSOLE, "--state-dir", join(h.root, "cfg")], { encoding: "utf8", env: h.env });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /hold: first sample/);
    assert.ok(existsSync(join(h.root, "cfg", "state", `memory-high-sample-${CONSOLE}.txt`)));
    assert.ok(!existsSync(join(h.root, "cfg", "state", "ledger.ndjson")));
    assert.doesNotMatch(readFileSync(h.calls, "utf8"), /systemctl/);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("the drift check treats a learned memory.high as current, and a recycle starts from it", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}memory-high-learned-`));
  try {
    mkdirSync(join(root, "deploy"), { recursive: true });
    mkdirSync(join(root, "cfg", "state"), { recursive: true });
    copyFileSync(join(REPO_ROOT, "deploy", "resource-policy.sh"), join(root, "deploy", "resource-policy.sh"));
    writeFileSync(join(root, "meminfo"), `MemTotal:       ${HOST_KB} kB\n`);
    const env = { PATH: process.env.PATH, RMD_MEMINFO_PATH: join(root, "meminfo") };
    const limits = { Memory: CONSOLE_MAX_MIB * MIB, MemorySwap: (CONSOLE_MAX_MIB + 4096) * MIB, CpuShares: 512, MemoryReservation: 0 };
    const driftAt = (annotation: number | null): ResourcePolicyDrift[] | undefined =>
      readResourcePolicyDrift(
        (cmd, args) =>
          cmd === "bash"
            ? execFileSync(cmd, args, { encoding: "utf8", env })
            : JSON.stringify({ ...limits, Annotations: annotation === null ? null : { [MEMORY_HIGH_ANNOTATION]: `uint64 ${annotation * MIB}` } }),
        root,
        "build",
        CONSOLE,
        join(root, "cfg"),
      );
    // Nothing learned: the policy's own 2048 MiB is the only current value, exactly as before.
    assert.deepEqual(driftAt(2048), []);
    assert.deepEqual(driftAt(3072), [{ field: "MemoryHigh", expected: 2048 * MIB, actual: 3072 * MIB }]);

    writeFileSync(
      join(root, "cfg", "state", `memory-high-tuned-${CONSOLE}.json`),
      `{"container":"${CONSOLE}","high_mib":3072,"policy_mib":2048,"updated_at":"2026-10-09T22:00:00Z","reason":"grow"}\n`,
    );
    // Learned 3072: the container that started from policy, from an earlier step, or from the learned
    // value is current — the tuner owns its live memory.high now.
    for (const started of [2048, 2560, 3072]) assert.deepEqual(driftAt(started), [], `annotation ${started} MiB`);
    // Under the policy, or no annotation at all, is still drift.
    assert.deepEqual(driftAt(1024), [{ field: "MemoryHigh", expected: 3072 * MIB, actual: 1024 * MIB }]);
    assert.deepEqual(driftAt(null), [{ field: "MemoryHigh", expected: 3072 * MIB, actual: 0 }]);
    // The recycle's own arguments start from the learned value.
    const args = execFileSync(
      "bash",
      ["-c", 'STATE_DIR="$2"; source "$1"; resource_policy_build_args "$3"; printf "%s\\n" "${RESOURCE_POLICY_BUILD_ARGS[@]}"; echo "$RESOURCE_POLICY_NOTE"', "p", join(root, "deploy", "resource-policy.sh"), join(root, "cfg"), CONSOLE],
      { encoding: "utf8", env },
    );
    assert.match(args, new RegExp(`--annotation=${MEMORY_HIGH_ANNOTATION.replace(/\./g, "\\.")}=uint64 ${3072 * MIB}\\n`));
    assert.match(args, /started at the learned 3072 MiB/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the tuner discovers full-ID peers with Docker's exact argv before tier-2 ordering", async t => {
  const core = "remudero-daemon", serve = "remudero-serve";
  const currentId = "c0ffee".padEnd(64, "0"), peerId = "bead".padEnd(64, "0");
  const cases = [
    { name: "core holds for serve's larger surplus", current: core, live: 8320, peerLive: 6400, action: "hold", target: 8320 },
    { name: "serve gives back before core despite core's larger absolute high", current: serve, live: 6400, peerLive: 8320, action: "shrink", target: 6144 },
    { name: "serve holds for core's larger surplus", current: serve, live: 5760, peerLive: 8352, action: "hold", target: 5760 },
    { name: "core gives back before serve's smaller surplus", current: core, live: 8352, peerLive: 5696, action: "shrink", target: 8192 },
    { name: "an unread ineligible cloudflared is not a tuner peer", current: serve, live: 6400, peerLive: 8320, excluded: true, action: "shrink", target: 6144 },
    { name: "equal surpluses preserve the existing tie behavior", current: core, live: 8320, peerLive: 5760, action: "shrink", target: 8192 },
    { name: "an advertised peer's missing high holds tier 2", current: core, live: 8320, peerLive: 6400, fault: "missing-high", action: "hold", target: 8320 },
    { name: "an advertised peer's malformed high holds tier 2", current: serve, live: 6400, peerLive: 8320, fault: "malformed-high", action: "hold", target: 6400 },
    { name: "failed peer discovery holds tier 2", current: core, live: 8320, peerLive: 6400, fault: "list-error", action: "hold", target: 8320 },
    { name: "empty discovery is unknown beside a successful inspect", current: core, live: 8320, peerLive: 6400, fault: "empty-list", action: "hold", target: 8320 },
    { name: "truncated peer identities are not guessed into a cgroup", current: core, live: 8320, peerLive: 6400, fault: "short-ids", action: "hold", target: 8320 },
    { name: "a list missing the inspected current identity holds tier 2", current: core, live: 8320, peerLive: 6400, fault: "missing-current", action: "hold", target: 8320 },
    { name: "a changed current identity in the peer list holds tier 2", current: core, live: 8320, peerLive: 6400, fault: "changed-current", action: "hold", target: 8320 },
    { name: "a duplicate current identity leaves peer ordering unknown", current: core, live: 8320, peerLive: 6400, fault: "duplicate-current", action: "hold", target: 8320 },
    { name: "a nonhex peer identity is not used as a cgroup path", current: serve, live: 6400, peerLive: 8320, fault: "nonhex-peer", action: "hold", target: 6400 },
    { name: "a short inspected identity holds before any cgroup or peer lookup", current: core, live: 8320, peerLive: 6400, fault: "short-inspect", action: "hold", target: 8320 },
    { name: "tier 1 stays a hold even for the largest peer", current: serve, live: 6400, peerLive: 8320, tier: "watch", action: "hold", target: 6400 },
    { name: "tier 3 still gives back despite a larger peer", current: core, live: 8320, peerLive: 6400, tier: "severe", action: "shrink", target: 8192 },
    { name: "the current policy floor still wins", current: serve, live: 5376, peerLive: 8320, action: "floor", target: 5632 },
    { name: "calm growth still respects the 95 percent hard cap", current: serve, live: 7168, peerLive: 8320, tier: "calm", action: "grow", target: 7296 },
    { name: "calm without squeeze still holds", current: serve, live: 6400, peerLive: 8320, tier: "no-squeeze", action: "hold", target: 6400 },
    { name: "the policy floor still wins when peer discovery fails", current: serve, live: 5376, peerLive: 8320, fault: "list-error", action: "floor", target: 5632 },
    { name: "tier 3 still gives back when a peer high is unreadable", current: core, live: 8320, peerLive: 6400, tier: "severe", fault: "missing-high", action: "shrink", target: 8192 },
    { name: "tier 1 still holds when peer discovery fails", current: serve, live: 6400, peerLive: 8320, tier: "watch", fault: "list-error", action: "hold", target: 6400 },
    { name: "calm capped growth still works when peer discovery fails", current: serve, live: 7168, peerLive: 8320, tier: "calm", fault: "list-error", action: "grow", target: 7296 },
    { name: "calm restoration still works when peer discovery fails", current: serve, live: 6400, peerLive: 8320, tier: "calm", fault: "list-error", learned: 6912, action: "restore", target: 6912 },
    { name: "calm without squeeze still holds when peer discovery fails", current: serve, live: 6400, peerLive: 8320, tier: "no-squeeze", fault: "list-error", action: "hold", target: 6400 },
  ];
  for (const row of cases) await t.test(row.name, () => {
    // Reuse the maintained host() fixture; no second builder or live Docker seam.
    const h = host(row.current), peer = row.current === core ? serve : core;
    const peerCg = join(h.root, "cg", "system.slice", `docker-${peerId}.scope`);
    const argvPath = join(h.root, "docker-argv.bin"), listPath = join(h.root, "peers.txt");
    try {
      mkdirSync(peerCg, { recursive: true });
      for (const [cg, name, high] of [[h.cg, row.current, row.live], [peerCg, peer, row.peerLive]] as const) {
        writeFileSync(join(cg, "memory.high"), `${high * MIB}\n`);
        writeFileSync(join(cg, "memory.max"), `${(name === serve ? 7680 : CONSOLE_MAX_MIB) * MIB}\n`);
        writeFileSync(join(cg, "memory.swap.max"), `${(name === serve ? 1024 : 4096) * MIB}\n`);
      }
      const boundaries = [h.cg, peerCg].map(cg => ({
        cg, max: readFileSync(join(cg, "memory.max"), "utf8"),
        swapMax: readFileSync(join(cg, "memory.swap.max"), "utf8"),
      }));
      const peerBefore = readFileSync(join(peerCg, "memory.high"), "utf8");
      const short = row.fault === "short-ids";
      const rows: Array<[string, string]> = [[row.current, currentId], [peer, peerId]];
      if (row.fault === "changed-current") rows[0] = [row.current, "feed".padEnd(64, "0")];
      if (row.fault === "duplicate-current") rows.push([row.current, currentId]);
      if (row.fault === "nonhex-peer") rows[1] = [peer, "g".repeat(64)];
      if (row.excluded) {
        const excludedId = "face".padEnd(64, "0");
        const excludedCg = join(h.root, "cg", "system.slice", `docker-${excludedId}.scope`);
        mkdirSync(excludedCg, { recursive: true });
        writeFileSync(join(excludedCg, "memory.high"), "not-a-tuner-input\n");
        rows.push(["cloudflared", excludedId]);
      }
      writeFileSync(listPath, rows.filter(([name]) => row.fault !== "missing-current" || name !== row.current)
        .map(([name, id]) => `${name} ${short ? id!.slice(0, 12) : id}\n`).join(""));
      assert.equal(currentId.length, 64);
      assert.equal(peerId.length, 64);
      assert.equal(readFileSync(join(peerCg, "memory.high"), "utf8"), peerBefore, "physical full-ID peer positive control");

      // The fake validates argv; it does not silently return a convenient peer for any format.
      // inspect's .Id and ps's .ID are intentionally DIFFERENT contracts.
      writeFileSync(join(h.root, "bin", "docker"), [
        "#!/usr/bin/env bash",
        "printf '%s\\0' \"$@\" >> \"$TUNER_FIXTURE_ARGV\"; printf '\\0' >> \"$TUNER_FIXTURE_ARGV\"",
        "printf '%s\\n' \"docker $*\" >> \"$TUNER_FIXTURE_CALLS\"",
        "case \"$1\" in",
        " inspect)",
        "  [ \"$#\" -eq 4 ] && [ \"$2\" = --format ] && [ \"$3\" = '{{.Id}}' ] && [ \"$4\" = \"$TUNER_FIXTURE_CONTAINER\" ] || exit 64",
        "  if [ \"$TUNER_FIXTURE_FAULT\" = short-inspect ]; then printf '%.12s\\n' \"$TUNER_FIXTURE_ID\"; else printf '%s\\n' \"$TUNER_FIXTURE_ID\"; fi ;;",
        " ps)",
        "  truncated=0",
        "  if [ \"$#\" -eq 4 ] && [ \"$2\" = --no-trunc ] && [ \"$3\" = --format ]; then format=\"$4\"",
        "  elif [ \"$#\" -eq 3 ] && [ \"$2\" = --format ]; then format=\"$3\"; truncated=1",
        "  else echo 'fixture: unexpected Docker ps argv' >&2; exit 64; fi",
        "  if [ \"$format\" = '{{.Names}} {{.Id}}' ]; then echo \"fixture: can't evaluate field Id in type *formatter.ContainerContext\" >&2; exit 1; fi",
        "  [ \"$format\" = '{{.Names}} {{.ID}}' ] || exit 64",
        "  case \"$TUNER_FIXTURE_FAULT\" in list-error) echo 'fixture: peer list unavailable' >&2; exit 1 ;; empty-list) exit 0 ;; esac",
        "  if [ \"$truncated\" -eq 1 ]; then while read -r name id; do printf '%s %.12s\\n' \"$name\" \"$id\"; done < \"$TUNER_FIXTURE_LIST\"",
        "  else cat \"$TUNER_FIXTURE_LIST\"; fi ;;",
        " *) exit 64 ;;",
        "esac", "",
      ].join("\n"));
      const tier = row.tier ?? "pressure";
      const availableMiB = tier === "severe" ? 1500 : tier === "watch" ? 3500
        : tier === "calm" || tier === "no-squeeze" ? 9000 : 3000;
      const swapin = tier === "watch" || tier === "calm" || tier === "no-squeeze" ? 5000 : 65000;
      writeFileSync(join(h.root, "meminfo"), `MemTotal: ${HOST_KB} kB\nMemAvailable: ${availableMiB * 1024} kB\n`);
      writeFileSync(join(h.root, "vmstat"), `pswpin ${swapin}\npswpout 9000\nallocstall_normal 10\nallocstall_movable 20\n`);
      const then = Math.floor(Date.now() / 1000) - 300;
      const noSqueeze = tier === "no-squeeze";
      writeFileSync(join(h.root, "cfg", "state", `memory-high-sample-${row.current}.txt`),
        `v1 ${then} ${currentId} ${noSqueeze ? 1124 : 1000} ${noSqueeze ? 25000 : 7000} 5000 30 0\n`);
      if (row.fault === "missing-high") rmSync(join(peerCg, "memory.high"));
      if (row.fault === "malformed-high") writeFileSync(join(peerCg, "memory.high"), "unreadable-number\n");
      if (row.learned) writeFileSync(join(h.root, "cfg", "state", `memory-high-tuned-${row.current}.json`),
        JSON.stringify({ container: row.current, high_mib: row.learned }) + "\n");
      const peerInput = existsSync(join(peerCg, "memory.high")) ? readFileSync(join(peerCg, "memory.high"), "utf8") : undefined;
      const run = spawnSync("bash", [TUNER, "--container", row.current, "--state-dir", join(h.root, "cfg")], {
        encoding: "utf8", env: { ...h.env, TUNER_FIXTURE_ARGV: argvPath, TUNER_FIXTURE_CALLS: h.calls,
          TUNER_FIXTURE_CONTAINER: row.current, TUNER_FIXTURE_ID: currentId, TUNER_FIXTURE_LIST: listPath,
          TUNER_FIXTURE_FAULT: row.fault ?? "" },
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.signal, null, "a signalled fixture is not a result");
      const argv = readFileSync(argvPath, "utf8").split("\0\0").filter(Boolean).map(command => command.split("\0"));
      assert.deepEqual(argv, [
        ["inspect", "--format", "{{.Id}}", row.current],
        ...(row.fault === "short-inspect" ? [] : [["ps", "--no-trunc", "--format", "{{.Names}} {{.ID}}"]),
      ], "the real shell must ask Docker for full IDs with the documented ps field");
      assert.equal(readFileSync(join(h.cg, "memory.high"), "utf8").trim(), String(row.target * MIB), run.stdout);
      assert.match(run.stdout, new RegExp(row.action === "hold" ? "hold" : row.action + " .*via systemd"));
      const calls = readFileSync(h.calls, "utf8");
      if (row.action === "hold") {
        assert.doesNotMatch(calls, /systemctl set-property/);
        assert.equal(existsSync(join(h.root, "cfg", "state", "ledger.ndjson")), false);
        assert.equal(existsSync(join(h.root, "cfg", "state", `memory-high-tuned-${row.current}.json`)), false);
      } else {
        assert.match(calls, new RegExp(`systemctl set-property --runtime docker-${currentId}\\.scope MemoryHigh=${row.target * MIB}`));
        const ledger = readFileSync(join(h.root, "cfg", "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        assert.equal(ledger.length, 1);
        assert.deepEqual([ledger[0].container, ledger[0].action, ledger[0].before_mib, ledger[0].after_mib],
          [row.current, row.action, row.live, row.target]);
      }
      if (row.fault === "short-inspect") assert.match(run.stdout, /hold: container identity unavailable/);
      else if (row.fault && tier === "pressure" && row.action === "hold")
        assert.match(run.stdout, /hold.*peer.*(?:unread|unavailable|empty|identity)/i, "unknown peer evidence must be named");
      if (tier === "watch") assert.match(run.stdout, /tier 1/);
      if (tier === "severe") assert.match(run.stdout, /tier 3/);
      if (tier === "no-squeeze") assert.match(run.stdout, /no squeeze/);
      for (const boundary of boundaries) {
        assert.equal(readFileSync(join(boundary.cg, "memory.max"), "utf8"), boundary.max);
        assert.equal(readFileSync(join(boundary.cg, "memory.swap.max"), "utf8"), boundary.swapMax);
      }
      assert.equal(existsSync(join(peerCg, "memory.high")), peerInput !== undefined);
      if (peerInput !== undefined) assert.equal(readFileSync(join(peerCg, "memory.high"), "utf8"), peerInput);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});
