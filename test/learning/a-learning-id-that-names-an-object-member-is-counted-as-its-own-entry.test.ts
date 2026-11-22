/**
 * test/learning/a-learning-id-that-names-an-object-member-is-counted-as-its-own-entry.test.ts — W1-T14251.
 *
 * A learning id is corpus text, and a worker's LEARNINGS_USED line is model output, so an id can
 * spell an object member. `foldLearningUsage` folded into a plain object with `into[id] ??= …`: for
 * `__proto__` that wrote the counters onto Object.prototype, so every fresh `{}` then read
 * `offered: NaN`, and for `constructor` it wrote them onto the Object function. `learningValue` read
 * `usage?.[id]` and so gave `constructor` a NaN posterior on an empty store.
 *
 * INVARIANT no-prototype-write: folding or reading learning usage never writes or reads a member of
 * Object.prototype or of Object.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { summarizeLearningUsefulness } from "#src/lib/digest.js";
import { foldLearningUsage, learningUsagePath, learningValue, leastUsefulLearnings, readLearningUsage, recordLearningUsage, type LearningUsage } from "#src/lib/knowledge-value.js";
import type { LedgerLine } from "#src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const MEMBER_IDS = ["__proto__", "constructor", "toString"] as const;

/** Whether Object.prototype or Object gained anything a fold could write. */
function untouched(): void {
  for (const target of [Object.prototype, Object] as const) {
    for (const key of ["offered", "used"]) {
      assert.equal(Object.hasOwn(target, key), false, `${target === Object ? "Object" : "Object.prototype"} must not gain ${key}`);
    }
  }
  assert.equal(({} as Record<string, unknown>).offered, undefined, "a fresh {} must not read an inherited counter");
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
}

/** One `learnings.used` row that offers `injected` and uses `used`. */
const row = (injected: readonly string[], used: readonly string[]) => ({ step: "learnings.used", injected_ids: [...injected], used_ids: [...used] });

test("W1-T14251 criterion 1: folding rows that offer and use __proto__, constructor and toString leaves Object.prototype and Object unchanged, and counts each id as its own entry", () => {
  const usage = foldLearningUsage([
    row([...MEMBER_IDS, "real"], ["__proto__", "constructor"]),
    row([...MEMBER_IDS], ["toString", "__proto__"]),
  ]);
  untouched();
  for (const id of [...MEMBER_IDS, "real"]) assert.ok(Object.hasOwn(usage, id), `${id} is its own entry`);
  assert.deepEqual(Object.keys(usage).sort(), ["__proto__", "constructor", "real", "toString"]);
  assert.deepEqual(usage["__proto__"], { offered: 2, used: 2 });
  assert.deepEqual(usage.constructor, { offered: 2, used: 1 });
  assert.deepEqual(usage.toString, { offered: 2, used: 1 });
  assert.deepEqual(usage.real, { offered: 1, used: 0 });
  assert.equal(Object.getPrototypeOf(usage), Object.prototype, "the store stays a plain object, so its JSON is unchanged");
  // The same fold into a store that already holds one of them adds to its own entry.
  const again = foldLearningUsage([row(["constructor"], ["constructor"])], usage);
  untouched();
  assert.deepEqual(again.constructor, { offered: 3, used: 2 });
});

test("W1-T14251 criterion 2: with an empty store, learningValue reads __proto__, constructor and toString as the no-history prior, alpha 1 and beta 1", () => {
  const prior = { alpha: 1, beta: 1, mean: 0.5 };
  for (const id of MEMBER_IDS) {
    assert.deepEqual(learningValue(id, {}), prior, `${id} on {}`);
    assert.deepEqual(learningValue(id, undefined), prior, `${id} with no store`);
  }
  // POSITIVE CONTROL: an own entry under the same name is read.
  const usage = foldLearningUsage([row(["constructor"], [])]);
  assert.deepEqual(learningValue("constructor", usage), { alpha: 1, beta: 2, mean: 1 / 3 });
  assert.deepEqual(learningValue("toString", usage), prior, "an id with no own entry is still the prior");
  untouched();
});

test("W1-T14251 criterion 3: recordLearningUsage through a real store file keeps those ids as keys with their counts, and a second record adds to them", () => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t14251-`));
  try {
    const path = learningUsagePath(stateDir);
    recordLearningUsage(path, { injected_ids: [...MEMBER_IDS], used_ids: ["__proto__"] });
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.ok(Object.hasOwn(written, "__proto__"), "the file names __proto__ as a key");
    const first = readLearningUsage(path);
    assert.deepEqual(Object.keys(first).sort(), ["__proto__", "constructor", "toString"]);
    assert.deepEqual(first["__proto__"], { offered: 1, used: 1 });
    recordLearningUsage(path, { injected_ids: [...MEMBER_IDS], used_ids: ["toString"] });
    const second = readLearningUsage(path);
    assert.deepEqual(second["__proto__"], { offered: 2, used: 1 });
    assert.deepEqual(second.constructor, { offered: 2, used: 0 });
    assert.deepEqual(second.toString, { offered: 2, used: 1 });
    assert.deepEqual(learningValue("__proto__", second), { alpha: 2, beta: 2, mean: 0.5 });
    untouched();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("W1-T14251 criterion 4: summarizeLearningUsefulness over ledger lines naming those ids lists them with their counts and no NaN mean", () => {
  const lines = [
    { ts: "2026-11-22T00:00:00.000Z", ...row([...MEMBER_IDS, "real"], ["constructor"]) },
    { ts: "2026-11-22T00:01:00.000Z", ...row([...MEMBER_IDS, "real"], ["constructor", "real"]) },
    { ts: "2026-11-22T00:02:00.000Z", step: "learnings.used", silent: true },
  ] as unknown as LedgerLine[];
  const summary = summarizeLearningUsefulness(lines)!;
  untouched();
  assert.equal(summary.reports, 2);
  assert.equal(summary.silent, 1);
  assert.equal(summary.offered, 8);
  assert.equal(summary.used, 3);
  const byId = new Map(summary.leastUseful.map((l) => [l.id, l]));
  assert.deepEqual([...byId.keys()].sort(), ["__proto__", "constructor", "real", "toString"]);
  for (const l of summary.leastUseful) assert.ok(Number.isFinite(l.mean), `${l.id} has a finite mean, not ${l.mean}`);
  assert.deepEqual({ offered: byId.get("__proto__")!.offered, used: byId.get("__proto__")!.used }, { offered: 2, used: 0 });
  assert.deepEqual({ offered: byId.get("constructor")!.offered, used: byId.get("constructor")!.used }, { offered: 2, used: 2 });
  // leastUsefulLearnings reads the same own entries the fold wrote.
  const usage: LearningUsage = foldLearningUsage(lines as unknown as Array<Record<string, unknown>>);
  assert.deepEqual(leastUsefulLearnings(usage, 10), summary.leastUseful);
});
