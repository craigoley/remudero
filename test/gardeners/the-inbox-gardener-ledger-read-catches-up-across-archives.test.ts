// W1-T13348: on the host (2026-11-17 10:55Z) the Inbox gardener's own ledger read model was still in the OLDEST of 240
// rotation archives. Its 25 ms tick advanced one 64 KiB chunk a pass, so coverage:ledger could never be observed and the
// gardener could never act. The read now spends a catch-up budget, and still never calls an unfinished read observed.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test, type TestContext } from "node:test";
import { INBOX_GARDENER_LIMITS, readInboxGardenerLedger } from "#src/lib/inbox-gardener.js";
import type { Clock } from "#src/lib/clock.js";

const SCOPE = { repository: "craigoley/remudero", instance: "core", root: "/r" };
const BASE = Date.now() - 3 * 86_400_000;
const PAD = "x".repeat(900);

/** Each now() moves the clock by stepMs, so a budget is spent by calls, not by real time. */
function steppingClock(stepMs: number): Clock {
  let t = Date.now();
  return { now: () => (t += stepMs), date: () => new Date(t), iso: () => new Date(t).toISOString() } as Clock;
}
const row = (i: number, step = "worker.activity", proposal = `noise-${i}`) =>
  JSON.stringify({ ts: new Date(BASE + i * 1000).toISOString(), host: "h", run_id: `R${i % 7}`, task_id: "DAEMON", step, proposal_id: proposal, pad: PAD });

/** Two gz archives and a live ledger: about 1.2 MB of rows, so a full read needs many 64 KiB transactions. The one row
 *  the gardener needs sits at the START of the OLDEST archive, where the host's read was stuck. */
function ledgerDir(t: TestContext, liveTail = "\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-gardener-catchup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => row(from + k)).join("\n") + "\n";
  writeFileSync(join(dir, "ledger.2026-11-15T00-00-00-000Z.ndjson.gz"),
    gzipSync(row(0, "panel.proposal_declined", "ask-old") + "\n" + lines(1, 600)));
  writeFileSync(join(dir, "ledger.2026-11-16T00-00-00-000Z.ndjson.gz"), gzipSync(lines(600, 1200)));
  writeFileSync(join(dir, "ledger.ndjson"), lines(1200, 1260) + row(1260, "inbox.gardener_restored", "ask-live").slice(0, liveTail ? undefined : 40) + liveTail);
  return dir;
}

test("W1-T13348 criterion 1: a ledger that needs many transactions is read to observed coverage in one pass", t => {
  const dir = ledgerDir(t);
  const read = readInboxGardenerLedger(dir, SCOPE, ["ask-old", "ask-live"], steppingClock(30));
  assert.equal(read.state, "observed");
  assert.deepEqual(read.rows.map(r => `${r.proposal_id}:${r.step}`).sort(), ["ask-live:inbox.gardener_restored", "ask-old:panel.proposal_declined"]);
});

test("W1-T13348 criterion 2: a catch-up the budget cannot finish reports partial, and the next pass resumes from its checkpoint", t => {
  const dir = ledgerDir(t);
  const slow = () => steppingClock(INBOX_GARDENER_LIMITS.ledgerCatchUpMs / 2);
  const first = readInboxGardenerLedger(dir, SCOPE, ["ask-old", "ask-live"], slow());
  assert.equal(first.state, "partial", "an unfinished catch-up is never observed");
  let passes = 1, read = first;
  while (read.state !== "observed" && passes < 100) { read = readInboxGardenerLedger(dir, SCOPE, ["ask-old", "ask-live"], slow()); passes++; }
  assert.equal(read.state, "observed", `each pass resumes where the last stopped, so the read finishes (after ${passes} passes)`);
  assert.ok(passes > 1);
  assert.deepEqual(read.rows.map(r => r.proposal_id).sort(), ["ask-live", "ask-old"]);
});

test("W1-T13348 criterion 3: invariant partial-never-observed, an unfinished live tail or a torn row is partial even with the full budget", t => {
  const tail = ledgerDir(t, "");
  assert.equal(readInboxGardenerLedger(tail, SCOPE, ["ask-old"], steppingClock(1)).state, "partial", "an unfinished live tail");
  const torn = ledgerDir(t);
  appendFileSync(join(torn, "ledger.ndjson"), `{"ts":"${new Date(BASE + 2_000_000).toISOString()}","step":"panel.proposal_declined","proposal_id":"ask-torn",\n`);
  assert.equal(readInboxGardenerLedger(torn, SCOPE, ["ask-old"], steppingClock(1)).state, "partial", "a torn relevant row");
  const done = ledgerDir(t);
  assert.equal(readInboxGardenerLedger(done, SCOPE, ["ask-old"], steppingClock(1)).state, "observed", "the control: the same ledger, whole, is observed");
});
