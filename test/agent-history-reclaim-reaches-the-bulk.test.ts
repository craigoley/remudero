import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gitRepo } from "./helpers/git-repo.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * W1-T3676 — the agent-history reclaim (W1-T3626, section 4b of deploy/host-update.sh) could not
 * reach the bytes it was filed for.
 *
 * MEASURED 2026-09-16: 3.72 GiB of the 6.5 GiB sat in two SQLite files (thread_history_1.sqlite,
 * state_5.sqlite) whose mtime is TODAY on every run, because they are live databases. An age-of-FILE
 * sweep cannot match them at any threshold, so the 14-day tier freed 29.6 MiB. And on a fleet that
 * is always up, the live-container refusal meant the rung reclaimed nothing and still read as a
 * clean run.
 *
 * So the three claims here, each driven through the REAL script with a stubbed `docker`:
 *   1. every tree reports the bytes it could NOT reach and which reason applies;
 *   2. a live-container refusal reads as REFUSED, never as a completed run with nothing to do;
 *   3. a live SQLite database whose mtime is always current is COMPACTED IN PLACE (WAL checkpoint +
 *      VACUUM), never deleted, and its rows survive.
 *
 * The fixtures are REAL SQLite files built with node:sqlite, not text files named `.sqlite`: the
 * bytes this task exists for are free pages INSIDE a live database, and only a real database has any.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");

/** Minimal `docker` stub for `--reclaim-only`: `good` has no container up, `live` has one fleet container. */
function writeDockerStub(dir: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'case "$1 $2" in',
    '  "info --format")  echo "$STUB_REC"; exit 0 ;;',
    '  "system df")      echo "TYPE TOTAL ACTIVE SIZE"; exit 0 ;;',
    "esac",
    'case "$1" in',
    "  ps)",
    '    case "$STUB_MODE" in live) echo c0ffee ;; esac; exit 0 ;;',
    "  inspect)",
    '    case "$STUB_MODE" in',
    '      live) echo "/ad-hoc|rmd-local:latest|/home/node/Remudero " ;;',
    "    esac; exit 0 ;;",
    "  image)",
    '    if [ "$2" = "inspect" ]; then exit 0; fi',
    '    echo "Total reclaimed space: 0B"; exit 0 ;;',
    '  container|builder) echo "Total reclaimed space: 0B"; exit 0 ;;',
    // Section 3a's snapshot runs through `docker run`; publish an archive the way the image would.
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

function runReclaim(mode: "good" | "live", trees: string[], extraEnv: NodeJS.ProcessEnv = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ah-bulk-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ah-bulk-rec-`));
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ah-bulk-state-`));
  const gitTarget = gitRepo({ kind: "reclaim-target" });
  writeDockerStub(dir);
  const r = spawnSync("bash", [SCRIPT, "--reclaim-only"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_MODE: mode,
      RMD_STATE_DIR: state,
      RMD_GIT_RECLAIM_DIRS: gitTarget.dir,
      RMD_STATE_SNAPSHOT_RECEIPT: join(rec, "state-snapshot.receipt"),
      RMD_AGENT_HISTORY_DIRS: trees.join(":"),
      ...extraEnv,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const KEPT_ROWS = 40;
const BODY_BYTES = 8192;

/**
 * A live agent database the way the host holds one: a WAL-mode SQLite file whose rows were mostly
 * deleted by its owning tool, leaving the pages free INSIDE the file, and whose mtime is NOW — the
 * condition an mtime sweep can never match, at any threshold.
 */
function liveDatabase(dir: string, name = "thread_history_1.sqlite"): string {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE history(id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
  const insert = db.prepare("INSERT INTO history(id, body) VALUES (?, ?)");
  for (let i = 1; i <= 400; i++) insert.run(i, Buffer.alloc(BODY_BYTES, i % 251));
  db.exec(`DELETE FROM history WHERE id > ${KEPT_ROWS}`);
  db.close();
  const now = new Date();
  utimesSync(path, now, now);
  return path;
}

function rowsOf(path: string): { count: number; intact: boolean } {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare("SELECT id, body FROM history ORDER BY id").all() as { id: number; body: Uint8Array }[];
  db.close();
  const intact = rows.every((r) => r.body.length === BODY_BYTES && r.body[0] === r.id % 251);
  return { count: rows.length, intact };
}

function tree(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ah-bulk-${label}-`));
}

// ── ACCEPTANCE 1: bytes it could not reach, and why, per tree ───────────────────────────────────

test("W1-T3676: the reclaim reports bytes it could not reach and the reason", () => {
  const codex = tree("codex");
  const db = liveDatabase(codex);
  // A fresh, non-database file — today's session log. The age tier keeps it on purpose.
  const session = join(codex, "session-today.jsonl");
  writeFileSync(session, "s".repeat(8192));
  const claude = tree("claude");

  const run = runReclaim("good", [codex, claude]);
  assert.equal(run.status, 0, run.stderr);
  // Per tree, with a reason: the age tier's file, and the rows a live database still holds.
  assert.match(
    run.stdout,
    new RegExp(`agent history reclaim — ${esc(codex)}: could not reach 8\\.0KB — reason: within-age-tier \\(1 file\\(s\\)\\)`),
  );
  assert.match(run.stdout, new RegExp(`agent history reclaim — ${esc(codex)}: could not reach \\S+ — reason: live-rows \\(1 file\\(s\\)\\)`));
  // The OTHER tree reports for itself, never folded into one sum.
  assert.match(run.stdout, new RegExp(`agent history reclaim — ${esc(claude)}: could not reach 0\\.0KB — every byte was in scope`));
  assert.ok(existsSync(session), "the age tier still keeps today's file");

  // With no engine to open a database, the gigabyte is NAMED as unreachable, never left invisible.
  const codex2 = tree("codex-noengine");
  const db2 = liveDatabase(codex2);
  const before = statSync(db2).size;
  const noEngine = runReclaim("good", [codex2], { RMD_AGENT_HISTORY_SQLITE_ENGINE: "none" });
  assert.equal(noEngine.status, 0, noEngine.stderr);
  assert.match(
    noEngine.stdout,
    new RegExp(`agent history reclaim — ${esc(codex2)}: could not reach \\S+ — reason: no-sqlite-engine \\(1 file\\(s\\)\\)`),
  );
  assert.equal(statSync(db2).size, before, "with no engine the database is left exactly as it was");
  assert.ok(existsSync(db), "a live database is never deleted");
});

// ── ACCEPTANCE 2: a refusal reads as a refusal ──────────────────────────────────────────────────

test("W1-T3676: a refused reclaim is not reported as a clean nothing-to-do run", () => {
  const codex = tree("codex-live");
  const db = liveDatabase(codex);
  const before = statSync(db).size;
  const live = runReclaim("live", [codex]);
  const out = `${live.stdout}\n${live.stderr}`;
  // Per tree: what it held, and that the reason is the refusal.
  assert.match(
    out,
    new RegExp(`agent history reclaim REFUSED — ${esc(codex)}: could not reach \\S+ — reason: live-fleet-container \\(1 file\\(s\\)\\)`),
  );
  // And the rung's own closing verdict says REFUSED, not COMPLETED.
  assert.match(live.stdout, /host-update: agent history reclaim: REFUSED/);
  assert.doesNotMatch(live.stdout, /host-update: agent history reclaim: COMPLETED/);
  assert.equal(statSync(db).size, before, "nothing is compacted beside a live fleet container");

  // An empty tree with nothing to do reads differently: COMPLETED, never REFUSED.
  const empty = tree("empty");
  const idle = runReclaim("good", [empty]);
  assert.equal(idle.status, 0, idle.stderr);
  assert.match(idle.stdout, /host-update: agent history reclaim: COMPLETED/);
  assert.doesNotMatch(`${idle.stdout}\n${idle.stderr}`, /agent history reclaim(:| ) ?REFUSED/);
});

// ── ACCEPTANCE 3: bytes inside an always-current file ───────────────────────────────────────────

test("W1-T3676: reclaim reaches bytes inside an always-current file", () => {
  const codex = tree("codex-bulk");
  const db = liveDatabase(codex);
  const before = statSync(db).size;
  assert.ok(before > 2 * 1024 * 1024, `the fixture must hold real free pages to reclaim, got ${before} bytes`);
  const mtimeBefore = statSync(db).mtimeMs;
  assert.ok(Date.now() - mtimeBefore < 60_000, "the fixture's mtime is current — no age tier can ever match it");

  const run = runReclaim("good", [codex]);
  assert.equal(run.status, 0, run.stderr);

  assert.ok(existsSync(db), "a live database is compacted in place, never deleted");
  const after = statSync(db).size;
  assert.ok(after < before / 2, `the free pages inside the file must be released: ${before} -> ${after} bytes`);
  const rows = rowsOf(db);
  assert.equal(rows.count, KEPT_ROWS, "every row the owning tool kept survives the compaction");
  assert.ok(rows.intact, "and every kept row's content is unchanged");
  assert.match(run.stdout, new RegExp(`compacted ${esc(db)}: \\S+ -> \\S+, freed \\S+`));
  assert.match(run.stdout, new RegExp(`agent history reclaim — ${esc(codex)}: compacted 1 live database\\(s\\) in place, freed \\S+`));
});
