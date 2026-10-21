// test/ci/gates/every-typecheck-spawn-runs-under-the-go-memory-limit.test.ts — operator ruling 2026-10-20. A cold full
// check of this repo peaked at 5.1–5.3 GB on the fleet host: TS 7 (a Go program) computed declaration diagnostics for
// every file under --noEmit, and its heap grew unchecked. The tsconfig now turns `declaration` off, every tsc spawn runs
// under GOMEMLIMIT=3GiB unless a limit is already set, and a cold check asks its slot for the measured 3.0–3.2 GB.
// FIXTURES ONLY: every tree, fake compiler, slot dir and buildinfo lives under this test's tmp dirs.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { typecheckStep } from "#src/lib/commit-message.js";
import type { Config } from "#src/lib/config.js";
import { defaultTypeCheckRunner } from "#src/lib/containment.js";
import { mergedHeadTypechecks } from "#src/lib/merge-probe.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  TYPECHECK_COLD_PEAK_BYTES, TYPECHECK_GOMEMLIMIT, TYPECHECK_WARM_PEAK_BYTES, typecheckEnv,
} from "#src/lib/typecheck-buildinfo.js";
import { runTypecheck } from "#src/lib/typecheck-run.js";
import { spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const GiB = 1024 ** 3;
const UNSET = "<unset>";
const TSCONFIG = JSON.stringify({ compilerOptions: { types: [], noEmit: true }, include: ["*.ts"] });

/** A fresh tmp root with a private slot dir; restores the slot env and GOMEMLIMIT afterwards. */
function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gomemlimit-`));
  const keys = ["RMD_TEST_SLOT_DIR", "RMD_TEST_SLOTS", "RMD_TEST_SLOT_PARENT", "GOMEMLIMIT"];
  const saved = keys.map((key) => process.env[key]);
  mkdirSync(join(root, "slots"));
  process.env.RMD_TEST_SLOT_DIR = join(root, "slots");
  process.env.RMD_TEST_SLOTS = "1";
  delete process.env.RMD_TEST_SLOT_PARENT;
  delete process.env.GOMEMLIMIT;
  t.after(() => {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** A tree whose `node_modules/.bin/tsc` is a fake compiler that records the GOMEMLIMIT it was given in `seen` — and
 *  prints it too when `print` (a captured child; an inherited one would write into this run's own report). */
function fakeCompilerTree(root: string, print = false): string {
  const dir = join(root, "tree");
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  const tsc = join(dir, "node_modules", ".bin", "tsc");
  const out = print ? `| tee "$(dirname "$0")/seen"` : `> "$(dirname "$0")/seen"`;
  writeFileSync(tsc, `#!/bin/sh\nprintf '%s' "\${GOMEMLIMIT-${UNSET}}" ${out}\n`);
  chmodSync(tsc, 0o755);
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  return dir;
}

const seenBy = (tree: string): string => readFileSync(join(tree, "node_modules", ".bin", "seen"), "utf8");

test("the repo's tsconfig turns declaration off, so --noEmit computes no declaration diagnostics", () => {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, "tsconfig.json"), "utf8")) as { compilerOptions: Record<string, unknown>; "//": string[] };
  assert.equal(config.compilerOptions.declaration, false);
  assert.match(config["//"].join(" "), /operator ruling 2026-10-20/, "the comment records why");
});

test("typecheckEnv sets GOMEMLIMIT=3GiB when unset and keeps an explicit value", () => {
  assert.equal(TYPECHECK_GOMEMLIMIT, "3GiB");
  assert.deepEqual(typecheckEnv({ PATH: "/bin" }), { PATH: "/bin", GOMEMLIMIT: "3GiB" });
  assert.deepEqual(typecheckEnv({ PATH: "/bin", GOMEMLIMIT: "2GiB" }), { PATH: "/bin", GOMEMLIMIT: "2GiB" });
  assert.deepEqual(typecheckEnv({ GOMEMLIMIT: "off" }), { GOMEMLIMIT: "off" }, "an explicit opt-out wins");
  assert.deepEqual(typecheckEnv({ HOME: "/h" }, "1GiB"), { HOME: "/h", GOMEMLIMIT: "1GiB" }, "an allowlisted env takes its parent's limit");
  assert.deepEqual(typecheckEnv({ HOME: "/h" }, undefined), { HOME: "/h", GOMEMLIMIT: "3GiB" });
});

test("a cold check's slot asks for the measured 3.25 GiB peak, a warm one half of it", () => {
  assert.equal(TYPECHECK_COLD_PEAK_BYTES, 3.25 * GiB);
  assert.equal(TYPECHECK_WARM_PEAK_BYTES, 1.625 * GiB);
});

test("npm run typecheck's real spawn passes GOMEMLIMIT=3GiB to tsc, and an explicit limit wins", (t) => {
  const tree = fakeCompilerTree(fixture(t));
  const opts = { canWrite: () => false, testSlot: { memoryHeadroom: () => undefined }, log: () => {} };
  assert.equal(runTypecheck(tree, [], opts), 0);
  assert.equal(seenBy(tree), "3GiB");
  process.env.GOMEMLIMIT = "2GiB";
  assert.equal(runTypecheck(tree, [], opts), 0);
  assert.equal(seenBy(tree), "2GiB");
});

test("preflight's typecheck step passes GOMEMLIMIT=3GiB to tsc, and an explicit limit wins", (t) => {
  const tree = fakeCompilerTree(fixture(t));
  const seen: (string | undefined)[] = [];
  const step = () => typecheckStep(tree, (file, args, options) => {
    seen.push(options?.env?.GOMEMLIMIT);
    return { status: 0, stdout: "", stderr: "" };
  }, { memoryHeadroom: () => undefined }, () => false);
  assert.equal(step().ok, true);
  process.env.GOMEMLIMIT = "2GiB";
  assert.equal(step().ok, true);
  assert.deepEqual(seen, ["3GiB", "2GiB"]);
});

test("the edit hook's default typecheck runner passes GOMEMLIMIT=3GiB to tsc, and an explicit limit wins", (t) => {
  const tree = fakeCompilerTree(fixture(t), true);
  assert.deepEqual(defaultTypeCheckRunner(tree, 30_000), { output: "3GiB", timedOut: false });
  process.env.GOMEMLIMIT = "2GiB";
  assert.deepEqual(defaultTypeCheckRunner(tree, 30_000), { output: "2GiB", timedOut: false });
});

test("the merge probe's allowlisted proof env still carries GOMEMLIMIT: 3GiB by default, the daemon's own when set", async (t) => {
  const root = fixture(t);
  const repo = gitRepo({ kind: "gomemlimit-probe" });
  t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(repo.dir, "a.ts"), "export const a = 1;\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base");
  const lane = repo.addWorktree(join(root, "lane"), "lane", "main");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(lane.dir, "node_modules"));
  writeFileSync(join(lane.dir, "b.ts"), "export const b = 1;\n");
  lane.git("add", "b.ts");
  lane.git("commit", "-qm", "lane");
  writeFileSync(join(repo.dir, "c.ts"), "export const c = 1;\n");
  repo.git("add", "c.ts");
  repo.git("commit", "-qm", "main");
  const seen: (string | undefined)[] = [];
  for (const limit of [undefined, "2GiB"]) {
    if (limit !== undefined) process.env.GOMEMLIMIT = limit;
    const result = await mergedHeadTypechecks(lane.dir, { mainRef: "main", spawn: (file, args, options) => {
      seen.push(options.env?.GOMEMLIMIT);
      assert.equal(options.env?.GH_TOKEN, undefined, "control: the env is still the allowlisted proof env");
      return spawn(file, [...args], options);
    } });
    assert.equal(result.outcome, "passes", JSON.stringify(result));
  }
  assert.deepEqual(seen, ["3GiB", "2GiB"]);
});

test("the open-weight typecheck check runs under GOMEMLIMIT=3GiB, and the worker env's own limit wins", async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, ".git"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
  const seen: (string | undefined)[] = [];
  for (const workerEnv of [undefined, { GOMEMLIMIT: "2GiB" }]) {
    let turn = 0;
    await spawnOpenWeightWorker({
      cwd: root, workerHome: join(root, "home"), prompt: "typecheck", tools: ["RunCheck"], maxTurns: 3,
      env: { RMD_OPENWEIGHT_API_KEY: "fixture" }, ...(workerEnv ? { workerEnv } : {}),
      runCheck: ({ env }) => { seen.push(env.GOMEMLIMIT); return ""; },
      fetchImpl: async () => {
        turn += 1;
        const message = turn === 1
          ? { tool_calls: [{ id: "c1", type: "function", function: { name: "run_check", arguments: '{"check":"typecheck"}' } }] }
          : { content: "done" };
        return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
      },
    }, { root, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } } as Config,
    { model: "gpt-oss-120b", effort: "low" });
  }
  assert.deepEqual(seen, ["3GiB", "2GiB"]);
});

test("a raw tsc through the fleet's tsc entry runs under GOMEMLIMIT=3GiB, and an explicit limit wins", async (t) => {
  fixture(t);
  // @ts-ignore executable builtins-only module, like the existing scripts/typecheck.mjs.
  const { runTscEntry } = await import("#scripts/tsc-entry.mjs");
  const seen: (string | undefined)[] = [];
  const record = (_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { seen.push(options.env.GOMEMLIMIT); return { status: 0 }; };
  assert.equal(runTscEntry(["--version"], REPO_ROOT, record), 0);
  process.env.GOMEMLIMIT = "2GiB";
  assert.equal(runTscEntry(["--version"], REPO_ROOT, record), 0);
  assert.deepEqual(seen, ["3GiB", "2GiB"]);
});

test("control: the fake compiler reports an unset limit as unset", (t) => {
  const tree = fakeCompilerTree(fixture(t), true);
  const res = spawnSync(join(tree, "node_modules", ".bin", "tsc"), [], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(res.stdout, UNSET);
});
