// test/the-daemon-owns-the-worker-git-credential-socket.test.ts — W1-T5115.
//
// W1-T2699 built the scoped-token socket and the per-worktree helper; nothing in production ran
// them. These tests drive the REAL `daemonCommand` (only its loop, App refresh, mint and the two
// worker-launching seams are injected), the REAL `runTask` spawn wrapper, the REAL sweep fix
// spawn and the REAL `spawnWorker` git wiring, then ask git itself for a credential.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createConnection } from "node:net";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import type { DispatchClaimReserver } from "../src/lib/dispatch-claim.js";
import { buildWorkerEnv } from "../src/lib/env.js";
import { mintScopedToken } from "../src/lib/github-app.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  daemonGitCredentialSocketPath,
  realScopedMint,
  secretBoundaryEnv,
  startDaemonGitCredentialSocket,
  type ScopedTokenMint,
} from "../src/lib/secret-boundary.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  CLAUDE_BIN_ENV_OVERRIDE,
  createClaudeExecutableCache,
  spawnWorker,
  type SpawnWorkerArgs,
  type WorkerResult,
} from "../src/lib/worker.js";
import { buildSweepHook, daemonCommand, gitCredentialFixSpawn, runTask } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

/** `git credential fill` for one owner/repo URL, asynchronously, with its stdin closed. */
function credentialFill(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, "credential", "fill"], { env });
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`git credential fill exited ${code}`))));
    child.stdin.end("url=https://github.com/acme/widgets.git\n\n");
  });
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

function scratchDir(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}git-cred-${kind}-`));
}

/** git with no operator config at all, so only what a test wires can answer a credential ask. */
function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "no-global-gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GH_TOKEN: "",
  };
}

function socketRoundTrip(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

type CapturedQuery = { env?: Record<string, string | undefined> };

/** The SDK's `query()` stand-in: no process, but it sees the exact env the worker would get. */
function capturingQuery(captured: CapturedQuery): SpawnWorkerArgs["queryFn"] {
  return ((input: { options?: { env?: Record<string, string | undefined> } }) => {
    captured.env = input.options?.env;
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s-1", total_cost_usd: 0, num_turns: 1 };
    })();
  }) as unknown as SpawnWorkerArgs["queryFn"];
}

/** A real `spawnWorker` call with no real worker: the git wiring runs before the injected query. */
function spawnArgs(scratch: string, cwd: string, captured: CapturedQuery): SpawnWorkerArgs {
  const settingsFile = join(scratch, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
  return {
    cwd,
    permissionMode: "bypassPermissions",
    settingsFile,
    prompt: "W1-T5115 git credential fixture",
    config: { claudeBin: "/unused", root: scratch },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: scratch, exists: () => true, canExecute: () => true, locations: [] },
    },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }) },
    queryFn: capturingQuery(captured),
  } as SpawnWorkerArgs;
}

function worktreeFixture(kind: string): { scratch: string; cwd: string } {
  const scratch = scratchDir(kind);
  const cwd = join(scratch, "worktree");
  mkdirSync(cwd);
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  return { scratch, cwd };
}

function credentialHelpers(cwd: string): string[] {
  return execFileSync("git", ["-C", cwd, "config", "--worktree", "--get-all", "credential.helper"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/** The daemon's own config home — the shape test/daemon-crashloop-wiring.test.ts drives. */
function daemonHome(): { home: string; root: string; planPath: string } {
  const home = scratchDir("daemon");
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const now = new Date();
  utimesSync(home, now, now);
  return { home, root, planPath };
}

type DaemonObservation = {
  code: number;
  root: string;
  socketPath: string;
  existedBeforeReady?: boolean;
  duringLoop?: { exists: boolean; mode: number; dirMode: number; isSocket: boolean; reply?: string };
  taskOpts?: Record<string, unknown>;
  sweepArgs?: unknown[];
  mintedFor: string[];
  cleanupErrors: string[];
};

/** Drive the real `daemonCommand` once. `armed` false is an App-unconfigured host. */
async function driveDaemon(armed: boolean, damageSocketOnStop = false): Promise<DaemonObservation> {
  const { home, root, planPath } = daemonHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const socketPath = daemonGitCredentialSocketPath(join(root, "state"));
  const observation: DaemonObservation = { code: -1, root, socketPath, mintedFor: [], cleanupErrors: [] };
  let settle!: () => void;
  const ready = new Promise<void>((resolve) => (settle = resolve));
  const mint: ScopedTokenMint = async (repo) => {
    observation.mintedFor.push(repo);
    return { ok: true, token: `scoped-for-${repo}` };
  };
  const runDaemonStub = async (_plan: unknown, deps: DaemonDeps): Promise<DaemonSummary> => {
    if (existsSync(socketPath)) {
      const stat = statSync(socketPath);
      observation.duringLoop = {
        exists: true,
        mode: stat.mode & 0o777,
        dirMode: statSync(join(socketPath, "..")).mode & 0o777,
        isSocket: stat.isSocket(),
        reply: await socketRoundTrip(socketPath, "protocol=https\nhost=github.com\npath=acme/widgets.git\n\n"),
      };
    }
    await deps.runOne("T-GIT-CRED");
    if (damageSocketOnStop) {
      rmSync(socketPath);
      mkdirSync(socketPath);
    }
    return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
  };
  try {
    const run = daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: runDaemonStub as never,
      startGithubAppRefresh: () => (armed ? { armed: true, ready } : { armed: false }),
      gitCredentialMint: mint,
      runTask: (async (_taskId: string, opts: Record<string, unknown>) => {
        observation.taskOpts = opts;
        return { taskId: "T-GIT-CRED", runId: "r", merged: false, costUsd: 0, verdict: "blocked" };
      }) as unknown as typeof runTask,
      buildSweepHook: ((...args: unknown[]) => {
        observation.sweepArgs = args;
        return async () => undefined;
      }) as unknown as typeof buildSweepHook,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    observation.existedBeforeReady = existsSync(socketPath);
    settle();
    observation.code = await run;
    const ledgerPath = join(root, "state", "ledger.ndjson");
    if (existsSync(ledgerPath)) {
      observation.cleanupErrors = readFileSync(ledgerPath, "utf8").split("\n").filter((line) => line.includes("git credential socket did not close"));
    }
    return observation;
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    // A damaged socket outlives shutdown; where the state root is too deep, its dir sits in /tmp.
    rmSync(dirname(socketPath), { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

// ── (1) the daemon starts the socket, owner-only, only after App readiness ──────────────────────

test("the daemon starts its git credential socket only after App readiness", async () => {
  const seen = await driveDaemon(true);
  assert.equal(seen.code, 0);
  assert.equal(seen.existedBeforeReady, false, "nothing may bind while the first App mint is still in flight");
  assert.ok(seen.duringLoop, "once readiness settles, the socket exists for the daemon loop's whole life");
  assert.equal(seen.duringLoop.isSocket, true, "it is a unix socket, not a token file");
  assert.equal(seen.duringLoop.mode, 0o600, "owner-only: no other user may connect");
  assert.equal(seen.duringLoop.dirMode, 0o700, "and its directory is private too");
  assert.equal(seen.duringLoop.reply, "username=x-access-token\npassword=scoped-for-acme/widgets\n", "and it answers git");
  assert.deepEqual(seen.mintedFor, ["acme/widgets"], "exactly one mint, for the repo git named");
});

// ── (2) task workers and sweep fix workers both receive it ──────────────────────────────────────

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "test-session", costUsd: 0, numTurns: 0, text: "", blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    ...over,
  };
}

const TASK_ID = "T-GIT-CRED-SOCKET";
const PR_URL = "https://github.com/acme/remudero/pull/1";
const HEAD_SHA = "c".repeat(40);

/** The real `runTask`, offline: recon + implement through its ONE spawn wrapper, then a CI wait
 *  handed off at once (the W1-T3793 fixture shape). Returns every spawn's arguments. */
async function runTaskSpawns(gitCredentialSocketPath: string | undefined): Promise<SpawnWorkerArgs[]> {
  const root = scratchDir("run-task");
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, [
    `- id: ${TASK_ID}`, "  title: git credential socket fixture", "  repo: remudero", "  type: implement",
    "  verify: auto", "  risk: medium", "  files: [src/run-task.ts]", "  origin: test", "  status: queued", "",
  ].join("\n"));
  const origin = gitRepo({ bare: true, kind: "git-cred-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "git-cred-seed" });
  seed.addRemote("origin", origin.dir);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "-u", "origin", "main");
  const repo = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  const gh = ghShim([
    { when: "pr view", stdout: JSON.stringify({ headRefName: "run-branch", body: "" }) },
    { when: "/pulls/", stdout: JSON.stringify({ number: 1, state: "open", merged: false, merged_at: null, head: { sha: HEAD_SHA } }) },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "queued" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
  ], { kind: "git-cred-socket" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${previousPath}`;
  const calls: SpawnWorkerArgs[] = [];
  const claimReserver: DispatchClaimReserver = {
    mintAnchor: () => "git-cred-anchor",
    attempt: () => "created",
    holder: () => undefined,
    drop: () => true,
  };
  try {
    const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
    await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn: async (args) => {
          calls.push(args);
          return calls.length === 1
            ? workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" })
            : workerResult({ text: `REPORT\nPR_URL: ${PR_URL}\n` });
        },
        claimReserver,
        containmentExec: (token: string): Promise<ProbeExecResult> =>
          Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
        isolationExec: (): Promise<IsolationProbeExecResult> =>
          Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
        externalWaitFreshness: () => ({ stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40) }),
        ...(gitCredentialSocketPath ? { gitCredentialSocketPath } : {}),
      }),
    );
    return calls;
  } finally {
    process.env.PATH = previousPath;
    rmSync(gh.dir, { recursive: true, force: true });
    origin.cleanup();
    seed.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}

test("task and fix workers both receive the daemon git credential socket", async () => {
  // THE DAEMON HANDS THE SAME PATH TO BOTH LAUNCHERS.
  const seen = await driveDaemon(true);
  assert.equal(seen.taskOpts?.gitCredentialSocketPath, seen.socketPath, "runOne threads the socket into runTask");
  // W1-T4075 appended the tick-read accessor after the socket, so the socket is located by VALUE,
  // not by a trailing position the next appended seam would shift again.
  assert.deepEqual(
    seen.sweepArgs?.filter((arg) => arg === seen.socketPath),
    [seen.socketPath],
    "and the full sweep hook receives the SAME path for its fix rung",
  );

  // THE TASK WORKER: every spawn through runTask's one wrapper carries it, as a git-only handle.
  const socketPath = join(scratchDir("task-socket"), "helper.sock");
  const taskSpawns = await runTaskSpawns(socketPath);
  assert.ok(taskSpawns.length >= 2, "recon and implement both spawned");
  for (const args of taskSpawns) {
    assert.deepEqual(args.secretBoundary, { credentialHelperSocketPath: socketPath }, "git-only: no model half is invented");
  }

  // THE FIX WORKER: the sweep's spawn, driven into the REAL spawnWorker, wires the worktree's git.
  const { scratch, cwd } = worktreeFixture("fix-worker");
  const fixSocket = join(scratch, "helper.sock");
  let fixArgs: SpawnWorkerArgs | undefined;
  const result = await gitCredentialFixSpawn(fixSocket, (args) => {
    fixArgs = args;
    return spawnWorker(args);
  })(spawnArgs(scratch, cwd, {}));
  assert.equal(result.credentialHelperUnwired, undefined, "the wiring landed");
  assert.deepEqual(fixArgs?.secretBoundary, { credentialHelperSocketPath: fixSocket });
  const helpers = credentialHelpers(cwd);
  assert.match(helpers.at(-1) ?? "", /git-credential-socket-helper\.mjs/, "the worktree's git names the socket helper");
  assert.ok((helpers.at(-1) ?? "").includes(fixSocket), "carrying the daemon's own socket path");

  // A SECOND SPAWN IN THE SAME WORKTREE (recon, then implement) finds it wired, not unwired.
  const again = await spawnWorker({ ...spawnArgs(scratch, cwd, {}), secretBoundary: { credentialHelperSocketPath: fixSocket } });
  assert.equal(again.credentialHelperUnwired, undefined, "a worktree already routed to this socket is not reported unwired");
  rmSync(scratch, { recursive: true, force: true });
});

test("the daemon sweep builds its fix effects with the active git socket", async () => {
  const root = scratchDir("sweep-socket");
  mkdirSync(join(root, "state"), { recursive: true });
  const gh = ghShim([{ when: "", stdout: "[]" }], { kind: "sweep-socket" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${previousPath}`;
  const rows: string[] = [];
  try {
    const hook = buildSweepHook(
      "acme", "widgets", { root, claudeBin: "/bin/true" } as Config,
      join(root, "state", "ledger.ndjson"), "SOCKET-SWEEP", { tasks: [], byId: new Map() },
      (step) => rows.push(step),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, join(root, "state", "git-credential", "helper.sock"),
    );
    await hook();
    assert.equal(rows.includes("sweep.error"), false, "the active-socket sweep reaches its normal completion path");
  } finally {
    process.env.PATH = previousPath;
    rmSync(gh.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (3) a scoped token, minted per request, held by no env and no file ──────────────────────────

test("a worker git credential request mints a repo-scoped token on demand", async () => {
  const { scratch, cwd } = worktreeFixture("mint");
  const minted: string[] = [];
  const mint: ScopedTokenMint = async (repo) => {
    minted.push(repo);
    return { ok: true, token: `scoped-token-${minted.length}` };
  };
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const socket = await startDaemonGitCredentialSocket({
    ready: Promise.resolve(),
    stateDir: join(scratch, "state"),
    log: (step, fields) => rows.push({ step, fields }),
    mint,
  });
  assert.ok(socket);
  try {
    const captured: CapturedQuery = {};
    await spawnWorker({ ...spawnArgs(scratch, cwd, captured), secretBoundary: { credentialHelperSocketPath: socket.socketPath } });

    // ASYNC on purpose: this socket is the in-process test host, served by this very event loop.
    const env = isolatedGitEnv(scratch);
    const first = await credentialFill(cwd, env);
    const second = await credentialFill(cwd, env);
    assert.match(first, /^password=scoped-token-1$/m, "git received the token minted for this request");
    assert.match(second, /^password=scoped-token-2$/m, "and a second request is minted fresh, never cached");
    assert.deepEqual(minted, ["acme/widgets", "acme/widgets"], "scoped to the owner/repo git named, once per request");
    assert.ok(rows.every((row) => row.step === "boundary.request"), "the existing value-free boundary rows");
    assert.equal(JSON.stringify(rows).includes("scoped-token-"), false, "no ledger row carries the token");

    const workerEnv = Object.values(captured.env ?? {}).join("\n");
    assert.equal(workerEnv.includes("scoped-token-"), false, "the worker env holds no scoped token value");
    const stateFiles = [join(scratch, "state"), dirname(socket.socketPath)].filter((dir) => existsSync(dir)).flatMap(filesUnder);
    for (const file of [...filesUnder(cwd), ...stateFiles].filter((f) => !f.endsWith(".sock"))) {
      assert.equal(readFileSync(file, "utf8").includes("scoped-token-"), false, `${file} must hold no token`);
    }
  } finally {
    await socket.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ── (4) an App-unconfigured daemon, and a direct run-task, stay ambient ─────────────────────────

test("an unconfigured daemon creates no git credential socket", async () => {
  const seen = await driveDaemon(false);
  assert.equal(seen.code, 0);
  assert.equal(seen.duringLoop, undefined, "no socket exists while the daemon loop runs");
  assert.equal(existsSync(join(seen.root, "state", "git-credential")), false, "and no socket directory was made");
  assert.equal(seen.taskOpts !== undefined && "gitCredentialSocketPath" in seen.taskOpts, false, "runTask gets no socket key at all");
  assert.ok(seen.sweepArgs, "the sweep hook was built");
  assert.equal(
    seen.sweepArgs.some((arg) => typeof arg === "string" && arg.includes("git-credential")),
    false,
    "and neither does the sweep hook",
  );
  assert.deepEqual(seen.mintedFor, []);

  assert.equal(
    await startDaemonGitCredentialSocket({ ready: undefined, stateDir: scratchDir("unarmed"), log: () => {} }),
    undefined,
    "no readiness barrier means no App, so nothing starts",
  );

  // A DIRECT `rmd run-task` never passes the path: its spawns carry no boundary at all.
  const direct = await runTaskSpawns(undefined);
  assert.ok(direct.length >= 2);
  for (const args of direct) assert.equal("secretBoundary" in args, false, "direct run-task spawns are unchanged");
});

// ── (5) the git half is separable from the model half ───────────────────────────────────────────

test("a git-only credential handle leaves the model credentials untouched", async () => {
  const built = buildWorkerEnv({}, { PATH: "/usr/bin", HOME: "/h", CLAUDE_CODE_OAUTH_TOKEN: "REAL-OAUTH", GH_TOKEN: "REAL-GH" });
  assert.equal(secretBoundaryEnv(built, { credentialHelperSocketPath: "/s.sock" }), built, "the env builder is a no-op");

  const MODEL_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"];
  const modelEnv = (env: Record<string, string | undefined> | undefined) =>
    Object.fromEntries(MODEL_KEYS.filter((key) => env && key in env).map((key) => [key, env?.[key]]));
  const oldOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "REAL-OAUTH-FIXTURE";
  const { scratch, cwd } = worktreeFixture("git-only");
  try {
    const ambient: CapturedQuery = {};
    await spawnWorker(spawnArgs(scratch, cwd, ambient));
    const gitOnly: CapturedQuery = {};
    await spawnWorker({ ...spawnArgs(scratch, cwd, gitOnly), secretBoundary: { credentialHelperSocketPath: join(scratch, "s.sock") } });
    assert.equal(ambient.env?.CLAUDE_CODE_OAUTH_TOKEN, "REAL-OAUTH-FIXTURE", "the control: the spawn carries the model token");
    assert.deepEqual(modelEnv(gitOnly.env), modelEnv(ambient.env), "a git-only handle leaves every model credential as it was");
    assert.match(credentialHelpers(cwd).at(-1) ?? "", /git-credential-socket-helper\.mjs/, "while still wiring git");
  } finally {
    if (oldOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldOauth;
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ── (6) no path, or a refusal, mints nothing broader ────────────────────────────────────────────

test("a pathless or refused git credential request mints nothing broader", async () => {
  const scratch = scratchDir("refuse");
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const log = (step: string, fields: Record<string, unknown>) => rows.push({ step, fields });

  // THE REAL MINT behind the daemon's socket, with an App configured and GitHub's exchange recorded.
  const keyPath = join(scratch, "app.pem");
  writeFileSync(keyPath, generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey);
  const exchanges: unknown[] = [];
  const realMint: ScopedTokenMint = async (repo) => {
    const minted = await mintScopedToken(repo, 60_000, {
      appId: "app-1",
      installationId: "inst-1",
      privateKeyPath: keyPath,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        exchanges.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ token: "INSTALLATION-WIDE", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
      }) as unknown as typeof fetch,
    });
    return minted.ok && minted.token ? { ok: true, token: minted.token } : { ok: false, reason: minted.reason ?? "no token" };
  };
  const real = await startDaemonGitCredentialSocket({ ready: Promise.resolve(), stateDir: join(scratch, "real"), log, mint: realMint });
  // A MINT THAT REFUSES a pathful request.
  const refusedFor: string[] = [];
  const refusing = await startDaemonGitCredentialSocket({
    ready: Promise.resolve(),
    stateDir: join(scratch, "refusing"),
    log,
    mint: async (repo) => {
      refusedFor.push(repo);
      return { ok: false, reason: "exchange rejected: 403" };
    },
  });
  // THE PRODUCTION HOST: its own thread and the real `mintScopedToken`. The test runner strips the
  // App's env from every thread it starts (test/setup/no-live-remote.ts), so this one refuses too.
  const threaded = await startDaemonGitCredentialSocket({ ready: Promise.resolve(), stateDir: join(scratch, "threaded"), log });
  assert.ok(real && refusing && threaded, "all three sockets started");
  const cwd = join(scratch, "worktree");
  mkdirSync(cwd);
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  const env = isolatedGitEnv(scratch);
  try {
    // NO PATH: refused before any exchange, never answered with the installation-wide token.
    assert.equal(await socketRoundTrip(real.socketPath, "protocol=https\nhost=github.com\n\n"), "", "no path, no credential");
    assert.deepEqual(exchanges, [], "a request naming no owner/repo never reaches GitHub's token exchange");
    assert.ok(
      rows.some((r) => r.step === "boundary.request" && r.fields.decision === "refuse" && /owner\/repo/.test(String(r.fields.reason))),
      "the refusal is explicit and names why",
    );
    // The control: the same mint DOES exchange for a scoped request, and scopes it to that repo.
    assert.match(await socketRoundTrip(real.socketPath, "protocol=https\nhost=github.com\npath=acme/widgets.git\n\n"), /^password=/m);
    assert.deepEqual((exchanges[0] as { repositories?: string[] }).repositories, ["widgets"], "scoped to the one repo asked for");

    // A REFUSED MINT: git receives nothing to fill with.
    await spawnWorker({ ...spawnArgs(scratch, cwd, {}), secretBoundary: { credentialHelperSocketPath: refusing.socketPath } });
    await assert.rejects(credentialFill(cwd, env), /exited/, "git is left with no credential");
    assert.deepEqual(refusedFor, ["acme/widgets"], "the refused request was the scoped one, never widened to the host");
    assert.ok(rows.some((r) => r.fields.reason === "exchange rejected: 403"), "the mint's own refusal reason is ledgered");

    // THE DAEMON'S OWN GIT IS SYNCHRONOUS. A socket on the main thread would never answer this
    // blocked call; the threaded host does, so git returns — refused, nothing minted — not hung.
    execFileSync("git", ["-C", cwd, "config", "--worktree", "--unset-all", "credential.helper"]);
    await spawnWorker({ ...spawnArgs(scratch, cwd, {}), secretBoundary: { credentialHelperSocketPath: threaded.socketPath } });
    const before = rows.length;
    assert.throws(
      () => execFileSync("git", ["-C", cwd, "credential", "fill"], {
        env, input: "url=https://github.com/acme/widgets.git\n\n", timeout: 20_000, stdio: ["pipe", "pipe", "pipe"],
      }),
      (err: { status?: number | null; signal?: string | null }) => err.signal === null && err.status !== 0,
      "a blocked caller is answered promptly — refused, not hung",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      rows.slice(before).some((r) => r.step === "boundary.request" && r.fields.decision === "refuse"),
      "the threaded host answered and ledgered its refusal",
    );
    assert.equal(rows.filter((r) => r.fields.status === "minted").length, 1, "only the scoped control ever minted");
  } finally {
    await real.close();
    await refusing.close();
    await threaded.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the production socket mint adapter returns only the scoped exchange result", async () => {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const mint = realScopedMint((step, fields) => rows.push({ step, fields }), async (repo, ttlMs, opts) => {
    assert.equal(repo, "acme/widgets");
    assert.equal(ttlMs, 10 * 60_000);
    opts?.log?.("github_app.scoped_token_minted", { repo });
    return { ok: true, token: "SCOPED-ONLY" };
  });
  assert.deepEqual(await mint("acme/widgets"), { ok: true, token: "SCOPED-ONLY" });
  assert.deepEqual(rows, [{ step: "github_app.scoped_token_minted", fields: { repo: "acme/widgets" } }]);
});

test("a failed daemon socket ledger write stays visible and does not kill the socket", async () => {
  const stateDir = scratchDir("ledger-failure");
  const originalWrite = process.stderr.write;
  const stderr: string[] = [];
  process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let socket: Awaited<ReturnType<typeof startDaemonGitCredentialSocket>>;
  try {
    socket = await startDaemonGitCredentialSocket({ ready: Promise.resolve(), stateDir, log: () => { throw new Error("ledger unavailable"); } });
    assert.ok(socket);
    assert.equal(await socketRoundTrip(socket.socketPath, "protocol=https\nhost=github.com\npath=acme/widgets.git\n\n"), "");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(stderr.some((line) => line.includes("ledger write failed: Error: ledger unavailable")));
  } finally {
    await socket?.close();
    process.stderr.write = originalWrite;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a thread that cannot bind reports startup failure and leaves no worker socket", async () => {
  const stateDir = scratchDir("bind-failure");
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  // A non-empty directory holds the socket's name: the thread can neither clear nor bind it.
  const socketPath = daemonGitCredentialSocketPath(stateDir);
  mkdirSync(join(socketPath, "occupied"), { recursive: true });
  try {
    const socket = await startDaemonGitCredentialSocket({
      ready: Promise.resolve(), stateDir, log: (step, fields) => rows.push({ step, fields }),
    });
    assert.equal(socket, undefined);
    assert.ok(rows.some((row) => row.step === "boundary.request" && String(row.fields.reason).includes("did not start")));
    assert.equal(statSync(socketPath).isSocket(), false, "no socket was left at the path");
  } finally {
    rmSync(dirname(socketPath), { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a state dir too deep for a unix socket path binds the daemon's git credential socket in a short owned /tmp dir", async () => {
  // Built under /tmp, so it is past sun_path's limit (104 bytes on macOS, 108 on Linux) on every host.
  const holder = mkdtempSync(join("/tmp", `${RMD_TMP_PREFIX}gc-deep-`));
  const stateDir = join(holder, "x".repeat(110), "state");
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const socket = await startDaemonGitCredentialSocket({
    ready: Promise.resolve(), stateDir, log: (step, fields) => rows.push({ step, fields }),
    mint: async () => ({ ok: true, token: "scoped-token-deep" }),
  });
  try {
    assert.ok(socket, `the socket started: ${JSON.stringify(rows)}`);
    assert.ok(Buffer.byteLength(socket.socketPath) < 104, `the path fits sun_path: ${socket.socketPath}`);
    assert.equal(dirname(dirname(socket.socketPath)), realpathSync("/tmp"), "it binds under the short /tmp root");
    assert.equal(socket.socketPath, daemonGitCredentialSocketPath(stateDir), "the path is the one the daemon names");
    const dir = lstatSync(dirname(socket.socketPath));
    assert.ok(dir.isDirectory() && (dir.mode & 0o777) === 0o700, "a private directory, not a link");
    assert.match(await socketRoundTrip(socket.socketPath, "protocol=https\nhost=github.com\npath=acme/widgets.git\n\n"), /^password=scoped-token-deep$/m);
  } finally {
    await socket?.close();
    rmSync(holder, { recursive: true, force: true });
  }
  assert.equal(existsSync(dirname(socket!.socketPath)), false, "closing removes the short dir as well as the socket");
});

test("a daemon socket thread's failed message refuses startup and removes its socket path", async () => {
  const stateDir = scratchDir("thread-failed-message");
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const threadUrl = new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort } from "node:worker_threads";
    parentPort.postMessage({ type: "failed", reason: "fixture bind refused" });
    setInterval(() => {}, 1000);
  `)}`);
  try {
    const socket = await startDaemonGitCredentialSocket({
      ready: Promise.resolve(), stateDir, threadUrl, log: (step, fields) => rows.push({ step, fields }),
    });
    assert.equal(socket, undefined);
    assert.ok(rows.some((row) => row.step === "boundary.request" &&
      String(row.fields.reason).includes("git credential socket did not start: Error: fixture bind refused")));
    assert.equal(existsSync(daemonGitCredentialSocketPath(stateDir)), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a startup failure also reports a failed socket cleanup", async () => {
  const stateDir = scratchDir("close-failure");
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  try {
    const socket = await startDaemonGitCredentialSocket({
      ready: Promise.resolve(), stateDir, log: (step, fields) => rows.push({ step, fields }),
      mint: async () => ({ ok: false, reason: "unused" }),
      socketStarter: async ({ socketPath }) => ({ socketPath, close: async () => { throw new Error("close unavailable"); } }),
    });
    assert.equal(socket, undefined);
    assert.ok(rows.some((row) => String(row.fields.reason).includes("git credential socket did not start")));
    assert.ok(rows.some((row) => String(row.fields.reason).includes("socket did not close: Error: close unavailable")));
  } finally {
    rmSync(dirname(daemonGitCredentialSocketPath(stateDir)), { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── (7) normal shutdown closes the socket and removes its path ──────────────────────────────────

test("the daemon git credential socket is removed on shutdown", async () => {
  const seen = await driveDaemon(true);
  assert.equal(seen.code, 0);
  assert.equal(seen.duringLoop?.exists, true, "the control: the socket existed while the daemon ran");
  assert.equal(existsSync(seen.socketPath), false, "after a normal stop the path is gone");

  // A STALE PATH from a killed process is removed by the start routine itself before it binds.
  const stateDir = scratchDir("stale");
  const stale = daemonGitCredentialSocketPath(stateDir);
  mkdirSync(join(stale, ".."), { recursive: true });
  writeFileSync(stale, "left behind by a killed daemon");
  const socket = await startDaemonGitCredentialSocket({ ready: Promise.resolve(), stateDir, log: () => {}, mint: async () => ({ ok: false, reason: "unused" }) });
  assert.ok(socket, "a stale path does not stop the next start");
  assert.equal(statSync(stale).isSocket(), true);
  await socket.close();
  assert.equal(existsSync(stale), false);
  rmSync(stateDir, { recursive: true, force: true });
});

test("the daemon records socket cleanup failure on normal shutdown", async () => {
  const seen = await driveDaemon(true, true);
  assert.equal(seen.code, 0);
  assert.ok(seen.cleanupErrors.some((line) => line.includes("git credential socket did not close")));
});
