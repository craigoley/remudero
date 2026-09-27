/**
 * W1-T3677 — THE STATE BACKUP WAS BUILT, TESTED, MARKED MERGED AND HAD NEVER RUN.
 *
 * `snapshotState` / `restoreState` (src/lib/ledger.ts, W1-T234) had zero callers outside
 * test/state-backup.test.ts: no timer invoked them and no snapshot existed on the host. Every W1-T234
 * criterion was proved against a temporary fixture, so all of them could pass forever on a host that
 * had never taken a snapshot. The nightly rung — `deploy/host-update.sh --reclaim-only` — now takes
 * one (section 3a), and these tests bind to THAT INVOCATION, never to the archive format.
 *
 * THE TECHNIQUE IS test/host-update-reclaim.test.ts's: stub `docker` on PATH, run the REAL script,
 * record every call. One addition makes the first test mean something: the stub's `docker run` does
 * not pretend. It maps the `-v` mounts and the image's `/app` onto this checkout and runs the
 * command the script handed it, so the archive on disk comes from the REAL `snapshotState`. Remove
 * the invocation from the rung and no archive appears — while test/state-backup.test.ts still
 * passes, which is exactly the condition this file exists to make impossible.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");
const LEDGER = '{"step":"run.start","task":"W1-T3677"}\n{"step":"run.end","task":"W1-T3677"}\n';

interface Call {
  bin: string;
  argv: string[];
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  calls: Call[];
  backups: string;
}

/**
 * `docker run` as the image would execute it: every `-v <host>:<container>[:mode]` is applied by
 * rewriting the container path to the host path, and `/app` (deploy/Dockerfile's WORKDIR, where the
 * image's source tree lives) becomes this checkout. The entrypoint is resolved to THIS node.
 */
const RUN_HELPER = `
import { spawnSync } from "node:child_process";
const [repoRoot, ...argv] = process.argv.slice(2);
const mounts = [];
let entrypoint = "";
let i = 0;
for (; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--rm") continue;
  if (["--pull", "--network", "-w", "--user", "-e"].includes(a)) { i++; continue; }
  if (a === "--entrypoint") { entrypoint = argv[++i]; continue; }
  if (a === "-v") { const [src, dst] = argv[++i].split(":"); mounts.push([dst, src]); continue; }
  break;
}
const cmd = argv.slice(i + 1).map((arg) => {
  let out = arg.split("/app/").join(repoRoot + "/");
  for (const [dst, src] of mounts) out = out.split(dst).join(src);
  return out;
});
if (entrypoint !== "node") { console.error("stub: unexpected entrypoint " + entrypoint); process.exit(127); }
const r = spawnSync(process.execPath, cmd, { cwd: repoRoot, stdio: "inherit" });
process.exit(r.status ?? 1);
`;

function writeStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "${a//$\'\\n\'/ }" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"',
    'case "$1 $2" in',
    '  "info --format")  echo "$STUB_REC"; exit 0 ;;',
    '  "system df")      echo "TYPE TOTAL ACTIVE SIZE"; exit 0 ;;',
    "esac",
    'case "$1" in',
    '  ps) case "$STUB_MODE" in live) echo c0ffee ;; esac; exit 0 ;;',
    '  inspect) case "$STUB_MODE" in live) echo "/remudero-daemon|rmd-local:latest|/home/node/Remudero " ;; esac; exit 0 ;;',
    "  run)",
    '    case "$STUB_MODE" in',
    // The image was already pruned, or never pulled: `--pull never` refuses exactly like this.
    '      no-image) echo "docker: Error response from daemon: No such image: reg.azurecr.io/remudero:latest." >&2; exit 125 ;;',
    // A run that claims success and publishes nothing — the host must not take its word for it.
    '      silent) exit 0 ;;',
    "    esac",
    '    shift; exec node "$STUB_DIR/docker-run.mjs" "$STUB_REPO_ROOT" "$@" ;;',
    '  image) [ "$2" = inspect ] && exit 0; echo "Total reclaimed space: 0B"; exit 0 ;;',
    '  container|builder) echo "Total reclaimed space: 0B"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
  writeFileSync(join(dir, "docker-run.mjs"), RUN_HELPER);
}

/** A state volume holding a real `state/` with a ledger and a 0600 token file. */
function stateVolume(): string {
  const vol = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}snapshot-vol-`));
  mkdirSync(join(vol, "state", "locks"), { recursive: true });
  writeFileSync(join(vol, "state", "ledger.ndjson"), LEDGER);
  writeFileSync(join(vol, "state", "inbox-proposals.json"), '{"P37":{}}\n');
  writeFileSync(join(vol, "state", "locks", "W1-T3677.lock"), "123\n");
  return vol;
}

function runRung(mode: string, vol: string, args: string[] = ["--reclaim-only"], extraEnv: NodeJS.ProcessEnv = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}snapshot-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}snapshot-rec-`));
  writeStubs(dir);
  // A real git reclaim target, so section 4a's all-miss refusal cannot redden a run for a reason
  // these tests are not about.
  const gitTarget = gitRepo({ kind: "snapshot-reclaim-target" });
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_DIR: dir,
      STUB_MODE: mode,
      STUB_REPO_ROOT: REPO_ROOT,
      RMD_STATE_DIR: vol,
      RMD_GIT_RECLAIM_DIRS: gitTarget.dir,
      RMD_AGENT_HISTORY_DIRS: join(vol, "no-agent-history"),
      ...extraEnv,
    },
  });
  const callsFile = join(rec, "calls");
  const calls = existsSync(callsFile)
    ? readFileSync(callsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [bin, ...argv] = l.split("\t");
          return { bin, argv };
        })
    : [];
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", calls, backups: join(vol, "state-backups") };
}

const isSnapshotRun = (c: Call) => c.bin === "docker" && c.argv[0] === "run";
const isImagePrune = (c: Call) => c.bin === "docker" && c.argv[0] === "image" && c.argv.includes("prune");
const snapshotsIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("state-backup.")).sort() : []);

/** Seed a snapshot dir named the way snapshotState names one, `ageHours` old by mtime. */
function seedSnapshot(backups: string, when: Date, ageHours: number): string {
  const name = `state-backup.${when.toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(join(backups, name), { recursive: true });
  writeFileSync(join(backups, name, "ledger.ndjson"), "seeded\n");
  const t = new Date(Date.now() - ageHours * 3600_000);
  utimesSync(join(backups, name), t, t);
  return name;
}

// ── 1. THE RUNG INVOKES THE SNAPSHOT ─────────────────────────────────────────────────────────

test("the nightly rung invokes the state snapshot", () => {
  const vol = stateVolume();
  assert.deepEqual(snapshotsIn(join(vol, "state-backups")), [], "control: the host starts with no snapshot");
  const run = runRung("good", vol);
  assert.equal(run.status, 0, `the rung must succeed when the snapshot does:\n${run.stderr}`);

  const snaps = snapshotsIn(run.backups);
  assert.equal(snaps.length, 1, "the host must have a snapshot it did not have before");
  const archive = join(run.backups, snaps[0]);
  assert.equal(readFileSync(join(archive, "ledger.ndjson"), "utf8"), LEDGER, "the ledger is copied byte-for-byte");
  assert.ok(existsSync(join(archive, "inbox-proposals.json")), "the proposals register is copied too");
  assert.ok(existsSync(join(archive, "locks", "W1-T3677.lock")), "nested state is copied too");
  assert.match(run.stdout, new RegExp(`state snapshot — .*${snaps[0]} verified`));

  const snapRun = run.calls.find(isSnapshotRun);
  assert.ok(snapRun, "the snapshot goes through docker run");
  assert.ok(snapRun.argv.includes(`${join(vol, "state")}:/rmd-snapshot/state:ro`), "state/ must be mounted READ-ONLY");
  assert.ok(snapRun.argv.includes("never"), "the snapshot must never pull an image");
  const runIdx = run.calls.findIndex(isSnapshotRun);
  const pruneIdx = run.calls.findIndex(isImagePrune);
  assert.ok(pruneIdx > 0, "control: the image prune ran");
  assert.ok(runIdx < pruneIdx, "the snapshot must run BEFORE the image prune removes the image it runs in");
  assert.equal(readFileSync(join(vol, "state", "ledger.ndjson"), "utf8"), LEDGER, "the source ledger is untouched");
});

test("a verified snapshot expires only its own oldest snapshots beyond the keep count", () => {
  const vol = stateVolume();
  const backups = join(vol, "state-backups");
  const seeded = [1, 2, 3].map((d) => seedSnapshot(backups, new Date(Date.UTC(2026, 0, d)), 24 * (30 - d)));
  mkdirSync(join(backups, "operator-notes"), { recursive: true });
  const run = runRung("good", vol, ["--reclaim-only"], { RMD_STATE_BACKUP_KEEP: "2" });
  assert.equal(run.status, 0, run.stderr);
  const after = snapshotsIn(backups);
  assert.equal(after.length, 2, "exactly the keep count remains");
  assert.ok(after.includes(seeded[2]), "the newest seeded snapshot is kept");
  assert.ok(!after.includes(seeded[0]) && !after.includes(seeded[1]), "the two oldest are expired");
  assert.ok(existsSync(join(backups, "operator-notes")), "a directory the snapshot did not write is never touched");
  assert.equal(readFileSync(join(vol, "state", "ledger.ndjson"), "utf8"), LEDGER, "state/ itself is never touched");
});

test("--dry-run --reclaim-only names the snapshot and takes none", () => {
  const vol = stateVolume();
  const run = runRung("good", vol, ["--reclaim-only", "--dry-run"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /state snapshot \(DRY RUN\) — would copy/);
  assert.equal(run.calls.filter(isSnapshotRun).length, 0, "a dry run issues no docker run");
  assert.deepEqual(snapshotsIn(run.backups), []);
});

test("a host with no state/ at all is a note, not a failure, and runs nothing", () => {
  const vol = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}snapshot-empty-vol-`));
  const run = runRung("good", vol);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /state snapshot — .* does not exist on this host; nothing to snapshot/);
  assert.equal(run.calls.filter(isSnapshotRun).length, 0);
});

test("a state volume with no state/ beside a sibling that has a ledger fails the rung, naming the sibling", () => {
  const parent = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}snapshot-drift-`));
  const derived = join(parent, "rmd-state");
  const sibling = join(parent, "rmd-state2");
  mkdirSync(derived, { recursive: true });
  mkdirSync(join(sibling, "state"), { recursive: true });
  writeFileSync(join(sibling, "state", "ledger.ndjson"), LEDGER);
  const run = runRung("good", derived);
  assert.notEqual(run.status, 0, "a snapshot that missed the real ledger must not report success");
  assert.match(run.stderr, /STATE SNAPSHOT FAILED/);
  assert.match(run.stderr, new RegExp(join(sibling, "state", "ledger.ndjson").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(run.calls.filter(isSnapshotRun).length, 0);
});

// ── 2. A FAILED SNAPSHOT FAILS THE RUNG LOUDLY ─────────────────────────────────────────────────

test("a failed snapshot fails the nightly rung loudly", () => {
  // A REAL snapshotState failure, not a simulated one: an empty state/ would publish an empty
  // archive, and snapshotState throws StateBackupError rather than do that.
  const vol = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}snapshot-fail-vol-`));
  mkdirSync(join(vol, "state"), { recursive: true });
  const run = runRung("good", vol);
  assert.notEqual(run.status, 0, "a failed snapshot must not let the nightly run report success");
  assert.match(run.stderr, /STATE SNAPSHOT FAILED — the snapshot exited 1/);
  assert.match(run.stderr, /StateBackupError: state backup: snapshot of .* would be an empty archive/, "the cause is shown");
  assert.match(run.stderr, /nightly STATE SNAPSHOT did not leave a verified, recent archive/);
  assert.deepEqual(snapshotsIn(join(vol, "state-backups")), [], "nothing is published");
  assert.ok(run.calls.findIndex(isImagePrune) >= 0, "the disk reclaim still runs — pressure does not wait on a backup");
});

test("a snapshot whose image is gone fails the rung loudly instead of pulling one", () => {
  const vol = stateVolume();
  const run = runRung("no-image", vol);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /STATE SNAPSHOT FAILED — the snapshot exited 125/);
  assert.match(run.stderr, /No such image/);
});

test("a snapshot that exits 0 but publishes no archive is not believed", () => {
  const vol = stateVolume();
  const run = runRung("silent", vol);
  assert.notEqual(run.status, 0, "a zero exit with nothing on disk is not a backup");
  assert.match(run.stderr, /exited 0 but published no archive this host can see/);
});

test("a failed snapshot expires nothing", () => {
  const vol = stateVolume();
  const backups = join(vol, "state-backups");
  const seeded = [1, 2, 3].map((d) => seedSnapshot(backups, new Date(Date.UTC(2026, 0, d)), 24 * (30 - d)));
  const run = runRung("no-image", vol, ["--reclaim-only"], { RMD_STATE_BACKUP_KEEP: "1" });
  assert.notEqual(run.status, 0);
  assert.deepEqual(snapshotsIn(backups), seeded, "old snapshots are the only copies left when tonight's failed");
});

// ── 3. NO SNAPSHOT WHILE A FLEET CONTAINER IS LIVE ─────────────────────────────────────────────

test("the snapshot refuses while a fleet container is live", () => {
  const vol = stateVolume();
  const run = runRung("live", vol);
  assert.equal(run.calls.filter(isSnapshotRun).length, 0, "no snapshot may be taken beside a live container");
  assert.deepEqual(snapshotsIn(run.backups), [], "and no archive of a possibly half-written ledger exists");
  assert.match(run.stderr, /REFUSING state snapshot — a fleet container is RUNNING/);
  assert.match(run.stderr, /rmd-local:latest/, "the refusal names the live holder");
  // With no recent snapshot to fall back on, the refusal leaves the ledger unprotected: loud.
  assert.notEqual(run.status, 0, "a refusal that leaves no recent snapshot must not report success");
  assert.match(run.stderr, /STATE SNAPSHOT MISSED — nothing under .* is newer than 48h/);
});

test("a live refusal with a recent snapshot still standing does not fail the rung", () => {
  const vol = stateVolume();
  const fresh = seedSnapshot(join(vol, "state-backups"), new Date(), 2);
  const run = runRung("live", vol);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /REFUSING state snapshot/);
  assert.match(run.stderr, new RegExp(`still stands: .*${fresh}`));
  assert.deepEqual(snapshotsIn(join(vol, "state-backups")), [fresh], "the refusal writes and expires nothing");
});

test("a live refusal whose newest snapshot is past the age bound fails the rung", () => {
  const vol = stateVolume();
  seedSnapshot(join(vol, "state-backups"), new Date(Date.now() - 72 * 3600_000), 72);
  const run = runRung("live", vol);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /STATE SNAPSHOT MISSED/);
});
