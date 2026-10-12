/**
 * deploy/mac/tmp-reclaim.sh — the operator Mac reclaims session scratch on its own.
 *
 * On 2026-09-23 the Mac filled to 0 bytes free: 33 GB of /private/tmp was checkouts and scratch that
 * interactive sessions made and never removed. This suite runs the REAL script against a fixture
 * directory and a stand-in lsof: what it deletes, everything it must never delete, and how its age
 * window follows disk pressure in tiers without ever going under six hours.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

interface Fixture { base: string; root: string; cwds: string; open: string; lsof: string }

/**
 * A fixture tmp root plus a stand-in lsof, so the suite never depends on the host's real processes:
 * `cwds` lists working directories it reports, `open` lists paths it reports as held open.
 */
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mac-reclaim-`));
  const root = join(base, "tmp");
  mkdirSync(root);
  const cwds = join(base, "cwds.txt");
  const open = join(base, "open.txt");
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
  return { base, root, cwds, open, lsof };
}

function reclaim(fx: Fixture, freePct: number, apply = true): { out: string; report: string } {
  const report = join(fx.base, "kept.txt");
  const r = spawnSync("bash", [SCRIPT, ...(apply ? ["--apply"] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_RECLAIM_ROOT: fx.root,
      RMD_RECLAIM_FREE_PCT: String(freePct),
      RMD_RECLAIM_REPORT: report,
      RMD_RECLAIM_LSOF: fx.lsof,
      TMPDIR: fx.base, // the tsx-cache pass reads TMPDIR; keep it off the real one
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

test("the age window follows disk pressure in tiers: two days with room to spare, never under six hours", () => {
  const fx = fixture();
  try {
    const dirs: Record<string, number> = { "aged-30h": 30, "aged-18h": 18, "aged-8h": 8, "aged-5h": 5 };
    for (const [name, hours] of Object.entries(dirs)) {
      mkdirSync(join(fx.root, name));
      writeFileSync(join(fx.root, name, "f"), "x");
      age(join(fx.root, name), HOURS_AGO(hours));
    }
    const would = (freePct: number) => {
      const { out } = reclaim(fx, freePct, false);
      return { out, gone: Object.keys(dirs).filter((d) => out.includes(`WOULD DELETE ${realpathSync(fx.root)}/${d} `)).sort() };
    };
    // [free %, window min, the dirs that window reclaims]
    const tiers: [number, number, string[]][] = [
      [40, 2880, []],
      [30, 2880, []],
      [25, 1440, ["aged-30h"]],
      [20, 1440, ["aged-30h"]],
      [15, 720, ["aged-18h", "aged-30h"]],
      [14, 360, ["aged-18h", "aged-30h", "aged-8h"]],
      [0, 360, ["aged-18h", "aged-30h", "aged-8h"]],
    ];
    for (const [freePct, window, gone] of tiers) {
      const r = would(freePct);
      assert.match(r.out, new RegExp(`age window ${window} min`), `free ${freePct}%: ${r.out}`);
      assert.deepEqual(r.gone, gone, `free ${freePct}%`);
    }
    for (const d of Object.keys(dirs)) assert.ok(existsSync(join(fx.root, d)), "a dry run deletes nothing");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
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
