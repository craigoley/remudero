/**
 * W1-T3705, THE SECOND GATE — the one #5819 deliberately did not close.
 *
 * There were TWO gates between an exhausted subscription and the work continuing, and escaping
 * either armed the other:
 *
 *   enabled includes codex  -> the AUCTION refuses on an exhausted subscription (closed by the
 *                              overflow fallback arm), and `providerRoutingOwnsHeadroom` stood the
 *                              daemon governor down.
 *   enabled = ["claude"]    -> the auction is skipped entirely... and the governor ARMS, pausing
 *                              dispatch over the ceiling.
 *
 * So the only configuration that reached the valve was `enabled: ["claude"]` AND
 * `headroom.enabled: false`, which nothing stated and no test pinned. These fixtures pin the fix:
 * a DIVERT PATH counts as routing owning the headroom decision, so the governor stands down when
 * the work will be billed somewhere else — and stays armed when it will not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { providerRoutingOwnsHeadroom, resolveHeadroomEnabled, overflowFallbackRefusal } from "../src/lib/config.js";

const KEY = "test-only-overflow-factor-present";

function cfg(over: Record<string, unknown> = {}): never {
  return { claudeBin: "/bin/true", root: "/tmp", dailyCapUsd: 20, ...over } as never;
}
/** The daemon's own composition, mirrored from run-task.ts's two call sites. */
const governorArmed = (config: never, env: NodeJS.ProcessEnv) =>
  resolveHeadroomEnabled(config, {}) && !providerRoutingOwnsHeadroom(config, env);

test("escaping the auction no longer arms the headroom governor", () => {
  // THE TRAP, AS IT WAS. A claude-only host skips the auction — and before this change the governor
  // armed, so an exhausted subscription paused dispatch with the valve armed and unreachable.
  const claudeOnlyArmedValve = cfg({ overflow: "api_key", workerProviders: { enabled: ["claude"] } });
  assert.equal(overflowFallbackRefusal(claudeOnlyArmedValve, { ANTHROPIC_API_KEY: KEY }), undefined, "the valve really is armed in this fixture");
  assert.equal(governorArmed(claudeOnlyArmedValve, { ANTHROPIC_API_KEY: KEY }), false, "an armed valve stands the governor down");

  // The cash arm does the same, on its own switch.
  const cashDivert = cfg({ workerProviders: { enabled: ["claude", "cash"], cashFallbackWhenBlocked: true } });
  assert.equal(governorArmed(cashDivert, {}), false, "an armed cash fallback stands the governor down");

  // And the original reason still holds: a second subscription window to allocate against.
  assert.equal(governorArmed(cfg({ workerProviders: { enabled: ["claude", "codex"] } }), {}), false);
});

test("the governor stays armed when nothing would actually divert", () => {
  // NO DIVERT PATH AT ALL: the governor is the only thing protecting the reserve, so it must arm.
  assert.equal(governorArmed(cfg({ workerProviders: { enabled: ["claude"] } }), {}), true);

  // BOTH FACTORS, OR NEITHER. An `overflow` switch whose key is absent diverts nothing — standing
  // the governor down for it would burn the subscription reserve it exists to hold back.
  const switchOnly = cfg({ overflow: "api_key", workerProviders: { enabled: ["claude"] } });
  assert.equal(governorArmed(switchOnly, {}), true, "an armed switch with no key must not stand the governor down");

  // A key with no switch is the same non-divert, from the other side.
  const keyOnly = cfg({ overflow: "none", workerProviders: { enabled: ["claude"] } });
  assert.equal(governorArmed(keyOnly, { ANTHROPIC_API_KEY: KEY }), true);

  // AND A CAP IS STILL REQUIRED: an uncapped valve would not be allowed to spend, so it is not a
  // divert path and must not stand the governor down either.
  const noCap = cfg({ overflow: "api_key", dailyCapUsd: null, workerProviders: { enabled: ["claude"] } });
  assert.equal(governorArmed(noCap, { ANTHROPIC_API_KEY: KEY }), true);

  // The cash switch without the cash PROVIDER enabled diverts nothing either.
  const switchNoProvider = cfg({ workerProviders: { enabled: ["claude"], cashFallbackWhenBlocked: true } });
  assert.equal(governorArmed(switchNoProvider, {}), true);
});

test("an operator who disables the governor still disables it", () => {
  // The stand-down widens when routing owns the decision; it must not become the ONLY way to turn
  // the governor off, or an operator's explicit `headroom.enabled: false` would stop meaning
  // anything. `resolveHeadroomEnabled` keeps that arm, untouched.
  const off = cfg({ headroom: { enabled: false }, workerProviders: { enabled: ["claude"] } });
  assert.equal(resolveHeadroomEnabled(off, {}), false);
  assert.equal(governorArmed(off, {}), false);

  // And the env override still wins over config, in both directions.
  assert.equal(resolveHeadroomEnabled(cfg({ headroom: { enabled: false } }), { RMD_HEADROOM_ENABLED: "1" }), true);
  assert.equal(resolveHeadroomEnabled(cfg({ headroom: { enabled: true } }), { RMD_HEADROOM_ENABLED: "0" }), false);
});
