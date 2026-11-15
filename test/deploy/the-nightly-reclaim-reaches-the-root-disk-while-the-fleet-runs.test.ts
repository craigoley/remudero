import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * W1-T12495 — the nightly `--reclaim-only` run refused its git rung and its agent history rung
 * whenever one fleet container was up, and the fleet is always up. Now each checkout proves itself
 * idle and each file proves itself closed, and nothing that can prune or compact runs beside a live
 * fleet. Every case drives the real deploy/host-update.sh with `docker`, `lsof` and a recording
 * `git` on PATH; no case touches the real host.
 */

const SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");
const UID = String(process.getuid?.() ?? 1000);
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const CONTAINER_CODEX = "/home/node/.codex";

function realBinary(name: string): string {
  const r = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const p = (r.stdout ?? "").trim();
  assert.ok(p, `no real ${name} on PATH`);
  return p;
}

function writeStubs(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'case "$1 $2" in',
    '  "info --format")  echo "$STUB_REC"; exit 0 ;;',
    '  "system df")      echo "TYPE TOTAL ACTIVE SIZE"; exit 0 ;;',
    "esac",
    'case "$1" in',
    '  ps) [ "$STUB_MODE" = live ] && echo c0ffee; exit 0 ;;',
    "  inspect)",
    '    [ "$STUB_MODE" = live ] || exit 0',
    '    case "$*" in',
    '      *Config.User*) printf "%s|%s\\n" "$STUB_USER" "$STUB_MOUNTS" ;;',
    "      *.Source*) echo ;;",
    '      *) echo "/remudero-daemon|rmd-local:latest|/home/node/Remudero " ;;',
    "    esac; exit 0 ;;",
    '  image) [ "$2" = inspect ] && exit 0; echo "Total reclaimed space: 0B"; exit 0 ;;',
    '  container|builder) echo "Total reclaimed space: 0B"; exit 0 ;;',
    "  run)",
    '    for a in "$@"; do case "$a" in *:/rmd-snapshot/backups) b="${a%%:*}" ;; esac; done',
    '    n=state-backup.2026-01-01T00-00-00-000Z; mkdir -p "$b/$n" && echo stub > "$b/$n/ledger.ndjson"',
    '    echo "RMD_STATE_SNAPSHOT $n 1"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
  const lsof = [
    "#!/usr/bin/env bash",
    'printf "%s\\n" "$*" >> "$STUB_REC/lsof-calls"',
    'printf "%s" "${STUB_LSOF_OUT:-}"',
    'exit "${STUB_LSOF_RC:-0}"',
    "",
  ].join("\n");
  const git = [
    "#!/usr/bin/env bash",
    '{ printf "git"; for a in "$@"; do printf "\\t%s" "$a"; done; printf "\\n"; } >> "$STUB_REC/git-calls"',
    `exec "${realBinary("git")}" "$@"`,
    "",
  ].join("\n");
  for (const [name, body] of Object.entries({ docker, lsof, git })) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
}

interface Run {
  status: number;
  out: string;
  stdout: string;
  gitCalls: string[][];
  lsofCalls: string[];
}

interface RunOpts {
  mode: "good" | "live";
  gitDirs: string[];
  trees?: string[];
  lsofOut?: string;
  lsofRc?: number;
  user?: string;
  mounts?: string;
  dryRun?: boolean;
}

function reclaim(opts: RunOpts): Run {
  const bin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reach-root-bin-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reach-root-rec-`));
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reach-root-state-`));
  writeStubs(bin);
  const args = [SCRIPT, "--reclaim-only", ...(opts.dryRun ? ["--dry-run"] : [])];
  const r = spawnSync("bash", args, {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_MODE: opts.mode,
      STUB_USER: opts.user ?? `${UID}:${UID}`,
      STUB_MOUNTS: opts.mounts ?? "",
      STUB_LSOF_OUT: opts.lsofOut ?? "",
      STUB_LSOF_RC: String(opts.lsofRc ?? 0),
      RMD_STATE_DIR: state,
      RMD_GIT_RECLAIM_DIRS: opts.gitDirs.join(":"),
      RMD_AGENT_HISTORY_DIRS: (opts.trees ?? [join(state, "no-agent-history")]).join(":"),
      RMD_STATE_SNAPSHOT_RECEIPT: join(rec, "state-snapshot.receipt"),
    },
  });
  const read = (name: string) => (existsSync(join(rec, name)) ? readFileSync(join(rec, name), "utf8").split("\n").filter(Boolean) : []);
  return {
    status: r.status ?? -1,
    out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
    stdout: r.stdout ?? "",
    gitCalls: read("git-calls").map((l) => l.split("\t").slice(1)),
    lsofCalls: read("lsof-calls"),
  };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The script's own human_kb. */
function humanKb(kb: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  let k = kb;
  let i = 0;
  while (k >= 1024 && i < 3) {
    k /= 1024;
    i++;
  }
  return `${k.toFixed(1)}${units[i]}`;
}

/** Set the mtime of a path and everything under it to `ms` ago. */
function age(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  if (statSync(path).isDirectory()) for (const e of readdirSync(path)) age(join(path, e), ms);
  utimesSync(path, when, when);
}

/** Calls that could remove an object: gc, prune or repack outside `git maintenance`. */
function pruningCalls(run: Run): string[][] {
  return run.gitCalls.filter((argv) => argv.some((a) => a === "gc" || a === "prune" || a === "repack"));
}
function maintenanceCalls(run: Run, dir: string): string[][] {
  return run.gitCalls.filter((argv) => argv[0] === "-C" && argv[1] === dir && argv[2] === "maintenance");
}

interface Target {
  repo: GitRepo;
  dangling: string;
}

/**
 * A checkout shaped like a clone (its history in a pack) with a stranded gc.log and one unreachable
 * loose object old enough for `git gc` to prune it. Its whole git directory was last written two
 * hours ago, so it is idle.
 */
function idleTarget(kind: string): Target {
  const repo = gitRepo({ kind });
  repo.git("repack", "-a", "-d", "-q");
  const blob = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reach-root-blob-`)), "orphan.txt");
  writeFileSync(blob, `unreachable ${kind} ${Math.random()}\n`);
  const dangling = repo.git("hash-object", "-w", blob);
  writeFileSync(join(repo.dir, ".git", "gc.log"), "warning: There are too many unreachable loose objects\n");
  age(join(repo.dir, ".git"), 2 * 60 * MINUTE);
  age(join(repo.dir, ".git", "objects", dangling.slice(0, 2), dangling.slice(2)), 60 * DAY);
  return { repo, dangling };
}

function hasObject(c: Target): boolean {
  return spawnSync("git", ["-C", c.repo.dir, "cat-file", "-e", c.dangling]).status === 0;
}

/** An agent history tree with old session files. */
function historyTree(label: string, names: string[]): { dir: string; files: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reach-root-${label}-`));
  mkdirSync(join(dir, "sessions"));
  const files: Record<string, string> = {};
  for (const name of names) {
    const p = join(dir, "sessions", name);
    writeFileSync(p, "x".repeat(4096));
    age(p, 30 * DAY);
    files[name] = p;
  }
  return { dir, files };
}

/** A live SQLite database whose owning tool deleted most rows, leaving free pages in the file. */
function liveDatabase(dir: string): { path: string; freeBytes: number } {
  const path = join(dir, "thread_history_1.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE history(id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
  const insert = db.prepare("INSERT INTO history(id, body) VALUES (?, ?)");
  for (let i = 1; i <= 200; i++) insert.run(i, Buffer.alloc(8192, i % 251));
  db.exec("DELETE FROM history WHERE id > 20");
  db.close();
  const ro = new DatabaseSync(path, { readOnly: true });
  const page = (ro.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
  const free = (ro.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
  ro.close();
  assert.ok(free > 0, "the fixture database must hold free pages");
  return { path, freeBytes: page * free };
}

const lsofList = (paths: string[]) => paths.map((p, i) => `p${100 + i}\nn${p}\n`).join("");

// ── the git rung ────────────────────────────────────────────────────────────────────────────

test("W1-T12495 criterion 1: beside a live fleet an idle checkout gets only git maintenance, never git gc", () => {
  const c = idleTarget("reach-root-idle");
  const run = reclaim({ mode: "live", gitDirs: [c.repo.dir] });
  assert.equal(run.status, 0, run.out);
  assert.deepEqual(maintenanceCalls(run, c.repo.dir), [
    ["-C", c.repo.dir, "maintenance", "run", "--quiet", "--task=loose-objects", "--task=incremental-repack", "--task=pack-refs"],
  ]);
  assert.equal(pruningCalls(run).length, 0, `no gc, prune or repack call: ${JSON.stringify(run.gitCalls)}`);
  assert.ok(hasObject(c), "an unreachable object old enough for git gc to prune is kept");
  assert.ok(existsSync(join(c.repo.dir, ".git", "gc.log")), "the gc.log is not removed beside a live fleet");
  assert.match(run.stdout, new RegExp(`git reclaim — ${esc(c.repo.dir)}: freed \\S+ with 'git maintenance' beside a live fleet container; no gc, no prune`));
});

test("W1-T12495 criterion 2: beside a live fleet a checkout with a lock or a recent write is kept, with its reason", () => {
  const locked = idleTarget("reach-root-locked");
  writeFileSync(join(locked.repo.dir, ".git", "index.lock"), "");
  age(join(locked.repo.dir, ".git", "index.lock"), 2 * 60 * MINUTE);
  const gcPid = idleTarget("reach-root-gcpid");
  writeFileSync(join(gcPid.repo.dir, ".git", "gc.pid"), "123 host\n");
  age(join(gcPid.repo.dir, ".git", "gc.pid"), 2 * 60 * MINUTE);
  const recent = idleTarget("reach-root-recent");
  writeFileSync(join(recent.repo.dir, ".git", "FETCH_HEAD"), "");
  const linked = idleTarget("reach-root-linked");
  const wtParent = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reach-root-wt-`));
  linked.repo.addWorktree(join(wtParent, "lane"), "lane");
  age(join(linked.repo.dir, ".git"), 2 * 60 * MINUTE);
  writeFileSync(join(linked.repo.dir, ".git", "worktrees", "lane", "ORIG_HEAD"), "");
  const idle = idleTarget("reach-root-idle-control");

  const dirs = [locked, gcPid, recent, linked, idle].map((c) => c.repo.dir);
  const run = reclaim({ mode: "live", gitDirs: dirs });
  assert.equal(run.status, 0, run.out);
  const kept = (c: Target, reason: string) =>
    assert.match(run.stdout, new RegExp(`git reclaim — ${esc(c.repo.dir)}: kept — ${reason}`));
  kept(locked, "git-lock: index\\.lock is present");
  kept(gcPid, "git-lock: gc\\.pid is present");
  kept(recent, "recent-write: \\S+ was written in the last 30 minutes");
  kept(linked, "recent-write: worktrees/lane\\S* was written in the last 30 minutes");
  for (const c of [locked, gcPid, recent, linked]) {
    assert.equal(maintenanceCalls(run, c.repo.dir).length, 0, `no git command that writes runs in ${c.repo.dir}`);
    assert.ok(hasObject(c));
  }
  assert.equal(pruningCalls(run).length, 0);
  assert.equal(maintenanceCalls(run, idle.repo.dir).length, 1, "the idle checkout beside them is still reached");
});

// ── the agent history rung ──────────────────────────────────────────────────────────────────

test("W1-T12495 criterion 3: beside a live fleet the age sweep removes an old closed file and keeps an open one", () => {
  const c = idleTarget("reach-root-ah3");
  const t = historyTree("ah3", ["closed.jsonl", "open-on-host.jsonl", "open-in-container.jsonl"]);
  const run = reclaim({
    mode: "live",
    gitDirs: [c.repo.dir],
    trees: [t.dir],
    mounts: `${t.dir}>${CONTAINER_CODEX}`,
    lsofOut: lsofList([t.files["open-on-host.jsonl"], `${CONTAINER_CODEX}/sessions/open-in-container.jsonl`]),
  });
  assert.equal(run.status, 0, run.out);
  assert.deepEqual(run.lsofCalls, [UID === "0" ? "-Fn" : `-u ${UID} -Fn`], "one lsof list of this user's open files");
  assert.ok(!existsSync(t.files["closed.jsonl"]), "an old file no process holds open is removed");
  assert.ok(existsSync(t.files["open-on-host.jsonl"]), "an old file a host process holds open is kept");
  assert.ok(existsSync(t.files["open-in-container.jsonl"]), "an old file a container process holds at its container path is kept");
  assert.match(run.stdout, new RegExp(`agent history reclaim — ${esc(t.dir)}: freed 4\\.0KB across 1 file\\(s\\)`));
  assert.match(run.stdout, new RegExp(`agent history reclaim — ${esc(t.dir)}: could not reach 8\\.0KB — reason: open-by-process \\(2 file\\(s\\)\\)`));
  assert.match(run.stdout, /host-update: agent history reclaim: COMPLETED/);
});

test("W1-T12495 criterion 4: beside a live fleet an open-file list that cannot be read in full removes nothing", () => {
  const cases: { name: string; opts: Partial<RunOpts> }[] = [
    { name: "lsof fails", opts: { lsofRc: 1 } },
    { name: "lsof reports incomplete visibility", opts: { lsofOut: "p1\nn/proc/1/cwd (readlink: Permission denied)\n" } },
  ];
  if (UID !== "0") {
    cases.push({ name: "a fleet container runs as another user", opts: { user: "0:0" } });
    cases.push({ name: "a fleet container runs with no user set", opts: { user: "" } });
  }
  for (const { name, opts } of cases) {
    const c = idleTarget("reach-root-ah4");
    const a = historyTree("ah4a", ["old-a.jsonl"]);
    const b = historyTree("ah4b", ["old-b.jsonl"]);
    const run = reclaim({ mode: "live", gitDirs: [c.repo.dir], trees: [a.dir, b.dir], ...opts });
    assert.equal(run.status, 0, `${name}: ${run.out}`);
    assert.ok(existsSync(a.files["old-a.jsonl"]) && existsSync(b.files["old-b.jsonl"]), `${name}: nothing is removed`);
    for (const t of [a, b]) {
      assert.match(run.stdout, new RegExp(`agent history reclaim — ${esc(t.dir)}: could not reach 4\\.0KB — reason: open-check-unreadable \\(1 file\\(s\\)\\)`), name);
      assert.doesNotMatch(run.stdout, new RegExp(`${esc(t.dir)}: freed`), name);
    }
    assert.match(run.stdout, /host-update: agent history reclaim: REFUSED/, name);
    assert.doesNotMatch(run.stdout, /agent history reclaim: COMPLETED/, name);
  }
});

test("W1-T12495 criterion 5: beside a live fleet no database is compacted and only its free pages are counted", () => {
  const c = idleTarget("reach-root-ah5");
  const t = historyTree("ah5", []);
  const db = liveDatabase(t.dir);
  writeFileSync(join(t.dir, "today.jsonl"), "s".repeat(8192));
  const before = statSync(db.path).size;
  const run = reclaim({ mode: "live", gitDirs: [c.repo.dir], trees: [t.dir] });
  assert.equal(run.status, 0, run.out);
  assert.equal(statSync(db.path).size, before, "the database is not compacted");
  assert.doesNotMatch(run.stdout, /^ {2}compacted |: compacted \d/m, "no compaction line");
  const freeKb = humanKb(Math.floor(db.freeBytes / 1024));
  assert.match(run.stdout, new RegExp(`${esc(t.dir)}: could not reach ${esc(freeKb)} — reason: live-fleet-container \\(1 file\\(s\\)\\)`));
  assert.match(run.stdout, new RegExp(`${esc(t.dir)}: could not reach \\S+ — reason: live-rows \\(1 file\\(s\\)\\)`));
  assert.match(run.stdout, new RegExp(`${esc(t.dir)}: could not reach 8\\.0KB — reason: within-age-tier \\(1 file\\(s\\)\\)`));
  assert.ok(db.freeBytes < before, "the free pages are a part of the file, not the whole tree");
});

test("W1-T12495 criterion 6: a --reclaim-only run beside a live fleet never says no fleet container is running", () => {
  const c = idleTarget("reach-root-c6");
  const live = reclaim({ mode: "live", gitDirs: [c.repo.dir] });
  assert.match(live.out, /fleet container\(s\) RUNNING — proceeding anyway under --reclaim-only/);
  assert.doesNotMatch(live.out, /no fleet container running/);
  const idle = reclaim({ mode: "good", gitDirs: [idleTarget("reach-root-c6-good").repo.dir] });
  assert.match(idle.out, /no fleet container running/, "the line still prints when nothing is up");
});

test("W1-T12495 criterion 7: with no fleet container live the git rung runs git gc and the sweep and compaction run", () => {
  const c = idleTarget("reach-root-c7");
  const t = historyTree("c7", ["old.jsonl"]);
  const db = liveDatabase(t.dir);
  const before = statSync(db.path).size;
  const run = reclaim({ mode: "good", gitDirs: [c.repo.dir], trees: [t.dir], lsofOut: lsofList([t.files["old.jsonl"]]) });
  assert.equal(run.status, 0, run.out);
  assert.ok(run.gitCalls.some((argv) => argv[0] === "-C" && argv[1] === c.repo.dir && argv[2] === "gc"), "git gc runs");
  assert.ok(!hasObject(c), "git gc prunes the old unreachable object");
  assert.ok(!existsSync(join(c.repo.dir, ".git", "gc.log")), "the stranded gc.log is removed");
  assert.equal(run.lsofCalls.length, 0, "no open-file check runs when nothing is up");
  assert.ok(!existsSync(t.files["old.jsonl"]), "the age sweep removes the old file");
  assert.ok(statSync(db.path).size < before, "the database is compacted");
  assert.match(run.stdout, new RegExp(`compacted ${esc(db.path)}`));
  assert.match(run.stdout, /host-update: agent history reclaim: COMPLETED/);
});

test("W1-T12495 criterion 8: invariant no-prune-beside-a-live-fleet holds across the whole run", () => {
  const idle = idleTarget("reach-root-c8-idle");
  const busy = idleTarget("reach-root-c8-busy");
  writeFileSync(join(busy.repo.dir, ".git", "FETCH_HEAD"), "");
  const t = historyTree("c8", ["open.jsonl", "closed.jsonl"]);
  const db = liveDatabase(t.dir);
  const before = statSync(db.path).size;
  const run = reclaim({
    mode: "live",
    gitDirs: [idle.repo.dir, busy.repo.dir],
    trees: [t.dir],
    lsofOut: lsofList([t.files["open.jsonl"]]),
  });
  assert.equal(run.status, 0, run.out);
  assert.equal(pruningCalls(run).length, 0, "no git gc and no prune beside a live fleet");
  assert.ok(hasObject(idle) && hasObject(busy), "no object is pruned");
  assert.equal(maintenanceCalls(run, busy.repo.dir).length, 0, "a busy checkout is not written");
  assert.equal(statSync(db.path).size, before, "no database is compacted");
  assert.ok(existsSync(t.files["open.jsonl"]), "a file a process holds open is kept");
  assert.ok(!existsSync(t.files["closed.jsonl"]), "a file proved closed is removed");

  const u = historyTree("c8-unread", ["unproved.jsonl"]);
  const unread = reclaim({ mode: "live", gitDirs: [idleTarget("reach-root-c8-u").repo.dir], trees: [u.dir], lsofRc: 1 });
  assert.ok(existsSync(u.files["unproved.jsonl"]), "a file that cannot be proved closed is kept");
  assert.equal(pruningCalls(unread).length, 0);
});
