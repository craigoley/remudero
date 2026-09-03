/**
 * `scripts/fleet-heartbeat.sh` — A STALE `.git/gc.log` DISABLES AUTOMATIC GC FOREVER (W1-T2529).
 *
 * WHY THIS FILE EXISTS. git writes `.git/gc.log` when a background `gc --auto` fails, and then
 * REFUSES to attempt another auto-gc for as long as that file exists — the condition is
 * self-sustaining, because the loose objects that made gc fail keep accumulating and gc never
 * runs again to clear them. On the fleet host this clone is written by every worker worktree,
 * every prune and every fetch, so the object count only goes one way. The ONLY existing signal
 * was a warning `git worktree add` prints to STDERR, interleaved with worker output, which the
 * daemon neither parses nor publishes. This suite proves the beat now carries the condition as a
 * field beside the shas it already publishes (`daemon_boot_head_sha`, `install_head_sha`,
 * `image_build_sha`, W1-T496's precedent for exactly this "checkable from the beat rather than by
 * shelling in" class of fact), that the reason is git's own text read from the file rather than a
 * fixed message this script made up, that a healthy clone reports a genuinely different value
 * (the field is not a constant), that no gc/prune command is ever invoked by the beat itself, and
 * that the existence check is what carries the signal — proven with a MUTANT that disables the
 * check and must therefore misreport a disabled clone as healthy.
 *
 * THE SHAPE IS THE PROVEN ONE, mirrored from `test/fleet-heartbeat-image-sha.test.ts` (W1-T496's
 * suite in the same spirit): stub `git` on PATH, run the REAL committed script, assert on a
 * recording of what it actually published — never a re-implementation. The subject is asserted
 * byte-identical to the committed file on every unmutated run so a drifted fixture cannot make a
 * passing test meaningless.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  /** Every subcommand the `git` stub was invoked with, one per line, in call order. */
  gitCalls: string[];
}

/**
 * A `git` stub that answers the handful of subcommands the beat legitimately reaches (git
 * plumbing only, same set `fleet-heartbeat-image-sha.test.ts` stubs) and RECORDS every
 * subcommand it was called with — including `gc`/`prune`, which it does not expect to ever see —
 * so the test can assert on the full call record rather than trusting the script's own claims.
 */
function gitStub(callLogPath: string): string {
  return [
    "#!/usr/bin/env bash",
    `LOG=${JSON.stringify(callLogPath)}`,
    'args=("$@"); i=0',
    'while [ "${args[$i]}" = "-C" ]; do i=$((i+2)); done',
    'sub="${args[$i]}"',
    'printf "%s\\n" "$sub" >> "$LOG"',
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
  /** Lines to write into `<install-dir>/.git/gc.log` before running the beat. Omit for none. */
  gcLog?: string[];
  env?: Record<string, string>;
  mutate?: [string, string];
}

function runBeat(opts: BeatOpts = {}): Beat {
  const dir = mkdtempSync(join(tmpdir(), "rmd-fleet-heartbeat-gclog-"));
  const binDir = join(dir, "stubbin");
  const scriptsDir = join(dir, "scripts");
  const root = join(dir, "root");
  const gitCallLog = join(dir, "git-calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".bin", "tsx"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(dir, "node_modules", ".bin", "tsx"), 0o755);
  writeFileSync(gitCallLog, "");

  // THE SUBJECT IS THE COMMITTED FILE. Copied only so INSTALL_DIR is controllable and, for the
  // mutant test, so the copy has something to edit — byte-equality is asserted below on every
  // unmutated run so a drifted fixture cannot make a passing test meaningless.
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

  // `INSTALL_DIR` resolves to `dirname(scriptPath)/..`, i.e. `dir` itself — the same directory
  // whose `.git` this test seeded above, so `.git/gc.log` lands exactly where the probe reads it.
  if (opts.gcLog) {
    writeFileSync(join(dir, ".git", "gc.log"), opts.gcLog.join("\n") + "\n");
  }

  writeFileSync(join(binDir, "git"), gitStub(gitCallLog), { mode: 0o755 });
  chmodSync(join(binDir, "git"), 0o755);

  const r = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: join(dir, "home"),
      RMD_ROOT: root,
      RMD_HEARTBEAT_DRY_RUN: "1",
      RMD_HEARTBEAT_CONTAINER: "none",
      ...(opts.env ?? {}),
    },
  });

  const gitCalls = readFileSync(gitCallLog, "utf8").split("\n").filter((l) => l.length > 0);
  const beat: Beat = {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    published: r.stdout ?? "",
    gitCalls,
  };
  rmSync(dir, { recursive: true, force: true });
  return beat;
}

/** `key=value` lookup over a published payload. */
function field(payload: string, key: string): string | undefined {
  const line = payload.split("\n").find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

test("bash -n: the committed script parses", () => {
  const r = spawnSync("bash", ["-n", REAL_SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

// ── Claim 1: the heartbeat reports whether automatic gc is disabled, beside the shas ───────────
test("a stale .git/gc.log is reported as gc_verdict=DISABLED, alongside the shas the beat already publishes", () => {
  const beat = runBeat({
    gcLog: [
      "warning: The last gc run reported the following. Please correct the root cause",
      "and remove .git/gc.log",
      "Automatic cleanup will not be performed until the file is removed.",
      "",
      "warning: There are too many unreachable loose objects; run 'git prune' to remove them.",
    ],
  });
  assert.equal(beat.status, 0, `${beat.stdout}\n${beat.stderr}`);
  assert.match(String(field(beat.published, "gc_verdict")), /^DISABLED/);
  // Published beside the checkout facts it already carries (W1-T496's precedent).
  assert.notEqual(field(beat.published, "install_head_sha"), undefined);
});

// ── Claim 2: the reason is git's own text from the file, not a fixed message ────────────────────
test("gc_disabled_reason is git's own first line from gc.log, not a message this script invented", () => {
  const beat = runBeat({
    gcLog: [
      "warning: The last gc run reported the following. Please correct the root cause",
      "and remove .git/gc.log",
    ],
  });
  assert.equal(
    field(beat.published, "gc_disabled_reason"),
    "warning: The last gc run reported the following. Please correct the root cause",
  );

  // A DIFFERENT file, seeded with a DIFFERENT first line, must publish that different text — proof
  // the field is read from the file's own content rather than always returning one fixed string.
  const beat2 = runBeat({ gcLog: ["some other root cause git recorded"] });
  assert.equal(field(beat2.published, "gc_disabled_reason"), "some other root cause git recorded");
});

// ── Claim 3: a healthy clone reports the healthy value — the field is not a constant ───────────
test("no gc.log: gc_verdict=ok and gc_disabled_reason=none, distinct from the disabled case", () => {
  const healthy = runBeat({});
  assert.equal(field(healthy.published, "gc_verdict"), "ok");
  assert.equal(field(healthy.published, "gc_disabled_reason"), "none");

  const disabled = runBeat({ gcLog: ["some root cause"] });
  assert.notEqual(
    field(healthy.published, "gc_verdict"),
    field(disabled.published, "gc_verdict"),
    "the healthy and disabled clones must report different gc_verdict values",
  );
});

// ── Claim 4: no gc, prune, or other object-writing git command is ever invoked by the beat ──────
test("the beat never invokes git gc, git prune, or any object-writing command — healthy or disabled", () => {
  const forbidden = new Set(["gc", "prune", "repack", "prune-packed", "reflog"]);
  for (const opts of [{}, { gcLog: ["some root cause"] }]) {
    const beat = runBeat(opts);
    assert.equal(beat.status, 0, `${beat.stdout}\n${beat.stderr}`);
    for (const call of beat.gitCalls) {
      assert.ok(!forbidden.has(call), `git ${call} must never be invoked by the beat`);
    }
  }
});

test("the script source itself never spells a gc/prune invocation outside its own prose comments", () => {
  const source = readFileSync(REAL_SCRIPT, "utf8");
  const codeLines = source.split("\n").filter((l) => !l.trim().startsWith("#"));
  for (const line of codeLines) {
    assert.doesNotMatch(line, /git\s+(-C\s+\S+\s+)?(gc|prune)\b/, `forbidden invocation on code line: ${line}`);
  }
});

// ── Claim 5: the existence check is what carries the signal — a MUTANT that removes it must
// misreport a disabled clone as healthy ─────────────────────────────────────────────────────────
test("MUTANT: disabling the existence check reports a disabled clone as healthy", () => {
  const beat = runBeat({
    gcLog: ["some root cause"],
    mutate: [
      'if [ -e "$GC_LOG" ]; then',
      'if false; then',
    ],
  });
  assert.equal(beat.status, 0, `${beat.stdout}\n${beat.stderr}`);
  assert.equal(
    field(beat.published, "gc_verdict"),
    "ok",
    "the mutation must actually make a disabled clone report healthy — otherwise this test proves nothing about the check",
  );
  assert.equal(field(beat.published, "gc_disabled_reason"), "none");
});
