/**
 * W1-T14591 — Serve's mount convergence mounts a newly registered instance: the watchdog's serve convergence
 * counts a registered, not retired instance that serve-container.sh would mount but the running serve does not,
 * after it has stayed unmounted for one full watchdog cycle, as drift, and replaces serve under its existing holds.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { daemonInstanceRegistryPath, type ResourcePolicyDrift } from "#src/lib/deployer.js";
import { loadHostMemoryBudgetPolicy } from "#src/lib/host-memory-shadow.js";
import { withInstanceRegistryRuntime } from "#src/lib/instance-registry-selection.js";
import { SERVE_MOUNT_ACTION } from "#src/lib/instances-view.js";
import {
  SERVE_IMAGE_REPLACE_SPACING_MS,
  SERVE_INSTANCE_MOUNT_SETTLE_MS,
  SERVE_POLICY_CONTAINER,
  SERVE_UNMOUNTED_INSTANCES_FILE,
  decideServePolicyConvergence,
  realServePolicyDeps,
  runServePolicyCycle,
  type ServePolicyInputs,
} from "#src/lib/serve-policy-convergence.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { legacyHostScript } from "#test/helpers/gh-shim.js";
import { repoRoot } from "#test/helpers/repo-root.js";

type CycleDeps = Parameters<typeof runServePolicyCycle>[0];
const NOW = Date.parse("2026-11-24T03:00:00.000Z");
const DRIFT: ResourcePolicyDrift[] = [{ field: "Memory", expected: 8, actual: 4 }];
const MOUNT_DRIFT = [{ target: "/tmp", expected: "/scratch/tmp", actual: undefined }];
const IMAGE = { expected: "a".repeat(40), actual: "b".repeat(40), basis: "serve-inputs" as const };
const BASE = "/home/node/rmd-instances";
const BUDGET = loadHostMemoryBudgetPolicy(join(repoRoot(), "plan", "policy.yaml"));

/** A cycle over plain seams; `overrides` shape one case, `reading` is the instance mount reading (absent: no seam). */
function cycle(overrides: Partial<CycleDeps>, reading: "absent" | string[] | undefined, after: string[] | "unreadable" = []) {
  const rows: { step: string; data: Record<string, unknown> }[] = [];
  const failures: string[] = [];
  const escalations: string[] = [];
  const readings: boolean[] = [];
  const deps = {
    log: (step: string, data: Record<string, unknown>) => void rows.push({ step, data }),
    now: () => NOW,
    stopPresent: () => false,
    pausePresent: () => false,
    serveHandoffInProgress: () => false,
    serveHealthy: () => true,
    servePolicyLastFailedAtMs: () => undefined,
    servePolicyDrift: () => [],
    serveMountPlanDrift: () => [],
    replaceServe: () => undefined,
    recordServePolicyFailure: (message: string) => void failures.push(message),
    clearServePolicyFailure: () => {},
    escalate: (e: { detail: string }) => void escalations.push(e.detail),
    ...overrides,
    ...(reading === "absent" ? {} : {
      serveUnmountedInstances: (_nowMs: number, raw?: boolean) => (readings.push(raw === true), raw !== true ? reading : after === "unreadable" ? undefined : after),
    }),
  } as unknown as CycleDeps;
  return { deps, rows, failures, escalations, readings };
}

function sequence<T>(...values: T[]): () => T {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

/** Each existing case, rebuilt fresh for every run (the seams count their reads). */
const CASES: Record<string, () => { overrides: Partial<CycleDeps>; opts?: { dryRun?: boolean } }> = {
  "no drift": () => ({ overrides: {} }),
  "resource drift": () => ({ overrides: { servePolicyDrift: sequence<typeof DRIFT>(DRIFT, []) } }),
  "scratch mount plan drift": () => ({ overrides: { serveMountPlanDrift: sequence<typeof MOUNT_DRIFT>(MOUNT_DRIFT, []) } }),
  "image drift with the restart spacing": () => ({ overrides: {
    serveImageInputs: () => ({ buildSha: IMAGE.actual, behind: 1 }), newestBakedSha: () => IMAGE.expected,
    imagePublished: () => true, serveLastRestartAtMs: () => NOW - 10 * 60_000,
  } as Partial<CycleDeps> }),
  "image drift without the restart spacing": () => {
    const behind = sequence(1, 0);
    return { overrides: {
      serveImageInputs: () => ({ buildSha: IMAGE.actual, behind: behind() }), newestBakedSha: () => IMAGE.expected,
      imagePublished: () => true, serveLastRestartAtMs: () => NOW - SERVE_IMAGE_REPLACE_SPACING_MS - 60_000,
    } as Partial<CycleDeps> };
  },
  STOP: () => ({ overrides: { servePolicyDrift: () => DRIFT, stopPresent: () => true } }),
  PAUSE: () => ({ overrides: { servePolicyDrift: () => DRIFT, pausePresent: () => true } }),
  "the failure back-off": () => ({ overrides: { servePolicyDrift: () => DRIFT, servePolicyLastFailedAtMs: () => NOW - 60_000 } }),
  "an open handoff": () => ({ overrides: { servePolicyDrift: () => DRIFT, serveHandoffInProgress: () => true } }),
  "an unhealthy serve": () => ({ overrides: { servePolicyDrift: () => DRIFT, serveHealthy: () => false } }),
  "a dry run": () => ({ overrides: { servePolicyDrift: () => DRIFT }, opts: { dryRun: true } }),
  "a held replace": () => ({ overrides: { servePolicyDrift: () => DRIFT, replaceServe: () => ({ held: "host_headroom", detail: "fixture pressure" }) } }),
};

test("W1-T14591 criterion 1: an empty or unknown instance mount reading decides, logs and ends as with no reading", () => {
  for (const [name, build] of Object.entries(CASES)) {
    const run = (reading: "absent" | string[] | undefined) => {
      const { overrides, opts } = build();
      const c = cycle(overrides, reading);
      const outcome = runServePolicyCycle(c.deps, { imageDriftOnly: true, ...opts });
      return { outcome, rows: c.rows, failures: c.failures, escalations: c.escalations, rawReads: c.readings.filter(Boolean).length };
    };
    const today = run("absent");
    assert.deepEqual(run([]), today, `${name}: an empty reading`);
    assert.deepEqual(run(undefined), today, `${name}: an unknown reading`);
    assert.equal(today.rows.some((r) => "unmountedInstances" in r.data || "action" in r.data), false, name);
  }
  const inputs: ServePolicyInputs = { drift: DRIFT, stopPresent: false, pausePresent: false, handoffInProgress: false, healthy: true,
    lastFailedAtMs: undefined, nowMs: NOW };
  for (const extra of [{}, { unmountedInstances: [] }, { unmountedInstances: undefined }]) {
    assert.deepEqual(decideServePolicyConvergence({ ...inputs, ...extra }), decideServePolicyConvergence(inputs));
    assert.deepEqual(decideServePolicyConvergence({ ...inputs, drift: [], ...extra }), decideServePolicyConvergence({ ...inputs, drift: [] }));
  }
});

/** A host with the shipped launchers, a fake docker on PATH that records each call, and a registry of `rows`. */
function launcherHost(t: { after: (fn: () => void) => void }, rows: string[], serveMounts: string[] = []) {
  const base = makeTempDir("w1t14591-launcher");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const core = join(base, "core-state"), bin = join(base, "bin"), calls = join(base, "calls");
  for (const dir of [join(core, "state"), bin, join(base, "code")]) mkdirSync(dir, { recursive: true });
  const mountsFile = join(base, "serve-mounts.json");
  const setServeMounts = (dests: string[]) =>
    writeFileSync(mountsFile, JSON.stringify([{ Type: "bind", Source: core, Destination: "/home/node/Remudero" },
      ...dests.map((d) => ({ Type: "bind", Source: join(base, "src"), Destination: d }))]));
  setServeMounts(serveMounts);
  writeFileSync(calls, "");
  writeFileSync(join(bin, "docker"), [
    "#!" + process.execPath,
    'const fs = require("node:fs");',
    "const a = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");`,
    'if (a[0] === "network") process.exit(0);',
    `if (a[0] === "inspect" && a[1] === "${SERVE_POLICY_CONTAINER}" && a.length === 2) process.exit(0);`,
    `if (a[0] === "inspect" && a[1] === "${SERVE_POLICY_CONTAINER}" && a.at(-1) === "{{json .Mounts}}") { process.stdout.write(fs.readFileSync(${JSON.stringify(mountsFile)})); process.exit(0); }`,
    "process.exit(1);", "",
  ].join("\n"), { mode: 0o755 });
  const registry = join(base, "registry.yaml");
  writeFileSync(registry, ["instances:", "  core:", "    repo: remudero", "    primary: true", "    container_name: remudero-daemon",
    "    image: registry.invalid/remudero:fixture", `    state_dir: ${core}`, ...rows, ""].join("\n"));
  const script = legacyHostScript(base, join(repoRoot(), "deploy", "serve-container.sh"), registry);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([n]) => !/^(RMD_|GH_|GITHUB_)/.test(n)));
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: base, RMD_STATE_DIR: core, RMD_SERVE_REPO_DIR: join(base, "code"),
    RMD_SERVE_DOCKER_NETWORK: "fixture-net", RMD_SERVE_DOCKERENV_PATH: join(base, "no-dockerenv"), RMD_SERVE_SUPERVISOR: "off",
    RMD_SCRATCH: "off", RMD_SCRATCH_ROOT: join(base, "scratch"), RMD_SCRATCH_SWITCH: join(base, "no-switch"),
    RMD_SCRATCH_CHECKOUTS: "off", RMD_SERVE_GENS_DIR: join(base, "generations"),
  });
  return {
    base, core, script, env, install: join(base, "legacy-host"), setServeMounts,
    run: (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
      spawnSync("bash", [script, ...args], { cwd: repoRoot(), env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 20_000 }),
    calls: (): string[][] => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]),
    resetCalls: () => writeFileSync(calls, ""),
  };
}

/** One instance of each kind the launch loop skips, beside one it mounts. */
function instanceRows(base: string): string[] {
  for (const dir of ["site-state", "retired-state", "gone-state"]) mkdirSync(join(base, dir, "state"), { recursive: true });
  return [
    "  site:", `    state_dir: ${join(base, "site-state")}`,
    "  retired:", `    state_dir: ${join(base, "retired-state")}`, "    retired: true",
    "  absent:", `    state_dir: ${join(base, "absent-state")}`,
    "  gone:", `    state_dir: ${join(base, "gone-state")}`, "    container_name: gone-daemon",
  ];
}

test("W1-T14591 criterion 2: --instance-mount-plan lists what a launch mounts and exits before any change", (t) => {
  const pre = makeTempDir("w1t14591-rows");
  t.after(() => rmSync(pre, { recursive: true, force: true }));
  const host = launcherHost(t, instanceRows(pre));
  writeFileSync(daemonInstanceRegistryPath(host.install),
    readFileSync(daemonInstanceRegistryPath(host.install), "utf8") + `  twin:\n    state_dir: ${host.core}\n`);
  // serve exists and no GH_TOKEN is given: a launch would refuse; the plan answers first
  const plan = host.run(["--instance-mount-plan"]);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.equal(plan.stdout, `instance\tsite\t${BASE}/site\n`);
  assert.match(plan.stderr, /instance absent's state .* is absent here/);
  assert.match(plan.stderr, /instance gone repos placement unavailable/);
  assert.ok(!host.calls().some((a) => ["run", "stop", "rm", "rename", "pull", "create"].includes(a[0]!)), JSON.stringify(host.calls()));
  assert.ok(!plan.stderr.includes("REFUSING"), plan.stderr);

  const launch = host.run(["--dry-run"], { GH_TOKEN: "fixture-only" });
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  const launched = [...launch.stdout.matchAll(/:\/home\/node\/rmd-instances\/([A-Za-z0-9_-]+):ro/g)].map((m) => m[1]);
  assert.deepEqual(launched, ["site"], "the launch mounts exactly the planned instances");
  assert.ok(launch.stdout.includes(`-v ${join(pre, "site-state")}:${BASE}/site:ro -v ${join(pre, "site-state")}/state:${BASE}/site/state`));
  assert.match(launch.stdout, /instance site state .* mounted at \/home\/node\/rmd-instances\/site/);
  assert.match(launch.stderr, /instance absent's state .* is absent here/);
  assert.match(launch.stderr, /instance gone repos placement unavailable/);

  const one = host.run(["--instance-mount-plan", "--instance", "core"]);
  assert.equal(one.status, 0, one.stdout + one.stderr);
  assert.equal(one.stdout, "", "a launch with --instance mounts no instance");

  // the watchdog seam reads this plan through the real launcher: only the planned instance is ever unmounted
  const real = launcherHost(t, instanceRows(pre));
  const exec = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", env: real.env, stdio: ["ignore", "pipe", "ignore"] });
  const seams = realServePolicyDeps({ installPath: real.install, stateRoot: real.core }, exec);
  assert.deepEqual(seams.serveUnmountedInstances!(NOW, true), ["site"]);
  real.setServeMounts([`${BASE}/site`]);
  assert.deepEqual(seams.serveUnmountedInstances!(NOW, true), []);
});

/** realServePolicyDeps over an exec stub that answers the launcher's plan and serve's Mounts. */
function stubbedSeams(t: { after: (fn: () => void) => void }) {
  const root = makeTempDir("w1t14591-settle");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const install = join(root, "install"), state = join(root, "state-root");
  for (const dir of [join(install, ".remudero"), join(install, "deploy"), join(state, "state")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(install, "deploy", "serve-container.sh"), "exit 1\n");
  writeFileSync(daemonInstanceRegistryPath(install),
    `instances:\n  core:\n    repo: remudero\n    primary: true\n    container_name: remudero-daemon\n    state_dir: ${state}\n`);
  const f = { plan: [] as string[], mounted: [] as string[], calls: [] as string[][], replaced: 0 };
  const exec = (cmd: string, args: string[]): string => {
    f.calls.push([cmd, ...args]);
    if (cmd === "bash" && args.includes("--instance-mount-plan")) return f.plan.map((n) => `instance\t${n}\t${BASE}/${n}\n`).join("");
    if (cmd === "docker" && args.at(-1) === "{{json .Mounts}}") return JSON.stringify(f.mounted.map((n) => ({ Destination: `${BASE}/${n}` })));
    if (cmd === "env") f.replaced++;
    return "";
  };
  const seams = realServePolicyDeps({ installPath: install, stateRoot: state }, exec, undefined, () => BUDGET);
  const file = join(state, "state", `${SERVE_UNMOUNTED_INSTANCES_FILE}.json`);
  const record = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, number> : undefined);
  return { f, seams, file, record, install, state };
}

test("W1-T14591 criterion 3: an unmounted instance counts only after it stays unmounted for the settle time", (t) => {
  const { f, seams, file, record, install, state } = stubbedSeams(t);
  assert.equal(SERVE_INSTANCE_MOUNT_SETTLE_MS, 5 * 60_000);
  f.plan = ["site", "fresh"];
  f.mounted = ["site"];
  assert.deepEqual(seams.serveUnmountedInstances!(NOW), [], "the first tick that sees it records it and does not count it");
  assert.deepEqual(record(), { fresh: NOW });
  assert.deepEqual(seams.serveUnmountedInstances!(NOW + SERVE_INSTANCE_MOUNT_SETTLE_MS - 1), []);
  assert.deepEqual(seams.serveUnmountedInstances!(NOW + SERVE_INSTANCE_MOUNT_SETTLE_MS), ["fresh"], "a later tick at the settle time counts it");
  assert.deepEqual(record(), { fresh: NOW }, "the first-seen time is kept");

  // a retired instance is never in the launcher's plan, so a stale entry for it is dropped and never counts
  writeFileSync(file, JSON.stringify({ fresh: NOW, retired: NOW - 60 * 60_000, gone: NOW - 60 * 60_000 }));
  assert.deepEqual(seams.serveUnmountedInstances!(NOW + SERVE_INSTANCE_MOUNT_SETTLE_MS), ["fresh"]);
  assert.deepEqual(record(), { fresh: NOW });

  // once mounted it is dropped; the file goes when nothing is unmounted
  f.mounted = ["site", "fresh"];
  assert.deepEqual(seams.serveUnmountedInstances!(NOW + 2 * SERVE_INSTANCE_MOUNT_SETTLE_MS), []);
  assert.equal(record(), undefined);

  // an unreadable record restarts the settle; it never skips it
  f.mounted = ["site"];
  writeFileSync(file, "{torn");
  assert.deepEqual(seams.serveUnmountedInstances!(NOW + 3 * SERVE_INSTANCE_MOUNT_SETTLE_MS), []);
  assert.deepEqual(record(), { fresh: NOW + 3 * SERVE_INSTANCE_MOUNT_SETTLE_MS });

  // an unknown reading (no inspect) leaves the file as it is
  const before = readFileSync(file, "utf8");
  f.plan = ["site", "fresh"];
  const noInspect = realServePolicyDeps({ installPath: install, stateRoot: state },
    (cmd, args) => { if (cmd === "docker") throw new Error("Error: No such object"); return args.includes("--instance-mount-plan") ? `instance\tfresh\t${BASE}/fresh\n` : ""; });
  assert.equal(noInspect.serveUnmountedInstances!(NOW + 9 * SERVE_INSTANCE_MOUNT_SETTLE_MS), undefined);
  assert.equal(readFileSync(file, "utf8"), before);

  // through the cycle: the first tick writes no row, the settled tick replaces serve
  writeFileSync(join(state, "state", "ledger.ndjson"), `${JSON.stringify({ step: "serve.handoff_done" })}\n`);
  rmSync(file);
  const tick = (nowMs: number) => {
    const rows: string[] = [];
    const deps = { ...seams, log: (step: string) => void rows.push(step), now: () => nowMs, stopPresent: () => false,
      pausePresent: () => false, serveHealthy: () => true, servePolicyDrift: () => [], serveMountPlanDrift: () => [],
      serveImageInputs: () => undefined, serveImageDrift: () => undefined, serveLastRestartAtMs: () => null,
      replaceServe: () => { f.mounted = ["site", "fresh"]; return undefined; } } as unknown as CycleDeps;
    return { out: runServePolicyCycle(deps, { imageDriftOnly: true }), rows };
  };
  const first = tick(NOW);
  assert.equal(first.out.replaced, false);
  assert.deepEqual(first.rows, []);
  const settled = tick(NOW + SERVE_INSTANCE_MOUNT_SETTLE_MS);
  assert.equal(settled.out.replaced, true, settled.out.reason);
  assert.deepEqual(settled.rows, ["deploy.serve_policy_replace", "deploy.serve_policy_replaced"]);
  assert.equal(record(), undefined, "a replace that mounts it removes it from the file");
});

test("W1-T14591 criterion 4: a counted instance is held by the existing holds, never by the image-only spacing", () => {
  const holds: Record<string, Partial<CycleDeps>> = {
    STOP: { stopPresent: () => true },
    PAUSE: { pausePresent: () => true },
    "the failure back-off": { servePolicyLastFailedAtMs: () => NOW - 60_000 },
    "an open handoff": { serveHandoffInProgress: () => true },
    "an unhealthy serve": { serveHealthy: () => false },
  };
  for (const [name, overrides] of Object.entries(holds)) {
    const c = cycle(overrides, ["site"]);
    const out = runServePolicyCycle(c.deps, { imageDriftOnly: true });
    assert.equal(out.replaced, false, name);
    assert.deepEqual(c.rows.map((r) => r.step), ["deploy.serve_policy_held"], name);
    assert.match(String(c.rows[0]!.data.reason), /serve instance mount missing \(site; the action is deploy\/serve-container\.sh --replace\)/, name);
    assert.deepEqual(c.rows[0]!.data.unmountedInstances, ["site"], name);
  }
  const dry = cycle({}, ["site"]);
  assert.equal(runServePolicyCycle(dry.deps, { imageDriftOnly: true, dryRun: true }).replaced, false);
  assert.deepEqual(dry.rows[0]!.data.unmountedInstances, ["site"]);
  const pressure = cycle({ replaceServe: () => ({ held: "host_headroom", detail: "fixture pressure" }) }, ["site"]);
  assert.match(runServePolicyCycle(pressure.deps, { imageDriftOnly: true }).reason, /fresh host pressure refused it/);
  assert.deepEqual(pressure.rows.map((r) => [r.step, r.data.unmountedInstances]),
    [["deploy.serve_policy_replace", ["site"]], ["deploy.serve_policy_held", ["site"]]]);
  assert.equal(pressure.failures.length, 0);

  // image drift inside the restart spacing plus a counted instance: the spacing does not apply
  const spaced = () => ({ serveImageInputs: sequence({ buildSha: IMAGE.actual, behind: 1 }, { buildSha: IMAGE.expected, behind: 0 }),
    newestBakedSha: () => IMAGE.expected, imagePublished: () => true, serveLastRestartAtMs: () => NOW - 60_000 }) as Partial<CycleDeps>;
  assert.equal(runServePolicyCycle(cycle(spaced(), "absent").deps, { imageDriftOnly: true }).replaced, false, "image alone waits");
  const both = cycle(spaced(), ["site"]);
  assert.equal(runServePolicyCycle(both.deps, { imageDriftOnly: true }).replaced, true);

  const go = cycle({}, ["site"]);
  const out = runServePolicyCycle(go.deps, { imageDriftOnly: true });
  assert.equal(out.replaced, true, out.reason);
  assert.deepEqual(out.unmountedInstances, ["site"]);
  const replaceRows = go.rows.filter((r) => r.step === "deploy.serve_policy_replace");
  assert.equal(replaceRows.length, 1);
  assert.deepEqual(replaceRows[0]!.data.unmountedInstances, ["site"]);
  assert.equal(replaceRows[0]!.data.action, SERVE_MOUNT_ACTION);
  assert.deepEqual(go.readings, [false, true], "the reading is taken again, raw, after the replace");

  const still = cycle({}, ["site"], ["site"]);
  const failed = runServePolicyCycle(still.deps, { imageDriftOnly: true });
  assert.equal(failed.replaced, false);
  assert.match(failed.reason, /instances still not mounted after the replace \(site\)/);
  assert.deepEqual(still.failures, ["instances still not mounted after the replace (site)"]);
  assert.equal(still.rows.at(-1)!.step, "deploy.serve_policy_failed");
  assert.equal(still.escalations.length, 1);
  assert.match(still.escalations[0]!, /- unmounted instances: site/);
  const unread = cycle({}, ["site"], "unreadable");
  assert.match(runServePolicyCycle(unread.deps, { imageDriftOnly: true }).reason, /instances still not mounted after the replace \(unreadable\)/);
});

test("W1-T14591 criterion 5: on the selected-registry path the reading is unknown and is never drift", async (t) => {
  const root = makeTempDir("w1t14591-selected");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const install = join(root, "install"), state = join(root, "state-root");
  for (const dir of [join(install, ".remudero"), join(install, "deploy"), join(state, "state")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(install, "deploy", "serve-container.sh"), "exit 1\n");
  const registry = `instances:\n  owner:\n    repo: remudero\n    github_repo: craigoley/remudero\n    primary: true\n    mode: shadow\n    state_dir: ${state}\n    container_name: remudero-daemon\n    image: registry.invalid/remudero:fixture\n`;
  writeFileSync(daemonInstanceRegistryPath(install), registry);
  const selectedPath = join(root, "private-selection.yaml");
  writeFileSync(selectedPath, registry, { mode: 0o600 });
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (args.includes("--instance-mount-plan")) return `instance\tother\t${BASE}/other\n`;
    return cmd === "docker" ? "[]" : "";
  };
  await withInstanceRegistryRuntime(() => {
    const seams = realServePolicyDeps({ installPath: install, stateRoot: state }, exec, undefined, () => BUDGET);
    assert.equal(seams.serveUnmountedInstances!(NOW + SERVE_INSTANCE_MOUNT_SETTLE_MS), undefined);
    assert.equal(seams.serveUnmountedInstances!(NOW + 2 * SERVE_INSTANCE_MOUNT_SETTLE_MS, true), undefined);
    const rows: string[] = [];
    const out = runServePolicyCycle({ ...seams, log: (step: string) => void rows.push(step), now: () => NOW,
      servePolicyDrift: () => [], serveMountPlanDrift: () => [], serveImageInputs: () => undefined, serveImageDrift: () => undefined,
    } as unknown as CycleDeps, { imageDriftOnly: true });
    assert.equal(out.replaced, false);
    assert.equal(out.unmountedInstances, undefined);
    assert.deepEqual(rows, []);
  }, { envPath: selectedPath, instanceName: "owner" });
  assert.equal(calls.some((c) => c.includes("--instance-mount-plan")), false, "the selected path never reads the plan");
  assert.equal(existsSync(join(state, "state", `${SERVE_UNMOUNTED_INSTANCES_FILE}.json`)), false);
});

