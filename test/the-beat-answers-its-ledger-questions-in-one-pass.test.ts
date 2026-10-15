/**
 * THE BEAT ANSWERS ITS THREE LEDGER QUESTIONS IN ONE NEWEST-FIRST PASS, AND STOPS.
 *
 * `scripts/fleet-heartbeat.sh` used to run `zgrep` over the WHOLE ledger union three times a beat:
 * once for the newest `daemon.*` ts, once for the step on that ts, once for the boot line. OBSERVED
 * 2026-10-15 on the Azure host: 356 gzip rotations, ~240 MB compressed, ~2 GB of text per pass, and
 * cron reading 4-4.9 MB/s from a data disk near its IOPS cap every five minutes.
 *
 * TWO CLAIMS, EACH WITH ITS FALSIFIER:
 *  1. SAME ANSWERS. The beat publishes byte-identical `daemon_last_*` and `daemon_boot_*` fields to
 *     the three-pass read it replaces — run here as a MUTANT that splices the old code back in, on
 *     the same live + plain + gzipped fixture.
 *  2. IT STOPS. Once every answer is final it opens no older rotation. Proven two ways: a recording
 *     `gzip` on PATH lists the archives actually decompressed, and a SENTINEL row planted in an
 *     older rotation (stamped later than that rotation was cut, which rotation never writes) would
 *     change the published answer if that file were ever read. The three-pass mutant and a mutant
 *     with the stop rule disabled both read it — so both assertions discriminate.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { test } from "node:test";
import { runBeat, type Beat } from "./helpers/fleet-heartbeat-harness.js";

// The script computes age from a REAL `date -u`; the fixture reads the same clock (see the note on
// NOW in test/fleet-heartbeat.test.ts) so a clock-shifted run cannot skew one side.
const NOW = new Date(String(spawnSync("date", ["-u", "+%Y-%m-%dT%H:%M:%S.000Z"]).stdout).trim());
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();
/** The name `rotateLedger` gives an archive cut `msAgo` ago (`datedArchivePath`). */
const rotation = (msAgo: number, gz: boolean): string =>
  `ledger.${iso(msAgo).replace(/[:.]/g, "-")}.ndjson${gz ? ".gz" : ""}`;
const row = (ts: string, step: string, extra: Record<string, string> = {}): string =>
  JSON.stringify({ ts, run_id: "DAEMON-1", task_id: "DAEMON", step, ...extra });

const NEWEST_GZ = rotation(60 * MIN, true);
const PLAIN = rotation(90 * MIN, false);
const OLDER_GZ = rotation(180 * MIN, true);
const OLDEST_GZ = rotation(300 * MIN, true);

/** A union where every form holds something and the answers come from different files. */
const LIVE = [
  row(iso(30 * 24 * 60 * MIN), "daemon.headroom_reserve.escalated"),
  row(iso(10 * MIN), "daemon.boot", { head_sha: "1111111111111111111111111111111111111111" }),
  row(iso(30_000), "daemon.alive"),
  row(iso(5_000), "run.start"),
];
const ROTATIONS: Record<string, string[]> = {
  [NEWEST_GZ]: [
    row(iso(120 * MIN), "daemon.boot", { head_sha: "2222222222222222222222222222222222222222" }),
    row(iso(70 * MIN), "daemon.poll"),
  ],
  [PLAIN]: [row(iso(100 * MIN), "daemon.iteration")],
  [OLDER_GZ]: [
    row(iso(240 * MIN), "daemon.boot", { head_sha: "3333333333333333333333333333333333333333" }),
    row(iso(210 * MIN), "daemon.poll"),
  ],
  [OLDEST_GZ]: [row(iso(360 * MIN), "daemon.poll")],
};

/** The read this change replaces, verbatim in behaviour: three `zgrep` passes over the union. */
const THREE_PASS = String.raw`  LEDGER_UNION_GLOB="$\{RMD_ROOT}/state/ledger.ndjson $\{RMD_ROOT}/state/ledger.*.ndjson $\{RMD_ROOT}/state/ledger.*.ndjson.gz"
  ledger_union_grep() {
    zgrep -h "$1" $LEDGER_UNION_GLOB 2>/dev/null
  }
  DAEMON_LAST_TS="$(ledger_union_grep '"step":"daemon\.' \
    | sed -n 's/^{"ts":"\([^"]*\)".*/\1/p' | sort | tail -n 1)"
  if [ -n "$DAEMON_LAST_TS" ]; then
    DAEMON_LAST_STEP="$(ledger_union_grep "\"ts\":\"$\{DAEMON_LAST_TS}\"" \
      | grep -o '"step":"daemon\.[^"]*"' | tail -n 1 | cut -d'"' -f4)"
  fi
  BOOT_LINE="$(ledger_union_grep '"step":"daemon.boot"' | tail -n 1)"`.replaceAll("$\\{", "${");

/** The one-pass read's hand-off into the script, which the mutant replaces. */
const ONE_PASS = String.raw`  BOOT_LINE=""
  while IFS= read -r _answer; do
    case "$_answer" in
      T=*) DAEMON_LAST_TS="$\{_answer#T=}" ;;
      S=*) DAEMON_LAST_STEP="$\{_answer#S=}" ;;
      B=*) BOOT_LINE="$\{_answer#B=}" ;;
    esac
  done <<LEDGER_ANSWERS
$(ledger_union_answers)
LEDGER_ANSWERS`.replaceAll("$\\{", "${");

const ANSWER_FIELDS = ["daemon_last_ts", "daemon_last_step", "daemon_boot_ts", "daemon_boot_head_sha"] as const;

function field(published: string, key: string): string | undefined {
  const line = published.split("\n").find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}
const answers = (beat: Beat): Record<string, string | undefined> =>
  Object.fromEntries(ANSWER_FIELDS.map((k) => [k, field(beat.published, k)]));
const opened = (beat: Beat): string[] => beat.gzipCalls.map((p) => basename(p));

test("one pass publishes the SAME four ledger answers as the three-pass union read it replaces", () => {
  const fixture = {
    ledger: LIVE,
    // A name `rotationStampIso` cannot read bounds nothing, so it is always read; it rides along here.
    rotations: { ...ROTATIONS, "ledger.unstamped.ndjson.gz": [row(iso(400 * MIN), "daemon.poll")] },
  };
  const one = runBeat(fixture);
  const three = runBeat({ ...fixture, mutate: [ONE_PASS, THREE_PASS] });
  assert.equal(one.status, 0, one.stderr);
  assert.equal(three.status, 0, three.stderr);
  assert.deepEqual(answers(one), answers(three), "every published ledger answer is unchanged");
  // Not vacuous: each answer is real, and they come from different files.
  assert.equal(field(one.published, "daemon_last_ts"), iso(30_000));
  assert.equal(field(one.published, "daemon_last_step"), "daemon.alive");
  // The boot is the LAST one in union order, i.e. the newest archive's, exactly as `tail -n 1` had it.
  assert.equal(field(one.published, "daemon_boot_head_sha"), "2222222222222222222222222222222222222222");
});

test("with nothing to find, a zero is still a zero: absent answers read `none` in both reads", () => {
  const fixture = {
    ledger: [row(iso(5_000), "run.start")],
    rotations: { [NEWEST_GZ]: [row(iso(70 * MIN), "pr.opened")], [OLDEST_GZ]: [row(iso(360 * MIN), "pr.opened")] },
    recordGzip: true,
  };
  const one = runBeat(fixture);
  const three = runBeat({ ...fixture, mutate: [ONE_PASS, THREE_PASS] });
  assert.deepEqual(answers(one), answers(three));
  for (const k of ANSWER_FIELDS) assert.equal(field(one.published, k), "none", `${k} must read none`);
  assert.equal(field(one.published, "daemon_last_age_s"), "unknown");
  // "none" is only honest if every rotation was searched — nothing found must not mean "stopped looking".
  assert.deepEqual(opened(one).sort(), [NEWEST_GZ, OLDEST_GZ].sort(), "an absent answer is searched for in every archive");
});

test("an answer that exists only in the OLDEST archive is still found — it keeps looking until it is final", () => {
  const beat = runBeat({
    ledger: [row(iso(30_000), "daemon.alive")],
    rotations: {
      [NEWEST_GZ]: [row(iso(70 * MIN), "daemon.poll")],
      [OLDEST_GZ]: [row(iso(360 * MIN), "daemon.boot", { head_sha: "4444444444444444444444444444444444444444" })],
    },
    recordGzip: true,
  });
  assert.equal(field(beat.published, "daemon_boot_head_sha"), "4444444444444444444444444444444444444444");
  assert.equal(field(beat.published, "daemon_last_ts"), iso(30_000));
  assert.deepEqual(opened(beat), [NEWEST_GZ, OLDEST_GZ], "newest first, down to the archive holding the boot");
});

// ── IT STOPS ────────────────────────────────────────────────────────────────────────────────────
// The SENTINEL is a `daemon.*` row stamped NOW, planted in archives cut an hour and more ago. Real
// rotation never writes one (an archive's stamp is at or after every row in it), so it cannot
// change a correct early stop; it changes the published answer only if that file is READ.
const SENTINEL = row(iso(1_000), "daemon.sentinel_read_from_an_older_rotation");
const STOP_FIXTURE = {
  ledger: LIVE,
  rotations: {
    [NEWEST_GZ]: ROTATIONS[NEWEST_GZ]!,
    [PLAIN]: [...ROTATIONS[PLAIN]!, SENTINEL],
    [OLDER_GZ]: [...ROTATIONS[OLDER_GZ]!, SENTINEL],
    [OLDEST_GZ]: [...ROTATIONS[OLDEST_GZ]!, SENTINEL],
  },
  recordGzip: true,
};

test("once every answer is final, no older rotation is opened — only the newest archive is decompressed", () => {
  const beat = runBeat(STOP_FIXTURE);
  assert.equal(beat.status, 0, beat.stderr);
  assert.deepEqual(opened(beat), [NEWEST_GZ], "the newest archive settles the boot; nothing older is decompressed");
  assert.equal(field(beat.published, "daemon_last_ts"), iso(30_000), "no sentinel was read, from the plain rotation either");
  assert.equal(field(beat.published, "daemon_last_step"), "daemon.alive");
  assert.equal(field(beat.published, "daemon_boot_head_sha"), "2222222222222222222222222222222222222222");
});

test("MUTANT: the three-pass read opens EVERY rotation, three times — the stop assertion discriminates", () => {
  const beat = runBeat({ ...STOP_FIXTURE, mutate: [ONE_PASS, THREE_PASS] });
  for (const name of [NEWEST_GZ, OLDER_GZ, OLDEST_GZ]) {
    assert.equal(opened(beat).filter((n) => n === name).length, 3, `the three-pass read decompresses ${name} once per pass`);
  }
  assert.equal(field(beat.published, "daemon_last_step"), "daemon.sentinel_read_from_an_older_rotation");
});

test("MUTANT: a pass with its stop rule disabled reads the older rotations and is caught", () => {
  const beat = runBeat({
    ...STOP_FIXTURE,
    mutate: [
      `if (wantQ && haveMax && st[i] != "~" && st[i] < substr(max, 1, 19)) wantQ = 0`,
      `if (0) wantQ = 0`,
    ],
  });
  assert.deepEqual(opened(beat), [NEWEST_GZ, OLDER_GZ, OLDEST_GZ]);
  assert.equal(field(beat.published, "daemon_last_ts"), iso(1_000), "the sentinel surfaces once older files are read");
});
