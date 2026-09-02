// W1-T2553: `deploy/recycle-container.sh` captured a declared runtime variable ONLY from
// `docker inspect` when a container existed; the shell fallback sat in the `else` branch reached
// only when NO container existed. That was fine while containers were started carrying a token,
// and became a PERMANENT DEADLOCK the moment W1-T2311 began creating them with `-e GH_TOKEN=`
// empty on purpose: the captured value is then "" forever, the refusal fires on every recycle
// after the first, and exporting GH_TOKEN — the one remedy the refusal itself recommends — cannot
// help, because that branch never looked at the shell.
//
// The refusal compounded it by printing "and this shell has none either" WITHOUT having read the
// shell, so an operator who HAD exported the variable was told their export had not worked.
//
// These tests drive the REAL script with a fake `docker` on PATH, so the branch under test is the
// shipped one rather than a re-implementation of it. NO TOKEN VALUE IS EVER PRINTED: the fixtures
// use an obvious non-secret placeholder and the assertions read only the script's own wording.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");
const PLACEHOLDER = "not-a-real-token-fixture";

/** A fake `docker` reporting one existing container whose declared runtime vars are all EMPTY —
 *  exactly the shape W1-T2311's own `-e GH_TOKEN=` produces. */
function fakeDockerDir(containerEnv: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-recycle-fake-docker-"));
  const envLines = containerEnv.join("\\n");
  // The IMAGE env must echo every name the container carries that this test is not exercising,
  // or `UNDECLARED_RUNTIME_VARS` (W1-T1069's drift guard) reads them as runtime-set and refuses
  // before the capture under test is ever reached. Only the DECLARED names below differ.
  const imageLines = containerEnv
    .filter((l) => !/^(GH_TOKEN|GH_APP_ID|GH_APP_INSTALLATION_ID|GH_APP_PRIVATE_KEY_PATH|RMD_RESTART_THROTTLE_S|RMD_FRESHNESS_RESTART_MAX)=/.test(l))
    .join("\\n");
  const sh = [
    "#!/usr/bin/env bash",
    // `docker inspect <name>` with no --format — the existence probe.
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

function runScript(opts: { containerEnv: string[]; shellEnv: Record<string, string> }) {
  const dir = fakeDockerDir(opts.containerEnv);
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? "/tmp",
      // W1-T2555: this suite drives the GH_TOKEN capture/fallback branch, never the STATE_DIR-is-a-
      // checkout predicate (that predicate has its own suite). Without this opt-in the new check
      // would refuse before the capture logic under test ever runs, since HOME/rmd-state is not a
      // real checkout in this test environment.
      RMD_RECYCLE_FIRST_BOOT: "1",
      // PRE-EXISTING, not introduced by this PR: section 1 refuses outright on `/.dockerenv`
      // before any capture logic, so wherever this suite runs inside a container — which is where
      // the reviewer executes proofs — all three behavioural cases below assert against
      // "REFUSING — this is running INSIDE a container" instead. MEASURED in the daemon container
      // at origin/main: 1/4 passing (only the source-level case, which never spawns the script);
      // with this override, 4/4. Sibling recycle suites already pass it for the same reason.
      RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "recycle-capture-no-such-dockerenv-marker"),
      ...opts.shellEnv,
    },
  });
}

// ── The deadlock: an empty container value must reach the shell ──────────────────────────────

test("an EMPTY container GH_TOKEN falls back to the shell instead of refusing forever — the W1-T2311 deadlock", () => {
  const r = runScript({
    // The exact shape W1-T2311 creates: the name is present, the value is empty.
    containerEnv: ["GH_TOKEN=", "GH_APP_ID=", "PATH=/usr/bin"],
    shellEnv: { GH_TOKEN: PLACEHOLDER },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(
    /no GH_TOKEN could be captured/.test(out),
    false,
    `the shell held a token, so the capture must not refuse. Output:\n${out.slice(0, 900)}`,
  );
  assert.match(out, /GH_TOKEN captured from shell/, "and it must say WHERE it came from");
});

test("a NON-EMPTY container value still wins over a shell export — precedence is unchanged", () => {
  const r = runScript({
    containerEnv: [`GH_TOKEN=${PLACEHOLDER}-from-container`, "PATH=/usr/bin"],
    shellEnv: { GH_TOKEN: `${PLACEHOLDER}-from-shell` },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /GH_TOKEN captured from container/, `a live container's own value must not be replaced by a stale export. Output:\n${out.slice(0, 900)}`);
});

// ── The refusal names what it actually consulted ─────────────────────────────────────────────

test("with BOTH sources empty the refusal names each source it consulted, and never asserts an unread one", () => {
  const r = runScript({ containerEnv: ["GH_TOKEN=", "PATH=/usr/bin"], shellEnv: {} });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /no GH_TOKEN could be captured/, "both empty must still refuse");
  assert.match(out, /Consulted remudero-daemon's own environment/, "it must name the container as a source it read");
  assert.match(out, /Consulted this shell/, "and the shell as a source it read");
  assert.match(out, /GH_TOKEN is not set/, "and report that source's actual result");
  assert.equal(
    /and this shell has none\s+either/.test(out),
    false,
    "the old wording asserted the shell was empty from a branch that never read it",
  );
  assert.notEqual(r.status, 0, "a genuine double-empty still exits non-zero — nothing is weakened");
});

// ── The source of the bug, pinned so a future edit cannot silently restore it ────────────────

test("the container capture branch reads the shell as a fallback — the source-level lock on the deadlock", () => {
  // READ THE WORKING TREE, NEVER `git show HEAD:`. The proof runs in the reviewer's materialized
  // head checkout, where a git object read is not guaranteed to work — this repo already observes
  // that shape (`verify-image.sh` reports `rmd fatal: not a git repository` inside the image). A
  // failed `git show` returns EMPTY stdout, not an error, so `source` became "" and every
  // assertion below failed on a tree whose script was perfectly correct: MEASURED, this file passed
  // 4/4 locally AND in GitHub Actions while the reviewer reported all four criteria "executed and
  // FAILED". Reading the file is also strictly STRONGER for what this test pins — an uncommitted
  // edit that restores the bug is caught here, where `git show HEAD:` would have missed it.
  const source = readFileSync(join(REPO_ROOT, "deploy", "recycle-container.sh"), "utf8");
  assert.ok(source.length > 0, "the script must be readable from the working tree");
  // The capture loop that runs when a container EXISTS must consult `${!name-}` — the shell — and
  // not only CONTAINER_ENV_LINES. Sliced to the container branch so the `else` branch's own
  // long-standing shell read cannot satisfy this by accident.
  const start = source.indexOf("for name in \"${RMD_DAEMON_RUNTIME_ENV_VARS[@]}\"; do");
  assert.ok(start > 0, "the capture loop must still exist");
  const containerBranch = source.slice(start, source.indexOf("\nelse", start));
  assert.match(containerBranch, /\$\{!name-\}/, "the container branch must fall back to the shell by name");
  assert.match(containerBranch, /CAPTURED_SOURCE/, "and record which source it used, so the refusal can name it");
});
