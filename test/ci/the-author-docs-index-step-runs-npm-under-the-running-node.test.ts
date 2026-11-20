/**
 * W1-T13774 — the author preflight's docs-index step runs npm under the running Node.
 *
 * The docs-index-precheck steps spawned a bare `npm`, so the npm on PATH ran, under PATH's first `node`, and the
 * package script's own `node` came from PATH too. Since W1-T13736 the preflight re-runs itself under the .nvmrc pin
 * with PATH unchanged, so on a host whose PATH leads with another Node those steps ran on that other Node. A fixture
 * checkout with docs inputs runs the real steps; a PATH whose first `node` is a shim that answers for any package
 * script with another version shows which Node the script ran on. Nothing here downloads or installs a Node.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";

// @ts-ignore the executable .mjs module has no declaration file.
import * as authorModule from "#scripts/preflight-author.mjs";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT as ROOT } from "#test/helpers/repo-root.js";

type Spawned = { status: number | null; signal?: string | null; error?: Error; stdout?: string; stderr?: string };
type Spawn = (file: string, args: string[], options?: { env?: Record<string, string | undefined> }) => Spawned;
type NpmCli = { execPath?: string; exists?: (path: string) => boolean };
type Step = { name: string; ok: boolean; exitCode?: number | null; inputs?: string[]; runtimeBoundMs?: number;
  reused?: unknown; error?: { message: string } | null };
type Receipt = { verdict: string; error?: string; steps: Step[]; stageReuse?: { reused: string[] } };
const author = authorModule as unknown as {
  AUTHOR_DOCS_PRECHECK_MAX_MS: number;
  main: (argv: string[], deps: { root: string; spawn?: Spawn; select?: () => unknown; host?: () => unknown; npmCli?: NpmCli }) => number;
  npmUnderRunningNode: (input?: NpmCli) => { file?: string; args?: string[]; binDir?: string; refuse?: string };
};

const SCRIPTS = ["docs-index:check", "docs-index:check-paths"];
const SHIM_VERSION = "v0.0.1-shim";
const scratch = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}docs-npm-node-`));
const saved = { slots: process.env.RMD_TEST_SLOT_DIR, out: process.env.T13774_OUT, red: process.env.T13774_STATIC_RED, path: process.env.PATH };
process.env.RMD_TEST_SLOT_DIR = join(scratch, "slots");
const cleanups: (() => void)[] = [];
after(() => {
  for (const [key, value] of [["RMD_TEST_SLOT_DIR", saved.slots], ["T13774_OUT", saved.out], ["T13774_STATIC_RED", saved.red],
    ["PATH", saved.path]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const cleanup of cleanups) cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

/** A committed author tree whose diff touches docs/, so both docs-index steps run; its static gate fails while
 *  T13774_STATIC_RED is set, which ends the run before any suite. Each docs script appends its stage and the
 *  version of the Node it ran on to T13774_OUT. */
function docsTree() {
  const tree = gitRepo({ kind: "docs-npm-node", seedCommit: false });
  cleanups.push(() => tree.cleanup());
  const root = tree.dir;
  for (const path of ["test/setup", "src", "scripts", "docs"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/diff-class.mjs"), "// This fixture has no census path readers.\n");
  writeFileSync(join(root, "scripts/census-precheck.mjs"), "console.log('fixture census precheck passed');\n");
  writeFileSync(join(root, "scripts/docs-version.mjs"), [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.T13774_OUT, `docs-index:${process.argv[2]} ${process.version}\\n`);", ""].join("\n"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: {
    "docs-index:check": "node scripts/docs-version.mjs check",
    "docs-index:check-paths": "node scripts/docs-version.mjs check-paths",
  } }) + "\n");
  writeFileSync(join(root, "src/run-task.ts"), "if (process.env.T13774_STATIC_RED) process.exitCode = 1;\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/leaf.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "test/leaf.test.ts"), "import { test } from 'node:test'; test('fixture', () => {});\n");
  writeFileSync(join(root, "docs/fixture.md"), "baseline\n");
  tree.git("add", ".");
  tree.git("commit", "-m", "test: baseline");
  tree.git("remote", "add", "origin", root);
  tree.git("checkout", "-b", "run-unfiled-docs-npm-node");
  writeFileSync(join(root, "docs/fixture.md"), "changed\n");
  writeFileSync(join(root, "src/leaf.ts"), "export const value = 2;\n");
  tree.git("add", ".");
  tree.git("commit", "-m", "docs: change an index input");
  const out = join(scratch, `${root.split("/").at(-1)}.out`);
  return { root, out };
}

const select = () => ({ fullRun: false, suites: ["test/leaf.test.ts"], reasons: ["fixture"], recentOnly: { floor: [] } });
const host = () => ({ cores: 8, load1: 0, headroomBytes: 8 * 1024 ** 3 });

/** One author run on `tree` with its static gate red, console output silenced; PATH is `path` while it runs. */
function authorRun(tree: { root: string; out: string }, deps: { spawn?: Spawn; npmCli?: NpmCli } = {}, path = saved.path) {
  writeFileSync(tree.out, "");
  process.env.T13774_OUT = tree.out;
  process.env.T13774_STATIC_RED = "1";
  if (path === undefined) delete process.env.PATH;
  else process.env.PATH = path;
  const log = console.log, error = console.error;
  console.log = () => {}; console.error = () => {};
  let status: number;
  try { status = author.main([], { root: tree.root, select, host, ...deps }); }
  finally {
    console.log = log; console.error = error;
    if (saved.path === undefined) delete process.env.PATH;
    else process.env.PATH = saved.path;
    delete process.env.T13774_STATIC_RED;
  }
  const receipt = JSON.parse(readFileSync(join(tree.root, "coverage/preflight-author.json"), "utf8")) as Receipt;
  return { status, receipt, wrote: readFileSync(tree.out, "utf8").split("\n").filter(Boolean) };
}

/** A spawn seam that runs every call for real and records each one. */
function recordingSpawn() {
  const calls: { file: string; args: string[]; path: string | undefined }[] = [];
  const spawn: Spawn = (file, args, options) => {
    calls.push({ file, args, path: options?.env?.PATH });
    return spawnSync(file, args, options as Parameters<typeof spawnSync>[2]) as unknown as Spawned;
  };
  return { spawn, calls, docs: () => calls.filter((call) => SCRIPTS.some((script) => call.args.includes(script))) };
}

const binDir = dirname(process.execPath);
const npmCliScript = join(binDir, "..", "lib/node_modules/npm/bin/npm-cli.js");

test("W1-T13774 criterion 1: both docs-index-precheck steps spawn the running Node with its own install's npm-cli.js, never a bare npm", () => {
  const tree = docsTree();
  const seam = recordingSpawn();
  const run = authorRun(tree, { spawn: seam.spawn });
  const docs = seam.docs();
  assert.equal(docs.length, 2, `both docs steps ran exactly once: ${JSON.stringify(seam.calls.map((call) => [call.file, ...call.args]))}`);
  for (const [index, script] of SCRIPTS.entries()) {
    const call = docs[index]!;
    assert.equal(call.file, process.execPath, `${script}: the spawned file is the running Node, not ${call.file}`);
    assert.deepEqual(call.args, [npmCliScript, "run", "--silent", script], `${script}: the npm CLI beside this Node runs the script`);
  }
  assert.equal(seam.calls.some((call) => call.file === "npm" || call.file.endsWith("/npm")), false, "no npm from PATH is spawned");
  assert.deepEqual(run.wrote, SCRIPTS.map((script) => `${script} ${process.version}`), "positive control: both scripts ran");

  const layout = (execPath: string, present: string[]) => author.npmUnderRunningNode({ execPath, exists: (path) => present.includes(path) });
  assert.deepEqual(layout("/opt/node-v1/bin/node", ["/opt/node-v1/lib/node_modules/npm/bin/npm-cli.js"]),
    { file: "/opt/node-v1/bin/node", args: ["/opt/node-v1/lib/node_modules/npm/bin/npm-cli.js"], binDir: "/opt/node-v1/bin" },
    "the install is the directory above the bin directory, as nodejs.org archives, nvm and Homebrew lay it out");
  assert.deepEqual(author.npmUnderRunningNode(), { file: process.execPath, args: [npmCliScript], binDir },
    "by default the running Node and its install");
});

test("W1-T13774 criterion 2: the step's child PATH leads with the running Node's bin directory, so the package script's node is the running Node", () => {
  const tree = docsTree();
  // The first node on PATH answers any package script with another version; npm itself it hands to the real Node,
  // as a PATH npm whose shebang reads `#!/usr/bin/env node` would run under it.
  const shimDir = join(scratch, `shim-${tree.root.split("/").at(-1)}`);
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "node"), ["#!/bin/sh",
    `case "$1" in scripts/*) printf 'docs-index:%s ${SHIM_VERSION}\\n' "$2" >> "$T13774_OUT"; exit 0 ;; esac`,
    `exec "${process.execPath}" "$@"`, ""].join("\n"), { mode: 0o755 });
  const probe = spawnSync("node", ["scripts/x.mjs", "probe"], { env: { PATH: shimDir, T13774_OUT: join(shimDir, "probe.out") }, encoding: "utf8" });
  assert.equal(probe.status, 0, "positive control: the shim is the first node on that PATH");
  assert.equal(readFileSync(join(shimDir, "probe.out"), "utf8"), `docs-index:probe ${SHIM_VERSION}\n`);

  const seam = recordingSpawn();
  const run = authorRun(tree, { spawn: seam.spawn }, `${shimDir}${delimiter}${saved.path ?? ""}`);
  assert.deepEqual(run.wrote, SCRIPTS.map((script) => `${script} ${process.version}`),
    `the package scripts ran on the running Node ${process.version}, not PATH's first node (${SHIM_VERSION})`);
  for (const call of seam.docs()) {
    assert.ok(call.path?.startsWith(binDir + delimiter + shimDir + delimiter), `the child's PATH leads with ${binDir}, then the parent's: ${call.path}`);
  }
});

test("W1-T13774 criterion 3: an install with no npm CLI script refuses the step before it spawns, naming the path and the remedy", () => {
  const tree = docsTree();
  const npmlessInstall = join(scratch, `npmless-${tree.root.split("/").at(-1)}`);
  mkdirSync(join(npmlessInstall, "bin"), { recursive: true });
  const execPath = join(npmlessInstall, "bin/node"), looked = join(npmlessInstall, "lib/node_modules/npm/bin/npm-cli.js");
  const seam = recordingSpawn();
  const run = authorRun(tree, { spawn: seam.spawn, npmCli: { execPath } });
  assert.deepEqual(seam.docs(), [], "no docs step was spawned, from PATH or anywhere");
  assert.equal(seam.calls.some((call) => call.file === "npm" || call.file.endsWith("/npm") || call.file === execPath), false,
    "neither PATH's npm nor the npm-less Node ran");
  assert.deepEqual(run.wrote, [], "no package script ran");
  assert.equal(run.status, 1);
  assert.equal(run.receipt.verdict, "refused");
  assert.deepEqual(run.receipt.steps.map((step) => step.name), ["census-precheck", "docs-index-precheck:docs-index:check"],
    "the refusal ends the run at the first docs step, before any later stage");
  const refused = run.receipt.steps.at(-1)!;
  assert.equal(refused.ok, false);
  assert.ok(refused.error?.message.includes(looked), `the failed step names the path it looked for: ${refused.error?.message}`);
  assert.ok((run.receipt.error ?? "").includes(looked), `the refusal names the path it looked for: ${run.receipt.error}`);
  assert.match(run.receipt.error ?? "", /reinstall/, "and the install remedy");

  const refusal = author.npmUnderRunningNode({ execPath: "/opt/node-v1/bin/node", exists: () => false });
  assert.equal(refusal.file, undefined, "a refusal names no file to spawn");
  assert.ok(refusal.refuse?.includes("/opt/node-v1/lib/node_modules/npm/bin/npm-cli.js"), `the refusal names the path: ${refusal.refuse}`);
  assert.match(refusal.refuse ?? "", /reinstall the Node at \/opt\/node-v1 /);
  assert.match(refusal.refuse ?? "", /npm from PATH is not run/);
});

test("W1-T13774 criterion 4: invariant same-package-commands: the same scripts, step names, receipt rows, runtime bound and stage reuse", () => {
  const tree = docsTree();
  const seam = recordingSpawn();
  const first = authorRun(tree, { spawn: seam.spawn });
  const beyondNpm = (args: string[]) => args[0]?.endsWith("/npm-cli.js") ? args.slice(1) : args;
  assert.deepEqual(seam.docs().map((call) => beyondNpm(call.args)), SCRIPTS.map((script) => ["run", "--silent", script]),
    "beyond the npm CLI the step runs the same package scripts with the same arguments, in the same order");
  assert.equal(first.receipt.verdict, "failed", first.receipt.error);
  assert.deepEqual(first.receipt.steps.map((step) => step.name),
    ["census-precheck", "docs-index-precheck:docs-index:check", "docs-index-precheck:docs-index:check-paths", "static-preflight"]);
  for (const script of SCRIPTS) {
    const row = first.receipt.steps.find((step) => step.name === `docs-index-precheck:${script}`)!;
    assert.equal(row.ok, true, `${script} passed`);
    assert.equal(row.exitCode, 0);
    assert.equal(row.runtimeBoundMs, author.AUTHOR_DOCS_PRECHECK_MAX_MS, `${script} keeps its runtime bound`);
    assert.deepEqual(row.inputs, ["docs/fixture.md"], `${script} names its docs inputs`);
  }

  const second = authorRun(tree);
  assert.deepEqual(second.receipt.stageReuse?.reused,
    ["census-precheck", "docs-index-precheck:docs-index:check", "docs-index-precheck:docs-index:check-paths"],
    "a second run on the same commit reuses both docs stages");
  assert.deepEqual(second.wrote, [], "the reused docs stages did not run again");
});
