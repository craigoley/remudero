// W1-T12950: a run child and serve read with the GitHub App installation token, as the daemons do. Before
// this task only the daemon set the installation budget, so run children (about 7,524 board reads in a day)
// and serve read with no share and no write reserve. Now each role sets its share through one start, and
// each keeps the write reserve.
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";

import { configPath } from "#src/lib/config.js";
import type { Config } from "#src/lib/config-schema.js";
import type { LearnedReservation } from "#src/lib/host-memory-learning.js";
import {
  configureGithubInstallationBudget, ghJson, ghJsonAsync, githubInstallationBudget, GhPaceFloorStandDownError,
} from "#src/lib/github-transport.js";
import { DEFAULT_HOST_INSTANCE_REGISTRY_PATH, installationConsumers } from "#src/lib/instance-registry.js";
import { INSTALLATION_SHARE_DIVISOR_ENV, startProcessInstallationBudget } from "#src/lib/installation-budget-start.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import type { Plan } from "#src/lib/plan.js";
import { spawnRunChild, writePlanSnapshot } from "#src/lib/run-child.js";
import { RUN_CHILD_SCHEMA, runDir, writeSpec, type RunChildProbe } from "#src/lib/run-child-contract.js";
import type { RunResult } from "#src/lib/run-result.js";
import { buildServeRoutes, type ServeDeps } from "#src/lib/serve.js";
import { DEFAULT_SWEEP_POLICY } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { runChildMain } from "#src/run-child-main.js";

const INSTALLATION = "155256285";
const LIMIT = 15_000;
/** The write reserve: 10% of the limit. */
const RESERVE = 1_500;
const SHA = "b".repeat(40);
const HASH = "a".repeat(64);
/** Three live instances on the installation, one on another, one retired: 3 + hand runs + run children + serve = 6. */
const HOST_REGISTRY = [
  "instances:",
  "  core:", "    repo: remudero", "    github_repo: craigoley/remudero", `    gh_app_installation_id: "${INSTALLATION}"`,
  "  site:", "    repo: remudero-site", "    github_repo: craigoley/remudero-site", `    gh_app_installation_id: "${INSTALLATION}"`,
  "  console:", "    repo: remudero-console", "    github_repo: craigoley/remudero-console", `    gh_app_installation_id: "${INSTALLATION}"`,
  "  other:", "    repo: other", "    github_repo: someone/other", '    gh_app_installation_id: "999"',
  "  old:", "    repo: old", "    github_repo: craigoley/old", "    retired: true", `    gh_app_installation_id: "${INSTALLATION}"`,
  "",
].join("\n");
const TASKS = [{ id: "W1-T12950", title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", status: "queued" }];
const RESULT: RunResult = { taskId: "W1-T12950", runId: "r1", merged: false, costUsd: 0, verdict: "no_pr" };
const noSignals = { on() {}, off() {} };
const probe: RunChildProbe = { process: () => ({ state: "alive", start: "proc:1" }), generation: () => ({ containerId: "c", initStart: "i" }) };
const READ = ["api", "repos/craigoley/remudero/pulls"];
const WRITE = ["api", "-X", "POST", "repos/craigoley/remudero/issues/1/comments", "-f", "body=x"];

type Row = Record<string, unknown> & { step: string };

afterEach(() => configureGithubInstallationBudget(undefined));

/** The reset an hour from now, in epoch seconds, as GitHub sends it. */
const resetSoon = (): number => Math.floor(Date.now() / 1000) + 3600;

/** A REST response with these rate-limit headers, as the real transport parses it. */
function response(remaining: number, body = "[]"): { stdout: string; stderr: string } {
  return {
    stdout: ["HTTP/2.0 200 OK", `X-Ratelimit-Remaining: ${remaining}`, `X-Ratelimit-Limit: ${LIMIT}`,
      `X-Ratelimit-Reset: ${resetSoon()}`, "X-Ratelimit-Resource: core", "", body].join("\r\n"),
    stderr: "",
  };
}

/** The host registry file reads as `text`, or fails with `code`; every other path reads as normal. */
function hostRegistry(t: TestContext, text: string | { code: string }): void {
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] !== DEFAULT_HOST_INSTANCE_REGISTRY_PATH) return originalRead(...args);
    if (typeof text === "string") return text;
    throw Object.assign(new Error(`${text.code}: open '${DEFAULT_HOST_INSTANCE_REGISTRY_PATH}'`), { code: text.code });
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

function scratchRoot(t: TestContext, label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12950-${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A run directory with its spec and plan snapshot, and the config the child's ledger rows go through. */
function runFixture(t: TestContext, label: string): { dir: string; root: string } {
  const root = scratchRoot(t, label);
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");
  const state = join(root, "state");
  const dir = runDir(state, `run-${label}`);
  mkdirSync(dir, { recursive: true });
  const snapshot = writePlanSnapshot(state, TASKS);
  writeSpec(dir, {
    schema: RUN_CHILD_SCHEMA, taskId: "W1-T12950", runId: `run-${label}`, instance: "core", engine: { sourceHash: HASH, sha: SHA },
    planSnapshotPath: snapshot.path, reservationId: "reservation-1", options: { skipGitSync: true },
  });
  return { dir, root };
}

/** The budget rows the run wrote to its ledger. */
function budgetRows(root: string): Row[] {
  return readFileSync(ledgerPathFor({ root } as Config), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row)
    .filter((row) => row.step === "github.budget.configured");
}

/** Runs the real run child entry with a stand-in run; `during` sees the process while the run executes. */
async function runChild(dir: string, env: NodeJS.ProcessEnv, during: () => Promise<void> | void = () => {}): Promise<{ code: number; errors: string[] }> {
  const errors: string[] = [];
  const code = await runChildMain(["--run-dir", dir], {
    signals: noSignals, probe, env, stderr: (text) => { errors.push(text); }, loadRunPath: async () => ({}),
    runTask: async () => { await during(); return RESULT; },
  });
  return { code, errors };
}

/** The minimal serve start: the real route assembly, with no App token refresh armed. */
function serveDeps(root: string, env: NodeJS.ProcessEnv, rows: Row[]): ServeDeps {
  const plan: Plan = { tasks: [], byId: new Map() };
  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(ledgerPath, "");
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const status = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  return {
    board: { plan, ledgerPath, github: status },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: status, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues: { close() {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "t12950-read", write: "t12950-write" },
    identity: { trustedLocalAddress: "127.0.0.1", capability: "remudero:console" },
    pollMs: 50,
    log: (step, extra) => { rows.push({ step, ...extra }); },
    githubAppRefresh: { start: (() => ({ armed: false })) as never, env },
  };
}

test("W1-T12950 criterion 1: a run child writes its run_child budget row and reads within its share", async (t) => {
  hostRegistry(t, HOST_REGISTRY);
  const { dir, root } = runFixture(t, "share");
  let inside: { consumers?: number; reads: number; refusal?: string; waitMs?: number } = { reads: 0 };
  const env = { GH_APP_INSTALLATION_ID: INSTALLATION, RMD_INSTANCE_NAME: "core", [INSTALLATION_SHARE_DIVISOR_ENV]: "2" };
  const { code, errors } = await runChild(dir, env, async () => {
    const budget = githubInstallationBudget();
    // 6 consumers, and the run-child share split by the divisor 2: 12 shares of what is left.
    inside = { consumers: budget.consumers, reads: 0 };
    // floor((reserve + 36 - reserve) / 12) = 3 reads after this reading.
    await ghJsonAsync(READ, async () => response(RESERVE + 36));
    for (let n = 0; n < 10; n++) {
      const admitted = budget.claimRead();
      if (!admitted.ok) {
        inside.refusal = admitted.reason;
        inside.waitMs = budget.resetWaitMs(admitted);
        break;
      }
      inside.reads += 1;
    }
  });
  assert.equal(code, 0, errors.join(""));
  assert.equal(inside.consumers, 12);
  assert.equal(inside.reads, 3, "the run child read its allowance");
  assert.equal(inside.refusal, "share", "the next read is past its share");
  assert.ok(inside.waitMs !== undefined && inside.waitMs > 0, "with no wait bound the read waits for the reset, as an unbounded daemon read does");
  const rows = budgetRows(root);
  assert.equal(rows.length, 1, "one row");
  assert.equal(rows[0]?.role, "run_child");
  assert.equal(rows[0]?.outcome, "configured");
  assert.equal(rows[0]?.consumers, 6);
  assert.equal(rows[0]?.share_divisor, 2);
  assert.equal(rows[0]?.instance, "core");
  assert.equal(rows[0]?.run_id, "run-share");
  assert.equal(rows[0]?.task_id, "W1-T12950");
});

test("W1-T12950 criterion 2: serve writes its serve budget row where it arms the token refresh, and its reads use the budget", async (t) => {
  hostRegistry(t, HOST_REGISTRY);
  const rows: Row[] = [];
  buildServeRoutes(serveDeps(scratchRoot(t, "serve"), { GH_APP_INSTALLATION_ID: INSTALLATION, RMD_INSTANCE_NAME: "console" }, rows));
  const configured = rows.filter((row) => row.step === "github.budget.configured");
  assert.equal(configured.length, 1);
  assert.deepEqual(configured[0], {
    step: "github.budget.configured", role: "serve", outcome: "configured", instance: "console", installation_id: INSTALLATION,
    consumers: 6, source: DEFAULT_HOST_INSTANCE_REGISTRY_PATH,
  });
  const budget = githubInstallationBudget();
  assert.equal(budget.consumers, 6);
  // floor(12 / 6) = 2 reads after this reading; the third stands down at once, with no wait for the reset.
  let calls = 0;
  const exec = async () => { calls += 1; return response(RESERVE + 12); };
  await ghJsonAsync(READ, exec);
  await ghJsonAsync(READ, async () => { calls += 1; return { stdout: "HTTP/2.0 200 OK\r\n\r\n[]", stderr: "" }; });
  await ghJsonAsync(READ, async () => { calls += 1; return { stdout: "HTTP/2.0 200 OK\r\n\r\n[]", stderr: "" }; });
  await assert.rejects(ghJsonAsync(READ, exec), GhPaceFloorStandDownError);
  assert.equal(calls, 3, "the read past the share never ran");
});

test("W1-T12950 criterion 3: in every role no write asks the budget, and a read is refused at the write reserve", async (t) => {
  for (const role of ["daemon", "run_child", "serve"] as const) {
    startProcessInstallationBudget({
      role, readRegistry: () => ({ text: HOST_REGISTRY, source: "host" }), log: () => {},
      env: { GH_APP_INSTALLATION_ID: INSTALLATION, RMD_INSTANCE_NAME: "core", [INSTALLATION_SHARE_DIVISOR_ENV]: "2" },
      ...(role === "serve" ? { maxWaitMs: 0 } : {}),
    });
    const budget = githubInstallationBudget();
    assert.ok(budget.consumers !== undefined, `${role} has a budget`);
    const asked = { claim: t.mock.method(budget, "claimRead"), admit: t.mock.method(budget, "admit") };
    for (const remaining of [RESERVE, RESERVE - 500]) {
      let wrote = 0;
      await ghJsonAsync(WRITE, async () => { wrote += 1; return response(remaining, "{}"); });
      ghJson(WRITE, undefined, () => { wrote += 1; return response(remaining, "{}").stdout; });
      assert.equal(wrote, 2, `${role}: both writes ran at remaining ${remaining}`);
      assert.equal(asked.claim.mock.callCount(), 0, `${role}: no write called claimRead`);
      assert.equal(asked.admit.mock.callCount(), 0, `${role}: no write called admit`);
      const read = budget.claimRead();
      assert.equal(read.ok, false, `${role}: a read is refused at remaining ${remaining}`);
      assert.equal(read.ok ? undefined : read.reason, "reserve");
      asked.claim.mock.resetCalls();
    }
    t.mock.restoreAll();
  }
});

test("W1-T12950 criterion 4: the run children and serve each count one share, and the daemon passes the run child its divisor", async (t) => {
  assert.equal(installationConsumers(HOST_REGISTRY, INSTALLATION), 6, "three live instances, hand runs, run children and serve");
  assert.equal(installationConsumers(HOST_REGISTRY, "999"), 4);

  // The daemon's spawn puts the host worker budget in the child's environment.
  const root = scratchRoot(t, "spawn");
  const state = join(root, "state");
  mkdirSync(join(state, "engines", HASH), { recursive: true });
  writeFileSync(join(state, "engines", HASH, "engine.json"), JSON.stringify({ sha: SHA, sourceHash: HASH, builtAt: Date.now() }));
  const reservation = {
    id: "reservation-1", workerClass: "implement", estimateMib: 1, estimateSource: "default", bindRoot: () => {}, releaseOccupancy: () => {},
  } as unknown as LearnedReservation;
  let childEnv: NodeJS.ProcessEnv | undefined;
  const launched = await spawnRunChild({
    taskId: "W1-T12950", stateRoot: state, repoDir: root, root, options: { skipGitSync: false },
    plan: async () => ({ plan: { tasks: TASKS } }) as never, log: () => {},
  }, {
    mainSha: async () => SHA, engine: { isCurrent: () => true }, reserve: async () => reservation, env: { KEEP: "1" },
    spawn: (_command, _args, options) => { childEnv = options.env; return { pid: undefined } as never; },
  });
  assert.equal(launched.started, false, "the stand-in child has no pid");
  assert.equal(childEnv?.[INSTALLATION_SHARE_DIVISOR_ENV], String(DEFAULT_SWEEP_POLICY.reviewCapacity.hostWorkerBudget));
  assert.equal(childEnv?.KEEP, "1", "the rest of the environment is passed as before");

  // With no divisor the run child divides by 1, and its row says so.
  hostRegistry(t, HOST_REGISTRY);
  const { dir, root: childRoot } = runFixture(t, "no-divisor");
  let consumers: number | undefined;
  const { code } = await runChild(dir, { GH_APP_INSTALLATION_ID: INSTALLATION, RMD_INSTANCE_NAME: "core" }, () => {
    consumers = githubInstallationBudget().consumers;
  });
  assert.equal(code, 0);
  assert.equal(consumers, 6);
  const [row] = budgetRows(childRoot);
  assert.equal(row?.share_divisor, 1);
  assert.equal(row?.divisor_reason, "divisor_missing");
});

test("W1-T12950 criterion 5: with no installation id or an unreadable registry, a run child and serve read as before", async (t) => {
  const unlimited = async (): Promise<void> => {
    assert.equal(githubInstallationBudget().consumers, undefined, "no budget is set");
    assert.deepEqual(await ghJsonAsync(READ, async () => ({ stdout: "[]", stderr: "" })), [], "the read asks no headers, as before");
    githubInstallationBudget().record({ remaining: 0, limit: LIMIT, reset: resetSoon(), resource: "core" });
    assert.equal(githubInstallationBudget().claimRead().ok, true, "a read goes ahead even at remaining 0");
  };
  const noId = runFixture(t, "no-id");
  const first = await runChild(noId.dir, { RMD_INSTANCE_NAME: "core" }, unlimited);
  assert.equal(first.code, 0, first.errors.join(""));
  assert.deepEqual(budgetRows(noId.root).map((row) => [row.role, row.outcome, row.reason]), [["run_child", "unconfigured", "no_installation_id"]]);

  hostRegistry(t, { code: "EACCES" });
  const unreadable = runFixture(t, "unreadable");
  const second = await runChild(unreadable.dir, { GH_APP_INSTALLATION_ID: INSTALLATION, RMD_INSTANCE_NAME: "core" }, unlimited);
  assert.equal(second.code, 0, second.errors.join(""));
  const [row] = budgetRows(unreadable.root);
  assert.equal(row?.role, "run_child");
  assert.equal(row?.outcome, "unconfigured");
  assert.equal(row?.reason, "registry_unreadable");
  assert.equal(row?.error, `EACCES: open '${DEFAULT_HOST_INSTANCE_REGISTRY_PATH}'`);

  for (const [env, reason] of [[{}, "no_installation_id"], [{ GH_APP_INSTALLATION_ID: INSTALLATION }, "registry_unreadable"]] as const) {
    const rows: Row[] = [];
    buildServeRoutes(serveDeps(scratchRoot(t, "serve-unset"), { ...env }, rows));
    const configured = rows.filter((r) => r.step === "github.budget.configured");
    assert.deepEqual(configured.map((r) => [r.role, r.outcome, r.reason]), [["serve", "unconfigured", reason]]);
    await unlimited();
  }
});
