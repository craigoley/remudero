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
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "mac", "tmp-reclaim.sh");

test("the temporary cleaner preserves caller precedence and finds system safety tools under cron", () => {
  // Execute only the maintained setup, before any discovery, locks or removal can run.
  const setup = readFileSync(SCRIPT, "utf8").split("APPLY=0")[0];
  assert.ok(setup.includes("set -u"));
  const command = setup + '\nprintf "PATH=%s\\n" "$PATH"\n' +
    (process.platform === "darwin" ? 'command -v lsof\n' : 'command -v id\n');
  for (const path of ["/usr/bin:/bin", "/fixture-first:/usr/bin:/bin"]) {
    const r = spawnSync("/bin/bash", ["-c", command], { encoding: "utf8", env: { PATH: path } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`PATH=${path}:/usr/sbin:/sbin\n`));
    if (process.platform === "darwin") assert.ok(r.stdout.includes("/usr/sbin/lsof\n"));
  }
});
// The script judges age with `find -mmin`, against the OS clock a child reads — one
// scripts/clock-shift.mjs cannot move — so the stamps `age()` touches are dated from that same
// clock, a real `date`, never from this process's `Date.now()`.
const osNowMs = () => Number(spawnSync("date", ["+%s"], { encoding: "utf8" }).stdout.trim()) * 1000;
const HOURS_AGO = (h: number) => new Date(osNowMs() - h * 3600_000);
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
  const find = sh(base, "sh", "-c", "command -v find").trim();
  // A fixture can backdate mtime, not kernel ctime. Positive cases use that
  // same age for ctime; the real-find metadata control below supplies no shim.
  writeFileSync(join(bin, "tsx-find-age"), `#!/bin/bash\nargs=(); for arg; do if [ "$arg" = -cmin ]; then args+=(-mmin); else args+=("$arg"); fi; done\nexec '${find}' "\${args[@]}"\n`, { mode: 0o755 });
  // Generic positive fixtures also simulate old ctime; explicit native controls
  // opt out of the fixture shim. Production has no age/ctime override.
  writeFileSync(join(bin, "find"), `#!/bin/bash\nif [ "\${FIXTURE_REAL_CTIME:-0}" = 1 ]; then exec '${find}' "$@"; fi\nargs=(); for arg; do if [ "$arg" = -cmin ]; then args+=(-mmin); else args+=("$arg"); fi; done\nexec '${find}' "\${args[@]}"\n`, { mode: 0o755 });
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

function reclaim(fx: Fixture, freePct: number, apply = true, extra: Record<string, string> = {}, options: string[] = []): { out: string; report: string } {
  const report = join(fx.base, "kept.txt");
  const r = spawnSync("bash", [SCRIPT, ...(apply ? ["--apply"] : []), ...options], {
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_RECLAIM_ROOT: fx.root,
      RMD_RECLAIM_SESSION_ROOT: fx.sessions,
      RMD_RECLAIM_FREE_PCT: String(freePct),
      RMD_RECLAIM_REPORT: report,
      RMD_RECLAIM_LSOF: fx.lsof,
      RMD_RECLAIM_KEEP_FILE: join(fx.base, "keep.txt"), // never the operator's own keep list
      RMD_RECLAIM_TSX_FIND: join(fx.bin, "tsx-find-age"),
      TMPDIR: fx.base, // the tsx-cache pass reads TMPDIR; keep it off the real one
      PATH: fx.bin + ":" + process.env.PATH,
      ...extra,
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

test("scheduled cleanup discovers historical nested TSX caches without deleting sibling fixtures or cash data", () => {
  const fx = fixture();
  try {
    const job = join(fx.root, "historical-ci", "run");
    const cache = join(job, "tsx-501");
    mkdirSync(cache, { recursive: true });
    mkdirSync(join(job, "fixture", ".git"), { recursive: true });
    const cash = join(job, "fixture", "openweight-allowance.json");
    writeFileSync(cash, '{"reservations":{"held":"unknown"}}\n');
    const old = join(cache, `17920-${"a".repeat(40)}`);
    const young = join(cache, `17920-${"b".repeat(40)}`);
    writeFileSync(old, '{"code":"compiled","map":null,"warnings":[]}');
    writeFileSync(young, "fresh compiler cache");
    age(job, HOURS_AGO(8)); age(young, HOURS_AGO(5));
    const before = readFileSync(cash, "utf8");
    const { out } = reclaim(fx, 40);
    assert.equal(existsSync(old), false, out);
    assert.ok(existsSync(young), out);
    assert.equal(readFileSync(cash, "utf8"), before);
    assert.ok(existsSync(join(job, "fixture", ".git")));
    assert.match(out, /pruned tsx cache files=1.*historical-ci/);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("nested TSX discovery retains active, Git-owned, seed, linked and unrecognized cache contents", () => {
  const fx = fixture();
  try {
    const caches = ["held", "source", "seed", "unknown"].map(name => join(fx.root, name, "tsx-501"));
    const hash = `17920-${"c".repeat(40)}`;
    for (const cache of caches) {
      mkdirSync(cache, { recursive: true }); writeFileSync(join(cache, hash), "compiled cache");
      mkdirSync(join(dirname(cache), "fixture", ".git"), { recursive: true });
    }
    mkdirSync(join(fx.root, "source", ".git"));
    writeFileSync(join(fx.root, "seed", ".rmd-dependency-seed-root.json"), "{}");
    writeFileSync(join(caches[3]!, "reservation.json"), "keep budget state");
    const outside = join(fx.base, "outside"); mkdirSync(outside); writeFileSync(join(outside, hash), "external");
    symlinkSync(outside, join(fx.root, "tsx-999"));
    for (const cache of caches) age(dirname(cache), HOURS_AGO(8));
    writeFileSync(fx.open, realpathSync(join(caches[0]!, hash)) + "\n");
    const { out } = reclaim(fx, 40);
    for (const cache of caches) assert.ok(existsSync(join(cache, hash)), cache + out);
    assert.equal(readFileSync(join(caches[3]!, "reservation.json"), "utf8"), "keep budget state");
    assert.ok(existsSync(join(outside, hash)));
    assert.match(out, /TSX discovery retains Git-owned/);
    assert.match(out, /TSX discovery contains unrecognized/);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("nested TSX cleanup preserves owned IPC sockets without letting them hide eligible old cache files", () => {
  for (const mode of ['idle-socket', 'live-socket', 'regular-pipe-impostor', 'linked-pipe']) {
    const fx = fixture();
    try {
      const job = join(fx.root, 'job'); const cache = join(job, 'tsx-501');
      mkdirSync(cache, {recursive: true});
      // A sibling Git fixture prevents generic whole-job retirement, as in real job TMPDIRs.
      mkdirSync(join(job, 'source', '.git'), {recursive: true});
      const old = join(cache, `17920-${'f'.repeat(40)}`), young = join(cache, `17920-${'e'.repeat(40)}`);
      writeFileSync(old, 'compiled cache'); writeFileSync(young, 'fresh cache');
      const ipc = join(cache, '123.pipe');
      if (mode === 'regular-pipe-impostor') writeFileSync(ipc, 'not an IPC socket');
      else if (mode === 'linked-pipe') symlinkSync(old, ipc);
      else {
        // Bind a short relative path to respect macOS's Unix-socket path limit.
        const r = spawnSync(process.execPath, ['-e',
          'const s=require("node:net").createServer();s.listen("123.pipe",()=>process.exit(0));'],
          {cwd: cache, encoding: 'utf8', timeout: 5000});
        assert.equal(r.status, 0, r.stderr); assert.ok(lstatSync(ipc).isSocket());
      }
      age(job, HOURS_AGO(8)); age(young, HOURS_AGO(5));
      if (mode === 'live-socket') writeFileSync(fx.open, realpathSync(ipc) + '\n');
      const {out} = reclaim(fx, 40);
      assert.ok(existsSync(ipc), 'IPC sockets and unrecognized entries are never removed: ' + out);
      assert.ok(existsSync(young));
      assert.equal(existsSync(old), mode !== 'idle-socket', mode + ': ' + out);
      if (mode === 'idle-socket') assert.match(out, /pruned tsx cache files=1/);
      else if (mode === 'live-socket') assert.match(out, /open file or lsof scan uncertain/);
      else assert.match(out, /TSX discovery contains unrecognized/);
    } finally {rmSync(fx.base, {recursive: true, force: true});}
  }
});

test("real kernel ctime protects backdated TSX cache files on scheduled discovery", () => {
  const fx = fixture();
  try {
    const job = join(fx.root, "historical-ci"); const cache = join(job, "tsx-501");
    mkdirSync(cache, { recursive: true }); mkdirSync(join(job, "fixture", ".git"), { recursive: true });
    const file = join(cache, `17920-${"d".repeat(40)}`); writeFileSync(file, "recent metadata");
    age(job, HOURS_AGO(12));
    const { out } = reclaim(fx, 40, true, { RMD_RECLAIM_TSX_FIND: "find", FIXTURE_REAL_CTIME: "1" });
    assert.ok(existsSync(file), out);
    assert.doesNotMatch(out, /pruned tsx cache files=/);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("real kernel ctime protects backdated generic temp files, tree leaves and session scratch", () => {
  const fx = fixture();
  try {
    const loose = join(fx.root, "backdated.json");
    const tree = join(fx.root, "backdated-tree");
    const mixed = join(fx.root, "mixed-tree");
    const session = join(fx.sessions, "backdated-session");
    for (const dir of [tree, mixed, session]) {
      mkdirSync(join(dir, "deep"), {recursive: true});
      writeFileSync(join(dir, "deep", "old.json"), "recently restored diagnostic\n");
      age(dir, HOURS_AGO(12));
    }
    writeFileSync(loose, "recently restored loose file\n");age(loose, HOURS_AGO(12));
    writeFileSync(join(mixed, "current.json"), "current work\n");
    const {out} = reclaim(fx, 0, true, {FIXTURE_REAL_CTIME: "1"});
    assert.ok(existsSync(loose), "old mtime cannot release a file with recent kernel ctime: " + out);
    for (const dir of [tree, mixed, session]) {
      assert.equal(readFileSync(join(dir, "deep", "old.json"), "utf8"), "recently restored diagnostic\n", dir + out);
    }
    assert.doesNotMatch(out, /deleted old nested file:|deleted old session scratch directory/);
  } finally {rmSync(fx.base, {recursive: true, force: true});}
});

test("a live enclosing scratch tree protects closed old leaves in deeper directories", () => {
  const fx = fixture();
  try {
    const active = join(fx.root, "active-scratch");
    const leaf = join(active, "deep", "old-diagnostic.json");
    mkdirSync(dirname(leaf), {recursive: true});writeFileSync(leaf, "retain active work\n");
    age(active, HOURS_AGO(12));
    writeFileSync(join(active, "current.json"), "a current run\n");
    writeFileSync(fx.cwds, realpathSync(active) + "\n");
    const {out,report} = reclaim(fx, 0);
    assert.equal(readFileSync(leaf, "utf8"), "retain active work\n", out);
    assert.match(report, /process working directory is inside path.*active-scratch/);
  } finally {rmSync(fx.base, {recursive: true, force: true});}
});

test("a scratch tree becoming live during sizing cancels nested pruning at the final boundary", () => {
  const fx = fixture();
  try {
    const active = join(fx.root, "becomes-active");
    const leaf = join(active, "deep", "old-diagnostic.json");
    mkdirSync(dirname(leaf), {recursive: true});writeFileSync(leaf, "retain new active reader\n");
    age(active, HOURS_AGO(12));writeFileSync(join(active, "current.json"), "current run\n");
    const du = sh(fx.base, "sh", "-c", "command -v du").trim();
    writeFileSync(join(fx.bin, "du"), `#!/bin/bash\nif [ "\${@: -1}" = ${JSON.stringify(leaf)} ]; then printf '%s\\n' ${JSON.stringify(realpathSync(active))} > ${JSON.stringify(fx.cwds)}; fi\nexec '${du}' "$@"\n`, {mode: 0o755});
    const {out,report} = reclaim(fx, 0);
    assert.equal(readFileSync(leaf, "utf8"), "retain new active reader\n", out);
    assert.match(report, /process working directory is inside path.*becomes-active/);
  } finally {rmSync(fx.base, {recursive: true, force: true});}
});

test("real lsof preserves a held nested cache while an idle historical cache is pruned", () => {
  const fx = fixture(); let fd: number | undefined;
  try {
    const files = ["held", "idle"].map(name => {
      const job = join(fx.root, name); const cache = join(job, "tsx-501");
      mkdirSync(cache, { recursive: true }); mkdirSync(join(job, "fixture", ".git"), { recursive: true });
      const file = join(cache, `17920-${"e".repeat(40)}`); writeFileSync(file, "compiled cache"); age(job, HOURS_AGO(8)); return file;
    });
    const lsof = sh(fx.base, "sh", "-c", "command -v lsof").trim();
    fd = openSync(files[0]!, "r");
    const { out } = reclaim(fx, 40, true, { RMD_RECLAIM_LSOF: lsof });
    assert.ok(existsSync(files[0]!), out); assert.equal(existsSync(files[1]!), false, out);
    assert.match(out, /open file or lsof scan uncertain/); assert.match(out, /pruned tsx cache files=1.*idle/);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(fx.base, { recursive: true, force: true }); }
});

test("owner is checked before recursive age scans, and stale safe symlink scratch is reclaimable", () => {
  const fx = fixture();
  try {
    const foreign = join(fx.root, "foreign-owned");
    const internal = join(fx.root, "internal-link-tree");
    const dangling = join(fx.root, "dangling-temp-link-tree");
    const external = join(fx.root, "external-link-tree");
    const externalTarget = join(fx.base, "external-target");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "f"), "owned by another account\n");
    mkdirSync(join(internal, "coverage"), { recursive: true });
    writeFileSync(join(internal, "coverage", "data"), "regenerable\n");
    symlinkSync(join(internal, "coverage"), join(internal, "test-link"));
    mkdirSync(dangling);
    symlinkSync(join(fx.root, "not-created-node-coverage"), join(dangling, "test-link"));
    mkdirSync(external);
    writeFileSync(externalTarget, "must remain\n");
    symlinkSync(externalTarget, join(external, "node_modules"));
    for (const path of [foreign, internal, dangling, external]) age(path, HOURS_AGO(8));

    const realStat = spawnSync("/bin/sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
    assert.ok(realStat, "the platform stat utility exists");
    writeFileSync(join(fx.bin, "stat"), [
      "#!/bin/sh",
      "last=",
      'for arg do last="$arg"; done',
      'if [ "${last##*/}" = "foreign-owned" ]; then printf "craigoleyagent\\n"; exit 0; fi',
      `exec ${JSON.stringify(realStat)} "$@"`,
    ].join("\n") + "\n", { mode: 0o755 });

    const applied = reclaim(fx, 40, true);
    assert.ok(existsSync(foreign), "a foreign-owned tree is not traversed or deleted");
    assert.match(applied.report, /owned by craigoleyagent; age check requires owner account.*foreign-owned/);
    assert.doesNotMatch(applied.report, /age scan unavailable.*foreign-owned/);
    assert.equal(existsSync(internal), false, "an old candidate with only an in-tree link can be removed");
    assert.equal(existsSync(dangling), false, "a dangling alias to a temp-root path can be removed");
    assert.ok(existsSync(external), "a live external symlink target keeps its candidate");
    assert.ok(existsSync(externalTarget), "removing a candidate never deletes its external target");
    assert.match(applied.report, /contains symlink outside cleanup root: .*external-link-tree/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
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

test("whole temporary entries are requalified after sizing before removal", () => {
  for (const activation of ["cwd", "recent-content", "ctime-only"]) {
    const fx = fixture();
    try {
      const tree = join(realpathSync(fx.root), "whole-candidate");
      mkdirSync(tree);
      writeFileSync(join(tree, "old-output.txt"), "retain when activity starts during sizing\n");
      age(tree, HOURS_AGO(8));
      const du = sh(fx.base, "sh", "-c", "command -v du").trim();
      const stamp = join(fx.base, "old-stamp");
      const sized = join(fx.base, "sizing-finished");
      const oldFile = join(tree, "old-output.txt");
      const oldMtime = lstatSync(oldFile).mtimeMs;
      if (activation === "ctime-only") {
        writeFileSync(stamp, "reference mtime\n"); sh(fx.base, "touch", "-r", oldFile, stamp);
        const nativeFind = sh(fx.base, "sh", "-c", "command -v find").trim();
        // Only initial old metadata is simulated. After du mutates and restores
        // mtime, the final boundary uses the real kernel ctime via native find.
        const shim = readFileSync(join(fx.bin, "find"), "utf8");
        writeFileSync(join(fx.bin, "find"), shim.replace("#!/bin/bash\n",
          `#!/bin/bash\nif [ -f ${JSON.stringify(sized)} ]; then exec '${nativeFind}' "$@"; fi\n`));
      }
      const activate = activation === "cwd"
        ? `printf '%s\\n' ${JSON.stringify(tree)} > ${JSON.stringify(fx.cwds)}`
        : activation === "recent-content"
          ? `printf 'new work\\n' > ${JSON.stringify(join(tree, "fresh.txt"))}`
          : `printf 'changed during sizing\\n' > ${JSON.stringify(oldFile)}; /usr/bin/touch -r ${JSON.stringify(stamp)} ${JSON.stringify(oldFile)} ${JSON.stringify(tree)}; /usr/bin/touch ${JSON.stringify(sized)}`;
      writeFileSync(join(fx.bin, "du"), `#!/bin/bash\ncase "\${@: -1}" in ./whole-candidate) ${activate} ;; esac\nexec '${du}' "$@"\n`, { mode: 0o755 });
      const { out } = reclaim(fx, 40);
      assert.ok(existsSync(join(tree, "old-output.txt")), activation + ": " + out);
      if (activation === "cwd") assert.match(out, /process working directory is inside path/);
      else if (activation === "recent-content") assert.ok(existsSync(join(tree, "fresh.txt")), out);
      else {
        assert.equal(readFileSync(oldFile, "utf8"), "changed during sizing\n");
        assert.equal(lstatSync(oldFile).mtimeMs, oldMtime, "mtime was restored; only real ctime protects the entry");
      }
    } finally { rmSync(fx.base, { recursive: true, force: true }); }
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

/** Wrap the fixture lsof so every call also prints the warning macOS lsof gives for a mount it cannot stat. */
function warnAbout(fx: Fixture, mount: string): string {
  const wrapper = join(fx.base, "lsof-warning");
  writeFileSync(wrapper, [
    "#!/bin/bash",
    `printf '%s\\n' "lsof: WARNING: can't stat() devicefs file system ${mount}" "      Output information may be incomplete." '      assuming "dev=30000004" from mount table' >&2`,
    `exec ${JSON.stringify(fx.lsof)} "$@"`,
  ].join("\n") + "\n", { mode: 0o755 });
  return wrapper;
}

test("a mount lsof cannot stat elsewhere does not keep every idle scratch path", () => {
  // 2026-10-28: another account's CoreDevice DeviceFS made lsof warn on every call, and the
  // warning was read as an open file, so /private/tmp kept 149 idle entries and deleted none.
  const fx = fixture();
  try {
    mkdirSync(join(fx.root, "old-scratch"));
    writeFileSync(join(fx.root, "old-scratch", "f"), "x");
    writeFileSync(join(fx.root, "old-notes.txt"), "x");
    age(fx.root, HOURS_AGO(8));
    const { out } = reclaim(fx, 40, true, { RMD_RECLAIM_LSOF: warnAbout(fx, "/Users/other/Library/Developer/CoreDevice/DeviceFS") });
    assert.ok(!existsSync(join(fx.root, "old-scratch")), out);
    assert.ok(!existsSync(join(fx.root, "old-notes.txt")), out);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("a mount lsof cannot stat inside a scratch path still keeps that path", () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.root, "image-session", "v"), { recursive: true });
    writeFileSync(join(fx.root, "image-session", "scratch.dmg"), "x");
    mkdirSync(join(fx.root, "old-scratch"));
    age(fx.root, HOURS_AGO(8));
    const mount = join(realpathSync(fx.root), "image-session", "v");
    const { out } = reclaim(fx, 40, true, { RMD_RECLAIM_LSOF: warnAbout(fx, mount) });
    assert.ok(existsSync(join(fx.root, "image-session", "scratch.dmg")), out);
    assert.match(out, /KEEP RISKY \((cwd scan unavailable|open file or lsof scan uncertain)\): .*image-session/);
    assert.ok(!existsSync(join(fx.root, "old-scratch")), out);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("an unexplained lsof warning keeps the path", () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.root, "old-scratch"));
    age(fx.root, HOURS_AGO(8));
    const wrapper = join(fx.base, "lsof-odd");
    writeFileSync(wrapper, `#!/bin/bash\necho 'lsof: WARNING: something else went wrong' >&2\nexec ${JSON.stringify(fx.lsof)} "$@"\n`, { mode: 0o755 });
    const { out } = reclaim(fx, 40, true, { RMD_RECLAIM_LSOF: wrapper });
    assert.ok(existsSync(join(fx.root, "old-scratch")), out);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("host-service names and the account keep list are never reclaimed", () => {
  const fx = fixture();
  try {
    const kept = ["openclaw", "ollama", "podcast-discovery-cache", "outer/openclaw-worker",
      "mixed/ollama-models", "mixed/podcast-cache"];
    for (const name of [...kept, "old-scratch"]) {
      mkdirSync(join(fx.root, name), { recursive: true });
      writeFileSync(join(fx.root, name, "f"), "x");
    }
    writeFileSync(join(fx.base, "keep.txt"), "# extra names\n\npodcast-*\n");
    age(fx.root, HOURS_AGO(8));
    writeFileSync(join(fx.root, "mixed", "fresh.txt"), "recent sibling\n");
    const { out } = reclaim(fx, 40);
    for (const name of kept) {
      assert.ok(existsSync(join(fx.root, name, "f")), name + ": " + out);
    }
    assert.match(out, /kept host-service name \(podcast-\*\)/);
    assert.ok(!existsSync(join(fx.root, "old-scratch")), out);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("host-service names and the account keep list are never reclaimed during cache cleanup", () => {
  for (const options of [[], ["--tsx-only"]]) {
    const fx = fixture();
    try {
      const hash = `17920-${"a".repeat(40)}`;
      const keptCaches = [
        join(fx.root, "tsx-701"), join(fx.root, "rt", "tsx-702"),
        join(fx.root, "job", "tsx-703"), join(fx.base, "tsx-704"),
        ...["openclaw-worker", "ollama-runtime", "podcast-cache"].map(name =>
          join(fx.root, name, "deep", "tsx-801")),
      ];
      const control = join(fx.root, "tsx-999");
      for (const cache of [...keptCaches, control]) {
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(cache, hash), "compiled cache\n");
      }
      const nodeCaches = [join(fx.root, "node-compile-cache"),
        join(fx.root, "rt", "node-compile-cache"), join(fx.base, "node-compile-cache")];
      for (const cache of nodeCaches) {
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(cache, "old-cache"), "node compiled cache\n");
      }
      const calls = join(fx.base, "python-calls.txt");
      const python = sh(fx.base, "sh", "-c", "command -v python3").trim();
      // Observe delegation too: real kernel ctime could otherwise hide a bypass.
      writeFileSync(join(fx.bin, "python3"), [
        `#!${process.execPath}`,
        `require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));`,
        `const r = require("node:child_process").spawnSync(${JSON.stringify(python)}, process.argv.slice(2), { stdio: "inherit" });`,
        "process.exit(r.status ?? 1);",
      ].join("\n") + "\n", { mode: 0o755 });
      writeFileSync(join(fx.base, "keep.txt"), "# extra names\n\npodcast-*\ntsx-70?\nnode-compile-cache\n");
      age(fx.root, HOURS_AGO(8));
      for (const cache of [keptCaches[3]!, nodeCaches[2]!]) age(cache, HOURS_AGO(8));

      const { out, report } = reclaim(fx, 40, true, {}, options);
      for (const cache of keptCaches) {
        assert.equal(readFileSync(join(cache, hash), "utf8"), "compiled cache\n", cache + out);
      }
      for (const cache of nodeCaches) {
        assert.equal(readFileSync(join(cache, "old-cache"), "utf8"), "node compiled cache\n");
      }
      assert.equal(existsSync(calls), false, "kept Node caches never reach the removal helper: " + out);
      if (options.length === 0) {
        assert.equal(existsSync(join(control, hash)), false, "unkept TSX content is reclaimed: " + out);
      }
      // Require the keep decision for each discovered path so another safety
      // gate cannot silently mask a missing keep check during discovery.
      for (const cache of keptCaches.filter(cache => cache.startsWith(fx.root + "/"))) {
        assert.ok(report.split("\n").some(line => line.startsWith("kept host-service name (") &&
          line.endsWith(" | " + realpathSync(cache))), "discovery applies the keep rule to " + cache + ": " + report);
      }
      assert.match(report, /kept host-service name \(tsx-70\?\)/);
      assert.match(report, /kept host-service name \(openclaw\*\)/);
      assert.match(report, /kept host-service name \(ollama\*\)/);
      assert.match(report, /kept host-service name \(podcast-\*\)/);
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  }
});

test("a dangling link into a removed part of the same scratch tree does not keep it", () => {
  // rmd copy-on-write fixtures leave `<wt>-linked/node_modules -> <tree>/<wt>/node_modules` after <wt> is gone.
  const fx = fixture();
  try {
    const tree = join(fx.root, "w1-fixture");
    mkdirSync(join(tree, "wt-linked"), { recursive: true });
    symlinkSync(join(realpathSync(fx.root), "w1-fixture", "wt", "node_modules"), join(tree, "wt-linked", "node_modules"));
    const outside = join(fx.root, "w2-fixture");
    mkdirSync(join(outside, "wt-linked"), { recursive: true });
    symlinkSync(join(fx.base, "gone", "node_modules"), join(outside, "wt-linked", "node_modules"));
    age(fx.root, HOURS_AGO(8));
    const { out } = reclaim(fx, 40);
    assert.ok(!existsSync(tree), out);
    assert.ok(existsSync(outside), "a dangling link out of the tree still keeps it: " + out);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});
