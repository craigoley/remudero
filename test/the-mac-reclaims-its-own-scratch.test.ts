/**
 * deploy/mac/tmp-reclaim.sh — the operator Mac reclaims session scratch on its own.
 *
 * On 2026-09-23 the Mac filled to 0 bytes free: 33 GB of /private/tmp was checkouts and scratch that
 * interactive sessions made and never removed. This suite runs the REAL script against a fixture
 * directory and stand-in lsof/crontab: what it deletes, what remains protected, and that the
 * fixed six-hour window also reclaims stale unscheduled logs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "mac", "tmp-reclaim.sh");
const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3600_000);
const WEEKS_AGO = HOURS_AGO(20 * 24);

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const git = (cwd: string, ...args: string[]) => sh(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args);

/** Set every file and directory under `path` to `when`, so the script's recency check sees old. */
function age(path: string, when: Date): void {
  const stamp = `${when.getFullYear()}${String(when.getMonth() + 1).padStart(2, "0")}${String(when.getDate()).padStart(2, "0")}${String(when.getHours()).padStart(2, "0")}${String(when.getMinutes()).padStart(2, "0")}`;
  sh(dirname(path), "find", path, "-exec", "touch", "-h", "-t", stamp, "{}", "+");
}

interface Fixture { base: string; root: string; sessions: string; cwds: string; open: string; lsof: string; bin: string; cron: string }

/**
 * A fixture tmp root plus a stand-in lsof, so the suite never depends on the host's real processes:
 * `cwds` lists working directories it reports, `open` lists paths it reports as held open.
 */
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mac-reclaim-`));
  const root = join(base, "tmp");
  const sessions = join(base, "sessions");
  mkdirSync(root);
  mkdirSync(sessions);
  const cwds = join(base, "cwds.txt");
  const open = join(base, "open.txt");
  const bin = join(base, "bin");
  const cron = join(base, "crontab.txt");
  mkdirSync(bin);
  writeFileSync(cron, "");
  writeFileSync(join(bin, "crontab"), "#!/bin/bash\n[ \"$1\" = \"-l\" ] || exit 2\n/bin/cat " + JSON.stringify(cron) + "\n", { mode: 0o755 });
  writeFileSync(cwds, "");
  writeFileSync(open, "");
  const lsof = join(base, "lsof");
  writeFileSync(lsof, [
    "#!/bin/bash",
    `case " $* " in *" cwd "*) while IFS= read -r p; do [ -n "$p" ] && printf 'p1\\nn%s\\n' "$p"; done < "${cwds}"; exit 0 ;; esac`,
    'target="${@: -1}"; hit=1',
    `while IFS= read -r p; do case "$p" in "$target"|"$target"/*) printf 'p1\\nn%s\\n' "$p"; hit=0 ;; esac; done < "${open}"`,
    "exit $hit",
  ].join("\n") + "\n", { mode: 0o755 });
  return { base, root, sessions, cwds, open, lsof, bin, cron };
}

function reclaim(fx: Fixture, freePct: number, apply = true): { out: string; report: string } {
  const report = join(fx.base, "kept.txt");
  const r = spawnSync("bash", [SCRIPT, ...(apply ? ["--apply"] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_RECLAIM_ROOT: fx.root,
      RMD_RECLAIM_SESSION_ROOT: fx.sessions,
      RMD_RECLAIM_FREE_PCT: String(freePct),
      RMD_RECLAIM_REPORT: report,
      RMD_RECLAIM_LSOF: fx.lsof,
      TMPDIR: fx.base, // the tsx-cache pass reads TMPDIR; keep it off the real one
      PATH: fx.bin + ":" + process.env.PATH,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout, report: existsSync(report) ? readFileSync(report, "utf8") : "" };
}

test("scratch is reclaimed, and a running session, any git checkout, or a Claude dir never is", () => {
  const fx = fixture();
  const { base, root } = fx;
  try {
    const origin = join(base, "origin.git");
    git(base, "init", "-q", "--bare", origin);
    const seed = join(base, "seed");
    git(base, "init", "-q", seed);
    writeFileSync(join(seed, "a.txt"), "a\n");
    git(seed, "add", "a.txt");
    git(seed, "commit", "-q", "-m", "seed");
    git(seed, "push", "-q", origin, "HEAD:main");

    mkdirSync(join(root, "old-scratch"));
    writeFileSync(join(root, "old-scratch", "f"), "x");
    mkdirSync(join(root, "busy-session", "deep"), { recursive: true });
    writeFileSync(join(root, "busy-session", "deep", "f"), "x");
    git(root, "clone", "-q", origin, "clean-checkout");
    git(root, "clone", "-q", origin, "dirty-checkout");
    writeFileSync(join(root, "dirty-checkout", "wip.txt"), "unsaved\n");
    // A worktree whose parent clone is deleted: git can no longer read it.
    git(root, "clone", "-q", origin, "parent");
    git(join(root, "parent"), "worktree", "add", "-q", join(root, "orphan-worktree"));
    mkdirSync(join(root, "claude-501"));

    for (const e of ["old-scratch", "busy-session", "clean-checkout", "dirty-checkout", "parent", "orphan-worktree", "claude-501"]) {
      age(join(root, e), WEEKS_AGO);
    }
    rmSync(join(root, "parent"), { recursive: true, force: true });
    writeFileSync(join(root, "busy-session", "deep", "f"), "still writing"); // fresh, deep inside an old dir

    const { out, report } = reclaim(fx, 30);
    assert.equal(existsSync(join(root, "old-scratch")), false, "old scratch is reclaimed");
    assert.ok(existsSync(join(root, "busy-session")), "a file written inside keeps a session's dir, whatever its top-level mtime");
    assert.ok(existsSync(join(root, "clean-checkout")), "a git checkout is kept even when clean");
    assert.ok(existsSync(join(root, "dirty-checkout")), "uncommitted work is kept");
    assert.ok(existsSync(join(root, "orphan-worktree")), "a worktree git cannot read is kept");
    assert.ok(existsSync(join(root, "claude-501")), "Claude Code's own session dir is never touched");
    assert.match(out, /Deleted: 1 entries/);
    // Kept-for-safety paths are reported, not silently skipped.
    assert.match(report, /Git checkout\/worktree: .*clean-checkout/);
    assert.match(report, /Git checkout\/worktree: .*dirty-checkout/);
    assert.match(report, /Git checkout\/worktree: .*orphan-worktree/);
    assert.match(report, /protected Claude\/macOS temp name \| .*claude-501/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an old dir a process is working in, or holds a file open in, is kept and reported", () => {
  const fx = fixture();
  try {
    for (const e of ["held-cwd", "held-open", "idle"]) {
      mkdirSync(join(fx.root, e));
      writeFileSync(join(fx.root, e, "f"), "x");
      age(join(fx.root, e), WEEKS_AGO);
    }
    const real = realpathSync(fx.root);
    writeFileSync(fx.cwds, `${join(real, "held-cwd")}\n`);
    writeFileSync(fx.open, `${join(real, "held-open", "f")}\n`);
    const { out, report } = reclaim(fx, 0);
    assert.equal(existsSync(join(fx.root, "idle")), false, "an unheld old dir goes");
    assert.ok(existsSync(join(fx.root, "held-cwd")), "a process working inside keeps it");
    assert.ok(existsSync(join(fx.root, "held-open")), "an open file inside keeps it");
    assert.match(out, /KEEP RISKY \(process working directory is inside path\): .*held-cwd/);
    assert.match(report, /held-open/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("the age window is always six hours, regardless of free space", () => {
  const fx = fixture();
  try {
    const dirs: Record<string, number> = { "aged-18h": 18, "aged-8h": 8, "aged-5h": 5 };
    for (const [name, hours] of Object.entries(dirs)) {
      mkdirSync(join(fx.root, name));
      writeFileSync(join(fx.root, name, "f"), "x");
      age(join(fx.root, name), HOURS_AGO(hours));
    }
    const would = (freePct: number) => {
      const { out } = reclaim(fx, freePct, false);
      return { out, gone: Object.keys(dirs).filter((d) => out.includes(`WOULD DELETE ${realpathSync(fx.root)}/${d} `)).sort() };
    };
    // The retention window is deliberately independent of free space.
    const cases: [number, string[]][] = [
      [40, ["aged-18h", "aged-8h"]],
      [0, ["aged-18h", "aged-8h"]],
    ];
    for (const [freePct, gone] of cases) {
      const r = would(freePct);
      assert.match(r.out, /age window 360 min/, `free ${freePct}%: ${r.out}`);
      assert.deepEqual(r.gone, gone, `free ${freePct}%`);
    }
    for (const d of Object.keys(dirs)) assert.ok(existsSync(join(fx.root, d)), "a dry run deletes nothing");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("six-hour session scratch cleanup removes only wholly old, unheld, non-Git directories", () => {
  const fx = fixture();
  try {
    const old = join(fx.sessions, "pr-1791818297138");
    const recentNested = join(fx.sessions, "recent-nested");
    const held = join(fx.sessions, "held-session");
    const checkout = join(fx.sessions, "git-session");
    const linked = join(fx.sessions, "linked-session");
    const credentials = join(fx.sessions, "content-session");
    const young = join(fx.sessions, "young-session");
    for (const dir of [old, recentNested, held, checkout, linked, credentials, young]) mkdirSync(dir);
    writeFileSync(join(old, "output.txt"), "disposable\n");
    mkdirSync(join(recentNested, "deep"));
    writeFileSync(join(recentNested, "deep", "old.txt"), "old\n");
    writeFileSync(join(held, "output.txt"), "active\n");
    git(fx.sessions, "init", "-q", checkout);
    const outside = join(fx.base, "outside.txt");
    writeFileSync(outside, "keep target\n");
    symlinkSync(outside, join(linked, "node_modules"));
    writeFileSync(join(credentials, "api-token.txt"), "keep\n");
    writeFileSync(join(young, "output.txt"), "recent\n");
    for (const dir of [old, recentNested, held, checkout, linked, credentials]) age(dir, HOURS_AGO(8));
    writeFileSync(join(recentNested, "deep", "new.txt"), "recent nested content\n");
    writeFileSync(fx.cwds, `${realpathSync(held)}\n`);

    const { out } = reclaim(fx, 40, false);
    assert.ok(existsSync(old), "dry run leaves directories intact");
    assert.ok(existsSync(recentNested), "a fresh nested file protects the entire directory");
    assert.ok(existsSync(held), "a live CWD protects the session directory");
    assert.ok(existsSync(checkout), "Git metadata protects the directory");
    assert.ok(existsSync(linked), "a nested symlink protects the directory");
    assert.ok(existsSync(credentials), "credential-like content protects the directory");
    assert.ok(existsSync(young), "a young directory remains");
    assert.match(out, /WOULD DELETE old session scratch directory .*pr-1791818297138/);
    const applied = reclaim(fx, 40, true);
    assert.equal(existsSync(old), false, "apply removes the eligible stale session directory");
    assert.match(applied.report, /recent content inside session scratch directory.*recent-nested/);
    assert.match(applied.report, /process working directory is inside path.*held-session/);
    assert.match(applied.report, /Git checkout\/worktree: .*git-session/);
    assert.match(applied.report, /contains symlink.*linked-session/);
    assert.match(applied.report, /credential-like filename: .*api-token/);
    for (const dir of [recentNested, held, checkout, linked, credentials, young]) {
      assert.ok(existsSync(dir), `${dir} remains protected`);
    }
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("stale inactive logs are removed, but scheduled or open logs are retained", () => {
  const fx = fixture();
  try {
    const root = realpathSync(fx.root);
    const stale = join(root, "old-debug.log");
    const scheduled = join(root, "health.log");
    const held = join(root, "held.log");
    for (const path of [stale, scheduled, held]) writeFileSync(path, "old diagnostic output\n");
    for (const path of [stale, scheduled, held]) age(path, HOURS_AGO(8));
    writeFileSync(fx.cron, "*/5 * * * * /bin/echo health >> " + scheduled + " 2>&1\n");
    writeFileSync(fx.open, held + "\n");

    const { out, report } = reclaim(fx, 40);
    assert.equal(existsSync(stale), false, "old unscheduled diagnostic log is reclaimed");
    assert.ok(existsSync(scheduled), "scheduled log output is protected: " + out);
    assert.ok(existsSync(held), "an open log is protected");
    assert.match(out, /scheduled log path referenced by crontab.*health\.log/);
    assert.match(out, /open file or lsof scan uncertain.*held\.log/);
    assert.match(report, /health\.log/);
    assert.match(report, /held\.log/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("nested /private/tmp/rt TSX caches are batch-pruned while other old rt entries are cleaned", () => {
  const fx = fixture();
  try {
    const rt = join(fx.root, "rt");
    const cache = join(rt, "tsx-502");
    const cacheFile = join(cache, "old-cache.js");
    const scratch = join(rt, "old-test-run");
    mkdirSync(cache, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(cacheFile, "regenerable\n");
    writeFileSync(join(scratch, "output.txt"), "disposable\n");
    age(cache, HOURS_AGO(8));
    age(scratch, HOURS_AGO(8));

    const { out } = reclaim(fx, 40);
    assert.ok(existsSync(cache), "the TSX cache root is retained");
    assert.equal(existsSync(cacheFile), false, "stale TSX cache files are reclaimed in one batch");
    assert.equal(existsSync(scratch), false, "old non-cache entries under rt are still swept");
    assert.match(out, /pruned tsx cache files=1.*tsx-502/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("a live nested /private/tmp/rt TSX cache fails closed", () => {
  const fx = fixture();
  try {
    const cache = join(fx.root, "rt", "tsx-502");
    const worker = join(cache, "active-worker");
    const cacheFile = join(cache, "old-cache.js");
    mkdirSync(worker, { recursive: true });
    writeFileSync(cacheFile, "regenerable\n");
    age(cache, HOURS_AGO(8));
    writeFileSync(fx.cwds, `${realpathSync(worker)}\n`);

    const { out, report } = reclaim(fx, 40);
    assert.ok(existsSync(cacheFile), `a cache with a live working directory remains intact: ${out} ${report}`);
    assert.match(out, /KEEP RISKY \(TSX cache process working directory is inside path\): .*tsx-502/);
    assert.match(report, /tsx-502/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("an unreadable crontab makes old logs fail closed", () => {
  const fx = fixture();
  try {
    const log = join(realpathSync(fx.root), "unknown.log");
    writeFileSync(log, "diagnostic output\n");
    age(log, HOURS_AGO(8));
    writeFileSync(join(fx.bin, "crontab"), "#!/bin/bash\nexit 2\n", { mode: 0o755 });

    const { out, report } = reclaim(fx, 40);
    assert.ok(existsSync(log), out);
    assert.match(out, /crontab unavailable; scheduled-log status unknown/);
    assert.match(report, /unknown\.log/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("the installer schedules one hourly job per account, and re-running it replaces rather than adds", () => {
  const { base } = fixture();
  try {
    // A stand-in `crontab` on PATH keeps the real crontab untouched.
    const bin = join(base, "bin");
    mkdirSync(bin, { recursive: true });
    const tab = join(base, "crontab.txt");
    writeFileSync(tab, "5 * * * * /usr/bin/true # someone else's job\n");
    writeFileSync(join(bin, "crontab"), `#!/bin/bash\nif [ "$1" = "-l" ]; then cat "${tab}"; else cat > "${tab}"; fi\n`, { mode: 0o755 });
    const home = join(base, "home");
    mkdirSync(home);
    const install = join(dirname(SCRIPT), "install-tmp-reclaim.sh");
    const run = () => {
      const r = spawnSync("bash", [install], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
      assert.equal(r.status, 0, r.stderr);
    };
    run();
    run();
    const lines = readFileSync(tab, "utf8").trim().split("\n");
    assert.equal(lines.filter((l) => l.includes("# remudero-tmp-reclaim")).length, 1, "one job, however often it is installed");
    assert.ok(lines.some((l) => l.includes("someone else's job")), "other crontab lines are kept");
    assert.match(lines.find((l) => l.includes("remudero-tmp-reclaim"))!, /^17 \* \* \* \* \/bin\/bash ".*tmp-reclaim\.sh" --apply >> ".*tmp-reclaim\.log" 2>&1/);
    assert.ok(existsSync(join(home, "Library", "Application Support", "remudero", "tmp-reclaim.sh")), "runs from a stable copy, not the checkout");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
