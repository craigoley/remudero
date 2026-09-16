/**
 * `scripts/fleet-heartbeat.sh` — ONE BEAT AT A TIME (W1-T3627).
 *
 * WHY THIS FILE EXISTS. This script is the only `zgrep` caller in the tree and it scans the whole
 * ledger union twice per run. On the Azure host that union is 359 files and 271 MB; one scan is
 * 7.2s idle, which at the 5-minute cron cadence is a 2.4% duty cycle. The cost was never the
 * defect. The FEEDBACK LOOP was: once anything slowed the host a scan passed five minutes, cron
 * fired regardless, and two concurrent scans are slower than one — so the next overlapped too. At
 * the collapse the process table held 56 concurrent zgreps (~28 instances, none finishing), load
 * 221 on 8 cores, and available memory FLAT at 0.9 GiB for an hour. Flat, not sawtoothing,
 * because nothing ever completed and released.
 *
 * THE SHAPE IS THE HOUSE ONE, mirrored from `a-clone-that-can-no-longer-gc-says-so-in-the-beat`:
 * stub `git` on PATH and run the REAL committed script, never a re-implementation. The subject is
 * asserted byte-identical to the committed file on every unmutated run, so a drifted fixture
 * cannot make a passing test meaningless.
 */
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_SCRIPT = join(REPO_ROOT, "scripts", "fleet-heartbeat.sh");

const HAVE_FLOCK = spawnSync("sh", ["-c", "command -v flock"], { encoding: "utf8" }).status === 0;

/** A `git` stub that answers the plumbing the beat reaches and never touches a network. */
const GIT_STUB = [
  "#!/usr/bin/env bash",
  'args=("$@"); i=0',
  'while [ "${args[$i]}" = "-C" ]; do i=$((i+2)); done',
  'sub="${args[$i]}"',
  'case "$sub" in',
  '  rev-parse)   printf "abc1234\\n" ;;',
  '  hash-object) cat > /dev/null; printf "1111111111111111111111111111111111111111\\n" ;;',
  '  mktree)      cat > /dev/null; printf "2222222222222222222222222222222222222222\\n" ;;',
  '  commit-tree) printf "3333333333333333333333333333333333333333\\n" ;;',
  '  push)        : ;;',
  "esac",
  "exit 0",
  "",
].join("\n");

interface Bed {
  dir: string;
  root: string;
  script: string;
  env: NodeJS.ProcessEnv;
  lock: string;
}

function makeBed(): Bed {
  const dir = mkdtempSync(join(tmpdir(), "rmd-heartbeat-overlap-"));
  const binDir = join(dir, "stubbin");
  const scriptsDir = join(dir, "scripts");
  const root = join(dir, "root");
  for (const d of [binDir, scriptsDir, join(root, "state"), join(dir, "home"), join(dir, ".git")]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(binDir, "git"), GIT_STUB, { mode: 0o755 });
  chmodSync(join(binDir, "git"), 0o755);

  // THE SUBJECT IS THE COMMITTED FILE, copied only so INSTALL_DIR is controllable.
  const real = readFileSync(REAL_SCRIPT, "utf8");
  const script = join(scriptsDir, "fleet-heartbeat.sh");
  writeFileSync(script, real, { mode: 0o755 });
  chmodSync(script, 0o755);
  assert.equal(readFileSync(script, "utf8"), real, "the subject must be byte-identical to the committed script");

  return {
    dir,
    root,
    script,
    lock: join(root, "state", "heartbeat.lock"),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: join(dir, "home"),
      RMD_ROOT: root,
      RMD_HEARTBEAT_BRANCH: "heartbeat-test",
      RMD_HEARTBEAT_LOCK_HELD: "",
    },
  };
}

function runBeat(bed: Bed) {
  return spawnSync("bash", [bed.script], { encoding: "utf8", env: bed.env, timeout: 120_000 });
}

test("a second heartbeat run refuses while the first still holds the lock", (t) => {
  if (!HAVE_FLOCK) return t.skip("no flock on this host — the guard fails open there by design");
  const bed = makeBed();

  // A beat is IN PROGRESS: hold the very lock path the script takes, the way a slow scan would.
  const holder = spawn("flock", ["-x", bed.lock, "-c", "sleep 30"], { stdio: "ignore" });
  try {
    // Give the holder a moment to actually acquire before the contender runs.
    spawnSync("sh", ["-c", `for i in $(seq 1 50); do flock -n ${JSON.stringify(bed.lock)} -c true || exit 0; sleep 0.1; done; exit 1`]);

    const second = runBeat(bed);

    assert.notEqual(second.status, 0, "an overlapping beat must REFUSE, not run alongside the first");
    // THE LOAD-BEARING ASSERTION: it refused before doing any work. A beat that ran and merely
    // exited non-zero would still have paid for the ledger scan, which is the whole cost.
    assert.equal(
      existsSync(join(bed.root, "state", "heartbeat-last.txt")),
      false,
      "the refused beat must not have published — refusing after the scan would save nothing",
    );
  } finally {
    holder.kill("SIGTERM");
  }
});

test("a heartbeat lock file left by an ended run does not block the next beat", (t) => {
  if (!HAVE_FLOCK) return t.skip("no flock on this host — the guard fails open there by design");
  const bed = makeBed();

  // A previous run ENDED and left its lock file on disk. flock is an FD lock the kernel drops on
  // exit, so the file's mere existence must carry no meaning — this is why the guard needs no
  // stale-lock recovery, and the assertion that keeps anyone from adding one.
  writeFileSync(bed.lock, "");
  assert.ok(existsSync(bed.lock), "control: the lock file must exist for this to prove anything");

  const beat = runBeat(bed);
  assert.equal(beat.status, 0, `a leftover lock file must not block a beat (stderr: ${beat.stderr?.slice(0, 400)})`);
  assert.ok(
    existsSync(join(bed.root, "state", "heartbeat-last.txt")),
    "the beat must have run to completion and published",
  );
});

test("the heartbeat guard skips rather than queues, and cannot exec itself forever", () => {
  const source = readFileSync(REAL_SCRIPT, "utf8");

  // -n, never -w: a late beat SKIPS. Queuing is what stacking is, so a timeout flag here would
  // re-introduce the pile-up this guard exists to remove.
  assert.match(source, /exec flock -n /, "the guard must take the lock non-blocking");
  assert.doesNotMatch(source, /flock\s+-w\s/, "a waiting flock would queue beats instead of skipping them");

  // The re-exec is bounded by an environment guard, because `exec` replaces the process and the
  // child has no other way to know it already holds the lock.
  assert.match(source, /RMD_HEARTBEAT_LOCK_HELD/, "the re-exec must be guarded against recursing forever");
  const guardIndex = source.indexOf("RMD_HEARTBEAT_LOCK_HELD");
  const execIndex = source.indexOf("exec flock -n ");
  assert.ok(guardIndex < execIndex, "the environment guard must be read BEFORE the exec it bounds");
});
