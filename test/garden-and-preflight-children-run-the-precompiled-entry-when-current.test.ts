// test/garden-and-preflight-children-run-the-precompiled-entry-when-current.test.ts — W1-T8778.
//
// Each garden pass and each pre-open fast preflight used to start `node --import tsx src/run-task.ts <verb>` with a
// cold, path-keyed tsx cache (about 519 MB peak against 173-182 MB for the bundle). They now go through
// childEntryArgv (src/lib/child-entry-argv.ts): the precompiled run-task entry under plain node when
// scripts/build-child-entries.mjs vouches for it, the old launch otherwise. Decision record:
// docs/adr/0006-precompiled-daemon-child-entries.md, decision 4: a verb switches only once it is shown to start no
// worker from its own module URL, which a bundle cannot load without tsx.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as workerThreads from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHILD_ENTRY_SPAWNED_STEP } from "../src/lib/child-entry-argv.js";
import { FIXTURE_CONFIG_PATH_SEGMENTS } from "../src/lib/config.js";
import { GARDEN_CHILD_HEAP_LIMIT_MB, REGISTERED_GARDEN_NAMES, gardenChildNodeArgv } from "../src/lib/garden-registry.js";
import { preopenGateLaunch } from "../src/lib/preopen-gate.js";
import { resolveProducerIdentity } from "../src/lib/producer-identity.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { preflightCommand, runRegisteredGardenPass, type GardenBuildContext } from "../src/run-task.js";
import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "build-child-entries.mjs");
const NAME = "run-task";
const SOURCE = "src/run-task.ts";
const MARKER = "RUN-TASK-BUNDLE-RAN";
const CAP = `--max-old-space-size=${GARDEN_CHILD_HEAP_LIMIT_MB}`;

interface BuildModule {
  OUT_DIR: string;
  buildChildEntries(opts: { root: string; entries: { name: string; source: string }[] }): Promise<unknown>;
}

const cleanups: string[] = [];
const scratch = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`));
  cleanups.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

/** A tree whose run-task source prints its node flags and arguments. */
function makeTree(): string {
  const root = scratch("t8778-tree");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  writeFileSync(join(root, SOURCE), `console.log(JSON.stringify({ marker: "${MARKER}", execArgv: process.execArgv, args: process.argv.slice(2) }));\n`);
  return root;
}

async function builtTree(): Promise<{ root: string; bundle: string }> {
  const mod = (await import(pathToFileURL(SCRIPT).href)) as BuildModule;
  const root = makeTree();
  await mod.buildChildEntries({ root, entries: [{ name: NAME, source: SOURCE }] });
  return { root, bundle: join(root, mod.OUT_DIR, `${NAME}.mjs`) };
}

type Row = { step: string; extra: Record<string, unknown> };
const rows = () => {
  const out: Row[] = [];
  return { out, log: (step: string, extra: Record<string, unknown> = {}) => void out.push({ step, extra }) };
};
const spawnedRows = (out: Row[]): Row[] => out.filter((r) => r.step === CHILD_ENTRY_SPAWNED_STEP);

const TSX_LOADER_FLAGS = ["--import", "tsx", "--require", "/h/node_modules/tsx/dist/preflight.cjs", "--import", "file:///h/node_modules/tsx/dist/loader.mjs"];

test("W1-T8778: a garden child runs the current bundle with its heap cap last", async () => {
  const { root, bundle } = await builtTree();
  const { log } = rows();
  const argv = gardenChildNodeArgv("plan", [], GARDEN_CHILD_HEAP_LIMIT_MB, { execArgv: [...TSX_LOADER_FLAGS, "--expose-gc", "--import", "./keep.mjs"], entry: "/h/src/run-task.ts" }, true, log, root);
  assert.deepEqual(argv, ["--expose-gc", "--import", "./keep.mjs", CAP, bundle, "garden", "run", "plan"],
    "the inherited tsx loader flags are dropped, other flags kept, the cap follows them, and the bundle is the entry");
  assert.ok(!argv.some((a) => /tsx/.test(a)), "no tsx import survives in front of the bundle");

  // Run it for real: plain node, the cap is the child's last node flag, and the entry saw the garden arguments.
  const r = spawnSync(process.execPath, gardenChildNodeArgv("plan", ["--hourly"], GARDEN_CHILD_HEAP_LIMIT_MB, { execArgv: [], entry: "" }, true, log, root), { encoding: "utf8", cwd: tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout) as { marker: string; execArgv: string[]; args: string[] };
  assert.equal(seen.marker, MARKER);
  assert.equal(seen.execArgv.at(-1), CAP);
  assert.deepEqual(seen.args, ["garden", "run", "plan", "--hourly"]);

  // A caller's explicit execArgv/entry is used as given, never rewritten and never ledgered.
  const explicit = rows();
  assert.deepEqual(
    gardenChildNodeArgv("plan", [], GARDEN_CHILD_HEAP_LIMIT_MB, { execArgv: ["--import", "tsx"], entry: "/probe.mjs" }, false, explicit.log, root),
    ["--import", "tsx", CAP, "/probe.mjs", "garden", "run", "plan"],
  );
  assert.deepEqual(explicit.out, []);

  // A tree with no current bundle keeps today's launch: the inherited flags and entry.
  const bare = rows();
  const legacy = gardenChildNodeArgv("plan", [], GARDEN_CHILD_HEAP_LIMIT_MB, { execArgv: ["--import", "tsx"], entry: "/h/src/run-task.ts" }, true, bare.log, makeTree());
  assert.deepEqual(legacy, ["--import", "tsx", CAP, "/h/src/run-task.ts", "garden", "run", "plan"]);
});

test("W1-T8778: inline `--flag=value` loader spellings drop only the tsx ones before the bundle", async () => {
  const { root, bundle } = await builtTree();
  const { log } = rows();
  const argv = gardenChildNodeArgv(
    "plan",
    [],
    GARDEN_CHILD_HEAP_LIMIT_MB,
    { execArgv: ["--import=tsx", "--require=/h/node_modules/tsx/dist/preflight.cjs", "--import=./keep.mjs", "--expose-gc"], entry: "/h/src/run-task.ts" },
    true,
    log,
    root,
  );
  assert.deepEqual(argv, ["--import=./keep.mjs", "--expose-gc", CAP, bundle, "garden", "run", "plan"],
    "inline tsx loader flags are dropped, the inline non-tsx loader and other flags are kept");
});

test("W1-T8778: the pre-open preflight runs the bundle when current and bin/rmd otherwise", async () => {
  const { root, bundle } = await builtTree();
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "rmd"), "#!/usr/bin/env bash\n");
  const { log } = rows();

  // W1-T9619: the HARNESS's current bundle runs against `--repo-root <cwd>`, for a worktree holding its own
  // bin/rmd and bundle (that tree's own code never runs) and for a consumer worktree alike.
  const core = makeTree();
  mkdirSync(join(core, "bin"));
  writeFileSync(join(core, "bin", "rmd"), "#!/usr/bin/env bash\n");
  assert.deepEqual(preopenGateLaunch(core, log, "/h/bin/rmd", root), { file: process.execPath, args: [bundle, "preflight", "--fast", "--repo-root", core] });
  const consumer = scratch("t8778-consumer");
  assert.deepEqual(preopenGateLaunch(consumer, log, "/h/bin/rmd", root), { file: process.execPath, args: [bundle, "preflight", "--fast", "--repo-root", consumer] });

  // No current harness bundle: the harness's bin/rmd, still with `--repo-root`.
  const stale = makeTree();
  assert.deepEqual(preopenGateLaunch(root, log, "/h/bin/rmd", stale), { file: "/h/bin/rmd", args: ["preflight", "--fast", "--repo-root", root] });
  assert.deepEqual(preopenGateLaunch(consumer, log, "/h/bin/rmd", stale), { file: "/h/bin/rmd", args: ["preflight", "--fast", "--repo-root", consumer] });
});

test("W1-T8778: each switched spawn ledgers its entry kind and reason", async () => {
  const { root } = await builtTree();
  const bare = makeTree();
  mkdirSync(join(bare, "bin"));
  writeFileSync(join(bare, "bin", "rmd"), "#!/usr/bin/env bash\n");
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "rmd"), "#!/usr/bin/env bash\n");

  const garden = rows();
  gardenChildNodeArgv("plan", [], GARDEN_CHILD_HEAP_LIMIT_MB, { execArgv: [], entry: "" }, true, garden.log, root);
  gardenChildNodeArgv("backlog", [], GARDEN_CHILD_HEAP_LIMIT_MB, { execArgv: [], entry: "" }, true, garden.log, bare);
  const computed = spawnedRows(garden.out)[0]!.extra.hash as { ms: number };
  const bytesRead = [SOURCE, "package.json", "package-lock.json"]
    .reduce((bytes, path) => bytes + statSync(join(root, path)).size, 0);
  assert.ok(Number.isFinite(computed.ms) && computed.ms >= 0);
  const noHash = { computed: 0, reused: 0, bytes_read: 0, ms: 0 };
  assert.deepEqual(spawnedRows(garden.out).map((r) => r.extra), [
    { name: NAME, verb: "garden run plan", kind: "bundle", reason: "source-hash-match",
      hash: { computed: 1, reused: 0, bytes_read: bytesRead, ms: computed.ms } },
    { name: NAME, verb: "garden run backlog", kind: "tsx", reason: "no-manifest", hash: noHash },
  ]);

  const gate = rows();
  preopenGateLaunch(bare, gate.log, "/h/bin/rmd", root);
  preopenGateLaunch(root, gate.log, "/h/bin/rmd", bare);
  assert.deepEqual(spawnedRows(gate.out).map((r) => r.extra), [
    { name: NAME, verb: "preflight --fast", kind: "bundle", reason: "source-hash-match",
      hash: { computed: 0, reused: 1, bytes_read: 0, ms: 0 } },
    { name: NAME, verb: "preflight --fast", kind: "tsx", reason: "no-manifest", hash: noHash },
  ]);
});

/**
 * Makes `worker_threads.Worker` throw, counting every construction, for the span of `during`. The count is the
 * evidence: a pass that catches its own error would hide a throw, but it cannot hide having asked for a Worker.
 */
async function withThrowingWorker<T>(during: () => Promise<T>): Promise<{ result: T; constructed: number }> {
  const cjs = createRequire(import.meta.url)("node:worker_threads") as { Worker: unknown };
  const original = cjs.Worker;
  let constructed = 0;
  const mutable = cjs;
  mutable.Worker = class ThrowingWorker {
    constructor() {
      constructed++;
      throw new Error("W1-T8778: a verb switched to the precompiled entry started a worker");
    }
  };
  syncBuiltinESMExports();
  try {
    return { result: await during(), constructed };
  } finally {
    mutable.Worker = original;
    syncBuiltinESMExports();
  }
}

test("W1-T8778: every switched verb starts no self-URL worker", async (t) => {
  const repo = gitRepo({ kind: "t8778-worker-proof" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "state"));
  // `gh` and the judge's binary fail at once, so no pass reaches a network or a model; each pass logs its own failure.
  const shim = ghShim([{ when: "", exit: 1, stderr: "t8778 isolated gh" }]);
  const priorPath = process.env.PATH;
  const falseBin = join(shim.dir, "claude-stub");
  writeFileSync(falseBin, "#!/bin/sh\nexit 1\n");
  chmodSync(falseBin, 0o755);
  process.env.PATH = `${shim.dir}:${priorPath}`;
  t.after(() => void (process.env.PATH = priorPath));
  const out: Row[] = [];
  const ctx: GardenBuildContext = {
    config: { root: repo.dir, claudeBin: falseBin } as GardenBuildContext["config"],
    repoRoot: repo.dir, owner: "acme", repo: "remudero",
    log: (step, extra = {}) => void out.push({ step, extra }),
    raiseDuplicate: () => "",
  };

  const constructedBy: Record<string, number> = {};
  for (const name of REGISTERED_GARDEN_NAMES) {
    const ran = await withThrowingWorker(async () => {
      const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 30_000).unref());
      return await Promise.race([runRegisteredGardenPass(name, [], ctx).then(() => "ran", (e: unknown) => `threw: ${String((e as Error)?.message ?? e)}`), timeout]);
    });
    constructedBy[name] = ran.constructed;
    assert.notEqual(ran.result, "timeout", `${name}: the pass must end for the proof to have seen all of it`);
  }
  assert.deepEqual(Object.entries(constructedBy).filter(([, n]) => n > 0), [], "no registered garden pass asks for a Worker");
  assert.equal(Object.keys(constructedBy).length, REGISTERED_GARDEN_NAMES.length, "every registered garden was driven");

  // The fast preflight's own code path, every spawn faked so only run-task's in-process work runs.
  const spawn: PreflightSpawn = () => ({ status: 0, stdout: "", stderr: "" });
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  let preflight;
  try {
    preflight = await withThrowingWorker(() => preflightCommand(["--fast"], { spawn }));
  } finally {
    console.log = original;
  }
  assert.equal(preflight.constructed, 0, "rmd preflight --fast asks for no Worker");

  // The control: the fixture's throwing class does fire when something constructs a Worker, so a zero above is a measurement.
  const control = await withThrowingWorker(async () => {
    try {
      new workerThreads.Worker("0");
      return "constructed";
    } catch (error) {
      return (error as Error).message.startsWith("W1-T8778") ? "threw" : "wrong error";
    }
  });
  assert.deepEqual(control, { result: "threw", constructed: 1 });
});

/** Run the REAL default `ledgerGateLog` in a child whose HOME holds a fixture config naming `root`. */
function runDefaultGateLogChild(root: string): { status: number | null; stderr: string } {
  const home = scratch("t8778-home");
  const configFile = join(home, ...FIXTURE_CONFIG_PATH_SEGMENTS);
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ claudeBin: "/bin/true", root }));
  const source = pathToFileURL(join(REPO_ROOT, "src", "lib", "preopen-gate.ts")).href;
  const script = `import { ledgerGateLog } from ${JSON.stringify(source)};\n` +
    `ledgerGateLog(${JSON.stringify(CHILD_ENTRY_SPAWNED_STEP)}, { name: "run-task", verb: "preflight --fast", kind: "tsx", reason: "probe" });\n`;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { status: r.status, stderr: r.stderr };
}

test("W1-T8778: the default pre-open gate log writes one row under a declared sender, and a failed write is noted, never thrown", () => {
  const root = scratch("t8778-ledger-root");
  const ok = runDefaultGateLogChild(root);
  assert.equal(ok.status, 0, ok.stderr);
  const lines = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "exactly one row");
  const row = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(row.step, CHILD_ENTRY_SPAWNED_STEP);
  assert.equal(row.kind, "tsx");
  // The census in every-message-names-one-declared-sender.test.ts refuses an undeclared task_id; the row's sender must resolve.
  assert.equal(resolveProducerIdentity(String(row.task_id)).id, "harness");

  // A root that is a FILE cannot hold state/: the write fails, the gate goes on, and stderr names the step.
  const blocked = join(scratch("t8778-blocked"), "not-a-dir");
  writeFileSync(blocked, "");
  const failed = runDefaultGateLogChild(blocked);
  assert.equal(failed.status, 0, "a failed ledger write is never the gate's failure");
  assert.match(failed.stderr, new RegExp(`preopen gate: could not ledger ${CHILD_ENTRY_SPAWNED_STEP.replace(".", "\\.")}: `));
});
