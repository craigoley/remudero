// W1-T15169: a second `npm run typecheck` in a worktree whose typecheck is still running waits for that one to finish.
// OBSERVED 2026-11-27 16:24Z: two native tsc runs on one fix-round worktree (4.0 and 2.5 GB) ran 25+ minutes side by
// side against one incremental buildinfo, started by two sandbox commands ~2 min apart. Every tsc here is a stub, every
// admission is injected and every tree is a fixture; the two-process cases run runTypecheck in real child processes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import type { TestSlotLease } from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { installedTypescriptVersion, TYPECHECK_BUILDINFO_NAME } from "#src/lib/typecheck-buildinfo.js";
import { runTypecheck, type TypecheckRunOptions } from "#src/lib/typecheck-run.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const lease = (): TestSlotLease => ({ outcome: "acquired", concurrency: 1, waitedMs: 0, note: "", refresh: () => {}, release: () => {} });
const admitted: Pick<TypecheckRunOptions, "acquireSlot" | "testSlot"> = { acquireSlot: lease, testSlot: { memoryHeadroom: () => undefined } };

/** A checkout with a plain `.git` dir and this repo's install linked in; cold (no buildinfo) unless `warm`. */
function tree(t: TestContext, name: string, warm = false): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t15169-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  if (warm) writeFileSync(buildInfoOf(root), usableBuildInfo(root));
  writeLedger([], { dir: join(root, "state"), scope: t });
  return root;
}

const buildInfoOf = (root: string): string => join(root, ".git", TYPECHECK_BUILDINFO_NAME);
const usableBuildInfo = (root: string): string =>
  JSON.stringify({ version: installedTypescriptVersion(root), fileNames: ["a.ts"], fileInfos: ["hash"] });

const steps = (lines: string[]): Array<Record<string, unknown>> => lines.flatMap((line) => {
  try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
});

interface CheckSpec {
  root: string;
  name: string;
  events: string;
  status: number;
  /** tsc (the stub) runs until this file exists, then writes a usable buildinfo, as a real first check would. */
  gate?: string;
}

/** One `npm run typecheck` in its own process; its stub tsc and its lock waits append to `events`. */
function startCheck(spec: CheckSpec): Promise<{ code: number; lines: string[]; stderr: string }> {
  const program = `
    import { appendFileSync, existsSync, writeFileSync } from "node:fs";
    import { dirname } from "node:path";
    const spec = ${JSON.stringify(spec)};
    const { runTypecheck } = await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, "src/lib/typecheck-run.ts")).href)});
    const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const lines = [];
    const lease = { outcome: "acquired", concurrency: 1, waitedMs: 0, note: "", refresh() {}, release() {} };
    const code = runTypecheck(spec.root, [], {
      acquireSlot: () => lease, testSlot: { memoryHeadroom: () => undefined }, log: (line) => lines.push(line),
      worktreeLock: { sleep: () => { appendFileSync(spec.events, spec.name + " waiting\\n"); pause(20); } },
      spawn: () => {
        appendFileSync(spec.events, spec.name + " start\\n");
        const until = Date.now() + 90000;
        while (spec.gate && !existsSync(spec.gate) && existsSync(dirname(spec.gate)) && Date.now() < until) pause(20);
        if (spec.gate) writeFileSync(${JSON.stringify(buildInfoOf(spec.root))}, ${JSON.stringify(usableBuildInfo(REPO_ROOT))});
        appendFileSync(spec.events, spec.name + " end\\n");
        return { status: spec.status };
      },
    });
    console.log("CHECK_RESULT " + JSON.stringify({ code, lines }));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program],
      { cwd: REPO_ROOT, env: { ...process.env, NODE_TEST_CONTEXT: "child" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", () => {
      const line = stdout.split("\n").find((l) => l.startsWith("CHECK_RESULT "));
      if (line === undefined) { reject(new Error(`${spec.name} printed no result\n${stdout}\n${stderr}`)); return; }
      resolve({ ...(JSON.parse(line.slice("CHECK_RESULT ".length)) as { code: number; lines: string[] }), stderr });
    });
  });
}

/** The events file and the gate live here; a gated child also stops waiting once it is gone. */
function eventsDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t15169-events-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const eventsOf = (path: string): string[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];

/** Wait until `events` holds a line matching `pattern`; fails loudly past a generous bound (child start-up under tsx). */
async function until(path: string, pattern: RegExp, what: string): Promise<string[]> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const lines = eventsOf(path);
    if (lines.some((line) => pattern.test(line))) return lines;
    if (Date.now() > deadline) throw new Error(`${what} never happened; events:\n${lines.join("\n")}`);
    await delay(25);
  }
}

test("W1-T15169 criterion 1: a second runTypecheck on a held root spawns no tsc until the first exits, then runs once warm with its own status", async (t) => {
  const root = tree(t, "one");
  const dir = eventsDir(t);
  const events = join(dir, "events");
  const gate = join(dir, "gate");
  t.after(() => { if (existsSync(dir)) writeFileSync(gate, ""); }); // a failed assertion still lets the gated child finish
  const first = startCheck({ root, name: "first", events, status: 0, gate });
  await until(events, /^first start$/, "the first check's tsc start");
  const second = startCheck({ root, name: "second", events, status: 3 });
  const seen = await until(events, /^second (start|waiting)$/, "the second check reaching tsc or the lock");
  assert.ok(!seen.includes("second start"), `the second check spawned tsc beside the first:\n${seen.join("\n")}`);
  writeFileSync(gate, "");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 3, `the second check returns its own tsc status\n${b.stderr}`);
  const order = eventsOf(events).filter((line) => !line.endsWith("waiting"));
  assert.deepEqual(order, ["first start", "first end", "second start", "second end"], "one tsc at a time, the second once");
  assert.deepEqual(steps(a.lines).map((row) => row.step), ["typecheck.cold"]);
  assert.deepEqual(steps(b.lines).map((row) => row.step), ["typecheck.waited_for_worktree", "typecheck.warm"],
    "the second read the buildinfo the first wrote, after the wait");
  assert.equal(existsSync(`${buildInfoOf(root)}.lock`), false, "both released the lock");
});

test("W1-T15169 criterion 2: a lock whose holder pid is gone, or reused by a newer process, is taken over and never waited on", (t) => {
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.ok(typeof dead === "number" && dead > 0);
  const holders = [
    { why: "pid gone", pid: dead, startedAt: new Date().toISOString() },
    { why: "pid reused by a newer process", pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" },
  ];
  for (const holder of holders) {
    const root = tree(t, "stale", true);
    acquireInflightLock(join(root, ".git"), TYPECHECK_BUILDINFO_NAME, { run_id: "fixture", info: { pid: holder.pid, startedAt: holder.startedAt } });
    assert.equal(existsSync(`${buildInfoOf(root)}.lock`), true, "the fixture lock is on disk");
    let sleeps = 0;
    let spawns = 0;
    const lines: string[] = [];
    const code = runTypecheck(root, [], { ...admitted, log: (line) => lines.push(line), worktreeLock: { sleep: () => { sleeps++; } },
      spawn: () => { spawns++; return { status: 0 }; } });
    assert.equal(code, 0, `${holder.why}\n${lines.join("\n")}`);
    assert.equal(sleeps, 0, `${holder.why}: the stale lock was waited on`);
    assert.equal(spawns, 1, holder.why);
    assert.ok(!steps(lines).some((row) => row.step === "typecheck.waited_for_worktree"), holder.why);
    assert.equal(existsSync(`${buildInfoOf(root)}.lock`), false, `${holder.why}: the taken-over lock was released`);
  }
});

test("W1-T15169 criterion 2: a live holder is waited on, so the take-over is the staleness check and not an ignored lock", (t) => {
  const root = tree(t, "live", true);
  const held = acquireInflightLock(join(root, ".git"), TYPECHECK_BUILDINFO_NAME, { run_id: "fixture" });
  let sleeps = 0;
  let spawnedWhileHeld = false;
  const code = runTypecheck(root, [], { ...admitted, log: () => {},
    worktreeLock: { sleep: () => { sleeps++; if (sleeps === 2) held.release(); } },
    spawn: () => { spawnedWhileHeld = existsSync(held.path) && sleeps < 2; return { status: 0 }; } });
  assert.equal(code, 0);
  assert.equal(sleeps, 2, "it polled the live holder until it let go");
  assert.equal(spawnedWhileHeld, false);
});

test("W1-T15169 criterion 3: runTypecheck on two different worktrees runs both at once", async (t) => {
  const one = tree(t, "a");
  const two = tree(t, "b");
  const dir = eventsDir(t);
  const events = join(dir, "events");
  const gate = join(dir, "gate");
  t.after(() => { if (existsSync(dir)) writeFileSync(gate, ""); }); // a failed assertion still lets the gated child finish
  const first = startCheck({ root: one, name: "first", events, status: 0, gate });
  await until(events, /^first start$/, "the first check's tsc start");
  const second = startCheck({ root: two, name: "second", events, status: 0 });
  const b = await second;
  const during = eventsOf(events);
  writeFileSync(gate, "");
  const a = await first;
  assert.deepEqual(during, ["first start", "second start", "second end"], "the other tree's check ran while the first held its own");
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.deepEqual(steps(b.lines).map((row) => row.step), ["typecheck.cold"], "no wait, and the same cold admission as before");
});

test("W1-T15169 criterion 4: the waiting run writes one typecheck.waited_for_worktree row naming the holder pid and its wait", (t) => {
  const root = tree(t, "row", true);
  const holderPid = spawnSync(process.execPath, ["-e", ""]).pid!;
  acquireInflightLock(join(root, ".git"), TYPECHECK_BUILDINFO_NAME, { run_id: "fixture", info: { pid: holderPid } });
  let probes = 0;
  const lines: string[] = [];
  // The holder reads alive for two polls, then gone: the run waits on the real sleep, then takes the lock over.
  const code = runTypecheck(root, [], { ...admitted, log: (line) => lines.push(line),
    worktreeLock: { pollMs: 5, isPidAlive: () => ++probes <= 2 }, spawn: () => ({ status: 0 }) });
  assert.equal(code, 0, lines.join("\n"));
  const rows = steps(lines).filter((row) => row.step === "typecheck.waited_for_worktree");
  assert.equal(rows.length, 1, lines.join("\n"));
  assert.equal(rows[0]!.holderPid, holderPid);
  assert.equal(typeof rows[0]!.waitedMs, "number");
  assert.ok((rows[0]!.waitedMs as number) >= 5, "it waited at least one poll");
  const quiet: string[] = [];
  assert.equal(runTypecheck(root, [], { ...admitted, log: (line) => quiet.push(line), spawn: () => ({ status: 0 }) }), 0);
  assert.ok(!steps(quiet).some((row) => row.step === "typecheck.waited_for_worktree"), "a run that never waited writes none");
});
