/**
 * REGRESSION SINCE 2026-10-17 03:43Z — AN ENGINE-BACKED PRE-OPEN GATE STARTS SANDBOXED, NOT UNMEASURED.
 *
 * In the fleet a run child runs from its engine tree, so the gate's harness IS that engine. The worker's worktree
 * links `node_modules` to the engine's `node_modules`, which links on to the managed checkout's install (W1-T9738).
 * W1-T9860 binds that middle hop read-only, and W1-T9619 binds the harness first: the hop's destination is then the
 * harness's own symlink inside the sandbox, bwrap cannot mount onto it, and every gate was recorded `unmeasured`.
 *
 * Every test runs without bubblewrap: a fake sandbox binary refuses exactly what bwrap refuses (a bind whose
 * destination is a symlink an earlier bind already placed) and otherwise runs the command after `--`. The last
 * test runs the real bwrap where the host has one.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";

import { defaultGateContainment, findOnPath, preopenGateEnv, preopenGateSandboxArgv, type GateContainInput } from "../src/lib/preopen-gate.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface EngineFixture {
  input: GateContainInput;
  canonical: string;
  engine: string;
  work: string;
  key: string;
}

/** The container's shape: the managed checkout's install, an engine tree linking to it, a worktree linking to the engine. */
function engineFixture(): EngineFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gate-engine-bind-`)));
  dirs.push(root);
  const canonical = join(root, "remudero");
  mkdirSync(join(canonical, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(canonical, "node_modules", "pkg", "index.js"), "module.exports = 'canonical install';\n");
  const engine = join(root, "state", "engines", "e".repeat(64));
  mkdirSync(join(engine, "bin"), { recursive: true });
  symlinkSync(join(canonical, "node_modules"), join(engine, "node_modules"));
  writeFileSync(join(engine, ".git"), "gitdir: /elsewhere\n");
  const key = join(engine, "app-key.pem");
  writeFileSync(key, "not a key");
  const work = join(root, "worktrees", "run-W1-T0-1");
  mkdirSync(work, { recursive: true });
  symlinkSync(join(engine, "node_modules"), join(work, "node_modules"));
  const home = join(root, "home");
  mkdirSync(home);
  return { input: { cwd: work, home, harnessRoot: engine, env: preopenGateEnv(home, { PATH: process.env.PATH }) }, canonical, engine, work, key };
}

/** A sandbox binary that refuses, with bwrap's own message, a bind onto a symlink an earlier bind placed. */
function bwrapLikeSandbox(dir: string): string {
  const path = join(dir, "bwrap-like");
  writeFileSync(path, `#!${process.execPath}
const fs = require("fs"); const cp = require("child_process"); const args = process.argv.slice(2);
const end = args.indexOf("--"); const placed = [];
const arity = { "--ro-bind": 2, "--bind": 2, "--dir": 1, "--tmpfs": 1, "--proc": 1, "--dev": 1, "--chdir": 1 };
for (let i = 0; i < end; i += 1 + (arity[args[i]] ?? 0)) {
  if (args[i] !== "--ro-bind" && args[i] !== "--bind") continue;
  const [from, to] = [args[i + 1], args[i + 2]];
  let link = false;
  try { link = fs.lstatSync(to).isSymbolicLink(); } catch { link = false; }
  if (link && placed.some((p) => to.startsWith(p + "/"))) {
    process.stderr.write("bwrap: Can't bind mount /oldroot" + fs.realpathSync(from) + " on /newroot" + to + ": Unable to mount source on destination: No such file or directory\\n");
    process.exit(1);
  }
  placed.push(to);
}
const r = cp.spawnSync(args[end + 1], args.slice(end + 2), { stdio: "inherit" });
process.exit(r.status === null ? 128 : r.status);
`);
  chmodSync(path, 0o755);
  return path;
}

const pairs = (argv: string[], flag: string): Array<[string, string]> => argv.flatMap((a, i) => (a === flag ? [[argv[i + 1]!, argv[i + 2]!] as [string, string]] : []));

test("an engine whose node_modules links into the managed checkout's install starts sandboxed, not unmeasured", async () => {
  const f = engineFixture();
  const contain = await defaultGateContainment(f.input, { binary: bwrapLikeSandbox(f.engine), platform: "linux", parentEnv: { GH_APP_PRIVATE_KEY_PATH: f.key } });
  assert.equal(contain.mode, "sandboxed", JSON.stringify(contain));
  const argv = contain.mode === "sandboxed" ? contain.argv : [];
  const ro = pairs(argv, "--ro-bind");
  assert.ok(!ro.some(([, to]) => to === join(f.engine, "node_modules")), "the engine's own link is never a bind destination");
  // W1-T9738: the install the modules resolve to is read-only, and no writable bind holds it.
  assert.ok(ro.some(([from, to]) => from === to && to === join(f.canonical, "node_modules")), "the managed checkout's install is bound read-only");
  const writable = pairs(argv, "--bind");
  assert.deepEqual(writable.filter(([, to]) => to === "/tmp"), [[join(f.input.home, ".rmd-private-tmp"), "/tmp"]], "only this HOME's private scratch backs sandbox /tmp");
  assert.ok(!writable.some(([from]) => join(f.canonical, "node_modules").startsWith(`${from}/`) || from === f.engine), "no writable host bind holds the install or the engine");
  assert.ok(!writable.some(([, to]) => to !== "/tmp" && (join(f.canonical, "node_modules").startsWith(`${to}/`) || to === f.engine)), "no writable overlay exposes the install or the engine");
  // W1-T9619: harness read-only with its .git and the App key masked, no network, and the argv still ends in --.
  assert.ok(ro.some(([from, to]) => from === to && to === f.engine), "the harness is bound read-only");
  assert.ok(ro.some(([from, to]) => from === "/dev/null" && to === join(f.engine, ".git")), "the harness's .git is masked");
  assert.ok(ro.some(([from, to]) => from === "/dev/null" && to === f.key), "the App key is masked");
  assert.ok(argv.includes("--unshare-net") && argv.at(-1) === "--");
  // Every hop of the worktree's link chain is visible in the sandbox: bound, or under a read-only bind.
  for (let link = join(f.work, "node_modules"); lstatSync(link).isSymbolicLink(); link = resolve(dirname(link), readlinkSync(link))) {
    const next = resolve(dirname(link), readlinkSync(link));
    assert.ok(ro.some(([, to]) => next === to || next.startsWith(`${to}/`)), `${next} is visible inside the sandbox`);
  }
});

test("an engine-backed gate argv keeps every bind the harness does not already show", () => {
  const f = engineFixture();
  const argv = preopenGateSandboxArgv(f.input, {});
  assert.ok(pairs(argv, "--bind").some(([from, to]) => from === to && to === f.work), "the worktree stays writable");
  assert.ok(pairs(argv, "--bind").some(([from, to]) => from === to && to === f.input.home), "the throwaway HOME stays writable");
  assert.ok(pairs(argv, "--ro-bind").some(([from, to]) => from === to && to === "/etc/passwd"), "the runtime's /etc entries stay bound");
  assert.ok(argv.lastIndexOf(f.engine) < argv.lastIndexOf(f.work), "the harness lands before the worktree's own binds");
});

const bwrapPath = findOnPath("bwrap");
test("under the real sandbox an engine-backed gate resolves its modules through the engine's link", { skip: bwrapPath === null ? "bwrap is not installed on this host" : false }, async (t) => {
  const f = engineFixture();
  const contain = await defaultGateContainment(f.input, { parentEnv: {} });
  if (contain.mode !== "sandboxed" && /uid map|namespace|Operation not permitted/.test(contain.reason)) return void t.skip(`bwrap cannot create a namespace here: ${contain.reason}`);
  assert.equal(contain.mode, "sandboxed", JSON.stringify(contain));
  const argv = contain.mode === "sandboxed" ? contain.argv : [];
  const out = execFileSync(bwrapPath!, [...argv, process.execPath, "-e", "process.stdout.write(require(require.resolve('pkg', { paths: [process.cwd()] })))"], {
    cwd: f.work, env: f.input.env, encoding: "utf8",
  });
  assert.equal(out, "canonical install");
});
