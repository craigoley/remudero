import assert from "node:assert/strict";
import { appendFileSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { hostResourceStatePath, parseHeartbeatPayload, runHostResourcePassAsync } from "#src/lib/host-resource-gardener.js";
import { runBeat } from "#test/helpers/fleet-heartbeat-harness.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const firstTs = "2026-11-23T10:00:00Z";
const nextTs = "2026-11-23T11:00:00Z";
const mib = 1024 ** 2;

function fixture(t: TestContext) {
  const { dir } = ownedFixtureDir(t, "janitor-passes");
  const rows: Record<string, unknown>[] = [];
  const beat = (env: Record<string, string>) => {
    const result = runBeat({ env, stateFiles: { "heartbeat-count.txt": "1\n" } });
    assert.equal(result.status, 0, result.stderr);
    return parseHeartbeatPayload(result.published);
  };
  const log = (name: string, lines: string[], ts = firstTs) => {
    const path = join(dir, name);
    writeFileSync(path, lines.join("\n") + "\n");
    utimesSync(path, new Date(ts), new Date(ts));
    return path;
  };
  const run = async (...beats: { host: string; fields: Record<string, string> }[]) => {
    await runHostResourcePassAsync({
      stateDir: dir,
      clock: fixedClock(Date.parse(nextTs)),
      readHeartbeats: async () => beats.map(({ host, fields }) => ({
        host,
        payload: Object.entries({ beat_ts: nextTs, ...fields }).map(([key, value]) => `${key}=${value}`).join("\n"),
      })),
      planOrigins: () => [],
      log: (step, row) => { if (step === "host_resource.janitor_pass") rows.push(row!); },
    });
  };
  return { dir, rows, beat, log, run };
}

const phases = (payload: Record<string, string>) => Object.entries(payload)
  .filter(([key]) => key.startsWith("janitor_phase_")).map(([, value]) => value);

test("W1-T12261 criterion 1: publish the latest Azure pass by phase and root, largest eight first", (t) => {
  const f = fixture(t);
  const path = f.log("host-cleanup.log", [
    "rmd-host-cleanup: / 77% -> 71% (38 MB reclaimed this pass)",
    "rmd-host-cleanup: reclaim-total tsx /retired-root: reclaimed 38 MB (39845888 bytes) in 99 entries",
    "rmd-host-cleanup: decision-report /var/log/receipt",
    "rmd-host-cleanup: retention idle 6 h, scratch 6 h, tsx 6 h (tiered)",
    "rmd-host-cleanup: / 71% -> 70% (1 MB reclaimed this pass)",
    ...Array.from({ length: 9 }, (_, index) =>
      `rmd-host-cleanup: reclaim-total tsx /tmp/cache: ${index}: reclaimed 0 MB (${index + 100} bytes) in ${index + 1} entries`),
    "rmd-host-cleanup: decision-report /var/log/receipt",
    "rmd-host-cleanup: retention idle 6 h, scratch 6 h, tsx 6 h (tiered)",
    "rmd-host-cleanup: / 70% -> 69% (3 MB reclaimed this pass)",
    "REMOVE /tmp/path-that-must-not-be-published",
  ]);
  const payload = f.beat({ RMD_JANITOR_LOGS: path });
  assert.equal(payload.janitor_last_ts, firstTs);
  assert.equal(payload.janitor_last_removed, "45");
  assert.equal(payload.janitor_last_freed_bytes, "936");
  assert.deepEqual(phases(payload), Array.from({ length: 8 }, (_, i) => `tsx|/tmp/cache: ${8 - i}|${9 - i}|${108 - i}`));
  assert.equal(Object.values(payload).some((value) => value.includes("path-that-must-not-be-published")), false);
});

test("W1-T12261 criterion 2: read current and older Mac janitor summaries and the Mac temp cleaner", (t) => {
  const f = fixture(t);
  const mac = f.log("janitor.log", [
    "2026-11-23T10:00:00 === janitor start: apply=1 age>=6h coverage-age>=6h free=23GiB ===",
    "2026-11-23T10:00:00 generated-cache: pruned tsx cache files=2 bytes=3456 kept-open=0 (older than 360 min): /private/tmp/tsx-501",
    "2026-11-23T10:00:00 === done: removed=4 removed-complete=yes reclaimed=16M reclaimed-scope=legacy free=23->24GiB ===",
    "2026-11-23T10:20:00 === janitor start: apply=1 age>=6h coverage-age>=6h free=24GiB ===",
  ], nextTs);
  const temp = f.log("tmp-reclaim.log", [
    "pruned tsx cache files=3 bytes=12345 kept-open=0 (older than 360 min): /private/tmp/tsx-501",
    "leftover stem=rmd-private-name removed=2 bytes=9012",
    "leftover stem=another-private-name removed=1 bytes=100",
    "2026-11-23T10:30:00Z Deleted: 1441 entries, 29 MB (free 12%, age window 360 min); risky retained=1",
    "tsx files pruned: 3, skipped caches=0; df avail 100 -> 200 KiB (delta 100 KiB)",
    "session scratch dirs deleted: 4, 3 MB (root /Users/agent/Remudero/.session-scratch; age window 360 min)",
    "session scratch files deleted: 1, 0 MB",
  ]);
  const current = f.beat({ RMD_JANITOR_LOGS: mac, TZ: "UTC" });
  assert.equal(current.janitor_last_ts, firstTs);
  assert.equal(current.janitor_last_before, "23GB");
  assert.equal(current.janitor_last_removed, "6");
  assert.equal(current.janitor_last_freed_bytes, String(16 * mib + 3456));
  assert.deepEqual(phases(current), ["tsx|/private/tmp/tsx-501|2|3456"]);

  const newest = f.beat({ RMD_JANITOR_LOGS: `${mac}:${temp}`, TZ: "UTC" });
  assert.equal(newest.janitor_log, temp);
  assert.equal(newest.janitor_last_ts, "2026-11-23T10:30:00Z");
  assert.equal(newest.janitor_last_removed, "1444");
  assert.equal(newest.janitor_last_freed_bytes, String(29 * mib + 12345));
  assert.deepEqual(phases(newest), [
    `temp|unknown|1441|${29 * mib}`,
    `session-dirs|/Users/agent/Remudero/.session-scratch|4|${3 * mib}`,
    "tsx|/private/tmp/tsx-501|3|12345",
    "leftovers|unknown|3|9112",
    "session-files|/Users/agent/Remudero/.session-scratch|1|0",
  ]);

  const legacy = f.log("remudero-janitor-mini.log", ["janitor (mini): freed ~0 GB; free space 25 GB -> 10 GB"]);
  const older = f.beat({ RMD_JANITOR_LOGS: legacy });
  assert.equal(older.janitor_last_freed, "0GB");
  assert.equal(older.janitor_last_freed_bytes, "0");
  assert.equal(older.janitor_last_removed, "unknown");
});

test("W1-T12261 criterion 3: the async gardener records the pass and its exact measurements for each host", async (t) => {
  const f = fixture(t);
  const azure = f.beat({ RMD_JANITOR_LOGS: f.log("host-cleanup.log", [
    "rmd-host-cleanup: / 77% -> 71% (3784 MB reclaimed this pass)",
    "rmd-host-cleanup: reclaim-total tsx /tmp/tsx-1000: reclaimed 171 MB (179965952 bytes) in 1 entries",
  ]) });
  await f.run({ host: "azure", fields: azure }, { host: "mini", fields: azure });
  assert.deepEqual(f.rows, ["azure", "mini"].map((host) => ({
    host, janitor_ts: firstTs, freed_bytes: 179965952, entries_removed: 1,
    phases: [{ phase: "tsx", root: "/tmp/tsx-1000", entries_removed: 1, freed_bytes: 179965952 }],
  })));
});

test("W1-T12261 criterion 4: duplicate and out-of-order passes stay deduplicated across restart", async (t) => {
  const f = fixture(t);
  const fields = { janitor_last_ts: firstTs, janitor_last_removed: "0", janitor_last_freed_bytes: "0" };
  await Promise.all([f.run({ host: "azure", fields }), f.run({ host: "azure", fields })]);
  assert.equal(JSON.parse(readFileSync(hostResourceStatePath(f.dir), "utf8")).janitorPasses.azure, firstTs);
  await f.run({ host: "azure", fields: { ...fields, beat_ts: "2026-11-23T11:01:00Z" } });
  await f.run({ host: "azure", fields: { ...fields, janitor_last_ts: nextTs } });
  await f.run({ host: "azure", fields });
  assert.deepEqual(f.rows.map((row) => row.janitor_ts), [firstTs, nextTs]);
});

test("W1-T12261 criterion 5: absent results write no row and unreadable fields stay distinct from zero", async (t) => {
  const f = fixture(t);
  const path = f.log("tmp-reclaim.log", [
    "2026-11-23T10:00:00Z Would delete: 9 entries, 1 MB",
    "2026-11-23T10:00:01Z Deleted: 8 entries, 1 MB (free 12%, age window 360 min); risky retained=1",
  ]);
  const absent = f.beat({ RMD_JANITOR_LOGS: path });
  await f.run({ host: "mini", fields: absent });
  assert.equal(absent.janitor_last_ts, "unknown");
  assert.deepEqual(f.rows, []);

  appendFileSync(path, "2026-11-23T11:00:00Z Deleted: unreadable entries, 2 MB\ntsx files pruned: 0\n");
  const partial = f.beat({ RMD_JANITOR_LOGS: path });
  assert.equal(partial.janitor_last_removed, "unknown");
  await f.run({ host: "mini", fields: partial });
  assert.deepEqual(f.rows, [{
    host: "mini", janitor_ts: nextTs, freed_bytes: 2 * mib, entries_removed: "unreadable",
    phases: [
      { phase: "temp", root: "unknown", entries_removed: "unreadable", freed_bytes: 2 * mib },
      { phase: "tsx", root: "unknown", entries_removed: 0, freed_bytes: 0 },
    ],
  }]);
});
