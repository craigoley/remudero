/**
 * W1-T4267 — A MERGED RESOURCE POLICY NEVER REACHED A RUNNING CONTAINER.
 *
 * MEASURED 2026-09-23 13:34Z on the fleet host: after W1-T4102 merged, `docker inspect` showed
 * remudero-daemon at Memory=0 CpuShares=0 while the recycled console daemon carried the ceiling.
 * Limits apply only when a container is CREATED, and the recycle tick read image drift alone, so a
 * policy change created no recycle pressure. These drive the decision, the supervisor tick and the
 * SHIPPED reader (only `execFile` faked for docker; the policy itself runs through real bash).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  IMAGE_RECYCLE_FAILURE_BACKOFF_MS,
  IMAGE_SHA_CONTAINER,
  decideDeployTrigger,
  realDeployDeps,
  resourcePolicyDriftFrom,
  runDeployCycle,
  type DeployDeps,
  type ResourcePolicyDrift,
  type TriggerInputs,
} from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-09-23T13:34:00.000Z");
const HEAD = "c".repeat(40);
const MIB = 1024 * 1024;

/** The watchdog tick on the incident's host: checkout, daemon and image all current. */
const tick: TriggerInputs = {
  markerPresent: false,
  autoMode: false,
  installHead: HEAD,
  originMain: HEAD,
  runningHead: HEAD,
  daemonAlive: true,
  stopPresent: false,
  imageDriftOnly: true,
  imageBakedCommitsBehind: 0,
  nowMs: NOW,
};

/** The incident's HostConfig: no ceiling, default weight. */
const UNLIMITED = { Memory: 0, MemorySwap: 0, CpuShares: 0, MemoryReservation: 0, Privileged: false };
const DRIFT: ResourcePolicyDrift[] = [
  { field: "Memory", expected: 12041 * MIB, actual: 0 },
  { field: "CpuShares", expected: 512, actual: 0 },
];

/** A throwaway install holding the REAL policy file, plus a meminfo the policy reads (15625 MiB). */
function fixture(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}resource-policy-`));
  mkdirSync(join(root, "deploy"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "deploy", "resource-policy.sh"), join(root, "deploy", "resource-policy.sh"));
  writeFileSync(join(root, "meminfo"), "MemTotal:       16000000 kB\nMemFree:         1000000 kB\n");
  return { root, env: { PATH: process.env.PATH, RMD_MEMINFO_PATH: join(root, "meminfo") } };
}

function shippedReader(root: string, execFile: (cmd: string, args: string[]) => string) {
  return realDeployDeps({
    installPath: root,
    stateRoot: root,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 4317,
    uid: 501,
    ledgerPath: join(root, "ledger.ndjson"),
    log: () => {},
    sleep: () => {},
    execFile,
  }).resourcePolicyDrift!;
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test("a container whose live limits differ from the policy is due a recycle", () => {
  const d = decideDeployTrigger({ ...tick, resourcePolicyDrift: DRIFT });
  assert.equal(d.deploy, true, d.reason);
  assert.match(d.reason, /automatic resource-policy recycle/);

  // CONTROL: the same tick with limits that MATCH is up-to-date — the drift is what decided.
  const matched = decideDeployTrigger({ ...tick, resourcePolicyDrift: [] });
  assert.equal(matched.deploy, false);
  assert.match(matched.reason, /up-to-date/);

  // Same bounds as the automatic image recycle: STOP (set or unknown) and a recent failure hold it.
  for (const stopPresent of [true, undefined]) {
    const held = decideDeployTrigger({ ...tick, stopPresent, resourcePolicyDrift: DRIFT });
    assert.equal(held.deploy, false, `stopPresent=${stopPresent}`);
    assert.match(held.reason, /resource policy drift .*STOP is set or unknown/);
  }
  const backingOff = decideDeployTrigger({ ...tick, resourcePolicyDrift: DRIFT, lastFailedAtMs: NOW - 60_000 });
  assert.equal(backingOff.deploy, false);
  assert.match(backingOff.reason, /backs off/);
  const after = decideDeployTrigger({ ...tick, resourcePolicyDrift: DRIFT, lastFailedAtMs: NOW - IMAGE_RECYCLE_FAILURE_BACKOFF_MS - 1 });
  assert.equal(after.deploy, true, "the back-off is an hour, not forever");

  // The operator's full reading (not the tick) is unchanged by a drift reading.
  const full = decideDeployTrigger({ ...tick, imageDriftOnly: undefined, resourcePolicyDrift: DRIFT });
  assert.match(full.reason, /up-to-date/);

  // THE SUPERVISOR TICK: the drift reader is asked only on the tick, and a drift recycles through
  // the existing idle gate and restart backend.
  const calls: string[] = [];
  let asked = 0;
  const deps = {
    log: () => {},
    now: () => NOW,
    fetch: () => {},
    installHead: () => HEAD,
    runningHead: () => HEAD,
    originMain: () => HEAD,
    markerPresent: () => false,
    autoMode: () => false,
    lastFailedHead: () => undefined,
    daemonAlive: () => true,
    stopPresent: () => false,
    imageBakedCommitsBehind: () => 0,
    resourcePolicyDrift: () => {
      asked++;
      return DRIFT;
    },
    lastFailedAtMs: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    pullFf: () => calls.push("pullFf"),
    resetHard: () => {},
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => calls.push("kickstart"),
    waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }),
    alert: () => calls.push("alert"),
    clearMarker: () => {},
    kickstartConsole: () => {},
    consolePid: () => 1,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
  } as unknown as DeployDeps;
  const operator = runDeployCycle(deps);
  assert.equal(asked, 0, "outside the tick the live limits are not read");
  assert.equal(operator.deployed, false);
  const out = runDeployCycle(deps, { imageDriftOnly: true });
  assert.equal(asked, 1);
  assert.equal(out.deployed, true, out.reason);
  assert.ok(calls.includes("kickstart") && !calls.includes("alert"), calls.join(","));
});

test("the recycle reason names each drifted limit as expected and actual", () => {
  const { root, env } = fixture();
  const inspected: string[][] = [];
  const execFile = (cmd: string, args: string[]): string => {
    if (cmd === "bash") return execFileSync(cmd, args, { encoding: "utf8", env });
    inspected.push(args);
    return `${JSON.stringify(UNLIMITED)}\n`;
  };
  try {
    // THE SHIPPED READER, on the incident's HostConfig: the build policy's real output (15625 MiB
    // host - 1536 serve reserve - 2048 overhead = 12041 MiB, +4096 MiB swap, 512 shares).
    const drift = withEnv({ RMD_RESOURCE_POLICY_CONTAINER: undefined, RMD_RESOURCE_POLICY_ROLE: undefined }, () =>
      shippedReader(root, execFile)(),
    );
    assert.deepEqual(drift, [
      { field: "Memory", expected: 12041 * MIB, actual: 0 },
      { field: "MemorySwap", expected: 16137 * MIB, actual: 0 },
      { field: "CpuShares", expected: 512, actual: 0 },
    ]);
    assert.deepEqual(inspected[0], ["inspect", IMAGE_SHA_CONTAINER, "--format", "{{json .HostConfig}}"]);

    const d = decideDeployTrigger({ ...tick, resourcePolicyDrift: drift });
    assert.equal(d.deploy, true);
    assert.match(d.reason, new RegExp(`Memory expected=${12041 * MIB} actual=0`));
    assert.match(d.reason, new RegExp(`MemorySwap expected=${16137 * MIB} actual=0`));
    assert.match(d.reason, /CpuShares expected=512 actual=0/);
    assert.doesNotMatch(d.reason, /MemoryReservation/, "a field that matches is not named");

    // The launcher names its own container and role; serve's policy is a reservation, no ceiling.
    const serve = withEnv({ RMD_RESOURCE_POLICY_CONTAINER: "remudero-core-daemon", RMD_RESOURCE_POLICY_ROLE: "serve" }, () =>
      shippedReader(root, execFile)(),
    );
    assert.equal(inspected[1]![1], "remudero-core-daemon");
    assert.deepEqual(serve, [
      { field: "CpuShares", expected: 4096, actual: 0 },
      { field: "MemoryReservation", expected: 1536 * MIB, actual: 0 },
    ]);

    // A container already on the policy reads NO drift (Docker's -1 swap is drift, not unknown).
    const onPolicy = { Memory: 12041 * MIB, MemorySwap: 16137 * MIB, CpuShares: 512, MemoryReservation: 0 };
    assert.deepEqual(resourcePolicyDriftFrom("--cpu-shares=512\n--memory=12041m\n--memory-swap=16137m\n", JSON.stringify(onPolicy)), []);
    assert.deepEqual(resourcePolicyDriftFrom("--memory=1m\n--memory-swap=2m\n", JSON.stringify({ ...UNLIMITED, Memory: MIB, MemorySwap: -1 })), [
      { field: "MemorySwap", expected: 2 * MIB, actual: -1 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable container inspect never forces a recycle", () => {
  const { root, env } = fixture();
  try {
    const bash = (args: string[]) => execFileSync("bash", args, { encoding: "utf8", env });
    // The container is down or absent: docker inspect fails.
    const down = shippedReader(root, (cmd, args) => {
      if (cmd === "bash") return bash(args);
      throw new Error("Error: No such object: remudero-daemon");
    })();
    assert.equal(down, undefined, "an unreadable inspect is UNKNOWN, never drift and never 'matched'");
    // Readable but not a HostConfig: garbage, null, or a field that is not a number.
    for (const text of ["not json", "null", JSON.stringify({ ...UNLIMITED, CpuShares: "512" })]) {
      assert.equal(resourcePolicyDriftFrom("--cpu-shares=512\n", text), undefined, text);
    }
    // The policy side unreadable (no policy file in this install) is UNKNOWN too.
    rmSync(join(root, "deploy", "resource-policy.sh"));
    const noPolicy = shippedReader(root, (cmd, args) => (cmd === "bash" ? bash(args) : JSON.stringify(UNLIMITED)))();
    assert.equal(noPolicy, undefined);

    // UNKNOWN changes no decision: the tick stays up-to-date.
    const d = decideDeployTrigger({ ...tick, resourcePolicyDrift: undefined });
    assert.equal(d.deploy, false);
    assert.match(d.reason, /up-to-date/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
