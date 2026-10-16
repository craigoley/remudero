// test/run-child-auto-reads-its-whole-window-past-rotation.test.ts — W1-T9816.
//
// `sweep.runChild.mode: auto` decides from its evidence since the previous boot. Rotation keeps no `run_child.*` row and keeps
// `daemon.start` only 30 min, so each test splits that evidence between an archive and the live file the way a rotation does,
// then boots the way daemonCommand does: this boot's daemon.start, bootRunChildMode over the real union, the real adoption
// pass fed to the tracker, and the forced once-per-boot decision.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { adoptRunChildren } from "../src/lib/run-child.js";
import {
  RUN_CHILD_MODE_DECISION_STEP, bootRunChildMode, readRunChildModeUnion, runChildModeFor, runChildModeWindow,
} from "../src/lib/run-child-mode.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

type Row = Record<string, unknown>;
const MIB = 1024 * 1024;
const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const start = (minutes: number): Row => ({ ts: ago(minutes), step: "daemon.start", run_id: `DAEMON-${minutes}`, task_id: "DAEMON" });
const probe = (minutes: number): Row => ({ ts: ago(minutes), step: "run_child.shadow", run_id: `probe-${minutes}`, contract: "ok",
  tree_peak_bytes: 300 * MIB, class_estimate_bytes: 512 * MIB });
const ndjson = (rows: Row[]): string => rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");

/** One `auto` boot over a state dir whose archive and live file hold `archive` and `live`; returns the decision it ledgers. */
function bootAuto(archive: Row[] | Buffer, live: Row[], archiveName = "ledger.2026-10-16T00-00-00-000Z.ndjson") {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}child-window-`));
  scratch.push(root);
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const archivePath = join(stateDir, archiveName);
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(archivePath, Buffer.isBuffer(archive) ? archive : ndjson(archive));
  writeFileSync(ledgerPath, ndjson(live));
  appendFileSync(ledgerPath, ndjson([start(0)])); // daemonCommand ledgers this boot's daemon.start before it reads
  const logged: Row[] = [];
  const log = (step: string, extra: Row = {}) => { logged.push({ step, ...extra }); };
  const decisions = () => logged.filter((row) => row.step === RUN_CHILD_MODE_DECISION_STEP);
  try {
    const { tracker, settledRunIds } = bootRunChildMode({ stateDir, auto: true, liveRows: readLedgerLines(ledgerPath), log });
    adoptRunChildren({ stateRoot: stateDir, instance: "fixture", settledRunIds,
      log: (step, extra = {}) => { log(step, extra); tracker.observe(step, extra); } });
    tracker.record(runChildModeFor("auto", tracker.evidence()).decision, log, true);
    return { decisions: decisions(), settledRunIds, archivePath };
  } catch (error) {
    return { error: error as Error, decisions: decisions(), archivePath };
  }
}

test("W1-T9816: a rotated-away lost child still holds run-child promotion", () => {
  // The falsifier: the archive holds boot B and the lost child; the live file kept B's start (inside 30 min) and clean probes.
  const b = start(40);
  const lost: Row = { ts: ago(35), step: "run_child.lost", run_id: "run-A", detail: "unclassified failure: Cannot find module 'tsx'" };
  const { decisions } = bootAuto([b, lost], [b, probe(20), probe(19)]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.to, "shadow");
  assert.match(String(decisions[0]!.reason), /1 lost child/);
  assert.equal(decisions[0]!.window_start, b.ts);
});

test("W1-T9816: an archived previous boot still opens the run-child window", () => {
  // The previous boot is older than the 30-min render window, so only the archive holds it; the live file kept nothing.
  const b = start(90);
  const { decisions } = bootAuto([start(150), b, probe(80), probe(79)], []);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.to, "on");
  assert.match(String(decisions[0]!.reason), /^promoted: 2 round trip/);
  assert.equal(decisions[0]!.window_start, b.ts, "the window opens at the previous boot, read from the archive");
});

test("W1-T9816: an archived on decision keeps run-child mode on across a rotation", () => {
  // Boot B decided on, and its child settled; a rotation then moved all of it out of the live file.
  const b = start(70);
  const on: Row = { ts: ago(69), step: RUN_CHILD_MODE_DECISION_STEP, run_id: b.run_id, from: "shadow", to: "on", reason: "promoted" };
  const settled: Row = { ts: ago(30), step: "run_child.settled", run_id: "run-B", outcome: "fulfilled" };
  const { decisions, settledRunIds } = bootAuto([b, on, settled], []);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.from, "on");
  assert.equal(decisions[0]!.to, "on");
  assert.match(String(decisions[0]!.reason), /^stays on/);
  assert.deepEqual([...settledRunIds!], ["run-B"], "the same read hands adoption the archived settlement");
});

test("W1-T9816: an unreadable run-child window holds shadow", () => {
  // A torn gzip archive: the union cannot read it, so no window is whole. The boot ledgers why, then refuses.
  const b = start(40);
  const { error, decisions, archivePath } = bootAuto(Buffer.from("not a gzip stream"), [b, probe(20), probe(19)],
    "ledger.2026-10-16T00-00-00-000Z.ndjson.gz");
  assert.match(String(error?.message), /^run child settlements unreadable: /);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.to, "shadow");
  assert.match(String(decisions[0]!.reason), /^held: the evidence window is unreadable/);
  assert.ok(String(decisions[0]!.reason).includes(archivePath), "the reason names the unread file");
});

test("W1-T9816: the window starts at the boot before the previous one, oldest first", () => {
  const [p5, s100, p95, s60, s30, p55, s1] = [probe(5), start(100), probe(95), start(60), start(30), probe(55), start(1)];
  assert.deepEqual(runChildModeWindow([p5, s100, { ts: ago(4), step: "verdict" }, p95, s60, s30, p55, s1]), [s60, p55, s30, p5, s1]);
  assert.deepEqual(runChildModeWindow([probe(3), start(2)]).map((row) => row.step), ["run_child.shadow", "daemon.start"]);
  assert.deepEqual(readRunChildModeUnion("/state", () => ({ ok: false, unread: ["/state/x.gz"], rows: [] }) as never),
    { rows: [], unread: ["/state/x.gz"] });
  // `on` reads the same union for its settlements but seeds the tracker from the live rows, and an unreadable union refuses it.
  const seeded = bootRunChildMode({ stateDir: "/state", auto: false, liveRows: [start(9), probe(8)], log: () => {},
    read: () => ({ ok: true, unread: [], rows: [{ step: "run_child.settled", run_id: "R" }, { step: "run_child.settled" }] }) as never });
  assert.deepEqual([...seeded.settledRunIds], ["R"]);
  assert.equal(seeded.tracker.evidence().current.roundTrips, 1);
  const logged: string[] = [];
  assert.throws(() => bootRunChildMode({ stateDir: "/state", auto: false, liveRows: [], log: (step) => { logged.push(step); },
    read: () => ({ ok: false, unread: ["/state/y.gz"], rows: [] }) as never }), /settlements unreadable: \/state\/y\.gz/);
  assert.deepEqual(logged, [], "only auto ledgers a decision before refusing");
});
