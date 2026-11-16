/**
 * W1-T12257 — deploy/mac/tmp-reclaim.sh judges the fleet's own names in the temp folder of the
 * account, and only those. The suite runs the REAL script against a fixture temp folder (TMPDIR),
 * with stand-in ps/lsof/crontab and audited find/du/stat, so no real process or path is read.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy/mac/tmp-reclaim.sh");
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

function command(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const r = spawnSync(file, args, { encoding: "utf8", ...options });
  assert.equal(r.status, 0, `${file} ${args.join(" ")}: ${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

// The script judges age with `find -mmin` against the OS clock a child reads, so stamps come from
// that same clock (a real `date`), never from this process's Date.now().
const osNowMs = () => Number(command("date", ["+%s"]).trim()) * 1000;

/** Set every file, directory and link under `path` to `hours` ago. */
function age(path: string, hours: number): void {
  const when = new Date(osNowMs() - hours * 3600_000);
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}${two(when.getHours())}${two(when.getMinutes())}`;
  command("find", [path, "-exec", "touch", "-h", "-t", stamp, "{}", "+"], { cwd: dirname(path) });
}

interface Fixture { base: string; root: string; user: string; processes: string; cwds: string; open: string; audit: string; report: string; env: NodeJS.ProcessEnv }

function fixture(): Fixture {
  // Darwin's account temp directory stays outside /private/tmp; Linux uses its writable scratch.
  const writable = process.platform === "darwin" ? command("getconf", ["DARWIN_USER_TEMP_DIR"]).trim() : tmpdir();
  const base = realpathSync(mkdtempSync(join(writable, "rmd-user-tmp-fleet-")));
  const root = join(base, "tmp"), user = join(base, "user"), sessions = join(base, "sessions"), bin = join(base, "bin");
  for (const p of [root, user, sessions, bin, join(base, "home")]) mkdirSync(p);
  const processes = join(base, "processes"), cwds = join(base, "cwds"), open = join(base, "open"), audit = join(base, "audit");
  for (const p of [processes, cwds, open, audit]) writeFileSync(p, "");
  const real = (tool: string) => command("/bin/sh", ["-c", `command -v ${tool}`]).trim();
  const log = `printf '%s\\n' "$*" >> ${quote(audit)}`;
  // A fixture can backdate mtime, not kernel ctime, so the audited find reads ctime as mtime.
  writeFileSync(join(bin, "find"), `#!/bin/bash\n${log}\nargs=(); for arg; do if [ "$arg" = -cmin ]; then args+=(-mmin); else args+=("$arg"); fi; done\nexec ${quote(real("find"))} "\${args[@]}"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "du"), `#!/bin/bash\n${log}\nexec ${quote(real("du"))} "$@"\n`, { mode: 0o755 });
  // An entry named rmd-foreign-* reads as owned by another account.
  writeFileSync(join(bin, "stat"), `#!/bin/bash\n${log}\nlast=""; for arg; do last=$arg; done\ncase "\${last##*/}" in rmd-foreign-*) echo fixture-other; exit 0;; esac\nexec ${quote(real("stat"))} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "ps"), `#!/bin/sh\ncat ${quote(processes)}\n`, { mode: 0o755 });
  writeFileSync(join(bin, "crontab"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const lsof = join(bin, "lsof");
  writeFileSync(lsof, `#!/bin/bash
${log}
case " $* " in *" cwd "*) while IFS= read -r p; do [ -z "$p" ] || printf 'p1\\nn%s\\n' "$p"; done < ${quote(cwds)}; exit 0;; esac
target="\${@: -1}"; status=1
while IFS= read -r p; do case "$p" in "$target"|"$target"/*) printf 'p1\\nn%s\\n' "$p"; status=0;; esac; done < ${quote(open)}
exit "$status"
`, { mode: 0o755 });
  const report = join(base, "report");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(base, "home"), PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: user, RMD_RECLAIM_ROOT: root, RMD_RECLAIM_SESSION_ROOT: sessions, RMD_RECLAIM_REPORT: report,
    RMD_RECLAIM_LSOF: lsof, RMD_RECLAIM_TSX_FIND: join(bin, "find"), RMD_RECLAIM_KEEP_FILE: join(base, "keep"), RMD_RECLAIM_FREE_PCT: "30" };
  return { base, root, user, processes, cwds, open, audit, report, env };
}

/** A directory entry holding one file, `hours` old. */
function entry(fx: Fixture, name: string, hours = 12, body = "leftover"): string {
  const path = join(fx.user, name);
  mkdirSync(path);
  writeFileSync(join(path, "data.json"), body);
  age(path, hours);
  return path;
}

function reclaim(fx: Fixture, args: string[], env: NodeJS.ProcessEnv = {}): { out: string; report: string } {
  const out = command("/bin/bash", [SCRIPT, ...args], { env: { ...fx.env, ...env } });
  return { out, report: existsSync(fx.report) ? readFileSync(fx.report, "utf8") : "" };
}

test("W1-T12257 criterion 1: the regular pass judges only direct children of the account temp folder named rmd-* or remudero-*", () => {
  const fx = fixture();
  try {
    const capture = entry(fx, "rmd-census-capture-AbC123");
    const legacy = entry(fx, "remudero-pr-fix");
    const loose = join(fx.user, "rmd-loose.json");
    writeFileSync(loose, "{}"); age(loose, 12);
    const other = entry(fx, "other-AbC123");
    const nested = join(other, "rmd-nested-XyZ789");
    mkdirSync(nested); writeFileSync(join(nested, "data.json"), "nested"); age(other, 12);
    const { out } = reclaim(fx, ["--apply"]);
    for (const gone of [capture, legacy, loose]) assert.equal(existsSync(gone), false, gone + out);
    assert.ok(existsSync(join(nested, "data.json")), "a fleet name below another direct child is never judged: " + out);
    assert.match(out, /^leftover stem=rmd-census-capture removed=1 bytes=[1-9][0-9]* *$/m, out);
    assert.match(out, /^leftover stem=remudero-pr-fix removed=1 /m, out);
    assert.doesNotMatch(out, /leftover stem=(other|rmd-nested)/, out);
    // When the account temp folder IS the main root, the main loop has judged it: no second pass.
    const again = entry(fx, "rmd-again-AbC123");
    const equal = reclaim(fx, ["--dry-run"], { RMD_RECLAIM_ROOT: fx.user }).out;
    assert.doesNotMatch(equal, /^leftover /m, equal);
    assert.ok(existsSync(again));
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12257 criterion 2: an owned fleet entry with nothing changed for six hours and no process using it is removed", () => {
  const fx = fixture();
  try {
    const idle = entry(fx, "rmd-idle-AbC123");
    const young = entry(fx, "rmd-young-AbC123", 1);
    const busy = entry(fx, "rmd-busy-AbC123");
    const foreign = entry(fx, "rmd-foreign-AbC123");
    writeFileSync(fx.processes, `node worker.js --scratch ${busy}\n`);
    const { out, report } = reclaim(fx, ["--apply"]);
    assert.equal(existsSync(idle), false, out);
    assert.ok(existsSync(join(young, "data.json")), "an entry younger than six hours stays: " + out);
    assert.ok(existsSync(join(busy, "data.json")), "an entry a process names stays: " + out);
    assert.ok(existsSync(join(foreign, "data.json")), "an entry of another account stays: " + out);
    assert.match(report, /process command references path \| .*rmd-busy-AbC123/, report);
    assert.match(report, /owned by fixture-other.*rmd-foreign-AbC123/, report);
    assert.match(out, /^leftover stem=rmd-idle removed=1 bytes=[1-9]/m, out);
    assert.match(out, /^leftover stem=rmd-busy removed=0 bytes=0$/m, out);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12257 criterion 3: entries with any other name are never removed or opened, at any age", () => {
  const fx = fixture();
  try {
    const others = ["daemon-x", "claude-x", "com.apple.x", "daemon-AbC123"].map((name) => entry(fx, name, 7 * 24));
    const control = entry(fx, "rmd-control-AbC123");
    writeFileSync(fx.audit, "");
    const { out } = reclaim(fx, ["--apply"]);
    assert.equal(existsSync(control), false, "the same pass removes a fleet entry: " + out);
    for (const p of others) assert.equal(readFileSync(join(p, "data.json"), "utf8"), "leftover", p + out);
    const audit = readFileSync(fx.audit, "utf8");
    assert.match(audit, /rmd-control-AbC123/, "the audit saw the pass open the fleet entry");
    for (const name of ["daemon-x", "claude-x", "com.apple.x", "daemon-AbC123"]) {
      assert.equal(audit.includes(name), false, `${name} was opened:\n${audit}`);
      assert.equal(out.includes(join(fx.user, name)), false, out);
    }
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12257 criterion 4: a fleet entry in use, changed inside six hours, or holding a lock, pid file or Git checkout stays", () => {
  const fx = fixture();
  try {
    const control = entry(fx, "rmd-idle-AbC123");
    const ps = entry(fx, "rmd-ps-AbC123");
    const cwd = entry(fx, "rmd-cwd-AbC123");
    const open = entry(fx, "rmd-open-AbC123");
    const recent = entry(fx, "rmd-recent-AbC123");
    writeFileSync(join(recent, "current.json"), "being written");
    const lock = entry(fx, "rmd-lock-AbC123");
    writeFileSync(join(lock, "held.lock"), ""); age(lock, 12);
    const pid = entry(fx, "rmd-pid-AbC123");
    mkdirSync(join(pid, "run")); writeFileSync(join(pid, "run", "daemon.pid"), "4242"); age(pid, 12);
    const git = entry(fx, "rmd-git-AbC123");
    const repo = gitRepo({ kind: "user-tmp-fleet-checkout" });
    cpSync(repo.dir, join(git, "repo"), { recursive: true }); repo.cleanup(); age(git, 12);
    writeFileSync(fx.processes, `node runner.js ${ps}\n`);
    writeFileSync(fx.cwds, `${cwd}\n`);
    writeFileSync(fx.open, `${join(open, "data.json")}\n`);
    const { out, report } = reclaim(fx, ["--apply"]);
    assert.equal(existsSync(control), false, out);
    for (const p of [ps, cwd, open, lock, pid]) assert.ok(existsSync(join(p, "data.json")), p + out + report);
    assert.ok(existsSync(join(recent, "current.json")), out);
    assert.ok(existsSync(join(lock, "held.lock")) && existsSync(join(pid, "run", "daemon.pid")));
    assert.ok(existsSync(join(git, "repo", ".git", "HEAD")), out + report);
    assert.match(report, /process working directory is inside path \| .*rmd-cwd-AbC123/, report);
    assert.match(report, /open file or lsof scan uncertain \| .*rmd-open-AbC123/, report);
    assert.match(report, /holds a lock file, pid file or socket: .*held\.lock/, report);
    assert.match(report, /holds a lock file, pid file or socket: .*daemon\.pid/, report);
    assert.match(report, /Git checkout\/worktree: .*rmd-git-AbC123/, report);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12257 criterion 4: a fleet entry holding a socket stays", () => {
  const fx = fixture();
  try {
    const control = entry(fx, "rmd-idle-AbC123");
    const sock = entry(fx, "rmd-sock-AbC123");
    // A short relative path respects macOS's Unix-socket path limit; the name is not *.sock.
    command(process.execPath, ["-e", 'require("node:net").createServer().listen("ipc", () => process.exit(0));'], { cwd: sock });
    age(sock, 12);
    const { out, report } = reclaim(fx, ["--apply"]);
    assert.equal(existsSync(control), false, out);
    assert.ok(existsSync(join(sock, "data.json")), out + report);
    assert.match(report, /holds a lock file, pid file or socket: .*ipc/, report);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12257 criterion 5: a fleet entry with a symlink out of the temp folder stays, and its target is never removed", () => {
  const fx = fixture();
  try {
    const control = entry(fx, "rmd-idle-AbC123");
    const outside = join(fx.base, "outside"), aliased = join(fx.base, "aliased");
    for (const p of [outside, aliased]) { mkdirSync(p); writeFileSync(join(p, "keep.txt"), "outside"); age(p, 12); }
    const linked = entry(fx, "rmd-linked-AbC123");
    symlinkSync(outside, join(linked, "out")); age(linked, 12);
    const alias = join(fx.user, "rmd-alias-AbC123");
    symlinkSync(aliased, alias); age(alias, 12);
    const { out, report } = reclaim(fx, ["--apply"]);
    assert.equal(existsSync(control), false, out);
    assert.ok(existsSync(join(linked, "data.json")), out + report);
    assert.match(report, /contains symlink outside cleanup root: .*rmd-linked-AbC123\/out/, report);
    assert.match(report, /symbolic link \| .*rmd-alias-AbC123/, report);
    for (const p of [outside, aliased]) assert.equal(readFileSync(join(p, "keep.txt"), "utf8"), "outside", p + out);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12257 criterion 6: a dry run lists each fleet entry that would go with its size, and cache-only mode never judges them", () => {
  const fx = fixture();
  try {
    const dry = entry(fx, "rmd-dry-AbC123");
    const { out } = reclaim(fx, ["--dry-run"]);
    assert.match(out, new RegExp(`^WOULD DELETE ${dry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\([0-9]+ KiB\\)$`, "m"), out);
    assert.match(out, /^leftover stem=rmd-dry removed=1 bytes=[1-9]/m, out);
    assert.ok(existsSync(join(dry, "data.json")), "a dry run removes nothing: " + out);
    const cacheOnly = reclaim(fx, ["--apply", "--tsx-only"]).out;
    assert.ok(existsSync(join(dry, "data.json")), "cache-only mode never removes a fleet entry: " + cacheOnly);
    assert.doesNotMatch(cacheOnly, /^leftover |^unowned |rmd-dry-AbC123/m, cacheOnly);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12257 criterion 7: each pass prints removed count and bytes per fleet stem, and the mkdtemp-shaped names it left per stem", () => {
  const fx = fixture();
  try {
    const removed = ["rmd-census-capture-AbC123", "rmd-census-capture-XyZ789"].map((name) => entry(fx, name, 12, "x".repeat(10_000)));
    const held = entry(fx, "rmd-census-capture-Held01");
    writeFileSync(join(held, "slot.lock"), ""); age(held, 12);
    entry(fx, "rmd-t1234", 1);
    for (const name of ["daemon-AbC123", "daemon-XyZ789", "daemon-freshness-Qq1234", "com.apple.launchd.AbCdEf", "daemon-x", "claude-x"]) {
      entry(fx, name, 7 * 24);
    }
    const bytes = removed.reduce((sum, p) => sum + Number(command("du", ["-xsk", p]).split("\t")[0]) * 1024, 0);
    const { out } = reclaim(fx, ["--apply"]);
    for (const p of removed) assert.equal(existsSync(p), false, out);
    assert.ok(existsSync(held));
    assert.match(out, new RegExp(`^leftover stem=rmd-census-capture removed=2 bytes=${bytes}$`, "m"), out);
    assert.match(out, /^leftover stem=rmd-t1234 removed=0 bytes=0$/m, out);
    assert.match(out, /^unowned stem=daemon left=2$/m, out);
    assert.match(out, /^unowned stem=daemon-freshness left=1$/m, out);
    assert.match(out, /^unowned stem=com\.apple\.launchd left=1$/m, out);
    assert.doesNotMatch(out, /^unowned stem=(daemon-x|claude-x|claude|rmd-)/m, out);
    assert.equal(out.match(/^leftover stem=rmd-census-capture /gm)?.length, 1, "one line per stem: " + out);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});
