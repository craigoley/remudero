import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { loadPlan } from "../src/lib/plan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const GUARD_PATH = join(REPO_ROOT, ".github", "workflows", "main-plan-guard.yml");

// ── W1-T491: the guard that asks whether `main`'s plan still loads ────────────────────────────
//
// Two same-base PRs can each be correctly green and still produce a `main` on which `loadPlan`
// refuses. Every other gate is `pull_request`-triggered, so nothing on `main` notices. These
// tests hold up the three properties that make the guard trustworthy rather than decorative:
// it FIRES on the two ways a plan actually goes unloadable, it stays GREEN on a healthy plan
// (asserted against the REAL tree, not only a fixture — a tripwire that is always red is a
// tripwire nobody reads), and it is wired to run on every push to `main` without a path filter
// or a test-suite run.

/** A minimal well-formed task entry — the smallest shape `loadPlanFromYaml` accepts. */
const task = (id: string, dependsOn: string[] = []): string =>
  [
    `- id: ${id}`,
    `  title: ${id.toLowerCase()}`,
    "  repo: remudero",
    "  type: implement",
    `  depends_on: [${dependsOn.join(", ")}]`,
    "  status: queued",
  ].join("\n");

/** Write a plan tree (monolith + optional shards) into a fresh temp dir; return the tasks.yaml. */
function planTree(monolith: string, shards: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-main-plan-guard-"));
  const monolithPath = join(dir, "tasks.yaml");
  writeFileSync(monolithPath, monolith + "\n");
  const shardNames = Object.keys(shards);
  if (shardNames.length > 0) {
    mkdirSync(join(dir, "tasks.d"), { recursive: true });
    for (const name of shardNames) {
      writeFileSync(join(dir, "tasks.d", name), shards[name] + "\n");
    }
  }
  return monolithPath;
}

/** The guard workflow, parsed. */
function guardWorkflow(): Record<string, unknown> {
  return parseYaml(readFileSync(GUARD_PATH, "utf8")) as Record<string, unknown>;
}

/** Every `run:` script in the guard, concatenated — what the job actually executes. */
function guardRunScripts(): string {
  const wf = guardWorkflow() as { jobs?: Record<string, { steps?: Array<{ run?: string }> }> };
  const steps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
  return steps.map((s) => s.run ?? "").join("\n");
}

// FAILURE MODE 1 — the class that broke main twice: two differently-NAMED files, one id.
test("main-plan-load-guard: a duplicate task id across a shard and the monolith makes loadPlan refuse", () => {
  const planPath = planTree(task("W1-T1"), { "collides.yaml": task("W1-T1") });
  assert.throws(
    () => loadPlan(planPath),
    /duplicate task id/,
    "a shard re-declaring a monolith id must refuse to load — this is the exact pairing that took main down",
  );
});

// FAILURE MODE 2 — same run catches it, per loadPlanFromYaml's dependency resolution.
test("main-plan-load-guard: a depends_on naming a task outside the blob makes loadPlan refuse", () => {
  const planPath = planTree([task("W1-T1"), task("W1-T2", ["W1-T404"])].join("\n"));
  assert.throws(
    () => loadPlan(planPath),
    /depends_on unknown task/,
    "a dependency naming a task no shard supplies must refuse to load",
  );
});

// THE HEALTHY CASE, DRIVEN AGAINST THE REAL TREE — without this the guard is a tripwire nobody
// can trust, and a permanently-red check on main teaches the operator to ignore it.
test("main-plan-load-guard: the live plan in this repo loads cleanly so the guard is a detector and not a permanent red", () => {
  const plan = loadPlan(join(REPO_ROOT, "plan", "tasks.yaml"));
  assert.ok(
    plan.tasks.length > 0,
    "the real plan must load and yield tasks — the guard's green state has to be reachable",
  );
});

// WIRING — a guard that does not run, or that a path filter can silence, is not a guard.
test("main-plan-load-guard: the guard runs on push to main and declares no path filter", () => {
  const wf = guardWorkflow() as {
    on?: { push?: { branches?: string[]; paths?: string[]; "paths-ignore"?: string[] } };
  };
  // `on:` is YAML 1.1-truthy in some parsers; assert against whichever key carries the triggers.
  const on = (wf.on ?? (wf as Record<string, unknown>)[true as unknown as string]) as {
    push?: { branches?: string[]; paths?: string[]; "paths-ignore"?: string[] };
  };
  assert.deepEqual(on.push?.branches, ["main"], "the guard must trigger on push to main");
  assert.equal(on.push?.paths, undefined, "no paths filter — a filtered check can go silently absent");
  assert.equal(on.push?.["paths-ignore"], undefined, "no paths-ignore filter, for the same reason");
});

// COST — the whole argument for a dedicated workflow is that it does NOT buy a suite run per merge.
test("main-plan-load-guard: the guard loads the plan without running the PR test suite", () => {
  const scripts = guardRunScripts();
  assert.match(scripts, /loadPlan\(/, "the guard must actually load the plan");
  assert.doesNotMatch(scripts, /node --test|npm test|experimental-test-coverage/, "no suite run per merge");
  // `lint-plan` exits 1 on ordinary violations (main carries many), so gating on it would be
  // permanently red and would not discriminate an unloadable plan.
  assert.doesNotMatch(scripts, /lint-plan/, "the guard must not gate on lint-plan's exit code");
});
