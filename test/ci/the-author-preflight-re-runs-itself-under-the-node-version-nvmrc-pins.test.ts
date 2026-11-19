/**
 * W1-T13736 — the author preflight re-runs itself under the Node version .nvmrc pins.
 *
 * A fixture checkout pins a version this process is not (99.1.2), and a fake install of it under a fixture home is a
 * shell script that answers `--version` and otherwise records the argv and environment it was run with. The preflight
 * must run the fake as itself when it reads the pin, never run one that reads another version, refuse rather than
 * re-run a second time, and with no install name the verified install command. Nothing here downloads or installs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// @ts-ignore the executable .mjs module has no declaration file.
import * as authorModule from "#scripts/preflight-author.mjs";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT as ROOT } from "#test/helpers/repo-root.js";

type Spawned = { status: number | null; signal?: string | null; error?: Error; stdout?: string; stderr?: string };
type Spawn = (file: string, args: string[], options?: Record<string, unknown>) => Spawned;
type Locate = { home?: string; env?: Record<string, string | undefined>; platform?: string; arch?: string;
  execPath?: string; exists?: (path: string) => boolean; versionOf?: (path: string) => string | undefined;
  realpath?: (path: string) => string };
type Reexec = { reexec?: string; refuse?: string; candidates: string[] };
const author = authorModule as unknown as {
  main: (argv: string[], deps: { root: string; spawn?: Spawn; pinnedNode?: Locate; verdictLedger?: unknown }) => number;
  pinnedNodeReexec: (input: Locate & { pin: string; current: string }) => Reexec;
};

const PIN = "99.1.2";
const SCRIPT = realpathSync(join(ROOT, "scripts/preflight-author.mjs"));
const scratch = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}node-pin-reexec-`));
const savedProbe = process.env.T13736_PROBE;
after(() => {
  if (savedProbe === undefined) delete process.env.T13736_PROBE;
  else process.env.T13736_PROBE = savedProbe;
  rmSync(scratch, { recursive: true, force: true });
});

let serial = 0;
/** A checkout whose .nvmrc pins PIN, and an empty home beside it. */
function fixture() {
  const dir = join(scratch, `case-${++serial}`);
  const root = join(dir, "checkout"), home = join(dir, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, ".nvmrc"), `${PIN}\n`);
  return { root, home };
}

/** A fake Node at `path` whose `--version` reads `version`; any other run records its argv and env and exits 7. */
function fakeNode(path: string, version: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, ["#!/bin/sh",
    `if [ "$1" = "--version" ]; then echo "v${version}"; exit 0; fi`,
    `printf '%s\\n' "$@" > "$(dirname "$0")/argv.txt"`,
    `printf '%s' "$T13736_PROBE" > "$(dirname "$0")/probe.txt"`,
    `printf '%s' "$PATH" > "$(dirname "$0")/path.txt"`,
    "exit 7", ""].join("\n"), { mode: 0o755 });
  return { ran: () => existsSync(join(path, "..", "argv.txt")), argv: () => readFileSync(join(path, "..", "argv.txt"), "utf8").split("\n").slice(0, -1),
    probe: () => readFileSync(join(path, "..", "probe.txt"), "utf8"), path: () => readFileSync(join(path, "..", "path.txt"), "utf8") };
}

/** Run `fn` with console output captured. */
function printed<T>(fn: () => T) {
  const out: string[] = [], err: string[] = [];
  const saved = { log: console.log, error: console.error };
  console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { err.push(args.join(" ")); };
  try { return { value: fn(), out, err }; }
  finally { Object.assign(console, saved); }
}

const noLedger = { ledger: () => ({ reason: "a test has no ledger" }) };
const receiptOf = (root: string) => JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8")) as { verdict: string; error?: string };

test("W1-T13736 criterion 1: the preflight re-runs itself under the installed pin with the same argv and env, prints one line, and exits with the child's status", () => {
  assert.notEqual(process.versions.node, PIN, "the fixture pin must differ from the running Node");
  const { root, home } = fixture();
  const path = join(home, ".local/opt", `node-v${PIN}`, "bin/node");
  const fake = fakeNode(path, PIN);
  process.env.T13736_PROBE = "same-environment";
  const argv = ["--head-ref", "run-W1-T13736-fixture", "--dry-run"];
  const run = printed(() => author.main(argv, { root, verdictLedger: noLedger, pinnedNode: { home, env: {} } }));
  assert.equal(fake.ran(), true, `the installed pin was never run; stderr: ${run.err.join(" | ")}`);
  assert.equal(run.value, 7, "the preflight exits with the child's status");
  assert.deepEqual(fake.argv(), [...process.execArgv, SCRIPT, ...argv], "the child gets this process's node flags, this script and the same arguments");
  assert.equal(fake.probe(), "same-environment", "the child inherits the same environment");
  assert.equal(fake.path().split(":", 1)[0], join(home, ".local/opt", `node-v${PIN}`, "bin"), "the pinned Node directory leads PATH for nested node commands");
  const lines = run.out.filter((line) => line.includes(path));
  assert.equal(lines.length, 1, `one line names the path: ${run.out.join(" | ")}`);
  assert.ok(lines[0]!.includes(process.versions.node) && lines[0]!.includes(PIN), `the line names both versions: ${lines[0]}`);
  assert.equal(existsSync(join(root, "coverage/preflight-author.json")), false, "the child, not this process, writes the receipt");
});

test("W1-T13736 criterion 1: the candidates are the plain and <platform>-<arch> installs under ~/.local/opt, then nvm's, in that order", () => {
  const home = "/home/fixture";
  const plain = `${home}/.local/opt/node-v${PIN}/bin/node`, archived = `${home}/.local/opt/node-v${PIN}-linux-x64/bin/node`;
  const choose = (present: string[], env: Record<string, string | undefined> = {}) => author.pinnedNodeReexec({ pin: PIN, current: "24.0.0",
    home, env, platform: "linux", arch: "x64", execPath: "/usr/bin/node", exists: (p) => present.includes(p), versionOf: () => `v${PIN}`, realpath: (p) => p });
  assert.deepEqual(choose([]).candidates, [plain, archived, `${home}/.nvm/versions/node/v${PIN}/bin/node`]);
  assert.equal(choose([archived]).reexec, archived);
  assert.equal(choose([plain, archived]).reexec, plain);
  assert.equal(choose([`${home}/.nvm/versions/node/v${PIN}/bin/node`]).reexec, `${home}/.nvm/versions/node/v${PIN}/bin/node`, "nvm's default directory");
  assert.equal(choose(["/opt/nvm/versions/node/v99.1.2/bin/node"], { NVM_DIR: "/opt/nvm" }).reexec, "/opt/nvm/versions/node/v99.1.2/bin/node", "NVM_DIR wins over the default");
});

test("W1-T13736 criterion 2: an install whose own --version does not read the pin is never run as the gate", () => {
  const { root, home } = fixture();
  const path = join(home, ".local/opt", `node-v${PIN}`, "bin/node");
  const fake = fakeNode(path, "24.0.1");
  const run = printed(() => author.main(["--head-ref", "run-W1-T13736-fixture"], { root, verdictLedger: noLedger, pinnedNode: { home, env: {} } }));
  assert.equal(fake.ran(), false, "a candidate that reads another version was run as the gate");
  assert.equal(run.value, 1);
  const receipt = receiptOf(root);
  assert.equal(receipt.verdict, "refused");
  assert.match(receipt.error ?? "", new RegExp(`^Node ${PIN.replace(/\./g, "\\.")} required; got ${process.versions.node.replace(/\./g, "\\.")}`));
  assert.ok((receipt.error ?? "").includes(`${path} reads v24.0.1`), `the refusal names the install that read another version: ${receipt.error}`);
});

test("W1-T13736 criterion 2: a child that still reads a Node other than the pin refuses node-version instead of re-running again", () => {
  const { root, home } = fixture();
  const path = join(home, ".local/opt", `node-v${PIN}`, "bin/node");
  const fake = fakeNode(path, PIN);
  const calls: string[][] = [];
  const spawn: Spawn = (file, args) => { calls.push([file, ...args]); return file === path && args[0] === "--version" ? { status: 0, stdout: `v${PIN}\n` } : { status: 0 }; };
  // This process is that install already (the re-run child), yet it does not read the pin.
  const run = printed(() => author.main(["--head-ref", "run-W1-T13736-fixture"], { root, spawn, verdictLedger: noLedger,
    pinnedNode: { home, env: {}, execPath: path } }));
  assert.equal(run.value, 1);
  assert.equal(fake.ran(), false);
  assert.deepEqual(calls.filter((call) => call[1] !== "--version"), [], "no second re-run and no gate step");
  const receipt = receiptOf(root);
  assert.match(receipt.error ?? "", new RegExp(`^Node ${PIN.replace(/\./g, "\\.")} required; got `));
  assert.match(receipt.error ?? "", /not re-run again/);
  assert.ok(run.err.some((line) => line.includes("REFUSED")));
});

test("W1-T13736 criterion 2: a re-run ended by a signal or never started refuses naming why", () => {
  for (const [ending, pattern] of [[{ status: null, signal: "SIGTERM" }, /ended by signal SIGTERM/],
    [{ status: null, error: new Error("spawn EACCES") }, /could not start: spawn EACCES/]] as const) {
    const { root, home } = fixture();
    const path = join(home, ".local/opt", `node-v${PIN}`, "bin/node");
    fakeNode(path, PIN);
    const spawn: Spawn = (file, args) => args[0] === "--version" ? { status: 0, stdout: `v${PIN}\n` } : ending;
    const run = printed(() => author.main([], { root, spawn, verdictLedger: noLedger, pinnedNode: { home, env: {} } }));
    assert.equal(run.value, 1);
    assert.match(receiptOf(root).error ?? "", pattern);
  }
});

test("W1-T13736 criterion 3: with no install of the pin the preflight refuses node-version naming the verified install command", () => {
  const { root, home } = fixture();
  const run = printed(() => author.main(["--head-ref", "run-W1-T13736-fixture"], { root, verdictLedger: noLedger, pinnedNode: { home, env: {} } }));
  assert.equal(run.value, 1);
  const error = receiptOf(root).error ?? "";
  assert.match(error, new RegExp(`^Node ${PIN.replace(/\./g, "\\.")} required; got ${process.versions.node.replace(/\./g, "\\.")}`));
  const archive = `node-v${PIN}-${process.platform}-${process.arch}.tar.gz`;
  assert.ok(error.includes(`https://nodejs.org/dist/v${PIN}/${archive}`), `the refusal names the release archive: ${error}`);
  assert.ok(error.includes(`https://nodejs.org/dist/v${PIN}/SHASUMS256.txt`), "and the release's checksum list");
  assert.ok(error.includes(`grep ' ${archive}$' SHASUMS256.txt`), "and checks the archive against it");
  assert.ok(run.err.some((line) => line.includes(error.slice(0, 40))), "the refusal is printed");

  const names = (platform: string, arch: string, env: Record<string, string | undefined> = {}, present: string[] = []) =>
    author.pinnedNodeReexec({ pin: PIN, current: "24.0.0", home: "/h", env, platform, arch, execPath: "/usr/bin/node",
      exists: (p) => present.includes(p), versionOf: () => undefined, realpath: (p) => p }).refuse ?? "";
  assert.match(names("darwin", "arm64"), /node-v99\.1\.2-darwin-arm64\.tar\.gz\$' SHASUMS256\.txt \| shasum -a 256 -c - && .*tar -xzf node-v99\.1\.2-darwin-arm64\.tar\.gz -C "\$HOME\/\.local\/opt"/);
  assert.match(names("linux", "x64"), /node-v99\.1\.2-linux-x64\.tar\.gz\$' SHASUMS256\.txt \| sha256sum -c - && /);
  assert.match(names("linux", "x64", { NVM_DIR: "/opt/nvm" }), /nvm install 99\.1\.2/, "nvm where NVM_DIR names it");
  assert.match(names("darwin", "arm64", {}, ["/h/.nvm/nvm.sh"]), /nvm install 99\.1\.2/, "nvm where its default install is present");
  assert.doesNotMatch(names("darwin", "arm64"), /nvm install/);
  assert.match(names("win32", "x64"), /https:\/\/nodejs\.org\/dist\/v99\.1\.2\/ checked against its SHASUMS256\.txt/);
});

test("W1-T13736 criterion 5: invariant never-another-node: no path runs the gate under another version, downloads a Node or installs one", () => {
  for (const scenario of ["absent", "wrong-version", "this-node"] as const) {
    const { root, home } = fixture();
    const path = join(home, ".local/opt", `node-v${PIN}`, "bin/node");
    if (scenario !== "absent") fakeNode(path, scenario === "wrong-version" ? "24.0.1" : PIN);
    const calls: string[][] = [];
    const spawn: Spawn = (file, args, options) => {
      calls.push([file, ...args]);
      // Probes answer as the real one would; everything else is refused here so no stubbed call can reach the network.
      if (args[0] === "--version" && existsSync(file)) return spawnSync(file, args, { ...options, encoding: "utf8" }) as Spawned;
      return { status: 1, stderr: "not run in this test" };
    };
    const run = printed(() => author.main(["--head-ref", "run-W1-T13736-fixture"], { root, spawn, verdictLedger: noLedger,
      pinnedNode: { home, env: {}, ...(scenario === "this-node" ? { execPath: path } : {}) } }));
    assert.equal(run.value, 1, `${scenario}: refused`);
    assert.match(receiptOf(root).error ?? "", /^Node 99\.1\.2 required; got /, `${scenario}: refused node-version`);
    const other = calls.filter(([, ...args]) => !(args.length === 1 && args[0] === "--version"));
    assert.deepEqual(other, [], `${scenario}: only --version probes ran; no gate step, download, install or other Node`);
    for (const [file] of calls) assert.ok(file.endsWith("/bin/node"), `${scenario}: probed only a Node install, not ${file}`);
  }
});
