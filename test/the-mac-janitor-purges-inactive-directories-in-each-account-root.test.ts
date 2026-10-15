/** Runs the actual account janitor; all deletion targets and probes are private fixtures. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { age as fixtureAge, fixture, git, repos, type Fixture } from "./helpers/host-cleanup-fixture.js";

const SCRIPT = join(process.cwd(), "deploy/mac/remudero-janitor.sh");
// The clock-shift preload moves Date and fs timestamps together. fixtureAge
// already maps its shifted Date back to the OS clock used by the child shell.
function age(path: string, hours = 7) {
  fixtureAge(path, hours);
}

const native = (name: string) => execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
function probes(fx: Fixture) {
  const stat = native("stat");
  // ctime cannot be backdated. Only this fixture probe supplies mtime as ctime;
  // another case removes it and holds a genuinely fresh metadata change.
  writeFileSync(join(fx.root, "bin/stat"), `#!/bin/bash
if [ "$2" = '%m %c' ]; then shift 2; exec '${stat}' -f '%m %m' "$@"; fi
if [ "$2" = '%Y %Z' ]; then shift 2; exec '${stat}' -c '%Y %Y' "$@"; fi
exec '${stat}' "$@"
`, { mode: 0o755 });
  writeFileSync(join(fx.root, "bin/ps"), '#!/bin/bash\n[ "${FAIL_PS:-0}" != 1 ] || exit 2\nprintf "1 %s\\n" "${LIVE_PATH:-/bin/sh}"\n', { mode: 0o755 });
  writeFileSync(join(fx.root, "bin/lsof"), `#!/bin/bash
[ "\${FAIL_LSOF:-0}" != 1 ] || exit 2
case " $* " in
  *" +D "*) target="\${@: -1}"; rc=1
    while IFS= read -r p; do case "$p" in "$target"|"$target"/*) printf 'p1\\nn%s\\n' "$p"; rc=0 ;; esac; done < '${fx.lsofList}'
    exit "$rc" ;;
esac
while IFS= read -r p; do [ -n "$p" ] && printf 'p1\\nn%s\\n' "$p"; done < '${fx.lsofList}'
exit 0
`, { mode: 0o755 });
}
function roots(fx: Fixture) {
  return [join(fx.home, "Remudero"), join(fx.home, "Remudero/lanes-wt"),
    join(fx.home, "Remudero/remudero"), join(fx.home, "rmd-work"), fx.scratch];
}
function setup() {
  const fx = fixture();
  fx.root = realpathSync(fx.root); fx.home = realpathSync(fx.home);
  fx.scratch = realpathSync(fx.scratch); fx.lsofList = realpathSync(fx.lsofList);
  probes(fx);
  for (const path of roots(fx)) mkdirSync(path, { recursive: true });
  return fx;
}
function data(root: string, name: string, hours = 7) {
  const path = join(root, name); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "payload.bin"), "disposable scratch\n"); age(path, hours); return path;
}
function sweep(fx: Fixture, apply = true, extra: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, apply ? "--apply" : "--dry-run"], { encoding: "utf8", timeout: 60_000, env: {
    ...process.env, PATH: `${join(fx.root, "bin")}:${process.env.PATH}`, TMPDIR: fx.scratch,
    REMUDERO_JANITOR_ACCOUNT_HOME: fx.home, REMUDERO_JANITOR_SCAN_ROOTS: fx.scratch,
    REMUDERO_JANITOR_LOG: join(fx.root, "janitor.log"), REMUDERO_JANITOR_LOCK_DIR: join(fx.root, "janitor.lock"),
    REMUDERO_JANITOR_DIRECTORY_ROOTS: roots(fx).join(":"), ...extra,
  } });
}

test("six-hour directory purge reaches every account root and preserves each scan container", () => {
  const fx = setup();
  try {
    const old = roots(fx).map(root => data(root, "unprefixed-old-data"));
    const young = roots(fx).map(root => data(root, "unprefixed-five-hour-data", 5));
    const nestedRecent = data(roots(fx)[3]!, "old-root-recent-child"); age(join(nestedRecent, "payload.bin"), 1);
    const r = sweep(fx); assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const path of old) assert.equal(existsSync(path), false, r.stdout);
    for (const path of [...roots(fx), ...young, nestedRecent]) assert.equal(existsSync(path), true, path + r.stdout);
    assert.equal((r.stdout.match(/REMOVED-SCRATCH/g) ?? []).length, old.length);
    assert.match(r.stdout, /all-content age>=6h/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("the default account policy includes Remudero, lanes-wt, the canonical checkout and rmd-work", () => {
  const fx = setup();
  try {
    const old = roots(fx).slice(0, 4).map(root => data(root, "default-scope-data"));
    const r = sweep(fx, true, { REMUDERO_JANITOR_DIRECTORY_ROOTS: "" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const path of old) assert.equal(existsSync(path), false, r.stdout);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("unversioned source, reports, history, credentials and dependency seeds survive regardless of age", () => {
  const fx = setup();
  try {
    const base = roots(fx)[3]!;
    const names = ["fix.py", "report.md", "summary.txt", "report.json", ".rmd-janitor-keep", "package.json", "ledger.ndjson", "backup.bundle", "source.tar", "source.zip", "credentials.pem", ".rmd-dependency-seed-root.json"];
    const held = names.map((file, i) => { const p = data(base, `held-${i}`); writeFileSync(join(p, file), "retain\n"); age(p, 8); return p; });
    const idle = data(base, "idle-sibling"); const r = sweep(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(idle), false, r.stdout);
    for (const path of held) assert.equal(existsSync(path), true, path + r.stdout);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("tracked and unignored source children survive while ignored data-only scratch can retire", () => {
  const fx = setup();
  try {
    const { main } = repos(fx); const operator = roots(fx)[2]!;
    rmSync(operator, { recursive: true }); git(fx.root, "clone", join(fx.root, "origin.git"), operator);
    const tracked = data(operator, "tracked-data");
    writeFileSync(join(operator, ".gitignore"), "ignored-data/\n");
    git(operator, "add", ".gitignore", "tracked-data"); git(operator, "commit", "-m", "source");
    git(operator, "push", "origin", "HEAD:source");
    const untracked = data(operator, "untracked-data"); const ignored = data(operator, "ignored-data");
    age(tracked, 8); const r = sweep(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(tracked), true, r.stdout); assert.equal(existsSync(untracked), true, r.stdout);
    assert.equal(existsSync(ignored), false, r.stdout); assert.equal(existsSync(main), true);
    assert.match(r.stdout, /tracked source directory/); assert.match(r.stdout, /untracked source directory is not ignored/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("an unpublished checkout cannot enter generic directory deletion", () => {
  const fx = setup();
  try {
    const { main } = repos(fx); const path = join(roots(fx)[1]!, "private-checkout");
    git(main, "worktree", "add", "-b", "unpublished", path);
    git(path, "commit", "--allow-empty", "-m", "unpublished work"); age(path, 8);
    const r = sweep(fx); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(path), true, r.stdout);
    assert.match(r.stdout, /Git workspace uses publication-aware retirement/);
    assert.match(r.stdout, /not-proven-published/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("live paths, unreadable process probes and external symlinks remain in place", () => {
  for (const kind of ["argv", "cwd", "ps-unavailable", "lsof-unavailable", "symlink"] as const) {
    const fx = setup();
    try {
      const path = data(roots(fx)[3]!, "held-data"); const env: Record<string, string> = {};
      if (kind === "argv") env.LIVE_PATH = path;
      if (kind === "cwd") writeFileSync(fx.lsofList, path + "\n");
      if (kind === "ps-unavailable") env.FAIL_PS = "1";
      if (kind === "lsof-unavailable") env.FAIL_LSOF = "1";
      if (kind === "symlink") {
        const before = statSync(path); symlinkSync(fx.root, join(path, "outside"));
        utimesSync(path, before.atime, before.mtime); // Never recurse through the deliberate cycle.
      }
      const r = sweep(fx, true, env); assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(existsSync(path), true, `${kind}: ${r.stdout}`);
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("a mounted descendant or unreadable mount inventory keeps the directory", () => {
  for (const fail of [false, true]) {
    const fx = setup();
    try {
      const path = data(roots(fx)[3]!, "mounted-data");
      writeFileSync(join(fx.root, "bin/mount"), fail ? "#!/bin/bash\nexit 2\n"
        : `#!/bin/bash\nprintf '%s\\n' 'fixture-device on ${path}/mounted (test filesystem)'\n`, { mode: 0o755 });
      const r = sweep(fx); assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(existsSync(path), true, r.stdout);
      assert.match(r.stdout, fail ? /mount visibility unavailable/ : /directory contains a mount/);
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("real lsof preserves a held file while an equally old idle sibling is removed", () => {
  const fx = setup(); let fd: number | undefined;
  try {
    rmSync(join(fx.root, "bin/lsof")); rmSync(join(fx.root, "bin/ps"));
    const held = data(roots(fx)[3]!, "held-with-real-fd"); const idle = data(roots(fx)[3]!, "idle-with-real-probes");
    fd = openSync(join(held, "payload.bin"), "r"); const r = sweep(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(held), true, r.stdout); assert.equal(existsSync(idle), false, r.stdout);
    assert.match(r.stdout, /open files or visibility unknown/);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(fx.root, { recursive: true, force: true }); }
});

test("fresh real ctime keeps old-mtime data, and dry-run never removes candidates", () => {
  const fx = setup();
  try {
    const path = data(roots(fx)[3]!, "fresh-metadata-old-mtime");
    const dry = sweep(fx, false); assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.equal(existsSync(path), true); assert.match(dry.stdout, /WOULD-REMOVE-SCRATCH/);
    rmSync(join(fx.root, "bin/stat"));
    const real = sweep(fx); assert.equal(real.status, 0, real.stderr + real.stdout);
    assert.equal(existsSync(path), true, real.stdout); assert.match(real.stdout, /content or metadata touched within 6h/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});


test("a foreign-owned directory is refused before any deletion", () => {
  const fx = setup();
  try {
    const path = data(roots(fx)[3]!, "foreign-owner-data");
    const stat = join(fx.root, "bin/stat");
    const body = readFileSync(stat, "utf8");
    writeFileSync(stat, body.replace("#!/bin/bash\n", `#!/bin/bash
case "$*" in *"%Su ${path}"|*"%U ${path}") echo another-account; exit 0 ;; esac
`), { mode: 0o755 });
    const r = sweep(fx); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(path), true, r.stdout); assert.match(r.stdout, /foreign or unknown owner/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a nested file touched between initial qualification and removal keeps the entire directory", () => {
  const fx = setup();
  try {
    const path = data(roots(fx)[3]!, "changed-before-remove");
    const counter = join(fx.root, "ps-counter");
    writeFileSync(join(fx.root, "bin/ps"), `#!/bin/bash
n=0; [ ! -f '${counter}' ] || read -r n < '${counter}'
n=$((n+1)); printf '%s\\n' "$n" > '${counter}'
[ "$n" -ne 3 ] || touch '${path}/new-content.bin'
exit 0
`, { mode: 0o755 });
    const r = sweep(fx); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(join(path, "new-content.bin")), true, r.stdout);
    assert.equal(existsSync(path), true, r.stdout);
    assert.match(r.stdout, /content or metadata touched within 6h/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});


test("parent aliases resolve once while a symlink scan root stays excluded", () => {
  const fx = setup();
  try {
    const parent = join(fx.root, "home-alias"); symlinkSync(fx.home, parent);
    const root = join(parent, "rmd-work"); const old = data(roots(fx)[3]!, "alias-idle-data");
    const excluded = join(fx.root, "excluded"); mkdirSync(excluded);
    const keep = data(excluded, "symlink-root-data");
    const link = join(fx.root, "root-link"); symlinkSync(excluded, link);
    const r = sweep(fx, true, { REMUDERO_JANITOR_DIRECTORY_ROOTS: [root, roots(fx)[3]!, link].join(":") });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(old), false, r.stdout); assert.equal(existsSync(keep), true, r.stdout);
    assert.equal((r.stdout.match(/REMOVED-SCRATCH/g) ?? []).length, 1, r.stdout);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});


test("explicit temp roots also confine the legacy Darwin coverage cache lane", { skip: process.platform !== "darwin" }, () => {
  const fx = setup();
  const outside = mkdtempSync("/private/tmp/rmd9-janitor-isolation-");
  function legacy(root: string) {
    mkdirSync(join(root, "r/.git"), { recursive: true });
    writeFileSync(join(root, "r/package.json"), '{"name":"remudero"}');
    const cache = join(root, "cov/r/tmp/node-coverage-fixture"); mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "coverage-1-2-3.json"), "{}"); age(root, 7); return cache;
  }
  try {
    const kept = legacy(outside); const inside = join(fx.scratch, "rmd9-inside");
    const removed = legacy(inside);
    const r = sweep(fx); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(kept), true, r.stdout);
    assert.equal(existsSync(removed), false, r.stdout);
    assert.equal(r.stdout.includes(outside), false, "no decision may inspect the excluded fixture root");
  } finally { rmSync(outside, { recursive: true, force: true }); rmSync(fx.root, { recursive: true, force: true }); }
});
