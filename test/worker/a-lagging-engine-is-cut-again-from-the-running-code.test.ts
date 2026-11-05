// 2026-11-05: engines were cut only after a build run cut its worktree, but every build run first ran a containment
// probe FROM the newest engine. When that engine's code failed the probe, no build cut a worktree and no engine was cut:
// the probe kept running stale code for 4+ h. A spawn that finds the engine behind main now asks for an engine cut from
// the running process's own code tree.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { StoreBuildResult } from "#src/lib/child-entry-store.js";
import { refreshEngineFromCodeTree, type EngineGit } from "#src/lib/engine-tree.js";
import { startRunChildProbe, type RunChildProbeInput } from "#src/lib/run-child.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const MAIN = "m".repeat(40);
const ENGINE = "e".repeat(40);
const CODE = "c".repeat(40);
const HASH = "a".repeat(64);
const TIMEOUT = { timeout: 30_000 };
const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });
const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}engine-refresh-${label}-`));
  scratch.push(dir);
  return dir;
};

type Row = { step: string; extra?: Record<string, unknown> };
const recorder = (): { rows: Row[]; log: (step: string, extra?: Record<string, unknown>) => void } => {
  const rows: Row[] = [];
  return { rows, log: (step, extra) => rows.push({ step, extra }) };
};
const headIs = (sha: string): EngineGit => async (_dir, args) => {
  if (args[0] === "rev-parse" && args[1] === "HEAD") return `${sha}\n`;
  throw new Error(`unexpected git ${args.join(" ")}`);
};

test("a lagging engine is refreshed from the code tree: the store is filled and an engine pass runs, both ledgered", TIMEOUT, async () => {
  const state = tmp("lag");
  const { rows, log } = recorder();
  const calls: string[] = [];
  const stored: StoreBuildResult = { kind: "built", hash: HASH, ms: 1, bytes: 1 };
  await refreshEngineFromCodeTree("/code", state, "/store", { engineSha: ENGINE, mainSha: MAIN }, log, {
    git: headIs(CODE),
    buildIntoStore: async (tree, opts) => { calls.push(`store ${tree} ${opts.storeRoot}`); return stored; },
    afterStore: async (tree, stateRoot, storeRoot, got) => { calls.push(`engine ${tree} ${stateRoot === state} ${storeRoot} ${got === stored}`); },
  });
  assert.deepEqual(calls, ["store /code /store", "engine /code true /store true"]);
  assert.deepEqual(rows.map((r) => r.step), ["engine.refresh_requested", "engine.refresh_done"]);
  assert.deepEqual(rows[0].extra, { code_sha: CODE, engine_sha: ENGINE, main_sha: MAIN });
});

test("no refresh when the engine already holds the code tree's revision, and one per revision otherwise", TIMEOUT, async () => {
  const state = tmp("once");
  const { rows, log } = recorder();
  let builds = 0;
  const opts = {
    git: headIs(CODE),
    buildIntoStore: async (): Promise<StoreBuildResult> => { builds++; return { kind: "present", hash: HASH }; },
    afterStore: async () => {},
  };
  await refreshEngineFromCodeTree("/code", state, "/store", { engineSha: CODE, mainSha: MAIN }, log, opts);
  assert.equal(builds, 0, "the engine is the code tree's revision: nothing to cut");
  const a = refreshEngineFromCodeTree("/code", state, "/store", { engineSha: ENGINE, mainSha: MAIN }, log, opts);
  const b = refreshEngineFromCodeTree("/code", state, "/store", { engineSha: ENGINE, mainSha: MAIN }, log, opts);
  assert.equal(a, b, "a concurrent ask joins the pass in flight");
  await a;
  await refreshEngineFromCodeTree("/code", state, "/store", { engineSha: ENGINE, mainSha: MAIN }, log, opts);
  assert.equal(builds, 1, "a revision already refreshed is not refreshed again");
  assert.equal(rows.filter((r) => r.step === "engine.refresh_requested").length, 1);
});

test("a refresh that throws is ledgered and never rejects", TIMEOUT, async () => {
  const state = tmp("throws");
  const { rows, log } = recorder();
  await refreshEngineFromCodeTree("/code", state, "/store", { engineSha: ENGINE, mainSha: MAIN }, log, {
    git: headIs(CODE),
    buildIntoStore: async () => { throw new Error("store unwritable"); },
    afterStore: async () => {},
  });
  const failed = rows.find((r) => r.step === "engine.refresh_failed");
  assert.ok(failed, "the failure has a row");
  assert.match(String(failed.extra?.reason), /store unwritable/);
});

function engineFixture(sha: string): string {
  const state = tmp("probe");
  const root = join(state, "engines", HASH);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "engine.json"), `${JSON.stringify({ sha, sourceHash: HASH, builtAt: 1 })}\n`);
  return state;
}
const probeInput = (state: string): RunChildProbeInput => ({
  taskId: "W1-T1", stateRoot: state, repoDir: "/repo", root: state, plan: Promise.resolve(undefined), options: {} as RunChildProbeInput["options"], log: () => {},
});
async function probeAsks(engineSha: string): Promise<{ engineSha: string | null; mainSha: string }[]> {
  const state = engineFixture(engineSha);
  const asked: { engineSha: string | null; mainSha: string }[] = [];
  await startRunChildProbe(probeInput(state), {
    readMode: () => "shadow",
    mainSha: async () => MAIN,
    engine: { isCurrent: () => true, git: async () => "" },
    refreshEngine: (_input, lag) => { asked.push(lag); },
    launch: () => { throw new Error("stop after the engine is chosen"); },
  });
  return asked;
}

test("a probe spawned on an engine behind main asks for a current engine; one at main does not", TIMEOUT, async () => {
  assert.deepEqual(await probeAsks(ENGINE), [{ engineSha: ENGINE, mainSha: MAIN }]);
  assert.deepEqual(await probeAsks(MAIN), []);
});
