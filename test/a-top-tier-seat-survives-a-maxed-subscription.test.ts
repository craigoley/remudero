import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { architectModel, judgeModel } from "../src/lib/config.js";
import { validateMounts } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config-schema.js";

// this change. A seat that exists only while its subscription has headroom is a single point of
// failure. `squeeze_model` fills it when — and ONLY when — the ordinary provider has none.
//
// The ranks this exercises land in a sibling change; the fixtures add them locally so these tests
// do not depend on merge order.
const CFG = {} as unknown as Config;
const table = (mut: (m: any) => void = () => {}) => {
  const m = parse(readFileSync(".remudero/mounts.yaml", "utf8")) as any;
  m.tiers = { ...m.tiers, "gpt-5.6-terra": 3, "gpt-5.6-luna": 2 };
  m.capabilities.claude = { ...m.capabilities.claude, "gpt-5.6-terra": "frontier", "gpt-5.6-luna": "balanced" };
  mut(m);
  return m;
};

test("SUBSCRIPTION FIRST — a declared fallback is not used while the primary can run", () => {
  const mounts = validateMounts(table((m) => { m.architect.squeeze_model = "gpt-5.6-terra"; }), {});
  assert.equal(architectModel(CFG, mounts), "claude-opus-5", "absent flag means the primary");
  assert.equal(architectModel(CFG, mounts, { squeezed: false }), "claude-opus-5");
});

test("under squeeze the seat is FILLED rather than left empty", () => {
  const mounts = validateMounts(table((m) => { m.architect.squeeze_model = "gpt-5.6-terra"; }), {});
  assert.equal(architectModel(CFG, mounts, { squeezed: true }), "gpt-5.6-terra");
});

test("a table declaring NO fallback behaves exactly as before, squeezed or not", () => {
  const mounts = validateMounts(table(), {});
  assert.equal(architectModel(CFG, mounts), "claude-opus-5");
  assert.equal(architectModel(CFG, mounts, { squeezed: true }), "claude-opus-5", "no fallback means no change in behaviour");
});

test("the Judge seat follows the same subscription-first rule", () => {
  const mounts = validateMounts(table((m) => { m.judge.squeeze_model = "gpt-5.6-terra"; }), {});
  assert.equal(judgeModel(mounts), "opus");
  assert.equal(judgeModel(mounts, { squeezed: true }), "gpt-5.6-terra");
});

test("a fallback that does NOT dominate the workers cannot load at all", () => {
  // luna ranks with sonnet (2), and workers ride sonnet — so a squeeze would put the Architect
  // level with the work it supervises. The table must refuse to LOAD, not discover this mid-squeeze.
  assert.throws(
    () => validateMounts(table((m) => { m.architect.squeeze_model = "gpt-5.6-luna"; }), {}),
    /Tier Invariant \(G-17\) violated/,
    "a squeeze may change which model holds a seat, never whether the seat outranks its floor",
  );
});

test("an UNRANKED fallback is refused, so it can never be selected", () => {
  assert.throws(
    () => validateMounts(table((m) => { m.architect.squeeze_model = "gpt-5.6-sol"; }), {}),
    /'squeeze_model' must be one of/,
  );
});
