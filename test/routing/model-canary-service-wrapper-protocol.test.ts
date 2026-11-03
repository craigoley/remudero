import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { runInNewContext, Script } from "node:vm";
import test from "node:test";
import { LINUX_CODING_SERVICE_WRAPPER_SOURCE } from "#src/lib/model-canary-systemd-bwrap-backend.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const pid = 4312;

function wrapperHarness() {
  const unit = "rmd-coding-probe-00000000-0000-4000-8000-000000000001";
  const controlGroup = `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}.service`;
  const bubblewrapBytes = Buffer.from("trusted-bwrap-fixture");
  const bubblewrapPath = "/usr/bin/bwrap";
  const nodePath = "/usr/bin/node";
  const nodeBytes = Buffer.from("trusted-node-fixture");
  const librarySource = "/usr/lib/libfixture.so.1.2";
  const libraryTarget = "/usr/lib/libfixture.so.1";
  const libraryBytes = Buffer.from("trusted-library-fixture");
  const files = new Map([[bubblewrapPath, bubblewrapBytes], [nodePath, nodeBytes], [librarySource, libraryBytes]]);
  const runtimeFiles = [
    { source: nodePath, target: nodePath, sha256: hash(nodeBytes) },
    { source: librarySource, target: libraryTarget, sha256: hash(libraryBytes) },
  ];
  const plan = { unit, node: { path: nodePath }, bubblewrap: { path: bubblewrapPath, sha256: hash(bubblewrapBytes) },
    runtimeFiles, bounds: { scratchMaxBytes: 16_777_216, heapMaxBytes: 67_108_864,
      stdoutMaxBytes: 4096, stderrMaxBytes: 4096 } };
  const parentSentinel = "a".repeat(64);
  const wrapperStdout = Object.assign(new EventEmitter(), { value: "" });
  const wrapperStderr = { value: "" };
  const childCapture = { source: "", stdin: "", args: [] as string[], spawnCount: 0 };
  const stdin = Object.assign(new EventEmitter(), { pause() {} });
  let wrapperExitCode: number | null = null;
  let nextFileFd = 41;
  const fdPaths = new Map<number, string>();
  const readOffsets = new Map<number, number>();
  const fs = {
    readFileSync(path: string) {
      assert.equal(typeof path, "string", "trusted wrapper file paths must be strings");
      if (path === "/proc/self/cgroup") return `0::${controlGroup}\n`;
      if (path === `/sys/fs/cgroup${controlGroup}/cgroup.procs`) return `${pid}\n`;
      throw new Error("unexpected-read");
    },
    realpathSync(path: string) {
      assert.equal(typeof path, "string", "trusted wrapper realpath arguments must be strings");
      assert.ok(files.has(path), `only manifest or fixed executable paths may be resolved: ${path}`);
      return path;
    },
    openSync(path: string) {
      assert.equal(typeof path, "string", "trusted wrapper open arguments must be strings");
      assert.ok(files.has(path), `only manifest files may be opened: ${path}`);
      const fd = nextFileFd++;
      fdPaths.set(fd, path);
      readOffsets.set(fd, 0);
      return fd;
    },
    fstatSync(fd: number) { assert.ok(fdPaths.has(fd)); return { isFile: () => true }; },
    readSync(fd: number, target: Buffer, offset: number, length: number, position: number | null) {
      const path = fdPaths.get(fd);
      assert.ok(path);
      const fileBytes = files.get(path)!;
      const start = position === null ? readOffsets.get(fd)! : position;
      const bytes = fileBytes.subarray(start, start + length);
      bytes.copy(target, offset);
      if (position === null) readOffsets.set(fd, start + bytes.length);
      return bytes.length;
    },
    closeSync(fd: number) { assert.ok(fdPaths.delete(fd)); readOffsets.delete(fd); },
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 },
  };
  const childProcess = {
    spawn(_path: string, args: string[], options: { stdio: string[] }) {
      childCapture.spawnCount++;
      childCapture.args = args;
      assert.equal(JSON.stringify(options.stdio), JSON.stringify(["pipe", "pipe", "pipe", "pipe"]));
      const child = new EventEmitter() as EventEmitter & {
        stdio: unknown[]; stdin: { end(value: string): void }; stdout: EventEmitter; stderr: EventEmitter;
        kill(): void;
      };
      const sourceFd = new Writable({
        write(chunk, _encoding, callback) { childCapture.source += Buffer.from(chunk).toString("utf8"); callback(); },
      });
      child.stdio = [null, null, null, sourceFd];
      child.stdin = { end(value: string) { childCapture.stdin = value; } };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      sourceFd.once("finish", () => {
        child.stdout.emit("data", Buffer.from("candidate-output-not-executed\n"));
        child.emit("close", 0, null);
      });
      return child;
    },
  };
  const vmProcess = {
    pid, execPath: "/usr/bin/node",
    env: { RMD_CODING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
      RMD_PROFILE_PARENT_SENTINEL: parentSentinel },
    stdin,
    stdout: { write(value: string) { wrapperStdout.value += value; wrapperStdout.emit("data", value); } },
    stderr: { write(value: string) { wrapperStderr.value += value; } },
    exit(code?: number) {
      wrapperExitCode = code ?? vmProcess.exitCode;
      if (wrapperExitCode !== 0) throw new Error("wrapper-exit");
    },
    exitCode: 0,
  };
  const wrapperSource = LINUX_CODING_SERVICE_WRAPPER_SOURCE;
  runInNewContext(wrapperSource, {
    Buffer, process: vmProcess, require(name: string) {
      if (name === "node:child_process") return childProcess;
      if (name === "node:fs") return fs;
      if (name === "node:crypto") return { createHash };
      if (name === "node:perf_hooks") return { performance: { now: () => 1 } };
      if (name === "node:path") return { posix: { dirname: () => "/usr/bin" } };
      throw new Error("unexpected-require");
    },
  });
  return { controlGroup, unit, parentSentinel, nodePath, librarySource, libraryTarget,
    stdin, wrapperStdout, wrapperStderr, childCapture,
    get wrapperExitCode() { return wrapperExitCode; } };
}

test("W1-T10957: the emitted trusted wrapper preserves newline framing and FD3 source transport", async () => {
  const source = "process.stdout.write('fixed-source-not-executed')";
  const h = wrapperHarness();
  const request = JSON.stringify({ controlGroup: h.controlGroup, profileControl: "known-good", parentSentinel: h.parentSentinel,
    sourceBytes: Buffer.byteLength(source), sourceDigest: hash(source), stdin: "1 2 3 4\n" });
  const resultReady = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("trusted wrapper result timeout")), 1000);
    const check = () => {
      if (h.wrapperStdout.value.includes("RMD_RESULT ")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    h.wrapperStdout.on("data", check);
    check();
  });
  h.stdin.emit("data", Buffer.from(`${request}\n${source}`));
  await resultReady;

  assert.equal(h.childCapture.spawnCount, 1, "newline cgroup parsing must reach unit matching and bwrap spawn");
  assert.equal(h.childCapture.source, source, "the candidate source frame must be forwarded byte-for-byte on FD3");
  assert.equal(h.childCapture.stdin, "1 2 3 4\n", "candidate stdin remains a separate channel");
  const evalIndex = h.childCapture.args.indexOf("-e");
  assert.ok(evalIndex >= 0, "bwrap receives the fixed Node bootstrap");
  const candidateBootstrap = h.childCapture.args[evalIndex + 1]!;
  assert.ok(candidateBootstrap.includes("fs.readSync(3"), "the candidate bootstrap reads source from FD3");
  assert.doesNotThrow(() => new Script(candidateBootstrap), "the doubly nested fixed bootstrap remains valid JavaScript");
  assert.ok(!h.childCapture.args.join(" ").includes(source), "candidate source must not be placed in argv");
  for (const flag of ["--disable-userns", "--assert-userns-disabled", "--remount-ro", "/dev", "/proc", "/dev/pts", "/", "--v8-pool-size=1"])
    assert.ok(h.childCapture.args.includes(flag), `bwrap must enforce declared isolation flag ${flag}`);
  const bindPairs = h.childCapture.args.flatMap((arg, index, args) => arg === "--ro-bind" ? [[args[index + 1], args[index + 2]]] : []);
  assert.equal(JSON.stringify(bindPairs), JSON.stringify([[h.nodePath, h.nodePath], [h.librarySource, h.libraryTarget]]),
    "the real runtime manifest source/target contract must become exact read-only bwrap binds");
  assert.match(h.wrapperStdout.value, new RegExp(`RMD_PROFILE_PARENT_SENTINEL ${h.parentSentinel}\\n`));
  const resultLine = h.wrapperStdout.value.split("\n").find(line => line.startsWith("RMD_RESULT "));
  assert.ok(resultLine, "the wrapper must frame its result with a physical newline");
  assert.equal(JSON.parse(resultLine.slice("RMD_RESULT ".length)).stdoutBytes, Buffer.byteLength("candidate-output-not-executed\n"));
  h.stdin.emit("data", Buffer.from("release\n"));
  assert.equal(h.wrapperExitCode, 0, "the wrapper accepts the newline-delimited release frame");
});

test("W1-T10957: the emitted trusted wrapper rejects a source frame with trailing bytes", () => {
  const source = "fixed-source";
  const h = wrapperHarness();
  const request = JSON.stringify({ controlGroup: h.controlGroup, profileControl: "known-bad",
    sourceBytes: Buffer.byteLength(source), sourceDigest: hash(source), stdin: "" });
  assert.throws(() => h.stdin.emit("data", Buffer.from(`${request}\n${source}x`)), /wrapper-exit/);
  assert.equal(h.childCapture.spawnCount, 0, "invalid source frames never reach bwrap");
  assert.equal(h.wrapperStderr.value, "source-frame-overrun\n", "failure diagnostics keep a physical newline");
  assert.equal(h.wrapperExitCode, 125);
});
