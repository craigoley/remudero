import assert from "node:assert/strict";
import test from "node:test";
import { parseTestSlotHolder } from "#src/lib/test-slot.js";

const base = { pid: 1, host: "h", startedAt: "2026-01-01T00:00:00Z", heartbeatAt: "2026-01-01T00:00:00Z" };

test("W1-T10412: hand_fix:src/lib/test-slot.ts is prevented, not retried", () => {
  const bad = parseTestSlotHolder(JSON.stringify({ ...base, cgroupScope: { path: "/x.scope", dedicated: "true" } }));
  assert.equal(bad?.cgroupScope, undefined);
  const nul = parseTestSlotHolder(JSON.stringify({ ...base, cgroupScope: null }));
  assert.equal(nul?.cgroupScope, undefined);
  const good = { path: "/x.scope", dedicated: true };
  assert.deepEqual(parseTestSlotHolder(JSON.stringify({ ...base, cgroupScope: good }))?.cgroupScope, good);
  assert.equal(parseTestSlotHolder(JSON.stringify(base))?.cgroupScope, undefined);
});
