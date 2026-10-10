/**
 * `npm run typecheck` on the fleet host takes the host-wide test slot when cold and runs incremental — the same
 * admission #10487 (W1-T7392) gave the harness's own checks. MEASURED 2026-10-10: two Codex fix workers' own
 * `npm run typecheck` ran the bare package script, cold, 2.1-2.4 GB each for 31+ minutes, with no slot.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { acquireTestSlot, readPidNamespace } from "../src/lib/test-slot.js";
import { codexTestSlotArgs, planTypecheckCommand, runTypecheckCommand, typecheckBuildInfoFor } from "../src/lib/typecheck-command.js";
import { spawnCodexWorker } from "../src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "../src/lib/worker-containment.js";

const REPO = resolve(".");
const TS_VERSION = JSON.parse(readFileSync(join(REPO, "node_modules", "typescript", "package.json"), "utf8")).version as string;
const FAKE_TSC = `#!/usr/bin/env node
const { readdirSync, readFileSync, writeFileSync } = require("node:fs");
const dir = process.env.RMD_TEST_SLOT_DIR;
let labels = [];
try { labels = readdirSync(dir).filter((n) => /^slot-/.test(n)).map((n) => JSON.parse(readFileSync(dir + "/" + n, "utf8")).label); } catch {}
writeFileSync(process.env.FAKE_TSC_OUT, JSON.stringify({ argv: process.argv.slice(2), labels }));
process.exit(Number(process.env.FAKE_TSC_EXIT ?? 0));
`;

interface Fx { root: string; slots: string; out: string; tmp: string }

/** A package root whose `node_modules` carries the real tsx and typescript and a FAKE `.bin/tsc` that records what it
 *  was given and which slots were held while it ran. `scripts` links the real directory, so the package script runs
 *  the real wrapper against this root. */
function typecheckTree(t: TestContext): Fx {
  const base = mkdtempSync(join(tmpdir(), "rmd-npm-typecheck-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "pkg");
  const slots = join(base, "slots");
  const tmp = join(base, "tmp");
  for (const dir of [root, slots, tmp, join(root, ".git"), join(root, "node_modules", ".bin")]) mkdirSync(dir, { recursive: true });
  for (const name of ["tsx", "typescript"]) symlinkSync(join(REPO, "node_modules", name), join(root, "node_modules", name));
  symlinkSync(join(REPO, "scripts"), join(root, "scripts"));
  writeFileSync(join(root, "node_modules", ".bin", "tsc"), FAKE_TSC);
  chmodSync(join(root, "node_modules", ".bin", "tsc"), 0o755);
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  return { root, slots, tmp, out: join(base, "tsc.json") };
}

function fleetEnv(fx: Fx, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, RMD_TEST_SLOT_DIR: fx.slots, RMD_TEST_SLOTS: "1", FAKE_TSC_OUT: fx.out };
  delete env.NODE_TEST_CONTEXT;
  delete env.RMD_TEST_SLOT_PARENT;
  env.NODE_V8_COVERAGE = ""; // the wrapper child is production-shaped, not a coverage participant
  return { ...env, ...extra };
}

/** Run the REAL package.json `typecheck` script the way npm does: in the package root, `.bin` first on PATH. */
function runPackageScript(fx: Fx, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string }> {
  const script = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts.typecheck as string;
  const child = spawn("sh", ["-c", script], {
    cwd: fx.root, env: { ...env, PATH: `${join(fx.root, "node_modules", ".bin")}:${env.PATH}` }, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  return new Promise((done) => child.on("close", (status) => { clearTimeout(timer); done({ status, stderr }); }));
}

const recorded = (fx: Fx): { argv: string[]; labels: string[] } => JSON.parse(readFileSync(fx.out, "utf8"));
const slotFiles = (fx: Fx): string[] => readdirSync(fx.slots).filter((name) => name.startsWith("slot-"));

test("npm run typecheck on the fleet host runs cold tsc inside a host slot, incremental, and releases the slot", async (t) => {
  const fx = typecheckTree(t);
  const res = await runPackageScript(fx, fleetEnv(fx));
  assert.equal(res.status, 0, res.stderr);
  const seen = recorded(fx);
  assert.deepEqual(seen.labels, ["typecheck:npm"], "the cold check ran while holding the host-wide slot");
  assert.deepEqual(seen.argv.slice(0, 4), ["-p", "tsconfig.json", "--noEmit", "--incremental"]);
  assert.equal(seen.argv[seen.argv.indexOf("--tsBuildInfoFile") + 1], join(fx.root, ".git", "rmd-typecheck.tsbuildinfo"));
  assert.deepEqual(slotFiles(fx), [], "the slot is released when tsc exits");
});

test("npm run typecheck inside a caller that already holds the only slot borrows it instead of waiting", async (t) => {
  const fx = typecheckTree(t);
  const lease = acquireTestSlot("caller-holds-it", { dir: fx.slots, slots: 1, log: () => {} });
  t.after(() => lease.release());
  assert.equal(lease.outcome, "acquired");
  assert.ok(lease.childEnvironment, "this process can hand its slot to a real descendant");
  const started = Date.now();
  const res = await runPackageScript(fx, fleetEnv(fx, lease.childEnvironment!));
  assert.equal(res.status, 0, res.stderr);
  assert.ok(Date.now() - started < 30_000, "no wait on its own ancestor's slot");
  assert.deepEqual(recorded(fx).labels, ["caller-holds-it"], "tsc ran under the caller's slot, and no second record was written");
  assert.deepEqual(recorded(fx).argv.includes("--incremental"), true);
});

test("off the fleet npm run typecheck is the plain tsc check with no slot; tsc's exit code and extra argv pass through", async (t) => {
  const fx = typecheckTree(t);
  const env = fleetEnv(fx, { FAKE_TSC_EXIT: "2" });
  delete env.RMD_TEST_SLOT_DIR;
  const calls: string[][] = [];
  const code = await runTypecheckCommand(fx.root, {
    env, isDir: () => false, extraArgs: ["--pretty", "false"], log: () => {},
    spawn: (file, args, options) => {
      calls.push(args);
      return spawn(file, args, { ...options, env });
    },
  });
  assert.equal(code, 2);
  assert.deepEqual(calls, [["-p", "tsconfig.json", "--noEmit", "--pretty", "false"]]);
  assert.deepEqual(slotFiles(fx), []);
});

test("a warm fleet typecheck takes no slot, and a sandbox's read-only git dir moves the buildinfo to TMPDIR", async (t) => {
  const fx = typecheckTree(t);
  const buildInfo = join(fx.root, ".git", "rmd-typecheck.tsbuildinfo");
  writeFileSync(buildInfo, JSON.stringify({ version: TS_VERSION, fileNames: ["./a.ts"], fileInfos: [{}] }));
  const res = await runPackageScript(fx, fleetEnv(fx));
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(recorded(fx).labels, [], "a usable buildinfo is the cheap tier: no queue");

  const gitDir = join(fx.root, ".git");
  const readOnlyGit = (dir: string) => dir !== gitDir;
  const plan = planTypecheckCommand(fx.root, { env: fleetEnv(fx), isDir: () => false, tmp: fx.tmp, writable: readOnlyGit });
  assert.match(plan.buildInfo ?? "", new RegExp(`^${fx.tmp}/rmd-typecheck-[0-9a-f]{16}\\.tsbuildinfo$`));
  assert.equal(plan.args.includes("--incremental"), true);
  assert.deepEqual(planTypecheckCommand(fx.root, { env: fleetEnv(fx), isDir: () => false, tmp: fx.tmp, writable: () => false }).args,
    ["-p", "tsconfig.json", "--noEmit"], "nowhere writable: the plain check, never an incremental one that cannot write its buildinfo");
  assert.equal(planTypecheckCommand(fx.root, { env: fleetEnv(fx), isDir: () => false, tmp: fx.tmp }).buildInfo, buildInfo,
    "a writable git dir keeps the buildinfo beside the checkout");
});

test("a slot holder in another pid namespace on the same host is aged by its lease, never by a pid probe", () => {
  const now = Date.parse("2026-10-10T08:25:00.000Z");
  const clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const base = { slots: 1, clock, load: () => ({ cores: 8, load1: 0 }), hostname: () => "Remudero", bootId: () => "boot-1",
    isPidAlive: () => false, pidNamespace: () => "pid:[4026531836]", waitBoundMs: 0, log: () => {} };
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["a live sandboxed holder whose pid this namespace cannot see", { heartbeatAt: new Date(now - 60_000).toISOString() }, "wait_bound_exceeded"],
    ["a sandboxed holder silent past its own lease", { heartbeatAt: new Date(now - 6 * 60_000).toISOString(), leaseMs: 5 * 60_000 }, "acquired"],
  ];
  for (const [name, holder, expected] of cases) {
    const dir = mkdtempSync(join(tmpdir(), "rmd-slot-pidns-"));
    try {
      writeFileSync(join(dir, "slot-1.json"), JSON.stringify({ pid: 3, host: "Remudero", bootId: "boot-1", pidNamespace: "pid:[4026533001]",
        startedAt: new Date(now - 120_000).toISOString(), label: "typecheck:npm", ...holder }));
      const lease = acquireTestSlot("reader", { ...base, dir });
      assert.equal(lease.outcome, expected, name);
      lease.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "rmd-slot-pidns-"));
  try {
    const lease = acquireTestSlot("writer", { ...base, dir, leaseMs: 300_000 });
    const record = JSON.parse(readFileSync(join(dir, "slot-1.json"), "utf8"));
    assert.equal(record.pidNamespace, "pid:[4026531836]");
    assert.equal(record.leaseMs, 300_000);
    lease.release();
    assert.equal(readPidNamespace(join(dir, "no-such-ns")), undefined, "no /proc: no namespace, so the pid probe stays the rung");
    if (process.platform === "linux") assert.match(readPidNamespace() ?? "", /^pid:\[\d+\]$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Codex writer's shell is told the slot directory and may write it; readers, tests and Macs get nothing", async (t) => {
  assert.deepEqual(codexTestSlotArgs({ RMD_TEST_SLOT_DIR: "/home/node/rmd-scratch/test-slots", RMD_TEST_SLOTS: "2" }), [
    "--add-dir", "/home/node/rmd-scratch/test-slots",
    "-c", 'shell_environment_policy.set.RMD_TEST_SLOT_DIR="/home/node/rmd-scratch/test-slots"',
    "-c", 'shell_environment_policy.set.RMD_TEST_SLOTS="2"',
  ]);
  assert.deepEqual(codexTestSlotArgs({}), []);
  assert.deepEqual(codexTestSlotArgs({ RMD_TEST_SLOT_DIR: "/x", NODE_TEST_CONTEXT: "child-v8" }), []);

  const saved = { dir: process.env.RMD_TEST_SLOT_DIR, slots: process.env.RMD_TEST_SLOTS, ctx: process.env.NODE_TEST_CONTEXT };
  t.after(() => {
    for (const [key, value] of [["RMD_TEST_SLOT_DIR", saved.dir], ["RMD_TEST_SLOTS", saved.slots], ["NODE_TEST_CONTEXT", saved.ctx]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.RMD_TEST_SLOT_DIR = "/home/node/rmd-scratch/test-slots";
  delete process.env.RMD_TEST_SLOTS;
  delete process.env.NODE_TEST_CONTEXT;
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-slot-grant-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const capture = async (tools: string[]): Promise<string[]> => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough() });
    stdin.on("finish", () => {
      stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "slot-grant" })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
      stdout.end();
      queueMicrotask(() => child.emit("exit", 0));
    });
    let captured: ContainedSpawnOptions | undefined;
    const workerHome = mkdtempSync(join(tmpdir(), "rmd-codex-slot-home-"));
    try {
      await spawnCodexWorker({
        workerHome, cwd: root, prompt: "typecheck", settingsFile: join(REPO, "settings", "worker.json"), tools,
        containment: { spawn: (options) => { captured = options; return { process: child as never, pid: 31_337 }; }, teardown: () => {} },
      }, { claudeBin: "/unused", root, workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna" } });
    } finally {
      rmSync(workerHome, { recursive: true, force: true });
    }
    assert.ok(captured);
    return captured.args;
  };
  const writer = await capture(["Read", "Write", "Edit", "Bash"]);
  assert.equal(writer[writer.indexOf("--add-dir") + 1], "/home/node/rmd-scratch/test-slots");
  assert.ok(writer.includes('shell_environment_policy.set.RMD_TEST_SLOT_DIR="/home/node/rmd-scratch/test-slots"'));
  assert.ok(writer.indexOf("--add-dir") < writer.indexOf("-C"), "the grant is an exec option, before the cwd and the prompt");
  const reader = await capture(["Read", "Bash"]);
  assert.equal(reader.includes("--add-dir"), false, "a read-only worker writes nothing, slot records included");
  assert.equal(existsSync(root), true);
});

test("each way a fleet typecheck can end names its own exit code, and a held slot heartbeats until then", async (t) => {
  const fx = typecheckTree(t);
  const lines: string[] = [];
  const ports = (spawnChild: NonNullable<Parameters<typeof runTypecheckCommand>[1]>["spawn"]) => ({
    env: fleetEnv(fx), isDir: () => false, tmp: fx.tmp, log: (line: string) => void lines.push(line), heartbeatMs: 5, spawn: spawnChild,
  });
  assert.equal(await runTypecheckCommand(fx.root, ports(() => { throw new Error("no exec"); })), 1, "a spawn that throws never ran");
  assert.equal(await runTypecheckCommand(fx.root, ports((_f, args, o) => spawn(join(fx.root, "missing-tsc"), args, o))), 1,
    "a spawn error event never ran");
  assert.equal(lines.filter((line) => line.includes("SPAWN FAILURE")).length, 2);

  let beats = 0;
  const signalled = await runTypecheckCommand(fx.root, ports((_f, _a, o) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], o);
    const timer = setInterval(() => {
      const record = readdirSync(fx.slots).find((name) => name.startsWith("slot-"));
      if (record && JSON.parse(readFileSync(join(fx.slots, record), "utf8")).heartbeatAt) beats += 1;
      if (beats >= 3) {
        clearInterval(timer);
        rmSync(join(fx.slots, record!), { force: true });
        rmSync(fx.slots, { recursive: true, force: true });
        setTimeout(() => (process.listeners("SIGTERM").at(-1) as () => void)(), 30); // the wrapper's own forwarder only
      }
    }, 10);
    return child;
  }));
  assert.equal(signalled, 143, "a forwarded SIGTERM ends tsc and the script exits 128+15");
  assert.ok(lines.some((line) => line.includes("typecheck.npm_heartbeat_failed")), "a heartbeat that cannot write says so");
  mkdirSync(fx.slots);

  const killed = await runTypecheckCommand(fx.root, ports((_f, _a, o) => {
    const child = spawn(process.execPath, ["-e", "process.kill(process.pid, 'SIGHUP')"], o);
    return child;
  }));
  assert.equal(killed, 129, "an unnamed signal still exits non-zero");
  assert.match(planTypecheckCommand(join(fx.root, "absent"), { env: fleetEnv(fx), isDir: () => false, tmp: fx.tmp }).buildInfo ?? "",
    /rmd-typecheck-[0-9a-f]{16}\.tsbuildinfo$/, "a root with no git dir keys its TMPDIR buildinfo by its spelled path");
  assert.equal(typecheckBuildInfoFor(join(fx.root, "absent"), join(fx.tmp, "missing")), undefined,
    "no git dir and a TMPDIR that is not there: nowhere to keep a buildinfo");
});
