import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

/**
 * W1-T3682: `deploy/host-update.sh`'s git-object reclaim defaults
 * `RMD_GIT_RECLAIM_DIRS` to `${STATE_DIR}/remudero:${RMD_OP_DIR}` — and on the Azure host
 * `${STATE_DIR}` (`~/rmd-state`) has never held a checkout; the live one is `~/rmd-state2/remudero`,
 * the SAME rmd-state -> rmd-state2 drift `--print-daemon-run` has warned about since 2026-08-12.
 * Section 4a never asked. A missing target used to print "no .git here, skipping" to STDOUT and
 * the run still exited 0 — indistinguishable from a reclaim that reached everything and had
 * nothing to free. A second, independent way to reach that same "did nothing, exit 0" shape:
 * `sudo`, which resolves `$HOME` to `/root` and silently redirects every default with it.
 *
 * Kept OUT of `deploy/host-update.sh`'s plan `files:` entry for the reason
 * `plan/tasks.d/W1-T3680-every-dependabot-pr-is-structurally-unmergeable.yaml` records: lint-plan's
 * `proof-unit-test-unresolvable` rule requires every `unit test:` proof to resolve in the HEAD
 * TREE OF THE DIFF once `files:` names a `test/` path — a task filed before its own test exists
 * cannot satisfy that, so the test stays off the list while still shipping in this diff.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Writes a `docker` stub answering just enough for `--reclaim-only`/`--dry-run`: DOCKER_ROOT is a
 * REAL directory (`df -Pk` needs one to exist, or `set -o pipefail` aborts the run before it ever
 * reaches section 4a — the same trap test/host-update-reclaim.test.ts's own `writeStubs` names),
 * no fleet container is ever "running", and every prune reports a fixed, parseable total. No `az`
 * stub: `--reclaim-only` and `--dry-run` both skip the registry login. Returns the real directory
 * `docker info` answers with.
 */
function writeStubs(dir: string): string {
  const dockerRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-sib-root-`));
  writeFileSync(
    join(dir, "docker"),
    [
      "#!/usr/bin/env bash",
      'case "$1 $2" in',
      `  "info --format") echo "${dockerRoot}"; exit 0 ;;`,
      '  "system df")      echo "TYPE TOTAL ACTIVE SIZE"; exit 0 ;;',
      "esac",
      'case "$1" in',
      "  ps)      exit 0 ;;",
      "  inspect) exit 0 ;;",
      "  image)",
      '    if [ "$2" = "inspect" ]; then exit 0; fi',
      '    echo "Total reclaimed space: 0B"; exit 0 ;;',
      '  builder) echo "Total reclaimed space: 0B"; exit 0 ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(join(dir, "docker"), 0o755);
  return dockerRoot;
}

/** Stubs `id -u` to answer "0" — the shape a `sudo` invocation produces — without needing real
 *  root. `$EUID` is a bash builtin no PATH stub can override, which is why the sudo guard reads
 *  the effective uid via the external `id` command, exactly as deploy/verify-image.sh and
 *  deploy/install-container-runtime-mount-order.sh already do (and
 *  test/container-runtime-mount-order-install.test.ts already stubs `id` the same way). */
function writeIdStub(dir: string): void {
  writeFileSync(
    join(dir, "id"),
    ["#!/usr/bin/env bash", 'if [ "$1" = "-u" ]; then echo 0; exit 0; fi', "exit 1", ""].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(join(dir, "id"), 0o755);
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function runHostUpdate(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Run {
  const bin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-sib-bin-`));
  writeStubs(bin);
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ...extraEnv },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A real checkout at exactly `<parent>/<name>`, built via the shared git-repo fixture and MOVED
 *  into place — never a raw `git init`, which test/fixture-copy-census.test.ts's baseline caps —
 *  so its path is exactly what the reclaim loop is told to look at. */
function checkoutAt(parent: string, name: string): string {
  const built = gitRepo({ kind: "host-update-sib-git" });
  mkdirSync(parent, { recursive: true });
  const dest = join(parent, name);
  renameSync(built.dir, dest);
  return dest;
}

// ── Acceptance 1: a target with no .git, whose SIBLING does, is named in the warning ───────────

test("a reclaim target with a live sibling is named in the warning", () => {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-sib-`));
  // The measured shape exactly: STATE_DIR/remudero never created, STATE_DIR2/remudero is the
  // live checkout — the rmd-state -> rmd-state2 rename --print-daemon-run already detects.
  const target = join(base, "rmd-state", "remudero");
  const sibling = checkoutAt(join(base, "rmd-state2"), "remudero");
  const run = runHostUpdate(["--reclaim-only"], { RMD_GIT_RECLAIM_DIRS: target });
  assert.match(run.stderr, new RegExp(`WARNING — git reclaim target ${esc(target)} has no \\.git, but`));
  assert.match(run.stderr, new RegExp(`${esc(sibling)} does\\. Set RMD_GIT_RECLAIM_DIRS`));
  assert.doesNotMatch(run.stdout, /no \.git here, skipping/, "the old silent stdout note must be gone");
});

// ── Acceptance 2: reaching NONE of the named targets exits non-zero ─────────────────────────────

test("a reclaim reaching no target exits non-zero", () => {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-sib-nogit-`));
  const target = join(base, "remudero"); // no .git, and no sibling of `base` holds one either
  const run = runHostUpdate(["--reclaim-only"], { RMD_GIT_RECLAIM_DIRS: target });
  assert.notEqual(run.status, 0, "an all-miss must not report the same exit code as a clean run");
  assert.match(run.stderr, /reached NONE of its named targets/);
});

// ── Acceptance 3: reaching a real checkout and freeing nothing still succeeds ───────────────────

test("a reclaim freeing nothing from a real checkout succeeds", () => {
  const repo = gitRepo({ kind: "host-update-sib-real" });
  const run = runHostUpdate(["--reclaim-only"], { RMD_GIT_RECLAIM_DIRS: repo.dir });
  assert.equal(run.status, 0, "a real checkout with nothing to free is a normal outcome, not a failure");
  assert.match(run.stdout, new RegExp(`git reclaim — ${esc(repo.dir)}: freed`));
});

// ── Acceptance 4: an accidental sudo invocation, no override, is refused ───────────────────────

test("sudo with no override is refused rather than redirected", () => {
  const bin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-sudo-bin-`));
  writeIdStub(bin);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, SUDO_USER: "craigoleyagent" };
  // The guard fires only when EVERY RMD_*_DIR override is absent — strip whatever this test
  // process's own environment happens to carry, or the refusal could silently step aside.
  for (const key of ["RMD_STATE_DIR", "RMD_CLAUDE_DIR", "RMD_CODEX_DIR", "RMD_CONTAINER_CONFIG_DIR", "RMD_OP_DIR"]) {
    delete env[key];
  }
  const r = spawnSync("bash", [SCRIPT, "--dry-run"], { encoding: "utf8", cwd: REPO_ROOT, env });
  assert.equal(r.status, 2, "an accidental sudo invocation with no override must refuse, not proceed");
  assert.match(r.stderr ?? "", /REFUSING — running via sudo as root/);
  assert.match(r.stderr ?? "", /craigoleyagent/, "the refusal must name the owning user");
});

test("sudo WITH an explicit RMD_*_DIR override proceeds rather than refusing", () => {
  const bin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-update-sudo-bin-`));
  writeIdStub(bin);
  const dockerRoot = writeStubs(bin);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    SUDO_USER: "craigoleyagent",
    RMD_STATE_DIR: dockerRoot, // any real directory — the override itself is what matters here
  };
  const r = spawnSync("bash", [SCRIPT, "--dry-run"], { encoding: "utf8", cwd: REPO_ROOT, env });
  assert.notEqual(r.status, 2, "a deliberate override must step the refusal aside");
  assert.doesNotMatch(r.stderr ?? "", /REFUSING — running via sudo/);
});
