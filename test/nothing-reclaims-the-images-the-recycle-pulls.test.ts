import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");
const BASH_BIN = ["/opt/homebrew/opt/bash/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find(existsSync) ?? "bash";

// ── W1-T2585: NOTHING RECLAIMS THE IMAGES THE RECYCLE PULLS ─────────────────────────────────
//
// MEASURED 2026-09-01: docker images held 22.92G of a 29G disk at 100% full, and a manual prune
// reclaimed 4.549GB. `deploy/recycle-container.sh` runs `docker pull` on every recycle — the
// ordinary operator action after any merge to a baked path — and removed nothing, so the store
// grew monotonically with operator activity. The failure never surfaced as a disk alarm: the
// daemon exited 1, workers failed checkout, and verify-image.sh emitted three confident WRONG
// product diagnoses (W1-T2571 owns that misreporting separately).
//
// deploy/host-update.sh has reclaimed since 2026-08-08 and is a DIFFERENT path — the operator's
// full update run. Its `--reclaim-only` mode exists so a reclaim can run on a schedule, but is
// named by no workflow and no npm script (only a comment in scripts/fleet-heartbeat.sh), so
// nothing reclaims between operator-initiated host-updates. That is why this path needs its own.
//
// THE CONSTRAINT IS THE DELIVERABLE: never remove an image in use. Taking the running container's
// image, or the digest the recycle just pulled, makes the host unrecoverable rather than merely
// full — strictly worse than the disk it frees. So this suite drives the REAL script with `docker`
// stubbed on PATH, and asserts the reclaim's position and its protection from the recorded calls
// rather than from the source.

/** One recorded `docker` invocation, as the stub appends it. */
interface DockerCall {
  argv: string[];
}

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
  calls: DockerCall[];
}

/**
 * The stub answers only what the reclaim path needs, and is deliberately NOT a copy of
 * test/recycle-container.test.ts's fuller fixture: this suite drives the first-boot path (no
 * pre-existing container), so the env-drift and worker-wait branches it models are never reached.
 *
 * `scenario` selects the reclaim's behaviour:
 *   freed      — the prune reports real bytes and every protected id survives
 *   nothing    — the prune reports `0B`
 *   overreach  — the prune removes an image a container references (a protected id stops
 *                resolving), the case the rationale says must never pass silently
 */
function dockerStub(scenario: string): string {
  return [
    "#!/usr/bin/env bash",
    'printf "%s" "$1" >> "$REC/calls"; for a in "${@:2}"; do printf "\\t%s" "$a" >> "$REC/calls"; done; printf "\\n" >> "$REC/calls"',
    'verb="$1"; shift',
    'case "$verb" in',
    "  ps)",
    // `docker ps -aq` — the container ids whose images are protected.
    '    echo "container-running"; exit 0 ;;',
    "  image)",
    '    sub="$1"; shift',
    '    if [ "$sub" = "prune" ]; then',
    `      case "${scenario}" in`,
    '        nothing) echo "Total reclaimed space: 0B" ;;',
    '        *)       echo "deleted: sha256:OLDIMAGE"; echo "Total reclaimed space: 4.549GB" ;;',
    "      esac",
    "      exit 0",
    "    fi",
    '    if [ "$sub" = "inspect" ]; then',
    // Resolving a protected id AFTER the prune. `overreach` makes the running container's
    // image stop resolving, which is exactly what an over-broad prune would look like.
    '      while [ $# -gt 0 ] && [ "$1" = "--format" ]; do shift 2; done',
    `      case "${scenario}:$1" in`,
    '        overreach:sha256:RUNNINGIMAGE) exit 1 ;;',
    '        *) echo "sha256:PULLEDID"; exit 0 ;;',
    "      esac",
    "    fi",
    "    exit 0 ;;",
    "  inspect)",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    case "$fmt" in',
    '      *Mounts*)',
    '        printf "%s\\t/home/node/Remudero\\ttrue\\n" "${RMD_STATE_DIR:-$HOME/rmd-state2}"',
    '        printf "%s\\t/home/node/.claude\\ttrue\\n" "${RMD_CLAUDE_DIR:-$HOME/.claude}"',
    '        codex="${RMD_CODEX_DIR:-$HOME/.codex}"; [ ! -d "$codex" ] || printf "%s\\t/home/node/.codex\\ttrue\\n" "$codex"',
    '        config="${RMD_CONTAINER_CONFIG_DIR:-$HOME/.config/remudero-container}"; [ ! -d "$config" ] || printf "%s\\t/home/node/.config/remudero\\ttrue\\n" "$config"',
    "        exit 0 ;;",
    // `{{.Image}}` against a container id is the protected-set read; against the container NAME
    // it is section 7's proof that the started container is on the digest just pulled.
    '      *.Image*)',
    '        case "$1" in',
    '          container-running) echo "sha256:RUNNINGIMAGE" ;;',
    '          *) echo "sha256:PULLEDID" ;;',
    "        esac",
    "        exit 0 ;;",
    "      *) exit 1 ;;",
    "    esac ;;",
    "  pull)",
    '    echo "Status: Downloaded newer image"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

function recycle(scenario: string, extraEnv: Record<string, string> = {}): Outcome {
  const binDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reclaim-bin-`));
  const recDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reclaim-rec-`));
  writeFileSync(join(binDir, "docker"), dockerStub(scenario), { mode: 0o755 });
  writeFileSync(join(binDir, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const r = spawnSync(BASH_BIN, [SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      REC: recDir,
      RMD_STATE_DIR: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reclaim-state-`)),
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_FIRST_BOOT: "1",
      // Section 1 refuses before touching anything unless a credential survives the recycle, so a
      // synthetic shell token is what carries this fixture past it — the script's own documented
      // one-off path. The App trio is stated EMPTY rather than inherited: these spread
      // `...process.env`, the daemon container really does carry all three, and an ambient value
      // would silently decide a credential branch the fixture means to state itself.
      GH_TOKEN: "fixture-token-value",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "reclaim-no-such-dockerenv-marker"),
      ...extraEnv,
    },
  });

  let calls: DockerCall[] = [];
  try {
    calls = readFileSync(join(recDir, "calls"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ argv: line.split("\t") }));
  } catch {
    calls = [];
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", calls };
}

const indexOfCall = (calls: DockerCall[], pred: (c: DockerCall) => boolean) => calls.findIndex(pred);
const isPrune = (c: DockerCall) => c.argv[0] === "image" && c.argv[1] === "prune";
const isRun = (c: DockerCall) => c.argv[0] === "run";
const isRm = (c: DockerCall) => c.argv[0] === "rm";

// ── criterion 1 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2585: the recycle reclaims unreferenced images and reports the bytes it freed", () => {
  const out = recycle("freed");
  assert.equal(out.status, 0, `expected a clean recycle; stderr:\n${out.stderr}`);
  assert.ok(indexOfCall(out.calls, isPrune) >= 0, "the recycle must run an image prune — on main it ran none");
  assert.match(out.stdout, /reclaimed 4\.549GB/, out.stdout);
});

// ── criterion 2 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2585: the reclaim runs only AFTER the new container is up, so the pulled digest is referenced", () => {
  const out = recycle("freed");
  const prune = indexOfCall(out.calls, isPrune);
  const started = indexOfCall(out.calls, isRun);
  const removed = indexOfCall(out.calls, isRm);
  assert.ok(started >= 0 && prune >= 0, "both a run and a prune must happen");
  assert.ok(
    prune > started,
    `the prune must follow the run — between docker rm (${removed}) and docker run (${started}) NO container ` +
      `references the newly pulled image, and a prune there would delete the image the recycle is about to start`,
  );
});

test("W1-T2585: an image a container references is never removed — an over-broad prune is a FAILED RECLAIM", () => {
  const out = recycle("overreach");
  assert.equal(out.status, 1, `an over-broad prune must fail the run; stdout:\n${out.stdout}`);
  assert.match(out.stderr, /FAILED RECLAIM/, out.stderr);
  assert.match(out.stderr, /sha256:RUNNINGIMAGE/, "the protected id that vanished must be named");
  assert.match(out.stderr, /recycle itself\s+SUCCEEDED|SUCCEEDED/, "and it must say the recycle itself succeeded");
});

test("W1-T2585: the protected set is read from the containers themselves, not assumed from prune's defaults", () => {
  const out = recycle("freed");
  assert.ok(
    out.calls.some((c) => c.argv[0] === "ps" && c.argv.includes("-aq")),
    "the protected ids must be enumerated from `docker ps -aq`",
  );
  assert.ok(
    out.calls.some((c) => c.argv[0] === "image" && c.argv[1] === "inspect"),
    "and each must be re-inspected after the prune — the falsifier the rationale asks for",
  );
  assert.match(out.stdout, /protected\)/, out.stdout);
});

// ── criterion 3 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2585: a reclaim that frees nothing says so, so a no-op cannot read as a success", () => {
  const out = recycle("nothing");
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /reclaimed 0B/, out.stdout);
  assert.match(out.stdout, /Not an error, and not a success either/, out.stdout);
  assert.doesNotMatch(out.stdout, /reclaimed 4\.549GB/, "the freed-bytes line must not also appear");
});

test("W1-T2585: the reclaim is skippable, and skipping says so rather than reading as a zero reclaim", () => {
  const out = recycle("freed", { RMD_RECYCLE_SKIP_RECLAIM: "1" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /reclaim SKIPPED/, out.stdout);
  assert.equal(indexOfCall(out.calls, isPrune), -1, "no prune may run when the reclaim is skipped");
});

// ── the rules the reclaim must not break ─────────────────────────────────────────────────────

test("W1-T2585: volumes are never pruned, and stopped containers are never removed", () => {
  const out = recycle("freed");
  for (const c of out.calls) {
    assert.ok(!c.argv.includes("--volumes"), `no call may pass --volumes: ${c.argv.join(" ")}`);
    assert.ok(
      !(c.argv[0] === "container" && c.argv[1] === "prune"),
      "container prune removes STOPPED containers, and an exited ad-hoc worker is indistinguishable from junk here (W1-T2725)",
    );
  }
});
