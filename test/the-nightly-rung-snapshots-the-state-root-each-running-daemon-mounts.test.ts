/**
 * W1-T5545 — THE NIGHTLY RUNG SNAPSHOTS THE STATE ROOT EACH RUNNING DAEMON MOUNTS.
 *
 * The cron line sets no RMD_STATE_DIR, so W1-T3677's snapshot read `${HOME}/rmd-state` — an empty
 * decoy — while the daemons mounted ~/rmd-state2, ~/rmd-site-state and
 * /mnt/rmd/remudero-console-state. The rung now derives its roots from the host side of every running
 * container's /home/node/Remudero mount, and snapshots each into its own `<root>/state-backups`.
 *
 * THE FIXTURE IS THE HOST'S SHAPE: HOME holds the decoy `rmd-state/state/` (empty), and the stubbed
 * docker reports four running containers — two daemons on two roots, a serve container sharing the
 * first root, and a cloudflared mounting nothing. The stub's `docker run` really runs the command it
 * is handed against this checkout (test/the-state-snapshot-actually-runs-on-this-host.test.ts's
 * technique), so every archive comes from the real snapshotState. Falsifier: restore the
 * `${HOME}/rmd-state` fallback with no mount derivation, and neither mounted root is snapshotted.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");

/** `docker run` as the image would run it: `-v` mounts and `/app` rewritten onto this checkout. */
const RUN_HELPER = `
import { spawnSync } from "node:child_process";
const [repoRoot, ...argv] = process.argv.slice(2);
const mounts = [];
let i = 0;
for (; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--rm") continue;
  if (["--pull", "--network", "-w", "--entrypoint"].includes(a)) { i++; continue; }
  if (a === "-v") { const [src, dst] = argv[++i].split(":"); mounts.push([dst, src]); continue; }
  break;
}
const cmd = argv.slice(i + 1).map((arg) => {
  let out = arg.split("/app/").join(repoRoot + "/");
  for (const [dst, src] of mounts) out = out.split(dst).join(src);
  return out;
});
process.exit(spawnSync(process.execPath, cmd, { cwd: repoRoot, stdio: "inherit" }).status ?? 1);
`;

/** STUB_MOUNTS is `<id>=<host source>` pairs; an id with an empty source mounts no state. */
function writeStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "${a//$\'\\n\'/ }" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"',
    'case "$1 $2" in "info --format") echo "$STUB_REC"; exit 0 ;; "system df") echo "TYPE TOTAL"; exit 0 ;; esac',
    'case "$1" in',
    '  ps) for p in $STUB_MOUNTS; do echo "${p%%=*}"; done; exit 0 ;;',
    '  inspect)',
    '    id="${!#}"; src=""; for p in $STUB_MOUNTS; do [ "${p%%=*}" = "$id" ] && src="${p#*=}"; done',
    '    case "$*" in *.Source*) echo "$src" ;; *) [ -n "$src" ] && echo "/$id|rmd-local:latest|/home/node/Remudero " || echo "/$id|cloudflare/cloudflared|" ;; esac; exit 0 ;;',
    '  run) shift; exec node "$STUB_DIR/docker-run.mjs" "$STUB_REPO_ROOT" "$@" ;;',
    '  image) [ "$2" = inspect ] && exit 0; echo "Total reclaimed space: 0B"; exit 0 ;;',
    "esac",
    'echo "Total reclaimed space: 0B"; exit 0',
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "docker-run.mjs"), RUN_HELPER);
}

function stateRoot(parent: string, name: string, task: string): string {
  const root = join(parent, name);
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "ledger.ndjson"), `${JSON.stringify({ step: "run.start", task })}\n`);
  return root;
}

function runRung(home: string, mounts: string): { status: number; stdout: string; stderr: string; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mounted-roots-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mounted-roots-rec-`));
  writeStubs(dir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    STUB_REC: rec,
    STUB_DIR: dir,
    STUB_REPO_ROOT: REPO_ROOT,
    STUB_MOUNTS: mounts,
    RMD_GIT_RECLAIM_DIRS: gitRepo({ kind: "mounted-roots-reclaim-target" }).dir,
    RMD_AGENT_HISTORY_DIRS: join(home, "no-agent-history"),
  };
  // The cron's environment: no RMD_STATE_DIR, no backup-dir override.
  delete env.RMD_STATE_DIR;
  delete env.RMD_STATE_BACKUP_DIR;
  const r = spawnSync("bash", [SCRIPT, "--reclaim-only"], { encoding: "utf8", cwd: REPO_ROOT, env });
  const callsFile = join(rec, "calls");
  const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").split("\n").filter(Boolean) : [];
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", calls };
}

const snapshotsIn = (root: string) => {
  const dir = join(root, "state-backups");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("state-backup.")) : [];
};

test("the nightly rung snapshots the state root each running daemon mounts", () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mounted-roots-home-`));
  mkdirSync(join(home, "rmd-state", "state"), { recursive: true }); // the decoy, empty
  const core = stateRoot(home, "rmd-state2", "core");
  const site = stateRoot(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mounted-roots-site-`)), "site-state", "site");
  const run = runRung(home, `daemon=${core} site=${site} serve=${core}/ tunnel=`);

  assert.equal(run.status, 0, `every mounted root snapshots, so the rung succeeds:\n${run.stderr}`);
  for (const [root, task] of [[core, "core"], [site, "site"]]) {
    const snaps = snapshotsIn(root);
    assert.equal(snaps.length, 1, `${root} is snapshotted exactly once, though two containers mount it`);
    const copied = readFileSync(join(root, "state-backups", snaps[0], "ledger.ndjson"), "utf8");
    assert.equal(JSON.parse(copied).task, task, "each archive holds its OWN root's ledger");
    assert.match(run.stdout, new RegExp(`${snaps[0]} verified`));
  }
  assert.equal(run.calls.filter((c) => c.startsWith("docker\trun\t")).length, 2, "one snapshot per distinct root");
  assert.deepEqual(snapshotsIn(join(home, "rmd-state")), [], "the empty ~/rmd-state decoy is not what gets backed up");
  assert.doesNotMatch(run.stdout, /using .*rmd-state$/m, "no fallback to the default root while daemons mount real ones");
});

test("with no container mounting state and no RMD_STATE_DIR, the rung falls back to ~/rmd-state and says so", () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mounted-roots-fallback-`));
  const fallback = stateRoot(home, "rmd-state", "fallback");
  const run = runRung(home, "tunnel=");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no running container mounts \/home\/node\/Remudero and RMD_STATE_DIR is unset; using .*rmd-state/);
  assert.equal(snapshotsIn(fallback).length, 1);
});
