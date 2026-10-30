import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { withTempDir } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function host(root: string) {
  const sentinel = join(root, "default-scratch");
  const scratch = join(root, "fixture-scratch");
  mkdirSync(sentinel);
  mkdirSync(scratch);
  const mounts = join(root, "mounts");
  writeFileSync(mounts, [sentinel, scratch].map((dir) => `/dev/fixture ${dir} ext4 rw 0 0\n`).join(""));
  const probe = (state: string, container: string, prepare: boolean | "restore" = true, env: NodeJS.ProcessEnv = {}) => {
    const run = spawnSync("bash", ["-uc", `
      . "$1"
      default_root="$2"
      scratch_root() { printf '%s' "\${RMD_SCRATCH_ROOT:-$default_root}"; }
      if scratch_plan "$3" "$4"; then planned=0; else planned=$?; fi
      printf 'PLAN %s\\n' "$planned"
      printf 'BIND %s\\n' "\${SCRATCH_ARGS[@]+"\${SCRATCH_ARGS[@]}"}"
      printf 'NOTE %s\\n' "$SCRATCH_NOTE"
      if [ "$5" = true ]; then
        if scratch_prepare; then echo PREPARED; else echo UNPREPARED; fi
      elif [ "$5" = restore ]; then
        scratch_restore "$3"
      fi
    `, "probe", join(REPO_ROOT, "deploy/scratch-mounts.sh"), sentinel, state, container, String(prepare)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, RMD_SCRATCH: "on", RMD_SCRATCH_MOUNTS_FILE: mounts, ...env },
    });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };
  return { sentinel, scratch, probe };
}

test("W1-T9756: a hand-built env never plans scratch under the real root", async () => {
  await withTempDir("scratch-fixture-census", async (root) => {
    const fx = host(root);
    // State names used by the serve, recycle, runtime-contract, reclaim and app-auth fixtures.
    const shapes = ["rmd-serve-policy-1", "recycle-state-1", "rmd-runtime-recycle-state-1",
      "rmd-reclaim-state-1", "rmd-recycle-bash3-capture-state-1", "rmd-appauth-state-1",
      "state", "state_dir", "state-root", "site-state", "target-state", "brand-new-host"];
    for (const name of shapes) {
      const state = join(root, name);
      mkdirSync(state);
      for (const container of ["remudero-serve", "remudero-daemon"]) {
        const out = fx.probe(state, container);
        assert.match(out, /^PLAN 1$/m, `${name}: ${out}`);
        assert.match(out, /^BIND $/m, out);
        assert.match(out, /^UNPREPARED$/m, out);
        assert.equal(existsSync(join(state, ".scratch-mounts")), false);
        assert.deepEqual(readdirSync(fx.sentinel), [], `${name} leaked into the default root`);
      }
    }
    // Positive control: the same planner and mounts table really can prepare scratch directories.
    const state = join(root, shapes[0]!);
    const own = fx.probe(state, "remudero-serve", true, { RMD_SCRATCH_ROOT: fx.scratch });
    assert.match(own, /^PLAN 0$/m, own);
    assert.match(own, /^PREPARED$/m, own);
    assert.ok(existsSync(join(fx.scratch, "rmd", basename(state), "worktrees")));
    assert.ok(existsSync(join(state, ".scratch-mounts")));
    assert.deepEqual(readdirSync(fx.sentinel), []);
  });
});

test("W1-T9756: a real state dir still plans under the scratch root", async () => {
  await withTempDir("scratch-production-control", async (root) => {
    const fx = host(root);
    for (const state of ["/mnt/rmd/rmd-state2", "/mnt/rmd/rmd-state2/", "/mnt/rmd/rmd-site-state", "/srv/remudero-console-state", "/tmp-data/state"]) {
      for (const container of ["remudero-serve", "remudero-daemon"]) {
        const out = fx.probe(state, container, false);
        assert.match(out, /^PLAN 0$/m, out);
        assert.ok(out.includes(`${fx.sentinel}/rmd/${basename(state)}/worktrees:/home/node/Remudero/worktrees`), out);
      }
    }
    assert.deepEqual(readdirSync(fx.sentinel), [], "planning alone changes nothing");
  });
});

test("temporary state is refused across os temp roots and rmd fixture ancestors", async () => {
  await withTempDir("scratch-temp-paths", async (root) => {
    const fx = host(root);
    for (const state of ["/tmp/state", "/var/tmp/state", "/private/tmp/state",
      "/var/folders/xx/T/state", "/private/var/folders/xx/T/state", "/srv/rmd-fixture-123/nested/state"]) {
      assert.match(fx.probe(state, "remudero-daemon", false), /^PLAN 1$/m, state);
    }
    for (const name of ["TMPDIR", "TMP", "TEMP"]) {
      assert.match(fx.probe("/srv/private-temp/state", "remudero-daemon", false, { [name]: "/srv/private-temp/" }), /^PLAN 1$/m);
    }
    assert.deepEqual(readdirSync(fx.sentinel), []);
  });
});

test("a hand-built env cannot restore a temporary state's manifest into the default scratch root", async () => {
  await withTempDir("scratch-fixture-restore", async (state) => {
    const fx = host(state);
    const target = join(fx.sentinel, "rmd", "fixture", "worktrees");
    writeFileSync(join(state, ".scratch-mounts"), `${target}\n`);
    const out = fx.probe(state, "remudero-daemon", "restore");
    assert.match(out, /temporary state dir.*nothing restored/);
    assert.deepEqual(readdirSync(fx.sentinel), []);
    const own = join(fx.scratch, "rmd", "fixture", "worktrees");
    writeFileSync(join(state, ".scratch-mounts"), `${own}\n`);
    assert.match(fx.probe(state, "remudero-daemon", "restore", { RMD_SCRATCH_ROOT: fx.scratch }), /restored/);
    assert.ok(existsSync(own));
  });
});
