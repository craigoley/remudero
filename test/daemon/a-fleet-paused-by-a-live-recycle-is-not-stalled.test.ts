import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  decideProgressWatchdog,
  readLiveRecyclePausePid,
  STALL_DIAGNOSE_AFTER_MS,
  STALL_RECYCLE_AFTER_MS,
} from "#src/lib/progress-watchdog.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { allowGhRefusals } from "#test/setup/tmp-hygiene.js";

allowGhRefusals("the spawned verb reads the live open-PR list (W1-T11750); the refused read is its unreachable-board arm, which the ledger count then decides");

const reason = "container recycle (deploy/recycle-container.sh)";
const nowMs = Date.now();
const rows = [{ ts: new Date(nowMs - STALL_RECYCLE_AFTER_MS - 60_000).toISOString(), step: "sweep.pass", enumerated: 4 }];
const input = { rows, nowMs, openPrCount: 4, revivalLog: "" };

test("test/daemon/a-fleet-paused-by-a-live-recycle-is-not-stalled.test.ts", () => {
  const verdict = decideProgressWatchdog({ ...input, liveRecyclePausePid: process.pid });
  assert.equal(verdict.state, "IN_RECYCLE");
  assert.equal(verdict.action, "none");
  assert.equal(verdict.progressAgeMs, STALL_RECYCLE_AFTER_MS + 60_000);
  assert.match(verdict.reason, new RegExp(`live recycle \\(pid ${process.pid}\\) owns PAUSE`));
  assert.match(verdict.reason, /not a stall/);
});

test("a live recycle also suppresses the generation and diagnostic stall branches", () => {
  for (const age of [STALL_DIAGNOSE_AFTER_MS + 1, STALL_RECYCLE_AFTER_MS + 1]) {
    for (const step of ["sweep.pass", "daemon.boot"]) {
      const verdict = decideProgressWatchdog({
        ...input, liveRecyclePausePid: process.pid,
        rows: [{ ts: new Date(nowMs - age).toISOString(), step }],
      });
      assert.deepEqual([verdict.state, verdict.action], ["IN_RECYCLE", "none"]);
    }
  }
});

test("without a proven live recycle, the watchdog retains its existing verdict", () => {
  const verdict = decideProgressWatchdog(input);
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"]);
});

test("a verified live recycle owns the verdict even when ledger evidence is absent or idle", () => {
  for (const openPrCount of [undefined, 0, 4]) {
    const verdict = decideProgressWatchdog({ ...input, rows: [], openPrCount, liveRecyclePausePid: process.pid });
    assert.deepEqual([verdict.state, verdict.action], ["IN_RECYCLE", "none"]);
  }
});

function fixture(t: TestContext) {
  const { dir } = writeLedger(rows, { scope: t });
  const pause = join(dir, "PAUSE");
  const body = { reason, pid: process.pid, host: hostname(), writerStart: "Wed Nov 4 12:00:00 2026" };
  const err: string[] = [];
  t.mock.method(console, "error", (text: unknown) => { err.push(String(text)); });
  return {
    pause, body, err,
    run(exec?: (file: string, args: string[]) => string) {
      return decideProgressWatchdog({ ...input, liveRecyclePausePid: readLiveRecyclePausePid(dir, exec) });
    },
    cli() {
      const child = spawnSync(process.execPath, ["--import", "tsx", "src/run-task.ts",
        "progress-watchdog", "--state-root", dir, "--json"], {
        cwd: REPO_ROOT, encoding: "utf8",
        env: { ...process.env, RMD_SELF_SYNC_DONE: "1", NODE_V8_COVERAGE: "" },
      });
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout) as { state: string; action: string; reason: string };
    },
  };
}

test("the verb verifies a real live writer with C locale and UTC ps output", (t) => {
  const f = fixture(t);
  const writerStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  }).trim().replace(/[ \t]+/g, " ");
  assert.notEqual(writerStart, "", "positive control: ps sees the writer");
  const body = JSON.stringify({ ...f.body, writerStart });
  writeFileSync(f.pause, body);
  const verdict = f.run();
  assert.deepEqual([verdict.state, verdict.action], ["IN_RECYCLE", "none"]);
  const cli = f.cli();
  assert.deepEqual([cli.state, cli.action], ["IN_RECYCLE", "none"]);
  assert.equal(cli.reason, verdict.reason);
  assert.equal(readFileSync(f.pause, "utf8"), body);
  assert.deepEqual(f.err, []);
});

test("the PAUSE reader normalizes ps whitespace and requests the recorded pid", (t) => {
  const f = fixture(t);
  writeFileSync(f.pause, JSON.stringify(f.body));
  const verdict = f.run((file, args) => {
    assert.equal(file, "env");
    assert.deepEqual(args, ["LC_ALL=C", "TZ=UTC", "ps", "-o", "lstart=", "-p", String(process.pid)]);
    return "  Wed Nov  4 12:00:00 2026 \n";
  });
  assert.deepEqual([verdict.state, verdict.action], ["IN_RECYCLE", "none"]);
});

for (const [name, fields] of [
  ["operator PAUSE", { reason: "operator maintenance" }],
  ["a similar recycle reason", { reason: `${reason} extra` }],
  ["another host", { host: `${hostname()}-elsewhere` }],
  ["no host", { host: undefined }],
  ["no writerStart", { writerStart: undefined }],
  ["an empty writerStart", { writerStart: "" }],
  ["a string pid", { pid: String(process.pid) }],
  ["pid zero", { pid: 0 }],
  ["a negative pid", { pid: -1 }],
  ["a fractional pid", { pid: 1.5 }],
] as const) {
  test(`the PAUSE reader preserves STALLED for ${name} without probing a process`, (t) => {
    const f = fixture(t);
    writeFileSync(f.pause, JSON.stringify({ ...f.body, ...fields }));
    const verdict = f.run(() => assert.fail("ownership is not eligible for a liveness probe"));
    assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"]);
    assert.deepEqual(f.err, []);
    if (name === "operator PAUSE") {
      const cli = f.cli();
      assert.deepEqual([cli.state, cli.action], ["STALLED", "recycle"]);
    }
  });
}

for (const start of ["", "Thu Jan 1 00:00:00 1970"]) {
  test(`an absent or reused writer (${JSON.stringify(start)}) still reads STALLED`, (t) => {
    const f = fixture(t);
    writeFileSync(f.pause, JSON.stringify(f.body));
    const verdict = f.run(() => start);
    assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"]);
  });
}

test("a real exited writer still reads STALLED", (t) => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, ["-e", ""], { env: { ...process.env, NODE_V8_COVERAGE: "" } });
  assert.equal(child.status, 0);
  assert.ok(child.pid > 0);
  writeFileSync(f.pause, JSON.stringify({ ...f.body, pid: child.pid }));
  const verdict = f.run();
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"]);
  const cli = f.cli();
  assert.deepEqual([cli.state, cli.action], ["STALLED", "recycle"]);
});

test("no PAUSE retains STALLED without probing a process", (t) => {
  const f = fixture(t);
  const verdict = f.run(() => assert.fail("no PAUSE needs no ps"));
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"]);
  assert.deepEqual(f.err, []);
  const cli = f.cli();
  assert.deepEqual([cli.state, cli.action], ["STALLED", "recycle"]);
});

for (const body of ["null", "[]", "broken json"]) {
  test(`an invalid PAUSE (${body}) never suppresses a stall`, (t) => {
    const f = fixture(t);
    writeFileSync(f.pause, body);
    const verdict = f.run();
    assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"]);
  });
}

test("an unreadable PAUSE reports the failed ownership check and retains STALLED", (t) => {
  const f = fixture(t);
  mkdirSync(f.pause);
  const verdict = f.run();
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"]);
  assert.match(f.err.join("\n"), /cannot verify recycle PAUSE writer/);
});

test("a failed ps reports the failed ownership check and retains STALLED", (t) => {
  const f = fixture(t);
  writeFileSync(f.pause, JSON.stringify(f.body));
  const verdict = f.run(() => { throw new Error("ps unavailable"); });
  assert.deepEqual([verdict.state, verdict.action], ["STALLED", "recycle"]);
  assert.match(f.err.join("\n"), /ps unavailable/);
});
