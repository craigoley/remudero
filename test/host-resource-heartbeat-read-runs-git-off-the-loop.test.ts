import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  gitHeartbeatSource,
  readSamples,
  runHostResourcePass,
  runHostResourcePassAsync,
  samplesPath,
  startHostResourceGardener,
  type HeartbeatRead,
  type HostResourcePorts,
} from "../src/lib/host-resource-gardener.js";
import { gitRepo } from "./helpers/git-repo.js";

const REF_PREFIX = "refs/remotes/origin/heartbeat-";
const FETCH_ARGS = ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/heartbeat-*:refs/remotes/origin/heartbeat-*"];

function fixtures() {
  const origin = gitRepo({ bare: true, kind: "heartbeat-origin" });
  const writer = gitRepo({ kind: "heartbeat-writer" });
  const reader = gitRepo({ kind: "heartbeat-reader" });
  const stamp = new Date().toISOString();
  writer.addRemote("origin", origin.dir);
  reader.addRemote("origin", origin.dir);
  for (const [host, free] of [["azure", 40_000_000], ["mini-west", 30_000_000]] as const) {
    writeFileSync(join(writer.dir, "heartbeat.txt"), `beat_ts=${stamp}\nroot_fs_free_kb=${free}\nroot_fs_total_kb=130000000\nswap_used_kb=800000\n`);
    writer.git("add", "heartbeat.txt");
    writer.git("commit", "--quiet", "-m", `heartbeat ${host}`);
    writer.git("push", "--quiet", "origin", `HEAD:refs/heads/heartbeat-${host}`);
  }
  writer.git("rm", "heartbeat.txt");
  writer.git("commit", "--quiet", "-m", "branch with no published heartbeat payload");
  writer.git("push", "--quiet", "origin", "HEAD:refs/heads/heartbeat-empty");
  return { origin, reader, stamp };
}

function ports(stateDir: string, readHeartbeats: HostResourcePorts["readHeartbeats"], nowMs = Date.now()): HostResourcePorts {
  mkdirSync(stateDir, { recursive: true });
  return { stateDir, readHeartbeats, clock: fixedClock(nowMs), log: () => {}, planOrigins: () => [] };
}

/** The pre-change native algorithm, using a separate owned reader and the same origin. */
function syncSource(repoRoot: string): HeartbeatRead[] {
  const git = (args: string[]) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", timeout: 60_000 });
  git(FETCH_ARGS);
  const refs = git(["for-each-ref", "--format=%(refname)", `${REF_PREFIX}*`]).split("\n").filter(Boolean);
  const out: HeartbeatRead[] = [];
  for (const ref of refs) {
    try { out.push({ host: ref.slice(REF_PREFIX.length), payload: git(["show", `${ref}:heartbeat.txt`]) }); }
    catch (error) {
      assert.match(String((error as { stderr?: string }).stderr), /path 'heartbeat.txt' does not exist/);
    }
  }
  return out;
}

test("W1-T5002: a timer keeps firing while the heartbeat read waits on git", async () => {
  const { reader } = fixtures();
  const entered = join(reader.dir, "upload-pack-entered");
  const release = join(reader.dir, "upload-pack-release");
  const releasedBy = join(reader.dir, "upload-pack-released-by");
  const wrapper = join(reader.dir, "rmd-upload-pack");
  // A real Git transport waits for a parent-loop witness, not a CPU-speed timing threshold.
  // The child's finite backstop lets the synchronous falsifier finish and report zero ticks.
  writeFileSync(wrapper, `#!${process.execPath}\n` + [
    'const {existsSync,writeFileSync}=require("node:fs");',
    'const {spawn}=require("node:child_process");',
    `writeFileSync(${JSON.stringify(entered)}, "entered");`,
    'let finished=false;let polling;let backstop;',
    'const finish=(by)=>{if(finished)return;finished=true;clearInterval(polling);clearTimeout(backstop);',
    `writeFileSync(${JSON.stringify(releasedBy)},by);`,
    'const child=spawn("git",["upload-pack",...process.argv.slice(2)],{stdio:"inherit"});',
    'child.on("error",()=>process.exit(1));child.on("exit",code=>process.exit(code??1));};',
    `polling=setInterval(()=>{if(existsSync(${JSON.stringify(release)}))finish("parent");},10);`,
    'backstop=setTimeout(()=>finish("backstop"),1000);',
  ].join("\n") + "\n", { mode: 0o700 });
  reader.git("config", "remote.origin.uploadpack", `'${wrapper.replaceAll("'", "'\\''")}'`);
  let ticks = 0;
  const timer = setInterval(() => {
    if (!existsSync(entered)) return;
    ticks++;
    writeFileSync(release, "release the real Git transport");
  }, 5);
  try {
    const beats = await gitHeartbeatSource(reader.dir)();
    assert.equal(readFileSync(entered, "utf8"), "entered", "positive native transport witness");
    assert.equal(beats.length, 2, "the awaited transport completed real heartbeat fetch/show operations");
    assert.ok(ticks > 0, "the parent timer must fire while native Git is waiting");
    assert.equal(readFileSync(releasedBy, "utf8"), "parent", "completion must come from the parent, not the child's backstop");
  } finally { clearInterval(timer); }
});

test("W1-T5002: an async heartbeat read yields the same samples as the sync one", async () => {
  const { origin, reader, stamp } = fixtures();
  const legacy = gitRepo({ kind: "heartbeat-sync-reader" });
  legacy.addRemote("origin", origin.dir);
  const syncBeats = syncSource(legacy.dir);
  const asyncBeats = await gitHeartbeatSource(reader.dir)();
  assert.deepEqual(asyncBeats, syncBeats, "including payload bytes, host order and the absent-payload branch");
  assert.deepEqual(asyncBeats.map(beat => beat.host), ["azure", "mini-west"]);
  const nowMs = Date.parse(stamp) + 60_000;
  const syncDir = join(legacy.dir, "state");
  const asyncDir = join(reader.dir, "state");
  const before = runHostResourcePass(ports(syncDir, () => syncBeats, nowMs));
  const after = await runHostResourcePassAsync(ports(asyncDir, gitHeartbeatSource(reader.dir), nowMs));
  assert.deepEqual(after, before);
  assert.equal(after.appended, 2, "positive sample-population control");
  assert.deepEqual(readSamples(asyncDir), readSamples(syncDir));
});

test("W1-T5002: a failed real heartbeat fetch refuses sampling rather than certifying an empty population", async () => {
  const reader = gitRepo({ kind: "heartbeat-no-origin" });
  const stateDir = join(reader.dir, "state");
  await assert.rejects(runHostResourcePassAsync(ports(stateDir, gitHeartbeatSource(reader.dir))), /fetching heartbeat branches failed:/);
  assert.equal(existsSync(samplesPath(stateDir)), false);
});

async function withNativeGitFault(readerDir: string, mode: "listing" | "show" | "show-command", run: () => Promise<void>): Promise<void> {
  const nativeGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(readerDir, "rmd-git-fault-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!${process.execPath}\n` + [
    'const {spawnSync}=require("node:child_process");const{writeFileSync}=require("node:fs");const{join}=require("node:path");',
    'const args=process.argv.slice(2);',
    `if(args[2]==="for-each-ref" && ${JSON.stringify(mode)}==="listing")args.push("--rmd-invalid");`,
    `if(args[2]==="show" && ${JSON.stringify(mode)}==="show-command")args.splice(3,0,"--rmd-invalid");`,
    `const native=spawnSync(${JSON.stringify(nativeGit)},args,{encoding:"utf8"});`,
    `if(args[2]==="for-each-ref" && native.status===0 && ${JSON.stringify(mode)}==="show"){`,
    'writeFileSync(join(args[1],".git/refs/remotes/origin/heartbeat-azure"),"f".repeat(40)+"\\n");}',
    'process.stdout.write(native.stdout??"");process.stderr.write(native.stderr??"");process.exit(native.status??1);',
  ].join("\n") + "\n", { mode: 0o700 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath ?? ""}`;
  try { await run(); }
  finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
}

test("W1-T5002: a native failed ref listing is refused rather than returned as an empty heartbeat population", async () => {
  const { reader } = fixtures();
  await withNativeGitFault(reader.dir, "listing", async () => {
    await assert.rejects(gitHeartbeatSource(reader.dir)(), error => {
      const native = error as { code?: number; stderr?: string };
      return native.code === 129 && /unknown option.*rmd-invalid/.test(native.stderr ?? "");
    });
  });
});

test("W1-T5002: a corrupt native heartbeat ref is not treated as a branch without a payload", async () => {
  const { reader } = fixtures();
  await withNativeGitFault(reader.dir, "show", async () => {
    await assert.rejects(gitHeartbeatSource(reader.dir)(), error => {
      const native = error as { code?: number; stderr?: string };
      return native.code === 128 && /Not a valid object name.*heartbeat-azure/.test(native.stderr ?? "");
    });
  });
});

test("W1-T5002: a missing real Git executable retains its native spawn refusal", async () => {
  const reader = gitRepo({ kind: "heartbeat-spawn-refusal" });
  const priorPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(gitHeartbeatSource(reader.dir)(), error => {
      const reported = error as Error;
      return /fetching heartbeat branches failed:/.test(reported.message) && (reported.cause as { code?: string })?.code === "ENOENT";
    });
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
});

test("W1-T5002: an unexpected native show failure keeps its error instead of dropping a host", async () => {
  const { reader } = fixtures();
  await withNativeGitFault(reader.dir, "show-command", async () => {
    await assert.rejects(gitHeartbeatSource(reader.dir)(), error => {
      const native = error as { code?: number; stderr?: string };
      return native.code === 128 && /unrecognized argument.*--rmd-invalid/.test(native.stderr ?? "");
    });
  });
});

test("W1-T5002: an asynchronous heartbeat port is awaited and its failure retains the native cause", async () => {
  const repo = gitRepo({ kind: "heartbeat-async-port" });
  const native = new Error("read failed");
  await assert.rejects(runHostResourcePassAsync(ports(join(repo.dir, "state"), () => Promise.reject(native))), error => error === native);
  const result = await runHostResourcePassAsync(ports(join(repo.dir, "state"), () => Promise.resolve([])));
  assert.equal(result.appended, 0);
});

test("W1-T5002: the standalone timer keeps one asynchronous read in flight and recovers after rejection", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const repo = gitRepo({ kind: "heartbeat-timer" });
  let nowMs = Date.now(), reads = 0;
  let rejectRead!: (error: Error) => void;
  const rows: string[] = [];
  const p = ports(join(repo.dir, "state"), () => {
    reads++;
    if (reads === 1) return new Promise<HeartbeatRead[]>((_resolve, reject) => { rejectRead = reject; });
    return Promise.resolve([]);
  });
  p.clock = { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() };
  p.log = step => rows.push(step);
  const handle = startHostResourceGardener(p, 1_000);
  try {
    assert.equal(reads, 1);
    nowMs += 6 * 60_000;
    t.mock.timers.tick(1_000);
    assert.equal(reads, 1, "elapsed cadence cannot admit a second pending read");
    rejectRead(new Error("async transport failure"));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(rows, ["host_resource.failed"]);
    t.mock.timers.tick(1_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reads, 2, "guard releases only after the awaited failed pass closes");
    assert.deepEqual(rows, ["host_resource.failed"]);
  } finally { handle.stop(); }
});
