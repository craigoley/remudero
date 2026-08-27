/**
 * `scripts/fleet-heartbeat.sh` — THE DEPLOY-SUPERVISOR TICK (W1-T2349).
 *
 * WHY THIS FILE EXISTS. The beat already carries daemon liveness, the install verdict, the
 * restart budget and three shas — and, until this task, NOT ONE FIELD derived from the deploy
 * cycle. MEASURED 2026-08-27: the mini's deploy-supervisor went 7h26m overdue with nothing
 * off-host reporting it, because every other beat field can read perfectly healthy while the
 * thing that ADVANCES the daemon's install has quietly stopped ticking. `runDeployCycle`
 * (src/lib/deployer.ts) logs a `deploy.*` line on every branch before its next tick — even a
 * same-head no-op logs `deploy.skip` — so the MAX ts over the `deploy.` prefix is the same
 * always-advancing signal `daemon_verdict` already reads over the `daemon.` prefix, one more grep
 * of a ledger this script already opens.
 *
 * THE SHAPE IS THE PROVEN ONE, mirrored from `test/fleet-heartbeat-image-sha.test.ts` (itself
 * mirrored from `test/fleet-heartbeat.test.ts`): stub `git` on PATH, run the REAL committed
 * script via `RMD_HEARTBEAT_DRY_RUN=1`, and assert on the payload it actually prints — never a
 * re-implementation of the probe. The subject is asserted byte-identical to the committed file on
 * every unmutated run so a drifted fixture cannot make a passing test meaningless.
 *
 * THIS IS A NEW FILE, DELIBERATELY, FOR THE SAME REASON W1-T496's third-sha suite is one:
 * `test/fleet-heartbeat.test.ts` already carries two DECLARED host-parity divergences over the
 * BSD/GNU `date` split, and this shard's own path is not declared in its own `files:` list, so
 * adding coverage to that file would convert a `proof-scope` warning into a hard filing violation.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_SCRIPT = join(REPO_ROOT, "scripts", "fleet-heartbeat.sh");

interface Beat {
  status: number;
  stdout: string;
  stderr: string;
  published: string;
}

/** A `git` stub answering the handful of subcommands this script reaches, git-plumbing only. */
function gitStub(): string {
  return [
    "#!/usr/bin/env bash",
    "args=(\"$@\"); i=0",
    'while [ "${args[$i]}" = "-C" ]; do i=$((i+2)); done',
    'sub="${args[$i]}"',
    'case "$sub" in',
    '  rev-parse)    printf "abc1234\\n" ;;',
    '  hash-object)  cat > /dev/null; printf "1111111111111111111111111111111111111111\\n" ;;',
    '  mktree)       cat > /dev/null; printf "2222222222222222222222222222222222222222\\n" ;;',
    '  commit-tree)  printf "3333333333333333333333333333333333333333\\n" ;;',
    '  push)         : ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

interface BeatOpts {
  ledger?: string[];
  tsx?: boolean;
  env?: Record<string, string>;
  /** Applied to the copied script as [find, replace], with `find` asserted UNIQUE. */
  mutate?: [string, string];
}

function runBeat(opts: BeatOpts = {}): Beat {
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-supervisor-"));
  const binDir = join(dir, "stubbin");
  const scriptsDir = join(dir, "scripts");
  const root = join(dir, "root");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });

  if (opts.tsx !== false) {
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "tsx"), "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(join(dir, "node_modules", ".bin", "tsx"), 0o755);
  }

  // THE SUBJECT IS THE COMMITTED FILE. Copied only so INSTALL_DIR is controllable and mutants have
  // something to edit — byte-equality is asserted below on every unmutated run so a drifted
  // fixture cannot make a passing test meaningless.
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

  if (opts.ledger) writeFileSync(join(root, "state", "ledger.ndjson"), opts.ledger.join("\n") + "\n");

  writeFileSync(join(binDir, "git"), gitStub(), { mode: 0o755 });
  chmodSync(join(binDir, "git"), 0o755);

  const r = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: join(dir, "home"),
      RMD_ROOT: root,
      RMD_HEARTBEAT_DRY_RUN: "1",
      // No container runtime on this host: the (unrelated, W1-T483/W1-T496) restart-budget and
      // image-sha probes must take their absent branch rather than reach a real docker.
      RMD_HEARTBEAT_DOCKER: join(binDir, "no-such-runtime"),
      ...(opts.env ?? {}),
    },
  });

  const beat: Beat = {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    published: r.stdout ?? "",
  };
  rmSync(dir, { recursive: true, force: true });
  return beat;
}

/** `key=value` lookup over a published payload. */
function field(payload: string, key: string): string | undefined {
  const line = payload.split("\n").find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

// `fleet-heartbeat.sh` computes "now" through a REAL `date -u` call in a REAL bash subprocess, a
// syscall no injected JS clock can shift (see test/fleet-heartbeat.test.ts's own note on this,
// which this mirrors) — so NOW is derived from the SAME real `date -u` the script itself calls,
// keeping the fixture's clock and the subject's clock the same one regardless of any shift.
const NOW = new Date(String(spawnSync("date", ["-u", "+%Y-%m-%dT%H:%M:%S.000Z"]).stdout).trim());
const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();

const FRESH_DAEMON = (ago = 30_000) => `{"ts":"${iso(ago)}","step":"daemon.idle","tick":1,"poll_interval_ms":60000}`;

test("bash -n: the committed script parses", () => {
  const r = spawnSync("bash", ["-n", REAL_SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

// ── Claim 1: a recent deploy.* line publishes its own tick age off-host ───────────────────────
test("a beat seeded with a recent deploy ledger line publishes that tick age off-host", () => {
  const beat = runBeat({
    ledger: [FRESH_DAEMON(), `{"ts":"${iso(30_000)}","step":"deploy.skip","reason":"up-to-date"}`],
  });
  assert.equal(beat.status, 0, `${beat.stdout}\n${beat.stderr}`);
  assert.equal(field(beat.published, "supervisor_verdict"), "live");
  assert.equal(field(beat.published, "supervisor_last_step"), "deploy.skip");
  assert.equal(field(beat.published, "supervisor_last_ts"), iso(30_000));
  assert.match(field(beat.published, "supervisor_last_age_s") ?? "", /^\d+$/, "a real, published age");
});

// The MAX over the prefix, not the last line — mirrors the daemon probe's own guard so a reader
// who has learned one contract has learned the other. Built so the wrong reads are distinguishable
// from the right one: the last LINE is older, the newest LINE is not a `deploy.` step, and only a
// MAX over the prefix picks `deploy.kickstart`.
const MIXED_DEPLOY_LEDGER = [
  FRESH_DAEMON(60_000),
  `{"ts":"${iso(9 * 60_000)}","step":"deploy.not_idle","phase":"pre-pull"}`,
  // The NEWEST deploy line, deliberately NOT last in the file.
  `{"ts":"${iso(60_000)}","step":"deploy.kickstart","to":"abc1234"}`,
  // NEWER than every deploy line, but not a deploy step — must be ignored.
  `{"ts":"${iso(0)}","step":"run.start","note":"not a deploy step"}`,
  // LAST in the file, but older than the newest deploy line — sort|tail must beat append order.
  `{"ts":"${iso(5 * 60_000)}","step":"deploy.not_idle","phase":"pre-kickstart"}`,
];

test("deploy-supervisor liveness is the MAX ts over deploy.-prefixed steps — not the last line, not another step", () => {
  const beat = runBeat({ ledger: MIXED_DEPLOY_LEDGER });
  assert.equal(field(beat.published, "supervisor_last_ts"), iso(60_000), "the newest deploy. line wins");
  assert.equal(field(beat.published, "supervisor_last_step"), "deploy.kickstart");
  assert.equal(field(beat.published, "supervisor_verdict"), "live");
});

// ── Claim 2: an overdue deploy.* line publishes an overdue verdict, without disturbing the
// daemon/install fields ─────────────────────────────────────────────────────────────────────────
test("a beat seeded with a deploy line older than the window publishes an overdue verdict while the daemon and install fields still read healthy", () => {
  const beat = runBeat({
    ledger: [FRESH_DAEMON(), `{"ts":"${iso(3 * 3600_000)}","step":"deploy.skip","reason":"up-to-date"}`],
    tsx: true,
  });
  assert.equal(beat.status, 0, `${beat.stdout}\n${beat.stderr}`);
  const v = field(beat.published, "supervisor_verdict");
  assert.ok(v?.startsWith("STALE"), `a three-hour-old deploy tick must read STALE, got ${v}`);
  // THE EXACT CASE THIS TASK FILES: the daemon and install verdicts must stay healthy alongside
  // the overdue deploy cycle, or this field is indistinguishable from a dead daemon and buys the
  // operator nothing new.
  assert.equal(field(beat.published, "daemon_verdict"), "live", "the daemon reading must be untouched");
  assert.equal(field(beat.published, "rmd_verdict"), "ok", "the install reading must be untouched");
});

test("the staleness predicate discriminates at its own boundary, in both directions", () => {
  // SUPERVISOR_STALE_AFTER_S=1200 in the script: exactly at the threshold still reads live (the
  // comparison is `-le`), one second past reads STALE. Mirrors the same boundary discipline
  // `.github/workflows/fleet-heartbeat-watch.yml`'s own self-check applies to STALE_AFTER_MINUTES.
  const atThreshold = runBeat({
    ledger: [FRESH_DAEMON(), `{"ts":"${iso(1200_000)}","step":"deploy.skip","reason":"up-to-date"}`],
  });
  assert.equal(field(atThreshold.published, "supervisor_verdict"), "live", "exactly at the threshold is still live");

  const pastThreshold = runBeat({
    ledger: [FRESH_DAEMON(), `{"ts":"${iso(1201_000)}","step":"deploy.skip","reason":"up-to-date"}`],
  });
  assert.match(
    field(pastThreshold.published, "supervisor_verdict") ?? "",
    /^STALE/,
    "one second past the threshold reads STALE",
  );
});

// ── Claim 3: no deploy.* line at all publishes an unknown reading with its reason, and never a
// zero age ───────────────────────────────────────────────────────────────────────────────────────
test("a ledger carrying no deploy line publishes an unknown reading with its reason and omits the age rather than writing zero", () => {
  const beat = runBeat({ ledger: [FRESH_DAEMON()] });
  assert.equal(beat.status, 0, `${beat.stdout}\n${beat.stderr}`);
  assert.equal(field(beat.published, "supervisor_verdict"), "unknown");
  assert.equal(field(beat.published, "supervisor_last_ts"), "none");
  assert.equal(field(beat.published, "supervisor_last_step"), "none");
  assert.equal(
    field(beat.published, "supervisor_last_age_s"),
    undefined,
    "no deploy.* line means no age was ever computed — it must be ABSENT, not 0",
  );
  assert.match(String(field(beat.published, "supervisor_source")), /no deploy\.\* line/);
  // The daemon signal must still be carried — a host with no deploy-supervisor at all (the
  // container host, W1-T483) is not thereby a dead daemon.
  assert.equal(field(beat.published, "daemon_verdict"), "live");
});

test("an unreadable ledger publishes the same unknown verdict, with the unreadable reason named", () => {
  // No `ledger` fixture at all: `$LEDGER` is never created, exercising the `[ ! -r "$LEDGER" ]`
  // branch shared with the daemon probe above it.
  const beat = runBeat({});
  assert.equal(beat.status, 0);
  assert.equal(field(beat.published, "supervisor_verdict"), "unknown");
  assert.equal(field(beat.published, "supervisor_last_age_s"), undefined);
  assert.match(String(field(beat.published, "supervisor_source")), /^unreadable — no ledger at/);
});

// ── MUTANTS: each guard above is re-run against a script with that behaviour broken ────────────

test("MUTANT: an absent deploy reading that still writes supervisor_last_age_s=0 is caught", () => {
  // Proves the omit-guard is load-bearing: force the field to always append, unconditionally.
  const beat = runBeat({
    ledger: [FRESH_DAEMON()],
    mutate: [
      'if [ -n "$SUPERVISOR_AGE_S" ]; then\n  PAYLOAD="${PAYLOAD}\nsupervisor_last_age_s=${SUPERVISOR_AGE_S}"\nfi',
      'PAYLOAD="${PAYLOAD}\nsupervisor_last_age_s=${SUPERVISOR_AGE_S:-0}"',
    ],
  });
  assert.equal(
    field(beat.published, "supervisor_last_age_s"),
    "0",
    "the mutant must actually produce the dangerous zero — otherwise this proves nothing about the guard",
  );
});

test("MUTANT: taking the LAST deploy line instead of the max is caught", () => {
  const beat = runBeat({
    ledger: MIXED_DEPLOY_LEDGER,
    mutate: [
      `grep '"step":"deploy\\.' "$LEDGER" 2>/dev/null \\\n    | sed -n 's/^{"ts":"\\([^"]*\\)".*/\\1/p' | sort | tail -n 1`,
      `grep '"step":"deploy\\.' "$LEDGER" 2>/dev/null \\\n    | sed -n 's/^{"ts":"\\([^"]*\\)".*/\\1/p' | tail -n 1`,
    ],
  });
  assert.equal(
    field(beat.published, "supervisor_last_ts"),
    iso(5 * 60_000),
    "without the sort it takes the last APPENDED deploy line, which is not the newest",
  );
});

test("MUTANT: keying supervisor liveness on the daemon prefix instead of deploy. is caught", () => {
  const beat = runBeat({
    ledger: [FRESH_DAEMON(), `{"ts":"${iso(3 * 3600_000)}","step":"deploy.skip","reason":"up-to-date"}`],
    mutate: [`grep '"step":"deploy\\.' "$LEDGER"`, `grep '"step":"daemon\\.' "$LEDGER"`],
  });
  // With the prefix swapped, the supervisor reading collapses onto the fresh daemon line instead
  // of the three-hour-old deploy line — the exact confusion this field exists to prevent.
  assert.equal(
    field(beat.published, "supervisor_verdict"),
    "live",
    "the mutant must misreport the overdue deploy cycle as live",
  );
});
