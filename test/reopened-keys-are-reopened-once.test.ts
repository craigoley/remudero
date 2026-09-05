import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evictRefusalPoisonedKeys,
  markReopened,
  parseReopenedKeysCache,
  writeReopenedKeys,
  type DraftAttemptCache,
  type DraftCache,
} from "../src/lib/inbox.js";

// ── W1-T2566: THE MIGRATION IS BOUNDED WITHIN A BOOT AND UNBOUNDED ACROSS BOOTS ──────────────
//
// `evictRefusalPoisonedKeys`'s predicate is "keyed, live in the registry, no cached draft" —
// deliberately NOT refusal-specific, because the evidence a refusal leaves is in the ledger, not
// in either cache. W1-T2564 priced that at "ONE extra attempt per boot", quoted against an
// unstated assumption that boots are rare.
//
// MEASURED 2026-09-01, they are not: median daemon process lifetime 50.5 minutes across 479
// processes, 32% under 30 minutes. So a proposal that fails GENUINELY and repeatedly never
// acquires a cached draft, satisfies the predicate on EVERY boot, and is re-opened roughly 29
// times a day at an $8.52 draft mean. The loop is bounded within a process by the closure flag and
// UNBOUNDED ACROSS processes, because a restart is precisely what resets that flag.
//
// ⚠ THE MIGRATION ITSELF IS CORRECT and this is not a defect report against it. It fired once,
// evicted 285, and left exactly the intended state. What is added is a bound that survives a
// restart — and the closure flag STAYS, because running the eviction per poll re-opens the key
// W1-T192 just wrote for a genuine failure in that same poll.

const attemptsWith = (...ids: string[]): DraftAttemptCache => Object.fromEntries(ids.map((id) => [id, "anchor::0"]));
const NO_DRAFTS: DraftCache = {};

/** One daemon boot: the eviction as the caller runs it, against a persisted marker. */
function boot(attempts: DraftAttemptCache, reopened: Record<string, string>) {
  const live = new Set(Object.keys(attempts));
  const evicted = evictRefusalPoisonedKeys(attempts, NO_DRAFTS, live, new Set(Object.keys(reopened)));
  return { evicted, nextReopened: markReopened(reopened, evicted, "2026-09-04T00:00:00.000Z") };
}

// ── criterion 1 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2566: a proposal already re-opened once is not re-opened again after a daemon restart", () => {
  // BOOT 1 — a genuinely-failing proposal: keyed, live, no cached draft. Re-opened, as designed.
  const first = boot(attemptsWith("P-stuck"), {});
  assert.deepEqual(first.evicted, ["P-stuck"], "the first boot re-opens it");
  assert.ok(first.nextReopened["P-stuck"], "and records that it did");

  // BOOT 2 — the SAME proposal, still failing, so still keyed with no draft. Before this task the
  // closure flag had been reset by the restart and it was re-opened again, forever.
  const second = boot(attemptsWith("P-stuck"), first.nextReopened);
  assert.deepEqual(second.evicted, [], "the second boot must NOT re-open it — ~29 times a day at $8.52 each is what this stops");

  // And it stays refused across every later boot, not just the next one.
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(boot(attemptsWith("P-stuck"), second.nextReopened).evicted, [], `boot ${i + 3}`);
  }
});

test("W1-T2566: the attempt key SURVIVES on a proposal that is not re-opened", () => {
  // The eviction deletes the key; skipping the eviction must leave it in place, or the proposal
  // becomes due again by another route and the bound buys nothing.
  const attempts = attemptsWith("P-stuck");
  evictRefusalPoisonedKeys(attempts, NO_DRAFTS, new Set(["P-stuck"]), new Set(["P-stuck"]));
  assert.deepEqual(Object.keys(attempts), ["P-stuck"], "the key must still be there");
  // CONTROL: with no marker the same call really does delete it, so the assertion above is not
  // passing because the eviction is inert.
  const control = attemptsWith("P-stuck");
  evictRefusalPoisonedKeys(control, NO_DRAFTS, new Set(["P-stuck"]), new Set());
  assert.deepEqual(Object.keys(control), [], "control: unmarked, the eviction frees it");
});

// ── criterion 2 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2566: a proposal never seen before is still re-opened on first sight, so a fresh host recovers", () => {
  // THIS IS THE DISTINCTION THAT IS THE DELIVERABLE. W1-T2564 chose a closure flag because every
  // boot runs it, so a freshly-provisioned host recovers with no operator step. A per-id marker
  // preserves that; a single global "migration done" flag would NOT, and would reintroduce exactly
  // the gap the closure flag was chosen to avoid.
  const seasoned = { "P-old": "2026-09-01T00:00:00.000Z" };
  const { evicted } = boot(attemptsWith("P-old", "P-new"), seasoned);
  assert.deepEqual(evicted, ["P-new"], "the never-seen id is re-opened even on a host that has run the migration before");
});

test("W1-T2566: a host with a marker file it cannot read still recovers, rather than failing the boot", () => {
  // Losing the marker costs ONE extra attempt per id; failing the boot costs the fleet. So a
  // malformed file must parse as "nothing re-opened yet".
  for (const bad of ["", "not json at all", "[]", "null", '{"P":123}']) {
    const parsed = parseReopenedKeysCache(bad);
    assert.deepEqual(parsed, {}, `"${bad}" must degrade to empty, not throw`);
  }
  // CONTROL: a well-formed file really does round-trip, so the assertions above are not vacuous.
  assert.deepEqual(parseReopenedKeysCache('{"P-old":"2026-09-01T00:00:00.000Z"}'), { "P-old": "2026-09-01T00:00:00.000Z" });
});

// ── criterion 3 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2566: the marker survives a process restart, which the closure flag it replaces could not", () => {
  const dir = mkdtempSync(join(tmpdir(), "reopened-"));
  const path = join(dir, "inbox-reopened-keys.json");

  // "Process 1" re-opens a stuck proposal and commits the marker.
  const first = boot(attemptsWith("P-stuck"), {});
  writeReopenedKeys(path, first.nextReopened);
  assert.deepEqual(first.evicted, ["P-stuck"]);

  // "Process 2" — a genuine restart: nothing in memory carries over, the marker is read off disk.
  const fromDisk = parseReopenedKeysCache(readFileSync(path, "utf8"));
  assert.ok(fromDisk["P-stuck"], "the marker is on disk, not in a closure");
  assert.deepEqual(boot(attemptsWith("P-stuck"), fromDisk).evicted, [], "and the restart does not re-open it");
});

test("W1-T2566: the marker is committed by rename, so a torn write cannot read as fully-migrated", () => {
  const dir = mkdtempSync(join(tmpdir(), "reopened-atomic-"));
  const path = join(dir, "inbox-reopened-keys.json");
  writeReopenedKeys(path, { "P-a": "2026-09-04T00:00:00.000Z" });
  assert.deepEqual(parseReopenedKeysCache(readFileSync(path, "utf8")), { "P-a": "2026-09-04T00:00:00.000Z" });
  // A half-written file is the failure this guards: it would parse as a marker set and silently
  // retire proposals the caches still consider due. Staging then renaming makes it unreachable.
  writeFileSync(`${path}.tmp-stale`, "{ half");
  assert.deepEqual(parseReopenedKeysCache(readFileSync(path, "utf8")), { "P-a": "2026-09-04T00:00:00.000Z" }, "the committed file is untouched by a stray temp");
});

test("W1-T2566: markReopened never moves an existing stamp, and mutates nothing", () => {
  const current = Object.freeze({ "P-old": "2026-09-01T00:00:00.000Z" });
  const next = markReopened(current, ["P-old", "P-new"], "2026-09-04T00:00:00.000Z");
  assert.equal(next["P-old"], "2026-09-01T00:00:00.000Z", "a re-read must not rewrite when it first happened");
  assert.equal(next["P-new"], "2026-09-04T00:00:00.000Z");
  assert.deepEqual(current, { "P-old": "2026-09-01T00:00:00.000Z" }, "and the input is untouched");
});

// ── the shapes this must not disturb ─────────────────────────────────────────────────────────

test("W1-T2566: the eviction predicate itself is unchanged — explicitly out of scope", () => {
  // "keyed, live, no cached draft" still decides what is poisoned. The marker is an EXCLUSION
  // layered on top, and every existing caller (which passes no marker) is byte-identical.
  const attempts = attemptsWith("P-keyed", "P-dead");
  const drafts: DraftCache = { "P-drafted": { fragmentYaml: "x" } as never };
  attempts["P-drafted"] = "anchor::0";
  const freed = evictRefusalPoisonedKeys(attempts, drafts, new Set(["P-keyed", "P-drafted"]));
  assert.deepEqual(freed, ["P-keyed"], "not live ⇒ skipped; has a cached draft ⇒ skipped; keyed+live+undrafted ⇒ freed");
});

test("W1-T2566: the closure flag is NOT removed — it is what keeps this off the per-poll path", () => {
  const runTask = readFileSync(join(import.meta.dirname, "..", "src", "run-task.ts"), "utf8");
  assert.match(runTask, /if \(!attemptsMigrated\) \{/, "the once-per-process guard must remain");
  // Running the eviction per poll re-opens the key W1-T192 had just written for a GENUINE failure
  // in that same poll — an unbounded retry loop wearing a migration's clothes. The flag and the
  // marker do different jobs and both are needed.
  assert.match(runTask, /parseReopenedKeysCache\(/, "and the persisted marker must be read beside it");
  assert.match(runTask, /writeReopenedKeys\(/, "and written after the pair commits");
});
