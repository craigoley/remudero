import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { age, fixture, type Fixture } from "#test/helpers/host-cleanup-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const janitor = join(REPO_ROOT, "deploy/mac/remudero-janitor.sh");
const native = (name: string) => execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
function setup() {
  const fx = fixture();
  fx.root = realpathSync(fx.root); fx.home = realpathSync(fx.home); fx.scratch = realpathSync(fx.scratch);
  const bin = join(fx.root, "bin"), stat = native("stat");
  // Fixtures cannot backdate ctime; report the aged mtime in its place.
  writeFileSync(join(bin, "stat"), `#!/bin/bash
if [ "$2" = '%m %c' ]; then shift 2; exec '${stat}' -f '%m %m' "$@"; fi
if [ "$2" = '%Y %Z' ]; then shift 2; exec '${stat}' -c '%Y %Y' "$@"; fi
exec '${stat}' "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, "ps"), '#!/bin/bash\nprintf "1 %s\\n" "${LIVE_COMMAND:-/bin/sh}"\n', { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), `#!/bin/bash
case " $* " in *" -d cwd "*) exit 0 ;; esac
target="\${@: -1}"
while IFS= read -r p; do
  case "$p" in "$target"|"$target"/*) printf 'p1\\nn%s\\n' "$p"; exit 0 ;; esac
done < '${fx.lsofList}'
exit 1
`, { mode: 0o755 });
  return fx;
}
function file(path: string, body = "payload\n") { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); return path; }
function browser(dir: string, stamped = true) {
  file(join(dir, "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"));
  if (stamped) file(join(dir, "INSTALLATION_COMPLETE"), "");
  return dir;
}
function run(fx: Fixture, apply = true, extra: Record<string, string> = {}) {
  const r = spawnSync("bash", [janitor, apply ? "--apply" : "--dry-run"], { encoding: "utf8", timeout: 60_000, env: {
    ...process.env, HOME: fx.home, TMPDIR: fx.scratch, PATH: `${join(fx.root, "bin")}:${process.env.PATH}`,
    REMUDERO_JANITOR_ACCOUNT_HOME: fx.home, REMUDERO_JANITOR_SCAN_ROOTS: fx.scratch,
    REMUDERO_JANITOR_DIRECTORY_ROOTS: fx.scratch, REMUDERO_JANITOR_LOG: join(fx.root, "janitor.log"),
    REMUDERO_JANITOR_LOCK_DIR: join(fx.root, "janitor.lock"), ...extra,
  } });
  assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout;
}

test("an idle Playwright browser copy nested in an active Codex run is removed and its reports stay", () => {
  const fx = setup();
  try {
    const run1 = join(fx.home, ".codex/work-artifacts/console-next/local");
    const assets = join(run1, "playwright-platform-assets");
    const idle = [browser(join(assets, "chromium-1248")), browser(join(assets, "chromium_headless_shell-1248")),
      browser(join(assets, "ffmpeg-1013"))];
    const report = file(join(assets, "verification.json"), "{}\n");
    age(join(fx.home, ".codex"), 9);
    file(join(run1, "today/active.log"));
    const dry = run(fx, false);
    for (const dir of idle) assert.ok(existsSync(dir), dry);
    assert.match(dry, /WOULD-REMOVE \d+h \d+M .*chromium-1248/);
    const out = run(fx);
    for (const dir of idle) assert.equal(existsSync(dir), false, out);
    assert.ok(existsSync(report), out);
    assert.ok(existsSync(join(run1, "today/active.log")), out);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a private npm cache nested in a Codex run is removed once idle", () => {
  const fx = setup();
  try {
    const cache = join(fx.home, ".codex/work-artifacts/proof/npm-cache-private.X/_cacache");
    file(join(cache, "index-v5/aa/bb"));
    file(join(cache, "content-v2/sha512/cc"));
    const receipt = file(join(fx.home, ".codex/work-artifacts/proof/receipt.json"), "{}\n");
    age(join(fx.home, ".codex"), 9);
    const out = run(fx);
    assert.equal(existsSync(cache), false, out);
    assert.ok(existsSync(receipt), out);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a fresh, unstamped, open or symlinked download copy in a Codex run is kept", () => {
  const fx = setup();
  try {
    const base = join(fx.home, ".codex/work-artifacts/run");
    const fresh = browser(join(base, "fresh/chromium-1300"));
    const unstamped = browser(join(base, "partial/chromium-1249"), false);
    const open = browser(join(base, "running/chromium-1248"));
    const unknown = file(join(base, "other/_cacache/notes.md"));
    const target = browser(join(fx.root, "outside/chromium-1248"));
    mkdirSync(join(base, "linked"), { recursive: true });
    symlinkSync(target, join(base, "linked/chromium-1248"));
    age(join(fx.home, ".codex"), 9); age(target, 9);
    age(fresh, 1);
    writeFileSync(fx.lsofList, join(open, "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium") + "\n");
    const out = run(fx);
    for (const kept of [fresh, unstamped, open, unknown, target]) assert.ok(existsSync(kept), kept + "\n" + out);
    assert.match(out, /SKIP young \dh .*chromium-1300/);
    assert.match(out, /SKIP unrecognised-browser-install .*chromium-1249/);
    assert.match(out, /SKIP (open|unverified) .*running\/chromium-1248/);
    assert.match(out, /SKIP unrecognised-npm-cache .*other\/_cacache/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
