import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";
import fs, { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";

import { daemonInstallationRegistry, startDaemonInstallationBudget } from "#src/cli/commands/daemon.js";
import { configureGithubInstallationBudget } from "#src/lib/github-transport.js";
import { DEFAULT_HOST_INSTANCE_REGISTRY_PATH, installationConsumers, registryInstanceForRepo } from "#src/lib/instance-registry.js";
import { ledgerExceedsRotationCeiling, rotateLedger } from "#src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const INSTALLATION = "155256285";
const TARGET = "craigoley/remudero";
const CHECKOUT_REGISTRY = join(REPO_ROOT, ".remudero", "daemon-instances.yaml");

/** The checkout copy's shape: three live instances that name no installation, one on another, one retired. */
const OMITTED_IDS = [
  "instances:",
  "  core:", "    repo: remudero", "    github_repo: craigoley/remudero",
  "  site:", "    repo: remudero-site", "    github_repo: craigoley/remudero-site",
  "  console:", "    repo: remudero-console", "    github_repo: craigoley/remudero-console",
  "  other:", "    repo: other", "    github_repo: someone/other", '    gh_app_installation_id: "999"',
  "  old:", "    repo: old", "    github_repo: craigoley/old", "    retired: true",
  "",
].join("\n");

type Row = { step: string; extra?: Record<string, unknown> };

function configuredRow(
  read: () => { text: string; source: string; omitsInstallationIds?: boolean } | undefined,
  env: NodeJS.ProcessEnv = { GH_APP_INSTALLATION_ID: INSTALLATION },
  target: string | undefined = TARGET,
): Record<string, unknown> | undefined {
  const rows: Row[] = [];
  startDaemonInstallationBudget(read, env, (step, extra) => rows.push({ step, extra }), undefined, target);
  return rows.find((row) => row.step === "github.budget.configured")?.extra;
}

/** fs.readFileSync fails for the host registry path only; every other path reads as normal. */
function hostRegistryFails(t: TestContext, code: string): unknown[] {
  const originalRead = fs.readFileSync;
  const attempted: unknown[] = [];
  t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    attempted.push(args[0]);
    if (args[0] === DEFAULT_HOST_INSTANCE_REGISTRY_PATH) {
      throw Object.assign(new Error(`${code}: open '${DEFAULT_HOST_INSTANCE_REGISTRY_PATH}'`), { code });
    }
    return originalRead(...args);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return attempted;
}

afterEach(() => configureGithubInstallationBudget(undefined));

test("W1-T12670 criterion 1: with no host file the daemon reads the checkout's registry and the row names it", (t) => {
  const attempted = hostRegistryFails(t, "ENOENT");
  const read = daemonInstallationRegistry(REPO_ROOT);
  assert.equal(read?.source, CHECKOUT_REGISTRY);
  assert.equal(read?.omitsInstallationIds, true);
  assert.deepEqual(attempted, [DEFAULT_HOST_INSTANCE_REGISTRY_PATH, CHECKOUT_REGISTRY]);
  const row = configuredRow(() => daemonInstallationRegistry(REPO_ROOT));
  assert.equal(row?.outcome, "configured");
  assert.equal(row?.source, CHECKOUT_REGISTRY);

  // A checkout with no registry copy either stays unconfigured, with the reason.
  const empty = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}no-checkout-registry-`));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const missing = configuredRow(() => daemonInstallationRegistry(empty));
  assert.equal(missing?.outcome, "unconfigured");
  assert.equal(missing?.reason, "registry_unreadable");
});

test("W1-T12670 criterion 2: a host read error other than a missing file is logged, never hidden by the checkout", (t) => {
  const attempted = hostRegistryFails(t, "EACCES");
  const row = configuredRow(() => daemonInstallationRegistry(REPO_ROOT));
  assert.deepEqual(row, {
    role: "daemon", outcome: "unconfigured", instance: "unknown", instance_reason: "no_registry", reason: "registry_unreadable",
    installation_id: INSTALLATION, error: `EACCES: open '${DEFAULT_HOST_INSTANCE_REGISTRY_PATH}'`,
  });
  assert.deepEqual(attempted, [DEFAULT_HOST_INSTANCE_REGISTRY_PATH], "no checkout read after EACCES");
});

test("W1-T12670 criterion 3: with no RMD_INSTANCE_NAME the instance is the one live entry for the target repo", () => {
  const checkout = () => ({ text: OMITTED_IDS, source: "checkout", omitsInstallationIds: true });
  assert.equal(configuredRow(checkout)?.instance, "core");
  assert.equal(configuredRow(checkout, undefined, "Craigoley/Remudero-Site")?.instance, "site", "the repo match ignores case");
  assert.deepEqual(registryInstanceForRepo(OMITTED_IDS, "craigoley/old"), { reason: "no_registry_match" }, "a retired entry is no match");

  const none = configuredRow(checkout, undefined, "craigoley/nothing");
  assert.equal(none?.instance, "unknown");
  assert.equal(none?.instance_reason, "no_registry_match");

  const twice = OMITTED_IDS.replace("instances:\n", "instances:\n  core2:\n    repo: remudero\n    github_repo: craigoley/remudero\n");
  const several = configuredRow(() => ({ text: twice, source: "checkout", omitsInstallationIds: true }));
  assert.equal(several?.instance, "unknown");
  assert.equal(several?.instance_reason, "several_registry_matches");

  for (const instance of ["site", "unknown"]) {
    const env = { GH_APP_INSTALLATION_ID: INSTALLATION, RMD_INSTANCE_NAME: instance };
    assert.deepEqual(configuredRow(checkout, env), {
      role: "daemon", outcome: "configured", instance, installation_id: INSTALLATION, consumers: 6, source: "checkout",
    }, "RMD_INSTANCE_NAME wins over the repo match without adding instance_reason");
    assert.deepEqual(configuredRow(checkout, { RMD_INSTANCE_NAME: instance }), {
      role: "daemon", outcome: "unconfigured", instance, reason: "no_installation_id",
    });
    assert.deepEqual(configuredRow(() => undefined, env), {
      role: "daemon", outcome: "unconfigured", instance, reason: "registry_unreadable", installation_id: INSTALLATION,
    });
    assert.deepEqual(configuredRow(() => { throw new Error("registry denied"); }, env), {
      role: "daemon", outcome: "unconfigured", instance, reason: "registry_unreadable",
      installation_id: INSTALLATION, error: "registry denied",
    });
    assert.deepEqual(configuredRow(() => ({ text: OMITTED_IDS, source: "selected" }), env), {
      role: "daemon", outcome: "unconfigured", instance, reason: "no_instance_on_installation",
      installation_id: INSTALLATION, source: "selected",
    });
  }
});

test("W1-T12670 criterion 4: omitted installation ids count only on the checkout fallback, and only as more consumers", () => {
  // core, site and console name no id; "other" names 999 and "old" is retired.
  assert.equal(installationConsumers(OMITTED_IDS, INSTALLATION, { countOmitted: true }), 6);
  assert.equal(installationConsumers(OMITTED_IDS, "999", { countOmitted: true }), 7, "an entry on 999 counts for 999 only");
  assert.equal(installationConsumers(OMITTED_IDS, INSTALLATION), undefined, "W1-T12553's rule is the default");

  const fallback = configuredRow(() => ({ text: OMITTED_IDS, source: "checkout", omitsInstallationIds: true }));
  assert.equal(fallback?.consumers, 6);
  const host = configuredRow(() => ({ text: OMITTED_IDS, source: DEFAULT_HOST_INSTANCE_REGISTRY_PATH }));
  assert.equal(host?.outcome, "unconfigured");
  assert.equal(host?.reason, "no_instance_on_installation");
  const selected = configuredRow(() => ({ text: OMITTED_IDS, source: "selected" }));
  assert.equal(selected?.reason, "no_instance_on_installation");
});

test("W1-T12670 criterion 5: the real daemon start in a core-like container logs a configured share", async (t) => {
  hostRegistryFails(t, "ENOENT");
  const saved: Record<string, string | undefined> = {};
  for (const name of ["GH_APP_INSTALLATION_ID", "RMD_INSTANCE_NAME", "RMD_SELECTED_INSTANCE_REGISTRY", "RMD_INSTANCE_REGISTRY"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.GH_APP_INSTALLATION_ID = INSTALLATION;
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}core-like-daemon-`));
  const initialListeners = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) if (!initialListeners[signal].includes(listener)) process.removeListener(signal, listener);
    }
    await flush();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "state"));
  const plan = join(root, "tasks.yaml");
  writeFileSync(plan, "[]\n");
  const code = await daemonCommand(["--allow-self-target", "--plan", plan, "--max", "0"], {
    config: { root, claudeBin: "/bin/true" }, repoRoot: REPO_ROOT,
    startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
    checkPause: () => undefined, checkStop: () => undefined,
    readRunChildMode: () => "off",
    runDaemon: async () => ({ attempted: [], merged: [], stopReason: "stopped" as const, costUsd: 0, ticks: 0 }),
    bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined, drop: () => false, list: () => [] },
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
  });
  assert.equal(code, 0);
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const row = rows.find((r) => r.step === "github.budget.configured");
  assert.ok(row, `a github.budget.configured row, saw ${rows.map((r) => r.step).join(",")}`);
  assert.equal(row.outcome, "configured", JSON.stringify(row));
  assert.equal(row.instance, "core");
  assert.equal(row.installation_id, INSTALLATION);
  assert.equal(row.role, "daemon");
  // Every unretired registry row takes a share, the oleyarcade (W1-T14552) and wreckterra (W1-T14594) shadow rows included.
  assert.equal(row.consumers, 9, "W1-T14594: core, site, console, ops, oleyarcade and wreckterra plus the hand-run, run-child and serve shares");
  assert.equal(row.source, CHECKOUT_REGISTRY);
});

test("W1-T12670 criterion 6: rotation keeps the github.budget.configured row of each surviving boot", () => {
  const configured = { step: "github.budget.configured", outcome: "configured", instance: "core", consumers: 4 };
  const { path } = writeLedger([
    { ts: "2026-08-26T00:00:00.000Z", run_id: "DAEMON-1", step: "daemon.boot" },
    { ts: "2026-08-26T00:00:01.000Z", run_id: "DAEMON-1", ...configured, source: "old-boot" },
    { ts: "2026-08-26T01:00:00.000Z", run_id: "DAEMON-2", step: "daemon.boot" },
    { ts: "2026-08-26T01:00:01.000Z", run_id: "DAEMON-2", ...configured, source: "running-boot" },
    { ts: "2026-08-26T01:00:02.000Z", run_id: "DAEMON-2", step: "daemon.memory_policy", heap_growing_percent: 10 },
    { ts: "2026-08-26T01:00:03.000Z", run_id: "DAEMON-2", step: "daemon.tick" },
  ]);
  const ceiling = 200_000;
  let n = 0;
  while (!ledgerExceedsRotationCeiling(path, ceiling)) {
    appendFileSync(path, Array.from({ length: 200 }, () =>
      JSON.stringify({ ts: "2026-08-26T02:00:00.000Z", step: "ci.polling", run_id: `noise-${n++}`, detail: "x".repeat(96) })).join("\n") + "\n");
  }
  assert.equal(rotateLedger(path, { ceilingBytes: ceiling }).rotated, true);
  const live = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const kept = live.filter((r) => r.step === "github.budget.configured").map((r) => r.source);
  assert.deepEqual(kept, ["running-boot"], "the running boot's share row is kept; the replaced boot's ages out with it");
  assert.ok(live.some((r) => r.step === "daemon.memory_policy" && r.run_id === "DAEMON-2"), "the same rule keeps the heap policy row");
});
