import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { inboxBakeoffCommand } from "#src/run-task.js";
import { inboxDraftPrompt } from "#src/lib/inbox.js";
import { loadPlan } from "#src/lib/plan.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const task = (id: string, title: string) => ({ id, title, repo: "remudero", type: "implement", verify: "auto", depends_on: [], files: ["src/fixture.ts"], acceptance: [] });
const proposal = { id: "fixture-canonical-plan", summary: "Use the existing shard dependency", evidenceAnchors: [{ description: "fixture", pattern: "fixture" }] };

async function withFixture(shard: string | undefined, run: (ports: {
  seed: string;
  currentProductionTasks: () => ReturnType<typeof loadPlan>["tasks"];
  command: (replay: Parameters<typeof inboxBakeoffCommand>[2]) => Promise<number>;
}) => Promise<void>): Promise<void> {
  const origin = gitRepo({ bare: true, kind: "bakeoff-canonical-origin" });
  const seed = gitRepo({ kind: "bakeoff-canonical-seed" });
  const root = mkdtempSync(join(tmpdir(), "rmd-bakeoff-canonical-"));
  const home = join(root, "home"), stateRoot = join(root, "state"), configDir = join(home, ".config", "remudero");
  const saved = new Map(["HOME", "GH_TOKEN", "RMD_GH_CACHE_HOME"].map((key) => [key, process.env[key]]));
  const oldLog = console.log, oldError = console.error;
  let spawns = 0;
  try {
    mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(seed.dir, "plan", "tasks.yaml"), stringify([task("BASE-T1", "base dependency")]));
    if (shard !== undefined) writeFileSync(join(seed.dir, "plan", "tasks.d", "SHARD-T2.yaml"), shard);
    seed.git("add", "plan");
    seed.git("commit", "--quiet", "-m", "canonical plan fixture");
    seed.addRemote("origin", origin.dir);
    seed.git("push", "--quiet", "origin", "main");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(join(stateRoot, "state"), { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ root: stateRoot, installRoot: repoRoot, claudeBin: "/bin/true" }));
    writeFileSync(join(stateRoot, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [proposal] }));
    process.env.HOME = home;
    delete process.env.GH_TOKEN;
    process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
    console.log = () => {};
    console.error = () => {};
    const noSpend: Parameters<typeof inboxBakeoffCommand>[1] = async () => {
      spawns++;
      throw new Error("No provider may run in this fixture");
    };
    const clone: Parameters<typeof inboxBakeoffCommand>[3] = (args) => {
      assert.deepEqual(args.slice(0, 2), ["repo", "clone"]);
      assert.ok(args.at(-1));
      execFileSync("git", ["clone", "--quiet", origin.dir, args.at(-1)!], { stdio: "ignore" });
    };
    const currentProductionTasks = () => {
      const listing = execFileSync("git", ["-C", join(stateRoot, "repos", "remudero"), "worktree", "list", "--porcelain"], { encoding: "utf8" });
      const lanes = listing.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9)).filter((path) => path.startsWith(join(stateRoot, "worktrees") + sep));
      assert.equal(lanes.length, 1, "the active fixture has exactly one owned measured worktree");
      return loadPlan(join(lanes[0]!, "plan", "tasks.yaml")).tasks;
    };
    await run({ seed: seed.dir, currentProductionTasks, command: (replay) => inboxBakeoffCommand(["--sample", "1"], noSpend, replay, clone) });
    const registered = execFileSync("git", ["-C", join(stateRoot, "repos", "remudero"), "worktree", "list", "--porcelain"], { encoding: "utf8" });
    assert.equal(registered.split("\n").filter((line) => line.startsWith("worktree ")).length, 1, "success and loader failure retire only the owned temporary lane worktree");
    assert.equal(spawns, 0, "the test never calls a provider");
  } finally {
    console.log = oldLog;
    console.error = oldError;
    for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
    seed.cleanup();
    origin.cleanup();
  }
}

test("the bakeoff measures the canonical plan including shard-only dependencies", async () => {
  const title = "A whole finding in a shard must reach the measured prompt without being clipped";
  await withFixture(stringify([task("SHARD-T2", title)]), async ({ seed, currentProductionTasks, command }) => {
    const productionTasks = loadPlan(join(seed, "plan", "tasks.yaml")).tasks;
    assert.deepEqual(productionTasks.map((row) => row.id), ["BASE-T1", "SHARD-T2"], "positive control opens both real plan forms");
    let replays = 0;
    assert.equal(await command(async ({ planText }) => {
      replays++;
      assert.deepEqual(parse(planText).map((row: { id: string }) => row.id), productionTasks.map((row) => row.id), "no shard-only dependency disappears from the measured input");
      assert.deepEqual(parse(planText), parse(stringify(currentProductionTasks())), "the measured replay receives the same canonical materialization from its actual worktree, including source provenance");
      const prompt = inboxDraftPrompt(proposal, planText, "fixture-no-provider");
      assert.ok(prompt.includes("SHARD-T2"));
      assert.ok(prompt.includes(title), "whole titles remain available to dependency grounding");
      return [];
    }), 0);
    assert.equal(replays, 1);
  });
});

test("a malformed canonical shard refuses bakeoff before any replay or provider call", async () => {
  await withFixture("- id: SHARD-T2\n  title: [unterminated\n", async ({ command }) => {
    let replays = 0;
    await assert.rejects(() => command(async () => { replays++; return []; }), /YAML|parse|unterminated|flow sequence/i);
    assert.equal(replays, 0, "a corrupt shard is not measured as a smaller successful plan");
  });
});

test("a monolith-only plan still reaches one non-spending bakeoff replay", async () => {
  await withFixture(undefined, async ({ seed, command }) => {
    const expected = loadPlan(join(seed, "plan", "tasks.yaml")).tasks;
    let replays = 0;
    assert.equal(await command(async ({ planText }) => {
      replays++;
      assert.deepEqual(parse(planText).map((row: { id: string }) => row.id), expected.map((row) => row.id));
      assert.equal(parse(planText)[0].title, expected[0]!.title);
      return [];
    }), 0);
    assert.equal(replays, 1);
  });
});

