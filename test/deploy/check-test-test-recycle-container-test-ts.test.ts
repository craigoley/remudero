import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { makeTempDir } from "#src/lib/tmp.js";

// Replays the recorded round (PR #15638: the recycler's `session.json.observations` was never written
// because a cold observer start outlived the 5 s backstop on a CPU-saturated host) through the real
// deploy/registry-shadow.sh, with an observer whose observation step takes 6 s.
function replay(deadline: string | undefined) {
  const root = makeTempDir("recycle-observer-cold-start");
  try {
    mkdirSync(join(root, "deploy")), mkdirSync(join(root, "bin"));
    copyFileSync(join(REPO_ROOT, "deploy/registry-shadow.sh"), join(root, "deploy/registry-shadow.sh"));
    const session = join(root, "session.json");
    writeFileSync(join(root, "bin/node"), `#!/usr/bin/env bash
case " $* " in *" --capture "*) printf 'pin\\n'; exit 0 ;; esac
sleep 6
printf '{"action":"recycle"}\\n' >> "${session}.observations"
`);
    chmodSync(join(root, "bin/node"), 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` };
    if (deadline === undefined) delete env.RMD_REGISTRY_SHADOW_DEADLINE_S; else env.RMD_REGISTRY_SHADOW_DEADLINE_S = deadline;
    const run = spawnSync("bash", ["-c", `. "$1"; registry_shadow_start --selected-registry-shadow "$2"; registry_shadow_observe recycle i o/r host id`,
      "fixture", join(root, "deploy/registry-shadow.sh"), session], { env, encoding: "utf8", timeout: 60000 });
    const file = session + ".observations";
    return { status: run.status, stderr: run.stderr, recorded: existsSync(file) ? readFileSync(file, "utf8") : null };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("W1-T11299: check:test:test/recycle-container.test.ts is prevented, not retried", () => {
  const healthy = replay(undefined);
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.doesNotMatch(healthy.stderr, /shell_shadow_unrecorded/, "a slow cold start inside the default backstop is recorded");
  assert.match(healthy.recorded ?? "", /"action":"recycle"/, "the observation row exists, not ENOENT");
  const old = replay("5");
  assert.equal(old.recorded, null, "control: the superseded 5 s bound is what lost the row");
  assert.match(old.stderr, /shell_shadow_unrecorded/);
});
