import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { validateMounts } from "../src/lib/mounts.js";

// this change. An Architect that exists only while the Claude subscription has headroom is a single
// point of failure, not a fleet. Ranking the two Azure deployments the fleet already trusts makes
// a top-tier seat HOLDABLE under squeeze -- and the Tier Invariant must keep meaning exactly what
// it meant, which is what these tests pin.

const live = () => parse(readFileSync(".remudero/mounts.yaml", "utf8")) as Record<string, any>;

test("the live table still validates — ranking a model does not move any seat", () => {
  assert.doesNotThrow(() => validateMounts(live(), {}));
});

test("terra may hold the Architect seat, and the Judge seat, under squeeze", () => {
  for (const seat of ["architect", "judge"]) {
    const m = live();
    m[seat] = { ...m[seat], model: "gpt-5.6-terra" };
    assert.doesNotThrow(
      () => validateMounts(m, {}),
      `${seat} must be holdable by terra — otherwise a maxed Claude subscription has no ${seat} at all`,
    );
  }
});

test("luna may NOT hold the Architect seat — the invariant still bites", () => {
  // luna ranks with sonnet (2). A worker riding sonnet is therefore NOT strictly below it, so the
  // seat is refused. This is the property that makes the new ranks safe rather than decorative:
  // adding models did not lower the bar, it only made a model that clears the bar expressible.
  const m = live();
  m.architect = { ...m.architect, model: "gpt-5.6-luna" };
  assert.throws(() => validateMounts(m, {}), /Tier Invariant \(G-17\) violated/);
});

test("sol is deliberately unranked, so it cannot be selected by accident", () => {
  const m = live();
  assert.equal(m.tiers["gpt-5.6-sol"], undefined, "sol is 2.5x terra for the same band — unranked on purpose");
  m.architect = { ...m.architect, model: "gpt-5.6-sol" };
  assert.throws(() => validateMounts(m, {}), /must be one of/);
});

test("every ranked model resolves a capability, which the loader requires", () => {
  const m = live();
  for (const model of Object.keys(m.tiers)) {
    assert.ok(
      m.capabilities.claude[model] !== undefined,
      `${model} is ranked in tiers but has no capability — the loader refuses this, and the invariant could not compare it`,
    );
  }
});
