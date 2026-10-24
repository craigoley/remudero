import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixture, scratchDir, SCRIPT, type Fixture } from "#test/helpers/host-cleanup-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function defaultView(fx: Fixture, actor: "0" | "1000", extra: Record<string, string> = {}, custom = false) {
  const bin = join(fx.root, "open-view-bin");
  mkdirSync(bin);
  const sudoLog = join(fx.root, "sudo.log");
  const scripts: Record<string, string> = {
    id: '#!/bin/bash\nif [ "$1" = -u ]; then printf "%s\\n" "$FAKE_ACTOR_UID"; else exec /usr/bin/id "$@"; fi\n',
    sudo: '#!/bin/bash\nprintf "%s\\n" "$*" >> "$FAKE_SUDO_LOG"\nif [ "${FAKE_SUDO_FAIL:-0}" != 0 ]; then exit "$FAKE_SUDO_FAIL"; fi\n[ "$1" = -n ] && [ "$2" = -- ] && [ "$3" = /usr/bin/lsof ] || exit 64\nshift 3\nFAKE_ELEVATED=1 exec "$FAKE_VIEW_LSOF" "$@"\n',
    lsof: "#!/bin/bash\nif [ \"${FAKE_SCAN_MODE:-complete}\" = nonzero ]; then printf \"p2\\nn%s\\n\" \"$FAKE_HELD_PATH\"; exit 1; fi\nif [ \"${FAKE_SCAN_MODE:-complete}\" = partial ]; then printf \"p1\\nn/proc/1/cwd (readlink: Permission denied)\\np2\\nn%s\\n\" \"$FAKE_HELD_PATH\"; exit 0; fi\nif [ \"$FAKE_ACTOR_UID\" != 0 ] && [ \"${FAKE_ELEVATED:-0}\" != 1 ]; then printf \"p1\\nn/proc/1/cwd (readlink: Permission denied)\\np3\\nn%s\\n\" \"$FAKE_VISIBLE_PATH\"; exit 0; fi\nexec \"$FAKE_BASE_LSOF\" \"$@\"\n",
  };
  if (extra.FAKE_PS_FAIL === "1") scripts.ps = "#!/bin/bash\nexit 1\n";
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...fx.env, ...extra,
    PATH: bin + ":" + process.env.PATH,
    RMD_CLEANUP_UID: String(process.getuid!()),
    FAKE_ACTOR_UID: actor,
    FAKE_SUDO_LOG: sudoLog,
    FAKE_VIEW_LSOF: join(bin, "lsof"),
    FAKE_BASE_LSOF: fx.env.RMD_CLEANUP_LSOF,
    FAKE_VISIBLE_PATH: join(fx.root, "unrelated-open-path"),
  };
  if (!custom) delete env.RMD_CLEANUP_LSOF;
  const result = spawnSync("bash", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return { ...result, sudoLog };
}

function candidates() {
  const fx = fixture();
  const held = scratchDir(fx, "rmd-root-held", true);
  const free = scratchDir(fx, "rmd-free", true);
  writeFileSync(fx.lsofList, held + "\n");
  return { fx, held, free };
}

test("the non-root Azure janitor requests a privileged open-file view and keeps an idle root-held path", () => {
  const { fx, held, free } = candidates();
  const r = defaultView(fx, "1000", { FAKE_HELD_PATH: held });
  assert.equal(existsSync(held), true, r.stdout);
  assert.equal(existsSync(free), false, "positive control: the same-age unheld path is removed\n" + r.stdout);
  assert.match(readFileSync(r.sudoLog, "utf8"), /^-n -- \/usr\/bin\/lsof -Fn$/m);
});

test("the root Azure janitor reads its complete open-file view directly without sudo", () => {
  const { fx, held, free } = candidates();
  const r = defaultView(fx, "0", { FAKE_HELD_PATH: held });
  assert.equal(existsSync(held), true, r.stdout);
  assert.equal(existsSync(free), false, r.stdout);
  assert.equal(existsSync(r.sudoLog), false);
});

test("a failed noninteractive privilege probe keeps every idle janitor candidate", () => {
  for (const code of ["1", "127"]) {
    const { fx, held, free } = candidates();
    const r = defaultView(fx, "1000", { FAKE_HELD_PATH: held, FAKE_SUDO_FAIL: code });
    assert.equal(existsSync(held), true, r.stdout);
    assert.equal(existsSync(free), true, "unknown visibility keeps the otherwise removable control");
    assert.match(r.stdout, /REFUSE sweeps: lsof failed/);
  }
});

test("an exit-zero lsof scan with permission-denied process paths keeps every idle candidate", () => {
  const { fx, held, free } = candidates();
  const r = defaultView(fx, "0", { FAKE_HELD_PATH: held, FAKE_SCAN_MODE: "partial" });
  assert.equal(existsSync(held), true, r.stdout);
  assert.equal(existsSync(free), true, r.stdout);
  assert.match(r.stdout, /incomplete visibility/);
});

test("a nonzero lsof scan keeps every idle candidate even when some paths were printed", () => {
  const { fx, held, free } = candidates();
  const r = defaultView(fx, "0", { FAKE_HELD_PATH: held, FAKE_SCAN_MODE: "nonzero" });
  assert.equal(existsSync(held), true, r.stdout);
  assert.equal(existsSync(free), true, r.stdout);
  assert.match(r.stdout, /REFUSE sweeps: lsof failed/);
});

test("a custom complete open-file probe is used without escalating account-owned code", () => {
  const { fx, held, free } = candidates();
  const r = defaultView(fx, "1000", { FAKE_HELD_PATH: held }, true);
  assert.equal(existsSync(held), true, r.stdout);
  assert.equal(existsSync(free), false, r.stdout);
  assert.equal(existsSync(r.sudoLog), false);
});

test("a failed process snapshot keeps every idle candidate and reports that decision", () => {
  const { fx, held, free } = candidates();
  const r = defaultView(fx, "1000", { FAKE_HELD_PATH: held, FAKE_PS_FAIL: "1" });
  assert.equal(existsSync(held), true, r.stdout);
  assert.equal(existsSync(free), true, r.stdout);
  assert.match(r.stdout, /REFUSE sweeps: process snapshot failed/);
  assert.equal(existsSync(r.sudoLog), false);
});
