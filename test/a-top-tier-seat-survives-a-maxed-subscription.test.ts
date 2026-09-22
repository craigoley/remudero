/**
 * W1-T3711 — THE SQUEEZE SEAT IS REFUSED, AND THIS RECORDS WHY.
 *
 * W1-T3705's shard shipped `squeeze_model` on the `architect:` and `judge:` rows, and this suite
 * originally asserted that it parsed and resolved. It did both — and NOTHING SELECTED FROM IT.
 * Measured on origin/main afterwards:
 *
 *     grep -rn "judgeModel("     src | grep -v src/lib/config.ts   ->  0 callers
 *     grep -rn "architectModel(" src | grep -v config.ts,retro.ts  ->  1 caller, ONE ARGUMENT
 *     grep -rn "squeezeModel"    src | grep -v src/lib/mounts.ts   ->  only config.ts itself
 *
 * So an operator could set the seat meant to survive a maxed subscription and get a green load, a
 * satisfied Tier Invariant, and the subscription model anyway. Unit tests of an unreachable function
 * pass and prove nothing about what ships — which is what these tests were.
 *
 * AND WIRING IT WOULD HAVE ADDED A SECOND ANSWER TO A SOLVED QUESTION. When a spawn diverts to cash,
 * `selectOpenWeightModel` already maps the requested Claude model onto a cash capability through
 * `openWeightCapabilityForRequestedModel` and the `capabilities.claude` ladder. `squeeze_model` is a
 * competing per-row answer to exactly that, and two copies of one rule is the defect this repo keeps
 * paying for.
 *
 * So the field now REFUSES at load. These tests pin the refusal and the mechanisms that genuinely do
 * carry work through an exhausted subscription, so the next reader does not re-derive the seat.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { architectModel } from "../src/lib/config.js";
import { MountsError, validateMounts } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config-schema.js";

const CFG = {} as unknown as Config;
const table = (mut: (m: any) => void = () => {}) => {
  const m = parse(readFileSync(".remudero/mounts.yaml", "utf8")) as any;
  m.tiers = { ...m.tiers, "gpt-5.6-terra": 3, "gpt-5.6-luna": 2 };
  m.capabilities.claude = { ...m.capabilities.claude, "gpt-5.6-terra": "frontier", "gpt-5.6-luna": "balanced" };
  mut(m);
  return m;
};

test("a squeeze_model nothing selects from is REFUSED at load, not silently ignored", () => {
  // BOTH ROWS, because both resolvers are unreachable and either would read as configured.
  for (const row of ["architect", "judge"]) {
    assert.throws(
      () => validateMounts(table((m) => { m[row].squeeze_model = "gpt-5.6-terra"; }), {}),
      (e: unknown) => {
        assert.ok(e instanceof MountsError, `${row}: must fail as a MountsError`);
        assert.match(String((e as Error).message), /NOTHING READS IT/, `${row}: the refusal must say why`);
        return true;
      },
      `${row}: a dead squeeze seat must refuse`,
    );
  }
});

test("the refusal names the paths that DO survive a maxed subscription", () => {
  // A refusal that only says no sends the reader looking for a seat that does not exist. This one
  // has to point at the two mechanisms that actually carry work when the subscription is gone.
  const err = (() => {
    try { validateMounts(table((m) => { m.architect.squeeze_model = "gpt-5.6-terra"; }), {}); return ""; }
    catch (e) { return String((e as Error).message); }
  })();
  assert.match(err, /api_key/, "the overflow valve (W1-T3705) is one of the two");
  assert.match(err, /cashFallbackWhenBlocked/, "the blocked-auction cash fallback (W1-T3692) is the other");
});

test("a table declaring NO squeeze seat loads and behaves exactly as before", () => {
  // THE REGRESSION GUARD. The refusal must bite ONLY on the dead field — every live mount row, and
  // the real committed table, must be untouched by it.
  const mounts = validateMounts(table(), {});
  assert.equal(architectModel(CFG, mounts), "claude-opus-5-5");
  assert.equal(architectModel({} as unknown as Config), "opus", "the config default still answers with no table");
});

test("the deleted seat resolvers are GONE, not merely unused", async () => {
  // An unreachable resolver left in place is a promise the config cannot keep — the next reader
  // finds `judgeModel` and reasonably assumes something selects through it. Asserted on the module's
  // own exports so the deletion cannot quietly regress into a re-export.
  const config = await import("../src/lib/config.js");
  assert.equal("judgeModel" in config, false, "judgeModel had no seat to resolve and must not exist");
  assert.equal(architectModel.length, 2, "architectModel takes (config, mounts) — no squeezed option");
});

test("the committed mounts table sets no squeeze seat, so refusing it breaks no host", () => {
  // Checked against the REAL file rather than a fixture: this is what makes the refusal safe to ship
  // rather than a change that takes the fleet down on next load.
  const raw = readFileSync(".remudero/mounts.yaml", "utf8");
  assert.doesNotMatch(raw, /^\s*squeeze_model:/m, "no live row may set the refused field");
  assert.doesNotThrow(() => validateMounts(parse(raw) as never, {}), "the committed table must still load");
});
