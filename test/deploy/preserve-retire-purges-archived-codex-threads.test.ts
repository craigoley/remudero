/** Runs the real preserve-then-retire helper against a private fixture home with a stubbed Codex CLI. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { preserveRetireFixtureArgs } from "#test/helpers/preserve-retire-fixture.js";

const HELPER = join(REPO_ROOT, "deploy/mac/preserve-retire.py");
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

interface Fx { root: string; home: string; bin: string; db: string; calls: string }

function setup(config: Record<string, unknown>): Fx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-preserve-retire-codex-")));
  const home = join(root, "home");
  mkdirSync(join(home, ".local/state/remudero"), { recursive: true });
  for (const dir of [home, join(home, ".local"), join(home, ".local/state"), join(home, ".local/state/remudero")]) chmodSync(dir, 0o700);
  const cfg = join(home, ".local/state/remudero/preserve-retire.json");
  writeFileSync(cfg, JSON.stringify({ enabled: true, idle_hours: 24, retain_days: 7, interval_hours: 0, roots: [], ...config }), { mode: 0o600 });
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "ps"), '#!/bin/bash\nprintf "%s\\n" /bin/sh\n', { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  mkdirSync(join(home, ".codex"), { recursive: true });
  const db = join(home, ".codex/state_5.sqlite");
  const calls = join(root, "codex-calls");
  // The stub deletes the row, except FAIL_ID, whose row a cascade already removed, and STUCK_ID, which stays.
  writeFileSync(join(bin, "codex"), `#!/bin/bash
printf '%s %s\\n' "$*" "$CODEX_HOME" >> '${calls}'
[ "$3" = stuck ] && exit 1
python3 -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("delete from threads where id=?",(sys.argv[2],)); c.commit()' '${db}' "$3"
[ "$3" = cascade ] && exit 1
exit 0
`, { mode: 0o755 });
  return { root, home, bin, db, calls };
}

function threads(fx: Fx, rows: [string, number, number | null, number][]) {
  execFileSync("python3", ["-c", `import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1]); c.execute("create table threads(id text primary key, archived integer, archived_at integer, is_pinned integer)")
c.executemany("insert into threads values(?,?,?,?)", json.loads(sys.argv[2])); c.commit()`, fx.db, JSON.stringify(rows)]);
}
function remaining(fx: Fx): string[] {
  return execFileSync("python3", ["-c", "import sqlite3,sys; print('\\n'.join(r[0] for r in sqlite3.connect(sys.argv[1]).execute('select id from threads order by id')))", fx.db], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
}
function helper(fx: Fx, apply: boolean, now = NOW) {
  return spawnSync("python3", preserveRetireFixtureArgs(fx.home, HELPER, ["--home", fx.home, "--now", String(now), ...(apply ? ["--apply"] : [])]), {
    encoding: "utf8", timeout: 120_000, env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}` },
  });
}

test("archived, unpinned Codex threads archived a day ago are deleted through the Codex CLI; recent, pinned and live threads stay", () => {
  const fx = setup({});
  try {
    threads(fx, [["old", 1, NOW - 2 * DAY, 0], ["cascade", 1, NOW - 3 * DAY, 0], ["stuck", 1, NOW - 3 * DAY, 0],
      ["recent", 1, NOW - 3600, 0], ["pinned", 1, NOW - 9 * DAY, 1], ["live", 0, null, 0]]);
    const keep = join(fx.home, ".codex/.rmd-janitor-keep");
    writeFileSync(keep, "operator work\n");
    const before = readFileSync(fx.db);
    for (const apply of [false, true]) {
      const kept = helper(fx, apply);
      assert.equal(kept.status, 0, kept.stderr + kept.stdout);
      assert.match(kept.stdout, /codex-threads-removed=0/);
      assert.equal(existsSync(fx.calls), false, "a kept Codex home never calls the CLI");
      assert.deepEqual(readFileSync(fx.db), before, "the kept database stays byte-for-byte intact");
    }
    rmSync(keep);
    const dry = helper(fx, false);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /codex-threads-removed=3 apply=0/);
    assert.equal(existsSync(fx.calls), false, "a dry run never calls the CLI");
    const r = helper(fx, true);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(remaining(fx), ["live", "pinned", "recent", "stuck"]);
    assert.match(r.stdout, /codex-threads-removed=2 apply=1/);
    assert.match(r.stdout, /HOLD.*codex-thread delete-failed.*stuck/);
    assert.match(readFileSync(fx.calls, "utf8"), new RegExp(`delete --force old ${join(fx.home, ".codex")}`));
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a keep declaration inside either Codex rollout tree holds shared database deletion and its logs", () => {
  for (const rel of [".codex/archived_sessions", ".codex/sessions/2026/11/01"]) {
    const fx = setup({ codex_session_days: 1 });
    try {
      threads(fx, [["old", 1, NOW - 2 * DAY, 0]]);
      const dir = join(fx.home, rel);
      mkdirSync(dir, { recursive: true });
      const rollout = join(dir, "rollout-2026-11-01T10-00-00-old.jsonl");
      writeFileSync(rollout, "kept history\n");
      const keep = join(dir, ".rmd-janitor-keep");
      writeFileSync(keep, "operator work\n");
      const before = readFileSync(fx.db);
      const kept = helper(fx, true, NOW + 2 * DAY);
      assert.equal(kept.status, 0, kept.stderr + kept.stdout);
      assert.equal(existsSync(fx.calls), false, "the CLI can cascade into kept rollout trees");
      assert.deepEqual(readFileSync(fx.db), before);
      assert.equal(readFileSync(rollout, "utf8"), "kept history\n");
      rmSync(keep);
      const released = helper(fx, true, NOW + 2 * DAY);
      assert.equal(released.status, 0, released.stderr + released.stdout);
      assert.deepEqual(remaining(fx), []);
      assert.equal(existsSync(rollout), false, released.stdout);
      assert.match(readFileSync(fx.calls, "utf8"), /delete --force old/);
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("an archived rollout log expires on codex_archived_days though live session logs keep codex_session_days", () => {
  const fx = setup({ codex_session_days: 7 });
  try {
    const archived = join(fx.home, ".codex/archived_sessions");
    const live = join(fx.home, ".codex/sessions/2026/11/01");
    mkdirSync(archived, { recursive: true }); mkdirSync(live, { recursive: true });
    const old = join(archived, "rollout-2026-09-20T18-19-07-archived.jsonl.zst");
    const session = join(live, "rollout-2026-11-01T10-00-00-live.jsonl");
    for (const p of [old, session]) { writeFileSync(p, "{}\n"); const t = new Date(Date.now()); utimesSync(p, t, t); }
    // ctime cannot be set back: run the helper two days ahead instead.
    const r = helper(fx, true, NOW + 2 * DAY);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(old), false, r.stdout);
    assert.equal(existsSync(session), true, r.stdout);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("codex_archived_days 0 disables the thread purge, and a missing state database is a clean skip", () => {
  const fx = setup({ codex_archived_days: 0 });
  try {
    threads(fx, [["old", 1, NOW - 9 * DAY, 0]]);
    const off = helper(fx, true);
    assert.equal(off.status, 0, off.stderr + off.stdout);
    assert.deepEqual(remaining(fx), ["old"]);
    rmSync(fx.db);
    writeFileSync(join(fx.home, ".local/state/remudero/preserve-retire.json"), JSON.stringify({ enabled: true, idle_hours: 24, retain_days: 7, interval_hours: 0, roots: [] }));
    const nodb = helper(fx, true);
    assert.equal(nodb.status, 0, nodb.stderr + nodb.stdout);
    assert.match(nodb.stdout, /codex-threads-removed=0/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
