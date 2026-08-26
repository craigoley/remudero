// test/daemon-default-credential.test.ts — W1-T2311: THE DAEMON'S DEFAULT CREDENTIAL WAS THE
// OPERATOR'S PAT.
//
// MEASURED 2026-08-26: `docker inspect` (deploy/recycle-container.sh) reports only the STATIC
// config a container was started with, never a value `refreshInstallationToken`
// (src/lib/github-app.ts) mutates inside a running process — so every recycle re-captured the
// ORIGINAL boot-time personal token and re-booted the NEXT container on that same standing PAT,
// forever. `refreshInstallationToken` only overwrites `process.env.GH_TOKEN` IN THAT PROCESS, and
// a timed-out exchange leaves whatever was already there untouched — so the personal token was
// never reached by falling back to it, it WAS the default.
//
// Covers plan/tasks.d/W1-T2311-…yaml's four unit-test acceptance criteria:
//   1. the daemon's default credential is no longer a personal token, by whichever remedy taken
//   2. a timed-out exchange cannot leave fleet calls running on the operator's own user
//   3. the implementer records which remedy was taken and why, in the source
//   4. nothing added paces, throttles, sleeps or backs off a call
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

import { EXCHANGE_TIMEOUT_MS, REFRESH_MARGIN_MS, refreshInstallationToken } from "../src/lib/github-app.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECYCLE_SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");
const GITHUB_APP_SRC = join(REPO_ROOT, "src", "lib", "github-app.ts");

// The exact shape the operator's real token measured on 2026-08-26: 93 characters. Not the real
// value (never a literal in this tree — see github-app.ts's own file header on that discipline),
// just a fixture shaped the same way so a leak of the wrong value is unmistakable in an assertion.
const OPERATOR_PAT_FIXTURE = `ghp_${"x".repeat(89)}`;
assert.equal(OPERATOR_PAT_FIXTURE.length, 93, "control: the fixture itself must be 93 characters");

// ── (1) + partial (2): THE RECYCLED CONTAINER'S BOOT ENV NO LONGER CARRIES THE PAT ──────────────
//
// Drives the REAL script, the same technique test/recycle-container.test.ts uses: stub `docker`
// and `az` on PATH, record every `docker run` invocation, and assert on what it actually passed —
// not on prose. The outgoing container here carries the operator's PAT under GH_TOKEN, exactly as
// MEASURED 2026-08-26, so this reproduces the defect's own starting condition.

interface Call {
  bin: string;
  argv: string[];
}

function writeStubs(dir: string): void {
  const containerEnvLines = [
    `GH_TOKEN=${OPERATOR_PAT_FIXTURE}`,
    "RMD_RESTART_THROTTLE_S=300",
    "RMD_FRESHNESS_RESTART_MAX=100",
    "GH_APP_ID=app-id-fixture",
    "GH_APP_INSTALLATION_ID=install-id-fixture",
    "GH_APP_PRIVATE_KEY_PATH=/path/to/key.pem",
  ];
  const imageEnvLines = ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/node"];

  const docker = [
    "#!/usr/bin/env bash",
    'rec() { printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"; }',
    'rec "$@"',
    'case "$1" in',
    "  image)",
    '    if [ "$2" = "inspect" ]; then',
    "      shift 2",
    '      fmt=""',
    '      if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '      case "$fmt" in',
    "        *Config.Env*)",
    ...imageEnvLines.map((l) => `          echo "${l}"`),
    '          echo ""',
    "          exit 0 ;;",
    "        *) echo \"sha256:PULLEDID\"; exit 0 ;;",
    "      esac",
    "    fi",
    "    exit 0 ;;",
    "  inspect)",
    "    shift",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    if [ -z "$fmt" ]; then exit 0; fi',
    '    case "$fmt" in',
    "      *Config.Image*) echo \"test-registry/remudero:old\"; exit 0 ;;",
    "      *Config.Env*)",
    ...containerEnvLines.map((l) => `        echo "${l}"`),
    '        echo ""',
    "        exit 0 ;;",
    "      *.Image}}*) echo \"sha256:PULLEDID\"; exit 0 ;;",
    "    esac",
    "    exit 0 ;;",
    "  pull) echo \"Status: Downloaded newer image\"; exit 0 ;;",
    "  exec) exit 0 ;;",
    "  stop|rm|run) exit 0 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");

  const az = ["#!/usr/bin/env bash", "exit 0", ""].join("\n");

  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "az"), az, { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
}

function runRecycle(): { status: number; stderr: string; calls: Call[] } {
  const dir = mkdtempSync(join(tmpdir(), "daemon-default-cred-stub-"));
  const rec = mkdtempSync(join(tmpdir(), "daemon-default-cred-rec-"));
  const state = mkdtempSync(join(tmpdir(), "daemon-default-cred-state-"));
  writeStubs(dir);
  const r = spawnSync("bash", [RECYCLE_SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      RMD_STATE_DIR: state,
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      GH_TOKEN: "",
      RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "daemon-default-cred-no-such-dockerenv-marker"),
    },
  });
  let calls: Call[] = [];
  try {
    calls = readFileSync(join(rec, "calls"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [bin, ...argv] = l.split("\t");
        return { bin, argv };
      });
  } catch {
    calls = [];
  }
  return { status: r.status ?? -1, stderr: r.stderr ?? "", calls };
}

test("W1-T2311: the recycled container's docker run no longer carries the outgoing container's GH_TOKEN value", () => {
  const run = runRecycle();
  assert.equal(run.status, 0, `expected a clean recycle, got ${run.status}: ${run.stderr}`);
  const runCall = run.calls.find((c) => c.bin === "docker" && c.argv[0] === "run");
  assert.ok(runCall, "a docker run call must have happened");

  const eFlags = new Map<string, string>();
  for (let i = 0; i < runCall!.argv.length; i++) {
    if (runCall!.argv[i] === "-e") {
      const [name, ...rest] = runCall!.argv[i + 1].split("=");
      eFlags.set(name, rest.join("="));
    }
  }

  assert.ok(eFlags.has("GH_TOKEN"), "GH_TOKEN must still be a DECLARED name (unrelated to this task)");
  assert.equal(eFlags.get("GH_TOKEN"), "", "the daemon's default credential must no longer be the operator's PAT");
  assert.notEqual(eFlags.get("GH_TOKEN"), OPERATOR_PAT_FIXTURE);

  // Other declared runtime vars still carry their captured value through unchanged — this task's
  // fix is narrow to GH_TOKEN, not a blanket stop on carrying config across a recycle.
  assert.equal(eFlags.get("GH_APP_ID"), "app-id-fixture");
  assert.equal(eFlags.get("RMD_RESTART_THROTTLE_S"), "300");

  // Defence in depth: the PAT fixture must not surface ANYWHERE in the docker run invocation,
  // under any name.
  assert.ok(!runCall!.argv.includes(`GH_TOKEN=${OPERATOR_PAT_FIXTURE}`));
  assert.ok(!runCall!.argv.some((a) => a.includes(OPERATOR_PAT_FIXTURE)));
});

// ── (2): A TIMED-OUT EXCHANGE CANNOT LEAVE FLEET CALLS RUNNING ON THE OPERATOR'S OWN USER ───────
//
// Drives the real `refreshInstallationToken` with a socket that opens and never settles (the
// shape EXCHANGE_TIMEOUT_MS exists for — see test/github-app-fallback-visible.test.ts, which pins
// that a timed-out exchange leaves an EXISTING value untouched and must keep doing so). The
// difference here is the STARTING value: with remedy (a) taken, the daemon's own boot env never
// carries GH_TOKEN in the first place, so "untouched" now means "still nothing" rather than
// "still the operator's PAT".
test("W1-T2311: a timed-out exchange cannot leave fleet calls running on the operator's own credential", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const env: NodeJS.ProcessEnv = {
    GH_APP_ID: "123456",
    GH_APP_INSTALLATION_ID: "155256285",
    GH_APP_PRIVATE_KEY_PATH: "/fake/key.pem",
    // No GH_TOKEN — the fixed boot state this task produces.
  };
  const hangingFetch: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      (init as RequestInit | undefined)?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });

  // `mock.timers` advances a FAKE clock by exactly EXCHANGE_TIMEOUT_MS rather than a real
  // wall-clock wait — same technique test/github-app.test.ts's W1-T1068 suite uses.
  mock.timers.enable({ apis: ["setTimeout"] });
  let result: { ok: boolean; reason?: string };
  try {
    const promise = refreshInstallationToken({
      env,
      fetchImpl: hangingFetch,
      readKey: () => pem,
      log: () => {},
    });
    mock.timers.tick(EXCHANGE_TIMEOUT_MS);
    result = await promise;
  } finally {
    mock.timers.reset();
  }

  assert.equal(result.ok, false);
  assert.equal(result.reason, "exchange timed out");
  assert.equal(env.GH_TOKEN, undefined, "no personal token exists to fall back onto once the boot env carries none");
});

// ── (3): THE IMPLEMENTER RECORDS WHICH REMEDY WAS TAKEN AND WHY, IN THE SOURCE ──────────────────

test("W1-T2311: the source records which remedy was taken and why", () => {
  const githubApp = readFileSync(GITHUB_APP_SRC, "utf8");
  assert.match(githubApp, /W1-T2311/, "github-app.ts must reference this task");
  assert.match(githubApp, /REMEDY \(a\) TAKEN/, "the CHOSEN remedy must be named");
  assert.match(githubApp, /REMEDY \(b\)/, "the REJECTED remedy must be named too — a decision needs both sides");
  assert.match(githubApp, /leaves the previous value untouched/, "the untouched-not-cleared contract must be recorded");
  assert.match(githubApp, /UNINVESTIGATED/, "the second-order timeout question must be recorded as unanswered");

  const recycle = readFileSync(RECYCLE_SCRIPT, "utf8");
  assert.match(recycle, /W1-T2311/, "recycle-container.sh must reference this task");
  assert.match(recycle, /operator read path/i, "the replacement path for operator-side reads must be named");
  assert.match(recycle, /docker exec -e GH_TOKEN=/, "the replacement path must be concrete, not merely asserted");
});

// ── (4): NOTHING ADDED PACES, THROTTLES, SLEEPS OR BACKS OFF A CALL ──────────────────────────────
//
// W1-T1066: a polling loop once locked an operator out of his own repository for ninety minutes.
// This checks the SECTIONS this task actually added, not the whole file — deploy/recycle-container.sh
// already contains a legitimate, pre-existing bounded `sleep` in its in-flight-worker wait loop
// (W1-T1046), which this task must not be read as flagging.

function sectionBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `start marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `end marker not found after start: ${endMarker}`);
  return src.slice(start, end);
}

test("W1-T2311: nothing added paces, throttles, sleeps or backs off a call", () => {
  const githubApp = readFileSync(GITHUB_APP_SRC, "utf8");
  const decisionRecord = sectionBetween(
    githubApp,
    "W1-T2311 DECISION RECORD",
    "import { readFileSync }",
  );
  assert.doesNotMatch(decisionRecord, /\bsleep\(/);
  assert.doesNotMatch(decisionRecord, /setTimeout|setInterval/);

  // The retry cadence itself is unchanged — this task did not touch either constant.
  assert.match(githubApp, /export const REFRESH_MARGIN_MS = 5 \* 60 \* 1000;/);
  assert.match(githubApp, /export const EXCHANGE_TIMEOUT_MS = 20 \* 1000;/);
  assert.equal(REFRESH_MARGIN_MS, 5 * 60 * 1000);
  assert.equal(EXCHANGE_TIMEOUT_MS, 20 * 1000);

  const recycle = readFileSync(RECYCLE_SCRIPT, "utf8");
  const addedSection = sectionBetween(
    recycle,
    "W1-T2311: THE CAPTURE ABOVE IS READ",
    "Names only, never values",
  );
  assert.doesNotMatch(addedSection, /\bsleep\b/);

  const runEnvSection = sectionBetween(recycle, "GH_TOKEN IS THE ONE DECLARED NAME", "AUTHENTICATE, THEN PULL");
  assert.doesNotMatch(runEnvSection, /\bsleep\b/);
});
