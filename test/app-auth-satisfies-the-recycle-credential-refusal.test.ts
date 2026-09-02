// The recycle's FIRST refusal — "no GH_TOKEN could be captured" — protects exactly one thing,
// stated in its own text: a token that exists ONLY in the outgoing container's environment and is
// unrecoverable once that container is removed. Under App auth that premise is false. The daemon
// mints its own installation token per boot from `GH_APP_ID`, `GH_APP_INSTALLATION_ID` and a
// private-key FILE on the host, all of which outlive the container, so removing it loses nothing.
//
// Left unfixed the refusal was not merely redundant, it was harmful: W1-T2311 forwards
// `-e GH_TOKEN=` EMPTY on purpose, so every recycle captured empty and refused, and the value an
// operator typed to get past it was discarded by that same forwarding loop and never reached the
// daemon. The only effect of the gate was to put a live personal token on a terminal, repeatedly.
//
// These tests drive the REAL script with a fake `docker` on PATH, so the branch under test is the
// shipped one. NO TOKEN VALUE IS EVER PRINTED — the fixtures use an obvious non-secret placeholder
// and a fake key file, and the assertions read only the script's own wording.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");
const PLACEHOLDER = "not-a-real-token-fixture";
const CRED_MOUNT_DEST = "/home/node/.claude";

/** A fake `docker` reporting one existing container whose declared runtime vars are as given. */
function fakeDockerDir(containerEnv: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-appauth-fake-docker-"));
  const envLines = containerEnv.join("\\n");
  // The IMAGE env must echo every name the container carries that is not a DECLARED runtime var,
  // or W1-T1069's drift guard reads them as runtime-set and refuses before the check under test.
  const imageLines = containerEnv
    .filter(
      (l) =>
        !/^(GH_TOKEN|GH_APP_ID|GH_APP_INSTALLATION_ID|GH_APP_PRIVATE_KEY_PATH|RMD_RESTART_THROTTLE_S|RMD_FRESHNESS_RESTART_MAX)=/.test(
          l,
        ),
    )
    .join("\\n");
  const sh = [
    "#!/usr/bin/env bash",
    'if [ "$1" = "inspect" ] && [ "$2" = "remudero-daemon" ]; then exit 0; fi',
    'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
    `  printf '${imageLines}\\n'`,
    "  exit 0",
    "fi",
    'if [ "$1" = "inspect" ]; then',
    '  case "$*" in',
    `    *".Config.Env"*) printf '${envLines}\\n' ;;`,
    '    *".Config.Image"*) echo "fixture/image:latest" ;;',
    '    *".Image"*) echo "sha256:fixture" ;;',
    "    *) exit 0 ;;",
    "  esac",
    "  exit 0",
    "fi",
    "exit 0",
  ].join("\n");
  writeFileSync(join(dir, "docker"), sh + "\n");
  chmodSync(join(dir, "docker"), 0o755);
  return dir;
}

/** Runs the real script against a temp CRED_DIR, optionally materializing the App private key. */
function runScript(opts: {
  containerEnv: string[];
  shellEnv?: Record<string, string>;
  keyFile?: "present" | "absent" | "empty";
  keyName?: string;
}): { out: string; status: number | null; credDir: string } {
  const dockerDir = fakeDockerDir(opts.containerEnv);
  const credDir = mkdtempSync(join(tmpdir(), "rmd-appauth-cred-"));
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-appauth-state-"));
  mkdirSync(join(stateDir, "state"), { recursive: true });
  // W1-T2555 added a checkout guard (section 1.5) that refuses BEFORE any credential logic when
  // STATE_DIR carries no `remudero/.git`. Without it the script never reaches the App-auth path
  // under test, and every case below asserts against that refusal instead.
  mkdirSync(join(stateDir, "remudero", ".git"), { recursive: true });
  const keyName = opts.keyName ?? "rmd-app.pem";
  if (opts.keyFile === "present") {
    // Not a real key — the script tests only that the FILE is present and non-empty.
    writeFileSync(join(credDir, keyName), "-----BEGIN RSA PRIVATE KEY-----\nfixture\n");
  } else if (opts.keyFile === "empty") {
    writeFileSync(join(credDir, keyName), "");
  }
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      PATH: `${dockerDir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? "/tmp",
      RMD_CLAUDE_DIR: credDir,
      RMD_STATE_DIR: stateDir,
      RMD_RECYCLE_DOCKERENV_PATH: join(stateDir, "no-dockerenv-marker"),
      ...(opts.shellEnv ?? {}),
    },
  });
  return { out: `${r.stdout}\n${r.stderr}`, status: r.status, credDir };
}

const APP_ENV = [
  "GH_TOKEN=",
  "GH_APP_ID=4648213",
  "GH_APP_INSTALLATION_ID=155256285",
  `GH_APP_PRIVATE_KEY_PATH=${CRED_MOUNT_DEST}/rmd-app.pem`,
  "PATH=/usr/bin",
];

// ── The fix: a configured App is a credential, so no token is asked for ──────────────────────

test("with App auth configured and its key on disk, an empty GH_TOKEN does NOT refuse", () => {
  const { out } = runScript({ containerEnv: APP_ENV, keyFile: "present" });
  assert.equal(
    /REFUSING — no GH_TOKEN could be captured/.test(out),
    false,
    `App auth outlives the container, so nothing is lost and nothing may be demanded. Output:\n${out.slice(0, 1200)}`,
  );
  assert.match(out, /NONE IS NEEDED — App auth is fully configured/, "and it must say so, not pass silently");
  assert.equal(
    /Export GH_TOKEN in this shell and re-run/.test(out),
    false,
    "the operator must not be told to paste a token that the forwarding loop would discard anyway",
  );
});

// ── The falsifiers: each missing App input still refuses, and is NAMED ────────────────────────

test("a MISSING App private key still refuses, and names the host path it probed", () => {
  const { out, status, credDir } = runScript({ containerEnv: APP_ENV, keyFile: "absent" });
  assert.match(out, /REFUSING — no GH_TOKEN could be captured/, "an unmintable App config is not a credential");
  assert.match(out, /the App private key is missing or empty on this host at/, "and the cause must be named");
  assert.ok(
    out.includes(join(credDir, "rmd-app.pem")),
    `the HOST path must be printed, not the container path the variable holds. Output:\n${out.slice(0, 1200)}`,
  );
  assert.notEqual(status, 0, "and it must exit non-zero");
});

test("an EMPTY App private key file is refused exactly like a missing one", () => {
  const { out, status } = runScript({ containerEnv: APP_ENV, keyFile: "empty" });
  assert.match(out, /the App private key is missing or empty on this host at/, "a zero-byte key mints nothing");
  assert.notEqual(status, 0, "and it must exit non-zero");
});

test("a missing GH_APP_INSTALLATION_ID still refuses, and names that variable", () => {
  const { out, status } = runScript({
    containerEnv: APP_ENV.map((l) => (l.startsWith("GH_APP_INSTALLATION_ID=") ? "GH_APP_INSTALLATION_ID=" : l)),
    keyFile: "present",
  });
  assert.match(out, /GH_APP_INSTALLATION_ID is not set/, "two of three inputs is not App auth");
  assert.notEqual(status, 0, "and it must exit non-zero");
});

test("a key path under NEITHER bind mount is refused rather than assumed reachable", () => {
  const { out, status } = runScript({
    containerEnv: APP_ENV.map((l) =>
      l.startsWith("GH_APP_PRIVATE_KEY_PATH=") ? "GH_APP_PRIVATE_KEY_PATH=/opt/secrets/rmd-app.pem" : l,
    ),
    keyFile: "present",
  });
  assert.match(
    out,
    /is under neither bind mount, so this shell cannot verify the key exists/,
    "an unverifiable path fails closed — the container is removed before the daemon could report it",
  );
  assert.notEqual(status, 0, "and it must exit non-zero");
});

// ── Precedence is unchanged: a real token still wins and is still reported ────────────────────

test("a captured GH_TOKEN still short-circuits the App check and is reported by source", () => {
  const { out } = runScript({
    containerEnv: ["GH_TOKEN=", "PATH=/usr/bin"],
    shellEnv: { GH_TOKEN: PLACEHOLDER },
  });
  assert.match(out, /GH_TOKEN captured from shell/, "the pre-existing capture path is untouched");
  assert.equal(
    /NONE IS NEEDED — App auth is fully configured/.test(out),
    false,
    "the App branch is the fallback for an ABSENT token, not a replacement for a present one",
  );
});
