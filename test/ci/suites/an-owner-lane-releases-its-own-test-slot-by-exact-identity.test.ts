import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBootId, readPidNamespace, testSlotProcessFacts, type TestSlotHolder } from "#src/lib/test-slot.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "scripts", "test-slot-owner-release.mjs");
const linux = process.platform === "linux" && readBootId() !== undefined && readPidNamespace() !== undefined;

/** A pid that existed and has exited, so the recorded owner is provably gone. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

function holder(pid: number, processStart: string): TestSlotHolder {
  const at = new Date().toISOString();
  return { pid, host: hostname(), bootId: readBootId(), pidNs: readPidNamespace(), ownerUid: process.getuid?.(),
    processStart, ownerNonce: "nonce-t11808", startedAt: at, heartbeatAt: at, label: "owner lane fixture",
    workIdentity: "reservation-marker-v1",
    cgroupScope: { path: "/user.slice/user-1000.slice/run-t11808-absent.scope", dedicated: true } };
}

function writeSlot(dir: string, held: TestSlotHolder): string {
  const path = join(dir, "slot-1.json");
  writeFileSync(path, JSON.stringify(held));
  // A shared (group/other-readable) legacy record; the owner digit stays 7, so no permission denial is assumed.
  chmodSync(path, 0o755);
  return path;
}

function runCli(args: string[]) {
  const run = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { encoding: "utf8", cwd: REPO_ROOT });
  const line = run.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return { status: run.status, row: JSON.parse(line) as { step: string; outcome: string; reason: string }, stderr: run.stderr };
}

const flags = (dir: string, held: TestSlotHolder, over: Record<string, string> = {}): string[] =>
  Object.entries({ "slot-dir": dir, slot: "1", nonce: held.ownerNonce!, pid: String(held.pid), start: held.processStart!, ...over })
    .flatMap(([key, value]) => [`--${key}`, value]);

test("the owner-lane command releases only an exactly identified reservation with proven-ended evidence and leaves every refused record unchanged", { skip: !linux }, t => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t11808-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Refusals leave the record byte-identical.
  const dead = holder(deadPid(), "proc:100");
  const path = writeSlot(dir, dead);
  const before = readFileSync(path);
  const wrongNonce = runCli(flags(dir, dead, { nonce: "nonce-other" }));
  assert.equal(wrongNonce.status, 1);
  assert.equal(wrongNonce.row.step, "test_slot.owner_release_cli");
  assert.equal(wrongNonce.row.outcome, "refused");
  assert.match(wrongNonce.row.reason, /PID reuse or a replaced reservation/);
  const wrongStart = runCli(flags(dir, dead, { start: "proc:101" }));
  assert.equal(wrongStart.status, 1);
  assert.equal(wrongStart.row.outcome, "refused");
  assert.deepEqual(readFileSync(path), before);

  // A live owner (this very process, with its real kernel start) is never released.
  const liveStart = testSlotProcessFacts(process.pid)?.start;
  assert.ok(liveStart, "this process has kernel start facts");
  const live = holder(process.pid, liveStart);
  writeSlot(dir, live);
  const liveBefore = readFileSync(path);
  const alive = runCli(flags(dir, live));
  assert.equal(alive.status, 1);
  assert.equal(alive.row.outcome, "refused");
  assert.match(alive.row.reason, /is alive/);
  assert.deepEqual(readFileSync(path), liveBefore);

  // A missing flag refuses non-zero without touching the record.
  writeSlot(dir, dead);
  for (const missing of ["slot-dir", "slot", "nonce", "pid", "start"]) {
    const args = flags(dir, dead);
    const at = args.indexOf(`--${missing}`);
    args.splice(at, 2);
    const run = runCli(args);
    assert.notEqual(run.status, 0, missing);
    assert.equal(run.row.outcome, "refused");
    assert.match(run.row.reason, new RegExp(`missing required --${missing}`));
  }
  assert.deepEqual(readFileSync(path), before);

  // Positive control: the exact identity with proven-ended evidence releases and exits 0.
  const released = runCli(flags(dir, dead));
  assert.equal(released.status, 0, released.stderr);
  assert.equal(released.row.outcome, "released");
  assert.equal(existsSync(path), false);
});
