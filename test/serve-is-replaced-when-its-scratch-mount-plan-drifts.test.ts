/**
 * W1-T6125 — SERVE NEVER TOOK A NEW SCRATCH BIND.
 *
 * W1-T6110 (#9770) recycles a daemon whose binds differ from deploy/scratch-mounts.sh `scratch_plan`,
 * but remudero-serve converges only through serve-policy-convergence.ts, whose drift was the resource
 * policy alone, so serve took #9761's test-slot bind only at its next unrelated replace. These drive
 * the serve pass with injected seams, and its SHIPPED wiring with the plan run through real bash over
 * the real scratch-mounts.sh; only `docker` and the launcher are fixtures. No real container is touched.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DeployDeps, MountPlanDrift, ResourcePolicyDrift } from "../src/lib/deployer.js";
import type { Escalation } from "../src/lib/escalate.js";
import { SERVE_POLICY_CONTAINER, realServePolicyDeps, runServePolicyCycle } from "../src/lib/serve-policy-convergence.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const TICK = { imageDriftOnly: true };
const SLOT = "/home/node/rmd-scratch/test-slots";

const SLOT_DRIFT: MountPlanDrift[] = [
  { target: SLOT, expected: "/mnt/scratch/rmd/test-slots", actual: undefined },
  { target: "env RMD_TEST_SLOT_DIR", expected: SLOT, actual: undefined },
];

type ServeTick = DeployDeps & { serveMountPlanDrift?: () => MountPlanDrift[] | undefined; escalate?: (e: Escalation) => void };

interface Harness {
  deps: ServeTick;
  rows: { step: string; data?: Record<string, unknown> }[];
  replaces: number;
  escalations: Escalation[];
  failures: string[];
}

/** A tick whose seams all read "go": limits on policy, and the mount reader returns `mounts` in turn. */
function harness(over: Partial<ServeTick> = {}, mounts: (MountPlanDrift[] | undefined)[] = [SLOT_DRIFT, []], limits: ResourcePolicyDrift[] | undefined = []): Harness {
  const h: Harness = { deps: undefined as unknown as ServeTick, rows: [], replaces: 0, escalations: [], failures: [] };
  let read = 0;
  h.deps = {
    log: (step: string, data?: Record<string, unknown>) => h.rows.push({ step, data }),
    now: () => NOW,
    stopPresent: () => false,
    pausePresent: () => false,
    serveHandoffInProgress: () => false,
    serveHealthy: () => true,
    servePolicyLastFailedAtMs: () => undefined,
    servePolicyDrift: () => limits,
    serveMountPlanDrift: () => mounts[Math.min(read++, mounts.length - 1)],
    replaceServe: () => {
      h.replaces++;
    },
    recordServePolicyFailure: (message: string) => h.failures.push(message),
    clearServePolicyFailure: () => {},
    escalate: (e: Escalation) => h.escalations.push(e),
    ...over,
  } as unknown as ServeTick;
  return h;
}

test("serve with a missing scratch bind is replaced once, naming each drifted bind", () => {
  const h = harness();
  const out = runServePolicyCycle(h.deps, TICK);
  assert.equal(out.replaced, true, out.reason);
  assert.equal(h.replaces, 1);
  assert.match(out.reason, /mount plan drift/);
  assert.match(out.reason, new RegExp(`${SLOT} expected=/mnt/scratch/rmd/test-slots actual=absent`));
  assert.match(out.reason, /env RMD_TEST_SLOT_DIR expected=/);
  assert.deepEqual(h.rows.map((r) => r.step), ["deploy.serve_policy_replace", "deploy.serve_policy_replaced"]);
  assert.deepEqual(h.rows[0]!.data?.mountDrift, SLOT_DRIFT);
  assert.deepEqual(out.mountDrift, SLOT_DRIFT);
  assert.equal(h.escalations.length + h.failures.length, 0);

  // Limits unreadable is UNKNOWN for that reading only: the bind drift still replaces, and the
  // post-replace check does not fault the replace for a reading that was never known.
  const limitsUnknown = harness({}, [SLOT_DRIFT, []], undefined);
  assert.equal(runServePolicyCycle(limitsUnknown.deps, TICK).replaced, true);
});

test("serve whose binds match its plan, or whose plan is UNKNOWN, is never replaced", () => {
  for (const mounts of [[], undefined]) {
    for (const limits of [[], undefined]) {
      const h = harness({}, [mounts], limits);
      const out = runServePolicyCycle(h.deps, TICK);
      const label = `mounts=${JSON.stringify(mounts)} limits=${JSON.stringify(limits)}`;
      assert.equal(out.replaced, false, label);
      assert.equal(h.replaces, 0, label);
      assert.equal(h.rows.length, 0, `no known drift is not news (${label})`);
    }
  }
  const noReader = harness({ serveMountPlanDrift: undefined });
  assert.equal(runServePolicyCycle(noReader.deps, TICK).replaced, false, "an unwired mount reader is UNKNOWN");
});

test("a mount-drift replace is held by STOP, PAUSE, the back-off, a handoff and an unhealthy serve", () => {
  const cases: [string, Partial<ServeTick>, RegExp][] = [
    ["STOP", { stopPresent: () => true }, /STOP is set or unknown/],
    ["PAUSE", { pausePresent: () => undefined }, /PAUSE is set or unknown/],
    ["recent failure", { servePolicyLastFailedAtMs: () => NOW - 60_000 }, /backing off/],
    ["handoff", { serveHandoffInProgress: () => true }, /handoff is in progress/],
    ["handoff unknown", { serveHandoffInProgress: () => undefined }, /handoff is in progress or unreadable/],
    ["unhealthy", { serveHealthy: () => false }, /serve is not healthy now/],
  ];
  for (const [name, over, why] of cases) {
    const h = harness(over);
    const out = runServePolicyCycle(h.deps, TICK);
    assert.equal(h.replaces, 0, name);
    assert.equal(out.replaced, false, name);
    assert.deepEqual(h.rows.map((r) => r.step), ["deploy.serve_policy_held"], name);
    assert.match(String(h.rows[0]!.data?.reason), why, name);
    assert.match(String(h.rows[0]!.data?.reason), new RegExp(`${SLOT} expected=`), name);
    assert.deepEqual(h.rows[0]!.data?.mountDrift, SLOT_DRIFT, name);
  }
});

test("a replace whose container still lacks the bind is a recorded failure with its back-off", () => {
  const still = harness({}, [SLOT_DRIFT, SLOT_DRIFT]);
  const out = runServePolicyCycle(still.deps, TICK);
  assert.equal(out.replaced, false);
  assert.match(out.reason, /binds still off the scratch mount plan/);
  assert.equal(still.failures.length, 1);
  assert.equal(still.rows.at(-1)!.step, "deploy.serve_policy_failed");
  assert.deepEqual(still.rows.at(-1)!.data?.mountDrift, SLOT_DRIFT);
  assert.equal(still.escalations.length, 1);
  assert.match(still.escalations[0]!.detail, new RegExp(`mount drift: ${SLOT} expected=`));

  const unreadable = harness({}, [SLOT_DRIFT, undefined]);
  assert.match(runServePolicyCycle(unreadable.deps, TICK).reason, /scratch mount plan after the replace \(unreadable\)/);
  assert.equal(unreadable.failures.length, 1);
});

/** A throwaway primary install holding the REAL scratch-mounts.sh, a scratch root the mounts table
 *  declares mounted, and the switch on. No resource-policy.sh: that reading is UNKNOWN throughout. */
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-mounts-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "rmd-state2");
  const install = join(state, "daemon-install");
  const scratch = join(root, "mnt", "scratch");
  mkdirSync(join(install, "deploy"), { recursive: true });
  mkdirSync(join(install, ".remudero"), { recursive: true });
  mkdirSync(join(state, "state"), { recursive: true });
  mkdirSync(scratch, { recursive: true });
  copyFileSync(join(REPO_ROOT, "deploy", "scratch-mounts.sh"), join(install, "deploy", "scratch-mounts.sh"));
  writeFileSync(join(root, "mounts"), `/dev/nvme1n1 ${scratch} ext4 rw,noatime 0 0\n`);
  writeFileSync(
    join(install, ".remudero", "daemon-instances.yaml"),
    `instances:\n  core:\n    repo: remudero\n    primary: true\n    container_name: remudero-daemon\n    state_dir: ${state}\n`,
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_V8_COVERAGE: "",
    RMD_SCRATCH: "on",
    RMD_SCRATCH_ROOT: scratch,
    RMD_SCRATCH_MOUNTS_FILE: join(root, "mounts"),
  };
  const base = join(scratch, "rmd", "rmd-state2");
  const binds: [string, string][] = [
    [`${base}/worktrees`, "/home/node/Remudero/worktrees"],
    [`${base}/tmp`, "/home/node/Remudero/tmp"],
    [`${base}/remudero-coverage`, "/home/node/Remudero/.remudero-coverage"],
    [`${base}/repos-coverage`, "/home/node/Remudero/repos/.remudero-coverage"],
    [`${base}/read-model`, "/home/node/rmd-scratch/read-model"],
    [`${base}/worker-homes`, "/home/node/rmd-scratch/worker-homes"],
    [`${base}/containers/${SERVE_POLICY_CONTAINER}/tmp`, "/tmp"],
    [`${scratch}/rmd/test-slots`, SLOT],
  ];
  const inspect = (withSlot: boolean): string =>
    JSON.stringify({
      Mounts: [
        { Type: "bind", Source: state, Destination: "/home/node/Remudero", RW: true },
        ...binds.filter(([, d]) => withSlot || d !== SLOT).map(([Source, Destination]) => ({ Type: "bind", Source, Destination, RW: true })),
      ],
      Env: [
        "RMD_READ_MODEL_DB_DIR=/home/node/Remudero/state:/home/node/rmd-scratch/read-model",
        "RMD_WORKER_HOME_DIR=/home/node/Remudero:/home/node/rmd-scratch/worker-homes",
        ...(withSlot ? [`RMD_TEST_SLOT_DIR=${SLOT}`] : []),
      ],
    });
  return { root, state, install, scratch, env, inspect };
}

test("the shipped serve wiring reads remudero-serve's binds against the shared scratch plan and converges", (t) => {
  const f = fixture(t);
  let launched = false;
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]): string => {
    if (cmd === "bash") return execFileSync(cmd, args, { encoding: "utf8", env: f.env });
    calls.push([cmd, ...args]);
    if (cmd === "docker" && args.at(-1)!.includes(".Mounts")) return f.inspect(launched);
    if (cmd === "docker" && args.at(-1)!.includes(".State")) return "true false\n";
    if (cmd === "docker") throw new Error("Error: No such object"); // HostConfig: limits UNKNOWN
    if (cmd === "env") launched = true;
    return "";
  };
  const seams = realServePolicyDeps({ installPath: f.install, stateRoot: f.state }, exec);
  const before = seams.serveMountPlanDrift!();
  assert.deepEqual(before?.map((d) => [d.target, d.actual]), [[SLOT, undefined], ["env RMD_TEST_SLOT_DIR", undefined]]);
  assert.equal(before?.[0]?.expected, `${f.scratch}/rmd/test-slots`);
  assert.ok(calls.some((c) => c[0] === "docker" && c[2] === SERVE_POLICY_CONTAINER && c.at(-1)!.includes(".Mounts")), "inspects serve, not the daemon");

  writeFileSync(join(f.state, "state", "ledger.ndjson"), `${JSON.stringify({ step: "serve.handoff_done" })}\n`);
  const rows: string[] = [];
  const out = runServePolicyCycle(
    { log: (step: string) => rows.push(step), now: () => NOW, stopPresent: () => false, ...seams } as unknown as DeployDeps,
    TICK,
  );
  assert.equal(out.replaced, true, out.reason);
  assert.ok(calls.some((c) => c[0] === "env" && c.includes("--replace")), "replaced through serve-container.sh");
  assert.deepEqual(rows, ["deploy.serve_policy_replace", "deploy.serve_policy_replaced"]);
  assert.deepEqual(seams.serveMountPlanDrift!(), [], "the replaced container carries the bind");
});

test("the shipped serve mount reading is UNKNOWN with scratch off or an unreadable inspect", (t) => {
  const f = fixture(t);
  const off = (cmd: string, args: string[]): string =>
    cmd === "bash" ? execFileSync(cmd, args, { encoding: "utf8", env: { ...f.env, RMD_SCRATCH: "off" } }) : f.inspect(false);
  assert.equal(realServePolicyDeps({ installPath: f.install, stateRoot: f.state }, off).serveMountPlanDrift!(), undefined);
  const noInspect = (cmd: string, args: string[]): string => {
    if (cmd === "bash") return execFileSync(cmd, args, { encoding: "utf8", env: f.env });
    throw new Error("Error: No such object: remudero-serve");
  };
  assert.equal(realServePolicyDeps({ installPath: f.install, stateRoot: f.state }, noInspect).serveMountPlanDrift!(), undefined);
});
