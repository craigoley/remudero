import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy/mac/tmp-reclaim.sh");
const source = readFileSync(SCRIPT, "utf8");
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function command(file: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = spawnSync(file, args, { encoding: "utf8", env });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  return r.stdout;
}
function fixture() {
  // Proof checkouts and their parents are read-only. Darwin's account temp directory stays
  // outside /private/tmp even when a runner sets TMPDIR there; Linux uses its writable proof scratch.
  const writable = process.platform === "darwin" ? command("getconf", ["DARWIN_USER_TEMP_DIR"]).trim() : tmpdir();
  const base = realpathSync(mkdtempSync(join(writable, "rmd-tsx-alias-fixture-")));
  const root = join(base, "tmp"), user = join(base, "user"), sessions = join(base, "sessions"), bin = join(base, "bin");
  for (const p of [root, user, sessions, bin, join(base, "home")]) mkdirSync(p);
  const processes = join(base, "processes"), cwds = join(base, "cwds"), open = join(base, "open");
  for (const p of [processes, cwds, open]) writeFileSync(p, "");
  const find = command("/bin/sh", ["-c", "command -v find"]).trim();
  const python = command("/bin/sh", ["-c", "command -v python3"]).trim();
  const audit = join(base, "node-compile-visited");
  writeFileSync(join(bin, "find"), `#!/bin/bash\nargs=(); for arg; do if [ "$arg" = -cmin ]; then args+=(-mmin); else args+=("$arg"); fi; done\nexec ${quote(find)} "\${args[@]}"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "ps"), `#!/bin/sh\ncat ${quote(processes)}\n`, { mode: 0o755 });
  writeFileSync(join(bin, "crontab"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "python3"), `#!/bin/sh\ncase " $* " in *" --node-compile-cache "*) : > ${quote(audit)}; echo FIXTURE_NODE_COMPILE_VISIT; exit 0;; esac\nexec ${quote(python)} "$@"\n`, { mode: 0o755 });
  const lsof = join(bin, "lsof");
  writeFileSync(lsof, `#!/bin/bash
case " $* " in *" cwd "*) while IFS= read -r p; do [ -z "$p" ] || printf 'p1\\nn%s\\n' "$p"; done < ${quote(cwds)}; exit 0;; esac
target="\${@: -1}"; status=1
while IFS= read -r p; do case "$p" in "$target"|"$target"/*) printf 'p1\\nn%s\\n' "$p"; status=0;; esac; done < ${quote(open)}
exit "$status"
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(base, "home"), PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: user, RMD_RECLAIM_ROOT: root, RMD_RECLAIM_SESSION_ROOT: sessions, RMD_RECLAIM_REPORT: join(base, "report"),
    RMD_RECLAIM_LSOF: lsof, RMD_RECLAIM_TSX_FIND: join(bin, "find"), RMD_RECLAIM_KEEP_FILE: join(base, "keep"), RMD_RECLAIM_FREE_PCT: "30" };
  const cache = join(user, `tsx-${userInfo().uid}`);
  mkdirSync(cache);
  const old = join(cache, `1-${"a".repeat(40)}`), recent = join(cache, `2-${"b".repeat(40)}`);
  writeFileSync(old, "old"); writeFileSync(recent, "recent");
  // mtime can be backdated; the fixture find maps ctime to it, matching the maintained test style.
  // The native metadata control remains in the existing scratch-cleaner suite.
  const now = Number(command("date", ["+%s"]).trim()) * 1000;
  const floor = Number(/^AGE_MIN=([0-9]+)$/m.exec(source)![1]);
  const stamp = new Date(now - floor * 2 * 60_000);
  utimesSync(old, stamp, stamp);
  return { base, root, user, sessions, bin, processes, cwds, open, env, cache, old, recent, stamp, audit };
}

test("W1-T11461 criterion 1: aliases follow the cache candidate and preserve genuine full tmp suffixes", () => {
  const fx = fixture();
  try {
    assert.equal(realpathSync(fx.cache).startsWith("/private/tmp/"), false);
    writeFileSync(fx.processes, `/tmp/${fx.cache.split("/").at(-1)}\n`);
    const boundary = '\ncd "$ROOT" || exit 1\n';
    assert.equal(source.split(boundary).length, 2);
    const harness = join(fx.base, "prefix.sh");
    const cacheName = fx.cache.split("/").at(-1)!;
    writeFileSync(harness, source.split(boundary)[0] + `
source ${quote(join(REPO_ROOT, "deploy/dependency-seed-guard.sh"))}
ROOT_REAL=/private/tmp
if path_is_live_or_unknown ${quote(`/user-cache/${cacheName}`)}; then echo OUTSIDE_ALIAS_FALSE_HOLD; else echo OUTSIDE_ALIAS_CLEAR; fi
prune_tsx_cache ${quote(fx.cache)} 1
printf 'OUTSIDE_ELIGIBLE=%s\\n' "$TSX_PRUNED_N"
printf '%s\\n' ${quote(`/tmp/rt/nested/${cacheName}`)} > ${quote(fx.processes)}
if path_is_live_or_unknown ${quote(`/private/tmp/rt/nested/${cacheName}`)}; then echo REAL_ALIAS_HELD; else echo REAL_ALIAS_LOST; fi
: > ${quote(fx.processes)}
printf '%s\\n' ${quote(`/tmp/rt/nested/${cacheName}`)} > ${quote(fx.cwds)}
if path_is_live_or_unknown ${quote(`/private/tmp/rt/nested/${cacheName}/leaf`)}; then echo REAL_CWD_HELD; else echo REAL_CWD_LOST; fi
: > ${quote(fx.cwds)}
`, { mode: 0o755 });
    const out = command("/bin/bash", [harness], fx.env);
    assert.match(out, /^OUTSIDE_ALIAS_CLEAR$/m, out);
    assert.equal(out.includes("OUTSIDE_ALIAS_FALSE_HOLD"), false, out);
    assert.match(out, /^OUTSIDE_ELIGIBLE=1$/m, out);
    assert.match(out, /^REAL_ALIAS_HELD$/m, out);
    assert.match(out, /^REAL_CWD_HELD$/m, out);
    assert.equal(out.includes("REAL_ALIAS_LOST"), false);
    assert.equal(out.includes("REAL_CWD_LOST"), false);
    assert.ok(existsSync(fx.old) && existsSync(fx.recent), "the harness only dry-runs fixture data");
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});

test("W1-T11461 criterion 2: cache-only visits the distinct user root without Node or session cleanup", () => {
  const fx = fixture();
  try {
    assert.notEqual(realpathSync(fx.root), realpathSync(fx.user));
    const other = join(fx.user, "tsx-not-a-number"); mkdirSync(other);
    const otherFile = join(other, `3-${"c".repeat(40)}`); writeFileSync(otherFile, "unrecognized cache"); utimesSync(otherFile, fx.stamp, fx.stamp);
    mkdirSync(join(fx.user, "node-compile-cache"));
    writeFileSync(join(fx.user, "node-compile-cache", "old"), "unrelated Node cache");
    writeFileSync(join(fx.sessions, "old"), "unrelated session");
    const run = () => command("/bin/bash", [SCRIPT, "--dry-run", "--tsx-only"], fx.env);
    const out = run();
    assert.match(out, /tsx files would-prune: 1\b/, out);
    assert.equal(out.includes("FIXTURE_NODE_COMPILE_VISIT"), false, out);
    assert.equal(out.includes("node-compile-cache"), false, out);
    assert.equal(existsSync(fx.audit), false);
    assert.ok(existsSync(fx.cache) && existsSync(fx.recent) && existsSync(fx.old));
    const equal = command("/bin/bash", [SCRIPT, "--dry-run", "--tsx-only"], { ...fx.env, RMD_RECLAIM_ROOT: fx.user });
    assert.match(equal, /tsx files would-prune: 1\b/, "equal resolved roots must not double-count the cache");
    writeFileSync(fx.open, fx.old + "\n");
    assert.match(run(), /tsx files would-prune: 0\b/, "an open cache remains protected");
    writeFileSync(fx.open, "");
    const opaque = join(fx.cache, "operator-note.txt"); writeFileSync(opaque, "retain unknown data"); utimesSync(opaque, fx.stamp, fx.stamp);
    const unknown = run();
    assert.match(unknown, /tsx files would-prune: 0\b/, unknown);
    assert.match(unknown, /unrecognized or special data/, unknown);
    assert.ok(existsSync(opaque) && existsSync(otherFile));
  } finally { rmSync(fx.base, { recursive: true, force: true }); }
});
