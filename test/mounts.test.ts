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
  resolveMountForClass,
  TierInvariantError,
  validateMounts,
} from "../src/lib/mounts.js";
import { DEFAULT_TASK_CLASS } from "../src/lib/task-class.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED = mountsPath(REPO_ROOT);

/** A minimal, VALID table used as the base for negative-case mutations. Every
 *  risk cell is a mapping of class → mount (W1-T167); `src` is the required
 *  default class every risk cell must carry. */
function goodRaw() {
  return {
    tiers: { haiku: 1, sonnet: 2, opus: 3 },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "opus", effort: "high", max_turns: 60, context_budget: 180000 },
    judge: { model: "opus", effort: "high", max_turns: 60, context_budget: 150000 },
    routes: {
      implement: {
        low: { src: { model: "sonnet", effort: "medium", max_turns: 30, context_budget: 120000 } },
        high: { src: { model: "sonnet", effort: "high", max_turns: 50, context_budget: 180000 } },
      },
      recon: {
        low: { src: { model: "haiku", effort: "medium", max_turns: 20, context_budget: 60000 } },
      },
    },
  };
}

test("the SHIPPED .remudero/mounts.yaml loads and satisfies the Tier Invariant", () => {
  const m = loadMounts(SHIPPED);
  assert.equal(m.architect.model, "opus");
  assert.equal(m.judge.model, "opus");
  // Every worker rides strictly below the Architect tier AND the judge tier —
  // across every class row, not just `src` (W1-T167: the invariant descends
  // into the class layer).
  const architectTier = m.tiers[m.architect.model];
  const judgeTier = m.tiers[m.judge.model];
  for (const [type, byRisk] of Object.entries(m.routes)) {
    for (const [risk, byClass] of Object.entries(byRisk)) {
      for (const [cls, mount] of Object.entries(byClass)) {
        assert.ok(
          m.tiers[mount.model] < architectTier,
          `${type}.${risk}.${cls} (${mount.model}) must ride below the Architect`,
        );
        assert.ok(
          m.tiers[mount.model] < judgeTier,
          `${type}.${risk}.${cls} (${mount.model}) must ride below the flight judge`,
        );
      }
    }
  }
});

test("REJECTS a `judge` mount at or below the worker ceiling (W1-T21/G-17)", () => {
  const bad = goodRaw();
  bad.judge.model = "sonnet"; // judge == the sonnet worker ceiling
  assert.throws(
    () => validateMounts(bad),
    (e: unknown) =>
      e instanceof TierInvariantError &&
      /flight judge/.test((e as Error).message) &&
      /G-17/.test((e as Error).message),
    "must name the flight judge and cite the invariant",
  );
});

test("REJECTS a worker riding AT the judge's tier even when it stays below the Architect", () => {
  const bad = goodRaw();
  bad.judge.model = "sonnet";
  bad.architect.model = "opus";
  bad.routes.implement.high.src.model = "sonnet"; // == judge tier, still < architect tier
  assert.throws(() => validateMounts(bad), TierInvariantError);
});

test("ACCEPTS a `judge` mount riding the Architect's own tier, strictly above every worker", () => {
  const good = goodRaw();
  good.judge.model = "opus";
  assert.doesNotThrow(() => validateMounts(good));
});

test("SHIPPED table also passes when the operator thinking_default is supplied (Craig: medium)", () => {
  assert.doesNotThrow(() => loadMounts(SHIPPED, { thinkingDefault: "medium" }));
});

test("validateMounts accepts a correctly-shaped table", () => {
  assert.doesNotThrow(() => validateMounts(goodRaw()));
});

test("REJECTS a worker riding the Architect's tier (Tier Invariant, G-17)", () => {
  const bad = goodRaw();
  bad.routes.implement.high.src.model = "opus"; // worker == architect tier
  assert.throws(
    () => validateMounts(bad),
    (e: unknown) =>
      e instanceof TierInvariantError &&
      /routes\.implement\.high\.src/.test((e as Error).message) &&
      /G-17/.test((e as Error).message),
    "must name the offending worker route (including its class) and cite the invariant",
  );
});

test("REJECTS a NON-default class row riding the Architect's tier (W1-T167 — the invariant is not src-only)", () => {
  const bad = goodRaw();
  (bad.routes.implement.low as Record<string, unknown>).docs = {
    model: "opus",
    effort: "high",
    max_turns: 400,
    context_budget: 40000,
  };
  assert.throws(
    () => validateMounts(bad),
    (e: unknown) =>
      e instanceof TierInvariantError &&
      /routes\.implement\.low\.docs/.test((e as Error).message) &&
      /G-17/.test((e as Error).message),
  );
});

test("REJECTS a `reviewer` row riding the Architect's tier (W1-T63/G-17 — the new row is not exempt)", () => {
  const bad = goodRaw();
  (bad.routes as Record<string, unknown>).reviewer = {
    high: { src: { model: "opus", effort: "high", max_turns: 400, context_budget: 200000 } },
  };
  assert.throws(
    () => validateMounts(bad),
    (e: unknown) =>
      e instanceof TierInvariantError &&
      /routes\.reviewer\.high\.src/.test((e as Error).message) &&
      /G-17/.test((e as Error).message),
  );
});

test("ACCEPTS a `reviewer` row at the sonnet worker ceiling, strictly below the opus Architect", () => {
  const good = goodRaw();
  (good.routes as Record<string, unknown>).reviewer = {
    high: { src: { model: "sonnet", effort: "high", max_turns: 400, context_budget: 200000 } },
  };
  assert.doesNotThrow(() => validateMounts(good));
});

test("REJECTS a worker riding ABOVE the Architect (Tier Invariant)", () => {
  const bad = goodRaw();
  bad.architect.model = "sonnet"; // architect below the sonnet workers' would-be ceiling
  bad.routes.implement.high.src.model = "opus";
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
  bad.routes.recon.low.src.model = "gpt5";
  assert.throws(() => validateMounts(bad), MountsError);
});

test("rejects an unknown effort (not in the efforts ordering)", () => {
  const bad = goodRaw();
  bad.routes.recon.low.src.effort = "ultra";
  assert.throws(() => validateMounts(bad), MountsError);
});

test("rejects a non-positive / non-integer budget field", () => {
  const badTurns = goodRaw();
  badTurns.routes.recon.low.src.max_turns = 0;
  assert.throws(() => validateMounts(badTurns), MountsError);
  const badCtx = goodRaw();
  badCtx.routes.recon.low.src.context_budget = -1;
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

// ── W1-T167: the class axis — policy-as-data, no code branch ────────────────

test("a risk cell missing the 'src' default class is REJECTED at load", () => {
  const bad = goodRaw();
  (bad.routes.implement.low as Record<string, unknown>) = {
    docs: { model: "haiku", effort: "low", max_turns: 400, context_budget: 40000 },
  };
  assert.throws(
    () => validateMounts(bad),
    (e: unknown) => e instanceof MountsError && /routes\.implement\.low/.test((e as Error).message) && /src/.test((e as Error).message),
  );
});

test("resolveMountForClass resolves the class-specific row when it exists, exactly (no fallback)", () => {
  const raw = goodRaw();
  (raw.routes.implement.low as Record<string, unknown>).docs = {
    model: "haiku",
    effort: "low",
    max_turns: 400,
    context_budget: 40000,
  };
  const m = validateMounts(raw);
  const r = resolveMountForClass(m, "implement", "low", "docs");
  assert.equal(r.fellBackToDefault, false);
  assert.equal(r.requestedClass, "docs");
  assert.equal(r.resolvedClass, "docs");
  assert.deepEqual(r.mount, { model: "haiku", effort: "low", maxTurns: 400, contextBudget: 40000 });
});

test("resolveMountForClass FALLS BACK to 'src' and REPORTS the fallback when the class has no row (never silent)", () => {
  const m = validateMounts(goodRaw()); // implement.low has ONLY a `src` row
  const r = resolveMountForClass(m, "implement", "low", "docs");
  assert.equal(r.fellBackToDefault, true);
  assert.equal(r.requestedClass, "docs");
  assert.equal(r.resolvedClass, DEFAULT_TASK_CLASS);
  assert.deepEqual(r.mount, { model: "sonnet", effort: "medium", maxTurns: 30, contextBudget: 120000 });
});

test("resolveMountForClass still FAILS LOUD on an unrouted task_type / risk (a class miss is the ONLY silent-capable case)", () => {
  const m = validateMounts(goodRaw());
  assert.throws(() => resolveMountForClass(m, "implement", "extreme", "docs"), MountsError);
  assert.throws(() => resolveMountForClass(m, "nonesuch", "low", "docs"), MountsError);
});

test("the SHIPPED table: a docs/plan-lint class resolves a CHEAPER mount than risk:high src (the default, unchanged)", () => {
  const m = loadMounts(SHIPPED);
  const cheap = resolveMountForClass(m, "implement", "low", "docs");
  const highSrc = resolveMountForClass(m, "implement", "high", "src");
  assert.equal(cheap.fellBackToDefault, false, "the shipped table must carry a real implement.low.docs row");
  assert.equal(highSrc.resolvedClass, "src");
  const cheapTier = m.tiers[cheap.mount.model];
  const defaultTier = m.tiers[highSrc.mount.model];
  assert.ok(
    cheapTier < defaultTier || (cheapTier === defaultTier && m.efforts[cheap.mount.effort] < m.efforts[highSrc.mount.effort]),
    `docs class (${cheap.mount.model}/${cheap.mount.effort}) must be cheaper than risk:high src (${highSrc.mount.model}/${highSrc.mount.effort})`,
  );
});

test("the SHIPPED table: risk:high has NO docs/plan-lint row for implement — a class miss there falls back LOUDLY", () => {
  const m = loadMounts(SHIPPED);
  const r = resolveMountForClass(m, "implement", "high", "docs");
  assert.equal(r.fellBackToDefault, true);
  assert.equal(r.resolvedClass, "src");
});

test("changing a routing DECISION is a data edit — mutating the raw table changes resolveMountForClass's answer with NO code change", () => {
  const raw = goodRaw();
  (raw.routes.implement.low as Record<string, unknown>).docs = {
    model: "haiku",
    effort: "low",
    max_turns: 400,
    context_budget: 40000,
  };
  const before = resolveMountForClass(validateMounts(raw), "implement", "low", "docs");
  assert.equal(before.mount.effort, "low");
  (raw.routes.implement.low as Record<string, { effort: string }>).docs.effort = "medium";
  const after = resolveMountForClass(validateMounts(raw), "implement", "low", "docs");
  assert.equal(after.mount.effort, "medium", "a routing-table row edit alone must change the resolved mount");
});

test("resolveMountForClass: a hand-built Mounts missing BOTH the class row and the default fallback fails LOUD (the guarded unreachable), never returns undefined", () => {
  const handBuilt = {
    routes: { implement: { medium: { docs: { model: "haiku", effort: "low", maxTurns: 10, contextBudget: 1 } } } },
  } as never;
  assert.throws(
    () => resolveMountForClass(handBuilt, "implement", "medium", "src"),
    /and no 'src' fallback either/,
  );
});
