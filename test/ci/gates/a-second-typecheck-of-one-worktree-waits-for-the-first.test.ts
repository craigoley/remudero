// W1-T15169: a second `npm run typecheck` in a worktree whose typecheck is still running waits for that one to finish.
// OBSERVED 2026-11-27 16:24Z: two native tsc runs on one fix-round worktree (4.0 and 2.5 GB) ran 25+ minutes side by
// side against one incremental buildinfo, started by two sandbox commands ~2 min apart. Every tsc here is a stub, every
// admission is injected and every tree is a fixture; the two-process cases run runTypecheck in real child processes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { acquireInflightLock } from "#src/lib/inflight-lock.js";
import { admitStaticWork, INITIAL_PID_NAMESPACE, type ReservedTreeProbeHost, type TestSlotLease } from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  installedTypescriptVersion, measuredTypecheckArgs, TYPECHECK_BUILDINFO_NAME, WORKTREE_LOCK_BEAT_MS, WORKTREE_LOCK_MISSED_BEATS,
} from "#src/lib/typecheck-buildinfo.js";
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

/** A /proc as seen from `self` (a reader in namespace `selfNs`) where the recorded namespace's init is pid 77, or absent. */
function fakeProc(selfNs: string, heldNs: string, initStart: number | undefined): ReservedTreeProbeHost {
  const stat = (pid: string, start: number) => `${pid} (node) S ${["1", ...Array(17).fill("0"), String(start), "0"].join(" ")}`;
  const files: Record<string, string> = {
    "/proc/self/ns/pid": selfNs, "/proc/self/status": "NSpid:\t1234\n", "/proc/1/ns/pid": selfNs,
    "/proc/1/status": "NSpid:\t1\n", "/proc/1/stat": stat("1", 1),
    ...(initStart === undefined ? {} : { "/proc/77/ns/pid": heldNs, "/proc/77/status": "NSpid:\t77\t1\n", "/proc/77/stat": stat("77", initStart) }),
  };
  return {
    platform: "linux", bootId: "boot-a", list: () => initStart === undefined ? ["1"] : ["1", "77"],
    read: (path) => { const body = files[path]; if (body === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" }); return body; },
  };
}

test("W1-T15169 criterion 2: a holder in another pid namespace is waited on unless that namespace is proven gone, never pid-probed", (t) => {
  const HELD_NS = "pid:[4026532001]";
  const SANDBOX_NS = "pid:[4026532002]";
  // The holder's pid reads dead from here, as a sibling sandbox's pid does: only the namespace judgment may decide.
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
  const cases = [
    { why: "a sibling sandbox (the 2026-11-27 shape): its namespace is invisible from here", self: SANDBOX_NS, initStart: 400 as number | undefined, boot: "boot-a", waits: true },
    { why: "seen from the initial namespace, its init is older than the holder: live", self: INITIAL_PID_NAMESPACE, initStart: 400, boot: "boot-a", waits: true },
    { why: "seen from the initial namespace, no process is left in it: gone", self: INITIAL_PID_NAMESPACE, initStart: undefined, boot: "boot-a", waits: false },
    { why: "its namespace id was reused by a newer init: gone", self: INITIAL_PID_NAMESPACE, initStart: 900, boot: "boot-a", waits: false },
    { why: "it was recorded under an earlier kernel boot: gone", self: SANDBOX_NS, initStart: 400, boot: "boot-old", waits: false },
  ];
  for (const c of cases) {
    const root = tree(t, "ns", true);
    const held = acquireInflightLock(join(root, ".git"), TYPECHECK_BUILDINFO_NAME, { run_id: "fixture", info: { pid: deadPid },
      extra: { pidNs: HELD_NS, bootId: c.boot, processStart: "proc:500" } });
    let sleeps = 0;
    let spawnedWhileHeld: boolean | undefined;
    const code = runTypecheck(root, [], { ...admitted, log: () => {},
      worktreeLock: { pidNamespace: () => c.self, bootId: () => "boot-a", namespaceProbe: fakeProc(c.self, HELD_NS, c.initStart),
        sleep: () => { sleeps++; held.release(); } },
      spawn: () => { spawnedWhileHeld = sleeps === 0; return { status: 0 }; } });
    assert.equal(code, 0, c.why);
    assert.equal(sleeps, c.waits ? 1 : 0, `${c.why}: ${c.waits ? "taken over" : "waited on"}`);
    assert.equal(spawnedWhileHeld, !c.waits, c.why);
  }
});

test("W1-T15169 criterion 2: a check records its pid namespace, boot id and kernel start in the lock it holds", (t) => {
  const root = tree(t, "identity", true);
  let record: Record<string, unknown> | undefined;
  let heartbeat: string | undefined;
  assert.equal(runTypecheck(root, [], { ...admitted, log: () => {},
    worktreeLock: { pidNamespace: () => "pid:[4026532009]", bootId: () => "boot-z" },
    spawn: (_file, _args, _cwd, _env, beat) => {
      heartbeat = beat;
      record = JSON.parse(readFileSync(`${buildInfoOf(root)}.lock`, "utf8")) as Record<string, unknown>;
      return { status: 0 };
    } }), 0);
  assert.equal(heartbeat, `${buildInfoOf(root)}.lock`, "tsc's observer is handed the lock to beat");
  assert.equal(record?.pid, process.pid);
  assert.equal(record?.pidNs, "pid:[4026532009]");
  assert.equal(record?.bootId, "boot-z");
  assert.match(String(record?.processStart), /^(proc|ps):/);
});

const WINDOW_MS = WORKTREE_LOCK_BEAT_MS * WORKTREE_LOCK_MISSED_BEATS;

test("W1-T15169 criterion 2: a holder in another pid namespace that keeps beating is waited on past the miss window", (t) => {
  const root = tree(t, "beating", true);
  const sandbox = fakeProc("pid:[4026532002]", "pid:[4026532001]", 400);
  const held = acquireInflightLock(join(root, ".git"), TYPECHECK_BUILDINFO_NAME, { run_id: "fixture",
    info: { pid: spawnSync(process.execPath, ["-e", ""]).pid! }, extra: { pidNs: "pid:[4026532001]", bootId: "boot-a", processStart: "proc:500" } });
  let now = 1_000_000;
  let lastBeat = now;
  let sleeps = 0;
  const polls = 2 * WORKTREE_LOCK_MISSED_BEATS + 1;
  let spawnedAfter: number | undefined;
  const code = runTypecheck(root, [], { ...admitted, log: () => {}, spawn: () => { spawnedAfter = sleeps; return { status: 0 }; },
    worktreeLock: { pidNamespace: () => "pid:[4026532002]", bootId: () => "boot-a", namespaceProbe: sandbox,
      clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() }, mtimeOf: () => lastBeat,
      // Each poll a beat's worth of time passes and the holder beats once.
      sleep: () => { sleeps++; now += WORKTREE_LOCK_BEAT_MS; lastBeat = now; if (sleeps === polls) held.release(); } } });
  assert.equal(code, 0);
  assert.ok(polls * WORKTREE_LOCK_BEAT_MS > WINDOW_MS, "the wait outlasted the miss window");
  assert.equal(spawnedAfter, polls, "tsc started only once the beating holder let go");
});

test("W1-T15169 criterion 2: a holder whose beats stopped is taken over once the miss window passes, in any pid namespace", (t) => {
  const holders = [
    { why: "a sibling sandbox, SIGKILLed", pid: spawnSync(process.execPath, ["-e", ""]).pid!,
      extra: { pidNs: "pid:[4026532001]", bootId: "boot-a", processStart: "proc:500" } as Record<string, string> },
    { why: "a live pid in this namespace that stopped beating", pid: process.pid, extra: {} as Record<string, string> },
  ];
  for (const holder of holders) {
    const root = tree(t, "silent", true);
    acquireInflightLock(join(root, ".git"), TYPECHECK_BUILDINFO_NAME, { run_id: "fixture", info: { pid: holder.pid }, extra: holder.extra });
    let now = 1_000_000;
    const lastBeat = now;
    let sleeps = 0;
    const lines: string[] = [];
    const code = runTypecheck(root, [], { ...admitted, log: (line) => lines.push(line), spawn: () => ({ status: 0 }),
      worktreeLock: { pidNamespace: () => "pid:[4026532002]", bootId: () => "boot-a", namespaceProbe: fakeProc("pid:[4026532002]", "pid:[4026532001]", 400),
        clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() }, mtimeOf: () => lastBeat,
        isPidAlive: (pid) => pid === process.pid,
        sleep: () => { if (++sleeps > 1_000) throw new Error(`${holder.why}: waited forever on a silent holder`); now += WORKTREE_LOCK_BEAT_MS; } } });
    assert.equal(code, 0, holder.why);
    assert.equal(sleeps, WORKTREE_LOCK_MISSED_BEATS + 1, `${holder.why}: taken over on the first poll past the window`);
    const row = steps(lines).find((r) => r.step === "typecheck.waited_for_worktree");
    assert.deepEqual([row?.holderPid, row?.beatMs, row?.missedBeats], [holder.pid, WORKTREE_LOCK_BEAT_MS, WORKTREE_LOCK_MISSED_BEATS], holder.why);
  }
});

test("W1-T15169 criterion 2: tsc's observer beats the lock it is handed, and only that one", (t) => {
  const dir = eventsDir(t);
  const lock = join(dir, "worktree.lock");
  const other = join(dir, "other.lock");
  for (const path of [lock, other]) { writeFileSync(path, "{}"); utimesSync(path, 1_000, 1_000); }
  const run = (heartbeat?: string) => spawnSync(process.execPath,
    measuredTypecheckArgs("capture", process.execPath, ["-e", "setTimeout(() => {}, 50)"], heartbeat),
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe", "pipe"], timeout: 60_000 });
  assert.equal(run().status, 0);
  assert.equal(statSync(lock).mtimeMs, 1_000_000, "no lock named, none beaten");
  const result = run(lock);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(statSync(lock).mtimeMs > 1_000_000, "the observer beat the lock while its child ran");
  assert.equal(statSync(other).mtimeMs, 1_000_000);
});

test("W1-T15169 criterion 2: a holder waiting for its memory admission keeps beating its lock", (t) => {
  const root = tree(t, "admission", true);
  const slots = join(root, "slots");
  mkdirSync(slots);
  const lockPath = `${buildInfoOf(root)}.lock`;
  // A live peer's recorded peak is what a short headroom must hold beside, so the check waits until it reads roomy.
  const peer = admitStaticWork("peer", { dir: slots, memoryBytes: 1024 ** 3, memoryHeadroom: () => 64 * 1024 ** 3, log: () => {} });
  t.after(() => peer.release());
  for (const lost of [false, true]) {
    let calls = 0;
    let beatenBetween: boolean | undefined;
    const code = runTypecheck(root, [], { log: () => {}, spawn: () => ({ status: 0 }),
      testSlot: { dir: slots, memoryHeadroom: () => calls >= 2 ? 64 * 1024 ** 3 : 0, pollMs: 1, waitBoundMs: 60_000, log: () => {},
        sleep: () => {
          calls++;
          if (calls === 1) { if (lost) unlinkSync(lockPath); else utimesSync(lockPath, 1_000, 1_000); }
          if (calls === 2 && !lost) beatenBetween = statSync(lockPath).mtimeMs > 1_000_000;
        } } });
    assert.equal(code, 0, `lost=${lost}`);
    assert.ok(calls >= 2, `lost=${lost}: the admission waited (${calls} polls)`);
    if (!lost) assert.equal(beatenBetween, true, "the admission wait beat the lock between polls");
  }
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
