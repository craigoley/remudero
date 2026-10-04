/**
 * W1-T5545 — A DERIVED STATE DIR WITH NO LEDGER BESIDE A SIBLING THAT HAS ONE FAILS THE RUNG.
 *
 * W1-T3677's drift check (`find_sibling_with_marker`) ran only when the derived root had NO state/
 * at all. On the host ~/rmd-state HAS a state/ — empty — so the decoy passed while the real 1.4 GB
 * ledger sat next door in ~/rmd-state2 with no backup. The check now asks whether state/ holds a
 * ledger, for every derived root, and a miss beside a sibling that has one fails the rung, naming
 * both paths. The harness is the stubbed-docker rung of
 * test/the-nightly-rung-snapshots-the-state-root-each-running-daemon-mounts.test.ts.
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
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}no-ledger-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}no-ledger-rec-`));
  writeStubs(dir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    STUB_REC: rec,
    STUB_DIR: dir,
    STUB_REPO_ROOT: REPO_ROOT,
    STUB_MOUNTS: mounts,
    RMD_GIT_RECLAIM_DIRS: gitRepo({ kind: "no-ledger-reclaim-target" }).dir,
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

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("a derived state dir whose state holds no ledger beside a sibling that does fails the rung", () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}no-ledger-home-`));
  const decoy = join(home, "rmd-state");
  mkdirSync(join(decoy, "state"), { recursive: true }); // EXISTS, holds no ledger — the host's shape
  writeFileSync(join(decoy, "state", "inbox-proposals.json"), "{}\n");
  const real = stateRoot(home, "rmd-state2", "core");
  const run = runRung(home, "tunnel="); // nothing mounts state, so the cron's default root is derived

  assert.notEqual(run.status, 0, "a snapshot that missed the real ledger must not report success");
  assert.match(run.stderr, /STATE SNAPSHOT FAILED/);
  assert.match(run.stderr, new RegExp(esc(join(decoy, "state", "ledger.ndjson"))), "names the derived root's missing ledger");
  assert.match(run.stderr, new RegExp(esc(join(real, "state", "ledger.ndjson"))), "names the sibling that holds the ledger");
  assert.match(run.stderr, /nightly STATE SNAPSHOT did not leave a verified, recent archive/);
  assert.equal(run.calls.filter((c) => c.startsWith("docker\trun\t")).length, 0, "the decoy is not snapshotted");
  assert.deepEqual(snapshotsIn(decoy), []);
});

test("the same miss on a root a running container mounts fails too, while its healthy roots still snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}no-ledger-mounted-`));
  const empty = join(home, "rmd-state");
  mkdirSync(join(empty, "state"), { recursive: true });
  stateRoot(home, "rmd-state2", "sibling");
  const other = stateRoot(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}no-ledger-other-`)), "site-state", "site");
  const run = runRung(home, `daemon=${empty} site=${other}`);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, new RegExp(`${esc(join(empty, "state", "ledger.ndjson"))} does not exist or is empty`));
  assert.equal(snapshotsIn(other).length, 1, "one root's miss does not cost the others their snapshot");
});

test("control: a derived root that holds its own ledger snapshots normally beside a sibling", () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}no-ledger-control-`));
  const own = stateRoot(home, "rmd-state", "own");
  stateRoot(home, "rmd-state2", "sibling");
  const run = runRung(home, "tunnel=");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(snapshotsIn(own).length, 1, "the sibling scan fires only when the derived root lacks a ledger");
});
