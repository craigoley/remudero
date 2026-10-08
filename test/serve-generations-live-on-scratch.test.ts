/**
 * W1-T6401 — SERVE GENERATIONS LIVE ON SCRATCH.
 *
 * deploy/serve-container.sh bound serve's generation tree from ~/rmd-serve-gens on the host root disk,
 * and serve runs its node and tsx loader from there: a 2026-10-08 block trace showed it as that
 * IOPS-throttled disk's heaviest reader. With the scratch plan on and no override, the generations now
 * sit under the same per-instance scratch base as the other rebuildable binds. These drive the REAL
 * script in --dry-run over a throwaway scratch root the mounts table declares mounted; only `docker`
 * is a stub, and a dry run creates nothing.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const GENS_DEST = "/home/node/rmd-serve-gens";

interface Host {
  root: string;
  scratch: string;
  state: string;
  env: Record<string, string>;
}

/** A throwaway host: a state dir, a scratch root the mounts table declares mounted, the switch file. */
function host(t: { after: (fn: () => void) => void }): Host {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-gens-host-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, "mnt", "scratch");
  const state = join(root, "rmd-state2");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(join(state, "state"), { recursive: true });
  writeFileSync(join(root, "mounts"), `/dev/nvme1n1 ${scratch} ext4 rw,noatime 0 0\n`);
  writeFileSync(join(root, "scratch-mounts.on"), "");
  return {
    root, scratch, state,
    env: { RMD_SCRATCH_ROOT: scratch, RMD_SCRATCH_MOUNTS_FILE: join(root, "mounts"), RMD_SCRATCH_SWITCH: join(root, "scratch-mounts.on") },
  };
}

function dryRunServe(h: Host, env: Record<string, string> = {}): { status: number | null; out: string } {
  const bin = join(h.root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(h.root, "code"), { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\nif [ "\${1:-}" = network ] && [ "\${2:-}" = inspect ]; then exit 0; fi\nexit 1\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.RMD_SERVE_GENS_DIR;
  delete base.RMD_SERVE_SUPERVISOR;
  delete base.RMD_SCRATCH;
  const r = spawnSync("bash", [join(REPO_ROOT, "deploy", "serve-container.sh"), "--dry-run"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...base, ...h.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: h.root,
      GH_TOKEN: "test-token",
      RMD_STATE_DIR: h.state,
      RMD_SERVE_REPO_DIR: join(h.root, "code"),
      RMD_SERVE_DOCKER_NETWORK: "rmd-test-net",
      RMD_SERVE_DOCKERENV_PATH: join(h.root, "no-dockerenv"),
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The host side of the generations bind in the planned `docker run`, or undefined when there is none. */
function gensSource(out: string): string | undefined {
  return new RegExp(`-v ([^ ]+):${GENS_DEST} -e RMD_SERVE_GENS_DIR=${GENS_DEST}`).exec(out)?.[1];
}

test("W1-T6401: serve generations default to scratch when scratch is on", (t) => {
  const h = host(t);
  const on = dryRunServe(h);
  assert.equal(on.status, 0, on.out);
  assert.match(on.out, /scratch mounts on/, "the fixture really switched scratch on");
  const scratchBase = join(h.scratch, "rmd", "rmd-state2");
  assert.equal(gensSource(on.out), `${scratchBase}/serve-gens`, on.out);
  assert.match(on.out, new RegExp(`-v ${scratchBase}/containers/remudero-serve/tmp:/tmp`), "the same per-instance base as the other scratch binds");
  assert.doesNotMatch(on.out, new RegExp(`${h.root}/rmd-serve-gens`), "nothing of serve's generations stays on the root disk");
  assert.equal(existsSync(join(h.scratch, "rmd")), false, "a dry run creates no directory");
});

test("W1-T6401: scratch off or an override keeps the old generations dir", (t) => {
  const h = host(t);
  const home = `${h.root}/rmd-serve-gens`;

  const off = dryRunServe(h, { RMD_SCRATCH: "off" });
  assert.equal(off.status, 0, off.out);
  assert.match(off.out, /scratch mounts off/);
  assert.equal(gensSource(off.out), home, off.out);

  const unmounted = dryRunServe(h, { RMD_SCRATCH_MOUNTS_FILE: join(h.root, "absent") });
  assert.equal(unmounted.status, 0, unmounted.out);
  assert.match(unmounted.out, /is not a mounted filesystem/);
  assert.equal(gensSource(unmounted.out), home, "an unusable scratch root keeps the generations where they were");

  const override = join(h.root, "operator-gens");
  const pinned = dryRunServe(h, { RMD_SERVE_GENS_DIR: override });
  assert.equal(pinned.status, 0, pinned.out);
  assert.match(pinned.out, /scratch mounts on/, "the override wins even with scratch on");
  assert.equal(gensSource(pinned.out), override, pinned.out);
  assert.doesNotMatch(pinned.out, /\/serve-gens:/);

  const direct = dryRunServe(h, { RMD_SERVE_SUPERVISOR: "off" });
  assert.equal(direct.status, 0, direct.out);
  assert.equal(gensSource(direct.out), undefined, "no supervisor, no generations bind at all");
});
