import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { codexCandidatesForCapability } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12517: `rmd plan` run from a TARGET repository that carries no tsx. The Codex capacity probe used to
// preload a bare `tsx`, which Node resolves from the process cwd (CONSOLE-T172); W1-T12516 resolves it from
// the CLI installation. Each run below is a REAL node process running src/run-task.ts's real `plan` verb
// under the harness's own tsx loader: the real planCommand, the real spawnWorker and the real default Codex
// probe. Only the Codex CLI itself (a deterministic app-server/exec stub), `gh` and the network are local.
// bin/rmd execs the tsx CLI, which opens a unix-socket IPC pipe the worker sandbox refuses (EPERM), so the
// children use `node --import <tsx> src/run-task.ts` — the same entry past the shell wrapper.

const HARNESS_LOADER = pathToFileURL(createRequire(join(REPO_ROOT, "package.json")).resolve("tsx")).href;
const CHILD_DEADLINE_MS = 120_000;
const OUTPUT_TAIL_CHARS = 16_384;
const BRIEF = "check that retries are covered";
const SEED_ID = "W1-T10";
const SEED_PLAN = `version: 1\ntasks:\n  - id: ${SEED_ID}\n    title: seeded target task\n    repo: target\n    type: implement\n    status: queued\n`;
const LIMITS = {
  rateLimits: { limitId: "codex", primary: { usedPercent: 20 } },
  rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 20 } } },
};

/** The stub offers exactly the mounts table's Codex candidates for the Architect's frontier capability, so
 *  the successful handshake decides which model the launch must carry. */
function stubModels() {
  const ids = codexCandidatesForCapability(loadMounts(mountsPath(REPO_ROOT)).capabilities, "frontier", "high");
  assert.ok(ids.length > 0, "positive control: the ladder names at least one Codex model for the Architect");
  return ids.map((id) => ({
    id, displayName: id, defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })),
  }));
}

/** A deterministic Codex CLI. `app-server` answers the three probe RPCs; `exec` records what the Architect
 *  was launched with (argv, cwd, prompt and the plan/mount files it can see) and answers CLEAR. */
function codexStub(path: string, log: string): void {
  writeFileSync(path, `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const log = ${JSON.stringify(log)};
const record = (entry) => appendFileSync(log, JSON.stringify({ ...entry, cwd: process.cwd() }) + "\\n");
const mode = process.argv[2];
let input = "";
if (mode === "app-server") {
  process.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
    for (let newline = input.indexOf("\\n"); newline >= 0; newline = input.indexOf("\\n")) {
      const request = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      record({ mode, method: request.method });
      const result = request.id === 1 ? {} : request.id === 2 ? ${JSON.stringify(LIMITS)}
        : request.id === 3 ? { data: ${JSON.stringify(stubModels())}, nextCursor: null } : undefined;
      if (result !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
    }
  });
} else {
  process.stdin.on("data", (chunk) => { input += chunk.toString("utf8"); });
  process.stdin.on("end", () => {
    record({ mode, argv: process.argv.slice(2), prompt: input,
      plan: existsSync("plan/tasks.yaml") ? readFileSync("plan/tasks.yaml", "utf8") : null,
      mounts: existsSync(".remudero/mounts.yaml"), nodeModules: existsSync("node_modules") });
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "CLEAR: already covered by ${SEED_ID}" } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + "\\n");
  });
}
`);
  chmodSync(path, 0o755);
}

/** `gh` stand-in: records every call and answers an empty list, so nothing reaches GitHub. */
function ghStub(path: string, log: string): void {
  writeFileSync(path, `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("[]\\n");
`);
  chmodSync(path, 0o755);
}

const GIT_IDENTITY = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...GIT_IDENTITY } });

interface ChildRun { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", HARNESS_LOADER, join(REPO_ROOT, "src", "run-task.ts"), ...args],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL_CHARS); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL_CHARS); });
    const deadline = setTimeout(() => child.kill("SIGKILL"), CHILD_DEADLINE_MS);
    child.once("error", (error) => { clearTimeout(deadline); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(deadline); resolve({ code, signal, stdout, stderr }); });
  });
}

/** True when `dir` or any ancestor can satisfy a bare `tsx` import. */
function ancestorResolvesTsx(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, "node_modules", "tsx"))) return at;
    if (dirname(at) === at) return undefined;
  }
}

function assertTargetCarriesNoLoader(target: string, when: string): void {
  const rel = relative(REPO_ROOT, target);
  assert.ok(rel.startsWith("..") || isAbsolute(rel), `${when}: the target sits outside Core's tree`);
  assert.equal(ancestorResolvesTsx(target), undefined, `${when}: no ancestor of the target resolves tsx`);
  assert.equal(existsSync(join(target, "node_modules")), false, `${when}: the target has no node_modules`);
  assert.equal(existsSync(join(target, "package.json")), false, `${when}: the target declares no dependency`);
}

interface StubCall { mode: string; method?: string; argv?: string[]; prompt?: string; plan?: string | null; mounts?: boolean; nodeModules?: boolean; cwd: string }
interface LedgerRow { step?: string; [key: string]: unknown }

/** One `rmd plan` run in its own disposable fixture: a target repository (own plan, own mounts, a local
 *  bare origin named owner/target) and an isolated state root, from `cwdFor(target)`. */
async function planFrom(label: "target" | "core", mode: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `rmd-plan-${label}-`)));
  try {
    const bare = join(root, "origin", "owner", "target.git"), target = join(root, "target");
    const home = join(root, "home"), state = join(root, "state-root"), cli = join(root, "cli"), codexHome = join(root, "codex-home"), privateTmp = join(root, "tmp");
    for (const dir of [bare, home, state, cli, codexHome, privateTmp, join(home, ".config", "remudero")]) mkdirSync(dir, { recursive: true });
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(root, "clone", "-q", bare, target);
    mkdirSync(join(target, "plan"), { recursive: true });
    mkdirSync(join(target, ".remudero"));
    cpSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), join(target, ".remudero", "mounts.yaml"));
    writeFileSync(join(target, "plan", "tasks.yaml"), SEED_PLAN);
    git(target, "add", "-A");
    git(target, "commit", "-qm", "seed the target plan");
    git(target, "push", "-q", "origin", "HEAD:main");
    git(root, "clone", "-q", bare, join(state, "repos", "target")); // the managed clone, so nothing is fetched from GitHub
    const calls = join(cli, "calls.ndjson"), ghLog = join(cli, "gh.ndjson"), codexBin = join(cli, "codex");
    codexStub(codexBin, calls);
    mkdirSync(join(cli, "bin"));
    ghStub(join(cli, "bin", "gh"), ghLog);
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({
      claudeBin: join(cli, "no-claude-in-this-fixture"), root: state, installRoot: REPO_ROOT,
      workerProviders: { enabled: ["codex"], codexBin, codexHome, capacityCacheMs: 60_000 },
    }));
    assertTargetCarriesNoLoader(target, "before");
    const planBefore = readFileSync(join(target, "plan", "tasks.yaml"), "utf8");
    const headBefore = git(target, "rev-parse", "HEAD").trim();
    const remoteBefore = git(root, "--git-dir", bare, "for-each-ref", "--format=%(refname) %(objectname)").trim();
    // Whitelisted environment: no NODE_OPTIONS/NODE_PATH preload and no test-runner context, and the
    // coverage session is blanked rather than deleted so the child never inherits the runner's.
    const env: NodeJS.ProcessEnv = {
      PATH: `${join(cli, "bin")}:${process.env.PATH}`, LANG: process.env.LANG, HOME: home, TMPDIR: privateTmp,
      RMD_TEST_SLOT_DIR: join(privateTmp, "test-slots"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      ...GIT_IDENTITY, NODE_V8_COVERAGE: undefined,
    };
    // Target: the process stands in the target checkout. Core control: the same verb from Core's own cwd,
    // pointed at the very same target by the global --repo-root flag.
    const cwd = label === "target" ? target : REPO_ROOT;
    const args = label === "target" ? ["plan", `--mode=${mode}`, BRIEF] : ["plan", "--repo-root", target, `--mode=${mode}`, BRIEF];
    const run = await runCli(cwd, args, env);
    assertTargetCarriesNoLoader(target, "after");
    const evidence = `exit=${run.code} signal=${run.signal}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
    const read = <T>(path: string): T[] => existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];
    return {
      run, evidence, cwd, target, state,
      calls: read<StubCall>(calls), gh: read<string[]>(ghLog), ledger: read<LedgerRow>(join(state, "state", "ledger.ndjson")),
      planBefore, planAfter: readFileSync(join(target, "plan", "tasks.yaml"), "utf8"),
      headBefore, headAfter: git(target, "rev-parse", "HEAD").trim(),
      status: git(target, "status", "--porcelain").trim(), targetEntries: readdirSync(target).sort(),
      remoteBefore, remoteAfter: git(root, "--git-dir", bare, "for-each-ref", "--format=%(refname) %(objectname)").trim(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type PlanRun = Awaited<ReturnType<typeof planFrom>>;

/** Everything a CLEAR run through a real Architect launch must show, whichever cwd the verb stood in. */
function assertReachedArchitect(run: PlanRun, label: string): string {
  const { evidence, calls, ledger } = run;
  assert.equal(run.run.code, 0, `the ${label} verb exits 0\n${evidence}`);
  assert.doesNotMatch(run.run.stderr, /Cannot find package 'tsx'|ERR_MODULE_NOT_FOUND/, `the ${label} child hit no missing-loader error\n${evidence}`);
  assert.match(run.run.stdout, new RegExp(`--mode=clarify: CLEAR — already covered by ${SEED_ID}`), `the ${label} Architect's verdict was read\n${evidence}`);
  // The stub handshake succeeded: the real probe thread ran every RPC from the caller's cwd.
  const inits = calls.filter((call) => call.mode === "app-server" && call.method === "initialize");
  assert.ok(inits.length >= 1, `the ${label} probe thread started a Codex app-server\n${evidence}`);
  for (const method of ["account/rateLimits/read", "model/list"]) {
    assert.ok(calls.filter((call) => call.method === method).length >= 1, `the ${label} stub answered ${method}`);
  }
  for (const call of calls.filter((entry) => entry.mode === "app-server")) assert.equal(call.cwd, run.cwd, `the ${label} probe kept the caller's cwd`);
  const execs = calls.filter((call) => call.mode === "exec");
  assert.equal(execs.length, 1, `exactly one Architect launch in the ${label} run\n${evidence}`);
  const architect = execs[0]!;
  const argv = architect.argv!;
  const worktree = argv[argv.indexOf("-C") + 1]!;
  assert.equal(architect.cwd, worktree, "the Architect ran in the cwd it was pointed at");
  assert.match(relative(run.state, worktree), /^worktrees[\\/]run-PLAN-clarify-\d+$/, "the Architect worktree is the target's plan lane under the isolated state root");
  // Target context survives: the Architect saw the TARGET's plan and mounts, not Core's.
  assert.equal(architect.plan, SEED_PLAN, `the ${label} Architect read the target's own plan`);
  assert.equal(architect.mounts, true, `the ${label} Architect worktree carries the target's mounts`);
  assert.ok(architect.prompt!.includes(BRIEF), "the brief reached the Architect");
  const minted = ledger.find((row) => row.step === "plan.id_minted");
  assert.ok(minted, "the reservation was ledgered");
  const reserved = minted.reserved as string[];
  assert.ok(reserved.length > 0 && reserved.every((id) => architect.prompt!.includes(id)), "every reserved id reached the Architect");
  assert.ok(!reserved.includes(SEED_ID), "the reserved ids continue the target's plan");
  const model = argv[argv.indexOf("--model") + 1]!;
  assert.ok(stubModels().some((m) => m.id === model), `the Architect ran a model the stub offered: ${model}`);
  // A deterministic CLEAR leaves nothing behind: no edit, no commit, no branch, no PR, no dependency.
  assert.equal(run.planAfter, run.planBefore, "the target plan is unchanged");
  assert.equal(run.headAfter, run.headBefore, "the target head is unchanged");
  assert.equal(run.status, "", "the target working tree is clean");
  assert.deepEqual(run.targetEntries, [".git", ".remudero", "plan"], "nothing was installed or linked into the target");
  assert.equal(run.remoteAfter, run.remoteBefore, "no branch or ref was left on the target's origin");
  assert.deepEqual(run.gh.filter((call) => call[0] === "pr"), [], "no gh pr call was made");
  assert.equal(ledger.some((row) => row.step === "pr.opened"), false, "no PR was recorded");
  const verdict = ledger.find((row) => row.step === "plan.verdict");
  assert.equal(verdict?.action, "no_action");
  const start = ledger.find((row) => row.step === "plan.start");
  assert.equal(start?.mode, "clarify");
  return model;
}

// The Core control runs once; the target test compares against its one reading.
let core: Promise<PlanRun> | undefined;
const coreControl = (): Promise<PlanRun> => core ??= planFrom("core", "clarify");
const TIMEOUT = { timeout: 2 * CHILD_DEADLINE_MS + 30_000 };

test("W1-T12517 Core-context control reaches the architect", TIMEOUT, async () => {
  const control = await coreControl();
  assert.equal(control.cwd, REPO_ROOT, "the control stood in Core's own cwd");
  assert.ok(assertReachedArchitect(control, "core"));
});

test("W1-T12517 target without tsx reaches its architect", TIMEOUT, async () => {
  const target = await planFrom("target", "clarify");
  assert.notEqual(target.cwd, REPO_ROOT);
  const targetModel = assertReachedArchitect(target, "target");
  const control = await coreControl();
  assert.equal(targetModel, assertReachedArchitect(control, "core"), "the target and Core runs make the same selection from the same stub");
  assert.equal(target.calls.filter((call) => call.mode === "exec").length, control.calls.filter((call) => call.mode === "exec").length);
});
