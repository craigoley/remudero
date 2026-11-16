// W1-T13179: a run child read the instance registry under its config root (the state mount), where no
// registry is, so every run_child github.budget.configured row said registry_unreadable and W1-T12950's
// share never applied. Now the daemon gives each run child the file it read at its start, and the child's
// reads wait no longer than a finite bound. These tests drive the daemon's start, its spawn and the real
// run child entry, with a state root that has no .remudero directory, as the daemon's real layout has.
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";

import { daemonInstallationRegistry, startDaemonInstallationBudget } from "#src/cli/commands/daemon.js";
import { configPath } from "#src/lib/config.js";
import type { Config } from "#src/lib/config-schema.js";
import type { LearnedReservation } from "#src/lib/host-memory-learning.js";
import { configureGithubInstallationBudget, ghJsonAsync, githubInstallationBudget, GhPaceFloorStandDownError } from "#src/lib/github-transport.js";
import { DEFAULT_HOST_INSTANCE_REGISTRY_PATH } from "#src/lib/instance-registry.js";
import {
  INSTALLATION_MAX_WAIT_MS_ENV, INSTALLATION_REGISTRY_OMITS_IDS_ENV, INSTALLATION_REGISTRY_PATH_ENV, INSTALLATION_SHARE_DIVISOR_ENV,
  RUN_CHILD_INSTALLATION_MAX_WAIT_MS,
} from "#src/lib/installation-budget-start.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { spawnRunChild, writePlanSnapshot } from "#src/lib/run-child.js";
import { RUN_CHILD_SCHEMA, runDir, writeSpec, type RunChildProbe } from "#src/lib/run-child-contract.js";
import type { RunResult } from "#src/lib/run-result.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { runChildMain } from "#src/run-child-main.js";

const INSTALLATION = "155256285";
const TARGET = "craigoley/remudero";
const LIMIT = 15_000;
/** The write reserve: 10% of the limit. */
const RESERVE = 1_500;
const SHA = "c".repeat(40);
const HASH = "d".repeat(64);
const POLL_MS = 30_000;
/** The checkout copy's shape: three live instances that name no installation, one on another: 3 + hand runs + run children + serve = 6. */
const CHECKOUT_REGISTRY = [
  "instances:",
  "  core:", "    repo: remudero", "    github_repo: craigoley/remudero",
  "  site:", "    repo: remudero-site", "    github_repo: craigoley/remudero-site",
  "  console:", "    repo: remudero-console", "    github_repo: craigoley/remudero-console",
  "  other:", "    repo: other", "    github_repo: someone/other", '    gh_app_installation_id: "999"',
  "",
].join("\n");
/** A registry a fallback to the config root would find: one instance on the installation, so 4 consumers. */
const DECOY_REGISTRY = [
  "instances:",
  "  core:", "    repo: remudero", "    github_repo: craigoley/remudero", `    gh_app_installation_id: "${INSTALLATION}"`,
  "",
].join("\n");
const TASKS = [{ id: "W1-T13179", title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", status: "queued" }];
const RESULT: RunResult = { taskId: "W1-T13179", runId: "r1", merged: false, costUsd: 0, verdict: "no_pr" };
const noSignals = { on() {}, off() {} };
const probe: RunChildProbe = { process: () => ({ state: "alive", start: "proc:1" }), generation: () => ({ containerId: "c", initStart: "i" }) };
const READ = ["api", "repos/craigoley/remudero/pulls"];

type Row = Record<string, unknown> & { step: string };

afterEach(() => configureGithubInstallationBudget(undefined));

const resetIn = (seconds: number): number => Math.floor(Date.now() / 1000) + seconds;

/** A REST response with these rate-limit headers, as the real transport parses it; the reset is an hour away. */
function response(remaining: number): { stdout: string; stderr: string } {
  return {
    stdout: ["HTTP/2.0 200 OK", `X-Ratelimit-Remaining: ${remaining}`, `X-Ratelimit-Limit: ${LIMIT}`,
      `X-Ratelimit-Reset: ${resetIn(3600)}`, "X-Ratelimit-Resource: core", "", "[]"].join("\r\n"),
    stderr: "",
  };
}

/** The host registry is not mounted (ENOENT), as in remudero-daemon; every other path reads as normal. */
function noHostRegistry(t: TestContext): void {
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] !== DEFAULT_HOST_INSTANCE_REGISTRY_PATH) return originalRead(...args);
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${DEFAULT_HOST_INSTANCE_REGISTRY_PATH}'`), { code: "ENOENT" });
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

function scratchRoot(t: TestContext, label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13179-${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** The daemon's checkout, with its registry copy, apart from the state root. */
function checkout(t: TestContext): { root: string; registry: string } {
  const root = scratchRoot(t, "checkout");
  mkdirSync(join(root, ".remudero"), { recursive: true });
  const registry = join(root, ".remudero", "daemon-instances.yaml");
  writeFileSync(registry, CHECKOUT_REGISTRY);
  return { root, registry };
}

/** A run directory under a state root with no .remudero directory, and the config the child's rows go through. */
function runFixture(t: TestContext, label: string, decoy = false): { dir: string; root: string } {
  const root = scratchRoot(t, label);
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");
  if (decoy) {
    mkdirSync(join(root, ".remudero"), { recursive: true });
    writeFileSync(join(root, ".remudero", "daemon-instances.yaml"), DECOY_REGISTRY);
  }
  const state = join(root, "state");
  const dir = runDir(state, `run-${label}`);
  mkdirSync(dir, { recursive: true });
  const snapshot = writePlanSnapshot(state, TASKS);
  writeSpec(dir, {
    schema: RUN_CHILD_SCHEMA, taskId: "W1-T13179", runId: `run-${label}`, instance: "core", engine: { sourceHash: HASH, sha: SHA },
    planSnapshotPath: snapshot.path, reservationId: "reservation-1", options: { skipGitSync: true },
  });
  return { dir, root };
}

function budgetRows(root: string): Row[] {
  return readFileSync(ledgerPathFor({ root } as Config), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row)
    .filter((row) => row.step === "github.budget.configured");
}

async function runChild(dir: string, env: NodeJS.ProcessEnv, during: () => Promise<void> | void = () => {}): Promise<number> {
  const errors: string[] = [];
  const code = await runChildMain(["--run-dir", dir], {
    signals: noSignals, probe, env, stderr: (text) => { errors.push(text); }, loadRunPath: async () => ({}),
    runTask: async () => { await during(); return RESULT; },
  });
  assert.equal(code, 0, errors.join(""));
  return code;
}

/** The daemon starts as in production (no host registry, its checkout's copy, its instance name in its environment), then spawns a run child; the child's environment. */
async function daemonSpawnEnv(t: TestContext, checkoutRoot: string): Promise<{ env: NodeJS.ProcessEnv; daemonRows: Row[] }> {
  const daemonRows: Row[] = [];
  startDaemonInstallationBudget(() => daemonInstallationRegistry(checkoutRoot), { GH_APP_INSTALLATION_ID: INSTALLATION },
    (step, extra) => { daemonRows.push({ step, ...extra }); }, undefined, TARGET, POLL_MS);
  configureGithubInstallationBudget(undefined);
  const root = scratchRoot(t, "spawn");
  const state = join(root, "state");
  mkdirSync(join(state, "engines", HASH), { recursive: true });
  writeFileSync(join(state, "engines", HASH, "engine.json"), JSON.stringify({ sha: SHA, sourceHash: HASH, builtAt: Date.now() }));
  const reservation = {
    id: "reservation-1", workerClass: "implement", estimateMib: 1, estimateSource: "default", bindRoot: () => {}, releaseOccupancy: () => {},
  } as unknown as LearnedReservation;
  let env: NodeJS.ProcessEnv | undefined;
  await spawnRunChild({
    taskId: "W1-T13179", stateRoot: state, repoDir: root, root, options: { skipGitSync: false },
    plan: async () => ({ plan: { tasks: TASKS } }) as never, log: () => {},
  }, {
    mainSha: async () => SHA, engine: { isCurrent: () => true }, reserve: async () => reservation, env: { RMD_INSTANCE_NAME: "core" },
    spawn: (_command, _args, options) => { env = options.env; return { pid: undefined } as never; },
  });
  assert.ok(env !== undefined, "the daemon spawned the child");
  return { env, daemonRows };
}

test("W1-T13179 criterion 1: a run child reads the registry its daemon read and writes a configured run_child row naming it", async (t) => {
  noHostRegistry(t);
  const daemonCheckout = checkout(t);
  const { env, daemonRows } = await daemonSpawnEnv(t, daemonCheckout.root);
  const daemonRow = daemonRows.find((row) => row.step === "github.budget.configured");
  assert.equal(daemonRow?.outcome, "configured");
  assert.equal(daemonRow?.source, daemonCheckout.registry);

  const { dir, root } = runFixture(t, "configured");
  assert.equal(existsSync(join(root, ".remudero")), false, "the state root holds no .remudero directory");
  let consumers: number | undefined;
  await runChild(dir, { ...env, GH_APP_INSTALLATION_ID: INSTALLATION }, () => { consumers = githubInstallationBudget().consumers; });
  const rows = budgetRows(root);
  assert.equal(rows.length, 1, "one row");
  assert.equal(rows[0]?.role, "run_child");
  assert.equal(rows[0]?.outcome, "configured", JSON.stringify(rows[0]));
  assert.equal(rows[0]?.source, daemonCheckout.registry, "the daemon's source path");
  assert.equal(rows[0]?.consumers, 6, "the checkout copy counts its instances with no installation id, as the daemon does");
  assert.equal(rows[0]?.instance, "core");
  assert.equal(rows[0]?.reason, undefined);
  assert.ok(consumers !== undefined && consumers > 0, "the budget is set while the run reads");
});

test("W1-T13179 criterion 2: the daemon gives the child its registry path beside the divisor, and the child never reads its config root", async (t) => {
  noHostRegistry(t);
  const daemonCheckout = checkout(t);
  const { env } = await daemonSpawnEnv(t, daemonCheckout.root);
  assert.ok(env[INSTALLATION_SHARE_DIVISOR_ENV], "the divisor is set");
  assert.equal(env[INSTALLATION_REGISTRY_PATH_ENV], daemonCheckout.registry, "the registry path the daemon read rides beside the divisor");
  assert.equal(env[INSTALLATION_REGISTRY_OMITS_IDS_ENV], "1", "the checkout copy names no installation ids");

  // A registry under the child's config root is never read: the child's row names the daemon's file and its count.
  const { dir, root } = runFixture(t, "decoy", true);
  await runChild(dir, { ...env, GH_APP_INSTALLATION_ID: INSTALLATION });
  const [row] = budgetRows(root);
  assert.equal(row?.source, daemonCheckout.registry);
  assert.notEqual(row?.source, join(root, ".remudero", "daemon-instances.yaml"));
  assert.equal(row?.consumers, 6, "not the decoy's 4");
});

test("W1-T13179 criterion 3: a run child's over-share read past a far reset stands down at once, and does not wait for the hourly reset", async (t) => {
  noHostRegistry(t);
  const daemonCheckout = checkout(t);
  const { env } = await daemonSpawnEnv(t, daemonCheckout.root);
  assert.equal(env[INSTALLATION_MAX_WAIT_MS_ENV], String(POLL_MS), "the daemon's poll interval is the child's bound");

  for (const [label, childEnv, bound] of [
    ["poll-bound", { ...env, GH_APP_INSTALLATION_ID: INSTALLATION }, POLL_MS],
    ["backstop", { ...env, GH_APP_INSTALLATION_ID: INSTALLATION, [INSTALLATION_MAX_WAIT_MS_ENV]: undefined }, RUN_CHILD_INSTALLATION_MAX_WAIT_MS],
  ] as const) {
    const { dir } = runFixture(t, label);
    const seen: { refusal?: string; farWait?: number; nearWait?: number; stoodDown?: boolean; calls: number; elapsedMs?: number } = { calls: 0 };
    await runChild(dir, childEnv, async () => {
      const budget = githubInstallationBudget();
      // 6 consumers split by the divisor: one read above the reserve leaves the child no read of its own.
      await ghJsonAsync(READ, async () => { seen.calls += 1; return response(RESERVE + 1); });
      const admitted = budget.claimRead();
      assert.equal(admitted.ok, false, `${label}: the next read is refused`);
      if (admitted.ok) return;
      seen.refusal = admitted.reason;
      seen.farWait = budget.resetWaitMs(admitted);
      seen.nearWait = budget.resetWaitMs({ ...admitted, waitUntil: resetIn(Math.floor(bound / 2000)) });
      const started = Date.now();
      await assert.rejects(ghJsonAsync(READ, async () => { seen.calls += 1; return response(RESERVE + 1); }), GhPaceFloorStandDownError);
      seen.elapsedMs = Date.now() - started;
      seen.stoodDown = true;
    });
    assert.equal(seen.refusal, "share", `${label}: the read is past the child's share`);
    assert.equal(seen.farWait, undefined, `${label}: a reset an hour away is past the bound, so the read does not wait for it`);
    assert.ok(seen.nearWait !== undefined && seen.nearWait <= bound, `${label}: a reset within the bound is waited for`);
    assert.equal(seen.stoodDown, true);
    assert.equal(seen.calls, 1, `${label}: the read past the share never ran`);
    assert.ok((seen.elapsedMs ?? Infinity) < 5_000, `${label}: it stood down at once`);
  }
});

test("W1-T13179 criterion 4: invariant:no-budget-when-unconfigured — no path, or a path that cannot be read, sets no budget and the row says why", async (t) => {
  const unlimited = async (): Promise<void> => {
    assert.equal(githubInstallationBudget().consumers, undefined, "no budget is set");
    assert.deepEqual(await ghJsonAsync(READ, async () => ({ stdout: "[]", stderr: "" })), [], "the read asks no headers, as before");
    githubInstallationBudget().record({ remaining: 0, limit: LIMIT, reset: resetIn(3600), resource: "core" });
    assert.equal(githubInstallationBudget().claimRead().ok, true, "a read goes ahead even at remaining 0");
  };
  // No path: the decoy under the config root is not a fallback.
  const missing = runFixture(t, "missing", true);
  await runChild(missing.dir, { GH_APP_INSTALLATION_ID: INSTALLATION, RMD_INSTANCE_NAME: "core", [INSTALLATION_SHARE_DIVISOR_ENV]: "2" }, unlimited);
  const [noPath] = budgetRows(missing.root);
  assert.equal(noPath?.role, "run_child");
  assert.equal(noPath?.outcome, "unconfigured");
  assert.equal(noPath?.reason, "registry_path_missing");
  assert.equal(noPath?.registry_path, `${INSTALLATION_REGISTRY_PATH_ENV} unset`);
  assert.equal(noPath?.error, `${INSTALLATION_REGISTRY_PATH_ENV} is not set`);
  assert.equal(noPath?.source, undefined, "no file was read");

  // A path that cannot be read: the row names the path and the error.
  const unreadable = runFixture(t, "unreadable");
  const gone = join(unreadable.root, "no-such-dir", "daemon-instances.yaml");
  await runChild(unreadable.dir, { GH_APP_INSTALLATION_ID: INSTALLATION, RMD_INSTANCE_NAME: "core", [INSTALLATION_REGISTRY_PATH_ENV]: gone }, unlimited);
  const [noFile] = budgetRows(unreadable.root);
  assert.equal(noFile?.outcome, "unconfigured");
  assert.equal(noFile?.reason, "registry_unreadable");
  assert.equal(noFile?.registry_path, gone);
  assert.match(String(noFile?.error), /ENOENT/);
  assert.ok(String(noFile?.error).includes(gone), "the error names the path");
});
