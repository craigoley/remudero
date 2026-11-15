import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * W1-T12409. The nightly agent history reclaim (section 4b of deploy/host-update.sh) removed every
 * file older than 14 days in the whole Codex home. That home also holds the Codex login
 * (auth.json), its config, installation_id, the installed CLI and work checkouts. And a test that
 * spread the real HOME into a `--reclaim-only` run walked and pruned the real ~/.codex.
 *
 * Every run here uses a temp HOME, so a broken guard can only touch the temp files.
 */

const SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");
const DAYS = 24 * 60 * 60 * 1000;

/** A `docker` that reports no fleet container (`good`) or one live fleet container (`live`). */
function writeDockerStub(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'case "$1 $2" in',
    '  "info --format")  echo "$STUB_REC"; exit 0 ;;',
    '  "system df")      echo "TYPE TOTAL ACTIVE SIZE"; exit 0 ;;',
    "esac",
    'case "$1" in',
    '  ps) case "$STUB_MODE" in live) echo c0ffee ;; esac; exit 0 ;;',
    '  inspect) case "$STUB_MODE" in live) echo "/ad-hoc|rmd-local:latest|/home/node/Remudero " ;; esac; exit 0 ;;',
    '  image) if [ "$2" = "inspect" ]; then exit 0; fi; echo "Total reclaimed space: 0B"; exit 0 ;;',
    '  container|builder) echo "Total reclaimed space: 0B"; exit 0 ;;',
    "  run)",
    '    for a in "$@"; do case "$a" in *:/rmd-snapshot/backups) b="${a%%:*}" ;; esac; done',
    '    n=state-backup.2026-01-01T00-00-00-000Z; mkdir -p "$b/$n" && echo stub > "$b/$n/ledger.ndjson"',
    '    echo "RMD_STATE_SNAPSHOT $n 1"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the real script with `--reclaim-only`, a temp HOME, and no inherited agent history paths. */
function runReclaim(home: string, env: NodeJS.ProcessEnv, opts: { dryRun?: boolean; mode?: "good" | "live" } = {}): Run {
  const bin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ah-keep-bin-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ah-keep-rec-`));
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ah-keep-state-`));
  writeDockerStub(bin);
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["RMD_CODEX_DIR", "RMD_CLAUDE_DIR", "RMD_AGENT_HISTORY_DIRS"]) delete base[key];
  const args = [SCRIPT, "--reclaim-only", ...(opts.dryRun ? ["--dry-run"] : [])];
  const r = spawnSync("bash", args, {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...base,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_MODE: opts.mode ?? "good",
      RMD_STATE_DIR: state,
      RMD_GIT_RECLAIM_DIRS: gitRepo({ kind: "ah-keep-reclaim-target" }).dir,
      RMD_STATE_SNAPSHOT_RECEIPT: join(rec, "state-snapshot.receipt"),
      ...env,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Write a 1 KiB file `daysOld` days old, making its folder first. */
function file(path: string, daysOld: number): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x".repeat(1024));
  const t = new Date(Date.now() - daysOld * DAYS);
  utimesSync(path, t, t);
  return path;
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ah-keep-home-`));
}

/** A Codex home the way the Azure host holds one, every file 30 days old except one session. */
function codexHome(home: string) {
  const dir = join(home, ".codex");
  return {
    dir,
    history: [
      file(join(dir, "sessions", "2026", "10", "01", "rollout-old.jsonl"), 30),
      file(join(dir, "log", "codex-tui.log"), 30),
    ],
    fresh: file(join(dir, "sessions", "2026", "11", "12", "rollout-new.jsonl"), 0),
    kept: [
      file(join(dir, "auth.json"), 30),
      file(join(dir, "config.toml"), 30),
      file(join(dir, "rmd_registry_7f305fceb975431e95da6cb339108d37.config.toml"), 30),
      file(join(dir, "installation_id"), 30),
      file(join(dir, "packages", "standalone", "releases", "0.167.0", "codex"), 30),
      file(join(dir, "work-artifacts", "checkout", "README.md"), 30),
    ],
  };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("W1-T12409 criterion 1: in the Codex home only the history folders lose old files", () => {
  const home = tempHome();
  const codex = codexHome(home);
  const run = runReclaim(home, { RMD_CODEX_DIR: codex.dir, RMD_CLAUDE_DIR: join(home, ".claude") });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  for (const path of codex.history) assert.ok(!existsSync(path), `an old history file is removed: ${path}`);
  for (const path of codex.kept) assert.ok(existsSync(path), `an old file outside the history folders is kept: ${path}`);
  assert.ok(existsSync(codex.fresh), "a new session is kept");
  assert.match(run.stdout, new RegExp(`agent history reclaim — ${esc(codex.dir)}: freed 2\\.0KB across 2 file\\(s\\)`));

  const dryHome = tempHome();
  const dry = codexHome(dryHome);
  const dryRun = runReclaim(dryHome, { RMD_CODEX_DIR: dry.dir, RMD_CLAUDE_DIR: join(dryHome, ".claude") }, { dryRun: true });
  assert.equal(dryRun.status, 0, dryRun.stdout + dryRun.stderr);
  assert.match(dryRun.stdout, new RegExp(`\\(DRY RUN\\) — ${esc(dry.dir)}: would free 2\\.0KB across files older than 14d`));
  for (const path of [...dry.history, ...dry.kept]) assert.ok(existsSync(path), `a dry run removes nothing: ${path}`);
});

test("W1-T12409 criterion 2: no tree loses a login or config file by name", () => {
  const home = tempHome();
  const tree = join(home, "history-tree");
  const session = file(join(tree, "project", "old-session.jsonl"), 30);
  const kept = [
    file(join(tree, "auth.json"), 30),
    file(join(tree, ".credentials.json"), 30),
    file(join(tree, "installation_id"), 30),
    file(join(tree, "project", "settings.toml"), 30),
  ];
  const run = runReclaim(home, { RMD_AGENT_HISTORY_DIRS: tree });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(!existsSync(session), "an old session in a tree that is not the Codex home is removed");
  for (const path of kept) assert.ok(existsSync(path), `a login or config file is kept by name: ${path}`);
});

test("W1-T12409 criterion 3: the old files the sweep keeps are reported as never-removed", () => {
  const home = tempHome();
  const codex = codexHome(home);
  const run = runReclaim(home, { RMD_CODEX_DIR: codex.dir, RMD_CLAUDE_DIR: join(home, ".claude") });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, new RegExp(
    `agent history reclaim — ${esc(codex.dir)}: could not reach 6\\.0KB — reason: never-removed \\(6 file\\(s\\)\\)`));
  assert.doesNotMatch(run.stdout, new RegExp(`${esc(codex.dir)}: could not reach 0\\.0KB — every byte was in scope`));

  const dryHome = tempHome();
  const dry = codexHome(dryHome);
  const dryRun = runReclaim(dryHome, { RMD_CODEX_DIR: dry.dir, RMD_CLAUDE_DIR: join(dryHome, ".claude") }, { dryRun: true });
  assert.match(dryRun.stdout, new RegExp(
    `agent history reclaim \\(DRY RUN\\) — ${esc(dry.dir)}: could not reach 6\\.0KB — reason: never-removed \\(6 file\\(s\\)\\)`));
});

test("W1-T12409 criterion 4: a test process never walks the agent history under its home", () => {
  for (const mode of ["good", "live"] as const) {
    const home = tempHome();
    const codexSession = file(join(home, ".codex", "sessions", "rollout-old.jsonl"), 30);
    const claudeSession = file(join(home, ".claude", "projects", "project", "old-session.jsonl"), 30);
    const run = runReclaim(home, { NODE_TEST_CONTEXT: "child-v8" }, { mode });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(existsSync(codexSession), `${mode}: a Codex session under HOME is not removed`);
    assert.ok(existsSync(claudeSession), `${mode}: a Claude session under HOME is not removed`);
    for (const tree of [join(home, ".codex"), join(home, ".claude", "projects")]) {
      assert.match(run.stdout, new RegExp(`agent history reclaim — ${esc(tree)}: skipped — a test process never walks`));
      assert.doesNotMatch(run.stdout + run.stderr, new RegExp(`${esc(tree)}: (freed|could not reach)`), `${mode}: ${tree} is not walked`);
    }
  }
});
