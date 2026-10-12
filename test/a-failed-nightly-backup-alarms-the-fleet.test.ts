import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import type { Escalation } from "../src/lib/escalate.js";
import { hostResourceStatePath, parseHeartbeatPayload, runHostResourcePass, type HostResourcePorts } from "../src/lib/host-resource-gardener.js";
import { runBeat, REPO_ROOT } from "./helpers/fleet-heartbeat-harness.js";

const PROOF = "test/a-failed-nightly-backup-alarms-the-fleet.test.ts";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const HOUR = 3_600_000;
const DATE = `#!/bin/sh
case "$*" in
  '-u +%s') echo 1791201600 ;;
  '-u +%Y-%m-%dT%H:%M:%SZ') echo 2026-10-05T12:00:00Z ;;
  *) exec /bin/date "$@" ;;
esac
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-backup-alarm-"));
  const home = join(dir, "home");
  const root = join(dir, "volume");
  const bin = join(dir, "bin");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(root, "state", "ledger.ndjson"), '{"step":"run.start"}\n');
  writeFileSync(join(bin, "docker"), `#!/bin/bash
case "$1 $2" in
  'info --format') echo "$BACKUP_ROOT"; exit 0 ;;
  'system df') exit 0 ;;
esac
case "$1" in
  ps)
    if [ "$BACKUP_MODE" = ps-failed ] && [ -f "$BACKUP_ROOT/ps-called" ]; then exit 1; fi
    touch "$BACKUP_ROOT/ps-called"
    echo c0ffee ;;
  inspect) case "$*" in *.Source*) echo "$BACKUP_ROOT" ;; *) echo '/daemon|rmd-local:latest|/home/node/Remudero ' ;; esac ;;
  run)
    case "$BACKUP_MODE" in
      failed) echo 'image unavailable' >&2; exit 125 ;;
      silent) exit 0 ;;
    esac
    archive=state-backup.2026-10-05T12-00-00-000Z
    mkdir -p "$BACKUP_ROOT/state-backups/$archive"
    cp "$BACKUP_ROOT/state/ledger.ndjson" "$BACKUP_ROOT/state-backups/$archive/ledger.ndjson"
    echo "RMD_STATE_SNAPSHOT $archive 1 0 0 0" ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "az"), `#!/bin/sh
case "$1 $2" in
  'disk show') echo '/disk/id|eastus' ;;
  'snapshot create') if [ "$OFFHOST_MODE" = failed ]; then echo 'expired Azure login' >&2; exit 1; fi ;;
  'snapshot show') echo 'Succeeded|fleet-state-backup|host-update|/disk/id' ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "date"), DATE, { mode: 0o755 });
  const receipt = join(home, ".local/state/remudero/state-snapshot.receipt");
  const rung = (mode = "ok", extra: NodeJS.ProcessEnv = {}, args = ["--reclaim-only"]) => spawnSync("bash", [join(REPO_ROOT, "deploy/host-update.sh"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_STATE_HOME: "", PATH: `${bin}:${process.env.PATH}`, BACKUP_ROOT: root, BACKUP_MODE: mode,
      OFFHOST_MODE: "ok", RMD_STATE_DIR: root, RMD_STATE_OFFHOST: "", RMD_STATE_BACKUP_DIR: "", RMD_STATE_SNAPSHOT_RECEIPT: "",
      RMD_STATE_OFFHOST_AZ: join(bin, "az"), RMD_STATE_BACKUP_KEEP: "7", RMD_STATE_OFFHOST_KEEP: "7", ...extra },
  });
  const beat = (path = receipt) => {
    const b = runBeat({ dateStub: DATE, env: { RMD_STATE_SNAPSHOT_RECEIPT: path } });
    assert.equal(b.status, 0, b.stderr);
    return b.published;
  };
  return { dir, root, receipt, rung, beat, read: () => parseHeartbeatPayload(readFileSync(receipt, "utf8")) };
}

function gardener(dir: string) {
  let beats: Array<{ host: string; payload: string }> = [];
  const escalations: Escalation[] = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const ports: HostResourcePorts = {
    stateDir: dir, clock: fixedClock(NOW), readHeartbeats: () => beats, planOrigins: () => [],
    log: (step, extra) => rows.push({ step, extra }), escalate: (e) => { escalations.push(e); return "https://issue/backup"; },
  };
  return { ports, escalations, rows, pass: (payload: string, host = "azure") => { beats = [{ host, payload }]; return runHostResourcePass(ports); } };
}

function seedReceipt(path: string, ageMs: number, result = "ok", offhost = "not-configured") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `result=${result}\nts=${new Date(NOW - ageMs).toISOString()}\narchives=1\noffhost=${offhost}\nreason=seeded failure\n`);
}

test(`${PROOF}: a failed nightly run reaches the beat, alarms once per host, and recovers`, () => {
  const f = fixture();
  try {
    const g = gardener(f.dir);
    const failed = f.rung("failed");
    assert.equal(failed.status, 1, failed.stderr);
    assert.ok(existsSync(f.receipt), "the nightly writer must publish a receipt even on failure");
    const receipt = f.read();
    assert.equal(receipt.result, "failed");
    assert.equal(receipt.archives, "0");
    assert.equal(receipt.offhost, "not-configured");
    assert.match(receipt.reason!, /STATE SNAPSHOT FAILED.*exited 125/);
    const beat = f.beat();
    const fields = parseHeartbeatPayload(beat);
    assert.equal(fields.backup_verdict, `FAILED: ${receipt.reason}`);
    assert.equal(fields.backup_ts, receipt.ts);
    assert.equal(fields.backup_offhost, receipt.offhost);
    g.pass(beat);
    g.pass(beat);
    g.pass(beat, "mini");
    assert.equal(g.escalations.length, 2);
    assert.deepEqual(g.escalations.map((e) => e.taskId).sort(), ["host-state-backup-azure", "host-state-backup-mini"]);
    assert.match(g.escalations[0]!.detail, /exited 125/);
    assert.equal(g.escalations[0]!.headDedup, "independent");
    const persisted = JSON.parse(readFileSync(hostResourceStatePath(f.dir), "utf8"));
    assert.equal(persisted.stateBackup.azure.verdict, fields.backup_verdict);
    assert.ok(persisted.stateBackup.azure.escalatedAt);
    runHostResourcePass({ ...g.ports, readHeartbeats: () => [{ host: "azure", payload: beat }] });
    assert.equal(g.escalations.length, 2, "a restarted pass must retain the episode");
    assert.equal(f.rung().status, 0);
    const ok = f.beat();
    assert.equal(parseHeartbeatPayload(ok).backup_verdict, "ok");
    assert.equal(f.read().archives, "1");
    g.pass(ok);
    g.pass(ok);
    assert.equal(g.rows.filter((r) => r.step === "host_resource.state_backup_recovered").length, 1);
    assert.equal(JSON.parse(readFileSync(hostResourceStatePath(f.dir), "utf8")).stateBackup.azure.verdict, "ok");
    assert.equal(g.escalations.length, 2);
    g.pass(beat);
    assert.equal(g.escalations.length, 3, "recovery permits a subsequent failure episode");
    assert.equal(readFileSync(join(f.root, "state/ledger.ndjson"), "utf8"), '{"step":"run.start"}\n');
    assert.deepEqual(readdirSync(join(f.receipt, "..")).sort(), ["state-snapshot.receipt"], "atomic write leaves no temporary receipt");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test(`${PROOF}: an Azure copy failure travels through the same alarm and a verified copy recovers`, () => {
  const f = fixture();
  try {
    const env = { RMD_STATE_OFFHOST: "azure-disk-snapshot:rg/disk", OFFHOST_MODE: "failed" };
    assert.equal(f.rung("ok", env).status, 1);
    assert.equal(f.read().result, "failed");
    assert.equal(f.read().offhost, "failed");
    assert.equal(f.read().archives, "1");
    assert.match(f.read().reason!, /OFF-HOST COPY FAILED.*snapshot create/);
    const g = gardener(f.dir);
    g.pass(f.beat());
    assert.equal(g.escalations.length, 1);
    assert.match(g.escalations[0]!.detail, /Off-host: failed/);
    assert.equal(f.rung("ok", { ...env, OFFHOST_MODE: "ok" }).status, 0);
    assert.equal(f.read().offhost, "ok");
    assert.equal(f.read().reason, "");
    g.pass(f.beat());
    assert.equal(g.rows.filter((r) => r.step === "host_resource.state_backup_recovered").length, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test(`${PROOF}: a missed run ages past 26 hours and alarms once while unknown stays silent`, () => {
  const f = fixture();
  try {
    const g = gardener(f.dir);
    const unknown = f.beat();
    assert.equal(parseHeartbeatPayload(unknown).backup_verdict, "unknown — no snapshot receipt");
    g.pass(unknown);
    assert.equal(g.escalations.length, 0);
    seedReceipt(f.receipt, 26 * HOUR);
    assert.equal(parseHeartbeatPayload(f.beat()).backup_verdict, "ok", "26 hours is still fresh");
    seedReceipt(f.receipt, 26 * HOUR + 1000);
    const stale = f.beat();
    assert.match(parseHeartbeatPayload(stale).backup_verdict!, /^STALE — last nightly snapshot run 26h0m ago$/);
    g.pass(stale);
    g.pass(stale);
    assert.equal(g.escalations.length, 1);
    g.pass(unknown);
    g.pass(stale);
    assert.equal(g.escalations.length, 1, "unknown cannot clear an alarm");
    seedReceipt(f.receipt, 0);
    g.pass(f.beat());
    assert.equal(g.rows.filter((r) => r.step === "host_resource.state_backup_recovered").length, 1);
    g.pass(stale);
    assert.equal(g.escalations.length, 1, "an older receipt cannot reopen a recovered episode");
    seedReceipt(f.receipt, 27 * HOUR, "failed", "failed");
    assert.match(parseHeartbeatPayload(f.beat()).backup_verdict!, /^STALE/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test(`${PROOF}: dry runs and runs that die before 4c cannot refresh the receipt`, () => {
  const f = fixture();
  try {
    seedReceipt(f.receipt, 27 * HOUR);
    const before = readFileSync(f.receipt, "utf8");
    assert.equal(f.rung("ok", {}, ["--reclaim-only", "--dry-run"]).status, 0);
    assert.equal(readFileSync(f.receipt, "utf8"), before);
    assert.equal(f.rung("ok", { RMD_STATE_BACKUP_KEEP: "0" }).status, 2);
    assert.equal(readFileSync(f.receipt, "utf8"), before);
    assert.match(parseHeartbeatPayload(f.beat()).backup_verdict!, /^STALE/);
    f.rung("ok", {}, ["--print-daemon-run"]);
    assert.equal(readFileSync(f.receipt, "utf8"), before);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test(`${PROOF}: the first failure headline survives a later off-host failure`, () => {
  const f = fixture();
  try {
    const r = f.rung("silent", { RMD_STATE_OFFHOST: "invalid-target" });
    assert.equal(r.status, 1);
    assert.equal(f.read().offhost, "failed");
    assert.match(f.read().reason!, /^host-update: STATE SNAPSHOT FAILED.*published no archive/);
    assert.match(parseHeartbeatPayload(f.beat()).backup_verdict!, /^FAILED: .*published no archive/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test(`${PROOF}: unreadable or malformed receipts never invent a healthy backup`, () => {
  const f = fixture();
  try {
    const g = gardener(f.dir);
    for (const content of ["", "result=ok\nts=not-a-date\noffhost=ok\n", "result=ok\n", "result=garbage\nts=2026-10-05T12:00:00Z\n", "result=ok\nts=2026-10-05T13:00:00Z\noffhost=ok\n"]) {
      mkdirSync(join(f.receipt, ".."), { recursive: true });
      writeFileSync(f.receipt, content);
      const beat = f.beat();
      assert.match(parseHeartbeatPayload(beat).backup_verdict!, /^unknown/);
      g.pass(beat);
    }
    assert.equal(g.escalations.length, 0);
    assert.match(parseHeartbeatPayload(f.beat(f.dir)).backup_verdict!, /^unknown/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test(`${PROOF}: both scripts share the XDG default and receipt overrides`, () => {
  const f = fixture();
  try {
    const xdg = join(f.dir, "xdg");
    assert.equal(f.rung("ok", { XDG_STATE_HOME: xdg }).status, 0);
    const path = join(xdg, "remudero/state-snapshot.receipt");
    assert.equal(parseHeartbeatPayload(readFileSync(path, "utf8")).result, "ok");
    const b = runBeat({ dateStub: DATE, env: { RMD_STATE_SNAPSHOT_RECEIPT: "", XDG_STATE_HOME: xdg } });
    assert.equal(b.status, 0, b.stderr);
    assert.equal(parseHeartbeatPayload(b.published).backup_verdict, "ok");
    assert.equal(f.rung().status, 0);
    const homeBeat = runBeat({ dateStub: DATE, env: { HOME: join(f.dir, "home"), XDG_STATE_HOME: "", RMD_STATE_SNAPSHOT_RECEIPT: "" } });
    assert.equal(homeBeat.status, 0, homeBeat.stderr);
    assert.equal(parseHeartbeatPayload(homeBeat.published).backup_verdict, "ok");
    const override = join(f.dir, "override.receipt");
    assert.equal(f.rung("ok", { RMD_STATE_SNAPSHOT_RECEIPT: override }).status, 0);
    assert.equal(parseHeartbeatPayload(f.beat(override)).backup_verdict, "ok");
    assert.equal(f.read().result, "ok");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test(`${PROOF}: a receipt write failure preserves the previous receipt and fails the rung`, () => {
  const f = fixture();
  try {
    seedReceipt(f.receipt, 27 * HOUR);
    const previous = readFileSync(f.receipt, "utf8");
    const blocked = join(f.dir, "blocked");
    writeFileSync(blocked, "not a directory");
    const r = f.rung("ok", { RMD_STATE_SNAPSHOT_RECEIPT: join(blocked, "receipt") });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot prepare state snapshot receipt/);
    assert.equal(readFileSync(f.receipt, "utf8"), previous);
    assert.match(parseHeartbeatPayload(f.beat()).backup_verdict!, /^STALE/);
    const directory = f.rung("ok", { RMD_STATE_SNAPSHOT_RECEIPT: f.dir });
    assert.equal(directory.status, 1);
    assert.match(directory.stderr, /cannot prepare state snapshot receipt/);
    writeFileSync(join(f.dir, "bin/mv"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const rename = f.rung();
    assert.equal(rename.status, 1);
    assert.match(rename.stderr, /cannot publish state snapshot receipt/);
    assert.equal(readFileSync(f.receipt, "utf8"), previous);
    assert.deepEqual(readdirSync(join(f.receipt, "..")).sort(), ["state-snapshot.receipt"]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test(`${PROOF}: every local snapshot failure records its own headline`, () => {
  for (const mode of ["ps-failed", "mkdir-failed", "missing-ledger"]) {
    const f = fixture();
    try {
      const extra: NodeJS.ProcessEnv = {};
      if (mode === "mkdir-failed") {
        const blocked = join(f.dir, "blocked");
        writeFileSync(blocked, "not a directory");
        extra.RMD_STATE_BACKUP_DIR = join(blocked, "backups");
      } else if (mode === "missing-ledger") {
        rmSync(join(f.root, "state/ledger.ndjson"));
        mkdirSync(`${f.root}2/state`, { recursive: true });
        writeFileSync(`${f.root}2/state/ledger.ndjson`, "a live sibling\n");
      }
      const r = f.rung(mode, extra);
      assert.equal(r.status, 1, r.stderr);
      assert.equal(f.read().result, "failed");
      const expected = mode === "ps-failed" ? /docker ps did not answer/ : mode === "mkdir-failed" ? /cannot create/ : /ledger.ndjson does not exist or is empty/;
      assert.match(f.read().reason!, expected);
      assert.match(parseHeartbeatPayload(f.beat()).backup_verdict!, expected);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test(`${PROOF}: consecutive failed nights remain one episode until a newer receipt recovers`, () => {
  const f = fixture();
  try {
    const g = gardener(f.dir);
    for (let night = 0; night < 6; night++) {
      seedReceipt(f.receipt, (6 - night) * HOUR, "failed", "failed");
      g.pass(f.beat());
    }
    assert.equal(g.escalations.length, 1);
    assert.equal(g.rows.filter((r) => r.step === "host_resource.state_backup_failed").length, 1);
    seedReceipt(f.receipt, 7 * HOUR);
    g.pass(f.beat());
    assert.equal(g.rows.filter((r) => r.step === "host_resource.state_backup_recovered").length, 0);
    seedReceipt(f.receipt, 0);
    g.pass(f.beat());
    assert.equal(g.rows.filter((r) => r.step === "host_resource.state_backup_recovered").length, 1);
    seedReceipt(f.receipt, 0, "failed", "failed");
    g.pass(f.beat());
    assert.equal(g.escalations.length, 2);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test(`${PROOF}: a failed backup without an escalation port remains eligible for a later alarm`, () => {
  const f = fixture();
  try {
    assert.equal(f.rung("failed").status, 1);
    const beat = f.beat();
    const g = gardener(f.dir);
    runHostResourcePass({ ...g.ports, escalate: undefined, readHeartbeats: () => [{ host: "azure", payload: beat }] });
    assert.equal(g.escalations.length, 0);
    assert.equal(JSON.parse(readFileSync(hostResourceStatePath(f.dir), "utf8")).stateBackup.azure.verdict, parseHeartbeatPayload(beat).backup_verdict);
    g.pass(beat);
    assert.equal(g.escalations.length, 1);
    g.pass("backup_verdict=ok\nbackup_ts=not-a-date\n");
    assert.equal(g.rows.filter((r) => r.step === "host_resource.state_backup_recovered").length, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
