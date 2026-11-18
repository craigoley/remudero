// W1-T11369: every daemon child that the spawn helper's pipe can carry forks through execFileRouted.
// @source-text-subject: the census inventories direct execFileLoopBounded call sites in source text;
// its planted-site control proves it detects a new unclassified one.
// @census-reads: src/** — every execFileLoopBounded call site across the source tree.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

import { readPushedRunBranchesOutputAsync } from "#src/cli/commands/daemon.js";
import { workerAcceptanceProofSpawner } from "#src/cli/commands/fix.js";
import { gitHeartbeatSource } from "#src/lib/host-resource-gardener.js";
import { runBuildScriptInChild } from "#src/lib/child-entry-store.js";
import { LoopBoundedChildTimeout } from "#src/lib/loop-bounded-child.js";
import { defaultGateContainment } from "#src/lib/preopen-gate.js";
import { runCheckProofChild } from "#src/lib/repair-proof-grader.js";
import { installSpawnHelper, startSpawnHelper, type SpawnHelper, type SpawnRequest } from "#src/lib/spawn-helper.js";
import { readVmStatAsync } from "#src/lib/test-slot.js";
import { selectOpenWeightUnitTestSuitesOffLoop } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Site = { file: string; line: number };

/** The defining modules: loop-bounded-child.ts is the primitive, spawn-helper.ts is its routed seam. */
const DEFINING = new Set(["src/lib/loop-bounded-child.ts", "src/lib/spawn-helper.ts"]);

/** A direct call stays only where the helper cannot carry it. Each entry is a count and its reason. */
const CLASSIFIED: Record<string, { count: number; reason: string }> = {
  "src/lib/proof-amendment.ts": { count: 1, reason: "writes the python3 script's input through command.child.stdin" },
  "src/lib/serve-plan-reload.ts": { count: 1, reason: "writes cat-file --batch input through command.child.stdin" },
  "src/lib/worktree-git.ts": { count: 1, reason: "writes git's input through command.child.stdin (the git leaf, W1-T13434)" },
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** A call, or the function passed as a default value (`= execFileLoopBounded`, `?? execFileLoopBounded`). */
const SITE = /\bexecFileLoopBounded\s*\(|(?:=|\?\?)\s*execFileLoopBounded\b/g;

function sites(file: string, text: string): Site[] {
  if (DEFINING.has(file)) return [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
  return code.split("\n").flatMap((line, index) => [...line.matchAll(SITE)].map(() => ({ file, line: index + 1 })));
}

function unclassified(all: readonly Site[]): Site[] {
  const seen = new Map<string, number>();
  return all.filter((site) => {
    const count = (seen.get(site.file) ?? 0) + 1;
    seen.set(site.file, count);
    return count > (CLASSIFIED[site.file]?.count ?? 0);
  });
}

test("W1-T11369 criterion 1: the census refuses every direct execFileLoopBounded call the helper could carry, and a planted one is caught", () => {
  const planted = sites("src/lib/new-caller.ts", [
    "// execFileLoopBounded(x) in a comment is not a call",
    "import { execFileLoopBounded } from \"./loop-bounded-child.js\";",
    "export const run = () => execFileLoopBounded(\"git\", [], {});",
    "export function read(exec = execFileLoopBounded) { return exec; }",
  ].join("\n"));
  assert.deepEqual(unclassified(planted), [{ file: "src/lib/new-caller.ts", line: 3 }, { file: "src/lib/new-caller.ts", line: 4 }],
    "a planted call and a planted default are caught; a comment and an import are not sites");

  const all = sources(join(REPO_ROOT, "src")).flatMap((path) => {
    const file = relative(REPO_ROOT, path).replaceAll("\\", "/");
    return sites(file, readFileSync(path, "utf8"));
  });
  for (const [file, entry] of Object.entries(CLASSIFIED)) {
    const found = all.filter((site) => site.file === file).length;
    assert.equal(found, entry.count, `positive control: ${file} still holds its ${entry.count} classified call (${entry.reason})`);
    assert.match(readFileSync(join(REPO_ROOT, file), "utf8"), /\.child\.stdin/, `${file} reads .child, the reason it stays direct`);
  }
  assert.deepEqual(unclassified(all), [], "route each call through execFileRouted, or classify it with a reason the pipe cannot carry");
});

/** A helper that records each request and answers it at once. */
function recordingHelper(): SpawnHelper & { requests: SpawnRequest[] } {
  const requests: SpawnRequest[] = [];
  return {
    requests,
    pid: undefined,
    unhealthy: () => undefined,
    run: async (request) => {
      requests.push(request);
      return { exitCode: 0, signal: null, stdout: "", stderr: "", via: "helper", sync_ms: 0 };
    },
    noteDirect: () => undefined,
    stop: () => undefined,
  };
}

test("W1-T11369 criterion 2: each routed call site keeps its own timeout, killSignal, cwd, env and maxBuffer, and a routed child stopped at its budget rejects with LoopBoundedChildTimeout", async () => {
  const helper = recordingHelper();
  installSpawnHelper(helper);
  try {
    await workerAcceptanceProofSpawner("true", [], REPO_ROOT, 4_321);
    await runBuildScriptInChild("script.mjs", ["one"], REPO_ROOT);
    await selectOpenWeightUnitTestSuitesOffLoop(REPO_ROOT, { PATH: "/usr/bin:/bin" });
    await readVmStatAsync("/no/such/vm_stat");
    assert.equal(await runCheckProofChild(["-e", ""], { cwd: REPO_ROOT, timeoutMs: 6_543 }), 0);
    assert.deepEqual(await gitHeartbeatSource(REPO_ROOT)(), []);
    await readPushedRunBranchesOutputAsync(REPO_ROOT);
    const gateDir = mkdtempSync(join(tmpdir(), "rmd-routed-gate-"));
    try {
      const contained = await defaultGateContainment({ cwd: gateDir, home: gateDir, harnessRoot: REPO_ROOT, env: { GATE: "1" } }, { binary: "bwrap-fixture", platform: "linux" });
      assert.equal(contained.mode, "sandboxed", JSON.stringify(contained));
    } finally {
      rmSync(gateDir, { recursive: true, force: true });
    }
  } finally {
    installSpawnHelper(undefined);
  }
  const [proof, build, selection, vmStat, checkProof, heartbeatFetch, heartbeatRefs, runBranches, gate] = helper.requests;
  assert.equal(helper.requests.length, 9, "every call reached the helper");
  assert.deepEqual([heartbeatFetch?.args?.slice(0, 3), heartbeatRefs?.args?.[2], heartbeatFetch?.timeoutMs], [["-C", REPO_ROOT, "fetch"], "for-each-ref", 60_000]);
  assert.deepEqual([runBranches?.file, runBranches?.cwd, runBranches?.killSignal, runBranches?.args?.[0]], ["git", REPO_ROOT, "SIGKILL", "ls-remote"]);
  assert.deepEqual([gate?.file, gate?.env, gate?.timeoutMs, gate?.killSignal], ["bwrap-fixture", { GATE: "1" }, 10_000, "SIGKILL"]);
  assert.deepEqual([proof?.file, proof?.cwd, proof?.timeoutMs, proof?.killSignal], ["true", REPO_ROOT, 4_321, "SIGKILL"]);
  assert.equal(proof?.env?.["NODE_V8_COVERAGE"], undefined, "the proof child's own env reaches the helper");
  assert.ok(proof?.env !== undefined && proof.env !== process.env);
  assert.deepEqual([build?.file, build?.args, build?.cwd, build?.maxBuffer, build?.timeoutMs], [process.execPath, ["script.mjs", "one"], REPO_ROOT, 4 * 1024 * 1024, 10 * 60 * 1000]);
  assert.deepEqual([selection?.file, selection?.env, selection?.maxBuffer], [process.execPath, { PATH: "/usr/bin:/bin" }, 8 * 1024 * 1024]);
  assert.deepEqual([vmStat?.file, vmStat?.timeoutMs], ["/no/such/vm_stat", 5_000]);
  assert.deepEqual([checkProof?.cwd, checkProof?.timeoutMs, checkProof?.env?.["RMD_SELF_SYNC_DONE"]], [REPO_ROOT, 6_543, "1"]);

  // A real helper: the routed child stopped at its budget rejects with the named timeout.
  const real = startSpawnHelper();
  installSpawnHelper(real);
  try {
    const stopped = await workerAcceptanceProofSpawner("sleep", ["30"], REPO_ROOT, 200).then(() => undefined, (e: unknown) => e);
    assert.ok(stopped instanceof LoopBoundedChildTimeout, `a routed child stopped at its budget rejects with LoopBoundedChildTimeout: ${String(stopped)}`);
    assert.equal(await workerAcceptanceProofSpawner("sh", ["-c", "printf routed"], REPO_ROOT, 30_000), "routed");
  } finally {
    real.stop();
    installSpawnHelper(undefined);
  }

  // No helper installed: the same calls run execFileLoopBounded directly, with the same results.
  assert.equal(await workerAcceptanceProofSpawner("sh", ["-c", "printf direct"], REPO_ROOT, 30_000), "direct");
  const direct = await workerAcceptanceProofSpawner("sleep", ["30"], REPO_ROOT, 200).then(() => undefined, (e: unknown) => e);
  assert.ok(direct instanceof LoopBoundedChildTimeout, "with no helper the direct child stopped at its budget rejects the same way");
  assert.equal(await runCheckProofChild(["-e", "process.exit(7)"], { cwd: REPO_ROOT, timeoutMs: 30_000 }), 7);
});
