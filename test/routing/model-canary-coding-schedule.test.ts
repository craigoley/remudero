import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCodingCanarySchedule, codingScheduledTrial } from "#src/lib/model-canary-coding-schedule.js";
import { executeNativeCodingSchedule } from "#src/lib/model-canary-coding-native.js";
import { codingCaseRequests } from "#src/lib/model-canary-coding.js";
import { CanarySlotOwner } from "#src/lib/model-canary-owner.js";
import type { CanarySlot } from "#src/lib/model-canary-schedule.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const item = codingCaseRequests()[0]!;
const pin = { model: "synthetic", route: "private-subscription", effort: "medium", suiteHash: item.suiteHash, billing: "subscription" as const };
const plan = () => buildCodingCanarySchedule("2026-10-13", "canonical-coding-fixture", item.id, [pin], true);
const image = "sha256:" + "a".repeat(64);

test("coding plans deterministically bind whole-case arms A/A positions and the existing trial block", () => {
  const p = plan(); assert.deepEqual(p, plan()); assert.equal(p.concurrency, 1); assert.equal(p.slots.length, 2);
  assert.deepEqual(new Set(p.slots.map(s => s.aaLabel)), new Set(["A", "B"]));
  for (const [i, slot] of p.slots.entries()) {
    const trial = codingScheduledTrial(slot)!;
    assert.equal(trial.position, i); assert.equal(trial.slotId, slot.id); assert.equal(trial.plannedSlotIds.length, 2);
    assert.equal(trial.scheduleDigest, p.digest); assert.equal(slot.pin.billing, "subscription");
  }
  assert.equal(codingScheduledTrial({ ...p.slots[0]!, coding: undefined }), undefined);
});

test("coding plan authority rejects cash duplicate pins widened populations bad dates and forged membership", () => {
  for (const f of [() => buildCodingCanarySchedule("2026-02-30", "seed", item.id, [pin]),
    () => buildCodingCanarySchedule("2026-10-13", "", item.id, [pin]),
    () => buildCodingCanarySchedule("2026-10-13", "seed", item.id, []),
    () => buildCodingCanarySchedule("2026-10-13", "seed", item.id, Array(129).fill(pin)),
    () => buildCodingCanarySchedule("2026-10-13", "seed", item.id, [pin, pin]),
    () => buildCodingCanarySchedule("2026-10-13", "seed", item.id, [{ ...pin, billing: "api" }]),
    () => buildCodingCanarySchedule("2026-10-13", "seed", item.id, [{ ...pin, suiteHash: "0".repeat(64) }])])
    assert.throws(f, /canary-coding-schedule-/);
  for (const change of [(s: CanarySlot) => { s.coding!.trial.plannedSlotIds.reverse(); },
    (s: CanarySlot) => { s.pin.model = "other"; }, (s: CanarySlot) => { s.coding!.seed = "other"; },
    (s: CanarySlot) => { s.id = "0".repeat(64); }]) {
    const slot = structuredClone(plan().slots[0]!); change(slot);
    assert.throws(() => codingScheduledTrial(slot), /canary-coding-slot-invalid/);
  }
});

test("coding schedule reuses the real durable owner and never skips a started slot after process replacement", async t => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}coding-plan-`)); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = plan(), one = new CanarySlotOwner(dir); one.claim(p.slots[0]!); one.close();
  const two = new CanarySlotOwner(dir); t.after(() => two.close());
  let factory = 0;
  const result = await executeNativeCodingSchedule(two, p, image, () => { factory++; throw new Error("must-not-start"); });
  assert.equal(result.state, "held"); assert.equal(result.nextSlot, p.slots[0]!.id); assert.equal(factory, 0);
  assert.equal(two.phase(p.slots[0]!), "started");
  const forged = structuredClone(p); forged.slots.reverse();
  await assert.rejects(executeNativeCodingSchedule(two, forged, image, () => { throw new Error("must-not-start"); }), /schedule-changed/);
});
