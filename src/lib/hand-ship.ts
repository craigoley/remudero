import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { systemClock } from "./clock.js";
import { acquireDrainLock, defaultIsPidAlive, DrainLockError } from "./drain-lock.js";
import { gitPushRunBranchAsync, worktreePushExecAsync } from "./git-push.js";
import { ghJsonAsync } from "./github-transport.js";
import { parseOwnerRepoFromRemoteUrl } from "./onboard/inventory.js";
import { acceptanceBlockDiagnostics } from "./review.js";
import { proofTestRunnerArgs } from "./test-run-timeout.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

interface ShipHost {
  name: string;
  target: string;
  kind: "mac" | "linux";
  checkout?: string;
  pathPrefix?: string;
}

interface ShipSource { root: string; branch: string; head: string; origin: string }
interface FailingTest { file: string | null; title: string }
type Priority = "low" | "normal";
type FailureClass = "caused by the change" | "caused by the host" | "also failing on main";

export interface ShipReceipt {
  headSha: string;
  baseSha: string;
  verdict: string;
  selection?: string;
  steps: { name: string; ok: boolean; failedCheck?: string; signal?: string | null; error?: unknown;
    judge?: { given: number; reported: number }; diagnostics?: { mayBeIncomplete: boolean };
    testSummary?: { pass: number; fail: number; cancelled: number } }[];
  failureAttribution?: { tests?: FailingTest[] };
}

interface AuthorTools {
  authorEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  authorPushEligibility(receipt: ShipReceipt): { pushEligible: boolean; pushEligibleReason: string };
  failingTestsFromTap(output: string, root: string): FailingTest[];
  testSummary(output: string): { pass: number; fail: number; cancelled: number } | null;
}

const authorEntry = "scripts/preflight-author.mjs";

async function authorTools(): Promise<AuthorTools> {
  const installedEntry = new URL(authorEntry, new URL("../../", import.meta.url));
  return import(installedEntry.href);
}

async function readMacPressure(raw: string): Promise<string> {
  // @ts-expect-error The author host admission .mjs module has no declaration file.
  const { macPressureState } = await import("../../scripts/lib/mac-author-admission.mjs");
  return macPressureState(raw);
}

interface ShipRun {
  dir: string;
  signal: AbortSignal;
  log: (line: string) => void;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export interface HandShipEffects {
  readHost(host: ShipHost, run: ShipRun): Promise<string>;
  readSource(cwd: string, run: ShipRun): Promise<ShipSource>;
  prepare(host: ShipHost, source: ShipSource, run: ShipRun): Promise<{
    preflight(priority: Priority): Promise<ShipReceipt>;
    rerun(tree: "head" | "main", file: string, sha: string): Promise<string[]>;
    close(): Promise<void>;
  }>;
  push(source: ShipSource, run: ShipRun): Promise<void>;
  findPull(source: ShipSource): Promise<number | undefined>;
  publish(source: ShipSource, title: string, body: string, existing?: number): Promise<{ url: string; body: string }>;
  checkBody(body: string, run: ShipRun): void;
}

interface ShipOptions { cwd: string; stateDir: string | (() => string); write?: (line: string) => void }
const runId = /^rmd-ship-\d{13}-[a-zA-Z0-9]{6}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const testPath = /^test\/(?:[^/\0\r\n]+\/)*[^/\0\r\n]+\.test\.ts$/;
const INIT_WINDOW_MS = 2_000;

function readHosts(path: string): ShipHost[] {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data) || !data.length || data.some((host: Partial<ShipHost> | null) => !host ||
    typeof host.name !== "string" || !host.name.trim() || /[\r\n]/.test(host.name) ||
    typeof host.target !== "string" || !/^[a-zA-Z0-9_][\w.@:-]*$/.test(host.target) ||
    (host.kind !== "mac" && host.kind !== "linux") ||
    (host.target !== "local" && host.checkout === undefined) ||
    (host.checkout !== undefined && (typeof host.checkout !== "string" || !isAbsolute(host.checkout))) ||
    (host.pathPrefix !== undefined && (typeof host.pathPrefix !== "string" || !isAbsolute(host.pathPrefix))))) {
    throw new Error(`${path}: expected hosts with name, target (SSH or local), kind (mac or linux), and an absolute checkout for SSH`);
  }
  return data;
}

async function chooseHost(hosts: ShipHost[], effects: HandShipEffects, run: ShipRun): Promise<ShipHost> {
  for (const host of [...hosts.filter((item) => item.kind === "mac"), ...hosts.filter((item) => item.kind === "linux")]) {
    run.signal.throwIfAborted();
    let raw: string;
    try {
      raw = await effects.readHost(host, run);
    } catch (error) {
      run.signal.throwIfAborted();
      run.log(`${host.name}: reading unavailable (${(error as Error).message})`);
      continue;
    }
    const reading = host.kind === "mac" ? await readMacPressure(raw) : /^MemAvailable:[ \t]*(\d+ kB)[ \t]*$/m.exec(raw)?.[1];
    if (reading === "unknown" || reading === undefined) run.log(`${host.name}: unreadable memory reading`);
    else if (host.kind === "mac" && reading !== "normal") run.log(`${host.name}: memory pressure ${reading} (${raw.trim()})`);
    else {
      run.log(`selected ${host.name}: ${host.kind === "mac" ? `memory pressure ${reading} (${raw.trim()})` : `MemAvailable ${reading}`}`);
      return host;
    }
  }
  throw new Error("no configured host has a usable memory reading");
}

function testFailureStage(step: ShipReceipt["steps"][number]): boolean {
  return step.name === "affected-tests" || step.name === "affected-tests-subset";
}

function consumeFailure(failures: string[], title: string): boolean {
  const index = failures.indexOf(title);
  if (index < 0) return false;
  failures.splice(index, 1);
  return true;
}

async function compareFailures(receipt: ShipReceipt, workspace: Awaited<ReturnType<HandShipEffects["prepare"]>>, run: ShipRun) {
  const failed = receipt.steps.find((step) => !step.ok);
  if (!failed || !testFailureStage(failed)) {
    if (failed?.name === "static-preflight" && failed.failedCheck) run.log(`caused by the change: ${failed.failedCheck}`);
    return receipt;
  }
  const tests = receipt.failureAttribution?.tests ?? [];
  const summary = failed.testSummary;
  const withEvidence = { ...receipt, failureAttribution: undefined };
  if (failed.signal || failed.error || failed.diagnostics?.mayBeIncomplete !== false || !summary || summary.fail === 0 ||
    tests.length !== summary.fail || tests.some(({ file }) => !file || !testPath.test(file) ||
      file.split("/").some((part) => part === "." || part === ".."))) {
    run.log("test failure comparison unavailable: the preflight did not completely name its failures");
    return withEvidence;
  }
  const files = [...new Set(tests.map((test) => test.file!))].sort();
  const head = new Map<string, string[]>();
  const main = new Map<string, string[]>();
  for (const file of files) head.set(file, [...await workspace.rerun("head", file, receipt.headSha)]);
  for (const file of files) main.set(file, [...await workspace.rerun("main", file, receipt.baseSha)]);
  const rows = tests.map((test) => {
    const here = consumeFailure(head.get(test.file!)!, test.title);
    const there = here && consumeFailure(main.get(test.file!)!, test.title);
    const classification: FailureClass = !here ? "caused by the host" : there ? "also failing on main" : "caused by the change";
    run.log(`${classification}: ${test.file} :: ${test.title}`);
    return { ...test, state: here && there ? "also-red" : here ? "only-head" : "unattributed" };
  });
  return { ...withEvidence, failureAttribution: {
    // The installed judge calls the comparison SHA mergeBase. Here it is the exact main SHA run above.
    base: { mergeBase: receipt.baseSha }, tests: rows,
    counts: { failingAtHead: rows.length, alsoFailingAtBase: rows.filter((test) => test.state === "also-red").length,
      failingOnlyAtHead: rows.filter((test) => test.state === "only-head").length,
      unattributed: rows.filter((test) => test.state === "unattributed").length },
  } };
}

function queuedEarlier(queue: string, id: string): boolean {
  return readdirSync(queue).some((name) => {
    if (!runId.test(name) || name >= id) return false;
    const dir = join(queue, name);
    try {
      const pid = Number(readFileSync(join(dir, "queued"), "utf8"));
      if (pid > 0) return defaultIsPidAlive(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return !existsSync(join(dir, "status.json")) && systemClock.now() - statSync(dir).mtimeMs < INIT_WINDOW_MS;
  });
}

async function enterQueue(queue: string, id: string, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    if (!queuedEarlier(queue, id)) {
      try {
        return acquireDrainLock(join(queue, "preflight.lock"));
      } catch (error) {
        if (!(error instanceof DrainLockError)) throw error;
      }
    }
    await delay(250, undefined, { signal });
  }
}

function stopRun(queue: string, id: string, write: (line: string) => void): number {
  const dir = join(queue, id);
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  if (["shipped", "stopped", "failed"].includes(status.status) || !defaultIsPidAlive(status.pid)) {
    write(`${id}: no active run (${status.status})`);
    return 1;
  }
  writeFileSync(join(dir, "stop"), "stop requested\n", { mode: 0o600 });
  write(`${id}: stop requested`);
  return 0;
}

export async function runHandShip(args: string[], options: ShipOptions, effects: HandShipEffects): Promise<number> {
  const write = options.write ?? console.log;
  const stateDir = () => typeof options.stateDir === "function" ? options.stateDir() : options.stateDir;
  if (args[0] === "stop") {
    if (args.length !== 2 || !runId.test(args[1])) { write("usage: rmd hand-worktree ship stop <run-id>"); return 2; }
    try { return stopRun(join(stateDir(), "hand-ship"), args[1], write); }
    catch (error) {
      const reason = (error as Error).message;
      write(`${args[1]}: ${reason}`);
      return 1;
    }
  }
  let values;
  try {
    ({ values } = parseArgs({ args, options: { title: { type: "string" }, "body-file": { type: "string" } } }));
  } catch (error) {
    const reason = (error as Error).message;
    write(reason);
    return 2;
  }
  const title = values.title?.trim();
  if (!title || !values["body-file"]) {
    write("usage: rmd hand-worktree ship --title <title> --body-file <path>");
    return 2;
  }
  const body = readFileSync(resolve(options.cwd, values["body-file"]), "utf8");
  const state = stateDir();
  const hosts = readHosts(join(state, "hand-ship-hosts.json"));
  const queue = join(state, "hand-ship");
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(queue, `rmd-ship-${systemClock.now()}-`));
  const id = basename(dir);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("stop requested"));
  const checkStop = () => { if (existsSync(join(dir, "stop"))) stop(); };
  const run: ShipRun = { dir, signal: controller.signal, log: (line) => {
    appendFileSync(join(dir, "run.log"), `${line}\n`, { mode: 0o600 });
    write(`${id}: ${line}`);
  } };
  const status = (state: string, detail?: string) => {
    const data = JSON.stringify({ id, pid: process.pid, status: state, detail, at: systemClock.iso() }) + "\n";
    writeFileSync(join(dir, "status.next"), data, { mode: 0o600 });
    renameSync(join(dir, "status.next"), join(dir, "status.json"));
    appendFileSync(join(dir, "history.ndjson"), data, { mode: 0o600 });
  };
  writeFileSync(join(dir, "queued"), String(process.pid), { mode: 0o600 });
  status("queued");
  run.log(`queued (${dir})`);
  const watch = setInterval(checkStop, 100);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const continueRun = () => { checkStop(); run.signal.throwIfAborted(); };
  try {
    const source = await effects.readSource(options.cwd, run);
    const lock = await enterQueue(queue, id, run.signal);
    try {
      rmSync(join(dir, "queued"));
      const host = await chooseHost(hosts, effects, run);
      status("preflight", `${host.name} ${source.head}`);
      const workspace = await effects.prepare(host, source, run);
      try {
        const receipt = await workspace.preflight(host.kind === "mac" ? "low" : "normal");
        continueRun();
        if (receipt.headSha !== source.head || !shaPattern.test(receipt.baseSha)) throw new Error("receipt does not identify the requested head and main");
        const verified = await compareFailures(receipt, workspace, run);
        const decision = (await authorTools()).authorPushEligibility(verified);
        run.log(decision.pushEligibleReason);
        if (!decision.pushEligible) throw new Error("preflight withheld publication");
      } finally {
        await workspace.close();
      }
    } finally {
      lock.release();
    }
    continueRun();
    const existing = await effects.findPull(source);
    const block = acceptanceBlockDiagnostics(body);
    if (existing !== undefined && (block.defective || block.criteriaParsed === 0)) {
      throw new Error("an amendment pull request requires a valid Acceptance: block");
    }
    continueRun();
    status("publishing", source.branch);
    await effects.push(source, run);
    continueRun();
    const pr = await effects.publish(source, title, body, existing);
    run.log(`pull request ${pr.url}`);
    effects.checkBody(pr.body, run);
    status("shipped", pr.url);
    return 0;
  } catch (error) {
    const detail = (error as Error).message;
    status(run.signal.aborted ? "stopped" : "failed", detail);
    run.log(detail);
    return 1;
  } finally {
    rmSync(join(dir, "queued"), { force: true });
    clearInterval(watch);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

interface CommandResult { code: number | null; stdout: string; stderr: string; truncated: boolean }
interface ChildOptions { cwd?: string; input?: string; control?: boolean; capture?: boolean; record?: boolean;
  env?: NodeJS.ProcessEnv; signal?: AbortSignal }
const outputLimit = 32 * 1024 * 1024;

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

async function runChild(run: ShipRun, file: string, args: string[], opts: ChildOptions = {}): Promise<CommandResult> {
  const signal = opts.signal ?? run.signal;
  const env = opts.env ?? (await authorTools()).authorEnvironment(process.env);
  signal.throwIfAborted();
  return await new Promise((resolveChild, reject) => {
    const child = (run.spawn ?? spawn)(file, args, { cwd: opts.cwd, env, detached: true,
      stdio: [opts.input || opts.control ? "pipe" : "ignore", "pipe", "pipe"] });
    const buffers = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let length = 0;
    let truncated = false;
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]!.on("data", (chunk: Buffer) => {
        if (opts.record) {
          try { appendFileSync(join(run.dir, "commands.log"), chunk, { mode: 0o600 }); }
          catch (error) { recordError(error); }
        }
        if (opts.capture === false) return;
        length += chunk.length;
        if (length <= outputLimit) buffers[stream].push(chunk);
        else truncated = true;
      });
    }
    let force: NodeJS.Timeout | undefined;
    const abort = () => {
      if (child.pid === undefined || force !== undefined) return;
      const pid = child.pid;
      if (opts.control) child.stdin!.end();
      else signalGroup(pid, "SIGTERM");
      force = setTimeout(() => signalGroup(pid, "SIGKILL"), opts.control ? 10_000 : 2_000);
    };
    let failure: unknown;
    const recordError = (error: unknown) => { failure ??= error; abort(); };
    const input = opts.input ? createReadStream(opts.input) : undefined;
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      // A remote command can close stdin before it reports its exit; keep its actual exit status.
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") recordError(error);
    });
    input?.on("error", recordError);
    if (input) input.pipe(child.stdin!);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", recordError);
    child.on("close", (code) => {
      clearTimeout(force);
      signal.removeEventListener("abort", abort);
      input?.destroy();
      if (signal.aborted) reject(signal.reason);
      else if (failure !== undefined) reject(failure);
      else resolveChild({ code, stdout: Buffer.concat(buffers.stdout).toString("utf8"),
        stderr: Buffer.concat(buffers.stderr).toString("utf8"), truncated });
    });
  });
}

function checked(result: CommandResult, label: string): string {
  if (result.code !== 0 || result.truncated) throw new Error(`${label} failed (${result.code ?? "signal"})${result.stderr.trim() ? `: ${result.stderr.trim().slice(-500)}` : ""}`);
  return result.stdout;
}

const shellWord = (word: string) => "'" + word.replaceAll("'", "'\\''") + "'";
const shellCommand = (args: string[]) => args.map(shellWord).join(" ");

// Job control gives the checked command its own process group. The SSH client's stdin stays
// open for the run, and EOF cancels that group even if the local coordinator disappears.
const sshSupervise = 'set -m; exec 3<&0; (exec "$@") 3<&- </dev/null & child=$!; ' +
  '(IFS= read -r _ <&3; kill -TERM -- "-$child" 2>/dev/null; sleep 2; kill -KILL -- "-$child" 2>/dev/null) >/dev/null 2>&1 & watcher=$!; ' +
  'wait "$child"; result=$?; kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null; ' +
  'kill -KILL -- "-$child" 2>/dev/null; exit "$result"';
const launchInDir = 'if [ -n "$1" ]; then PATH="$1:$PATH"; export PATH; fi; ' +
  'if [ -n "$2" ]; then cd "$2" || exit; fi; shift 2; exec "$@"';

async function hostCommand(host: ShipHost, run: ShipRun, args: string[], opts: ChildOptions = {}): Promise<CommandResult> {
  if (host.target === "local") {
    const env = (await authorTools()).authorEnvironment(process.env);
    if (host.pathPrefix) env.PATH = `${host.pathPrefix}:${env.PATH ?? "/usr/bin:/bin"}`;
    return runChild(run, args[0], args.slice(1), { ...opts, env });
  }
  const command = ["bash", "-c", launchInDir, "hand-ship", host.pathPrefix ?? "", opts.cwd ?? "", ...args];
  const remote = opts.input ? command : ["bash", "-c", sshSupervise, "hand-ship", ...command];
  return runChild(run, "ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2", "--", host.target, shellCommand(remote)], { ...opts, cwd: undefined, control: !opts.input });
}

async function gitAt(run: ShipRun, cwd: string, args: string[]): Promise<string> {
  run.signal.throwIfAborted();
  const output = await hostWorktreeGitAsync(cwd, args);
  run.signal.throwIfAborted();
  return output.trim();
}

function githubRepo(url: string) {
  const repo = /^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[\w.-]+\/[\w.-]+$/.test(url)
    ? parseOwnerRepoFromRemoteUrl(url) : undefined;
  if (!repo) throw new Error("origin must point to a GitHub repository");
  return repo;
}

async function defaultSource(cwd: string, run: ShipRun): Promise<ShipSource> {
  const root = checked(await runChild(run, "git", ["rev-parse", "--show-toplevel"], { cwd }), "git show-toplevel").trim();
  const branch = (await gitAt(run, root, ["symbolic-ref", "HEAD"])).replace(/^refs\/heads\//, "");
  const head = await gitAt(run, root, ["rev-parse", "HEAD"]);
  if (branch === "main" || branch.startsWith("refs/") || !shaPattern.test(head)) throw new Error("check out a committed branch other than main");
  if (await gitAt(run, root, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error("commit or remove working tree changes before shipping");
  const origin = await gitAt(run, root, ["remote", "get-url", "origin"]);
  const pushOrigin = githubRepo(await gitAt(run, root, ["remote", "get-url", "--all", "--push", "origin"]));
  const fetchOrigin = githubRepo(origin);
  if (pushOrigin.owner !== fetchOrigin.owner || pushOrigin.repo !== fetchOrigin.repo) throw new Error("origin fetch and push name different repositories");
  return { root, branch, head, origin };
}

async function prepareWorkspace(host: ShipHost, source: ShipSource, run: ShipRun): ReturnType<HandShipEffects["prepare"]> {
  const command = async (args: string[], opts: ChildOptions = {}) => checked(await hostCommand(host, run, args, opts), args.slice(0, 2).join(" "));
  run.signal.throwIfAborted();
  const scratch = (await command(["mktemp", "-d", "/tmp/rmd-hand-ship.XXXXXXXX"], { signal: AbortSignal.timeout(30_000) })).trim();
  if (!/^\/tmp\/rmd-hand-ship\.[a-zA-Z0-9]{8}$/.test(scratch)) throw new Error("host returned an invalid temporary directory");
  const bundle = join(run.dir, "head.bundle");
  const donor = host.checkout ?? source.root;
  const close = async () => {
    rmSync(bundle, { force: true });
    if (host.target === "local") rmSync(scratch, { recursive: true, force: true });
    else await command(["rm", "-rf", "--", scratch], { signal: AbortSignal.timeout(30_000) });
  };
  try {
    // TAP reports real paths, including /private/tmp on macOS.
    const physical = (await command(["pwd", "-P"], { cwd: scratch })).trim();
    if (physical !== scratch && physical !== `/private${scratch}`) throw new Error("host temporary path could not be verified");
    const hostBundle = host.target === "local" ? bundle : join(physical, "head.bundle");
    const headDir = join(physical, "head");
    const mainDir = join(physical, "main");
    await gitAt(run, source.root, ["bundle", "create", bundle, "HEAD"]);
    if (host.target !== "local") await command(["sh", "-c", 'cat > "$1"', "hand-ship", hostBundle], { input: bundle });
    await command(["git", "clone", "--no-checkout", "--", hostBundle, headDir]);
    const git = (args: string[], opts: ChildOptions = {}) => command(["git", ...args], { cwd: headDir, ...opts });
    await git(["checkout", "--detach", source.head]);
    await git(["remote", "set-url", "origin", source.origin]);
    await command(["cmp", "-s", join(headDir, "package-lock.json"), join(donor, "package-lock.json")]);
    await command(["ln", "-s", join(donor, "node_modules"), join(headDir, "node_modules")]);
    let priority: Priority = "normal";
    const node = (args: string[]) => priority === "low" ? ["/usr/bin/nice", "-n", "10", "node", ...args] : ["node", ...args];
    let baseCut = false;
    return {
      async preflight(requested) {
        priority = requested;
        run.log(`running author preflight at ${priority} priority`);
        const result = await hostCommand(host, run, node(["--import", "tsx", authorEntry,
          "--head-ref", source.branch, "--head-sha", source.head]), { cwd: headDir, capture: false, record: true });
        if (result.code === null || result.code > 3) throw new Error(`author preflight did not finish (exit ${result.code ?? "signal"})`);
        const raw = await command(["cat", "coverage/preflight-author.json"], { cwd: headDir });
        writeFileSync(join(run.dir, "receipt.json"), raw, { mode: 0o600 });
        const receipt = JSON.parse(raw);
        if (receipt.version !== 1 || receipt.dryRun !== false || !Array.isArray(receipt.steps) ||
          receipt.publicationIdentity?.state !== "passed" || receipt.publicationIdentity?.headRef !== source.branch) {
          throw new Error(receipt.error ?? "author preflight did not issue a receipt for this branch");
        }
        return receipt;
      },
      async rerun(tree, file, sha) {
        run.log(`isolated rerun on ${tree} ${sha}: ${file}`);
        if (tree === "main" && !baseCut) {
          await git(["diff", "--quiet", source.head, sha, "--", "package-lock.json"]);
          await command(["git", "clone", "--shared", "--no-checkout", "--", headDir, mainDir]);
          await git(["checkout", "--detach", sha], { cwd: mainDir });
          await command(["ln", "-s", join(donor, "node_modules"), join(mainDir, "node_modules")]);
          baseCut = true;
        }
        const cwd = tree === "main" ? mainDir : headDir;
        if ((await git(["rev-parse", "HEAD"], { cwd })).trim() !== sha || (await git(["status", "--porcelain"], { cwd })).trim()) {
          throw new Error(`${tree} changed before the isolated rerun`);
        }
        const available = await hostCommand(host, run, ["test", "-f", file], { cwd });
        if (available.code === 1 && tree === "main") return [];
        checked(available, `${tree} test ${file}`);
        await command(["test", "!", "-L", file], { cwd });
        const args = proofTestRunnerArgs(["--test", "--test-reporter=tap", "--test-concurrency=1", "--import", "tsx",
          "--import", "./test/setup/tmp-hygiene.ts", file], source.root, [file]);
        const result = await hostCommand(host, run, node(args), { cwd, record: true });
        const { testSummary, failingTestsFromTap } = await authorTools();
        const summary = testSummary(result.stdout);
        const failures = failingTestsFromTap(result.stdout, cwd);
        if (result.truncated || !summary || summary.cancelled !== 0 ||
          (result.code !== 0 && result.code !== 1) || failures.length !== summary.fail ||
          (result.code === 0 ? summary.pass === 0 || summary.fail !== 0 : summary.fail === 0) ||
          failures.some((failure) => failure.file !== file)) throw new Error(`${tree} ${file}: isolated rerun had no complete test result`);
        return failures.map(({ title }) => title);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

interface PullResponse { number: number; html_url: string; body: string }
const pullEndpoint = (source: ShipSource) => {
  const { owner, repo } = githubRepo(source.origin);
  return { owner, path: `repos/${owner}/${repo}/pulls` };
};

export function handShipEffects(checkAcceptance: (bodyFile: string) => number,
  github: (args: string[], fresh?: true) => Promise<unknown> = (args, fresh) => ghJsonAsync(args, undefined, undefined, { fresh }),
  pushGit = hostWorktreeGitAsync,
): HandShipEffects {
  return {
    async readHost(host, run) {
      const args = host.kind === "mac" ? ["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"] : ["cat", "/proc/meminfo"];
      return checked(await hostCommand(host, run, args, { signal: AbortSignal.any([run.signal, AbortSignal.timeout(15_000)]) }), "memory reading");
    },
    readSource: defaultSource,
    prepare: prepareWorkspace,
    async push(source, run) {
      const current = await defaultSource(source.root, run);
      if (current.head !== source.head || current.branch !== source.branch || current.origin !== source.origin) {
        throw new Error("source branch, head or origin changed during verification");
      }
      const execute = worktreePushExecAsync(source.root, { push: (worktree, args, opts) => {
        run.signal.throwIfAborted();
        return pushGit(worktree, args, opts);
      } });
      await gitPushRunBranchAsync(source.root, { expectedHeadSha: source.head, destination: source.branch,
        exec: (file, args, opts) => execute(file, [...args.slice(0, -1), `${source.head}:refs/heads/${source.branch}`], opts) });
    },
    async findPull(source) {
      const { owner, path } = pullEndpoint(source);
      const query = new URLSearchParams({ state: "open", head: `${owner}:${source.branch}` });
      const existing = await github(["api", `${path}?${query}`], true) as PullResponse[];
      if (Array.isArray(existing) && existing.length === 0) return undefined;
      const pull = Array.isArray(existing) && existing.length === 1 ? existing[0] : undefined;
      if (!pull || !Number.isSafeInteger(pull.number)) {
        throw new Error("GitHub did not identify a unique pull request for the branch");
      }
      return pull.number;
    },
    async publish(source, title, body, existing) {
      const { path } = pullEndpoint(source);
      const fields = ["-f", `title=${title}`, "-f", `body=${body}`];
      const written = await github(existing === undefined
        ? ["api", "-X", "POST", path, "-f", `head=${source.branch}`, "-f", "base=main", ...fields]
        : ["api", "-X", "PATCH", `${path}/${existing}`, ...fields]) as PullResponse;
      if (!written || !Number.isSafeInteger(written.number)) throw new Error("GitHub did not return a pull request number");
      const stored = await github(["api", `${path}/${written.number}`], true) as PullResponse;
      if (stored.body?.trimEnd() !== body.trimEnd()) throw new Error(`stored pull request body differs at ${stored.html_url}`);
      return { url: stored.html_url, body: stored.body };
    },
    checkBody(body, run) {
      const path = join(run.dir, "stored-pr-body.md");
      writeFileSync(path, body, { mode: 0o600 });
      if (checkAcceptance(path) !== 0) throw new Error(`stored pull request body failed check-acceptance (${path})`);
    },
  };
}
