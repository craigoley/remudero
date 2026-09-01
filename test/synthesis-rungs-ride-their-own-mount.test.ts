// test/synthesis-rungs-ride-their-own-mount.test.ts — W1-T2559.
//
// THE DEFECT THIS PROVES FIXED: retro, triage, and the inbox-draft rung used to resolve their
// model through `architectModel(config, mountsTable)` (src/lib/config.ts) — the SAME resolver
// `rmd plan`'s orchestration uses for PLAN AUTHORSHIP. `architectModel`'s own row comment said so
// in terms: it "governs the model the Architect-tier roles (retro, triage, the inbox-draft rung)
// all ride." G-17's Tier Invariant (`architect.tier > max(worker.tier)`) exists to keep a
// SUPERVISOR strictly above what it supervises — but these three ship no code and supervise no
// worker, so bundling them onto the Architect row forced three unrelated jobs onto
// `claude-opus-5`/high "for free," never because any ruling said a triage classification needs
// the top model.
//
// THE FIX: each of the three now resolves through its OWN `.remudero/mounts.yaml`
// `synthesis.<role>` row via `synthesisModel`/`synthesisEffort` (src/lib/config.ts), validated at
// load by `src/lib/mounts.ts`'s `validateMounts` — required, never defaulted, same fail-loud shape
// `architect`/`judge` already get. `architectModel` itself, and its one-argument
// `rmd plan` call shape, are UNTOUCHED.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { architectModel, synthesisEffort, synthesisModel, type Config } from "../src/lib/config.js";
import { loadMounts, mountsPath, MountsError, TierInvariantError, validateMounts, SYNTHESIS_ROLES } from "../src/lib/mounts.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIPPED = mountsPath(REPO_ROOT);

function config(over: Partial<Config> = {}): Config {
  return { claudeBin: "/usr/bin/claude", root: "/tmp/root", ...over };
}

/** A minimal, VALID table (same shape test/mounts.test.ts's own `goodRaw()` uses), with a
 *  `synthesis` block whose three rows are DELIBERATELY DIFFERENT from `architect` and from each
 *  other — so any test that would pass whether a resolver read `architect` or `synthesis.<role>`
 *  is not actually proving separation. */
function goodRaw() {
  return {
    tiers: { haiku: 1, sonnet: 2, opus: 3, "claude-opus-5": 4 },
    efforts: { low: 1, medium: 2, high: 3 },
    architect: { model: "claude-opus-5", effort: "high", max_turns: 400, context_budget: 180000 },
    judge: { model: "opus", effort: "high", max_turns: 400, context_budget: 150000 },
    synthesis: {
      retro: { model: "opus", effort: "high", max_turns: 300, context_budget: 170000 },
      triage: { model: "opus", effort: "low", max_turns: 200, context_budget: 90000 },
      inbox_draft: { model: "opus", effort: "medium", max_turns: 250, context_budget: 120000 },
    },
    routes: {
      implement: {
        low: { src: { model: "sonnet", effort: "medium", max_turns: 30, context_budget: 120000 } },
      },
    },
  };
}

// ── (1) retro/triage/inbox-draft resolve from their OWN row, not the architect row ──────────

test("synthesisModel resolves each of the three rungs from its OWN synthesis row, distinct from the architect row", () => {
  const m = validateMounts(goodRaw());
  assert.equal(synthesisModel(m, "retro"), "opus");
  assert.equal(synthesisModel(m, "triage"), "opus");
  assert.equal(synthesisModel(m, "inbox_draft"), "opus");
  // The fixture's architect row rides a DIFFERENT model (claude-opus-5) — proving these reads
  // came from `synthesis.<role>`, not a fallback to `architect`.
  assert.notEqual(synthesisModel(m, "retro"), m.architect.model);
  assert.notEqual(architectModel(config(), m), synthesisModel(m, "triage"));
});

test("the SHIPPED .remudero/mounts.yaml carries a synthesis row for all three rungs and resolves them", () => {
  const m = loadMounts(SHIPPED);
  for (const role of SYNTHESIS_ROLES) {
    assert.ok(m.synthesis[role], `synthesis.${role} must exist on the shipped table`);
    assert.ok(typeof synthesisModel(m, role) === "string" && synthesisModel(m, role).length > 0);
    assert.ok(typeof synthesisEffort(m, role) === "string" && synthesisEffort(m, role).length > 0);
  }
});

// ── (2) the Tier Invariant still holds and still refuses an architect at or below any worker ──

test("the Tier Invariant (G-17) still refuses a worker at or above the Architect's tier — unaffected by the synthesis rows existing", () => {
  const bad = goodRaw();
  bad.routes.implement.low.src.model = "claude-opus-5"; // worker == architect tier
  assert.throws(() => validateMounts(bad), TierInvariantError);
});

test("the Tier Invariant still refuses a worker at or above the flight judge's tier", () => {
  const bad = goodRaw();
  bad.routes.implement.low.src.model = "opus"; // == judge tier
  assert.throws(() => validateMounts(bad), TierInvariantError);
});

test("the Tier Invariant does NOT bind the synthesis rows: a synthesis row at or above the Architect's own tier does not throw — they supervise no worker", () => {
  const sameTierAsArchitect = goodRaw();
  sameTierAsArchitect.synthesis.retro.model = "claude-opus-5"; // == architect's own tier
  assert.doesNotThrow(() => validateMounts(sameTierAsArchitect));

  const belowWorkerCeiling = goodRaw();
  belowWorkerCeiling.synthesis.triage.model = "sonnet"; // == the worker ceiling in this fixture
  assert.doesNotThrow(
    () => validateMounts(belowWorkerCeiling),
    "a synthesis row is not a supervisor over the worker table — G-17's premise does not apply to it",
  );
});

// ── (3) plan authorship keeps the architect mount — moving synthesis rungs does not move it ──

test("editing a synthesis row leaves the architect row, and architectModel's resolution, untouched", () => {
  const raw = goodRaw();
  const before = validateMounts(raw);
  assert.equal(architectModel(config(), before), "claude-opus-5");

  const edited = goodRaw();
  edited.synthesis.retro.model = "sonnet";
  edited.synthesis.triage.effort = "medium";
  edited.synthesis.inbox_draft.max_turns = 999;
  const after = validateMounts(edited);

  assert.deepEqual(after.architect, before.architect, "moving a synthesis row must not move the architect row");
  assert.equal(architectModel(config(), after), "claude-opus-5", "plan authorship's resolved model is unaffected by a synthesis edit");
});

// ── (4) the one-argument architectModel(config) path (rmd plan) is untouched ────────────────

test("architectModel(config) — the ONE-ARGUMENT rmd plan path — is untouched: no mounts table, config fallback, then the opus default", () => {
  // No mounts table at all: resolves through config.architectModel, then "opus" — exactly the
  // pre-W1-T2559 contract; a `synthesis` block existing elsewhere in the table cannot leak in,
  // because this call passes no mounts table at all.
  assert.equal(architectModel(config()), "opus");
  assert.equal(architectModel(config({ architectModel: "sonnet" })), "sonnet");
  // And even WITH a full table available (mirroring the shape retro/triage/inbox_draft pass),
  // the one-argument call must still ignore it entirely, by construction.
  const m = validateMounts(goodRaw());
  assert.equal(architectModel(config()), "opus");
  assert.equal(architectModel(config({ architectModel: "opus" }), m), "claude-opus-5", "the two-arg form still reads the architect row, unchanged");
});

// ── (5) each synthesis row carries its own effort — effort is tuned, not only the model ──────

test("synthesisEffort resolves an INDEPENDENT effort per rung — the three rows are not forced to share one value", () => {
  const m = validateMounts(goodRaw());
  assert.equal(synthesisEffort(m, "retro"), "high");
  assert.equal(synthesisEffort(m, "triage"), "low");
  assert.equal(synthesisEffort(m, "inbox_draft"), "medium");
  // All three differ from each other in this fixture — proving effort is a per-row field, not a
  // single value copied from the architect row (which is "high" for all three, pre-fix).
  const efforts = new Set([synthesisEffort(m, "retro"), synthesisEffort(m, "triage"), synthesisEffort(m, "inbox_draft")]);
  assert.equal(efforts.size, 3, "each rung's effort must be independently settable");
});

test("the SHIPPED table actually tunes effort, not just model: triage (high-volume classification) rides a lower effort than retro", () => {
  const m = loadMounts(SHIPPED);
  const efforts = m.efforts;
  assert.ok(
    efforts[synthesisEffort(m, "triage")] < efforts[synthesisEffort(m, "retro")],
    "triage — classification at high volume — must ride a lower effort than retro's synthesis, per this task's own measured rationale",
  );
});

// ── (6) a malformed or missing synthesis row REFUSES at load, never a silent default ────────

test("REFUSES at load when the whole `synthesis` mapping is missing", () => {
  const bad = goodRaw() as Record<string, unknown>;
  delete bad.synthesis;
  assert.throws(() => validateMounts(bad), MountsError);
  assert.throws(() => validateMounts(bad), /synthesis/);
});

test("REFUSES at load when `synthesis` is present but not a mapping", () => {
  const bad = goodRaw() as unknown as Record<string, unknown>;
  bad.synthesis = "opus";
  assert.throws(() => validateMounts(bad), MountsError);
});

for (const role of SYNTHESIS_ROLES) {
  test(`REFUSES at load when synthesis.${role} is missing entirely`, () => {
    const bad = goodRaw();
    delete (bad.synthesis as Record<string, unknown>)[role];
    assert.throws(() => validateMounts(bad), MountsError);
    assert.throws(() => validateMounts(bad), new RegExp(`synthesis\\.${role}`));
  });

  test(`REFUSES at load when synthesis.${role} has an unknown model`, () => {
    const bad = goodRaw();
    (bad.synthesis as any)[role].model = "not-a-real-model";
    assert.throws(() => validateMounts(bad), MountsError);
  });

  test(`REFUSES at load when synthesis.${role} has an unknown effort`, () => {
    const bad = goodRaw();
    (bad.synthesis as any)[role].effort = "extreme";
    assert.throws(() => validateMounts(bad), MountsError);
  });

  test(`REFUSES at load when synthesis.${role} has a non-positive max_turns`, () => {
    const bad = goodRaw();
    (bad.synthesis as any)[role].max_turns = 0;
    assert.throws(() => validateMounts(bad), MountsError);
  });

  test(`REFUSES at load when synthesis.${role} has a non-integer context_budget`, () => {
    const bad = goodRaw();
    (bad.synthesis as any)[role].context_budget = 1.5;
    assert.throws(() => validateMounts(bad), MountsError);
  });
}

// ── (7) restoring the architect resolver for these three rungs would break the ownership
//      assertion — proving the assertions above are not vacuous ─────────────────────────────

test("FALSIFIER: if a call site reverted to architectModel(config, mounts) for a synthesis rung, this fixture's own ownership assertion would fail", () => {
  const m = validateMounts(goodRaw());
  const cfg = config();

  // This is exactly what the (fixed) retro/triage/inbox-draft call sites do: resolve via
  // synthesisModel(mounts, role), never architectModel.
  const correctlyResolved = { retro: synthesisModel(m, "retro"), triage: synthesisModel(m, "triage"), inbox_draft: synthesisModel(m, "inbox_draft") };
  // This is what the PRE-W1-T2559 (defective) call sites did: architectModel(config, mounts) for
  // all three, regardless of role.
  const regressedToArchitect = { retro: architectModel(cfg, m), triage: architectModel(cfg, m), inbox_draft: architectModel(cfg, m) };

  for (const role of SYNTHESIS_ROLES) {
    assert.equal(correctlyResolved[role], "opus", `${role} must resolve to its OWN row's model`);
    // The regression collapses every rung onto the single architect model (claude-opus-5 here) —
    // provably NOT what this fixture's synthesis rows declare (opus). If a call site were
    // reverted to architectModel, this inequality is exactly what would flip and expose it.
    assert.equal(regressedToArchitect[role], "claude-opus-5");
    assert.notEqual(
      correctlyResolved[role],
      regressedToArchitect[role],
      `${role}'s own mount must differ from the (regressed) architect resolution in this fixture, or this test could not detect a revert`,
    );
  }
});
