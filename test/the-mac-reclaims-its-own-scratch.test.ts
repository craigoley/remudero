/**
 * deploy/mac/tmp-reclaim.sh — the operator Mac reclaims session scratch on its own.
 *
 * On 2026-09-23 the Mac filled to 0 bytes free: 33 GB of /private/tmp was checkouts and scratch that
 * interactive sessions made and never removed. This suite runs the REAL script against a fixture
 * directory: what it deletes, everything it must never delete, and how its age window follows disk
 * pressure.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "mac", "tmp-reclaim.sh");
const DAY_AGO = new Date(Date.now() - 24 * 3600_000);
const WEEKS_AGO = new Date(Date.now() - 20 * 24 * 3600_000);

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

function reclaim(root: string, freePct: number, apply = true): { out: string; report: string } {
  const report = join(root, "..", "kept.txt");
  const r = spawnSync("bash", [SCRIPT, ...(apply ? ["--apply"] : [])], {
    encoding: "utf8",
    env: { ...process.env, RMD_RECLAIM_ROOT: root, RMD_RECLAIM_FREE_PCT: String(freePct), RMD_RECLAIM_REPORT: report },
  });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout, report: existsSync(report) ? readFileSync(report, "utf8") : "" };
}

function fixture(): { base: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mac-reclaim-`));
  const root = join(base, "tmp");
  mkdirSync(root);
  return { base, root };
}

test("scratch is reclaimed, and a running session, a checkout with work, or an unreadable checkout never is", () => {
  const { base, root } = fixture();
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
    git(root, "clone", "-q", origin, "unpushed-checkout");
    writeFileSync(join(root, "unpushed-checkout", "b.txt"), "b\n");
    git(join(root, "unpushed-checkout"), "add", "b.txt");
    git(join(root, "unpushed-checkout"), "commit", "-q", "-m", "local only");
    // A worktree whose parent clone is deleted: git can no longer read it.
    git(root, "clone", "-q", origin, "parent");
    git(join(root, "parent"), "worktree", "add", "-q", join(root, "orphan-worktree"));
    mkdirSync(join(root, "claude-501"));

    for (const e of ["old-scratch", "busy-session", "clean-checkout", "dirty-checkout", "unpushed-checkout", "parent", "orphan-worktree", "claude-501"]) {
      age(join(root, e), WEEKS_AGO);
    }
    rmSync(join(root, "parent"), { recursive: true, force: true });
    writeFileSync(join(root, "busy-session", "deep", "f"), "still writing"); // fresh, deep inside an old dir

    const { out, report } = reclaim(root, 30);
    assert.equal(existsSync(join(root, "old-scratch")), false, "old scratch is reclaimed");
    assert.equal(existsSync(join(root, "clean-checkout")), false, "a clean, pushed checkout is reclaimed");
    assert.ok(existsSync(join(root, "busy-session")), "a file written inside keeps a session's dir, whatever its top-level mtime");
    assert.ok(existsSync(join(root, "dirty-checkout")), "uncommitted work is kept");
    assert.ok(existsSync(join(root, "unpushed-checkout")), "a commit on no remote is kept");
    assert.ok(existsSync(join(root, "orphan-worktree")), "a checkout git cannot read is kept, never read as clean");
    assert.ok(existsSync(join(root, "claude-501")), "Claude Code's own session dir is never touched");
    assert.match(out, /Deleted: 2 entries/);
    // The kept checkouts older than a week are listed where a person can read them.
    assert.match(report, /dirty-checkout/);
    assert.match(report, /unpushed-checkout/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the age window follows disk pressure: two days with room to spare, down to two hours when full", () => {
  const { base, root } = fixture();
  try {
    mkdirSync(join(root, "yesterday"));
    age(join(root, "yesterday"), DAY_AGO);
    const roomy = reclaim(root, 30, false);
    assert.match(roomy.out, /age window 2880 min/);
    assert.match(roomy.out, /Would delete: 0 entries/, "a day-old dir is inside a two-day window");
    assert.match(reclaim(root, 10, false).out, /age window 561 min/, "tighter as free space shrinks");
    const full = reclaim(root, 0, false);
    assert.match(full.out, /age window 120 min/, "never under the two-hour floor");
    assert.match(full.out, /Would delete: 1 entries/);
    assert.ok(existsSync(join(root, "yesterday")), "a dry run deletes nothing");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the installer schedules one hourly job per account, and re-running it replaces rather than adds", () => {
  const { base } = fixture();
  try {
    // A stand-in `crontab` on PATH keeps the real crontab untouched.
    const bin = join(base, "bin");
    mkdirSync(bin);
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
