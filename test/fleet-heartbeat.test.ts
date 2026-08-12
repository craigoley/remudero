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

  const r = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: join(dir, "home"),
      RMD_ROOT: root,
      STUB_REC: rec,
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

const NOW = new Date();
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
  const beat = runBeat({
    ledger: MIXED_LEDGER,
    mutate: ["| sed -n 's/^{\"ts\":\"\\([^\"]*\\)\".*/\\1/p' | sort | tail -n 1", "| sed -n 's/^{\"ts\":\"\\([^\"]*\\)\".*/\\1/p' | tail -n 1"],
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
  assert.equal(field(lying.published, "daemon_last_age_s"), "0", "every timestamp resolves to now");
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
