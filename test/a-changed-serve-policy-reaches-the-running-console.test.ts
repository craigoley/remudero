/**
 * A CHANGED SERVE POLICY NEVER REACHED THE RUNNING CONSOLE.
 *
 * 2026-10-02: #8569 raised serve's memory limit 5120 → 7680 MiB and its reservation 3072 → 5120 MiB.
 * Limits apply only when a container is CREATED, and W1-T4267's drift check covered the build
 * daemons only, so remudero-serve kept the old limits until an operator replaced it by hand. These
 * drive the serve convergence pass with injected seams, and its SHIPPED wiring with only docker,
 * the launcher and the issue gateway faked (the policy itself runs through real bash).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { IMAGE_RECYCLE_FAILURE_BACKOFF_MS, MEMORY_HIGH_ANNOTATION, type DeployDeps, type ResourcePolicyDrift } from "../src/lib/deployer.js";
import type { Escalation, IssueGateway } from "../src/lib/escalate.js";
import { loadHostMemoryBudgetPolicy } from "../src/lib/host-memory-shadow.js";
import {
  SERVE_POLICY_CONTAINER,
  SERVE_POLICY_FAILED_FILE,
  SERVE_REPLACE_HELD_EXIT,
  realServePolicyDeps,
  serveReplaceAdmissionEnv,
  runServePolicyCycle,
  serveHandoffOpen,
} from "../src/lib/serve-policy-convergence.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const MIB = 1024 * 1024;
const TICK = { imageDriftOnly: true };

/** serve as it ran after #8569 merged: the pre-change limits. */
const OLD_LIMITS = { Memory: 5120 * MIB, MemorySwap: 6144 * MIB, CpuShares: 4096, MemoryReservation: 3072 * MIB };
/** The policy since operator ruling 2026-10-19: 2 GiB of swap, and no reservation (memory.low protected nothing). */
const ON_POLICY = { Memory: 7680 * MIB, MemorySwap: 9728 * MIB, CpuShares: 4096, MemoryReservation: 0 };
const DRIFT: ResourcePolicyDrift[] = [
  { field: "Memory", expected: 7680 * MIB, actual: 5120 * MIB },
  { field: "MemorySwap", expected: 9728 * MIB, actual: 6144 * MIB },
  { field: "MemoryReservation", expected: 0, actual: 3072 * MIB },
];

interface Harness {
  deps: DeployDeps;
  rows: { step: string; data?: Record<string, unknown> }[];
  replaces: number;
  escalations: Escalation[];
  failures: { message: string; atMs: number }[];
  cleared: number;
}

/** A tick whose seams all read "go" unless overridden; the drift reader returns `drifts` in turn. */
function harness(over: Partial<DeployDeps> = {}, drifts: (ResourcePolicyDrift[] | undefined)[] = [DRIFT, []]): Harness {
  const h: Harness = { deps: undefined as unknown as DeployDeps, rows: [], replaces: 0, escalations: [], failures: [], cleared: 0 };
  let read = 0;
  h.deps = {
    log: (step: string, data?: Record<string, unknown>) => h.rows.push({ step, data }),
    now: () => NOW,
    stopPresent: () => false,
    pausePresent: () => false,
    serveHandoffInProgress: () => false,
    serveHealthy: () => true,
    servePolicyLastFailedAtMs: () => undefined,
    servePolicyDrift: () => drifts[Math.min(read++, drifts.length - 1)],
    replaceServe: () => {
      h.replaces++;
    },
    recordServePolicyFailure: (message: string, atMs: number) => h.failures.push({ message, atMs }),
    clearServePolicyFailure: () => {
      h.cleared++;
    },
    escalate: (e: Escalation) => h.escalations.push(e),
    ...over,
  } as unknown as DeployDeps;
  return h;
}

test("serve on its old limits is replaced once through the launcher naming each drifted field", () => {
  const h = harness();
  const out = runServePolicyCycle(h.deps, TICK);
  assert.equal(out.replaced, true, out.reason);
  assert.equal(h.replaces, 1);
  assert.match(out.reason, new RegExp(`Memory expected=${7680 * MIB} actual=${5120 * MIB}`));
  assert.match(out.reason, new RegExp(`MemoryReservation expected=0 actual=${3072 * MIB}`));
  assert.doesNotMatch(out.reason, /CpuShares/, "a field that matches is not named");
  assert.deepEqual(h.rows.map((r) => r.step), ["deploy.serve_policy_replace", "deploy.serve_policy_replaced"]);
  assert.deepEqual(h.rows[1]!.data?.drift, DRIFT);
  assert.equal(h.cleared, 1, "a verified replace retracts a recorded failure");
  assert.equal(h.escalations.length, 0);

  // Outside the watchdog tick, or on an instance with no serve seams, nothing is read or replaced.
  const operator = harness();
  assert.equal(runServePolicyCycle(operator.deps).replaced, false);
  const site = harness({ servePolicyDrift: undefined, replaceServe: undefined });
  assert.match(runServePolicyCycle(site.deps, TICK).reason, /primary instance/);
  assert.equal(operator.replaces + site.replaces, 0);
});

test("serve already on its policy is left alone with no ledger row", () => {
  for (const drift of [[], undefined]) {
    const h = harness({}, [drift]);
    const out = runServePolicyCycle(h.deps, TICK);
    assert.equal(out.replaced, false);
    assert.equal(h.replaces, 0, `drift=${JSON.stringify(drift)}`);
    assert.equal(h.rows.length, 0, "no drift is not news");
  }
});

test("a held serve replace writes a row that names why it waited", () => {
  const cases: [string, Partial<DeployDeps>, RegExp][] = [
    ["STOP", { stopPresent: () => true }, /STOP is set or unknown/],
    ["STOP unknown", { stopPresent: undefined }, /STOP is set or unknown/],
    ["PAUSE", { pausePresent: () => true }, /PAUSE is set or unknown/],
    ["recent failure", { servePolicyLastFailedAtMs: () => NOW - 60_000 }, /failed under an hour ago — backing off/],
    ["handoff", { serveHandoffInProgress: () => true }, /handoff is in progress/],
    ["handoff unknown", { serveHandoffInProgress: () => undefined }, /handoff is in progress or unreadable/],
    ["unhealthy", { serveHealthy: () => false }, /serve is not healthy now/],
  ];
  for (const [name, over, why] of cases) {
    const h = harness(over);
    const out = runServePolicyCycle(h.deps, TICK);
    assert.equal(h.replaces, 0, name);
    assert.equal(out.replaced, false, name);
    assert.equal(h.rows.length, 1, name);
    assert.equal(h.rows[0]!.step, "deploy.serve_policy_held", name);
    assert.match(String(h.rows[0]!.data?.reason), why, name);
    assert.deepEqual(h.rows[0]!.data?.drift, DRIFT, name);
  }
  // The back-off is an hour, not forever; a dry run reads everything and replaces nothing.
  const after = harness({ servePolicyLastFailedAtMs: () => NOW - IMAGE_RECYCLE_FAILURE_BACKOFF_MS - 1 });
  assert.equal(runServePolicyCycle(after.deps, TICK).replaced, true);
  const dry = harness();
  assert.match(runServePolicyCycle(dry.deps, { ...TICK, dryRun: true }).reason, /dry run/);
  assert.equal(dry.replaces, 0);
});

test("a failed serve replace records a back-off and escalates", () => {
  const thrown = harness({
    replaceServe: () => {
      throw new Error("serve-container: REFUSING — target image could not be pulled");
    },
  });
  const out = runServePolicyCycle(thrown.deps, TICK);
  assert.equal(out.replaced, false);
  assert.match(out.reason, /could not be pulled/);
  assert.deepEqual(thrown.failures, [{ message: "serve-container: REFUSING — target image could not be pulled", atMs: NOW }]);
  assert.equal(thrown.rows.at(-1)!.step, "deploy.serve_policy_failed");
  assert.equal(thrown.escalations.length, 1);
  assert.match(thrown.escalations[0]!.detail, /could not be pulled/);
  assert.match(thrown.escalations[0]!.detail, /Memory expected=/);
  assert.equal(thrown.cleared, 0);

  // The launcher said OK but the limits did not land, or serve is down afterwards: also a failure.
  const unchanged = harness({}, [DRIFT, DRIFT]);
  assert.match(runServePolicyCycle(unchanged.deps, TICK).reason, /still off the policy/);
  assert.equal(unchanged.escalations.length, 1);
  const unreadable = harness({}, [DRIFT, undefined]);
  assert.match(runServePolicyCycle(unreadable.deps, TICK).reason, /unreadable/);
  let healthReads = 0;
  const down = harness({ serveHealthy: () => healthReads++ === 0 });
  assert.match(runServePolicyCycle(down.deps, TICK).reason, /not running after the replace/);
  assert.equal(down.failures.length, 1);
});

test("a serve handoff is open from its request until the supervisor closes it", () => {
  const row = (step: string) => JSON.stringify({ ts: "2026-10-02T12:00:00Z", task_id: "SERVE", step });
  assert.equal(serveHandoffOpen(""), false);
  assert.equal(serveHandoffOpen([row("serve.supervisor_ready"), row("serve.handoff_requested")].join("\n")), true);
  assert.equal(serveHandoffOpen([row("serve.handoff_requested"), row("serve.handoff_deferred")].join("\n")), false, "W1-T9504: a deferral keeps the active generation");
  assert.equal(serveHandoffOpen([row("serve.handoff_requested"), row("serve.handoff_done"), row("daemon.boot")].join("\n")), false);
  assert.equal(serveHandoffOpen([row("serve.handoff_requested"), row("serve.supervisor_start")].join("\n")), false, "a restart ends it");
});

/** A throwaway primary install: the REAL policy file and launcher path, a registry, a state dir. */
function fixture(primary = true): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-policy-`));
  mkdirSync(join(root, "deploy"), { recursive: true });
  mkdirSync(join(root, ".remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "deploy", "resource-policy.sh"), join(root, "deploy", "resource-policy.sh"));
  writeFileSync(
    join(root, ".remudero", "daemon-instances.yaml"),
    `instances:\n  core:\n    repo: remudero\n${primary ? "    primary: true\n" : ""}    container_name: remudero-daemon\n    state_dir: ${root}\n`,
  );
  // No MemTotal: serve's memory.high (sized from host RAM) stays out of these limits on every runner.
  return { root, env: { PATH: process.env.PATH, RMD_MEMINFO_PATH: join(root, "no-meminfo") } };
}

test("the shipped serve wiring reads the serve role against remudero-serve and replaces through serve-container.sh", () => {
  const { root, env } = fixture();
  const calls: string[][] = [];
  let hostConfig = OLD_LIMITS;
  let running = "true false";
  const created: string[] = [];
  const gateway: IssueGateway = { create: (title) => (created.push(title), "https://github.com/o/r/issues/1"), listOpen: () => [] };
  const exec = (cmd: string, args: string[]): string => {
    if (cmd === "bash" && args[0] === "-c") return execFileSync(cmd, args, { encoding: "utf8", env });
    calls.push([cmd, ...args]);
    if (cmd === "docker" && args.includes("{{json .HostConfig}}")) return JSON.stringify(hostConfig);
    if (cmd === "docker") return `${running}\n`;
    if (cmd === "git") return "https://github.com/craigoley/remudero.git\n";
    hostConfig = ON_POLICY;
    return "";
  };
  try {
    const seams = realServePolicyDeps({ installPath: root, stateRoot: root }, exec, () => gateway);
    assert.deepEqual(seams.servePolicyDrift!(), DRIFT);
    assert.deepEqual(calls[0], ["docker", "inspect", SERVE_POLICY_CONTAINER, "--format", "{{json .HostConfig}}"]);
    assert.equal(seams.serveHealthy!(), true);
    assert.equal(seams.pausePresent!(), false);
    assert.equal(seams.serveHandoffInProgress!(), undefined, "no ledger yet reads unknown");
    writeFileSync(join(root, "state", "ledger.ndjson"), `${JSON.stringify({ step: "serve.handoff_done" })}\n`);
    assert.equal(seams.serveHandoffInProgress!(), false);

    seams.replaceServe!();
    assert.deepEqual(calls.at(-1), ["env", `RMD_STATE_DIR=${root}`, ...serveReplaceAdmissionEnv(loadHostMemoryBudgetPolicy()), "bash", join(root, "deploy", "serve-container.sh"), "--replace"]);
    assert.deepEqual(seams.servePolicyDrift!(), [], "the replaced container is on the policy");

    // The failure record round-trips through state/, and clears.
    assert.equal(seams.servePolicyLastFailedAtMs!(), undefined);
    seams.recordServePolicyFailure!("pull refused", NOW);
    assert.equal(seams.servePolicyLastFailedAtMs!(), NOW);
    seams.clearServePolicyFailure!();
    assert.equal(existsSync(join(root, "state", SERVE_POLICY_FAILED_FILE)), false);
    seams.clearServePolicyFailure!();

    // The escalation goes to the checkout's own repo through the issue gateway.
    seams.escalate!({ class: "BLOCKED", taskId: "SERVE-POLICY", summary: "serve policy", detail: "d", options: [{ label: "a", detail: "b" }], recommendation: "a", headDedup: "independent" });
    assert.equal(created.length, 1);
    assert.match(readFileSync(join(root, "state", "ledger.ndjson"), "utf8"), /escalation\.issue_opened/);

    running = "false false";
    assert.equal(seams.serveHealthy!(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator ruling 2026-10-19: serve's 5 GiB reservation and 1 GiB of swap read as drift, so the tick replaces it", () => {
  const { root, env } = fixture();
  // serve as it ran before the ruling: the 2026-10-02 limits, a 5 GiB memory.low and 1 GiB of swap.
  const live = { Memory: 7680 * MIB, MemorySwap: 8704 * MIB, CpuShares: 4096, MemoryReservation: 5120 * MIB };
  const exec = (cmd: string, args: string[]): string =>
    cmd === "bash" ? execFileSync(cmd, args, { encoding: "utf8", env }) : JSON.stringify(live);
  try {
    const drift = realServePolicyDeps({ installPath: root, stateRoot: root }, exec).servePolicyDrift!();
    assert.deepEqual(drift, [
      { field: "MemorySwap", expected: 9728 * MIB, actual: 8704 * MIB },
      { field: "MemoryReservation", expected: 0, actual: 5120 * MIB },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shipped serve drift reader honors learned memory high in its actual state root", () => {
  const { root, env } = fixture();
  const stateRoot = join(root, "runtime");
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  writeFileSync(join(root, ".remudero", "daemon-instances.yaml"),
    `instances:\n  core:\n    repo: remudero\n    primary: true\n    container_name: remudero-daemon\n    state_dir: ${stateRoot}\n`);
  const meminfo = join(root, "meminfo");
  writeFileSync(meminfo, "MemTotal: 16777216 kB\n");
  const learned = join(stateRoot, "state", `memory-high-tuned-${SERVE_POLICY_CONTAINER}.json`);
  let annotation = 6656;
  let memory = ON_POLICY.Memory;
  const policyCalls: string[][] = [];
  const exec = (cmd: string, args: string[]): string => {
    if (cmd === "bash") {
      policyCalls.push(args);
      return execFileSync(cmd, args, { encoding: "utf8", env: { ...env, RMD_MEMINFO_PATH: meminfo } });
    }
    assert.equal(cmd, "docker");
    assert.deepEqual(args, ["inspect", SERVE_POLICY_CONTAINER, "--format", "{{json .HostConfig}}"]);
    return JSON.stringify({ ...ON_POLICY, Memory: memory,
      Annotations: { [MEMORY_HIGH_ANNOTATION]: `uint64 ${annotation * MIB}` } });
  };
  try {
    const seams = realServePolicyDeps({ installPath: root, stateRoot }, exec);
    // No learned owner: the unchanged policy remains authoritative.
    assert.deepEqual(seams.servePolicyDrift!(), [{ field: "MemoryHigh", expected: 5632 * MIB, actual: 6656 * MIB }]);
    writeFileSync(learned, `{"container":"${SERVE_POLICY_CONTAINER}","high_mib":6400,"policy_mib":5632}\n`);
    // The install's state folder is not the live state root. Reading this one would be wrong.
    writeFileSync(join(root, "state", `memory-high-tuned-${SERVE_POLICY_CONTAINER}.json`),
      `{"container":"${SERVE_POLICY_CONTAINER}","high_mib":7168,"policy_mib":5632}\n`);
    for (annotation of [5632, 6144, 6400, 6656]) {
      assert.deepEqual(seams.servePolicyDrift!(), [], `learned owner permits startup annotation ${annotation} MiB`);
    }
    assert.ok(policyCalls.every(args => args.at(-1) === stateRoot), "every real policy read receives the live state root");
    annotation = 5376;
    assert.deepEqual(seams.servePolicyDrift!(), [{ field: "MemoryHigh", expected: 6400 * MIB, actual: 5376 * MIB }],
      "learning never excuses an annotation below the unchanged policy floor");
    annotation = 6656;
    memory -= MIB;
    assert.deepEqual(seams.servePolicyDrift!(), [{ field: "Memory", expected: ON_POLICY.Memory, actual: memory }],
      "learning never excuses hard-limit drift");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shipped serve wiring stays dark off the primary instance and reads faults as unknown", () => {
  const site = fixture(false);
  const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-policy-bare-`));
  try {
    assert.deepEqual(realServePolicyDeps({ installPath: site.root, stateRoot: site.root }), {});
    assert.deepEqual(realServePolicyDeps({ installPath: bare, stateRoot: bare }), {}, "no registry, no primary");

    const { root } = fixture();
    try {
      const broken = (): string => {
        throw new Error("Error: No such object: remudero-serve");
      };
      const seams = realServePolicyDeps({ installPath: root, stateRoot: root }, broken);
      assert.equal(seams.serveHealthy!(), undefined);
      assert.equal(seams.servePolicyDrift!(), undefined);
      writeFileSync(join(root, "state", SERVE_POLICY_FAILED_FILE), "not json");
      assert.equal(seams.servePolicyLastFailedAtMs!(), undefined);
      writeFileSync(join(root, "state", SERVE_POLICY_FAILED_FILE), JSON.stringify({ at: "never" }));
      assert.equal(seams.servePolicyLastFailedAtMs!(), undefined);
      // No origin to name: the escalation is skipped, never thrown.
      seams.escalate!({ class: "BLOCKED", taskId: "SERVE-POLICY", summary: "s", detail: "d", options: [{ label: "a", detail: "b" }], recommendation: "a" });
      const notGithub = realServePolicyDeps({ installPath: root, stateRoot: root }, () => "/srv/mirror.git\n");
      notGithub.escalate!({ class: "BLOCKED", taskId: "SERVE-POLICY", summary: "s", detail: "d", options: [{ label: "a", detail: "b" }], recommendation: "a" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    rmSync(site.root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

// ── W1-T8311: the replace re-checks fresh host pressure before it can stop the console ───────────

/** A contained install: the REAL launcher (deploy/ linked in), a fake docker that only records, fake /proc files. */
function launcherFixture(): { root: string; log: string; proc: string; env: NodeJS.ProcessEnv; exec: (cmd: string, args: string[]) => string } {
  const { root } = fixture();
  rmSync(join(root, "deploy"), { recursive: true, force: true });
  symlinkSync(join(REPO_ROOT, "deploy"), join(root, "deploy"));
  for (const dir of ["bin", "proc", "code", "gens"]) mkdirSync(join(root, dir), { recursive: true });
  const log = join(root, "docker.log");
  writeFileSync(log, "");
  writeFileSync(join(root, "bin", "docker"), [
    "#!/usr/bin/env bash",
    'echo "docker $*" >> "${FAKE_DOCKER_LOG}"',
    'case "$1" in',
    '  inspect) case "$*" in *Running*) echo true ;; *Networks*) echo yes ;; esac; exit 0 ;;',
    '  stats) echo "5632MiB / 7.5GiB"; exit 0 ;;',
    '  logs) echo "listening on http://0.0.0.0:4317"; exit 0 ;;',
    '  network) echo "cloudflared remudero-serve"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(join(root, "bin", "docker"), 0o755);
  // A runner with the Azure CLI installed must never reach a real registry login from this fixture.
  writeFileSync(join(root, "bin", "az"), "#!/usr/bin/env bash\necho \"az $*\" >> \"${FAKE_DOCKER_LOG}\"\nexit 0\n");
  chmodSync(join(root, "bin", "az"), 0o755);
  const proc = join(root, "proc");
  writeFileSync(join(proc, "meminfo"), "MemTotal: 16000000 kB\nMemAvailable: 12000000 kB\n");
  writeFileSync(join(proc, "vmstat"), "pswpin 100\n");
  writeFileSync(join(proc, "psi"), "some avg10=0.50 avg60=0.10 avg300=0.00 total=1\nfull avg10=0.10 avg60=0.00 avg300=0.00 total=1\n");
  const env: NodeJS.ProcessEnv = {
    PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: root, GH_TOKEN: "fixture-token", FAKE_DOCKER_LOG: log,
    RMD_SERVE_REPO_DIR: join(root, "code"), RMD_SERVE_GENS_DIR: join(root, "gens"), RMD_SERVE_DOCKERENV_PATH: join(root, "no-dockerenv"),
    RMD_INSTANCE_REGISTRY: join(root, "no-registry"), RMD_MEMINFO_PATH: join(root, "no-meminfo"), RMD_SERVE_BANNER_WAIT_S: "1",
    RMD_SERVE_ADMIT_MEMINFO_PATH: join(proc, "meminfo"), RMD_SERVE_ADMIT_VMSTAT_PATH: join(proc, "vmstat"),
    RMD_SERVE_ADMIT_PSI_PATH: join(proc, "psi"), RMD_SERVE_ADMIT_SAMPLE_S: "0.05",
  };
  // The shipped process seam, with only its environment contained.
  const exec = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: "utf8", env, stdio: "pipe" });
  return { root, log, proc, env, exec };
}

const DESTRUCTIVE = /^docker (stop|rm|run|pull|network connect)\b/m;

test("serve convergence cannot stop the console before pressure admission", () => {
  // Injected ports: a held launcher is a HOLD, never a failure, a back-off or an escalation.
  const held = harness({ replaceServe: () => ({ held: "psi", detail: "memory PSI full avg10 2.53 (max 2)" }) });
  const out = runServePolicyCycle(held.deps, TICK);
  assert.equal(out.replaced, false);
  assert.match(out.reason, /fresh host pressure refused it \(psi: memory PSI full avg10 2\.53/);
  assert.deepEqual(held.rows.map((r) => r.step), ["deploy.serve_policy_replace", "deploy.serve_policy_held"]);
  assert.equal(held.rows[1]!.data?.hold, "psi");
  assert.deepEqual(held.rows[1]!.data?.drift, DRIFT);
  assert.deepEqual([held.failures, held.escalations, held.cleared], [[], [], 0], "nothing was replaced, so nothing failed");

  // The shipped wiring hands the launcher the budget's own thresholds and reads its held exit.
  const budget = loadHostMemoryBudgetPolicy(join(REPO_ROOT, "plan", "policy.yaml"));
  assert.deepEqual(serveReplaceAdmissionEnv(budget), [
    "RMD_SERVE_REPLACE_ADMISSION=required", `RMD_SERVE_ADMIT_HOST_RESERVE_MIB=${budget.hostReserveMib}`,
    `RMD_SERVE_ADMIT_SWAPIN_MAX=${budget.swapInPagesPerSecMax}`, `RMD_SERVE_ADMIT_PSI_SOME_AVG10_MAX=${budget.psiSomeAvg10Max}`,
    `RMD_SERVE_ADMIT_PSI_FULL_AVG10_MAX=${budget.psiFullAvg10Max}`, `RMD_SERVE_ADMIT_CANDIDATE_MIB=${budget.serveColdStartReserveMib}`,
  ]);
  const { root: wired } = fixture();
  try {
    const launched: string[][] = [];
    const refuse = (status: number) => (cmd: string, args: string[]): string => {
      launched.push([cmd, ...args]);
      throw Object.assign(new Error("Command failed"), { status, stderr: "serve-container: HELD (host_headroom) — MemAvailable 3954 MiB < need 4096 MiB (before docker stop). remudero-serve was left untouched.\n" });
    };
    const heldSeam = realServePolicyDeps({ installPath: wired, stateRoot: wired }, refuse(SERVE_REPLACE_HELD_EXIT), undefined, () => budget).replaceServe!;
    const heldResult = heldSeam();
    assert.equal(heldResult && heldResult.held, "host_headroom");
    assert.match(heldResult ? heldResult.detail : "", /3954 MiB/);
    assert.deepEqual(launched[0]!.slice(0, 2 + 6), ["env", `RMD_STATE_DIR=${wired}`, ...serveReplaceAdmissionEnv(budget)]);
    const failedSeam = realServePolicyDeps({ installPath: wired, stateRoot: wired }, refuse(1), undefined, () => budget).replaceServe!;
    assert.throws(failedSeam, /Command failed/, "any other exit is still a failure");
    const before = launched.length;
    const noPolicy = realServePolicyDeps({ installPath: wired, stateRoot: wired }, refuse(0), undefined, () => { throw new Error("policy.yaml: ENOENT"); }).replaceServe!;
    const noPolicyResult = noPolicy();
    assert.equal(noPolicyResult && noPolicyResult.held, "policy_unread");
    assert.equal(launched.length, before, "no admission thresholds, no launch at all");
  } finally {
    rmSync(wired, { recursive: true, force: true });
  }

  // The REAL launcher through the shipped seam: pressure holds before any destructive docker call.
  const f = launcherFixture();
  try {
    const cycle = (): { out: ReturnType<typeof runServePolicyCycle>; h: Harness } => {
      const seams = realServePolicyDeps({ installPath: f.root, stateRoot: f.root }, f.exec, undefined, () => budget);
      const h = harness({ replaceServe: seams.replaceServe });
      return { out: runServePolicyCycle(h.deps, TICK), h };
    };
    // Under the updated 2 GiB reserve + 6 GiB cold start - 5.5 GiB freed = 2.5 GiB need.
    writeFileSync(join(f.proc, "meminfo"), "MemAvailable: 2400000 kB\n");
    const tight = cycle();
    assert.equal(tight.out.replaced, false);
    assert.equal(tight.h.rows.at(-1)!.data?.hold, "host_headroom", tight.out.reason);
    assert.doesNotMatch(readFileSync(f.log, "utf8"), DESTRUCTIVE, "the old container, image and route were never touched");
    assert.equal(tight.h.failures.length, 0);

    writeFileSync(join(f.proc, "meminfo"), "MemAvailable: 12000000 kB\n");
    writeFileSync(join(f.proc, "psi"), "some avg10=3.00 avg60=0.10 avg300=0.00 total=1\nfull avg10=2.53 avg60=0.00 avg300=0.00 total=1\n");
    assert.equal(cycle().h.rows.at(-1)!.data?.hold, "psi");
    rmSync(join(f.proc, "psi"));
    assert.equal(cycle().h.rows.at(-1)!.data?.hold, "pressure_unread", "an unreadable PSI is a hold, never zero pressure");
    assert.doesNotMatch(readFileSync(f.log, "utf8"), DESTRUCTIVE);

    // Positive control: admitted, the same launcher stops, removes and recreates in that order.
    writeFileSync(join(f.proc, "psi"), "some avg10=0.50 avg60=0.10 avg300=0.00 total=1\nfull avg10=0.10 avg60=0.00 avg300=0.00 total=1\n");
    writeFileSync(f.log, "");
    const admitted = cycle();
    assert.equal(admitted.out.replaced, true, admitted.out.reason);
    const calls = readFileSync(f.log, "utf8").split("\n").map((l) => /^docker (stats|stop|rm|run)\b/.exec(l)?.[1]).filter(Boolean);
    assert.deepEqual(calls, ["stats", "stats", "stop", "rm", "run"], "a fresh admission (twice) precedes the stop");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
