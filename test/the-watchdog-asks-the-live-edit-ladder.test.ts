/**
 * 2026-10-11: the watchdog's `deploy_code_clean` logged "local edits; deferring without discarding
 * them" on every tick for five hours, and that was all it did. These suites run the REAL rendered
 * refresh functions over real clones; `rmd live-edits` is a committed stub that records its argv and
 * answers as the ladder would, so what is under test is the launcher's contract with the ladder.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RMD_STUB_CALLS"
dir=""
while [ $# -gt 0 ]; do [ "$1" = --checkout ] && dir="$2"; shift; done
if [ "\${RMD_STUB_RESTORE:-0}" = 1 ]; then
  git -C "$dir" checkout -- . && echo '{"tier":3,"restored":true}'
else
  echo '{"tier":1,"restored":false}'
fi
`;

function renderedRefresh(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ladder-render-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launcher = join(root, "launcher");
  const render = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], {
    encoding: "utf8",
    env: { ...process.env, RMD_STATE_DIR: join(root, "state-root"), RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: join(root, "bin"), RMD_LAUNCHER_PATH: launcher, RMD_REVIVAL_LOG: join(root, "revivals"), RMD_NODE_MAX_OLD_SPACE_MB: "8192" },
  });
  assert.equal(render.status, 0, render.stderr);
  const text = readFileSync(launcher, "utf8");
  return ["deploy_code_idle", "deploy_code_clean", "live_edits_ladder", "refresh_deploy_code"].map((name) => {
    const body = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, "m").exec(text);
    assert.ok(body, `the rendered launcher defines ${name}`);
    return body[0];
  }).join("\n");
}

interface Host { state: string; daemon: GitRepo; main: string; calls: string; tick: (env?: Record<string, string>) => { status: number | null; stdout: string; stderr: string } }

/** A daemon tree one commit behind origin, an install tree at origin/main, an idle container. */
function host(t: TestContext): Host {
  const fns = renderedRefresh(t);
  const origin = gitRepo({ bare: true, kind: "ladder-shell-origin" });
  const seed = gitRepo({ kind: "ladder-shell-seed" });
  mkdirSync(join(seed.dir, "bin"));
  writeFileSync(join(seed.dir, "bin", "rmd"), STUB);
  chmodSync(join(seed.dir, "bin", "rmd"), 0o755);
  writeFileSync(join(seed.dir, "app.txt"), "v1\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "seed");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const daemon = gitRepo({ cloneFrom: origin.dir, kind: "ladder-shell-daemon" });
  writeFileSync(join(seed.dir, "next.txt"), "main moves on\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "main moves on");
  seed.git("push", "--quiet", "origin", "main");
  const install = gitRepo({ cloneFrom: origin.dir, kind: "ladder-shell-install" });
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ladder-shell-state-`));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  symlinkSync(daemon.dir, join(state, "remudero"), "dir");
  mkdirSync(join(state, "state"));
  const bin = join(state, "path-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), "#!/usr/bin/env bash\nprintf 'PID ARGS\\n1 node rmd daemon\\n'\n");
  chmodSync(join(bin, "docker"), 0o755);
  const calls = join(state, "ladder-calls");
  const tick = (env: Record<string, string> = {}) => {
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${fns}\nrefresh_deploy_code remudero-daemon`], {
      encoding: "utf8",
      env: { ...process.env, ...env, STATE_DIR: state, CHECKOUT: install.dir, RMD_STUB_CALLS: calls, PATH: `${bin}:${process.env.PATH}` },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { state, daemon, main: seed.git("rev-parse", "HEAD"), calls, tick };
}

test("the watchdog's deploy-code refresh asks the live-edit ladder once per tick and still defers on tier 1", (t) => {
  const h = host(t);
  const before = h.daemon.git("rev-parse", "HEAD");
  writeFileSync(join(h.daemon.dir, "app.txt"), "hand edit\n");
  const r = h.tick();
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /local edits; deferring without discarding them/);
  assert.match(r.stdout, /live edits -- daemon-checkout: \{"tier":1,"restored":false\}/);
  const calls = readFileSync(h.calls, "utf8").trim().split("\n");
  assert.deepEqual(calls, [`live-edits --tree daemon-checkout --checkout ${h.state}/remudero --state-root ${h.state}/state --json`]);
  assert.equal(readFileSync(join(h.daemon.dir, "app.txt"), "utf8"), "hand edit\n", "the edit is never discarded by the launcher");
  assert.equal(h.daemon.git("rev-parse", "HEAD"), before);
});

test("when the live-edit ladder restores the daemon tree, the same watchdog refresh fast-forwards it", (t) => {
  const h = host(t);
  writeFileSync(join(h.daemon.dir, "app.txt"), "hand edit\n");
  const r = h.tick({ RMD_STUB_RESTORE: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /live edits restored from a confirmed copy; proceeding/);
  assert.equal(h.daemon.git("rev-parse", "HEAD"), h.main, "the tree fast-forwarded to origin/main");
});

test("an untracked-only change never asks the live-edit ladder, and still defers", (t) => {
  const h = host(t);
  writeFileSync(join(h.daemon.dir, "stray.txt"), "untracked\n");
  const r = h.tick();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /local edits; deferring without discarding them/);
  assert.equal(existsSync(h.calls), false, "no tracked edit, no ladder");
});
