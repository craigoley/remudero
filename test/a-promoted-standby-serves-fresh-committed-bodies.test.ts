/**
 * Phase 3 handoff, read-model half (arch-phase3-design.md §1 "Read-model leases", P3-03): a standby
 * loads committed bodies at boot, which can be a minute before it is promoted. At promote it reloads
 * them, judges warm sources by when the active generation last committed, and takes the lease within
 * one tick of the old generation releasing it.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import {
  READ_MODEL_LEDGER_STALE_MS,
  committedTickTimes,
  createReadModelTicker,
  createReadModelWorker,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import type { ViewSource } from "../src/lib/views.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-01T12:00:00.000Z");

function scratch(t: { after: (fn: () => void) => void }, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function steppedClock(): { clock: Clock; advance: (ms: number) => void } {
  let ms = T0;
  return { clock: { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() }, advance: (by) => void (ms += by) };
}

function rowLines(n: number, startMs: number, tag: string): string {
  let out = "";
  for (let i = 0; i < n; i++) out += `${JSON.stringify({ ts: new Date(startMs + i).toISOString(), step: "run.start", task_id: `T${i}`, run_id: `${tag}-${i}` })}\n`;
  return out;
}

function statusBodies(messages: ReadModelWorkerMessage[]) {
  return messages.flatMap((m) => (m.type === "body" && m.entry.view === "read-model" ? [m.entry] : []));
}

function activeGeneration(t: { after: (fn: () => void) => void }) {
  const ledgerDir = scratch(t, "promote-ledger");
  const stateDir = scratch(t, "promote-state");
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, "ledger.ndjson"), rowLines(4, T0 - 60_000, "boot"));
  const { clock, advance } = steppedClock();
  const messages: ReadModelWorkerMessage[] = [];
  const instances = [{ name: "core", ledgerDir }];
  const ticker = createReadModelTicker({ stateDir, instances, clock, holder: "active", post: (m) => void messages.push(m), oracle: "off" });
  let released = false;
  t.after(() => void (released || ticker.release()));
  const tickUntilNewBody = (): void => {
    const before = statusBodies(messages).length;
    for (let pass = 0; pass < 8 && statusBodies(messages).length === before; pass++) ticker.tick();
    assert.ok(statusBodies(messages).length > before, "the active generation committed a new status body");
  };
  return {
    ledgerDir, stateDir, instances, clock, advance, messages, ticker, tickUntilNewBody,
    release: () => ((released = true), ticker.release()),
  };
}

const warmSource: ViewSource[] = [{ name: "ledger:core", asOf: null, state: "stale", reason: "as persisted" }];

test("bodies reloaded at promote carry the active generation's last commit", (t) => {
  const active = activeGeneration(t);
  active.tickUntilNewBody();
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const standby = createReadModelWorker({ stateDir: active.stateDir, instances: active.instances, clock: active.clock, log: (step, extra) => void logs.push([step, extra]) });
  const booted = standby.body("read-model");
  assert.ok(booted, "the standby warm-loaded the committed body at boot");

  appendFileSync(join(active.ledgerDir, "ledger.ndjson"), rowLines(3, T0, "after-boot"));
  active.advance(1_000);
  active.tickUntilNewBody();
  const latest = statusBodies(active.messages).pop()!;
  assert.notEqual(latest.etag, booted.etag, "the active generation moved on after the standby booted");
  assert.equal(standby.body("read-model")?.etag, booted.etag, "until promote the standby still holds its boot-time copy");

  assert.equal(standby.reload(), 1, "one body changed since boot");
  assert.deepEqual(standby.body("read-model"), latest, "the promoted generation serves exactly what the active one last committed");
  assert.equal(standby.reload(), 0, "a second reload finds nothing newer");
  assert.deepEqual(logs.filter(([step]) => step === "read_model.reloaded").map(([, extra]) => extra?.replaced), [1, 0]);
});

test("a warm-loaded body committed within the stale bound is not marked warming", (t) => {
  const active = activeGeneration(t);
  active.tickUntilNewBody();
  const committed = committedTickTimes(active.stateDir, active.instances).get("core");
  assert.equal(committed, active.clock.now(), "the lease row says when the holder last committed");

  const standby = createReadModelWorker({ stateDir: active.stateDir, instances: active.instances, clock: active.clock });
  assert.deepEqual(standby.judge(warmSource, committed! + 5_000), [{ name: "ledger:core", asOf: null, state: "fresh" }], "the DB was committed 5 s ago: fresh, not warming");
  const late = standby.judge(warmSource, committed! + READ_MODEL_LEDGER_STALE_MS + 1)[0];
  assert.equal(late?.state, "stale", "past the stale bound with no tick of its own, the body is stale again");
  assert.match(late?.reason ?? "", /warming/);

  assert.equal(active.release(), 1, "the active generation releases its lease at drain start");
  standby.reload();
  assert.equal(standby.judge(warmSource, committed! + 1)[0]?.state, "stale", "a released lease is no evidence of a recent commit");
  assert.equal(committedTickTimes(active.stateDir, [{ name: "never-opened", ledgerDir: active.ledgerDir }]).size, 0, "an instance with no DB file has no commit time");
});

test("a second worker on the same DB acquires the lease within one tick of the first releasing it", (t) => {
  const active = activeGeneration(t);
  active.tickUntilNewBody();
  const posted: ReadModelWorkerMessage[] = [];
  const next = createReadModelTicker({ stateDir: active.stateDir, instances: active.instances, clock: active.clock, holder: "next", post: (m) => void posted.push(m), oracle: "off" });
  t.after(() => void next.release());
  const lease = (): string | undefined => {
    const states = posted.filter((m) => m.type === "state");
    const last = states[states.length - 1];
    return last?.type === "state" ? last.instances[0]?.lease : undefined;
  };
  next.tick();
  assert.equal(lease(), "elsewhere", "while the active generation holds it, the next one projects nothing");
  active.release();
  next.tick();
  assert.equal(lease(), "held", "one tick after the release, the next generation holds the lease");
});
