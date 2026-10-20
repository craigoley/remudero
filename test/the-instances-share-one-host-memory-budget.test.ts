/**
 * NO INSTANCE HAD A memory.high, AND EACH HARD CEILING WAS SIZED IN ISOLATION.
 *
 * OBSERVED 2026-10-09 on the 15.6 GiB fleet host: three build daemons at memory.max 8.6 GiB + 4 GiB
 * swap each and serve at 7.5 GiB, none with memory.high, so nothing pushed back until the host was
 * already swapping (600-2,300 pages/s, 23 OOM kills since boot). Operator ruling: SOFT LIMITS ONLY —
 * memory.max and swap stay exactly as they were; memory.high is added, sized from one host budget by
 * weight and never below an instance's observed working set. These drive the SHIPPED drift reader
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
import { readDaemonMemoryPolicy } from "../src/lib/daemon-memory-policy.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const MIB = 1024 * 1024;
const GB = 1e9;
const HOST_KB = 16371996; // the fleet host's MemTotal, read 2026-10-09 (15988 MiB)
const HOST_RESERVE_MIB = 2048;
/** Observed steady working sets, 2026-10-09: core main 4.5 GB + one tsc run 3.5 GB; serve ~5 GB. */
const INSTANCES = [
  { container: "remudero-daemon", role: "build", workingSet: 8.0 * GB },
  { container: "remudero-serve", role: "serve", workingSet: 5.0 * GB },
  { container: "remudero-console-daemon", role: "build", workingSet: 1.5 * GB },
  { container: "remudero-site-daemon", role: "build", workingSet: 1.0 * GB },
] as const;
/**
 * The most an IDLE site daemon was charged when its memory governor restarted it: the largest rss+swap
 * across all 189 site daemon.heap_pressure_exit rows from 2026-10-14T08:38Z to 2026-10-15T10:28Z
 * (share x budget_bytes; used heap 274 MiB at most, so no work in flight). Earlier rows on 10-14 ran
 * a 0.7 GB heap and are not an idle boot.
 */
const SITE_IDLE_BOOT_MAX_MIB = 942;
/** A host big enough that every weighted share clears its floor (site's 2/31 needs a 35.7 GiB budget). */
const BIG_HOST_MIB = 40 * 1024;
/** A container created before any policy: no limits, no annotations (Docker reports null). */
const BARE = { Memory: 0, MemorySwap: 0, CpuShares: 0, MemoryReservation: 0, Annotations: null };

function install(hostKb = HOST_KB): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}memory-budget-`));
  mkdirSync(join(root, "deploy"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "deploy", "resource-policy.sh"), join(root, "deploy", "resource-policy.sh"));
  writeFileSync(join(root, "meminfo"), `MemTotal:       ${hostKb} kB\nMemFree:          100000 kB\n`);
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
  return { max: field("Memory"), swap: field("MemorySwap"), high: field("MemoryHigh") };
}

test("each instance's memory.high sits above its working set and below an unchanged memory.max, summing to the host budget where the working sets fit", () => {
  const { root, env } = install();
  const big = install(BIG_HOST_MIB * 1024);
  try {
    const hostMib = Math.floor(HOST_KB / 1024);
    // SOFT LIMITS ONLY: memory.max and swap are byte-identical to the policy before memory.high existed,
    // except serve's swap, which operator ruling 2026-10-19 raised from 1 GiB to 2 GiB.
    const baseMax = { build: hostMib - 5120 - 2048, serve: 7680 };
    const baseSwap = { build: 4096, serve: 2048 };
    for (const { container, role, workingSet } of INSTANCES) {
      const p = policyOf(root, env, role, container);
      assert.equal(p.max, baseMax[role] * MIB, `${container}: memory.max unchanged`);
      assert.equal(p.swap, (baseMax[role] + baseSwap[role]) * MIB, `${container}: swap unchanged`);
      assert.ok(p.high > 0 && p.high < p.max, `${container}: memory.high ${p.high / MIB} MiB below memory.max ${p.max / MIB} MiB`);
      assert.ok(p.high > workingSet, `${container}: memory.high ${p.high / MIB} MiB above its ${workingSet / GB} GB working set`);
    }

    // Where the working sets fit (a 40 GiB host), the weighted shares decide and sum to the budget.
    const budget = (BIG_HOST_MIB - HOST_RESERVE_MIB) * MIB;
    const highs = INSTANCES.map(({ container, role }) => policyOf(big.root, big.env, role, container).high);
    const sum = highs.reduce((n, h) => n + h, 0);
    assert.ok(sum <= budget, `memory.high sums to ${sum / MIB} MiB against a ${budget / MIB} MiB budget`);
    assert.equal(highs[0], Math.floor((budget / MIB) * 16 / 31) * MIB, "core's high is its 16/31 weighted share, not a floor");
    assert.ok(highs[0]! > highs[2]! && highs[0]! > highs[3]!, "core outweighs console and site");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(big.root, { recursive: true, force: true });
  }
});

test("the site daemon's restart line clears an idle boot, so an idle site daemon does not restart in a loop", () => {
  // OBSERVED 2026-10-13 to 10-15: memory.high 1536 MiB put the governor's restart line at 768 MiB,
  // under an idle boot, so the site daemon restarted every few minutes doing no work. The memory-high
  // tuner never goes below the policy value, so the policy is the lowest line the daemon can see.
  const { root, env } = install();
  try {
    const { restartShare } = readDaemonMemoryPolicy(join(REPO_ROOT, "plan", "policy.yaml")).policy;
    const { high } = policyOf(root, env, "build", "remudero-site-daemon");
    const lineMib = (high / MIB) * restartShare;
    assert.ok(
      lineMib > SITE_IDLE_BOOT_MAX_MIB,
      `site memory.high ${high / MIB} MiB x restartShare ${restartShare} = ${lineMib} MiB, at or under an idle boot's ${SITE_IDLE_BOOT_MAX_MIB} MiB`,
    );
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
    const limits = { Memory: max, MemorySwap: swap, CpuShares: 512, MemoryReservation: 0 };

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
