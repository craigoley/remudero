/**
 * `scripts/fleet-heartbeat.sh` — THE LAST UNTESTED SHELL CHECKER, AND THE ONE THAT HAS NEVER RUN.
 *
 * WHY THIS FILE EXISTS. All 17 JS/TS checkers in this repo ship with a committed test that hands
 * them a deliberately broken subject and asserts a non-zero exit. All four SHELL checkers shipped
 * with none — and every one that has since been given a test turned out to have a defect:
 * `verify-image.sh` (an apostrophe in a COMMENT truncated a `docker run` argument, so three checks
 * executed on the HOST), `host-update.sh` (`RepoDigests` is empty for a locally-built image, so
 * "no digest" read as "no image"), `entrypoint.sh` (the git identity write sat below a block that
 * `exec`s and never returns — found BY the test, not by reading). This script has the weakest
 * evidence of the four: it was validated against fixtures and a throwaway bare repo, and the Mac
 * mini has been down since it was written, so it has never executed on the machine it reports on.
 *
 * THE SHAPE IS THE PROVEN ONE, mirrored from those three: stub the binaries on PATH, run the REAL
 * script, assert on a recording. ONE difference worth stating rather than copying blindly — #1519
 * used a single SHARED call log because its ordering claims spanned two executables (`docker` and
 * `az`). Every claim here is about `git` alone, so a single-binary log is sufficient; the shared
 * format is kept for consistency, not because the reason applies.
 *
 * THE SUBJECT IS THE COMMITTED SCRIPT, ASSERTED BYTE-FOR-BYTE. The fixture copies the file so it
 * can control `INSTALL_DIR` (derived from `BASH_SOURCE`) and so the mutants have something to
 * mutate — but a copy that had drifted would make every result meaningless, so equality with the
 * real file is checked on every run.
 *
 * EVERY GUARD BELOW HAS A MUTANT. A test that only passes on the current script proves nothing
 * about the next edit, so each behaviour is re-run against a copy with that one behaviour broken,
 * and the guard must fail. The substitution target is asserted UNIQUE before each mutation.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_SCRIPT = join(REPO_ROOT, "scripts", "fleet-heartbeat.sh");

interface Call {
  bin: string;
  argv: string[];
}

interface Beat {
  status: number;
  stdout: string;
  stderr: string;
  /** Every stubbed `git` invocation, in order. */
  calls: Call[];
  /** The payload piped to `git hash-object` — the bytes actually PUBLISHED, not the dry-run print. */
  published: string;
  /** The tree entry piped to `git mktree`. */
  treeInput: string;
}

/**
 * A `git` that records argv and answers the five subcommands this script reaches.
 *
 * It CAPTURES STDIN for `hash-object` and `mktree`, which is the point: asserting the dry-run
 * printout would prove nothing about what gets committed. `hash-object`'s stdin is the payload the
 * beat actually publishes.
 */
function gitStub(): string {
  return [
    "#!/usr/bin/env bash",
    'rec() { printf "%s" "git" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"; }',
    'rec "$@"',
    "args=(\"$@\"); i=0",
    'while [ "${args[$i]}" = "-C" ]; do i=$((i+2)); done',
    'sub="${args[$i]}"',
    'case "$sub" in',
    '  rev-parse)    printf "abc1234\\n" ;;',
    '  hash-object)  cat > "$STUB_REC/payload"; printf "1111111111111111111111111111111111111111\\n" ;;',
    '  mktree)       cat > "$STUB_REC/treeinput"; printf "2222222222222222222222222222222222222222\\n" ;;',
    '  commit-tree)  printf "3333333333333333333333333333333333333333\\n" ;;',
    '  push)         : ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

interface BeatOpts {
  /** Lines written to the ledger, verbatim. */
  ledger?: string[];
  /** Install a working `node_modules/.bin/tsx`. Default true. */
  tsx?: boolean;
  /** Seed a previous-beat state file so `since_prev_beat_s` is computable. Default true. */
  prevBeat?: boolean;
  env?: Record<string, string>;
  /** A `date` to put on PATH ahead of the real one, for the BSD-branch tests. */
  dateStub?: string;
  /**
   * A container-runtime stub reached through `RMD_HEARTBEAT_DOCKER` (W1-T483). Written to the stub
   * bin dir and named EXPLICITLY rather than shadowing `docker` on PATH, because this host really
   * has `/usr/bin/docker` and a stub placed earlier on PATH would still be found by
   * `command -v docker` — so the no-runtime branch could never be reached by shadowing. Omit it and
   * the script is pointed at a path that does not exist, which is the no-runtime case.
   */
  dockerStub?: string;
  /** A `hostname` to put on PATH, so `beat_host` can be asserted against a known answer. */
  hostnameStub?: string;
  /**
   * W1-T2767: a `df` to put on PATH, so the per-device headroom rows can be driven to a KNOWN
   * two-device answer. Omit it and the REAL `df` runs — which is deliberate for the real-leaf
   * test below: a suite where every reading is faked never executes the default path at all,
   * and the whole point of this task is that the real reading was measuring the wrong device.
   */
  dfStub?: string;
  /** Applied to the copied script as [find, replace], with `find` asserted UNIQUE. */
  mutate?: [string, string];
}

function runBeat(opts: BeatOpts = {}): Beat {
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-"));
  const rec = mkdtempSync(join(tmpdir(), "fleet-heartbeat-rec-"));
  const binDir = join(dir, "stubbin");
  const scriptsDir = join(dir, "scripts");
  const root = join(dir, "root");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });

  // THE SUBJECT IS THE COMMITTED FILE. Copied only so INSTALL_DIR is controllable and mutants have
  // something to edit; equality is asserted below so a drifted copy cannot quietly pass.
  const real = readFileSync(REAL_SCRIPT, "utf8");
  let source = real;
  if (opts.mutate) {
    const [find, replace] = opts.mutate;
    const n = source.split(find).length - 1;
    assert.equal(n, 1, `mutation target must be UNIQUE in the script, found ${n}: ${find}`);
    source = source.replace(find, replace);
    assert.notEqual(source, real, "the mutation must actually change the script");
  } else {
    assert.equal(source, real, "the unmutated subject must be byte-identical to the committed script");
  }
  const scriptPath = join(scriptsDir, "fleet-heartbeat.sh");
  writeFileSync(scriptPath, source, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);

  if (opts.tsx !== false) {
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "tsx"), "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(join(dir, "node_modules", ".bin", "tsx"), 0o755);
  }
  if (opts.ledger) writeFileSync(join(root, "state", "ledger.ndjson"), opts.ledger.join("\n") + "\n");
  if (opts.prevBeat !== false) {
    writeFileSync(join(root, "state", "heartbeat-last.txt"), "2020-01-01T00:00:00Z\n");
  }

  writeFileSync(join(binDir, "git"), gitStub(), { mode: 0o755 });
  chmodSync(join(binDir, "git"), 0o755);
  if (opts.dateStub) {
    writeFileSync(join(binDir, "date"), opts.dateStub, { mode: 0o755 });
    chmodSync(join(binDir, "date"), 0o755);
  }
  if (opts.hostnameStub) {
    writeFileSync(join(binDir, "hostname"), opts.hostnameStub, { mode: 0o755 });
    chmodSync(join(binDir, "hostname"), 0o755);
  }
  if (opts.dfStub) {
    writeFileSync(join(binDir, "df"), opts.dfStub, { mode: 0o755 });
    chmodSync(join(binDir, "df"), 0o755);
  }
  // DEFAULT TO A RUNTIME THAT DOES NOT EXIST. Every pre-W1-T483 test predates the restart-budget
  // probe and must keep asserting exactly what it asserted; pointing the probe at a missing binary
  // gives them the absent-fields shape rather than whatever this machine's real docker happens to
  // answer, so no existing expectation depends on the host.
  const dockerPath = join(binDir, "rt-stub");
  if (opts.dockerStub) {
    writeFileSync(dockerPath, opts.dockerStub, { mode: 0o755 });
    chmodSync(dockerPath, 0o755);
  }

  const r = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: join(dir, "home"),
      RMD_ROOT: root,
      STUB_REC: rec,
      RMD_HEARTBEAT_DOCKER: opts.dockerStub ? dockerPath : join(binDir, "no-such-runtime"),
      ...(opts.env ?? {}),
    },
  });

  const read = (f: string): string => {
    try {
      return readFileSync(join(rec, f), "utf8");
    } catch {
      return "";
    }
  };
  const calls = read("calls")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [bin, ...argv] = l.split("\t");
      return { bin, argv };
    });
  const beat: Beat = {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    calls,
    published: read("payload"),
    treeInput: read("treeinput"),
  };
  rmSync(dir, { recursive: true, force: true });
  rmSync(rec, { recursive: true, force: true });
  return beat;
}

/** `key=value` lookup over a published payload. */
function field(payload: string, key: string): string | undefined {
  const line = payload.split("\n").find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

/** The git subcommand of a recorded call, skipping `-C <dir>`. */
function sub(call: Call): string {
  let i = 0;
  while (call.argv[i] === "-C") i += 2;
  return call.argv[i] ?? "";
}

// `fleet-heartbeat.sh` runs as a REAL bash subprocess (`spawnSync("bash", ...)`, `runBeat` below)
// and computes its own "now" through a REAL `date -u` call (`epoch_of`'s GNU/BSD branches, and
// every stub above that falls through to the platform `date` binary) — a syscall the probe
// cannot reach, since `scripts/clock-shift.mjs` monkeypatches only THIS process's global `Date`,
// never a child process's. Building these fixtures from `new Date()` under a shift stamped every
// ledger row's `ts` days into the FUTURE relative to the script's own real clock, so
// `now_epoch - epoch_of(ts)` went NEGATIVE (measured: `-604739` at +7d) instead of a real age —
// the ledger-`ts`-vs-reader-clock mismatch #2250 fixed, except here the reader is a subprocess no
// injected JS clock can shift at all. Deriving NOW from the SAME real `date -u` the script itself
// calls keeps the fixture's clock and the subject's clock the same one, regardless of shift.
const NOW = new Date(String(spawnSync("date", ["-u", "+%Y-%m-%dT%H:%M:%S.000Z"]).stdout).trim());
// MILLISECONDS ARE KEPT. `appendLedger` writes `new Date().toISOString()`, so every real ledger
// ts looks like `2026-07-20T08:20:00.000Z`. A fixture that stripped them would exercise a format
// the script never actually meets — and the BSD branch of `epoch_of` exists precisely because
// `date -j -f` cannot read a fraction or the trailing Z.
const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();

/** A ledger whose newest `daemon.`-prefixed line is NOT the last line and NOT the newest line. */
const MIXED_LEDGER = [
  `{"ts":"${iso(9 * 60_000)}","step":"daemon.iteration","note":"older daemon line"}`,
  // The NEWEST daemon line, deliberately NOT last in the file.
  `{"ts":"${iso(60_000)}","step":"daemon.idle","note":"newest daemon line"}`,
  // NEWER than every daemon line, but NOT a daemon step — must be ignored.
  `{"ts":"${iso(0)}","step":"run.start","note":"not a daemon step"}`,
  // LAST in the file, but older than the newest daemon line — `sort | tail` must beat append order.
  `{"ts":"${iso(5 * 60_000)}","step":"daemon.headroom","note":"last line, not newest"}`,
];

test("bash -n: the committed script parses", () => {
  const r = spawnSync("bash", ["-n", REAL_SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("a beat publishes via git PLUMBING only — no porcelain, so a live checkout is never dirtied", () => {
  const beat = runBeat({ ledger: MIXED_LEDGER });
  assert.equal(beat.status, 0, `${beat.stdout}\n${beat.stderr}`);

  const subs = beat.calls.map(sub);
  assert.ok(beat.calls.length > 0, "the fixture must reach git at all");
  for (const s of ["hash-object", "mktree", "commit-tree", "push"]) {
    assert.ok(subs.includes(s), `the publish path must use ${s}, saw: ${subs.join(", ")}`);
  }
  // THE LOAD-BEARING NEGATIVE. `checkCliFreshness` refuses verbs on a dirty checkout, and the
  // launchd daemon loads its code from the operator checkout — a heartbeat that ran `git add` or
  // `git commit` would break the fleet it exists to watch. `commit-tree` is deliberately NOT in
  // this list and must not be confused with `commit`: the comparison is on exact tokens.
  for (const forbidden of ["add", "commit", "checkout", "switch", "reset", "stash", "merge", "rebase"]) {
    assert.ok(!subs.includes(forbidden), `porcelain '${forbidden}' must never be used, saw: ${subs.join(", ")}`);
  }
  // The tree names the payload file, so the branch is readable as a file rather than a bare message.
  assert.match(beat.treeInput, /heartbeat\.txt/, "the tree must carry heartbeat.txt");
});

test("each beat is a PARENTLESS root commit, so the branch stays one commit and never grows", () => {
  const beat = runBeat({ ledger: MIXED_LEDGER });
  const commitTree = beat.calls.find((c) => sub(c) === "commit-tree");
  assert.ok(commitTree, "fixture must reach commit-tree");
  assert.ok(
    !commitTree!.argv.includes("-p"),
    `commit-tree must take NO parent, argv was: ${commitTree!.argv.join(" ")}`,
  );
  const push = beat.calls.find((c) => sub(c) === "push");
  assert.ok(push!.argv.includes("--force"), "the beat is force-pushed over the branch");
});

test("daemon liveness is the MAX ts over daemon.-prefixed steps — not the last line, not another step", () => {
  // MIRRORS `deriveLastPoll` rather than inventing a second rule. The fixture is built so that all
  // three wrong answers are distinguishable: the last LINE is older, the newest LINE is not a
  // daemon step, and only a MAX over the prefix picks the right one.
  const beat = runBeat({ ledger: MIXED_LEDGER });
  assert.equal(field(beat.published, "daemon_last_ts"), iso(60_000), "the newest daemon. line wins");
  assert.equal(field(beat.published, "daemon_last_step"), "daemon.idle");
  assert.equal(field(beat.published, "daemon_verdict"), "live");
});

test("the beat carries since_prev_beat_s, so the watcher threshold can be fitted to data later", () => {
  // The 30-minute watcher threshold is 6x the 5-minute cadence, chosen on an UNMEASURED
  // distribution. A force-pushed single-commit branch keeps no history of its own, so this field is
  // the ONLY record of the observed gap — a beat without it silently forecloses ever fitting it.
  const beat = runBeat({ ledger: MIXED_LEDGER });
  const v = field(beat.published, "since_prev_beat_s");
  assert.ok(v !== undefined && v !== "" && v !== "unknown", `since_prev_beat_s must be present and real, got ${v}`);
  assert.match(v!, /^\d+$/, "and a number of seconds");
});

test("a BROKEN INSTALL is reported as broken WHILE still carrying daemon liveness — the case the design turns on", () => {
  // THE THIRD CASE, and the reason this script is bash rather than an rmd verb: an emptied
  // node_modules kills every verb and the launchd supervisor while the already-running daemon keeps
  // serving from resident memory. A verb-based heartbeat goes SILENT here and reads as a power cut.
  const beat = runBeat({ ledger: MIXED_LEDGER, tsx: false });
  assert.equal(beat.status, 0, "a broken install still publishes a beat — the verdict rides in the payload");
  assert.equal(field(beat.published, "tsx_present"), "no");
  assert.match(field(beat.published, "rmd_verdict") ?? "", /^BROKEN/, "the install is named broken");
  assert.equal(
    field(beat.published, "daemon_verdict"),
    "live",
    "and daemon liveness is STILL carried — a broken install must not be mistaken for a dead daemon",
  );
  assert.match(beat.stdout, /rmd BROKEN/, "the subject line separates the two failures for a phone");
});

test("RMD_HEARTBEAT_DRY_RUN=1 prints and exits without touching the remote", () => {
  const beat = runBeat({ ledger: MIXED_LEDGER, env: { RMD_HEARTBEAT_DRY_RUN: "1" } });
  assert.equal(beat.status, 0);
  assert.match(beat.stdout, /beat_ts=/, "it prints the payload");
  assert.equal(beat.calls.filter((c) => sub(c) === "push").length, 0, "and pushes NOTHING");
  assert.equal(beat.calls.filter((c) => sub(c) === "commit-tree").length, 0, "and builds no commit");
});

// ── MUTANTS: each guard above is re-run against a script with that behaviour broken ───────────

test("MUTANT: a commit-tree that takes a parent is caught", () => {
  const beat = runBeat({
    ledger: MIXED_LEDGER,
    mutate: ['commit-tree "$tree" -m "$SUBJECT"', 'commit-tree -p "$tree" "$tree" -m "$SUBJECT"'],
  });
  const commitTree = beat.calls.find((c) => sub(c) === "commit-tree");
  assert.ok(commitTree!.argv.includes("-p"), "the mutant must actually pass a parent");
});

test("MUTANT: keying liveness on ONE daemon step instead of the prefix is caught", () => {
  // The defect the design explicitly avoided — `runDaemon` has no single step that fires every
  // tick, so a single-step rule reports a stale or absent poll on a perfectly live daemon.
  const beat = runBeat({
    ledger: MIXED_LEDGER,
    mutate: [`grep '"step":"daemon\\.' "$LEDGER"`, `grep '"step":"daemon.iteration"' "$LEDGER"`],
  });
  assert.notEqual(
    field(beat.published, "daemon_last_ts"),
    iso(60_000),
    "a single-step rule must NOT still produce the max-over-prefix answer",
  );
  assert.equal(field(beat.published, "daemon_last_ts"), iso(9 * 60_000), "it reports the older iteration line");
});

test("MUTANT: taking the LAST daemon line instead of the max is caught", () => {
  // W1-T2349's deploy-supervisor probe mirrors this exact grep/sed/sort/tail idiom for the
  // `deploy.` prefix, so the bare sed/sort/tail fragment alone is no longer unique in the script —
  // the find string below anchors on the preceding `daemon\.` grep clause to stay unique to THIS
  // block, byte-for-byte as the committed script has it.
  const beat = runBeat({
    ledger: MIXED_LEDGER,
    mutate: [
      `grep '"step":"daemon\\.' "$LEDGER" 2>/dev/null \\\n    | sed -n 's/^{"ts":"\\([^"]*\\)".*/\\1/p' | sort | tail -n 1`,
      `grep '"step":"daemon\\.' "$LEDGER" 2>/dev/null \\\n    | sed -n 's/^{"ts":"\\([^"]*\\)".*/\\1/p' | tail -n 1`,
    ],
  });
  assert.equal(
    field(beat.published, "daemon_last_ts"),
    iso(5 * 60_000),
    "without the sort it takes the last APPENDED daemon line, which is not the newest",
  );
});

test("MUTANT: dropping since_prev_beat_s is caught", () => {
  const beat = runBeat({
    ledger: MIXED_LEDGER,
    mutate: ["since_prev_beat_s=${SINCE_PREV_S:-unknown}\n", ""],
  });
  assert.equal(field(beat.published, "since_prev_beat_s"), undefined, "the mutant must really drop the field");
});

test("MUTANT: a heartbeat that cannot tell a broken install from a healthy one is caught", () => {
  const beat = runBeat({
    ledger: MIXED_LEDGER,
    tsx: false,
    mutate: ['if [ -x "$TSX_PATH" ]; then TSX_PRESENT="yes"; else TSX_PRESENT="no"; fi', 'TSX_PRESENT="yes"'],
  });
  assert.equal(field(beat.published, "tsx_present"), "yes", "the mutant reports a broken install as healthy");
  assert.equal(field(beat.published, "rmd_verdict"), "ok", "and its verdict is wrong");
});

test("MUTANT: a dry run that still pushes is caught", () => {
  const beat = runBeat({
    ledger: MIXED_LEDGER,
    env: { RMD_HEARTBEAT_DRY_RUN: "1" },
    mutate: ['if [ "${RMD_HEARTBEAT_DRY_RUN:-}" = "1" ]; then', 'if [ "${RMD_HEARTBEAT_DRY_RUN:-}" = "never" ]; then'],
  });
  assert.equal(beat.calls.filter((c) => sub(c) === "push").length, 1, "the mutant pushes despite the dry-run flag");
});

// ── THE BRANCH THAT WILL ACTUALLY RUN ON THE MINI, AND HAS NEVER RUN ANYWHERE ─────────────────
// `epoch_of` tries GNU `date -u -d` first and falls back to BSD `date -u -j -f`. Every test above
// runs on Linux, so every one of them takes the GNU branch. The mini is macOS — it takes the OTHER
// branch, and the mini has been down since this script was written. These two tests are the only
// exercise that branch has ever had.

/** A `date` that behaves like BSD/macOS: `-d` is rejected, `-j -f` parses. */
const BSD_DATE = [
  "#!/usr/bin/env bash",
  "# BSD date: -d is not a parse flag and fails; -j -f is the parser.",
  "# ABSOLUTE PATH, never `env date`: this dir is FIRST on PATH, so resolving through PATH",
  "# re-execs this stub forever. That hung the suite twice before it was caught.",
  'for a in "$@"; do [ "$a" = "-d" ] && exit 1; done',
  'if [ "$1" = "-u" ] && [ "$2" = "-j" ] && [ "$3" = "-f" ]; then',
  '  exec /usr/bin/date -u -d "$5" "$6"',
  "fi",
  'exec /usr/bin/date "$@"',
  "",
].join("\n");

test("the BSD/macOS branch of epoch_of computes the SAME age the GNU branch does", () => {
  const gnu = runBeat({ ledger: MIXED_LEDGER });
  const bsd = runBeat({ ledger: MIXED_LEDGER, dateStub: BSD_DATE });
  assert.equal(bsd.status, 0, `${bsd.stdout}\n${bsd.stderr}`);
  assert.equal(field(bsd.published, "daemon_verdict"), "live", "the mini must reach the same verdict");
  assert.equal(
    field(bsd.published, "daemon_last_ts"),
    field(gnu.published, "daemon_last_ts"),
    "and read the same timestamp",
  );
  // The ages are computed a second apart at worst; equality of the VERDICT is the claim, and the
  // age must be a real number rather than the `unknown` an unparsed timestamp would produce.
  assert.match(field(bsd.published, "daemon_last_age_s") ?? "", /^\d+$/, "the BSD branch must parse, not give up");
});

test("FINDING: a `date` that ACCEPTS -d but ignores it makes every beat report a dead daemon as live", () => {
  // `epoch_of` probes GNU first and treats a ZERO EXIT as a correct parse. That is safe only if a
  // non-GNU `date` FAILS on `-d`. If any `date` on the PATH accepts `-d` and ignores its argument —
  // returning the CURRENT time — then every timestamp resolves to now, every age is 0, and every
  // beat reports `live` no matter how dead the daemon is. That is precisely the "green light on a
  // dead fleet" the script's own header calls worse than no light at all.
  //
  // I CANNOT SETTLE WHETHER macOS's `date` DOES THIS — there is no Mac here and the mini is down.
  // This test does not assert that it does. It demonstrates the CONSEQUENCE if it does, so the
  // question is on the record with a concrete failure rather than as a worry.
  const IGNORES_D = [
    "#!/usr/bin/env bash",
    "# A `date` that accepts -d and ignores it, returning NOW — the unsafe-but-plausible variant.",
    'for a in "$@"; do if [ "$a" = "-d" ]; then exec /usr/bin/date -u +%s; fi; done',
    'exec /usr/bin/date "$@"',
    "",
  ].join("\n");
  const stale = [`{"ts":"${iso(72 * 3600_000)}","step":"daemon.idle","note":"three days old"}`];

  const honest = runBeat({ ledger: stale });
  assert.match(field(honest.published, "daemon_verdict") ?? "", /^STALE/, "a three-day-old poll IS stale");

  const lying = runBeat({ ledger: stale, dateStub: IGNORES_D });
  // NOW_EPOCH is captured BEFORE epoch_of(DAEMON_LAST_TS) runs (the script probes the CLI, reads
  // the ledger, etc. in between), so under this stub — where BOTH resolve to "the instant they
  // were called" — a whole second can legitimately tick over between the two calls, making the
  // age a small NEGATIVE number rather than exactly 0. The finding is that it is near-zero (NOT
  // the ~259200s a three-day-old timestamp would honestly report), not that it is exactly 0.
  const lyingAgeRaw = field(lying.published, "daemon_last_age_s") ?? "";
  const lyingAge = Number(lyingAgeRaw);
  assert.ok(
    Number.isFinite(lyingAge) && lyingAge <= 0 && lyingAge > -5,
    `every timestamp resolves to now, so the age should be ~0, got ${lyingAgeRaw}`,
  );
  assert.equal(
    field(lying.published, "daemon_verdict"),
    "live",
    "and a three-day-dead daemon is reported LIVE — the failure mode this records",
  );
});

// ── BUSY IS NOT DEAD: the `daemon.alive` in-dispatch liveness row ─────────────────────────────
// THE DEFECT THIS PAIR PINS. Every other `daemon.`-prefixed step is written when a tick CLOSES,
// so before `daemon.alive` existed the beat inferred liveness from WORK COMPLETION and a daemon
// inside a long dispatch was byte-identical to a dead one. MEASURED on the mini (live ledger +
// all 666 gzipped rotations, 898 `daemon.iteration` rows): the dispatch-to-next-`daemon.` window
// runs p75 21.2m / p90 39.5m, so 36.5% of dispatches already exceeded DAEMON_STALE_AFTER_S=600
// and read STALE while the fleet was working. Observed live: `rmd status` reported the daemon
// RUNNING with two runs in flight while this script published `daemon STALE`.
//
// THE SCRIPT IS UNCHANGED BY THAT FIX, AND THAT IS THE POINT — it already selects on the PREFIX,
// so a new `daemon.`-prefixed row corrects it, `deriveLastPoll`, and the console's
// GET /v1/daemon-health at once, with no threshold moved and no second liveness rule invented.
// These tests pin that contract from the reader's side so a future rename off the prefix is caught
// here and not in production.
//
// BOTH DIRECTIONS, DELIBERATELY PAIRED: a change that reported "live" unconditionally would pass
// the first test and is exactly what the second exists to catch.

/** A daemon that dispatched 21 minutes ago and is STILL INSIDE that dispatch — the live case. */
const MID_DISPATCH_LEDGER = [
  `{"ts":"${iso(9000 * 1000)}","step":"daemon.boot","head_sha":"0123456789abcdef0123456789abcdef01234567"}`,
  `{"ts":"${iso(21 * 60_000)}","step":"daemon.iteration","task":"W1-T409"}`,
  `{"ts":"${iso(20 * 60_000)}","step":"run.start","task_id":"W1-T409"}`,
  // The in-dispatch heartbeat: no tick has CLOSED, but the loop is demonstrably running.
  `{"ts":"${iso(30_000)}","step":"daemon.alive","phase":"dispatch","poll_interval_ms":60000}`,
];

/** The SAME dispatch, with the daemon dead: the ticker stopped, so no `daemon.alive` follows. */
const DIED_MID_DISPATCH_LEDGER = [
  `{"ts":"${iso(9000 * 1000)}","step":"daemon.boot","head_sha":"0123456789abcdef0123456789abcdef01234567"}`,
  `{"ts":"${iso(21 * 60_000)}","step":"daemon.iteration","task":"W1-T409"}`,
  `{"ts":"${iso(20 * 60_000)}","step":"run.start","task_id":"W1-T409"}`,
];

test("a daemon INSIDE a long dispatch reads LIVE — the busy-versus-dead case that published a false STALE", () => {
  const beat = runBeat({ ledger: MID_DISPATCH_LEDGER });
  assert.equal(field(beat.published, "daemon_verdict"), "live", "a working daemon must not read STALE");
  assert.equal(field(beat.published, "daemon_last_step"), "daemon.alive", "the in-dispatch row is what won the max");
  assert.match(beat.stdout, /daemon live/, "and the phone-readable subject says so");
});

test("THE OTHER DIRECTION: a daemon that DIED mid-dispatch still reads STALE — the fix does not report live unconditionally", () => {
  // Same 21-minute-old dispatch, minus the liveness row. If this ever reads `live`, the signal has
  // become an unconditional green light, which is worse than the bug it replaced.
  const beat = runBeat({ ledger: DIED_MID_DISPATCH_LEDGER });
  const v = field(beat.published, "daemon_verdict");
  assert.ok(v?.startsWith("STALE"), `a dead daemon must still read STALE, got ${v}`);
  assert.equal(field(beat.published, "daemon_last_step"), "daemon.iteration", "the newest row is the dispatch itself");
  assert.match(beat.stdout, /daemon STALE/, "and the subject still carries the alarm");
});

test("MUTANT: a reader that excludes daemon.alive from the prefix is caught — the whole fix rides on that prefix", () => {
  const beat = runBeat({
    ledger: MID_DISPATCH_LEDGER,
    mutate: [`grep '"step":"daemon\\.' "$LEDGER"`, `grep '"step":"daemon\\.\\(idle\\|iteration\\|headroom\\)"' "$LEDGER"`],
  });
  const v = field(beat.published, "daemon_verdict");
  assert.ok(
    v?.startsWith("STALE"),
    `dropping daemon.alive from the read must resurrect the false STALE this fix removed, got ${v}`,
  );
});

// ── W1-T483: THE RESTART BUDGET, AND THE ABSENT-NEVER-ZERO RULE ───────────────────────────────
// `--restart=on-failure:N` caps the COUNT of automatic restarts and nothing restores it, while
// every non-zero exit — a routine freshness restart as much as a crash — spends one. Publishing
// the count while the fleet is UP is the only warning available; once the container is down there
// is nothing left to inspect. The failure direction is unusually dangerous here: `restart_count=0`
// is the most reassuring value in the range, so a read that FAILED must never produce it.

/** A container-runtime stub that answers the one `inspect --format` line the script asks for. */
const runtimeStub = (line: string): string => `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(line)}\n`;

const FRESH_LEDGER = [
  `{"ts":"${iso(9_000_000)}","step":"daemon.boot","head_sha":"0123456789abcdef0123456789abcdef01234567"}`,
  `{"ts":"${iso(45_000)}","step":"daemon.alive","tick":3,"poll_interval_ms":60000}`,
];

test("the beat carries the container restart budget ALONGSIDE daemon liveness — both, or the field is worthless", () => {
  const beat = runBeat({ ledger: FRESH_LEDGER, dockerStub: runtimeStub("1 5 on-failure") });
  assert.equal(beat.status, 0, "a beat that reads a budget must still publish");
  assert.equal(field(beat.published, "restart_count"), "1");
  assert.equal(field(beat.published, "restart_max"), "5");
  assert.equal(field(beat.published, "restart_policy"), "on-failure");
  // ALONGSIDE is the operative word: a budget field that displaced the liveness signal would trade
  // one blind spot for another, and liveness is the older and more important of the two.
  assert.equal(field(beat.published, "daemon_verdict"), "live");
  assert.equal(field(beat.published, "daemon_last_step"), "daemon.alive");
});

test("an UNREADABLE restart budget is ABSENT, never zero — the reassuring value must never come from a failed read", () => {
  // No runtime stub: the script is pointed at a path that does not exist, which is exactly what a
  // host without docker looks like. Shadowing `docker` on PATH could not produce this, because the
  // real /usr/bin/docker would still answer `command -v`.
  const beat = runBeat({ ledger: FRESH_LEDGER });
  assert.equal(beat.status, 0, "an unreadable budget must not fail the beat");
  assert.equal(field(beat.published, "restart_count"), undefined, "a failed read must publish NO count");
  assert.equal(field(beat.published, "restart_max"), undefined, "and no maximum either");
  assert.equal(field(beat.published, "restart_policy"), undefined, "and no policy");
  const why = field(beat.published, "restart_source");
  assert.match(String(why), /^unavailable — no /, `the reason must still be recorded, got ${why}`);
  // And the rest of the beat is unharmed — an absent budget is not a broken beat.
  assert.equal(field(beat.published, "daemon_verdict"), "live");
});

test("a runtime that answers with JUNK publishes no count either — a parse failure is a failed read", () => {
  const beat = runBeat({ ledger: FRESH_LEDGER, dockerStub: runtimeStub("notanumber 5 on-failure") });
  assert.equal(field(beat.published, "restart_count"), undefined, "a non-numeric count must be dropped");
  assert.equal(field(beat.published, "restart_max"), undefined, "and the maximum with it — a lone bound is not a budget");
  assert.match(String(field(beat.published, "restart_source")), /gave no numeric RestartCount/);
});

test("an UNCAPPED policy says `unlimited` — docker reports 0 there, which would read as no restarts left", () => {
  const beat = runBeat({ ledger: FRESH_LEDGER, dockerStub: runtimeStub("3 0 unless-stopped") });
  assert.equal(field(beat.published, "restart_count"), "3");
  assert.equal(field(beat.published, "restart_max"), "unlimited", "0 means NO CAP for unless-stopped, not an exhausted one");
  assert.equal(field(beat.published, "restart_policy"), "unless-stopped");
});

test("MUTANT: defaulting the restart count to 0 when the read fails is caught", () => {
  const beat = runBeat({
    ledger: FRESH_LEDGER,
    mutate: ["if [ -n \"$RESTART_COUNT\" ]; then", 'RESTART_COUNT="${RESTART_COUNT:-0}"; if true; then'],
  });
  // THE MUTANT MUST PRODUCE THE DEFECT, which is what proves the real guard is load-bearing: with
  // the emptiness test replaced by a `:-0` default, a read that never happened publishes the most
  // reassuring value in the field's range. The unmutated script is asserted ABSENT two tests above,
  // so the pair brackets the behaviour from both sides.
  assert.equal(
    field(beat.published, "restart_count"),
    "0",
    "the mutation must actually synthesise the zero — otherwise this test proves nothing about the guard",
  );
});

// ── W1-T483: THE BEAT MUST NAME THE HOST IT RUNS ON ───────────────────────────────────────────
// The live defect was not a missing beat. It was a beat that was ENTIRELY TRUTHFUL about a
// different machine: `beat_host=Craigs-Mac-mini` while the Azure fleet was down for 2h56m. So the
// assertion has to cover both halves — who is speaking, and whose ledger was read.

test("the beat names the host it runs on AND carries that host's own ledger reading", () => {
  const beat = runBeat({
    ledger: FRESH_LEDGER,
    hostnameStub: "#!/usr/bin/env bash\nprintf 'test-host-alpha\\n'\n",
    dockerStub: runtimeStub("2 5 on-failure"),
  });
  assert.equal(field(beat.published, "beat_host"), "test-host-alpha", "the beat must say which machine is speaking");
  // A ledger-DERIVED field, not merely the presence of a beat: this is what separates "a beat
  // exists" from "this host reported on itself".
  assert.equal(field(beat.published, "daemon_last_step"), "daemon.alive");
  assert.equal(field(beat.published, "daemon_verdict"), "live");
  assert.equal(field(beat.published, "restart_count"), "2", "and the budget it read is this host's too");
});

test("MUTANT: a beat_host pinned to a constant is caught — a hard-coded name is the defect in miniature", () => {
  const beat = runBeat({
    ledger: FRESH_LEDGER,
    hostnameStub: "#!/usr/bin/env bash\nprintf 'test-host-alpha\\n'\n",
    mutate: ["beat_host=$(hostname 2>/dev/null || printf 'unknown')", "beat_host=Craigs-Mac-mini"],
  });
  assert.notEqual(
    field(beat.published, "beat_host"),
    "test-host-alpha",
    "the mutant must NOT report the real host — if it does, this test proves nothing",
  );
});

test("A DEAD DAEMON STILL PUBLISHES — the beat is the reporter, and a reporter that goes quiet with its subject is useless", () => {
  const beat = runBeat({
    ledger: [`{"ts":"${iso(8_040_000)}","step":"daemon.iteration","task":"W1-T1"}`],
    hostnameStub: "#!/usr/bin/env bash\nprintf 'test-host-alpha\\n'\n",
    dockerStub: runtimeStub("5 5 on-failure"),
  });
  assert.equal(beat.status, 0, "a beat reporting a dead daemon is a SUCCESSFUL beat — the verdict rides in the payload");
  assert.ok(
    beat.calls.some((c) => sub(c) === "push"),
    "it must still reach the remote; a silent beat is indistinguishable from a power cut",
  );
  assert.ok(String(field(beat.published, "daemon_verdict")).startsWith("STALE"), "and it must SAY the daemon is gone");
  assert.equal(field(beat.published, "beat_host"), "test-host-alpha");
  // The budget is still readable while the container exists, which is the whole early-warning case:
  // 5 of 5 spent, and the next non-zero exit is the one nothing comes back from.
  assert.equal(field(beat.published, "restart_count"), "5");
  assert.equal(field(beat.published, "restart_max"), "5");
});

// ── W1-T483: THE WATCHER MUST JUDGE EVERY HOST INDEPENDENTLY ──────────────────────────────────
// The subject here is the WORKFLOW's own bash, extracted from the committed YAML and run against a
// stubbed `git` — the same drive-the-real-thing discipline `test/strict-probe.test.ts` uses for
// `tsc`. Asserting on a re-implementation would prove nothing about the file GitHub actually runs.
//
// THE CONDITION THAT FAILED, and the reason this exists: two hosts beat, one dies, and the
// watcher — reading a single branch — saw the survivor and stayed silent. Every test below is a
// variation on "does one host's health hide another host's silence".

const WATCH_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "fleet-heartbeat-watch.yml");
const WATCH_STEP_NAME = "Read every host beat branch and judge each age";

/** The committed step's `run:` body, dedented. Extraction failures are LOUD by design. */
function watchStepScript(): string {
  const lines = readFileSync(WATCH_WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `- name: ${WATCH_STEP_NAME}`);
  assert.notEqual(start, -1, `the workflow has no step named "${WATCH_STEP_NAME}" — rename it here too`);
  const runAt = lines.findIndex((l, i) => i > start && l.trim() === "run: |");
  assert.notEqual(runAt, -1, "the step no longer opens a literal `run: |` block");
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") {
      body.push("");
      continue;
    }
    if (!l.startsWith(" ".repeat(10))) break;
    body.push(l.slice(10));
  }
  const script = body.join("\n");
  // POSITIVE CONTROL ON THE EXTRACTION ITSELF. A rename, a re-indent or a reordering must fail HERE
  // rather than silently hand every test below an empty script that trivially "passes" — which is
  // the vacuous-pass shape this repo keeps re-finding.
  assert.ok(script.includes("for branch in $HEARTBEAT_BRANCHES"), "the extracted block is not the branch loop");
  assert.ok(script.includes('[ "$stale" -eq 0 ] || exit 1'), "the extracted block lost its combined verdict");
  return script;
}

/** A `git` answering the five subcommands the watcher reaches. `STUB_BRANCHES` is `name:ageSeconds`
 *  pairs; a branch absent from that list does not exist on the remote, which is the NOT-INSTALLED
 *  case the watcher must stay silent about. */
function watchGitStub(): string {
  return [
    "#!/usr/bin/env bash",
    'sub="$1"; shift',
    "lookup() {",
    '  for e in $STUB_BRANCHES; do',
    '    if [ "${e%%:*}" = "$1" ]; then printf "%s" "${e#*:}"; return 0; fi',
    "  done",
    "  return 1",
    "}",
    'case "$sub" in',
    "  ls-remote)",
    '    b="${@: -1}"',
    '    if lookup "$b" >/dev/null; then printf "%s\\trefs/heads/%s\\n" "0000000000000000000000000000000000000000" "$b"; fi',
    "    ;;",
    "  fetch) : ;;",
    "  log)",
    '    fmt=""; ref=""',
    '    for a in "$@"; do',
    '      case "$a" in --format=*) fmt="${a#--format=}" ;; origin/*) ref="${a#origin/}" ;; esac',
    "    done",
    '    age="$(lookup "$ref")" || age=0',
    '    if [ "$fmt" = "%ct" ]; then printf "%s\\n" "$(( $(date -u +%s) - age ))"',
    '    else printf "heartbeat: %s reporting\\n" "$ref"; fi',
    "    ;;",
    "  show)",
    '    ref="${1%%:*}"; ref="${ref#origin/}"',
    '    printf "beat_host=%s\\nrestart_count=1\\n" "$ref"',
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

interface Watch {
  status: number;
  stdout: string;
  stderr: string;
  report: string;
}

function runWatch(opts: { branches: string; stub: string; staleAfterMinutes?: string; mutate?: [string, string] }): Watch {
  const dir = mkdtempSync(join(tmpdir(), "heartbeat-watch-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "git"), watchGitStub(), { mode: 0o755 });
  chmodSync(join(binDir, "git"), 0o755);

  let script = watchStepScript();
  if (opts.mutate) {
    const [find, replace] = opts.mutate;
    const n = script.split(find).length - 1;
    assert.equal(n, 1, `mutation target must be UNIQUE in the step, found ${n}: ${find}`);
    script = script.replace(find, replace);
  }
  const scriptPath = join(dir, "watch.sh");
  writeFileSync(scriptPath, script, { mode: 0o755 });

  const r = spawnSync("bash", [scriptPath], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HEARTBEAT_BRANCHES: opts.branches,
      STALE_AFTER_MINUTES: opts.staleAfterMinutes ?? "30",
      STUB_BRANCHES: opts.stub,
    },
  });
  const reportPath = join(dir, "heartbeat-report.txt");
  const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", report };
}

test("A DEAD HOST IS FOUND WHILE ANOTHER HOST IS HEALTHY — the exact condition that failed on 2026-08-14", () => {
  const w = runWatch({ branches: "heartbeat heartbeat-azure", stub: "heartbeat:60 heartbeat-azure:9000" });
  assert.equal(w.status, 1, "a stale host must fail the job even though its sibling is fresh");
  assert.match(w.stderr, /STALE — 'heartbeat-azure'/, "the stale host must be named");
  assert.match(w.stdout, /fresh — 'heartbeat' is/, "and the healthy one still reported as healthy");
  assert.match(w.report, /── heartbeat ──/, "the report must carry the healthy host's block");
  assert.match(w.report, /── heartbeat-azure ──/, "and the dead one's — an unlabelled payload cannot be attributed");
  assert.match(w.stdout, /2 branch\(es\) watched, 0 not installed, 1 stale\./);
});

test("A HOST THAT NEVER INSTALLED THE BEAT STAYS SILENT — not-installed is not a finding", () => {
  const w = runWatch({ branches: "heartbeat heartbeat-azure", stub: "heartbeat:60" });
  assert.equal(w.status, 0, "an absent branch must not open an issue about a machine nobody has armed");
  assert.match(w.stdout, /'heartbeat-azure' does not exist on origin/);
  assert.match(w.stdout, /NOT INSTALLED/);
  assert.doesNotMatch(w.stderr, /STALE/, "and it must not be reported as stale either");
  assert.match(w.stdout, /1 branch\(es\) watched, 1 not installed, 0 stale\./);
});

test("AN ABSENT HOST DOES NOT SILENCE A STALE SIBLING — the two rules compose rather than cancel", () => {
  const w = runWatch({ branches: "heartbeat heartbeat-azure heartbeat-third", stub: "heartbeat:9000" });
  assert.equal(w.status, 1, "one stale host is still a finding when two others are merely uninstalled");
  assert.match(w.stdout, /1 branch\(es\) watched, 2 not installed, 1 stale\./);
});

test("EVERY BRANCH ABSENT is silent — the window between merging this and installing anything", () => {
  const w = runWatch({ branches: "heartbeat heartbeat-azure", stub: "" });
  assert.equal(w.status, 0, "a watcher armed before any host is cannot be allowed to alarm hourly");
  assert.match(w.stdout, /0 branch\(es\) watched, 2 not installed, 0 stale\./);
  assert.equal(w.report.trim(), "", "and it reads nothing, so there is nothing to report");
});

test("MUTANT: returning on the first FRESH branch is caught — that is the 2026-08-14 defect exactly", () => {
  const w = runWatch({
    branches: "heartbeat heartbeat-azure",
    stub: "heartbeat:60 heartbeat-azure:9000",
    mutate: [
      `echo "heartbeat-watch: fresh — '\${branch}' is \${age_m} minute(s) old."`,
      `echo "heartbeat-watch: fresh — '\${branch}' is \${age_m} minute(s) old."; exit 0`,
    ],
  });
  assert.equal(w.status, 0, "the mutant must MISS the dead host — otherwise this proves nothing");
  assert.doesNotMatch(w.stderr, /STALE/, "a healthy first host swallowing the rest is the whole defect");
});

test("MUTANT: failing INSIDE the loop is caught — one dead host must not hide the hosts after it", () => {
  const w = runWatch({
    branches: "heartbeat-azure heartbeat",
    stub: "heartbeat-azure:9000 heartbeat:9000",
    mutate: [
      `echo "heartbeat-watch: STALE — '\${branch}' has not beaten for \${age_m} minute(s)." >&2`,
      `echo "heartbeat-watch: STALE — '\${branch}' has not beaten for \${age_m} minute(s)." >&2; exit 1`,
    ],
  });
  assert.equal(w.status, 1, "it still fails, which is why the count is what discriminates");
  assert.doesNotMatch(w.report, /── heartbeat ──/, "the mutant must lose the SECOND host's block entirely");
});

// ── W1-T2767: per-device headroom ───────────────────────────────────────────────────────────────
// THE BEAT HAS NEVER MEASURED THE DISK THAT FILLS. On 2026-09-02 the 29G OS disk hit 100% and the
// host ran wedged ~25h while `disk_free_kb` read ~102GB green — correctly, because `RMD_ROOT` is a
// mount of the 126G data disk (dev 66310) and `/` is dev 66306. These guards pin the labelled
// per-device rows that make that split visible in the beat instead of invisible behind one number.

/** A `df -Pk <path>` stub: two distinct devices, so dedupe and min are actually exercised. */
const dfStub = (rootKb: string, stateKb: string): string =>
  [
    "#!/usr/bin/env bash",
    // Mirrors `df -Pk`: a header line, then device / 1k-blocks / used / available / capacity / mount.
    'target="${@: -1}"',
    'if [ "$target" = "/" ]; then',
    '  printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/root 30000000 1000 %s 58%% /\\n" ' + JSON.stringify(rootKb),
    "else",
    '  printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/nvme0n2p1 130000000 1000 %s 14%% /mnt/rmd\\n" ' + JSON.stringify(stateKb),
    "fi",
  ].join("\n") + "\n";

test("W1-T2767: the beat publishes root and state headroom as separate labelled devices, and a minimum across them", () => {
  // Root nearly full, state roomy — the EXACT September 2 shape, which the single `disk_free_kb`
  // number reported as green.
  const beat = runBeat({ dfStub: dfStub("500000", "107000000") });
  assert.equal(beat.status, 0, beat.stderr);

  assert.equal(field(beat.published, "root_fs_free_kb"), "500000", "the OS disk is reported in its own row");
  assert.equal(field(beat.published, "root_fs_device"), "/dev/root");
  assert.equal(field(beat.published, "state_fs_free_kb"), "107000000");
  assert.equal(field(beat.published, "state_fs_device"), "/dev/nvme0n2p1");
  assert.notEqual(
    field(beat.published, "root_fs_device"),
    field(beat.published, "state_fs_device"),
    "the two rows must name DIFFERENT devices — that split is the whole finding",
  );

  // The alarm number is the SMALLEST device, not the state root's.
  assert.equal(field(beat.published, "disk_min_free_kb"), "500000");
  // Back-compat: the pre-existing field keeps its exact meaning and value for existing readers.
  assert.equal(field(beat.published, "disk_free_kb"), "107000000");
});

test("W1-T2767: an unreadable device degrades to `unknown` and never drags the minimum to a fake 0", () => {
  // `df` fails for every path: nothing is readable, so nothing may be claimed.
  const beat = runBeat({ dfStub: "#!/usr/bin/env bash\nexit 1\n" });
  assert.equal(beat.status, 0, beat.stderr);
  assert.equal(field(beat.published, "root_fs_free_kb"), "unknown");
  assert.equal(field(beat.published, "root_fs_device"), "unknown");
  assert.equal(field(beat.published, "disk_min_free_kb"), "unknown", "unreadable is never reported as 0 free");
});

test("W1-T2767: one unreadable device does not erase a readable minimum", () => {
  // `/` answers, `RMD_ROOT` does not. A readable reading must still be published and still drive
  // the minimum — the mirror of the all-unreadable case above.
  const half = [
    "#!/usr/bin/env bash",
    'target="${@: -1}"',
    '[ "$target" = "/" ] || exit 1',
    'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/root 30000000 1000 400000 58%% /\\n"',
  ].join("\n") + "\n";
  const beat = runBeat({ dfStub: half });
  assert.equal(beat.status, 0, beat.stderr);
  assert.equal(field(beat.published, "root_fs_free_kb"), "400000");
  assert.equal(field(beat.published, "disk_free_kb"), "unknown", "the state root was genuinely unreadable");
  assert.equal(field(beat.published, "disk_min_free_kb"), "400000", "a readable device still yields a minimum");
});

test("W1-T2767: the REAL df leaf runs and reports this host's actual root filesystem", () => {
  // NO dfStub — the default implementation executes. Without this the seam's real leaf is never
  // exercised and only the fakes above are ever proven (CLAUDE.md's all-fakes trap), which is
  // exactly how a reading that measures the wrong device survives a green suite.
  const beat = runBeat();
  assert.equal(beat.status, 0, beat.stderr);

  const rootKb = field(beat.published, "root_fs_free_kb");
  const rootDev = field(beat.published, "root_fs_device");
  const minKb = field(beat.published, "disk_min_free_kb");

  // Falsifiable claims about the REAL reading, not merely that it returned.
  assert.match(String(rootKb), /^[0-9]+$/, `real df must yield a numeric block count, got ${rootKb}`);
  assert.ok(Number(rootKb) > 0, "a mounted root filesystem has non-zero available blocks");
  assert.ok(String(rootDev).length > 0 && rootDev !== "unknown", `real df must name a device, got ${rootDev}`);
  assert.match(String(minKb), /^[0-9]+$/, "the minimum over readable devices is numeric");
  assert.ok(Number(minKb) <= Number(rootKb), "the minimum never exceeds a device it is taken over");
});

test("W1-T2767 mutant: dropping the root-filesystem probe is caught", () => {
  const beat = runBeat({
    dfStub: dfStub("500000", "107000000"),
    mutate: ['ROOT_FS_FREE_KB="$(df_field / 4)"', 'ROOT_FS_FREE_KB=""'],
  });
  assert.notEqual(field(beat.published, "root_fs_free_kb"), "500000", "the guard must not pass on a script that stopped probing /");
});

test("W1-T2767 mutant: taking the minimum over the state root alone is caught", () => {
  // The regression this task exists to prevent: a `min` that only ever sees config.root, which is
  // precisely what reported green through September 2.
  const beat = runBeat({
    dfStub: dfStub("500000", "107000000"),
    mutate: ['for _kb in "$DISK_FREE_KB" "$ROOT_FS_FREE_KB"; do', 'for _kb in "$DISK_FREE_KB"; do'],
  });
  assert.equal(field(beat.published, "disk_min_free_kb"), "107000000", "the mutant reports the roomy device");
  assert.notEqual(field(beat.published, "disk_min_free_kb"), "500000", "and therefore misses the full one");
});
