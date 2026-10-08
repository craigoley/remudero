/**
 * W1-T6110 — A MERGED SCRATCH BIND NEVER REACHED A RUNNING CONTAINER.
 *
 * Binds, like W1-T4267's limits, apply only when a container is CREATED, and the watchdog tick
 * recycled on image and policy drift alone, so #9761's test-slot bind (and every later one) waited
 * for an unrelated recreate. Its revival path also sourced the INSTALLED rmd-scratch-mounts copy,
 * which only `install-host-units.sh --install` refreshes. These drive the decision, the supervisor
 * tick and the SHIPPED reader: the plan runs through real bash over the real deploy/scratch-mounts.sh;
 * only `docker inspect` is a fixture. No real container is touched.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as deployer from "../src/lib/deployer.js";
import {
  IMAGE_RECYCLE_FAILURE_BACKOFF_MS,
  IMAGE_SHA_CONTAINER,
  decideDeployTrigger,
  realDeployDeps,
  runDeployCycle,
  type DeployDeps,
  type MountPlanDrift,
  type TriggerInputs,
} from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const LIB = join(REPO_ROOT, "deploy", "scratch-mounts.sh");
const NOW = Date.parse("2026-10-06T18:00:00.000Z");
const HEAD = "c".repeat(40);

/** The watchdog tick on a current host: checkout, daemon, image and limits all current. */
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
  resourcePolicyDrift: [],
  nowMs: NOW,
};

const SLOT_DRIFT: MountPlanDrift[] = [
  { target: "/home/node/rmd-scratch/test-slots", expected: "/mnt/scratch/rmd/test-slots", actual: undefined },
  { target: "env RMD_TEST_SLOT_DIR", expected: "/home/node/rmd-scratch/test-slots", actual: undefined },
];

interface Fixture {
  root: string;
  install: string;
  state: string;
  scratch: string;
  env: NodeJS.ProcessEnv;
}

/** A throwaway install holding the REAL scratch-mounts.sh, a scratch root the mounts table
 *  declares mounted, and the switch on. */
function fixture(t: { after: (fn: () => void) => void }): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mount-plan-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const install = join(root, "rmd-state2", "daemon-install");
  const state = join(root, "rmd-state2");
  const scratch = join(root, "mnt", "scratch");
  mkdirSync(join(install, "deploy"), { recursive: true });
  mkdirSync(join(state, "state"), { recursive: true });
  mkdirSync(scratch, { recursive: true });
  copyFileSync(LIB, join(install, "deploy", "scratch-mounts.sh"));
  writeFileSync(join(root, "mounts"), `/dev/nvme1n1 ${scratch} ext4 rw,noatime 0 0\n`);
  return {
    root, install, state, scratch,
    env: {
      PATH: process.env.PATH,
      NODE_V8_COVERAGE: "",
      RMD_SCRATCH: "on",
      RMD_SCRATCH_ROOT: scratch,
      RMD_SCRATCH_MOUNTS_FILE: join(root, "mounts"),
    },
  };
}

/** The live container the plan describes: every planned bind and variable, plus the launcher's own
 *  non-scratch mounts and env, which the reading must never consult. */
function liveInspect(f: Fixture, container: string, edit: (live: { Mounts: Record<string, unknown>[]; Env: string[] }) => void = () => {}): string {
  const base = join(f.scratch, "rmd", "rmd-state2");
  const binds: [string, string][] = [
    [`${base}/worktrees`, "/home/node/Remudero/worktrees"],
    [`${base}/tmp`, "/home/node/Remudero/tmp"],
    [`${base}/remudero-coverage`, "/home/node/Remudero/.remudero-coverage"],
    [`${base}/repos`, "/home/node/Remudero/repos"],
    [`${base}/repos-coverage`, "/home/node/Remudero/repos/.remudero-coverage"],
    [`${base}/read-model`, "/home/node/rmd-scratch/read-model"],
    [`${base}/worker-homes`, "/home/node/rmd-scratch/worker-homes"],
    [`${base}/containers/${container}/tmp`, "/tmp"],
    [`${f.scratch}/rmd/test-slots`, "/home/node/rmd-scratch/test-slots"],
  ];
  const live = {
    Mounts: [
      { Type: "bind", Source: f.state, Destination: "/home/node/Remudero", RW: true },
      { Type: "bind", Source: "/home/u/.claude", Destination: "/home/node/.claude", RW: true },
      ...binds.map(([Source, Destination]) => ({ Type: "bind", Source, Destination, Mode: "", RW: true })),
    ],
    Env: [
      "NODE_OPTIONS=--max-old-space-size=8192",
      `RMD_READ_MODEL_DB_DIR=/home/node/Remudero/state:/home/node/rmd-scratch/read-model`,
      `RMD_WORKER_HOME_DIR=/home/node/Remudero:/home/node/rmd-scratch/worker-homes`,
      "RMD_TEST_SLOT_DIR=/home/node/rmd-scratch/test-slots",
      "PATH=/usr/local/bin:/usr/bin",
    ],
  };
  edit(live);
  return JSON.stringify(live);
}

/** A container launched before #9761: no test-slot bind and no RMD_TEST_SLOT_DIR. */
function beforeTestSlots(f: Fixture, container: string): string {
  return liveInspect(f, container, (live) => {
    live.Mounts = live.Mounts.filter((m) => m.Destination !== "/home/node/rmd-scratch/test-slots");
    live.Env = live.Env.filter((e) => !e.startsWith("RMD_TEST_SLOT_DIR="));
  });
}

function shippedReader(f: Fixture, execFile: (cmd: string, args: string[]) => string) {
  return realDeployDeps({
    installPath: f.install,
    stateRoot: f.state,
    daemonLabel: "com.remudero.daemon",
    serveLabel: "com.remudero.serve",
    servePort: 4317,
    uid: 501,
    ledgerPath: join(f.root, "ledger.ndjson"),
    log: () => {},
    sleep: () => {},
    execFile,
  }).mountPlanDrift!;
}

/** Real bash for the plan under `env`; `inspect` answers docker. */
function execWith(f: Fixture, inspect: (args: string[]) => string, env: NodeJS.ProcessEnv = {}) {
  return (cmd: string, args: string[]): string => {
    if (cmd === "bash") return execFileSync(cmd, args, { encoding: "utf8", env: { ...f.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    if (cmd === "docker") return inspect(args);
    throw new Error(`unexpected ${cmd}`);
  };
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

test("a container missing a planned scratch bind is recycled with the drifted bind named", () => {
  const d = decideDeployTrigger({ ...tick, mountPlanDrift: SLOT_DRIFT });
  assert.equal(d.deploy, true, d.reason);
  assert.match(d.reason, /^automatic mount-plan recycle: \/home\/node\/rmd-scratch\/test-slots expected=\/mnt\/scratch\/rmd\/test-slots actual=absent, env RMD_TEST_SLOT_DIR expected=/);

  // CONTROL: the same tick with binds that MATCH is up-to-date — the drift is what decided.
  const matched = decideDeployTrigger({ ...tick, mountPlanDrift: [] });
  assert.equal(matched.deploy, false);
  assert.match(matched.reason, /up-to-date/);

  // The policy path's own bounds: STOP (set or unknown) and a failure under an hour ago hold it.
  for (const stopPresent of [true, undefined]) {
    const held = decideDeployTrigger({ ...tick, stopPresent, mountPlanDrift: SLOT_DRIFT });
    assert.equal(held.deploy, false, `stopPresent=${stopPresent}`);
    assert.match(held.reason, /^mount plan drift \(.*test-slots.*\), but STOP is set or unknown — no automatic recycle$/);
  }
  const backingOff = decideDeployTrigger({ ...tick, mountPlanDrift: SLOT_DRIFT, lastFailedAtMs: NOW - 60_000 });
  assert.equal(backingOff.deploy, false);
  assert.match(backingOff.reason, /^mount plan drift .*backs off$/);
  const after = decideDeployTrigger({ ...tick, mountPlanDrift: SLOT_DRIFT, lastFailedAtMs: NOW - IMAGE_RECYCLE_FAILURE_BACKOFF_MS - 1 });
  assert.equal(after.deploy, true, "the back-off is an hour, not forever");

  // Both create-time drifts at once: one recycle, both named; the policy wording is unchanged.
  const both = decideDeployTrigger({
    ...tick,
    resourcePolicyDrift: [{ field: "CpuShares", expected: 512, actual: 0 }],
    mountPlanDrift: SLOT_DRIFT,
  });
  assert.equal(both.deploy, true);
  assert.match(both.reason, /^automatic resource-policy recycle: CpuShares expected=512 actual=0; automatic mount-plan recycle: /);

  // The operator's full reading (not the tick) is unchanged by a drift reading.
  assert.match(decideDeployTrigger({ ...tick, imageDriftOnly: undefined, mountPlanDrift: SLOT_DRIFT }).reason, /up-to-date/);

  // THE SUPERVISOR TICK: the reader is asked only on the tick, and drift recycles through the
  // existing idle gate and restart backend.
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
    resourcePolicyDrift: () => [],
    mountPlanDrift: () => {
      asked++;
      return SLOT_DRIFT;
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
  assert.equal(runDeployCycle(deps).deployed, false);
  assert.equal(asked, 0, "outside the tick the live binds are not read");
  const out = runDeployCycle(deps, { imageDriftOnly: true });
  assert.equal(asked, 1);
  assert.equal(out.deployed, true, out.reason);
  assert.ok(calls.includes("kickstart") && !calls.includes("alert"), calls.join(","));
});

test("the shipped reader finds the bind and variable a container launched before the plan lacks", (t) => {
  const f = fixture(t);
  const inspected: string[][] = [];
  const read = (container: string | undefined, inspect: string) =>
    withEnv({ RMD_RESOURCE_POLICY_CONTAINER: container }, () =>
      shippedReader(f, execWith(f, (args) => {
        inspected.push(args);
        return `${inspect}\n`;
      }))(),
    );

  const drift = read(undefined, beforeTestSlots(f, IMAGE_SHA_CONTAINER));
  assert.deepEqual(drift, [
    { target: "/home/node/rmd-scratch/test-slots", expected: `${f.scratch}/rmd/test-slots`, actual: undefined },
    { target: "env RMD_TEST_SLOT_DIR", expected: "/home/node/rmd-scratch/test-slots", actual: undefined },
  ]);
  assert.deepEqual(inspected[0], ["inspect", IMAGE_SHA_CONTAINER, "--format", '{"Mounts":{{json .Mounts}},"Env":{{json .Config.Env}}}']);
  const d = decideDeployTrigger({ ...tick, mountPlanDrift: drift });
  assert.equal(d.deploy, true, d.reason);
  assert.match(d.reason, new RegExp(`/home/node/rmd-scratch/test-slots expected=${f.scratch}/rmd/test-slots actual=absent`));

  // The launcher names its own container, and the plan's per-container /tmp follows it.
  assert.deepEqual(read("remudero-core-daemon", liveInspect(f, "remudero-core-daemon")), [], "binds that match are not drift");
  assert.equal(inspected[1]![1], "remudero-core-daemon");
  assert.deepEqual(read("remudero-core-daemon", liveInspect(f, IMAGE_SHA_CONTAINER)), [
    {
      target: "/tmp",
      expected: `${f.scratch}/rmd/rmd-state2/containers/remudero-core-daemon/tmp`,
      actual: `${f.scratch}/rmd/rmd-state2/containers/${IMAGE_SHA_CONTAINER}/tmp`,
    },
  ], "a planned bind at a different source is drift");

  // A read-only bind, or a planned variable with another value, is drift too.
  const readOnly = read(undefined, liveInspect(f, IMAGE_SHA_CONTAINER, (live) => {
    live.Mounts = live.Mounts.map((m) => (m.Destination === "/home/node/Remudero/tmp" ? { ...m, RW: false } : m));
    live.Env = live.Env.map((e) => (e.startsWith("RMD_TEST_SLOT_DIR=") ? "RMD_TEST_SLOT_DIR=/elsewhere" : e));
  }));
  assert.deepEqual(readOnly?.map((x) => [x.target, x.actual]), [
    ["/home/node/Remudero/tmp", `${f.scratch}/rmd/rmd-state2/tmp (read-only)`],
    ["env RMD_TEST_SLOT_DIR", "/elsewhere"],
  ]);
});

test("mount and env differences the scratch plan does not own are not drift", (t) => {
  const f = fixture(t);
  const read = (inspect: string) =>
    withEnv({ RMD_RESOURCE_POLICY_CONTAINER: undefined }, () => shippedReader(f, execWith(f, () => inspect))());
  const unrelated = read(liveInspect(f, IMAGE_SHA_CONTAINER, (live) => {
    // A different credential mount, an extra volume, a missing state bind and other env: none are
    // the scratch plan's, so another launch argument owns each and none may force a recycle.
    live.Mounts = live.Mounts
      .filter((m) => m.Destination !== "/home/node/Remudero")
      .map((m) => (m.Destination === "/home/node/.claude" ? { ...m, Source: "/other/.claude", RW: false } : m));
    live.Mounts.push({ Type: "volume", Name: "v", Source: "/var/lib/docker/volumes/v", Destination: "/data", RW: true });
    live.Env = live.Env.filter((e) => !e.startsWith("NODE_OPTIONS=")).concat("GH_APP_ID=1");
  }));
  assert.deepEqual(unrelated, []);
  assert.match(decideDeployTrigger({ ...tick, mountPlanDrift: unrelated }).reason, /up-to-date/);
});

test("an unreadable or disabled scratch plan never recycles a container to add or remove binds", (t) => {
  const f = fixture(t);
  const lacking = beforeTestSlots(f, IMAGE_SHA_CONTAINER);
  const read = (inspect: (args: string[]) => string, env: NodeJS.ProcessEnv = {}) =>
    withEnv({ RMD_RESOURCE_POLICY_CONTAINER: undefined }, () => shippedReader(f, execWith(f, inspect, env))());

  // CONTROL: this very container reads drift with the plan on, so each UNKNOWN below is the cause.
  assert.equal(read(() => lacking)?.length, 2);

  // DISABLED is "no desired binds", and that is UNKNOWN, not "recycle to remove them": a plan goes
  // off when the NVMe is briefly unmounted after a deallocate, and recycling then would move live
  // worktrees back onto the state disk; turning it off on purpose is an operator's own recycle.
  assert.equal(read(() => lacking, { RMD_SCRATCH: "off" }), undefined, "switch off");
  assert.equal(read(() => lacking, { RMD_SCRATCH_MOUNTS_FILE: join(f.root, "absent") }), undefined, "scratch root not mounted");
  // A plan scratch_prepare would drop (a planned dir it cannot create) launches without binds, so
  // recycling for them would repeat every tick.
  writeFileSync(join(f.scratch, "rmd"), "a file where the plan's directories go\n");
  assert.equal(read(() => lacking), undefined, "a planned dir the launch cannot create");
  rmSync(join(f.scratch, "rmd"));
  // The inspect side: the container down or absent, or an answer that is not an inspect.
  assert.equal(read(() => { throw new Error("Error: No such object: remudero-daemon"); }), undefined);
  for (const text of ["not json", "null", JSON.stringify({ Mounts: null, Env: [] }), JSON.stringify({ Mounts: [], Env: "x" })]) {
    assert.equal(read(() => text), undefined, text);
  }
  // No plan file in this install.
  rmSync(join(f.install, "deploy", "scratch-mounts.sh"));
  assert.equal(read(() => lacking), undefined, "no plan file");
  // A namespace read, so this file still LOADS on a tree without the reader and fails here instead.
  const { mountPlanDriftFrom } = deployer as Partial<typeof deployer>;
  assert.equal(typeof mountPlanDriftFrom, "function");
  assert.equal(mountPlanDriftFrom!("", lacking), undefined, "an empty plan is unknown");

  // UNKNOWN changes no decision: the tick stays up-to-date.
  assert.match(decideDeployTrigger({ ...tick, mountPlanDrift: undefined }).reason, /up-to-date/);
});

/** Renders the fleet units into a throwaway tree whose launcher and installed library are real. */
function installUnits(f: Fixture, mode: "--install" | "--check") {
  const units = {
    RMD_UNIT_DIR: join(f.root, "systemd"),
    RMD_BIN_DIR: join(f.root, "sbin"),
    RMD_LAUNCHER_PATH: join(f.root, "rmd-relaunch.sh"),
    RMD_REVIVAL_LOG: join(f.root, "revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_STATE_DIR: f.state,
  };
  return spawnSync("bash", [join(REPO_ROOT, "deploy", "install-host-units.sh"), ...(mode === "--install" ? ["--install"] : [])], {
    cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: "", ...units },
  });
}

/** Runs the rendered launcher's revival path against stub docker and findmnt. */
function relaunch(f: Fixture): { status: number | null; out: string; dockerRun: string } {
  const stubs = join(f.root, "stubs");
  mkdirSync(stubs, { recursive: true });
  writeFileSync(join(stubs, "docker"), `#!/usr/bin/env bash\necho "docker $*" >> "${f.root}/docker.log"\ncase "$1" in inspect) echo none ;; esac\nexit 0\n`);
  writeFileSync(join(stubs, "findmnt"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(stubs, "docker"), 0o755);
  chmodSync(join(stubs, "findmnt"), 0o755);
  writeFileSync(join(f.state, "state", "ledger.ndjson"), '{"step":"seed"}\n');
  rmSync(join(f.root, "docker.log"), { force: true });
  const r = spawnSync("bash", [join(f.root, "rmd-relaunch.sh")], {
    encoding: "utf8",
    env: { ...process.env, ...f.env, PATH: `${stubs}:${process.env.PATH ?? ""}` },
  });
  const log = existsSync(join(f.root, "docker.log")) ? readFileSync(join(f.root, "docker.log"), "utf8") : "";
  return { status: r.status, out: `${r.stdout}${r.stderr}`, dockerRun: log.split("\n").find((l) => l.startsWith("docker run")) ?? "" };
}

test("the launcher sources the checkout's scratch-mounts.sh before the installed copy", (t) => {
  const f = fixture(t);
  const installed = installUnits(f, "--install");
  assert.equal(installed.status, 0, installed.stderr);
  const installedLib = join(f.root, "sbin", "rmd-scratch-mounts");
  assert.equal(readFileSync(installedLib, "utf8"), readFileSync(LIB, "utf8"));

  // A bind merged after the install: the checkout's plan names it, the installed copy does not.
  const checkoutLib = join(f.install, "deploy", "scratch-mounts.sh");
  writeFileSync(checkoutLib, readFileSync(LIB, "utf8").replace(
    'SCRATCH_TEST_SLOT_DEST="/home/node/rmd-scratch/test-slots"',
    'SCRATCH_TEST_SLOT_DEST="/home/node/rmd-scratch/merged-after-install"',
  ));
  const fresh = relaunch(f);
  assert.equal(fresh.status, 0, fresh.out);
  assert.match(fresh.out, new RegExp(`scratch plan from ${checkoutLib}`));
  assert.match(fresh.dockerRun, /:\/home\/node\/rmd-scratch\/merged-after-install /, fresh.dockerRun);

  // The installed copy stays the fallback for a host whose checkout has no plan file.
  rmSync(checkoutLib);
  const fallback = relaunch(f);
  assert.equal(fallback.status, 0, fallback.out);
  assert.match(fallback.out, new RegExp(`scratch plan from ${installedLib}`));
  assert.match(fallback.dockerRun, /:\/home\/node\/rmd-scratch\/test-slots /, fallback.dockerRun);
});

test("a stale installed rmd-scratch-mounts is detected as drift, so the watchdog converge reinstalls it", (t) => {
  const f = fixture(t);
  assert.equal(installUnits(f, "--install").status, 0);
  const clean = installUnits(f, "--check");
  assert.equal(clean.status, 0, `a fresh install checks clean first: ${clean.stdout}${clean.stderr}`);
  const installedLib = join(f.root, "sbin", "rmd-scratch-mounts");
  // A copy installed before a plan change: one bind's destination differs from the checkout's.
  const before = readFileSync(installedLib, "utf8");
  const edited = before.replace('SCRATCH_TEST_SLOT_DEST="/home/node/rmd-scratch/test-slots"', 'SCRATCH_TEST_SLOT_DEST="/home/node/old"');
  assert.notEqual(edited, before, "the fixture edit applied");
  writeFileSync(installedLib, edited);
  const stale = installUnits(f, "--check");
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout, new RegExp(`DRIFTED ${installedLib}`));
});
