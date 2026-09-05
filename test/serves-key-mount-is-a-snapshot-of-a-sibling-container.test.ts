import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "serve-container.sh");

/**
 * test/serves-key-mount-is-a-snapshot-of-a-sibling-container.test.ts — W1-T2834.
 *
 * `daemon_host_path_for` translates a container path captured from `remudero-daemon` into a HOST
 * path by shelling `docker inspect` for that container's mount table. That inspection happens ONCE,
 * at `docker run` time, and is never re-evaluated. When it returned nothing the script took its
 * graceful-degrade branch — which left `GH_APP_PRIVATE_KEY_PATH` exported as the DAEMON'S container
 * path, and `-e GH_APP_PRIVATE_KEY_PATH` then carried that into serve verbatim, naming a file with
 * no corresponding mount in serve's namespace.
 *
 * MEASURED 2026-09-04: nine consecutive `github_app.token_refresh_failed` rows from 17:20:03Z,
 * reason `private key unreadable`, one every five minutes for over an hour, with NO RED CHECK
 * ANYWHERE.
 *
 * THESE TESTS DRIVE THE REAL SCRIPT with a fake `docker` on PATH — the same harness
 * test/app-auth-satisfies-the-recycle-credential-refusal.test.ts established — so the branch under
 * test is the shipped one, and the assertions read only the script's own wording.
 */

/**
 * A fake `docker` whose `remudero-daemon` mount table is EITHER present or empty — the two states
 * the one-shot inspection can observe, and the whole point of the fixture.
 *
 * IT MUST ANSWER THE SCRIPT'S TWO DIFFERENT INSPECT FORMATS DIFFERENTLY, and the first draft did
 * not: the STATE-DIR lookup asks `{{if eq .Destination "<state dest>"}}{{.Source}}{{end}}` and the
 * KEY lookup asks `{{printf "%s\t%s\n" .Source .Destination}}`. Answering both with the mount
 * TABLE made the script read the tab-separated pair as a state directory, disagree with its own
 * `RMD_STATE_DIR`, and refuse before ever reaching the branch under test — which is what the two
 * failing tests were actually reporting. Discriminated on `printf`, which only the key lookup has.
 */
function fakeDockerDir(opts: { daemonMounts: string[]; stateSource: string }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t2834-docker-`));
  const mountLines = opts.daemonMounts.join("\n");
  const sh = [
    "#!/usr/bin/env bash",
    'if [ "$1" = "inspect" ]; then',
    '  case "$*" in',
    // The KEY lookup — the mount table the resolver walks. An EMPTY answer is the race this task
    // is about: a container inspected mid-creation reports no mounts, and nothing re-evaluates it.
    `    *printf*) printf '${mountLines}${mountLines ? "\n" : ""}' ;;`,
    // The STATE-DIR lookup, kept AGREEING so the script reaches the key branch rather than
    // refusing on a state-mount disagreement.
    `    *Destination*) echo '${opts.stateSource}' ;;`,
    '    *".State.Running"*) echo "true" ;;',
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

interface RunResult { out: string; status: number | null; }

/** Runs the real script in --dry-run: it prints the launch it WOULD make and changes nothing, and
 *  it reaches the whole key-resolution path — which is why the degrade verdict is emitted there
 *  rather than in the post-launch section a dry run never gets to. */
function runScript(opts: {
  daemonMounts: string[];
  shellEnv?: Record<string, string>;
  cleanup: string[];
}): RunResult {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t2834-state-`));
  const dockerDir = fakeDockerDir({ daemonMounts: opts.daemonMounts, stateSource: stateDir });
  mkdirSync(join(stateDir, "state"), { recursive: true });
  mkdirSync(join(stateDir, "remudero", ".git"), { recursive: true });
  opts.cleanup.push(dockerDir, stateDir);
  const r = spawnSync("bash", [SCRIPT, "--dry-run"], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      PATH: `${dockerDir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? "/tmp",
      RMD_STATE_DIR: stateDir,
      GH_TOKEN: "not-a-real-token-fixture",
      ...(opts.shellEnv ?? {}),
    },
  });
  return { out: `${r.stdout}\n${r.stderr}`, status: r.status };
}

/** A readable, non-empty stand-in for the pem. Content is never read by the script. */
function keyFile(cleanup: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t2834-key-`));
  cleanup.push(dir);
  const p = join(dir, "rmd-app.pem");
  writeFileSync(p, "-----BEGIN RSA PRIVATE KEY-----\nfixture\n");
  return p;
}

// ── the defect: an empty mount table degrades, and used to degrade SILENTLY and WRONGLY ─────────

test("W1-T2834: an unresolvable key is never exported as an unmountable path, and the degrade is REPORTED", () => {
  const cleanup: string[] = [];
  try {
    const r = runScript({
      // The race, reproduced: `docker inspect` answers with NO mounts, exactly as a container
      // inspected mid-creation does.
      daemonMounts: [],
      shellEnv: { GH_APP_PRIVATE_KEY_PATH: "/home/node/.claude/rmd-app.pem" },
      cleanup,
    });
    assert.equal(r.status, 0, "a degrade is not a refusal — GH_TOKEN is a working fallback");

    // THE SILENT HALF IS GONE: a WARNING line, in the script's own voice, naming the remedy.
    assert.match(r.out, /WARNING — GitHub App private key NOT mounted/);
    assert.match(r.out, /RMD_GH_APP_PRIVATE_KEY_HOST_PATH=<host path to the pem>/);

    // AND THE WRONG HALF IS GONE: no bind of a path that was never resolved.
    assert.doesNotMatch(r.out, /-v [^ ]*\/home\/node\/\.claude\/rmd-app\.pem/, "no mount is invented");
    // THE BEHAVIOUR, NOT THE PROSE. `-e NAME` passes the name only, so the value the container
    // receives is invisible in the printed `docker run`; the script now states it, and a test can
    // read it. The path is RETAINED — W1-T2778's tests assert "the refresher retains the unreadable
    // path so its existing telemetry names the failure", and blanking it was tried here and
    // reverted rather than overturning that ruling from inside a task that never argued for it.
    assert.match(r.out, /GH_APP_PRIVATE_KEY_PATH -> \/home\/node\/\.claude\/rmd-app\.pem/,
      "the declared path rides through, so the refresher's telemetry still names the failure");
  } finally {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  }
});

// ── the fix: the host path is configuration, not an inference about a sibling ───────────────────

test("W1-T2834: an explicitly declared HOST path resolves with the daemon's mount table EMPTY — the race is removed, not narrowed", () => {
  const cleanup: string[] = [];
  try {
    const key = keyFile(cleanup);
    const r = runScript({
      daemonMounts: [], // the daemon tells us nothing, and it no longer matters
      shellEnv: { GH_APP_PRIVATE_KEY_PATH: "/home/node/.claude/rmd-app.pem", RMD_GH_APP_PRIVATE_KEY_HOST_PATH: key },
      cleanup,
    });
    assert.equal(r.status, 0);
    assert.match(r.out, /private key mounted as one read-only file, resolved from RMD_GH_APP_PRIVATE_KEY_HOST_PATH/);
    // W1-T2778's SECURITY SHAPE, UNCHANGED BY THIS FIX: ONE file, READ-ONLY, at the SAME
    // destination — and never the credential DIRECTORY, which is the thing that must not be bound.
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(r.out, new RegExp(`-v ${esc}:/home/node/\\.rmd-github-app-private-key\\.pem:ro`),
      "one file, read-only, same destination");
    assert.doesNotMatch(r.out, new RegExp(`-v ${dirname(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`),
      "the directory holding the key is never mounted");
    assert.match(r.out, /GH_APP_PRIVATE_KEY_PATH -> \/home\/node\/\.rmd-github-app-private-key\.pem/,
      "and the container is told the MOUNT destination, not the host path");
    assert.doesNotMatch(r.out, /WARNING — GitHub App private key NOT mounted/, "no degrade");
  } finally {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  }
});

test("W1-T2834: the daemon mount table still works as a FALLBACK HINT when no host path is declared", () => {
  const cleanup: string[] = [];
  try {
    const key = keyFile(cleanup);
    const r = runScript({
      // The translation W1-T2778 shipped, kept: source<TAB>destination.
      daemonMounts: [`${dirname(key)}\\t/home/node/.claude`],
      shellEnv: { GH_APP_PRIVATE_KEY_PATH: "/home/node/.claude/rmd-app.pem" },
      cleanup,
    });
    assert.equal(r.status, 0);
    assert.match(r.out, /resolved from remudero-daemon mount table \(fallback hint\)/);
    assert.doesNotMatch(r.out, /WARNING — GitHub App private key NOT mounted/);
  } finally {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  }
});

test("W1-T2834: the declared HOST path WINS over the sibling's mount table, so a stale table cannot override configuration", () => {
  const cleanup: string[] = [];
  try {
    const key = keyFile(cleanup);
    const decoy = keyFile(cleanup);
    const r = runScript({
      daemonMounts: [`${dirname(decoy)}\\t/home/node/.claude`],
      shellEnv: { GH_APP_PRIVATE_KEY_PATH: "/home/node/.claude/rmd-app.pem", RMD_GH_APP_PRIVATE_KEY_HOST_PATH: key },
      cleanup,
    });
    assert.equal(r.status, 0);
    assert.match(r.out, /resolved from RMD_GH_APP_PRIVATE_KEY_HOST_PATH/);
    assert.match(r.out, new RegExp(`-v ${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
    assert.doesNotMatch(r.out, new RegExp(`-v ${decoy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`), "the decoy is not bound");
  } finally {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  }
});

test("W1-T2834: a declared HOST path that is unreadable degrades — it is not trusted merely for being declared", () => {
  const cleanup: string[] = [];
  try {
    const r = runScript({
      daemonMounts: [],
      shellEnv: { RMD_GH_APP_PRIVATE_KEY_HOST_PATH: join(tmpdir(), "rmd-t2834-no-such-key.pem") },
      cleanup,
    });
    assert.equal(r.status, 0, "still not a refusal");
    assert.match(r.out, /WARNING — GitHub App private key NOT mounted/, "a declared path is still CHECKED");
  } finally {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  }
});

test("W1-T2834: a host with no key configured at all is unchanged — no warning, no mount, no refusal", () => {
  const cleanup: string[] = [];
  try {
    const r = runScript({ daemonMounts: [], cleanup });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.out, /WARNING — GitHub App private key NOT mounted/, "nothing was configured, so nothing degraded");
    assert.doesNotMatch(r.out, /private key mounted as one read-only file/);
  } finally {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  }
});
