/**
 * THE INSTANCES' MEMORY CEILINGS WERE SIZED IN ISOLATION, SO THEY OVERCOMMITTED THE HOST.
 *
 * OBSERVED 2026-10-09 on the 15.6 GiB fleet host: remudero-daemon, remudero-site-daemon and
 * remudero-console-daemon each carried memory.max 8.6 GiB + 4 GiB swap (each "host - serve reserve -
 * overhead"), serve 7.5 GiB, none with memory.high — ceilings that only bit after the host was already
 * swapping (600-2,300 pages/s, 23 OOM kills since boot). These drive the SHIPPED drift reader
 * (src/lib/deployer.ts), which evaluates deploy/resource-policy.sh through real bash; only docker is faked.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MEMORY_HIGH_ANNOTATION,
  decideDeployTrigger,
  readResourcePolicyDrift,
  resourcePolicyDriftFrom,
  type ResourcePolicyDrift,
} from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const MIB = 1024 * 1024;
const HOST_KB = 16371996; // the fleet host's MemTotal, read 2026-10-09
const HOST_MIB = Math.floor(HOST_KB / 1024);
const HOST_RESERVE_MIB = 2048;
const INSTANCES = [
  { container: "remudero-daemon", role: "build" },
  { container: "remudero-serve", role: "serve" },
  { container: "remudero-console-daemon", role: "build" },
  { container: "remudero-site-daemon", role: "build" },
] as const;
/** A container created before any policy: no limits, no annotations (Docker reports null). */
const BARE = { Memory: 0, MemorySwap: 0, CpuShares: 0, MemoryReservation: 0, Annotations: null };

function install(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}memory-budget-`));
  mkdirSync(join(root, "deploy"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "deploy", "resource-policy.sh"), join(root, "deploy", "resource-policy.sh"));
  writeFileSync(join(root, "meminfo"), `MemTotal:       ${HOST_KB} kB\nMemFree:          100000 kB\n`);
  return { root, env: { PATH: process.env.PATH, RMD_MEMINFO_PATH: join(root, "meminfo") } };
}

/** Each instance's expected limits, read as drift against a bare container through the shipped reader. */
function policyOf(root: string, env: NodeJS.ProcessEnv, role: "serve" | "build", container: string) {
  const drift = readResourcePolicyDrift(
    (cmd, args) => (cmd === "bash" ? execFileSync(cmd, args, { encoding: "utf8", env }) : JSON.stringify(BARE)),
    root,
    role,
    container,
  );
  assert.ok(drift, `${container}: the policy was unreadable`);
  const field = (f: ResourcePolicyDrift["field"]) => drift.find((d) => d.field === f)?.expected ?? 0;
  return { max: field("Memory"), high: field("MemoryHigh"), swap: field("MemorySwap") - field("Memory") };
}

test("on a 15.6 GiB host the four instances' memory ceilings sum to no more than RAM minus the host reserve, each with memory.high below its max", () => {
  const { root, env } = install();
  try {
    const p = Object.fromEntries(INSTANCES.map(({ container, role }) => [container, policyOf(root, env, role, container)]));
    const budget = (HOST_MIB - HOST_RESERVE_MIB) * MIB;
    const sumMax = Object.values(p).reduce((n, x) => n + x.max, 0);
    assert.ok(sumMax > 0.95 * budget, `the budget is spent, not left idle: ${sumMax / MIB} MiB of ${budget / MIB}`);
    assert.ok(sumMax <= budget, `memory.max sums to ${sumMax / MIB} MiB, over the ${budget / MIB} MiB budget`);
    for (const [name, x] of Object.entries(p)) {
      assert.ok(x.max > 0, `${name} has a ceiling`);
      assert.ok(x.high > 0 && x.high < x.max, `${name}: memory.high ${x.high / MIB} MiB must sit below memory.max ${x.max / MIB} MiB`);
      assert.ok(Math.abs(x.high / x.max - 0.85) < 0.01, `${name}: memory.high is ~85% of max (${(x.high / x.max).toFixed(3)})`);
      assert.ok(x.swap > 0 && x.swap < 4096 * MIB, `${name}: swap ${x.swap / MIB} MiB is a budget share, not a flat 4 GiB`);
    }
    const core = p["remudero-daemon"]!;
    assert.ok(core.max > p["remudero-console-daemon"]!.max && core.max > p["remudero-site-daemon"]!.max, "core outweighs site and console");
    assert.ok(core.swap > p["remudero-site-daemon"]!.swap, "swap scales with the instance's share");
    const sumSwap = Object.values(p).reduce((n, x) => n + x.swap, 0);
    assert.ok(sumSwap <= budget / 2, `swap allowances sum to ${sumSwap / MIB} MiB, within half the budget`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a container whose memory.high differs from the policy is due a recycle naming MemoryHigh", () => {
  const { root, env } = install();
  try {
    const expectedArgs = execFileSync(
      "bash",
      ["-c", 'source "$1"; resource_policy_build_args remudero-daemon; printf "%s\\n" "${RESOURCE_POLICY_BUILD_ARGS[@]}"', "p", join(root, "deploy", "resource-policy.sh")],
      { encoding: "utf8", env },
    );
    const { max, high, swap } = policyOf(root, env, "build", "remudero-daemon");
    const limits = { Memory: max, MemorySwap: max + swap, CpuShares: 512, MemoryReservation: 0 };

    // Every limit on the policy but memory.high absent (Docker's null annotations): drift, and the
    // watchdog tick recycles through the existing create-drift path.
    const missing = resourcePolicyDriftFrom(expectedArgs, JSON.stringify({ ...limits, Annotations: null }));
    assert.deepEqual(missing, [{ field: "MemoryHigh", expected: high, actual: 0 }]);
    const d = decideDeployTrigger({
      markerPresent: false, autoMode: false, installHead: "c", originMain: "c", runningHead: "c",
      daemonAlive: true, stopPresent: false, imageDriftOnly: true, imageBakedCommitsBehind: 0,
      resourcePolicyDrift: missing,
    });
    assert.equal(d.deploy, true, d.reason);
    assert.match(d.reason, new RegExp(`automatic resource-policy recycle: MemoryHigh expected=${high} actual=0`));

    // A stale value is drift too; the policy's own value is not.
    const stale = resourcePolicyDriftFrom(expectedArgs, JSON.stringify({ ...limits, Annotations: { [MEMORY_HIGH_ANNOTATION]: `uint64 ${high - MIB}` } }));
    assert.deepEqual(stale, [{ field: "MemoryHigh", expected: high, actual: high - MIB }]);
    assert.deepEqual(resourcePolicyDriftFrom(expectedArgs, JSON.stringify({ ...limits, Annotations: { [MEMORY_HIGH_ANNOTATION]: `uint64 ${high}` } })), []);
    // An annotation in a shape the launcher never writes is UNKNOWN — never a recycle storm.
    assert.equal(resourcePolicyDriftFrom(expectedArgs, JSON.stringify({ ...limits, Annotations: { [MEMORY_HIGH_ANNOTATION]: "5G" } })), undefined);
    assert.equal(resourcePolicyDriftFrom(expectedArgs, JSON.stringify({ ...limits, Annotations: "MemoryHigh" })), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
