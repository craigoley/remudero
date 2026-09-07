// Shared harness for `scripts/fleet-heartbeat.sh`, extracted here by W1-T494 so a SECOND suite can
// drive the REAL committed script without forking a copy of it. Two costs this avoids, both measured:
// duplicating the runner is the shape W1-T2903 files (218 `git init` sites across 130 files), and
// importing one test file from another RE-RUNS its whole suite — 38 extra executions per pass.
// Nothing about the runner's behaviour changed in the move; only `REPO_ROOT` gains one `..`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REAL_SCRIPT = join(REPO_ROOT, "scripts", "fleet-heartbeat.sh");

export interface Call {
  bin: string;
  argv: string[];
}

export interface Beat {
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

export interface BeatOpts {
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

export function runBeat(opts: BeatOpts = {}): Beat {
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
