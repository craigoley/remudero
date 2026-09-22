import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMounts, MountsError, mountsPath } from "../src/lib/mounts.js";

// Operator ruling 2026-09-22: "Sol and Opus are okay to use whenever Luna or Sonnet can't do the
// work, but I would prefer that we try Luna and Sonnet for most tasks." The routes stay on the
// Sonnet/Luna tier; the step_up row is the one place a worker attempt reaches Opus or Sol.

const REPO_ROOT = join(import.meta.dirname, "..");

test("every worker route stays at or below the sonnet ceiling while step_up rides opus", () => {
  const table = loadMounts(mountsPath(REPO_ROOT));
  const sonnet = table.tiers.sonnet;
  for (const [type, byRisk] of Object.entries(table.routes)) {
    for (const [risk, byClass] of Object.entries(byRisk)) {
      for (const [cls, mount] of Object.entries(byClass)) {
        assert.ok(table.tiers[mount.model] <= sonnet, `${type}.${risk}.${cls} rides ${mount.model}`);
      }
    }
  }
  assert.deepEqual(table.step_up, { model: "opus", effort: "high", maxTurns: 400, contextBudget: 180000 });
  assert.equal(table.capabilities?.claude.opus, "frontier", "step_up resolves the frontier capability, so Opus first and Sol 6 behind it");
});

test("the loader refuses a step_up at or above the Architect's tier, and an absent row means no step-up", () => {
  const raw = readFileSync(mountsPath(REPO_ROOT), "utf8");
  const root = mkdtempSync(join(tmpdir(), "rmd-step-up-"));
  try {
    const architectModel = loadMounts(mountsPath(REPO_ROOT)).architect.model;
    const block = "step_up:\n  model: opus\n";
    assert.ok(raw.includes(block));
    writeFileSync(join(root, "equal.yaml"), raw.replace(block, `step_up:\n  model: ${architectModel}\n`));
    assert.throws(() => loadMounts(join(root, "equal.yaml")), (error: unknown) =>
      error instanceof MountsError && /strictly below the Architect/.test(error.message));
    writeFileSync(join(root, "absent.yaml"), raw.replace(/step_up:\n(?: {2}.*\n)+/, ""));
    assert.equal(loadMounts(join(root, "absent.yaml")).step_up, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
