/**
 * W1-T12252: the Mac janitor trims the tsx cache while a tsx process runs.
 *
 * On 2026-11-11 the tsx cache of the Mac agent account reached 7.4 GB. The scheduled temp cleaner
 * removed nothing from it, because one open file held the whole cache. This suite runs the REAL
 * deploy/mac/tmp-reclaim.sh, and the real scheduled janitor, against private fixture directories.
 * It never reads or changes the real temp folder of the account.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync,
  symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { age as ageTree, fixture as janitorFixture } from "#test/helpers/host-cleanup-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy/mac/tmp-reclaim.sh");
const JANITOR = join(REPO_ROOT, "deploy/mac/remudero-janitor.sh");
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const hash = (letter: string) => `17920-${letter.repeat(40)}`;

function command(file: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = spawnSync(file, args, { encoding: "utf8", env });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  return r.stdout;
}
const tool = (name: string) => command("/bin/sh", ["-c", `command -v ${name}`]).trim();
// The script judges age with `find -mmin` against the OS clock, so stamps come from a real `date`.
const hoursAgo = (hours: number) => new Date(Number(command("date", ["+%s"]).trim()) * 1000 - hours * 3600_000);
function age(path: string, hours: number): void {
  const stamp = hoursAgo(hours);
  utimesSync(path, stamp, stamp);
}

interface Fx {
  base: string; root: string; user: string; bin: string; outside: string; cache: string;
  processes: string; cwds: string; open: string; env: NodeJS.ProcessEnv;
}

/**
 * A private temp root with one tsx cache in the per-user temp folder, plus stand-ins for `ps`,
 * `lsof` and `crontab`, so no case depends on the real processes of the host. `processes` is what
 * `ps` prints, `cwds` lists working directories and `open` lists the paths that lsof reports open.
 */
function fixture(): Fx {
  // Proof checkouts are read-only; the account temp folder is writable on Darwin.
  const writable = process.platform === "darwin" ? command("getconf", ["DARWIN_USER_TEMP_DIR"]).trim() : tmpdir();
  const base = realpathSync(mkdtempSync(join(writable, "rmd-tsx-trim-fixture-")));
  const [root, user, sessions, bin, home, outside] = ["tmp", "user", "sessions", "bin", "home", "outside"].map(name => join(base, name));
  for (const dir of [root, user, sessions, bin, home, outside]) mkdirSync(dir!);
  const [processes, cwds, open] = ["processes", "cwds", "open"].map(name => join(base, name));
  for (const file of [processes, cwds, open]) writeFileSync(file!, "");
  const find = tool("find");
  // A fixture can backdate mtime, not kernel ctime. This stand-in reads ctime from mtime; the
  // native ctime control below passes the real find.
  writeFileSync(join(bin!, "find-age"), `#!/bin/bash\nargs=(); for arg; do if [ "$arg" = -cmin ]; then args+=(-mmin); else args+=("$arg"); fi; done\nexec ${quote(find)} "\${args[@]}"\n`, { mode: 0o755 });
  writeFileSync(join(bin!, "ps"), `#!/bin/sh\n[ "\${FIXTURE_PS_FAIL:-0}" != 1 ] || exit 1\ncat ${quote(processes!)}\n`, { mode: 0o755 });
  writeFileSync(join(bin!, "crontab"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // FIXTURE_LSOF_FAIL_AT=<n> makes the n-th open-file read of a run fail, as an lsof that cannot scan.
  // With FIXTURE_LSOF_FAIL_PARTIAL=1 that read prints the names it found before it fails.
  // A dry run reads twice and an applied pass four times: each check reads once to find any use and
  // once more for the names, and an applied pass checks again just before the delete.
  writeFileSync(join(bin!, "lsof"), `#!/bin/bash
case " $* " in *" cwd "*) while IFS= read -r p; do [ -z "$p" ] || printf 'p1\\nn%s\\n' "$p"; done < ${quote(cwds!)}; exit 0;; esac
calls=$(cat ${quote(join(base, "lsof-calls"))} 2>/dev/null || echo 0); calls=$((calls + 1)); echo "$calls" > ${quote(join(base, "lsof-calls"))}
fail=0; [ "\${FIXTURE_LSOF_FAIL_AT:-0}" != "$calls" ] || fail=1
[ "$fail:\${FIXTURE_LSOF_FAIL_PARTIAL:-0}" != 1:0 ] || exit 2
target="\${@: -1}"; status=1
while IFS= read -r p; do
  [ -n "$p" ] || continue
  if [ "\${FIXTURE_LSOF_ANY_PATH:-0}" = 1 ]; then printf 'p1\\nn%s\\n' "$p"; status=0; continue; fi
  case "$p" in "$target"|"$target"/*) printf 'p1\\nn%s\\n' "$p"; status=0;; esac
done < ${quote(open!)}
[ "$fail" = 0 ] || exit 2
exit "$status"
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TMPDIR: user,
    RMD_RECLAIM_ROOT: root, RMD_RECLAIM_SESSION_ROOT: sessions, RMD_RECLAIM_REPORT: join(base, "report"),
    RMD_RECLAIM_LSOF: join(bin!, "lsof"), RMD_RECLAIM_TSX_FIND: join(bin!, "find-age"),
    RMD_RECLAIM_KEEP_FILE: join(base, "keep"), RMD_RECLAIM_FREE_PCT: "30",
  };
  const cache = join(user!, `tsx-${userInfo().uid}`);
  mkdirSync(cache);
  return { base, root: root!, user: user!, bin: bin!, outside: outside!, cache, processes: processes!, cwds: cwds!, open: open!, env };
}

/** Write cache files that last changed eight hours ago, one for each letter. */
function oldFiles(cache: string, letters: string): string[] {
  return [...letters].map(letter => {
    const file = join(cache, hash(letter));
    writeFileSync(file, `compiled ${letter}`);
    age(file, 8);
    return file;
  });
}

/** The cache-only call that the scheduled janitor makes. */
function pass(fx: Fx, mode: "--apply" | "--dry-run", extra: Record<string, string> = {}) {
  rmSync(join(fx.base, "lsof-calls"), { force: true });
  const r = spawnSync("/bin/bash", [SCRIPT, "--tsx-only", mode], { encoding: "utf8", env: { ...fx.env, ...extra } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const lines = (out: string, pattern: RegExp) => out.split("\n").filter(line => pattern.test(line));
const diskBytes = (files: string[]) =>
  command("du", ["-k", ...files]).trim().split("\n").reduce((sum, line) => sum + Number(line.split("\t")[0]) * 1024, 0);

test("W1-T12252 criterion 1: one held file no longer holds the cache; every other old file goes", () => {
  const fx = fixture();
  try {
    const files = oldFiles(fx.cache, "abcde");
    const held = files[2]!;
    writeFileSync(fx.open, `${held}\n`);
    const r = pass(fx, "--apply");
    assert.equal(r.status, 0, r.err);
    assert.ok(existsSync(held), r.out);
    for (const file of files) if (file !== held) assert.equal(existsSync(file), false, `${file}\n${r.out}`);
    assert.ok(existsSync(fx.cache), "the cache directory itself stays");
    assert.match(r.out, /^pruned tsx cache files=4 bytes=\d+ kept-open=1 \(older than 360 min\): /m, r.out);
    assert.match(r.out, /^tsx files pruned: 4, skipped caches=0;/m, r.out);
    assert.doesNotMatch(r.out, /KEEP RISKY/, r.out);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12252 criterion 1: with the real lsof, a file that a live process holds open is the only old file kept", { skip: spawnSync("/bin/sh", ["-c", "command -v lsof"]).status !== 0 }, () => {
  const fx = fixture(); let fd: number | undefined;
  try {
    const files = oldFiles(fx.cache, "abcd");
    fd = openSync(files[0]!, "r"); // this test process is the live holder
    // -w drops warnings about mounts that this account cannot stat; they say nothing about the fixture.
    const quiet = join(fx.bin, "lsof-quiet");
    writeFileSync(quiet, `#!/bin/bash\nexec ${quote(tool("lsof"))} -w "$@"\n`, { mode: 0o755 });
    const r = pass(fx, "--apply", { RMD_RECLAIM_LSOF: quiet });
    assert.equal(r.status, 0, r.err);
    assert.equal(readFileSync(fd, "utf8"), "compiled a", "the holder still reads its file");
    assert.ok(existsSync(files[0]!), r.out);
    for (const file of files.slice(1)) assert.equal(existsSync(file), false, `${file}\n${r.out}`);
    assert.match(r.out, /^pruned tsx cache files=3 bytes=\d+ kept-open=1 /m, r.out);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12252 criterion 2: a held file, a pid socket and a file inside the six hours all stay", () => {
  const fx = fixture();
  try {
    const [held, idle] = oldFiles(fx.cache, "ab") as [string, string];
    const young = join(fx.cache, hash("c"));
    writeFileSync(young, "fresh"); age(young, 5);
    // Bind a short relative path to respect the Unix-socket path limit.
    const bound = spawnSync(process.execPath, ["-e", 'const s=require("node:net").createServer();s.listen("123.pipe",()=>process.exit(0));'], { cwd: fx.cache, encoding: "utf8", timeout: 5000 });
    assert.equal(bound.status, 0, bound.stderr);
    const socket = join(fx.cache, "123.pipe");
    assert.ok(lstatSync(socket).isSocket());
    age(socket, 8);
    writeFileSync(fx.open, `${held}\n${socket}\n`);
    const r = pass(fx, "--apply");
    assert.equal(r.status, 0, r.err);
    assert.ok(existsSync(held) && existsSync(young), r.out);
    assert.ok(lstatSync(socket).isSocket(), r.out);
    assert.equal(existsSync(idle), false, r.out);
    assert.match(r.out, /^pruned tsx cache files=1 bytes=\d+ kept-open=1 /m, r.out);

    // When every old file is held, the pass removes nothing and says so in one line.
    const again = pass(fx, "--apply");
    assert.ok(existsSync(held), again.out);
    assert.match(again.out, /^kept tsx cache files held open=1 \(older than 360 min\): /m, again.out);
    assert.match(again.out, /^tsx files pruned: 0, skipped caches=0;/m, again.out);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12252 criterion 2: an old modification time with a change time inside the six hours stays", () => {
  const fx = fixture();
  try {
    const files = oldFiles(fx.cache, "ab"); // utimes moved mtime back; the kernel set ctime to now
    const r = pass(fx, "--apply", { RMD_RECLAIM_TSX_FIND: tool("find") });
    assert.equal(r.status, 0, r.err);
    for (const file of files) assert.ok(existsSync(file), r.out);
    assert.doesNotMatch(r.out, /pruned tsx cache files=/, r.out);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12252 criterion 3: an unreadable process list or open-file read, a working directory inside the cache, or a command that names the cache holds the whole cache", () => {
  const cases: { name: string; reason: RegExp; arrange: (fx: Fx, held: string) => Record<string, string> }[] = [
    { name: "process list unreadable", reason: /TSX cache process list unavailable/, arrange: () => ({ FIXTURE_PS_FAIL: "1" }) },
    { name: "first open-file read fails", reason: /TSX cache open file or lsof scan uncertain/, arrange: () => ({ FIXTURE_LSOF_FAIL_AT: "1" }) },
    { name: "second open-file read fails after the first found a held file", reason: /TSX cache open file or lsof scan uncertain/,
      arrange: (fx, held) => { writeFileSync(fx.open, `${held}\n`); return { FIXTURE_LSOF_FAIL_AT: "2" }; } },
    { name: "the read of the names stops part way", reason: /TSX cache open file or lsof scan uncertain/,
      arrange: (fx, held) => { writeFileSync(fx.open, `${held}\n`); return { FIXTURE_LSOF_FAIL_AT: "2", FIXTURE_LSOF_FAIL_PARTIAL: "1" }; } },
    { name: "the read before the delete fails", reason: /TSX cache open file or lsof scan uncertain/,
      arrange: (fx, held) => { writeFileSync(fx.open, `${held}\n`); return { FIXTURE_LSOF_FAIL_AT: "4" }; } },
    { name: "lsof names a path outside the cache", reason: /TSX cache open file or lsof scan uncertain/,
      arrange: fx => { writeFileSync(fx.open, `${join(fx.outside, "elsewhere")}\n`); return { FIXTURE_LSOF_ANY_PATH: "1" }; } },
    { name: "working directory inside the cache", reason: /TSX cache process working directory is inside path/,
      arrange: fx => { writeFileSync(fx.cwds, `${fx.cache}\n`); return {}; } },
    { name: "process command names the cache", reason: /TSX cache process command references path/,
      arrange: fx => { writeFileSync(fx.processes, `node --import tsx ${fx.cache}/entry\n`); return {}; } },
  ];
  for (const each of cases) {
    const fx = fixture();
    try {
      const files = oldFiles(fx.cache, "abc");
      const extra = each.arrange(fx, files[0]!);
      const r = pass(fx, "--apply", extra);
      assert.equal(r.status, 0, `${each.name}: ${r.err}`);
      for (const file of files) assert.ok(existsSync(file), `${each.name}: ${file}\n${r.out}`);
      assert.match(r.out, each.reason, `${each.name}: ${r.out}`);
      assert.match(r.out, /^tsx files pruned: 0, skipped caches=1;/m, `${each.name}: ${r.out}`);
      assert.doesNotMatch(r.out, /pruned tsx cache files=/, `${each.name}: ${r.out}`);
      assert.match(readFileSync(join(fx.base, "report"), "utf8"), each.reason, each.name);
    } finally { rmSync(fx.base, { recursive: true, force: true }); }
  }
});

test("W1-T12252 criterion 4: a symlink inside the cache that points outside holds the whole cache, and its target is never removed", () => {
  const fx = fixture();
  try {
    const files = oldFiles(fx.cache, "ab");
    const target = join(fx.outside, hash("f"));
    writeFileSync(target, "outside the cache"); age(target, 8);
    symlinkSync(target, join(fx.cache, hash("e")));
    // A cache directory that is itself a symlink is passed over, with the old file it leads to.
    const linkedDir = join(fx.outside, "linked-cache");
    mkdirSync(linkedDir);
    const [linkedFile] = oldFiles(linkedDir, "d") as [string];
    symlinkSync(linkedDir, join(fx.user, "tsx-777"));
    for (const mode of ["--dry-run", "--apply"] as const) {
      const r = pass(fx, mode);
      assert.equal(r.status, 0, r.err);
      assert.equal(readFileSync(target, "utf8"), "outside the cache", r.out);
      assert.ok(lstatSync(join(fx.cache, hash("e"))).isSymbolicLink(), r.out);
      for (const file of [...files, linkedFile]) assert.ok(existsSync(file), `${file}\n${r.out}`);
      assert.match(r.out, /KEEP RISKY \(TSX discovery contains unrecognized or special data\): /, r.out);
      assert.doesNotMatch(r.out, /prune tsx cache files=|pruned tsx cache files=/, r.out);
      assert.equal(r.out.includes("linked-cache"), false, r.out);
    }
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12252 criterion 5: a dry run prints the count and the bytes of the files that would go, and removes nothing", () => {
  const fx = fixture();
  try {
    const files = oldFiles(fx.cache, "abcde");
    writeFileSync(files[1]!, "x".repeat(70_000)); age(files[1]!, 8);
    writeFileSync(fx.open, `${files[4]}\n`);
    const expected = diskBytes(files.slice(0, 4));
    const r = pass(fx, "--dry-run");
    assert.equal(r.status, 0, r.err);
    for (const file of files) assert.ok(existsSync(file), `${file}\n${r.out}`);
    const line = lines(r.out, /^would prune tsx cache files=/);
    assert.equal(line.length, 1, r.out);
    assert.equal(line[0], `would prune tsx cache files=4 bytes=${expected} kept-open=1 (older than 360 min): ${fx.cache}`);
    assert.ok(expected >= 70_000);
    assert.match(r.out, /^tsx files would-prune: 4, skipped caches=0;/m, r.out);
    assert.equal(existsSync(join(fx.base, "report")), false, "a dry run writes no report of kept paths");
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12252 criterion 6: an applied pass prints one line for each cache, and a vanished or unreadable file does not stop it", () => {
  const fx = fixture();
  try {
    const first = oldFiles(fx.cache, "abcd");
    chmodSync(first[0]!, 0o000); // an unreadable file is still removed by its owner
    const expectedFirst = diskBytes(first.slice(0, 3));
    // A second cache under the scan root, beside a Git fixture as in a real job temp folder.
    const job = join(fx.root, "historical-ci");
    const nested = join(job, "tsx-501");
    mkdirSync(nested, { recursive: true }); mkdirSync(join(job, "fixture", ".git"), { recursive: true });
    const second = oldFiles(nested, "ab");
    writeFileSync(fx.open, `${second[0]}\n`);
    // This find removes one listed file after each listing, as a process that clears its own entry mid-pass.
    const vanishing = join(fx.bin, "find-vanish");
    writeFileSync(vanishing, `#!/bin/bash
case " $* " in
  *" -maxdepth 0 "*) exec ${quote(join(fx.bin, "find-age"))} "$@" ;;
esac
${quote(join(fx.bin, "find-age"))} "$@"; status=$?
rm -f -- ${quote(first[3]!)}
exit "$status"
`, { mode: 0o755 });
    const r = pass(fx, "--apply", { RMD_RECLAIM_TSX_FIND: vanishing });
    assert.equal(r.status, 0, r.err);
    for (const file of [...first, second[1]!]) assert.equal(existsSync(file), false, `${file}\n${r.out}`);
    assert.ok(existsSync(second[0]!), r.out);
    assert.deepEqual(lines(r.out, /^pruned tsx cache files=/).sort(), [
      // The vanished file was listed; the pass measured and removed the three that remained.
      `pruned tsx cache files=3 bytes=${expectedFirst} kept-open=0 (older than 360 min): ${fx.cache}`,
      `pruned tsx cache files=1 bytes=${diskBytes([second[0]!])} kept-open=1 (older than 360 min): ${nested}`,
    ].sort(), r.out);
    assert.match(r.out, /^tsx files pruned: 4, skipped caches=0;/m, r.out);
    assert.doesNotMatch(r.out, /KEEP RISKY \(TSX cache/, r.out);
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T12252 criterion 7: the scheduled janitor trims a cache with one held file and copies the line to its decision receipt", () => {
  const fx = janitorFixture();
  try {
    const bin = join(fx.root, "bin");
    const nativeStat = tool("stat");
    // The janitor's own age guard reads ctime; a fixture can only backdate mtime.
    writeFileSync(join(bin, "stat"), `#!/bin/bash\nif [ "$2" = '%m %c' ]; then shift 2; exec ${quote(nativeStat)} -f '%m %m' "$@"; fi\nif [ "$2" = '%Y %Z' ]; then shift 2; exec ${quote(nativeStat)} -c '%Y %Y' "$@"; fi\nexec ${quote(nativeStat)} "$@"\n`, { mode: 0o755 });
    writeFileSync(join(bin, "ps"), "#!/bin/bash\nprintf '1 /bin/sh\\n'\n", { mode: 0o755 });
    writeFileSync(join(bin, "lsof"), `#!/bin/bash
case " $* " in
  *" cwd "*) exit 0 ;;
  *" +D "*)
    target="\${@: -1}"; rc=1
    while IFS= read -r p; do case "$p" in "$target"|"$target"/*) printf 'p1\\nn%s\\n' "$p"; rc=0 ;; esac; done < ${quote(fx.lsofList)}
    exit "$rc" ;;
esac
exit 1
`, { mode: 0o755 });
    const job = join(fx.scratch, "historical-ci");
    const cache = join(job, "tsx-501");
    mkdirSync(cache, { recursive: true }); mkdirSync(join(job, "fixture", ".git"), { recursive: true });
    const files = ["a", "b", "c"].map(letter => { const file = join(cache, hash(letter)); writeFileSync(file, `compiled ${letter}`); return file; });
    ageTree(job, 8);
    const held = realpathSync(files[0]!);
    writeFileSync(fx.lsofList, `${held}\n`);
    const r = spawnSync("bash", [JANITOR, "--apply"], { encoding: "utf8", env: {
      ...process.env, HOME: fx.home, TMPDIR: fx.scratch, PATH: `${bin}:${process.env.PATH}`,
      REMUDERO_JANITOR_ACCOUNT_HOME: fx.home, REMUDERO_JANITOR_SCAN_ROOTS: fx.scratch,
      REMUDERO_JANITOR_LOG: join(fx.root, "mac.log"), REMUDERO_JANITOR_LOCK_DIR: join(fx.root, "mac.lock"),
      RMD_RECLAIM_TSX_FIND: join(bin, "find-age"),
    } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(existsSync(held), r.stdout);
    for (const file of files.slice(1)) assert.equal(existsSync(file), false, `${file}\n${r.stdout}`);
    assert.ok(existsSync(join(job, "fixture", ".git")), r.stdout);
    const line = /generated-cache: (pruned tsx cache files=2 bytes=\d+ kept-open=1 \(older than 360 min\): \S+)/.exec(r.stdout);
    assert.ok(line, r.stdout);
    assert.equal(dirname(held), realpathSync(cache));
    const rows = readFileSync(join(fx.home, ".local/state/remudero/janitor-decisions.tsv"), "utf8").trim().split("\n").map(row => row.split("\t"));
    assert.ok(rows.some(row => row[2] === "remove" && row[3] === "generated_cache_eligible" && row[4]!.includes(line[1]!)), r.stdout);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
