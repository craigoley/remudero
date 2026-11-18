/**
 * W1-T13434 — A PINNED GIT CALL FORKS THROUGH THE SPAWN HELPER.
 *
 * hostWorktreeGitAsync forked its git child from the daemon because it wrote stdin through `.child`. The helper carries
 * stdin as `input`, so with a healthy helper and routable options both the pinned config read and the git command are
 * helper requests, and the daemon pays only a pipe write. Real git, a real temporary repository, a real helper.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { LoopBoundedChildTimeout } from "#src/lib/loop-bounded-child.js";
import { execFileRouted, HELPER_SOURCE, installSpawnHelper, startSpawnHelper, type SpawnHelper, type SpawnRequest } from "#src/lib/spawn-helper.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { hostWorktreeGitAsync, WorktreeConfigRefusedError, type HostWorktreeGitOptions } from "#src/lib/worktree-git.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const SAVED = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "SSH_ASKPASS"] as const;
const saved = new Map(SAVED.map((k) => [k, process.env[k]] as const));
const LARGE_INPUT = "ignored\n".repeat(512 * 1024);

let root: string;
let repo: GitRepo;
let shimBin: string;
let runsFile: string;
let started: SpawnHelper[] = [];

/** A `git` first on PATH that records each run, sleeps `W1_T13434_SLEEP` seconds, then runs the real git. */
function writeGitShim(): void {
  const realGit = childProcess.execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  shimBin = join(root, "bin");
  mkdirSync(shimBin);
  writeFileSync(join(shimBin, "git"), `#!/bin/sh\necho run >> "${runsFile}"\n[ -n "$W1_T13434_SLEEP" ] && sleep "$W1_T13434_SLEEP"\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shimBin, "git"), 0o755);
}

const shimEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: `${shimBin}:${process.env.PATH ?? ""}`, ...extra });
const gitRuns = (): number => (existsSync(runsFile) ? readFileSync(runsFile, "utf8").split("\n").filter(Boolean).length : 0);

before(() => {
  root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13434-`));
  const globalEmpty = join(root, "global-empty");
  writeFileSync(globalEmpty, "");
  for (const k of ["GIT_ASKPASS", "SSH_ASKPASS"] as const) delete process.env[k];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalEmpty, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  runsFile = join(root, "git-runs");
  writeGitShim();
  repo = gitRepo({ kind: "t13434-routed-git" });
});

afterEach(() => {
  installSpawnHelper(undefined);
  for (const helper of started) helper.stop();
  started = [];
  rmSync(runsFile, { force: true });
});

after(() => {
  for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(root, { recursive: true, force: true });
});

type Seen = { requests: SpawnRequest[]; direct: Array<{ file: string; reason: string }> };

/** A real helper, installed, whose requests and direct notes the test sees. */
function installCounted(source?: string): Seen & { helper: SpawnHelper } {
  const real = startSpawnHelper(source === undefined ? {} : { source });
  started.push(real);
  const seen: Seen = { requests: [], direct: [] };
  const helper: SpawnHelper = {
    pid: real.pid,
    unhealthy: () => real.unhealthy(),
    run: (request) => { seen.requests.push(request); return real.run(request); },
    noteDirect: (file, syncMs, reason) => { seen.direct.push({ file, reason }); real.noteDirect(file, syncMs, reason); },
    stop: () => real.stop(),
  };
  installSpawnHelper(helper);
  return { ...seen, helper };
}

/** Counts daemon-side forks: ChildProcess.prototype.spawn and the synchronous child_process calls. */
function countForks(): { async: () => number; sync: () => number; restore: () => void } {
  const proto = childProcess.ChildProcess.prototype as unknown as { spawn: (...a: unknown[]) => unknown };
  const spawn = proto.spawn;
  let asyncForks = 0;
  let syncForks = 0;
  proto.spawn = function counted(this: unknown, ...a: unknown[]) { asyncForks++; return spawn.apply(this, a); };
  const cp = (childProcess as unknown as { default: Record<string, (...a: unknown[]) => unknown> }).default;
  const originals = new Map<string, (...a: unknown[]) => unknown>();
  for (const name of ["execFileSync", "execSync", "spawnSync"]) {
    const original = cp[name]!;
    originals.set(name, original);
    cp[name] = (...a: unknown[]) => { syncForks++; return original(...a); };
  }
  syncBuiltinESMExports();
  return {
    async: () => asyncForks,
    sync: () => syncForks,
    restore: () => {
      proto.spawn = spawn;
      for (const [name, original] of originals) cp[name] = original;
      syncBuiltinESMExports();
    },
  };
}

async function rejection(call: Promise<unknown>): Promise<Error & { code?: unknown }> {
  try {
    await call;
  } catch (error) {
    return error as Error & { code?: unknown };
  }
  assert.fail("the call resolved; it must reject");
}

const gitRequests = (seen: Seen): SpawnRequest[] => seen.requests.filter((r) => r.args?.[0] === "-C");

/** Runs `call` with process.stdout.write captured; returns what it wrote and the call's result. */
async function capturingStdout(call: () => Promise<string>): Promise<{ out: string; written: string }> {
  const write = process.stdout.write;
  let written = "";
  process.stdout.write = ((chunk: unknown) => { written += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    return { out: await call(), written };
  } finally {
    process.stdout.write = write;
  }
}

describe("a pinned git call forks through the spawn helper", () => {
  it("W1-T13434 criterion 1: the config read and the git command are 2 helper requests, input carried, stdout as direct", async () => {
    const credential = "protocol=https\nhost=example.invalid\nusername=fixture-user\npassword=fixture-pass\n\n";
    const direct = {
      pipe: await hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"]),
      ignore: await hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"], { stdio: "ignore" }),
      inherit: await capturingStdout(() => hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"], { stdio: "inherit-stdout" })),
      fill: await hostWorktreeGitAsync(repo.dir, ["credential", "fill"], { input: credential }),
    };
    const seen = installCounted();
    assert.equal(await hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"]), direct.pipe);
    assert.equal(seen.requests.length, 2, "a pipe call is 2 helper requests");
    assert.deepEqual(seen.requests[0]!.args, ["config", "--list", "--show-scope", "--null", "--no-includes"]);
    const git = seen.requests[1]!;
    assert.equal(git.file, "git");
    assert.deepEqual(git.args, ["-C", repo.dir, "rev-parse", "HEAD"]);
    assert.equal(git.cwd, repo.dir);
    assert.ok(String(git.env?.GIT_DIR).length > 0 && git.env?.GIT_WORK_TREE === repo.dir, "the pinned env goes with it");
    assert.ok(Number(git.env?.GIT_CONFIG_COUNT) > 0, "the hardening overrides go with it");
    assert.equal(git.input, undefined);
    assert.equal(await hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"], { stdio: "ignore" }), direct.ignore);
    const inherit = await capturingStdout(() => hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"], { stdio: "inherit-stdout" }));
    assert.deepEqual(inherit, direct.inherit);
    assert.equal(seen.requests.length, 6, "ignore and inherit-stdout are 2 requests each");
    assert.equal(await hostWorktreeGitAsync(repo.dir, ["credential", "fill"], { input: credential }), direct.fill);
    assert.equal(seen.requests.length, 8);
    assert.equal(seen.requests[7]!.input, credential, "the caller's input rides the git request");
    assert.deepEqual(seen.direct, [], "nothing ran directly");
  });

  it("W1-T13434 criterion 2: a routed call makes 0 daemon forks and a 20 ms timer keeps firing while git runs 1 s", async () => {
    const seen = installCounted();
    const forks = countForks();
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(performance.now()), 20);
    let out: string;
    const began = performance.now();
    try {
      out = await hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"], { env: shimEnv({ W1_T13434_SLEEP: "1" }) });
    } finally {
      clearInterval(timer);
      forks.restore();
    }
    const elapsed = performance.now() - began;
    assert.equal(out.trim(), repo.git("rev-parse", "HEAD"));
    assert.equal(forks.async(), 0, "no ChildProcess.prototype.spawn in the daemon");
    assert.equal(forks.sync(), 0, "no synchronous child_process call in the daemon");
    assert.equal(gitRequests(seen).length, 1);
    assert.equal(gitRuns(), 1, "the shim proves git ran in the helper");
    assert.ok(elapsed >= 1000, `git held its child for one second (${elapsed} ms)`);
    assert.ok(ticks.length >= 25, `the 20 ms timer kept firing: ${ticks.length} ticks in ${Math.round(elapsed)} ms`);
  });

  it("W1-T13434 criterion 3: a routed failure rejects as the direct one does; exit 0 without reading input keeps stdout", async () => {
    const cases: Array<{ name: string; args: string[]; opts: HostWorktreeGitOptions }> = [
      { name: "nonzero exit", args: ["rev-parse", "--verify", "no-such-ref-w1-t13434"], opts: {} },
      { name: "maxBuffer", args: ["log", "-p"], opts: { maxBuffer: 16 } },
      { name: "timeout", args: ["rev-parse", "HEAD"], opts: { timeout: 200, env: shimEnv({ W1_T13434_SLEEP: "1" }) } },
    ];
    const direct = new Map<string, Error & { code?: unknown }>();
    for (const c of cases) direct.set(c.name, await rejection(hostWorktreeGitAsync(repo.dir, c.args, c.opts)));
    const seen = installCounted();
    for (const c of cases) {
      const want = direct.get(c.name)!;
      const got = await rejection(hostWorktreeGitAsync(repo.dir, c.args, c.opts));
      assert.equal(got.constructor, want.constructor, `${c.name}: the same error class`);
      assert.equal(got.message.split("\n")[0], want.message.split("\n")[0], `${c.name}: the same message start`);
      assert.equal(got.code, want.code, `${c.name}: the same code`);
    }
    assert.match(direct.get("nonzero exit")!.message, new RegExp(`^Command failed: git -C ${repo.dir} rev-parse`));
    assert.equal(direct.get("maxBuffer")!.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    assert.ok(direct.get("timeout") instanceof LoopBoundedChildTimeout);
    assert.equal(gitRequests(seen).length, cases.length, "each failure was a routed request");
    const out = await hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"], { input: LARGE_INPUT });
    assert.equal(out.trim(), repo.git("rev-parse", "HEAD"));
    assert.equal(gitRequests(seen).length, cases.length + 1);
  });

  it("W1-T13434 criterion 4: a helper death in flight rejects once; no helper, unhealthy or latin1 runs direct; a refusal throws first", async () => {
    // A helper that answers the config read, then runs the git request and dies before it answers.
    const dying = HELPER_SOURCE.replace("rl.on(\"line\", (line) => {", `rl.on("line", (line) => {
  const peek = JSON.parse(line);
  if (peek.args[0] === "-C") { try { cp.execFileSync(peek.file, peek.args, { env: peek.env, stdio: "ignore" }); } catch {} process.exit(1); }`);
    const lost = installCounted(dying);
    const error = await rejection(hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"], { env: shimEnv() }));
    assert.equal(error.code, "helper_died_in_flight");
    assert.equal(gitRequests(lost).length, 1, "the request is never sent again");
    assert.equal(gitRuns(), 1, "git ran once");
    installSpawnHelper(undefined);
    rmSync(runsFile, { force: true });
    // The seam's own direct fallbacks still feed `input` to the child.
    assert.equal((await execFileRouted("sh", ["-c", "cat"], { encoding: "utf8", input: "fed" })).stdout, "fed");

    const head = repo.git("rev-parse", "HEAD");
    const forks = countForks();
    try {
      assert.equal((await hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"], { env: shimEnv() })).trim(), head);
      assert.equal(forks.async(), 2, "no helper: the config read and git fork here, as at origin/main");
    } finally {
      forks.restore();
    }
    const sick = installCounted();
    sick.helper.stop();
    assert.equal((await hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"], { env: shimEnv() })).trim(), head);
    assert.equal(gitRequests(sick).length, 0, "an unhealthy helper gets no git request");
    assert.deepEqual(sick.direct.map((d) => [d.file, d.reason]), [["git", "helper_stopped"]]);
    installSpawnHelper(undefined);

    const healthy = installCounted();
    assert.equal((await execFileRouted("sh", ["-c", "cat"], { encoding: "latin1", input: "fed" })).stdout, "fed");
    healthy.direct.length = 0;
    const latin1 = await hostWorktreeGitAsync(repo.dir, ["rev-parse", "HEAD"], { encoding: "latin1" });
    assert.equal(latin1.trim(), head);
    assert.equal(gitRequests(healthy).length, 0, "latin1 cannot ride the pipe");
    assert.deepEqual(healthy.direct.map((d) => [d.file, d.reason]), [["git", "unsupported_encoding"]]);
    assert.equal(gitRuns(), 2, "the no-helper and unhealthy calls each ran git once");

    const refused = gitRepo({ kind: "t13434-refused" });
    refused.git("config", "filter.x.clean", "cat");
    const before = healthy.requests.length;
    await assert.rejects(hostWorktreeGitAsync(refused.dir, ["status"], { env: shimEnv(), log: () => {} }), (e: unknown) => e instanceof WorktreeConfigRefusedError);
    assert.equal(healthy.requests.length - before, 1, "only the config read reached the helper");
    assert.equal(gitRuns(), 2, "no git child started for the refused call");
  });
});
