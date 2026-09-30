import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BAKEOFF_CANDIDATES } from "../src/lib/inbox-bakeoff.js";
import type { Proposal } from "../src/lib/inbox.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { inboxBakeoffCommand } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("inbox-bakeoff command runs its orchestration through injected, non-spending worker seams", async () => {
  const origin = gitRepo({ bare: true, kind: "inbox-bakeoff-origin" });
  const seed = gitRepo({ kind: "inbox-bakeoff-seed" });
  mkdirSync(join(seed.dir, "plan"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "- id: W1-T1\n  status: queued\n");
  seed.git("add", "plan/tasks.yaml");
  seed.git("commit", "--quiet", "-m", "fixture");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");

  const root = mkdtempSync(join(tmpdir(), "rmd-inbox-bakeoff-command-"));
  const home = join(root, "home");
  const stateRoot = join(root, "state");
  const configDir = join(home, ".config", "remudero");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    claudeBin: "/bin/true",
    root: stateRoot,
    installRoot: repoRoot,
  }));
  const proposal: Proposal = {
    id: "P1",
    summary: "a fixture inbox proposal",
    evidenceAnchors: [{ description: "fixture evidence", pattern: "landed" }],
  };
  const registryPath = join(stateRoot, "state", "inbox-proposals.json");
  writeFileSync(registryPath, JSON.stringify({ proposals: [proposal] }));

  const oldHome = process.env.HOME;
  const oldGhToken = process.env.GH_TOKEN;
  const oldGhCache = process.env.RMD_GH_CACHE_HOME;
  const oldError = console.error;
  const oldLog = console.log;
  const errors: string[] = [];
  const output: string[] = [];
  const calls: SpawnWorkerArgs[] = [];
  const cloneCalls: string[][] = [];
  const noSpendSpawn: Parameters<typeof inboxBakeoffCommand>[1] = async (args) => {
    calls.push(args);
    return {} as WorkerResult;
  };
  const replay: Parameters<typeof inboxBakeoffCommand>[2] = async ({ proposals, spawnFor, log }) => {
    log("inbox.bakeoff", { candidate_count: BAKEOFF_CANDIDATES.length });
    for (const candidate of BAKEOFF_CANDIDATES) await spawnFor(candidate)(proposals[0]!, "fixture prompt");
    return [];
  };
  const localGh: Parameters<typeof inboxBakeoffCommand>[3] = (args) => {
    cloneCalls.push(args);
    assert.deepEqual(args.slice(0, 2), ["repo", "clone"]);
    const target = args.at(-1);
    assert.ok(target, "the production clone request carries a target directory");
    execFileSync("git", ["clone", "--quiet", origin.dir, target], { stdio: "ignore" });
  };

  process.env.HOME = home;
  process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
  delete process.env.GH_TOKEN;
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  try {
    const result = await inboxBakeoffCommand(["--sample", "1"], noSpendSpawn, replay, localGh);
    assert.equal(result, 0);
    assert.equal(cloneCalls.length, 1, "an absent checkout uses the injected local clone exactly once");
    assert.match(cloneCalls[0]?.[2] ?? "", /^[^/]+\/[^/]+$/);
    assert.equal(calls.length, BAKEOFF_CANDIDATES.length, "every candidate is routed through the injected fake, never a paid worker");
    assert.ok(calls.slice(0, -1).every((args) => args.routingTrial?.id === "inbox-bakeoff"));
    assert.equal(calls.at(-1)?.routingTrial, undefined, "the subscription candidate is not given a cash routing trial");
    assert.ok(calls.some((args) => Array.isArray(args.tools) && args.tools.length === 0), "the no-tools candidate stays no-tools");
    assert.ok(output.some((line) => line.includes("inbox-bakeoff: 1 proposals")));
    assert.match(readFileSync(join(stateRoot, "state", "ledger.ndjson"), "utf8"), /inbox\.bakeoff/);

    const invalidOption = await inboxBakeoffCommand(["--unknown"], noSpendSpawn, replay);
    const invalidSample = await inboxBakeoffCommand(["--sample", "0"], noSpendSpawn, replay);
    assert.equal(invalidOption, 2);
    assert.equal(invalidSample, 2);
    writeFileSync(registryPath, JSON.stringify({ proposals: [] }));
    const empty = await inboxBakeoffCommand([], noSpendSpawn, replay);
    assert.equal(empty, 1);
    assert.equal(calls.length, BAKEOFF_CANDIDATES.length, "invalid and empty inputs never spawn a worker");
    assert.ok(errors.some((line) => line.includes("no open inbox proposals")));

    const repoDir = join(stateRoot, "repos", "remudero");
    const worktrees = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    assert.equal(worktrees.trim().split("\n").filter((line) => line.startsWith("worktree ")).length, 1,
      "the temporary lane worktree is removed even after the candidate replay");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldGhToken;
    if (oldGhCache === undefined) delete process.env.RMD_GH_CACHE_HOME;
    else process.env.RMD_GH_CACHE_HOME = oldGhCache;
    console.error = oldError;
    console.log = oldLog;
    rmSync(root, { recursive: true, force: true });
    seed.cleanup();
    origin.cleanup();
  }
});
