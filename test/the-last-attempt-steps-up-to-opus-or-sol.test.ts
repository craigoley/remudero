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

test("the loader refuses a step_up ABOVE the Architect's tier, allows a PEER, and an absent row means no step-up", () => {
  // Operator ruling 2026-09-22: a peer tier is allowed, above it is not. The step-up is held to the
  // bar the `judge` seat already clears — `judge: opus` (3) is a peer of a squeeze Architect on
  // `gpt-5.6-terra` (3) and nothing refuses that, because G-17 constrains worker ROUTES, not seats.
  // Requiring STRICT dominance here made the whole table unloadable under exactly that squeeze,
  // which is what `test/the-top-tier-is-not-claude-only.test.ts` pins.
  const raw = readFileSync(mountsPath(REPO_ROOT), "utf8");
  const root = mkdtempSync(join(tmpdir(), "rmd-step-up-"));
  try {
    const architectModel = loadMounts(mountsPath(REPO_ROOT)).architect.model;
    const block = "step_up:\n  model: opus\n";
    assert.ok(raw.includes(block));

    // PEER: the step-up riding the Architect's own model is the same tier, so it loads.
    writeFileSync(join(root, "peer.yaml"), raw.replace(block, `step_up:\n  model: ${architectModel}\n`));
    assert.equal(loadMounts(join(root, "peer.yaml")).step_up?.model, architectModel);

    // ABOVE: drop the Architect to `opus` (3) and leave the step-up on the tier-4 model, so the
    // step-up now OUTRANKS the Architect — the one case the rule still refuses.
    const architectBlock = `architect:\n  model: ${architectModel}\n`;
    assert.ok(raw.includes(architectBlock), "the committed table declares the Architect this way");
    writeFileSync(
      join(root, "above.yaml"),
      raw.replace(architectBlock, "architect:\n  model: opus\n").replace(block, `step_up:\n  model: ${architectModel}\n`),
    );
    assert.throws(() => loadMounts(join(root, "above.yaml")), (error: unknown) =>
      error instanceof MountsError && /must not outrank the Architect/.test(error.message));

    writeFileSync(join(root, "absent.yaml"), raw.replace(/step_up:\n(?: {2}.*\n)+/, ""));
    assert.equal(loadMounts(join(root, "absent.yaml")).step_up, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
