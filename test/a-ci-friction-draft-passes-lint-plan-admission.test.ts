/**
 * The ci-friction gardener's filing PRs must pass the lint-plan job they open against. #10428 let a
 * check resolve to the workflow job that declares it, so #10434 and #10446 filed shards owned by
 * `.github/workflows/ci.yml` — and both went red on lint-plan's machine-filing admission, because the
 * gardener's own pre-landing lint never ran that check. These tests run the gardener's real ladder and
 * emitter, then lint the shard it wrote with the repo's plan linter exactly as lint-plan --base does.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { runGarden, type GardenCheckout, type GardenerDeps } from "../src/lib/gardener.js";
import { ciFrictionGardenSpec, ciFrictionShardStem, type CiFrictionGardenSources } from "../src/lib/ci-friction-gardener.js";
import type { OwnerSearch } from "../src/lib/ci-friction-remedy.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { lintTask } from "../src/lib/task-linter.js";
import { gitRepo } from "./helpers/git-repo.js";

function fixture(kind: string, ownerFile: string) {
  const repo = gitRepo({ kind });
  mkdirSync(join(repo.dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo.dir, ".github", "workflows", "ci.yml"), "name: ci\non: [pull_request]\njobs:\n  gate:\n    runs-on: ubuntu-latest\n    steps: []\n");
  mkdirSync(join(repo.dir, "notes"), { recursive: true });
  writeFileSync(join(repo.dir, "notes", "friction.md"), "notes\n");
  repo.git("add", ".github/workflows/ci.yml", "notes/friction.md");
  repo.git("commit", "-q", "-m", "seed owners");
  const stateDir = join(repo.dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const landed: string[][] = [];
  const events: string[] = [];
  const land: GardenCheckout["land"] = (opts) => (landed.push(opts.paths), "https://github.com/acme/remudero/pull/1");
  const deps: GardenerDeps = {
    stateDir,
    repoRoot: repo.dir,
    openWorkspace: () => ({ root: repo.dir, branch: "ci-friction-garden-1", land, dispose: () => {} }),
    log: (step) => { events.push(step); },
    seed: 1,
  };
  // No source file names the cause; only the workflow search resolves it — the #10446 shape.
  const ownerSearch: OwnerSearch = {
    filesContaining: () => [],
    fileExists: (file) => existsSync(join(repo.dir, file)),
    workflowOwner: () => ({ files: [ownerFile], why: [`${ownerFile}: declares job gate`] }),
  };
  const sources: CiFrictionGardenSources = {
    ledgerRecords: () => [],
    gateFireRates: () => ({
      status: "measured", prsScanned: 9, neverFired: [], alwaysFired: [],
      gates: [{ gate: "gate", prs: 9, runs: 12, redRuns: 12, refusals: 12, repaired: 12, overridden: 0, minutes: 300 }],
    }),
    planState: () => ({ tasks: [] }),
    ownerSearch,
    mintTaskId: () => "W1-T99990",
  };
  return { repo, landed, events, pass: () => runGarden(ciFrictionGardenSpec(deps, sources), deps) };
}

test("a workflow-owned ci-friction draft files a shard lint-plan's machine-filing admission passes", () => {
  const fx = fixture("ci-friction-workflow-draft", ".github/workflows/ci.yml");
  const pass = fx.pass();
  assert.equal(pass.prUrl, "https://github.com/acme/remudero/pull/1", `the draft landed (events: ${fx.events.join(", ")})`);
  assert.equal(fx.landed.length, 1);
  const [path] = fx.landed[0]!;
  const plan = loadPlanFromYaml(readFileSync(join(fx.repo.dir, path!), "utf8"), path!);
  const task = plan.tasks[0]!;
  assert.equal(task.files?.[0], ".github/workflows/ci.yml", "the shard names the workflow that owns the check");
  const lint = lintTask(task, {
    duplicateSlug: ciFrictionShardStem(task.origin!.slice("ci-friction:".length)),
    machineFilingAdmission: { plan, releasedIds: new Set(), pathExists: (p) => existsSync(join(fx.repo.dir, p)) },
  });
  assert.deepEqual(lint.violations.filter((v) => v.severity === "block").map((v) => `${v.check}: ${v.message}`), []);
});

test("the ci-friction gardener refuses to land a draft machine-filing admission would refuse", () => {
  const fx = fixture("ci-friction-unadmissible-draft", "notes/friction.md");
  const pass = fx.pass();
  assert.equal(pass.prUrl, undefined, "no PR opens for a shard lint-plan would turn red");
  assert.deepEqual(fx.landed, []);
  assert.ok(fx.events.includes("ci-friction.garden_filing_failed"), `the refusal is a recorded filing failure (events: ${fx.events.join(", ")})`);
});
