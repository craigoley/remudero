import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12516: the Codex capacity probe thread used a bare `--import tsx` preload, which Node resolves
// from the PROCESS cwd. A worker dispatched into a target checkout without tsx (CONSOLE-T172) then died
// before PR open with "Cannot find package 'tsx'". Each child below is a REAL node process: it loads the
// harness through the harness's own installed loader, runs the default off-thread probe (no fake
// workerFactory, thread or capacity answer) and a real spawnCodexWorker launch through spawnWorker.

/** The harness's installed tsx entry, resolved from Core's package — never from the target. */
const HARNESS_LOADER = pathToFileURL(createRequire(join(REPO_ROOT, "package.json")).resolve("tsx")).href;
const CHILD_DEADLINE_MS = 60_000;
const OUTPUT_TAIL_CHARS = 8_192;
const LIMITS = {
  rateLimits: { limitId: "codex", primary: { usedPercent: 20 } },
  rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 20 } } },
};

/** Every Codex id the committed ladder names, so selection resolves exactly as production would. */
function ladderModels(): Array<Record<string, unknown>> {
  const ladder = loadMounts(mountsPath(REPO_ROOT)).capabilities;
  assert.ok(ladder, "positive control: Core's mounts carry a capability ladder");
  const ids = new Set<string>();
  for (const efforts of Object.values(ladder.codex)) for (const list of Object.values(efforts)) for (const id of list) ids.add(id);
  assert.ok(ids.size > 0, "positive control: the ladder names at least one Codex model");
  return [...ids].sort().map((id) => ({
    id, model: id, displayName: id, defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort })),
  }));
}

/** A deterministic stand-in for the Codex CLI: `app-server` answers the three RPCs; `exec` records its launch. */
function codexStub(path: string, log: string, models: Array<Record<string, unknown>>): void {
  writeFileSync(path, `#!${process.execPath}
const { appendFileSync } = require("node:fs");
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
        : request.id === 3 ? { data: ${JSON.stringify(models)}, nextCursor: null } : undefined;
      if (result !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
    }
  });
} else {
  record({ mode, argv: process.argv.slice(2) });
  process.stdin.on("data", (chunk) => { input += chunk.toString("utf8"); });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "stub launch done" } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + "\\n");
  });
}
`);
  chmodSync(path, 0o755);
}

/** The driver each isolated child evaluates: two default off-thread reads, caches cleared before each. */
const CHILD_DRIVER = `
const fixture = JSON.parse(process.env.RMD_CODEX_BOOTSTRAP_FIXTURE);
const provider = await import(fixture.workerProviderUrl);
const { spawnWorker } = await import(fixture.workerUrl);
const config = { claudeBin: "/unused/claude", root: fixture.stateRoot,
  workerProviders: { enabled: ["codex"], codexBin: fixture.codexBin, codexHome: fixture.codexHome, capacityCacheMs: 60000 } };
provider.clearCodexCapacityCache();
const read = await provider.readCodexCapacity(config, { timeoutMs: 8000 });
provider.clearCodexCapacityCache();
let launch;
try {
  const result = await spawnWorker({ cwd: process.cwd(), prompt: "report the stub", settingsFile: fixture.settingsFile,
    tools: ["Read", "Grep", "Glob"], maxTurns: 1, config });
  launch = { provider: result.provider, text: result.text, isError: result.isError, routedModel: result.routedModel };
} catch (error) {
  launch = { error: String(error && error.stack || error).slice(0, 2000) };
}
process.stdout.write("RESULT " + JSON.stringify({ cwd: process.cwd(),
  capacity: { readable: read.readable, model: read.model, detail: read.detail ?? null }, launch }) + "\\n");
`;

interface ChildRun { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function runIsolatedChild(cwd: string, fixture: Record<string, string>, home: string, privateTmp: string): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    // A whitelisted environment: no NODE_OPTIONS/NODE_PATH preload and no test-runner context. The
    // child strips NODE_TEST_CONTEXT, so its coverage session is blanked rather than deleted.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, LANG: process.env.LANG, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
      HOME: home, TMPDIR: privateTmp, RMD_TEST_SLOT_DIR: join(privateTmp, "test-slots"),
      RMD_CODEX_BOOTSTRAP_FIXTURE: JSON.stringify(fixture),
      NODE_V8_COVERAGE: undefined,
    };
    const child = spawn(process.execPath, ["--import", HARNESS_LOADER, "--input-type=module", "--eval", CHILD_DRIVER],
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
  assert.ok(relative(REPO_ROOT, target).startsWith("..") || isAbsolute(relative(REPO_ROOT, target)),
    `${when}: the target sits outside Core's tree`);
  assert.equal(ancestorResolvesTsx(target), undefined, `${when}: no ancestor of the target resolves tsx`);
  assert.equal(existsSync(join(target, "node_modules")), false, `${when}: the target has no node_modules`);
  assert.equal(existsSync(join(target, "package.json")), false, `${when}: the target declares no dependency`);
}

async function launchFrom(label: "target" | "core", cwdFor: (target: string) => string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `rmd-codex-bootstrap-${label}-`)));
  try {
    const target = join(root, "target"), cli = join(root, "cli"), stateRoot = join(root, "state-root");
    const home = join(root, "home"), privateTmp = join(root, "tmp"), codexHome = join(root, "codex-home");
    for (const dir of [target, cli, stateRoot, home, privateTmp, codexHome]) mkdirSync(dir, { recursive: true });
    const log = join(cli, "calls.ndjson"), codexBin = join(cli, "codex");
    codexStub(codexBin, log, ladderModels());
    assertTargetCarriesNoLoader(target, "before");
    const cwd = cwdFor(target);
    const run = await runIsolatedChild(cwd, {
      workerProviderUrl: pathToFileURL(join(REPO_ROOT, "src", "lib", "worker-provider.ts")).href,
      workerUrl: pathToFileURL(join(REPO_ROOT, "src", "lib", "worker.ts")).href,
      settingsFile: join(REPO_ROOT, "settings", "worker.json"),
      stateRoot, codexBin, codexHome,
    }, home, privateTmp);
    assertTargetCarriesNoLoader(target, "after");
    assert.deepEqual(readdirSync(target), [], "the launch installed, linked or copied nothing into the target");
    const evidence = `exit=${run.code} signal=${run.signal}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
    assert.equal(run.code, 0, `the isolated ${label} child exits 0\n${evidence}`);
    const line = run.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
    assert.ok(line, `the ${label} child reports a result\n${evidence}`);
    const result = JSON.parse(line.slice("RESULT ".length)) as {
      cwd: string; capacity: { readable: boolean; model?: string; detail: string | null };
      launch: { provider?: string; text?: string; isError?: boolean; routedModel?: string; error?: string };
    };
    const calls = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").map((entry) => JSON.parse(entry) as { mode: string; method?: string; argv?: string[]; cwd: string })
      : [];
    return { cwd, result, calls, evidence };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertUsableCapacityAndLaunch(run: Awaited<ReturnType<typeof launchFrom>>): string {
  const { cwd, result, calls, evidence } = run;
  assert.equal(result.cwd, cwd, "the child ran in the cwd it was given");
  assert.doesNotMatch(result.capacity.detail ?? "", /tsx|worker error|failed to start/i, evidence);
  assert.equal(result.capacity.readable, true, `the real off-thread probe reads usable capacity: ${result.capacity.detail}\n${evidence}`);
  assert.ok(result.capacity.model, "the probe selected a Codex model");
  const appServerInits = calls.filter((call) => call.mode === "app-server" && call.method === "initialize");
  // The direct read and spawnWorker's routing read each follow a cache clear; the launch's attribution
  // re-reads may add sessions, so the floor is two and every session completes all three RPCs.
  assert.ok(appServerInits.length >= 2, `each cleared-cache read launched its own probe thread\n${evidence}`);
  for (const method of ["account/rateLimits/read", "model/list"]) {
    assert.equal(calls.filter((call) => call.method === method).length, appServerInits.length, `the stub answered ${method} in every session`);
  }
  for (const call of calls.filter((entry) => entry.mode === "app-server")) {
    assert.equal(call.cwd, cwd, "the probe thread's app-server kept the caller's cwd");
  }
  assert.equal(result.launch.error, undefined, `spawnWorker launched Codex: ${result.launch.error}`);
  assert.equal(result.launch.provider, "codex");
  assert.equal(result.launch.isError, false);
  assert.equal(result.launch.text, "stub launch done");
  const execs = calls.filter((call) => call.mode === "exec");
  assert.equal(execs.length, 1, "exactly one Codex worker launch");
  assert.equal(execs[0]!.cwd, cwd, "the Codex worker ran in the caller's cwd");
  const argv = execs[0]!.argv!;
  assert.equal(argv[argv.indexOf("-C") + 1], cwd, "the Codex worker was pointed at the caller's cwd with -C");
  assert.equal(argv[argv.indexOf("--model") + 1], result.launch.routedModel, "the launch ran the routed model");
  return result.capacity.model!;
}

// The Core control runs once, in its own isolated child; both tests compare against that one reading.
let coreModel: Promise<string> | undefined;
const coreControl = (): Promise<string> => coreModel ??= launchFrom("core", () => REPO_ROOT).then(assertUsableCapacityAndLaunch);
const TIMEOUT = { timeout: 2 * CHILD_DEADLINE_MS + 30_000 };

test("the Core-cwd positive control reads Codex capacity and launches a Codex worker in Core", TIMEOUT, async () => {
  assert.ok(await coreControl());
});

test("the real Codex probe and CLI-backed worker start from a target without tsx and keep the target cwd", TIMEOUT, async () => {
  const targetModel = assertUsableCapacityAndLaunch(await launchFrom("target", (target) => target));
  assert.equal(targetModel, await coreControl(), "the target and Core children make the same selection from the same response");
});
