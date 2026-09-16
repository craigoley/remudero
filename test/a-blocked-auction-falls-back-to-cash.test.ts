import assert from "node:assert/strict";
import { test } from "node:test";
import { cashCanServeToolSurface, cashFallbackRefusal } from "../src/lib/worker.js";
import { OPENWEIGHT_FUNCTIONS } from "../src/lib/worker-provider.js";
import type { Config } from "../src/lib/config-schema.js";

// W1-T3692. When no subscription has readable headroom the auction throws
// ProviderCapacityBlockedError and the queue STALLS. Cash should carry the work at exactly that
// moment -- but ONLY for a spawn whose tool surface it can actually run, because openWeightTools
// throws on a tool it does not implement.

const base = {
  claudeBin: "/unused/claude",
  root: "/tmp",
  dailyCapUsd: 20,
  workerProviders: { enabled: ["claude", "cash"], cashFallbackWhenBlocked: true },
} as unknown as Config;

const cfg = (over: Record<string, unknown>) =>
  ({ ...base, workerProviders: { ...(base.workerProviders as object), ...over } }) as unknown as Config;

test("W1-T3692: a lane whose tools cash implements is eligible for the fallback", () => {
  assert.equal(cashFallbackRefusal(base, ["Read", "Grep", "Glob", "RunCheck"]), undefined);
  assert.equal(cashCanServeToolSurface(["Read", "Grep", "Glob", "RunCheck"]), true);
});

test("W1-T3692: a lane needing Bash is REFUSED, so a build lane is never handed to a provider that cannot run it", () => {
  // This is the fix/build surface: FIX_WORKER_TOOLS. Bash has no cash equivalent by design --
  // the check-runner cannot commit or push.
  assert.equal(OPENWEIGHT_FUNCTIONS["Bash"], undefined, "Bash must remain unimplementable by cash");
  assert.equal(cashCanServeToolSurface(["Read", "Write", "Edit", "Grep", "Glob", "Bash"]), false);
  const refusal = cashFallbackRefusal(base, ["Read", "Write", "Edit", "Grep", "Glob", "Bash"]);
  assert.match(String(refusal), /not implementable by cash/);
});

test("W1-T3692: an UNBOUNDED spawn is never eligible — absent bound refuses, it does not assume", () => {
  assert.equal(cashCanServeToolSurface(undefined), false);
  assert.equal(cashCanServeToolSurface([]), false);
  assert.match(String(cashFallbackRefusal(base, undefined)), /unbounded/);
});

test("W1-T3692: the fallback is OFF unless the operator opted in, so it cannot arrive by upgrade", () => {
  const off = cfg({ cashFallbackWhenBlocked: undefined });
  assert.match(String(cashFallbackRefusal(off, ["Read", "Grep"])), /has not enabled/);
  const explicitlyFalse = cfg({ cashFallbackWhenBlocked: false });
  assert.match(String(cashFallbackRefusal(explicitlyFalse, ["Read", "Grep"])), /has not enabled/);
});

test("W1-T3692: cash must be an enabled provider, and the spend must be capped", () => {
  const notEnabled = cfg({ enabled: ["claude"] });
  assert.match(String(cashFallbackRefusal(notEnabled, ["Read", "Grep"])), /not an enabled worker provider/);

  const uncapped = { ...base, dailyCapUsd: undefined } as unknown as Config;
  assert.match(String(cashFallbackRefusal(uncapped, ["Read", "Grep"])), /dailyCapUsd is unset/);
});

test("W1-T3692: every declared dispatch-lane openweight bound is genuinely servable by cash", async () => {
  // The bounds table and the adapter's function list must not drift apart: a lane declaring an
  // openweight row that cash cannot run would pass the auction fallback and then throw.
  const { DISPATCH_LANE_TOOL_BOUNDS } = await import("../src/lib/worker.js");
  const table = DISPATCH_LANE_TOOL_BOUNDS as unknown as Record<string, { openweight?: readonly string[] }>;
  let checked = 0;
  for (const [lane, byProvider] of Object.entries(table)) {
    if (!byProvider.openweight) continue;
    checked++;
    assert.ok(
      cashCanServeToolSurface(byProvider.openweight),
      `lane '${lane}' declares an openweight bound cash cannot run: ${byProvider.openweight.join(", ")}`,
    );
  }
  assert.ok(checked > 0, "at least one lane must declare an openweight bound, or the fallback has no eligible lane");
});
