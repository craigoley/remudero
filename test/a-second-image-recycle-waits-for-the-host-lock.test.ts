import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");
const BASH_BIN = ["/opt/homebrew/opt/bash/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find(existsSync) ?? "bash";

// ── ONE IMAGE RECYCLE PER HOST AT A TIME ────────────────────────────────────────────────────
//
// MEASURED 2026-10-10: core pulled `:latest` at 04:27:07Z and drained for 17 minutes; meanwhile the
// site instance recycled twice and each run's `docker image prune -af` removed core's freshly pulled,
// not-yet-referenced image. Core's smoke failed `No such image` at 04:44:42Z after its PAUSE had held
// dispatch for nothing. These drive the REAL script with docker stubbed on PATH and a holder process
// standing in for the other instance, and assert from the recorded docker calls that a second recycle
// neither pulls nor prunes while the host lock is held.

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
  calls: string[][];
}

const DOCKER_STUB = [
  "#!/usr/bin/env bash",
  'printf "%s" "$1" >> "$REC/calls"; for a in "${@:2}"; do printf "\\t%s" "$a" >> "$REC/calls"; done; printf "\\n" >> "$REC/calls"',
  'verb="$1"; shift',
  'case "$verb" in',
  '  ps) echo "container-running"; exit 0 ;;',
  "  image)",
  '    sub="$1"; shift',
  '    if [ "$sub" = "prune" ]; then echo "Total reclaimed space: 1.0GB"; exit 0; fi',
  '    if [ "$sub" = "inspect" ]; then echo "sha256:PULLEDID"; exit 0; fi',
  "    exit 0 ;;",
  "  inspect)",
  '    fmt=""',
  '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
  '    case "$fmt" in',
  '      *Mounts*)',
  '        printf "%s\\t/home/node/Remudero\\ttrue\\n" "${RMD_STATE_DIR:-$HOME/rmd-state2}"',
  '        printf "%s\\t/home/node/.claude\\ttrue\\n" "${RMD_CLAUDE_DIR:-$HOME/.claude}"',
  "        exit 0 ;;",
  '      *.Image*) case "$1" in container-running) echo "sha256:RUNNINGIMAGE" ;; *) echo "sha256:PULLEDID" ;; esac; exit 0 ;;',
  "      *) exit 1 ;;",
  "    esac ;;",
  '  pull) echo "Status: Downloaded newer image"; exit 0 ;;',
  "esac",
  "exit 0",
  "",
].join("\n");

function recycle(lockPath: string, extraEnv: Record<string, string> = {}): Outcome {
  const binDir = makeTempDir("hostlock-bin");
  const recDir = makeTempDir("hostlock-rec");
  writeFileSync(join(binDir, "docker"), DOCKER_STUB, { mode: 0o755 });
  writeFileSync(join(binDir, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const cashKeyPath = join(recDir, "openweight-api-key");
  writeFileSync(cashKeyPath, "fixture-cash-key\n", { mode: 0o600 });
  chmodSync(cashKeyPath, 0o600);
  const r = spawnSync(BASH_BIN, [SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      REC: recDir,
      RMD_STATE_DIR: makeTempDir("hostlock-state"),
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_FIRST_BOOT: "1",
      GH_TOKEN: "fixture-token-value",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      RMD_OPENWEIGHT_API_KEY_PATH: cashKeyPath,
      RMD_RECYCLE_DOCKERENV_PATH: join(recDir, "no-such-dockerenv-marker"),
      RMD_RECYCLE_HOST_LOCK: lockPath,
      RMD_RECYCLE_LOCK_WAIT_S: "2",
      RMD_RECYCLE_LOCK_POLL_S: "1",
      ...extraEnv,
    },
  });
  let calls: string[][] = [];
  try {
    calls = readFileSync(join(recDir, "calls"), "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
  } catch {
    calls = [];
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", calls };
}

/** A live process standing in for the other instance's recycle, recorded as the lock's holder. */
function holdLock(lockPath: string): ChildProcess {
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "holder"), `${holder.pid} site\n`);
  return holder;
}

const pulled = (o: Outcome) => o.calls.some((c) => c[0] === "pull");
const pruned = (o: Outcome) => o.calls.some((c) => c[0] === "image" && c[1] === "prune");

test("a second image recycle never pulls or prunes while another instance holds the host recycle lock", () => {
  const lockPath = join(makeTempDir("hostlock-dir"), "recycle-container.lock");
  const holder = holdLock(lockPath);
  try {
    const out = recycle(lockPath);
    assert.equal(out.status, 1, `a held lock past the wait must refuse; stdout:\n${out.stdout}\nstderr:\n${out.stderr}`);
    assert.match(out.stderr, /holds the host recycle lock/, out.stderr);
    assert.match(out.stdout, /deploy\.recycle_waiting/, "a waiting recycle must say so before it refuses");
    assert.equal(pulled(out), false, "no pull may run while another instance holds the lock");
    assert.equal(pruned(out), false, "no prune may run while another instance holds a pulled-but-unswapped image");
    assert.ok(existsSync(lockPath), "the refusing run must leave the holder's lock in place");
  } finally {
    holder.kill();
  }
});

test("a lock whose holder pid is dead is reclaimed and the recycle runs, then releases the lock", () => {
  const lockPath = join(makeTempDir("hostlock-dir"), "recycle-container.lock");
  const dead = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "holder"), `${dead} core\n`);
  const out = recycle(lockPath);
  assert.equal(out.status, 0, `a stale lock must not block the recycle; stderr:\n${out.stderr}`);
  assert.match(out.stdout, /DEAD pid/, out.stdout);
  assert.ok(pulled(out) && pruned(out), "the recycle must go on to pull and reclaim");
  assert.equal(existsSync(lockPath), false, "a finished recycle must release the host lock");
});
