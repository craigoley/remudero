import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
// @ts-ignore The executable author preflight currently has no declaration file.
import { authorPushEligibility, failingTestsFromTap } from "../../scripts/lib/author-push-eligibility.mjs";
// @ts-ignore The author admission module currently has no declaration file.
import { macPressureState } from "../../scripts/lib/mac-author-admission.mjs";
import { type Clock, loopAvailableDeadline, systemClock } from "./clock.js";
import { pushHandShipCommit } from "./git-push.js";
import { ghTextAsync, withGhTransportFloor, writeHandShipPullRequest } from "./github-transport.js";
import { acquireInflightLock } from "./inflight-lock.js";
import { parseAcceptanceBlock } from "./review.js";
import { authorTestRunnerArgs } from "./test-run-timeout.js";
import { killProcessGroup } from "./worker-containment.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";
import { repoSlugOfRemoteUrl } from "./worktree-retire.js";

export interface ShipHost {
  name: string;
  target: string;
  kind: "mac" | "linux";
  donor?: string;
  path?: string;
}

interface HostReading { reading: string; normal?: boolean }
interface Source { branch: string; sha: string; repo: string }
interface FailedTest { file: string; title: string; fileLevel?: boolean }
interface ShipPr { number: number; url: string; title: string; body: string; sha: string }
interface ShipBody { title?: string; body?: string }
type Priority = "low" | "normal";
type TestResult = "red" | "green" | "unmeasured";
type FailureClass = "also failing on main" | "caused by the host" | "caused by the change" | "unmeasured";

export interface HandShipReceipt {
  headSha: string;
  baseSha: string;
  verdict: string;
  selection?: string;
  steps: Array<{
    name: string;
    ok: boolean;
    testSummary?: { pass: number; fail: number; cancelled: number };
    judge?: { given: number; reported: number };
    diagnostics?: { stdout?: string; mayBeIncomplete: boolean };
  }>;
}

export type HandShipPorts = ReturnType<typeof handShipProduction>["deps"];

const SHA = /^[0-9a-f]{40}$/;
const RUN_BRANCH = /^run-[A-Za-z0-9-]+-[0-9]+$/;
const testKey = ({ file, title }: FailedTest) => JSON.stringify([file, title]);

function checkBody(title: string | undefined, body: string | undefined): asserts body is string {
  if (title === undefined || title.trim() === "" || !body || parseAcceptanceBlock(body).length === 0) {
    throw new Error("a PR title and a body with a parseable Acceptance block are required");
  }
}

async function selectHost(deps: HandShipPorts): Promise<ShipHost> {
  for (const host of deps.hosts().sort((a, b) => Number(b.kind === "mac") - Number(a.kind === "mac"))) {
    deps.signal?.throwIfAborted();
    const reading = await deps.readHost(host);
    if (reading && (host.kind === "linux" || reading.normal === true)) {
      deps.log(`selected ${host.name}: ${reading.reading}`);
      return host;
    }
    deps.log(`${host.name}: ${reading?.reading ?? "unreadable"}`);
  }
  throw new Error("no readable, eligible preflight host");
}

function isTestStep(name: string): boolean {
  return name === "affected-tests" || name === "affected-tests-subset";
}

async function compareFailures(deps: HandShipPorts, host: ShipHost, receipt: HandShipReceipt, failures: FailedTest[]) {
  const atHead: TestResult[] = [];
  for (const failure of failures) atHead.push(await deps.rerun(host, receipt.headSha, failure));
  const tests = [];
  for (const [index, failure] of failures.entries()) {
    const onMain = await deps.rerun(host, receipt.baseSha, failure);
    const head = atHead[index];
    const classification: FailureClass = head === "green" ? "caused by the host"
      : head === "red" && onMain === "red" ? "also failing on main"
      : head === "red" && onMain === "green" ? "caused by the change" : "unmeasured";
    deps.log(`${failure.file} :: ${failure.title} — ${classification}`);
    tests.push({ ...failure, state: classification === "also failing on main" ? "also-red"
      : classification === "caused by the change" ? "only-head" : "unattributed" });
  }
  return tests;
}

export async function runHandShip(input: ShipBody, deps: HandShipPorts): Promise<string> {
  const source = await deps.source();
  const existing = await deps.findPr(source);
  const title = input.title ?? existing?.title;
  const body = input.body ?? existing?.body;
  checkBody(title, body);
  const host = await selectHost(deps);
  const { receipt, failures } = await deps.preflight(source, host, host.kind === "mac" ? "low" : "normal");
  deps.signal?.throwIfAborted();
  if (receipt.headSha !== source.sha || !SHA.test(receipt.baseSha)) {
    throw new Error("the author receipt does not bind the requested head and a main commit");
  }
  const failed = receipt.steps.find((step) => !step.ok);
  // Use our head-then-main evidence in place of the preflight's merge-base attribution.
  let eligibility = authorPushEligibility({ ...receipt, failureAttribution: undefined });
  if (failed && isTestStep(failed.name)) {
    const identities = [...new Map(failures.map((failure) => [testKey(failure), failure])).values()];
    const tests = await compareFailures(deps, host, receipt, identities);
    const failingAtHead = failed.testSummary?.fail ?? 0;
    const alsoFailingAtBase = tests.filter(({ state }) => state === "also-red").length;
    const failingOnlyAtHead = tests.filter(({ state }) => state === "only-head").length;
    eligibility = authorPushEligibility({ ...receipt, failureAttribution: {
      tests, base: { mergeBase: receipt.baseSha }, counts: {
        failingAtHead, alsoFailingAtBase, failingOnlyAtHead, unattributed: failingAtHead - alsoFailingAtBase - failingOnlyAtHead,
      },
    } });
  }
  if (!eligibility.pushEligible) throw new Error(`not eligible to push: ${eligibility.pushEligibleReason}`);
  deps.log(eligibility.pushEligibleReason);
  deps.signal?.throwIfAborted();
  const expected = await deps.readTip(source);
  deps.signal?.throwIfAborted();
  await deps.push(source, expected);
  deps.log(`published ${source.branch} at ${source.sha}`);
  deps.signal?.throwIfAborted();
  const number = await deps.writePr(source, existing?.number, title!, body);
  const stored = await deps.readPr(source, number);
  checkBody(stored.title, stored.body);
  if (stored.sha !== source.sha || stored.title !== title || stored.body !== body) {
    throw new Error(`stored PR ${stored.url} differs from the requested head, title or body`);
  }
  deps.log(stored.url);
  return stored.url;
}

type RunStatus = "running" | "shipped" | "refused" | "stopped";

export function shipRunJournal(stateDir: string, clock: Clock = systemClock) {
  const id = randomUUID();
  const dir = join(stateDir, "hand-ship", id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stopFile = join(dir, "stop");
  const controller = new AbortController();
  const checkStop = () => {
    if (existsSync(stopFile)) controller.abort(new Error(`hand-ship run ${id} stopped`));
  };
  const record = (status: RunStatus) => {
    const row = JSON.stringify({ id, pid: process.pid, host: hostname(), status, at: clock.iso() }) + "\n";
    const path = join(dir, "status.json");
    writeFileSync(path + ".next", row, { mode: 0o600 });
    renameSync(path + ".next", path);
    appendFileSync(join(dir, "history.ndjson"), row, { mode: 0o600 });
  };
  record("running");
  const timer = setInterval(checkStop, 100);
  let finished = false;
  return { id, dir, signal: controller.signal, checkStop, finish: (status: Exclude<RunStatus, "running">) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    record(status);
  } };
}

export function stopHandShip(stateDir: string, id: string): boolean {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) return false;
  const dir = join(stateDir, "hand-ship", id);
  const path = join(dir, "status.json");
  if (!existsSync(path) || JSON.parse(readFileSync(path, "utf8")).status !== "running") return false;
  writeFileSync(join(dir, "stop"), "", { mode: 0o600 });
  return true;
}

export async function waitForHandShipStop(stateDir: string, id: string, clock: Clock = systemClock): Promise<string> {
  const path = join(stateDir, "hand-ship", id, "status.json");
  const deadline = clock.now() + 30_000;
  do {
    const { status } = JSON.parse(readFileSync(path, "utf8"));
    if (status !== "running") return status;
    await delay(100);
  } while (clock.now() < deadline);
  throw new Error(`stop requested for ${id}; the run has not acknowledged it within 30 seconds`);
}

function configuredHosts(stateDir: string): ShipHost[] {
  const entries: unknown = JSON.parse(readFileSync(join(stateDir, "hand-ship-hosts.json"), "utf8"));
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("hand-ship-hosts.json needs a nonempty host array");
  const names = new Set<string>();
  for (const host of entries) {
    if (!host || typeof host.name !== "string" || !host.name.trim() || names.has(host.name) ||
        !["mac", "linux"].includes(host.kind) || typeof host.target !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(host.target) ||
        (host.donor !== undefined && (typeof host.donor !== "string" || !isAbsolute(host.donor))) ||
        (host.target !== "local" && !host.donor) || (host.path !== undefined && typeof host.path !== "string")) {
      throw new Error("invalid hand-ship host: use a unique name, mac/linux kind, local/SSH target, and an absolute donor for SSH");
    }
    names.add(host.name);
  }
  return entries;
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const argvString = (args: string[]) => args.map(quote).join(" ");
const hostSsh = (host: ShipHost) => ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3", host.target];

interface ChildResult { code: number | null; stdout: string }
interface ChildOptions { signal?: AbortSignal; input?: string; log?: string; boundMs?: number; keepStdin?: boolean }

function command(file: string, args: string[], opts: ChildOptions = {}): Promise<ChildResult> {
  opts.signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const input = opts.input === undefined ? undefined : openSync(opts.input, "r");
    const log = opts.log === undefined ? undefined : openSync(opts.log, "a", 0o600);
    const child = spawn(file, args, {
      detached: true,
      stdio: [input ?? (opts.keepStdin ? "pipe" : "ignore"), "pipe", log ?? "pipe"],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: undefined },
    });
    if (input !== undefined) closeSync(input);
    if (log !== undefined) closeSync(log);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    let cancelEscalation: (() => void) | undefined;
    const terminate = (error: Error) => {
      if (failure) return;
      failure = error;
      child.stdin?.end();
      if (!child.pid) return;
      const pid = child.pid;
      const kill = (signal: NodeJS.Signals) => {
        try { killProcessGroup(pid, signal); }
        catch (error) {
          const reason = `could not signal ${file}: ${String(error)}`;
          failure = new Error(reason, { cause: error });
        }
      };
      if (!opts.keepStdin) kill("SIGTERM");
      cancelEscalation = loopAvailableDeadline(systemClock, 5_000, () => kill("SIGKILL"));
    };
    const abort = () => terminate(new Error(`${file} stopped`));
    opts.signal?.addEventListener("abort", abort, { once: true });
    const cancelDeadline = loopAvailableDeadline(systemClock, opts.boundMs ?? 3_600_000, () => terminate(new Error(`${file} timed out`)));
    child.stdout!.on("data", (chunk: Buffer) => {
      if (opts.log !== undefined) {
        try { appendFileSync(opts.log, chunk); }
        catch (error) {
          const reason = `could not write the hand-ship log: ${String(error)}`;
          terminate(new Error(reason, { cause: error }));
        }
      }
      size += chunk.length;
      if (size <= 64 * 1024 * 1024) stdout.push(chunk);
      else terminate(new Error(`${file} output exceeded 64 MiB`));
    });
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 100) stderr.push(chunk); });
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code, signal) => {
      cancelDeadline();
      cancelEscalation?.();
      opts.signal?.removeEventListener("abort", abort);
      if (failure || signal) reject(failure ?? new Error(`${file} ended with ${signal}`));
      else if (code !== 0 && !opts.log && stderr.length) reject(new Error(`${file} failed: ${Buffer.concat(stderr).toString().trim()}`));
      else resolveResult({ code, stdout: Buffer.concat(stdout).toString() });
    });
  });
}

// The SSH connection owns this foreground process group. Closing stdin ends the
// remote group even if an SSH client disconnect does not deliver a Unix signal.
const remoteSupervisor = `
const {spawn} = require("node:child_process");
const child = spawn(process.argv[1], process.argv.slice(2), {detached:true, stdio:["ignore","inherit","inherit"]});
let timer;
const kill = (signal) => {
  if (child.pid) {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
};
const stop = () => {
  if (timer) return;
  kill("SIGTERM");
  timer = setTimeout(() => { kill("SIGKILL"); process.stdin.pause(); }, 3000);
};
process.stdin.on("end", stop).resume();
process.once("SIGHUP", stop);
process.once("SIGTERM", stop);
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; process.stdin.pause(); });
child.on("close", (code) => { process.exitCode = code ?? 1; if (!timer) process.stdin.pause(); });
`;

function onHost(host: ShipHost, args: string[], opts: ChildOptions & { cwd?: string; supervise?: boolean } = {}) {
  const launch = args.length ? `exec ${argvString(host.target !== "local" && opts.supervise ? ["node", "-e", remoteSupervisor, "--", ...args] : args)}` : "";
  const shell = (host.path ? `export PATH=${quote(host.path)}:"$PATH"; ` : "") +
    (opts.cwd ? `cd ${quote(opts.cwd)} && ` : "") + launch;
  if (host.target === "local") return command("/bin/sh", ["-c", shell], opts);
  return command("ssh", [...hostSsh(host), shell], { ...opts, keepStdin: opts.supervise });
}

async function checked(result: Promise<ChildResult>, what: string): Promise<string> {
  const { code, stdout } = await result;
  if (code !== 0) throw new Error(`${what} exited with status ${code}`);
  return stdout;
}

function safePath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`invalid checkout path: ${path}`);
  }
  return join(root, path);
}

function launchArgs(priority: Priority, args: string[]): string[] {
  return [...(priority === "low" ? ["/usr/bin/nice", "-n", "10"] : []), "node", "--import", "tsx", ...args];
}

function failedTests(output: string, root: string): FailedTest[] {
  return (failingTestsFromTap(output, root) as Array<FailedTest | { file: null }>).filter((row): row is FailedTest => row.file !== null);
}

function passedTest(tap: string, title: string): boolean {
  const stack: string[] = [];
  for (const line of tap.split("\n")) {
    const header = /^( *)# Subtest: (.*)$/.exec(line);
    if (header) {
      stack.splice(header[1].length / 4, stack.length, header[2]);
      continue;
    }
    const pass = /^( *)ok [0-9]+ - (.*)$/.exec(line);
    if (pass && !/ # (?:SKIP|TODO)(?: |$)/.test(pass[2]) &&
        [...stack.slice(0, pass[1].length / 4), pass[2]].join(" > ") === title) return true;
  }
  return false;
}

export async function rerunHandShipTest(host: ShipHost, dir: string, failure: FailedTest, main: boolean, opts: ChildOptions): Promise<TestResult> {
  const inDir = (args: string[]) => onHost(host, args, { ...opts, cwd: dir });
  const file = safePath(dir, failure.file);
  if ((await inDir(["test", "-f", file])).code !== 0) return main ? "green" : "unmeasured";
  const parent = failure.title.split(" > ")[0];
  const run = async (titles: string[]): Promise<TestResult | "absent"> => {
    const patterns = [...new Set(titles)].map((title) => `--test-name-pattern=^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    const args = authorTestRunnerArgs(["--test", "--test-reporter=tap", "--test-concurrency=1",
      "--import", "./test/setup/tmp-hygiene.ts", ...patterns, "./" + failure.file], [failure.file], undefined);
    const launch = launchArgs(host.kind === "mac" ? "low" : "normal", args);
    const { code, stdout: tap } = await onHost(host, launch, { ...opts, cwd: dir, supervise: true });
    if (!/^# tests [1-9][0-9]*$/m.test(tap) || !/^# cancelled 0$/m.test(tap)) return "unmeasured";
    if (code === 1 && failedTests(tap, dir).some((entry) => testKey(entry) === testKey(failure))) return "red";
    if (failure.fileLevel && code === 0 && /^# pass [1-9][0-9]*$/m.test(tap)) return "green";
    if (!failure.fileLevel && passedTest(tap, failure.title)) return "green";
    return code === 0 ? "absent" : "unmeasured";
  };
  const exact = await run(failure.fileLevel ? [] : [failure.title, failure.title.replaceAll(" > ", " ")]);
  // Callback-defined subtests do not register until Node runs their parent.
  const observed = exact === "absent" && parent !== failure.title ? await run([parent]) : exact;
  return observed === "absent" ? (main ? "green" : "unmeasured") : observed;
}

function prFromApi(row: { number: number; html_url: string; title: string; body: string | null; head: { sha: string } }): ShipPr {
  return { number: row.number, url: row.html_url, title: row.title, body: row.body ?? "", sha: row.head.sha };
}

export function handShipProduction(
  cwd: string, stateDir: string, journal: ReturnType<typeof shipRunJournal>, log = console.log, transport = ghTextAsync,
) {
  const signal = journal.signal;
  const git = (args: string[]) => {
    journal.checkStop();
    return hostWorktreeGitAsync(cwd, args, { signal });
  };
  // Keep the broker for reads. Recheck cancellation before any following live write.
  const gh = async (args: string[]) => {
    journal.checkStop();
    signal.throwIfAborted();
    const response = withGhTransportFloor(() => transport(["api", ...args], { fresh: true }));
    let abort: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return JSON.parse(await Promise.race([response, stopped]));
    } finally {
      signal.removeEventListener("abort", abort!);
    }
  };
  const bundle = join(journal.dir, "head.bundle");
  const output = join(journal.dir, "run.log");
  let scratch: { host: ShipHost; dir: string } | undefined;
  let base: string | undefined;
  const deps = {
    signal,
    log(line: string) {
      appendFileSync(output, `${line}\n`, { mode: 0o600 });
      log(line);
    },
    hosts: () => configuredHosts(stateDir),
    async readHost(host: ShipHost): Promise<HostReading | undefined> {
      try {
        const call = host.kind === "mac" ? ["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"] : ["cat", "/proc/meminfo"];
        const reading = (await checked(onHost(host, call, { signal, boundMs: 15_000 }), "memory probe")).trim();
        if (host.kind === "mac") {
          const pressure = macPressureState(reading);
          return pressure === "unknown" ? undefined : { reading: `memory pressure ${pressure} (${reading})`, normal: pressure === "normal" };
        }
        const available = host.kind === "linux" && /^MemAvailable:\s+([1-9][0-9]*)\s+kB$/m.exec(reading);
        return available ? { reading: `${available[1]} kB available` } : undefined;
      } catch (error) {
        signal.throwIfAborted();
        deps.log(`${host.name} probe failed: ${String(error)}`);
        return undefined;
      }
    },
    async source(): Promise<Source> {
      const branch = (await git(["symbolic-ref", "--short", "HEAD"])).trim();
      const sha = (await git(["rev-parse", "HEAD"])).trim();
      const repo = repoSlugOfRemoteUrl((await git(["remote", "get-url", "origin"])).trim());
      if (!RUN_BRANCH.test(branch) || !SHA.test(sha) || !repo) throw new Error("run from a committed hand-worktree branch with a GitHub origin");
      if ((await git(["status", "--porcelain", "--untracked-files=normal"])).trim()) throw new Error("commit the hand worktree before shipping");
      return { branch, sha, repo };
    },
    async preflight(source: Source, host: ShipHost, priority: Priority) {
      const launch = (args: string[], opts: ChildOptions & { cwd?: string; supervise?: boolean } = {}) => onHost(host, args, { signal, ...opts });
      const donor = host.donor ?? cwd;
      const originalRemote = (await git(["remote", "get-url", "origin"])).trim();
      await git(["bundle", "create", bundle, `refs/heads/${source.branch}`]);
      const created = (await checked(launch(["mktemp", "-d", "/tmp/rmd-hand-ship.XXXXXXXX"]), "create host scratch")).trim();
      if (!/^\/tmp\/rmd-hand-ship\.[A-Za-z0-9]+$/.test(created)) throw new Error("the host did not return its scratch path");
      scratch = { host, dir: created };
      const dir = (await checked(launch(["pwd", "-P"], { cwd: created }), "resolve host scratch")).trim();
      if (dir !== created && dir !== `/private${created}`) throw new Error("the host scratch directory resolved outside its temporary root");
      scratch.dir = dir;
      const hostBundle = host.target === "local" ? bundle : join(dir, "head.bundle");
      if (host.target !== "local") await checked(command("ssh", [...hostSsh(host), `cat > ${quote(hostBundle)}`], { signal, input: bundle }), "copy bundle");
      const head = join(dir, "head");
      await checked(launch(["git", "clone", "--branch", source.branch, hostBundle, head]), "clone hand bundle");
      const actual = await checked(launch(["git", "rev-parse", "HEAD"], { cwd: head }), "read bundled SHA");
      if (actual.trim() !== source.sha) throw new Error("the hand branch moved while making its bundle");
      await checked(launch(["git", "remote", "set-url", "origin", originalRemote], { cwd: head }), "set the author preflight origin");
      await checked(launch(["cmp", "package-lock.json", join(donor, "package-lock.json")], { cwd: head, log: output }), "verify the dependency donor lockfile");
      await checked(launch(["ln", "-s", join(donor, "node_modules"), "node_modules"], { cwd: head }), "link the dependency donor");
      const result = await launch(launchArgs(priority, ["scripts/preflight-author.mjs", "--head-ref", source.branch, "--head-sha", source.sha]),
        { cwd: head, log: output, supervise: true });
      const content = await checked(launch(["cat", "coverage/preflight-author.json"], { cwd: head }), "read fresh author receipt");
      writeFileSync(join(journal.dir, "receipt.json"), content, { mode: 0o600 });
      const receipt: HandShipReceipt = JSON.parse(content);
      if ((result.code === 0 && receipt.verdict !== "passed") || (result.code !== 0 && receipt.verdict === "passed")) {
        throw new Error(`author preflight status ${result.code} disagrees with receipt verdict ${receipt.verdict}`);
      }
      const firstFailed = receipt.steps.find((step) => !step.ok);
      const path = firstFailed && isTestStep(firstFailed.name) ? firstFailed.diagnostics?.stdout : undefined;
      const tap = path ? await checked(launch(["cat", safePath(head, path)]), "read author TAP") : "";
      if (path) writeFileSync(join(journal.dir, "failed-step.tap"), tap, { mode: 0o600 });
      base = receipt.baseSha;
      return { receipt, failures: failedTests(tap, head) };
    },
    async rerun(host: ShipHost, sha: string, failure: FailedTest): Promise<TestResult> {
      journal.checkStop();
      if (!scratch || !SHA.test(sha)) throw new Error("the comparison checkout was not prepared");
      const main = sha === base;
      const dir = join(scratch.dir, main ? "main" : "head");
      const inDir = (args: string[]) => onHost(host, args, { signal, cwd: dir, log: output });
      if (main && (await onHost(host, ["test", "-d", dir], { signal })).code !== 0) {
        const head = join(scratch.dir, "head");
        await checked(onHost(host, ["git", "worktree", "add", "--detach", dir, sha], { cwd: head, signal, log: output }), "cut unchanged main");
        const donor = host.donor ?? cwd;
        if ((await inDir(["cmp", "package-lock.json", join(donor, "package-lock.json")])).code !== 0) {
          // No result can be attributed to main against another tree's dependencies.
          await checked(inDir(["touch", ".hand-ship-donor-mismatch"]), "mark unavailable main comparison");
        } else {
          await checked(inDir(["ln", "-s", join(donor, "node_modules"), "node_modules"]), "link main's dependency donor");
        }
      }
      if (main && (await inDir(["test", "-f", ".hand-ship-donor-mismatch"])).code === 0) return "unmeasured";
      return rerunHandShipTest(host, dir, failure, main, { signal, log: output });
    },
    async findPr(source: Source): Promise<ShipPr | undefined> {
      const owner = source.repo.split("/")[0];
      const rows = await gh([`repos/${source.repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${source.branch}`)}&base=main`]);
      if (!Array.isArray(rows)) throw new Error("GitHub did not return a PR list");
      const open = rows.filter((row) => row.state === "open");
      if (open.length > 1 || (open.length === 0 && rows.length > 0)) throw new Error("the run branch already has ambiguous or closed PR history");
      return open[0] ? prFromApi(open[0]) : undefined;
    },
    async readTip(source: Source) {
      const ref = `refs/heads/${source.branch}`;
      const response = (await git(["ls-remote", "--refs", "origin", ref])).trim();
      if (!response) return null;
      const [sha, returnedRef, ...rest] = response.split(/\s+/);
      if (!SHA.test(sha) || returnedRef !== ref || rest.length) throw new Error("origin returned an invalid branch tip");
      return sha;
    },
    push: ({ branch, sha }: Source, expected: string | null) => pushHandShipCommit(cwd, branch, sha, expected, signal),
    async writePr(source: Source, number: number | undefined, title: string, body: string) {
      journal.checkStop();
      return writeHandShipPullRequest(source, number, title, body, signal, transport);
    },
    async readPr(source: Source, number: number) {
      return prFromApi(await gh([`repos/${source.repo}/pulls/${number}`]));
    },
  };
  return { deps, cleanup: async () => {
    try {
      if (scratch) await checked(onHost(scratch.host, ["rm", "-rf", "--", scratch.dir], { boundMs: 30_000, log: output }), "remove host scratch");
    } finally {
      rmSync(bundle, { force: true });
    }
  } };
}

export function handShipArgs(rest: string[], cwd: string): ShipBody {
  const input: ShipBody = {};
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value] = rest.slice(index, index + 2);
    if (!value || value.startsWith("--")) throw new Error(`expected a value for ${flag}`);
    if (flag === "--title" && input.title === undefined) input.title = value;
    else if (flag === "--body-file" && input.body === undefined) input.body = readFileSync(resolve(cwd, value), "utf8");
    else throw new Error(`unknown or repeated hand-ship option ${flag}`);
  }
  return input;
}

export async function withHandShipRun(cwd: string, stateDir: string, run: (deps: HandShipPorts) => Promise<string>): Promise<number> {
  const journal = shipRunJournal(stateDir);
  const { deps, cleanup } = handShipProduction(cwd, stateDir, journal);
  let status: Exclude<RunStatus, "running"> = "refused";
  try {
    deps.log(`hand-ship run ${journal.id}: ${journal.dir}`);
    const lock = acquireInflightLock(dirname(journal.dir), "preflight", { run_id: journal.id });
    try {
      await run(deps);
      status = "shipped";
    } finally {
      try { await cleanup(); }
      finally { lock.release(); }
    }
    return 0;
  } catch (error) {
    if (journal.signal.aborted) status = "stopped";
    deps.log(`hand-ship: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    journal.finish(status);
  }
}
