/**
 * W1-T5346: containment and isolation are proven ONCE PER BOOT and again whenever an input the
 * probes read changes (operator ruling 2026-10-02, MASTER-PLAN §12 rule 11) — not on every run.
 *
 * Driven through the REAL `runTask()` with an injected probe-verdict cache, the two injected probe
 * executors counting their spawns, and a scripted claim reserver whose `attempt` answers
 * `unreachable`, so every run that clears the preflight ends at its dispatch claim
 * (`blocked_git_fetch`) without a worktree, a clone or a worker. A count of `attempt` calls is
 * therefore "how many runs proceeded to their claim".
 *
 * New symbols are read through a NAMESPACE import so this file still loads on a base that lacks
 * them — every test then fails on the missing symbol rather than the file failing to import.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as runTaskModule from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { DispatchClaimReserver } from "../src/lib/dispatch-claim.js";
import type { GitHub } from "../src/lib/status.js";
import type { spawnWorker } from "../src/lib/worker.js";
import type { ProbeExecResult as ContainmentProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- read through the namespace; see header.
const mod = runTaskModule as any;

const TASK_ID = "TST-PROBE-ONCE";
const PLAN = [
  `- id: ${TASK_ID}`,
  "  title: probe-once-per-boot wiring probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** Probe executors that count their spawns; `fail` flips the containment one to a dropped sandbox. */
function countingProbes() {
  const counts = { containment: 0, isolation: 0 };
  let fail = false;
  return {
    counts,
    setFailing: (f: boolean) => {
      fail = f;
    },
    containmentExec: (token: string): Promise<ContainmentProbeExecResult> => {
      counts.containment += 1;
      return Promise.resolve(
        fail
          ? { transcript: `touch ../${token}.txt`, outsideWriteCreated: true, insideWriteCreated: true, costUsd: 0 }
          : { transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 },
      );
    },
    isolationExec: (): Promise<IsolationProbeExecResult> => {
      counts.isolation += 1;
      return Promise.resolve({
        transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
        aliasCount: 0,
        functionCount: 0,
        functionNames: "-",
        costUsd: 0,
      });
    },
  };
}

/** Every run that clears the preflight reaches the claim and is refused there, before any spend. */
function unreachableReserver(): DispatchClaimReserver & { attempts: number } {
  const r = {
    attempts: 0,
    mintAnchor: () => "scripted-anchor",
    attempt: () => {
      r.attempts += 1;
      return "unreachable" as const;
    },
    holder: () => undefined,
    drop: () => true,
  };
  return r;
}

const NEVER_SPAWN = (async () => {
  throw new Error("no worker may spawn — every run here ends at the preflight or the claim");
}) as typeof spawnWorker;

interface Fixture {
  root: string;
  imageShaPath: string;
  run: (over?: Record<string, unknown>) => Promise<{ verdict: string; runId: string }>;
  ledger: () => Array<Record<string, unknown>>;
}

function fixture(cache: unknown, probes: ReturnType<typeof countingProbes>, reserver: ReturnType<typeof unreachableReserver>): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}probe-once-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, PLAN);
  mkdirSync(join(root, "repos", "remudero"), { recursive: true });
  const imageShaPath = join(root, "rmd-build-sha");
  writeFileSync(imageShaPath, "image-a\n");
  const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
  return {
    root,
    imageShaPath,
    run: async (over = {}) =>
      (await runTaskModule.runTask(TASK_ID, {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn: NEVER_SPAWN,
        containmentExec: probes.containmentExec,
        isolationExec: probes.isolationExec,
        claimReserver: reserver,
        probeVerdictCache: cache,
        probeKeySources: { imageBuildShaPath: imageShaPath, harnessRevision: "harness-a" },
        ...over,
      } as Parameters<typeof runTaskModule.runTask>[1])) as { verdict: string; runId: string },
    ledger: () =>
      readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

test("a second run in the same process with an unchanged probe key reuses the passing verdict without spawning a probe", async () => {
  const probes = countingProbes();
  const reserver = unreachableReserver();
  const f = fixture(mod.createProbeVerdictCache(), probes, reserver);
  try {
    const first = await f.run();
    const second = await f.run();
    assert.equal(first.verdict, "blocked_git_fetch", "the first run probes, passes and reaches its claim");
    assert.equal(second.verdict, "blocked_git_fetch", "the second run reaches its claim too");
    assert.equal(reserver.attempts, 2, "both runs proceeded to their claim");
    assert.deepEqual(probes.counts, { containment: 1, isolation: 1 }, "the second run spawned neither probe");

    const ledger = f.ledger();
    const reused = ledger.filter((l) => l.cached === true);
    const containmentReuse = reused.find((l) => l.step === "containment.probe");
    const isolationReuse = reused.find((l) => l.step === "isolation.probe");
    assert.ok(containmentReuse, "the reuse is ledgered on the containment.probe step");
    assert.ok(isolationReuse, "the reuse is ledgered on the isolation.probe step");
    assert.equal(containmentReuse.contained, true);
    assert.equal(isolationReuse.isolated, true);
    assert.equal(containmentReuse.proved_by_run, first.runId, "an audit can see WHICH probe this run relied on");
    assert.equal(typeof containmentReuse.probe_key, "string");
    assert.equal(typeof containmentReuse.age_ms, "number");
    assert.equal(containmentReuse.cost_usd, 0);
    const recorded = ledger.find((l) => l.step === "probe_cache.recorded");
    assert.equal(recorded?.probe_key, containmentReuse.probe_key, "the reused key is the key the first run proved");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a changed image sha or harness revision re-probes before the run's claim", async () => {
  const probes = countingProbes();
  const reserver = unreachableReserver();
  const f = fixture(mod.createProbeVerdictCache(), probes, reserver);
  try {
    await f.run();
    writeFileSync(f.imageShaPath, "image-b\n");
    await f.run();
    assert.deepEqual(probes.counts, { containment: 2, isolation: 2 }, "a new image is a new boundary");
    await f.run({ probeKeySources: { imageBuildShaPath: f.imageShaPath, harnessRevision: "harness-b" } });
    assert.deepEqual(probes.counts, { containment: 3, isolation: 3 }, "a new harness revision is a new boundary");
    await f.run({ probeKeySources: { imageBuildShaPath: f.imageShaPath, harnessRevision: "harness-b" } });
    assert.deepEqual(probes.counts, { containment: 3, isolation: 3 }, "and is itself reused once proven");
    assert.equal(reserver.attempts, 4);
    const misses = f.ledger().filter((l) => l.step === "probe_cache.miss").map((l) => l.reason);
    assert.deepEqual(misses, ["no-entry", "no-entry", "no-entry"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the probe key moves with every input the probes read, worker policy included", () => {
  const base = {
    imageBuildSha: "image-a",
    harnessRevision: "harness-a",
    workerSettings: "settings-a",
    hooks: "deny-floor.sh:aaa",
    cliVersion: "2.1.220",
    provider: "claude",
    claudeBin: "/usr/bin/claude",
    root: "/srv/root",
  };
  const key = mod.probeVerdictKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(mod.probeVerdictKey({ ...base }), key, "the key is deterministic");
  for (const field of Object.keys(base)) {
    assert.notEqual(mod.probeVerdictKey({ ...base, [field]: "changed" }), key, `${field} must move the key`);
  }
  assert.throws(() => mod.probeVerdictKey({ ...base, provider: undefined }), /provider/, "a missing input is never silently keyed");
});

test("the worker policy is read by content, with the run's own id normalised out, and every hook file is digested", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}probe-key-inputs-`));
  try {
    const hooksDir = join(dir, "hooks");
    mkdirSync(hooksDir);
    writeFileSync(join(hooksDir, "deny-floor.sh"), "deny v1\n");
    const settingsA = join(dir, "worker-settings-run-1.json");
    const settingsB = join(dir, "worker-settings-run-2.json");
    writeFileSync(settingsA, '{"tmp":"run-1","sandbox":{"enabled":true}}');
    writeFileSync(settingsB, '{"tmp":"run-2","sandbox":{"enabled":true}}');
    const src = (settingsFile: string, runId: string) => ({
      settingsFile,
      runId,
      hooksDir,
      imageBuildShaPath: join(dir, "absent-sha"),
      harnessRevision: "harness-a",
      cliVersion: undefined,
      provider: "claude",
      claudeBin: "/bin/true",
      root: dir,
    });
    const a = mod.readProbeKeyInputs(src(settingsA, "run-1"));
    const b = mod.readProbeKeyInputs(src(settingsB, "run-2"));
    assert.equal(a.imageBuildSha, "absent", "off-container the image sha is absent, not an error");
    assert.equal(a.cliVersion, "unobserved");
    assert.equal(mod.probeVerdictKey(a), mod.probeVerdictKey(b), "a per-run path is not a policy change");

    writeFileSync(settingsB, '{"tmp":"run-2","sandbox":{"enabled":false}}');
    assert.notEqual(mod.probeVerdictKey(mod.readProbeKeyInputs(src(settingsB, "run-2"))), mod.probeVerdictKey(a), "a sandbox change re-probes");

    writeFileSync(join(hooksDir, "deny-floor.sh"), "deny v2\n");
    assert.notEqual(mod.probeVerdictKey(mod.readProbeKeyInputs(src(settingsA, "run-1"))), mod.probeVerdictKey(a), "a hook change re-probes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing probe is never cached and holds every later run until a probe passes", async () => {
  const probes = countingProbes();
  const reserver = unreachableReserver();
  const f = fixture(mod.createProbeVerdictCache(), probes, reserver);
  try {
    // 1. image-a passes and is cached.
    assert.equal((await f.run()).verdict, "blocked_git_fetch");
    // 2. a new image fails containment — refused, and the process is now held.
    probes.setFailing(true);
    writeFileSync(f.imageShaPath, "image-b\n");
    assert.equal((await f.run()).verdict, "blocked_containment");
    assert.equal(reserver.attempts, 1, "the failing run never reached its claim");
    // 3. back on image-a, whose pass WAS cached: the hold forbids reusing it, so it re-probes and refuses.
    writeFileSync(f.imageShaPath, "image-a\n");
    assert.equal((await f.run()).verdict, "blocked_containment", "a held process re-probes and refuses");
    assert.equal(probes.counts.containment, 3, "the third run probed rather than reusing the earlier pass");
    assert.equal(reserver.attempts, 1, "no held run proceeded to its claim");
    // 4. a probe passes: the hold lifts and this run proceeds.
    probes.setFailing(false);
    assert.equal((await f.run()).verdict, "blocked_git_fetch");
    assert.equal(probes.counts.containment, 4);
    // 5. and only now is the pass reused.
    assert.equal((await f.run()).verdict, "blocked_git_fetch");
    assert.equal(probes.counts.containment, 4, "the fresh pass is reused");
    assert.equal(reserver.attempts, 3);
    const held = f.ledger().filter((l) => l.step === "probe_cache.miss" && String(l.reason).startsWith("held:"));
    assert.equal(held.length, 2, "both held runs say why they could not reuse a proof");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a pass recorded by a run that probed across a failure does not lift the hold", () => {
  const cache = mod.createProbeVerdictCache();
  const proof = { runId: "r1", provedAtMs: 1, provedAt: "1970-01-01T00:00:00.001Z", containmentReason: "c", isolationReason: "i" };
  const ticket = cache.open();
  cache.hold("containment: dropped sandbox");
  assert.equal(cache.recordPass("k", proof, ticket), false, "a failure landed while this run probed");
  assert.equal(cache.lookup("k"), undefined);
  assert.match(cache.heldReason, /dropped sandbox/);
  assert.equal(cache.recordPass("k", proof, cache.open()), true, "a pass begun after the failure lifts the hold");
  assert.equal(cache.heldReason, undefined);
  assert.deepEqual(cache.lookup("k"), proof);
});

test("an injected probe executor without an injected cache, or an unreadable key input, probes every run", async () => {
  const probes = countingProbes();
  const reserver = unreachableReserver();
  const f = fixture(undefined, probes, reserver);
  try {
    await f.run();
    await f.run();
    assert.deepEqual(probes.counts, { containment: 2, isolation: 2 }, "a test executor is never cached process-wide");

    const cache = mod.createProbeVerdictCache();
    // A directory where the image sha file should be: the key cannot be read, so nothing is reused.
    const unreadable = { imageBuildShaPath: f.root, harnessRevision: "harness-a" };
    await f.run({ probeVerdictCache: cache, probeKeySources: unreadable });
    await f.run({ probeVerdictCache: cache, probeKeySources: unreadable });
    assert.deepEqual(probes.counts, { containment: 4, isolation: 4 }, "an unkeyed run always probes");
    const unkeyed = f.ledger().filter((l) => l.step === "probe_cache.miss" && String(l.reason).startsWith("unkeyed:"));
    assert.equal(unkeyed.length, 2);
    assert.equal(f.ledger().some((l) => l.step === "probe_cache.recorded" && l.probe_key === null), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
