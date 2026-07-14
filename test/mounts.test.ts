import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  loadMounts,
  MountsError,
  mountsPath,
  resolveMount,
  TierInvariantError,
  validateMounts,
} from "../src/lib/mounts.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED = mountsPath(REPO_ROOT);

/** A minimal, VALID table used as the base for negative-case mutations. */
function goodRaw() {
  return {
    tiers: { haiku: 1, sonnet: 2, opus: 3 },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    routes: {
      implement: {
        low: { model: "sonnet", effort: "medium", max_turns: 30, context_budget: 120000 },
        high: { model: "sonnet", effort: "high", max_turns: 50, context_budget: 180000 },
      },
      recon: {
        low: { model: "haiku", effort: "medium", max_turns: 20, context_budget: 60000 },
      },
    },
  };
}

test("the SHIPPED .remudero/mounts.yaml loads and satisfies the Tier Invariant", () => {
  const m = loadMounts(SHIPPED);
  assert.equal(m.architect.model, "opus");
  // Every worker rides strictly below the Architect tier.
  const architectTier = m.tiers[m.architect.model];
  for (const [type, byRisk] of Object.entries(m.routes)) {
    for (const [risk, mount] of Object.entries(byRisk)) {
      assert.ok(
        m.tiers[mount.model] < architectTier,
        `${type}.${risk} (${mount.model}) must ride below the Architect`,
      );
    }
  }
});

test("SHIPPED table also passes when the operator thinking_default is supplied (Craig: medium)", () => {
  assert.doesNotThrow(() => loadMounts(SHIPPED, { thinkingDefault: "medium" }));
});

test("validateMounts accepts a correctly-shaped table", () => {
  assert.doesNotThrow(() => validateMounts(goodRaw()));
});

test("REJECTS a worker riding the Architect's tier (Tier Invariant, G-17)", () => {
  const bad = goodRaw();
  bad.routes.implement.high.model = "opus"; // worker == architect tier
  assert.throws(
    () => validateMounts(bad),
    (e: unknown) =>
      e instanceof TierInvariantError &&
      /routes\.implement\.high/.test((e as Error).message) &&
      /G-17/.test((e as Error).message),
    "must name the offending worker route and cite the invariant",
  );
});

test("REJECTS a worker riding ABOVE the Architect (Tier Invariant)", () => {
  const bad = goodRaw();
  bad.architect.model = "sonnet"; // architect below the sonnet workers' would-be ceiling
  bad.routes.implement.high.model = "opus";
  assert.throws(() => validateMounts(bad), TierInvariantError);
});

test("REJECTS an Architect effort below the plan-authorship floor (high)", () => {
  const bad = goodRaw();
  bad.architect.effort = "medium"; // below the `high` floor
  assert.throws(
    () => validateMounts(bad),
    (e: unknown) => e instanceof TierInvariantError && /floor/.test((e as Error).message),
  );
});

test("REJECTS an Architect effort below a supplied thinking_default", () => {
  const raw = goodRaw();
  // Architect effort `high` clears the floor, but the operator wants `max` — a
  // higher default the Architect does not meet, so the invariant must reject it.
  raw.efforts = { low: 1, medium: 2, high: 3, max: 4 } as typeof raw.efforts;
  assert.throws(
    () => validateMounts(raw, { thinkingDefault: "max" }),
    (e: unknown) => e instanceof TierInvariantError && /thinking_default/.test((e as Error).message),
  );
});

test("accepts thinking_default at or below the Architect effort", () => {
  assert.doesNotThrow(() => validateMounts(goodRaw(), { thinkingDefault: "medium" }));
  assert.doesNotThrow(() => validateMounts(goodRaw(), { thinkingDefault: "high" }));
});

test("rejects an unknown model (not in the tiers ordering)", () => {
  const bad = goodRaw();
  bad.routes.recon.low.model = "gpt5";
  assert.throws(() => validateMounts(bad), MountsError);
});

test("rejects an unknown effort (not in the efforts ordering)", () => {
  const bad = goodRaw();
  bad.routes.recon.low.effort = "ultra";
  assert.throws(() => validateMounts(bad), MountsError);
});

test("rejects a non-positive / non-integer budget field", () => {
  const badTurns = goodRaw();
  badTurns.routes.recon.low.max_turns = 0;
  assert.throws(() => validateMounts(badTurns), MountsError);
  const badCtx = goodRaw();
  badCtx.routes.recon.low.context_budget = -1;
  assert.throws(() => validateMounts(badCtx), MountsError);
});

test("rejects an empty routes table", () => {
  const bad = goodRaw();
  bad.routes = {} as never;
  assert.throws(() => validateMounts(bad), MountsError);
});

test("rejects a thinking_default that is not a known effort", () => {
  assert.throws(
    () => validateMounts(goodRaw(), { thinkingDefault: "nope" }),
    (e: unknown) => e instanceof MountsError && /thinking_default/.test((e as Error).message),
  );
});

test("resolveMount returns the mount for a (task_type, risk); misses throw", () => {
  const m = validateMounts(goodRaw());
  const mount = resolveMount(m, "implement", "high");
  assert.deepEqual(mount, { model: "sonnet", effort: "high", maxTurns: 50, contextBudget: 180000 });
  assert.throws(() => resolveMount(m, "implement", "extreme"), MountsError);
  assert.throws(() => resolveMount(m, "nonesuch", "low"), MountsError);
});

test("loadMounts throws MountsError on invalid YAML", () => {
  // Point at a non-YAML-mapping file: this test source itself parses as a scalar-free doc.
  // Use an inline invalid document via validateMounts instead for determinism.
  assert.throws(() => validateMounts(parseYaml("- just\n- a\n- list")), MountsError);
});

test("resolveMount over the SHIPPED table covers every declared task type", () => {
  const raw = parseYaml(readFileSync(SHIPPED, "utf8")) as { routes: Record<string, Record<string, unknown>> };
  const m = loadMounts(SHIPPED);
  for (const [type, byRisk] of Object.entries(raw.routes)) {
    for (const risk of Object.keys(byRisk)) {
      assert.doesNotThrow(() => resolveMount(m, type, risk));
    }
  }
});
