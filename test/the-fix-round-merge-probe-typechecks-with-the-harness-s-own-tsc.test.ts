// test/the-fix-round-merge-probe-typechecks-with-the-harness-s-own-tsc.test.ts — W1-T6155: the fix-round merge probe
// spawned `node <wt/node_modules>/typescript/bin/tsc` with the daemon's whole env, so a worker that planted a tsc in
// the node_modules its worktree links ran code as the daemon. These fixtures plant exactly that shim — it writes a
// marker holding its env — and run the REAL default typecheck: the harness's tsc must run instead, credential-free.
// FIXTURES ONLY: every repo, link, shim and marker lives under this test's tmp dirs.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { after, before, test } from "node:test";
import { defaultMergeProbeGit, mergedHeadTypechecks, type MergeProbeGit, type TypecheckSpawn } from "../src/lib/merge-probe.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const harnessPkg = createRequire(import.meta.url).resolve("typescript/package.json");
const HARNESS_TSC = join(realpathSync(dirname(harnessPkg)), "bin", "tsc");
const HARNESS_VERSION = (JSON.parse(readFileSync(harnessPkg, "utf8")) as { version: string }).version;

const CREDENTIALS = { GH_TOKEN: "ghp_fixture_token", GH_APP_ID: "4242", GH_APP_PRIVATE_KEY_PATH: "/fixture/key.pem" };
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const [key, value] of Object.entries(CREDENTIALS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
after(() => {
  for (const key of Object.keys(CREDENTIALS)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "esnext", moduleResolution: "bundler", strict: true, types: [], skipLibCheck: true },
  include: ["*.ts"],
});
const BASE = Array.from({ length: 10 }, (_, i) => `export const v${i}: number = ${i};\n`).join("");

/** A typescript package whose bin/tsc writes `marker` with its whole env — the planted program. */
function plantShim(modules: string, marker: string, version = HARNESS_VERSION): void {
  const pkg = join(modules, "typescript");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "typescript", version, bin: { tsc: "./bin/tsc" } }));
  writeFileSync(join(pkg, "bin", "tsc"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.env));\n`);
}

interface Fixture { root: string; managed: string; wt: string; marker: string }

/** A managed checkout and a linked worktree cut before main moved; `modules` decides what the worktree's
 *  node_modules is: a link to the managed checkout's, a link to a directory outside both, or a real dir inside it. */
function fixture(opts: { branchEdit: (b: string) => string; mainEdit: (b: string) => string; modules: "managed" | "outside" | "inside"; version?: string }): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}harness-tsc-`)));
  const marker = join(root, "shim-ran.json");
  const repo = gitRepo({ kind: "harness-tsc-managed" });
  const managed = realpathSync(repo.dir);
  writeFileSync(join(managed, ".gitignore"), "node_modules\n");
  writeFileSync(join(managed, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(managed, "a.ts"), BASE);
  repo.git("add", ".gitignore", "tsconfig.json", "a.ts");
  repo.git("commit", "-q", "-m", "base");
  const wt = join(root, "wt");
  const lane = repo.addWorktree(wt, "run-T-HARNESS-1", "main");
  writeFileSync(join(wt, "a.ts"), opts.branchEdit(BASE));
  lane.git("commit", "-q", "-am", "fix round");
  writeFileSync(join(managed, "a.ts"), opts.mainEdit(BASE));
  repo.git("commit", "-q", "-am", "main moves");
  if (opts.modules === "inside") {
    plantShim(join(wt, "node_modules"), marker, opts.version);
  } else {
    const target = opts.modules === "managed" ? join(managed, "node_modules") : join(root, "elsewhere", "node_modules");
    plantShim(target, marker, opts.version);
    symlinkSync(target, join(wt, "node_modules"));
  }
  return { root, managed, wt, marker };
}

interface Spawned { file: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }
/** The real spawn, observed: every typecheck child the default makes is recorded, then run for real. */
function recordingSpawn(): { spawned: Spawned[]; spawn: TypecheckSpawn } {
  const spawned: Spawned[] = [];
  return {
    spawned,
    spawn: (file, args, options) => {
      spawned.push({ file, args, env: { ...(options.env ?? {}) }, cwd: String(options.cwd) });
      return spawn(file, [...args], options);
    },
  };
}

const sameDeclTwice = { branchEdit: (b: string) => "export const dup = 1;\n" + b, mainEdit: (b: string) => b + "export const dup = 1;\n" };
const cleanMerge = { branchEdit: (b: string) => "export const fromBranch = 1;\n" + b, mainEdit: (b: string) => b + "export const fromMain = 2;\n" };

function assertHarnessChildren(spawned: Spawned[], fx: Fixture): void {
  assert.ok(spawned.length >= 1, "the default typecheck spawned at least one child");
  for (const child of spawned) {
    assert.equal(child.file, process.execPath);
    assert.equal(child.args[0], HARNESS_TSC, "the program is the harness's own tsc");
    assert.ok(!child.args[0]!.startsWith(fx.root + sep) && !child.args[0]!.startsWith(fx.managed + sep), "never a tsc under the fixture");
    const names = Object.keys(child.env);
    assert.deepEqual(names.filter((n) => n === "GH_TOKEN" || n.startsWith("GH_APP")), [], "no credential name reaches the child");
    assert.ok(child.env.HOME !== undefined && child.env.HOME !== process.env.HOME && child.env.HOME !== homedir(), "HOME is a throwaway");
    assert.ok(!Object.values(child.env).includes(CREDENTIALS.GH_TOKEN), "the token's value is nowhere in the env");
  }
}

test("a clean merge typechecks with the harness's tsc; the shim the worktree's node_modules link holds never runs", async () => {
  const fx = fixture({ ...cleanMerge, modules: "managed" });
  const rec = recordingSpawn();
  const result = await mergedHeadTypechecks(fx.wt, { mainRef: "main", spawn: rec.spawn });
  assert.equal(existsSync(fx.marker), false, `the planted tsc ran: ${existsSync(fx.marker) ? readFileSync(fx.marker, "utf8").slice(0, 200) : ""}`);
  assert.equal(result.outcome, "passes", JSON.stringify(result));
  assertHarnessChildren(rec.spawned, fx);
});

test("a merged tree with a genuine type error still reads merged_fails, judged by the harness's tsc", async () => {
  const fx = fixture({ ...sameDeclTwice, modules: "inside" });
  const rec = recordingSpawn();
  const result = await mergedHeadTypechecks(fx.wt, { mainRef: "main", spawn: rec.spawn });
  assert.equal(existsSync(fx.marker), false, "the planted tsc never ran");
  assert.equal(result.outcome, "merged_fails", JSON.stringify(result));
  assert.match(result.outcome === "merged_fails" ? result.text : "", /dup/);
  assert.equal(rec.spawned.length, 2, "the merged tree, then the head alone");
  assertHarnessChildren(rec.spawned, fx);
});

test("a node_modules link resolving outside the worktree, the managed checkout and the harness install is skipped by name", async () => {
  const fx = fixture({ ...cleanMerge, modules: "outside" });
  const rec = recordingSpawn();
  const result = await mergedHeadTypechecks(fx.wt, { mainRef: "main", spawn: rec.spawn });
  assert.equal(existsSync(fx.marker), false);
  assert.equal(result.outcome, "skipped");
  assert.match(result.outcome === "skipped" ? result.reason : "", /^node_modules resolves outside the worktree, the managed checkout and the harness install: /);
  assert.deepEqual(rec.spawned, [], "nothing is spawned for a link the probe will not read");
});

test("a tree whose installed typescript is not the harness's version is skipped by name, never judged", async () => {
  const fx = fixture({ ...cleanMerge, modules: "inside", version: "0.0.1-fixture" });
  const result = await mergedHeadTypechecks(fx.wt, { mainRef: "main" });
  assert.deepEqual(result, { outcome: "skipped", reason: `typescript version skew: harness ${HARNESS_VERSION}, tree 0.0.1-fixture` });
  assert.equal(existsSync(fx.marker), false);
});

test("a typecheck child that cannot start is skipped as could-not-run, never read as a verdict", async () => {
  const fx = fixture({ ...cleanMerge, modules: "inside" });
  const result = await mergedHeadTypechecks(fx.wt, {
    mainRef: "main",
    spawn: (_file, args, options) => spawn(join(fx.root, "no-such-node"), [...args], options),
  });
  assert.equal(result.outcome, "skipped");
  assert.match(result.outcome === "skipped" ? result.reason : "", /^typecheck could not run:\nspawn failed: /);
});

test("a tree git cannot archive is skipped by name, for the merged tree and for the head", async () => {
  for (const [nth, reason] of [[1, "git archive of the merged tree failed"], [2, "git archive of the head failed"]] as const) {
    const fx = fixture({ ...sameDeclTwice, modules: "inside" });
    const real = defaultMergeProbeGit(fx.wt);
    let archives = 0;
    const git: MergeProbeGit = (args) => (args[0] === "archive" && ++archives === nth ? { status: 128, stdout: "" } : real(args));
    const result = await mergedHeadTypechecks(fx.wt, { mainRef: "main", git });
    assert.deepEqual(result, { outcome: "skipped", reason });
  }
});
