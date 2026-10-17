/**
 * W1-T10025 — THE PRE-OPEN GATE'S SANDBOX STARTS WHEN ITS HARNESS IS AN ENGINE TREE.
 *
 * From 2026-10-17 03:43Z every run child's gate read `unmeasured`: "bwrap: Can't bind mount …/remudero/node_modules on
 * …/state/engines/<hash>…". The harness (the engine tree) is bound read-only first, and its `node_modules` is a link
 * to the managed checkout's install; a later bind whose destination is that link mounts out of the new root.
 * PR 12595 drops a read-only proof bind at or under the harness. These tests hold the general rule: no bind
 * destination is a link, or sits under one, so every destination is a real directory inside the sandbox.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { defaultGateContainment, findOnPath, preopenGateEnv, preopenGateSandboxArgv, type GateContainInput } from "../src/lib/preopen-gate.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface EngineTree {
  root: string;
  install: string;
  engine: string;
  input: GateContainInput;
}

/** The fleet's shape: an install, an engine tree under state/engines/<hash> linking to it, a worktree linking to the engine. */
function engineTree(): EngineTree {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t10025-`)));
  dirs.push(root);
  const install = join(root, "remudero", "node_modules");
  mkdirSync(join(install, "pkg"), { recursive: true });
  writeFileSync(join(install, "pkg", "index.js"), "module.exports = 'engine install';\n");
  const engine = join(root, "state", "engines", "a".repeat(64));
  mkdirSync(join(engine, "bin"), { recursive: true });
  symlinkSync(install, join(engine, "node_modules"));
  const work = join(root, "worktrees", "run-W1-T10025-1");
  mkdirSync(work, { recursive: true });
  symlinkSync(join(engine, "node_modules"), join(work, "node_modules"));
  const home = join(root, "home");
  mkdirSync(home);
  return { root, install, engine, input: { cwd: work, home, harnessRoot: engine, env: preopenGateEnv(home, { PATH: process.env.PATH }) } };
}

const binds = (argv: string[]): Array<[string, string]> =>
  argv.flatMap((a, i) => (a === "--bind" || a === "--ro-bind" ? [[argv[i + 1]!, argv[i + 2]!] as [string, string]] : []));

test("W1-T10025: an engine-tree harness argv binds nothing onto a node_modules link", () => {
  const f = engineTree();
  const argv = preopenGateSandboxArgv(f.input, {});
  const ours = binds(argv).filter(([, to]) => to === f.root || to.startsWith(`${f.root}/`));
  assert.ok(ours.length >= 3, `the fixture's binds are present: ${JSON.stringify(ours)}`);
  for (const [, to] of ours) assert.equal(realpathSync(to), to, `${to} is a link, or under one, so bwrap would mount out of the new root`);
  assert.ok(ours.some(([from, to]) => from === to && to === f.engine), "the harness is still bound");
  assert.ok(ours.some(([from, to]) => from === to && to === f.install), "the install the links resolve to is still bound");
});

/** Stand-in for bwrap where it is absent: refuses, with bwrap's message, a destination that is a link or under one. */
function destinationCheckingSandbox(dir: string): string {
  const path = join(dir, "bwrap-stand-in");
  writeFileSync(path, `#!${process.execPath}
const fs = require("fs"); const cp = require("child_process"); const args = process.argv.slice(2); const end = args.indexOf("--");
for (let i = 0; i < end; i++) {
  if (args[i] !== "--bind" && args[i] !== "--ro-bind") continue;
  const to = args[i + 2]; i += 2;
  if (!to.startsWith(${JSON.stringify(dir)})) continue;
  if (fs.realpathSync(to) !== to) { process.stderr.write("bwrap: Can't bind mount /oldroot" + fs.realpathSync(args[i - 1]) + " on /newroot" + to + "\\n"); process.exit(1); }
}
const r = cp.spawnSync(args[end + 1], args.slice(end + 2), { stdio: "inherit" });
process.exit(r.status === null ? 128 : r.status);
`);
  chmodSync(path, 0o755);
  return path;
}

const bwrap = findOnPath("bwrap");
test("W1-T10025: the gate sandbox starts for an engine-tree harness", async (t) => {
  const f = engineTree();
  if (bwrap === null) t.diagnostic("bwrap is not installed on this host: started under a stand-in that applies bwrap's destination rule");
  const contain = bwrap === null
    ? await defaultGateContainment(f.input, { binary: destinationCheckingSandbox(f.root), platform: "linux", parentEnv: {} })
    : await defaultGateContainment(f.input, { parentEnv: {} });
  if (bwrap !== null && contain.mode !== "sandboxed" && /uid map|namespace|Operation not permitted/.test(contain.reason)) {
    return void t.skip(`bwrap cannot create a namespace here: ${contain.reason}`);
  }
  assert.equal(contain.mode, "sandboxed", JSON.stringify(contain));
});
