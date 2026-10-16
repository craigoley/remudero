// test/run-child-auto-reads-its-whole-window-past-rotation.test.ts — W1-T9816.
//
// `sweep.runChild.mode: auto` decides from its evidence since the previous boot. Rotation keeps no `run_child.*` row and keeps
// `daemon.start` only 30 min, so each test splits that evidence between an archive and the live file the way a rotation does,
// boots the real daemonCommand under `auto`, and reads the `run_child.mode_decision` row the boot ledgers.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { wireSweepWakeToDaemon } from "../src/lib/github-event-wake.js";
import { RUN_CHILD_MODE_DECISION_STEP, readRunChildModeUnion, runChildModeWindow } from "../src/lib/run-child-mode.js";
import { daemonCommand, ledgerPathFor } from "../src/run-task.js";

type Row = Record<string, unknown>;
const MIB = 1024 * 1024;
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const start = (minutes: number): Row => ({ ts: ago(minutes), step: "daemon.start", run_id: `DAEMON-${minutes}`, task_id: "DAEMON" });
const probe = (minutes: number): Row => ({ ts: ago(minutes), step: "run_child.shadow", run_id: `probe-${minutes}`, contract: "ok",
  tree_peak_bytes: 300 * MIB, class_estimate_bytes: 512 * MIB });
const ndjson = (rows: Row[]): string => rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");

/** Boots daemonCommand once under `auto` over a state dir whose archive and live file hold `archive` and `live`. */
async function bootAuto(archive: Row[] | Buffer, live: Row[], archiveName = "ledger.2026-10-16T00-00-00-000Z.ndjson") {
  const root = mkdtempSync(join(tmpdir(), "rmd-child-window-"));
  const oldHome = process.env.HOME;
  // A boot that refuses leaves its sweep-wake watcher open; the test closes it so the process can exit.
  const wakes: Array<{ close(): void }> = [];
  try {
    mkdirSync(join(root, ".config", "remudero"), { recursive: true });
    writeFileSync(join(root, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
    process.env.HOME = root;
    const ledgerPath = ledgerPathFor({ root } as never);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", archiveName), Buffer.isBuffer(archive) ? archive : ndjson(archive));
    writeFileSync(ledgerPath, ndjson(live));
    const plan = join(root, "tasks.yaml");
    writeFileSync(plan, "[]\n");
    const outcome = await daemonCommand(["--allow-self-target", "--plan", plan, "--max", "0"], {
      readRunChildMode: () => "auto", checkStop: () => undefined, checkPause: () => undefined,
      wireSweepWake: (...args) => { const wake = wireSweepWakeToDaemon(...args); wakes.push(wake); return wake; },
      runDaemon: async () => ({ attempted: [], merged: [], costUsd: 0, ticks: 0, stopReason: "max_reached" }),
    }).then((code) => ({ code }), (error: unknown) => ({ error: error as Error }));
    const rows = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row) : [];
    const known = new Set(live.map((row) => row.ts));
    const decisions = rows.filter((row) => row.step === RUN_CHILD_MODE_DECISION_STEP && !known.has(row.ts));
    return { outcome, decisions, archivePath: join(root, "state", archiveName) };
  } finally {
    for (const wake of wakes) wake.close();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T9816: a rotated-away lost child still holds run-child promotion", async () => {
  // The falsifier: the archive holds boot B and the lost child; the live file kept B's start (inside 30 min) and clean probes.
  const b = start(40);
  const lost: Row = { ts: ago(35), step: "run_child.lost", run_id: "run-A", detail: "unclassified failure: Cannot find module 'tsx'" };
  const { outcome, decisions } = await bootAuto([b, lost], [b, probe(20), probe(19)]);
  assert.deepEqual(outcome, { code: 0 });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.to, "shadow");
  assert.match(String(decisions[0]!.reason), /1 lost child/);
  assert.equal(decisions[0]!.window_start, b.ts);
});

test("W1-T9816: an archived previous boot still opens the run-child window", async () => {
  // The previous boot is older than the 30-min render window, so only the archive holds it; the live file is empty.
  const b = start(90);
  const { outcome, decisions } = await bootAuto([start(150), b, probe(80), probe(79)], []);
  assert.deepEqual(outcome, { code: 0 });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.to, "on");
  assert.match(String(decisions[0]!.reason), /^promoted: 2 round trip/);
  assert.equal(decisions[0]!.window_start, b.ts, "the window opens at the previous boot, read from the archive");
});

test("W1-T9816: an archived on decision keeps run-child mode on across a rotation", async () => {
  // Boot B decided on, and its child settled; a rotation then moved all of it out of the live file.
  const b = start(70);
  const on: Row = { ts: ago(69), step: RUN_CHILD_MODE_DECISION_STEP, run_id: b.run_id, from: "shadow", to: "on", reason: "promoted" };
  const settled: Row = { ts: ago(30), step: "run_child.settled", run_id: "run-B", outcome: "fulfilled" };
  const { outcome, decisions } = await bootAuto([b, on, settled], []);
  assert.deepEqual(outcome, { code: 0 });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.from, "on");
  assert.equal(decisions[0]!.to, "on");
  assert.match(String(decisions[0]!.reason), /^stays on/);
});

test("W1-T9816: an unreadable run-child window holds shadow", async () => {
  // A torn gzip archive: the union cannot read it, so no window is whole. The boot ledgers why before it refuses.
  const name = "ledger.2026-10-16T00-00-00-000Z.ndjson.gz";
  const b = start(40);
  const { outcome, decisions, archivePath } = await bootAuto(Buffer.from("not a gzip stream"), [b, probe(20), probe(19)], name);
  assert.ok("error" in outcome, "the boot still refuses an unreadable settlement read");
  assert.match(outcome.error.message, /run child settlements unreadable/);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.to, "shadow");
  assert.match(String(decisions[0]!.reason), /^held: the evidence window is unreadable/);
  assert.ok(String(decisions[0]!.reason).includes(archivePath), "the reason names the unread file");
});

test("W1-T9816: the window starts at the boot before the previous one, oldest first", () => {
  const [p5, s100, p95, s60, s30, p55, s1] = [probe(5), start(100), probe(95), start(60), start(30), probe(55), start(1)];
  const window = runChildModeWindow([p5, s100, { ts: ago(4), step: "verdict" }, p95, s60, s30, p55, s1]);
  assert.deepEqual(window, [s60, p55, s30, p5, s1]);
  assert.deepEqual(runChildModeWindow([probe(3), start(2)]).map((row) => row.step), ["run_child.shadow", "daemon.start"]);
  const read = readRunChildModeUnion("/state", () => ({ ok: false, unread: ["/state/x.gz"], rows: [] }) as never);
  assert.deepEqual(read, { rows: [], unread: ["/state/x.gz"] });
});
