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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { IMAGE_RECYCLE_FAILURE_BACKOFF_MS, type DeployDeps, type ResourcePolicyDrift } from "../src/lib/deployer.js";
import type { Escalation, IssueGateway } from "../src/lib/escalate.js";
import {
  SERVE_POLICY_CONTAINER,
  SERVE_POLICY_FAILED_FILE,
  realServePolicyDeps,
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
const ON_POLICY = { Memory: 7680 * MIB, MemorySwap: 8704 * MIB, CpuShares: 4096, MemoryReservation: 5120 * MIB };
const DRIFT: ResourcePolicyDrift[] = [
  { field: "Memory", expected: 7680 * MIB, actual: 5120 * MIB },
  { field: "MemorySwap", expected: 8704 * MIB, actual: 6144 * MIB },
  { field: "MemoryReservation", expected: 5120 * MIB, actual: 3072 * MIB },
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
  assert.match(out.reason, new RegExp(`MemoryReservation expected=${5120 * MIB} actual=${3072 * MIB}`));
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
  assert.equal(serveHandoffOpen([row("serve.handoff_requested"), row("serve.handoff_deferred")].join("\n")), true);
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
  return { root, env: { PATH: process.env.PATH } };
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
    assert.deepEqual(calls.at(-1), ["env", `RMD_STATE_DIR=${root}`, "bash", join(root, "deploy", "serve-container.sh"), "--replace"]);
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
