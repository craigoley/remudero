/**
 * W1-T5549 — THE BEAT PUBLISHES THE SCRATCH FILESYSTEM'S FREE SPACE.
 *
 * W1-T2767 folded `/` and the state disk (`RMD_ROOT`) into `disk_min_free_kb`, but not /mnt/scratch:
 * a third device holding every fleet worktree, gate workspace, the read-model, tmp and the 24 GB
 * swapfile, which sat at 87-89% on 2026-10-03 while the beat read green. These guards drive the REAL
 * committed `scripts/fleet-heartbeat.sh` through the shared harness with a stubbed `df` and assert on
 * the PUBLISHED payload (the bytes piped to `git hash-object`), never the dry-run print.
 *
 * Every test names `RMD_SCRATCH_ROOT` explicitly, so no expectation depends on whether the host
 * running the suite has a /mnt/scratch of its own.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runBeat } from "./helpers/fleet-heartbeat-harness.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/** `key=value` lookup over a published payload. */
function field(payload: string, key: string): string | undefined {
  const line = payload.split("\n").find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

const ROOT_DEV = "/dev/root";
const STATE_DEV = "/dev/nvme0n2p1";
const SCRATCH_DEV = "/dev/nvme1n1";

/** A `df -Pk` row in the real column order: device / 1k-blocks / used / available / capacity / mount. */
const row = (dev: string, kb: string, mount: string): string =>
  `printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n${dev} 400000000 1000 %s 50%% ${mount}\\n" ${JSON.stringify(kb)}`;

interface Fs {
  /** Free KB `df` reports for the path, or `fail` for a non-zero exit with no output. */
  kb: string;
  dev: string;
}

/**
 * A `df` stub over THREE paths: `/`, the scratch root, and everything else (the harness's
 * `RMD_ROOT`). `scratch.dev` may name another path's device, which is how a shared filesystem is
 * driven.
 */
function dfStub(scratchPath: string, root: Fs, state: Fs, scratch: Fs): string {
  const arm = (fs: Fs, mount: string): string => (fs.kb === "fail" ? "  exit 1" : `  ${row(fs.dev, fs.kb, mount)}`);
  return [
    "#!/usr/bin/env bash",
    'target="${@: -1}"',
    'if [ "$target" = "/" ]; then',
    arm(root, "/"),
    `elif [ "$target" = ${JSON.stringify(scratchPath)} ]; then`,
    arm(scratch, "/mnt/scratch"),
    "else",
    arm(state, "/mnt/rmd"),
    "fi",
    "",
  ].join("\n");
}

/** Run one beat with a real (empty) scratch directory, removed afterwards. */
function withScratch<T>(fn: (scratch: string) => T): T {
  const scratch = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}beat-scratch-`));
  try {
    return fn(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("W1-T5549: the scratch device is published in its own labelled row and, when fullest, IS disk_min_free_kb", () => {
  withScratch((scratch) => {
    // The 2026-10-03 shape: root and state roomy, scratch nearly full.
    const beat = runBeat({
      env: { RMD_SCRATCH_ROOT: scratch },
      dfStub: dfStub(scratch, { kb: "20000000", dev: ROOT_DEV }, { kb: "10000000", dev: STATE_DEV }, { kb: "300000", dev: SCRATCH_DEV }),
    });
    assert.equal(beat.status, 0, beat.stderr);
    assert.equal(field(beat.published, "scratch_fs_free_kb"), "300000");
    assert.equal(field(beat.published, "scratch_fs_device"), SCRATCH_DEV);
    assert.equal(field(beat.published, "state_fs_free_kb"), "10000000");
    assert.equal(field(beat.published, "root_fs_free_kb"), "20000000");
    assert.equal(
      field(beat.published, "disk_min_free_kb"),
      "300000",
      "the alarm number must be the fullest device — the state disk's 10000000 is the blind-spot reading",
    );
  });
});

test("W1-T5549: a roomy scratch device does not lower a smaller minimum elsewhere", () => {
  withScratch((scratch) => {
    const beat = runBeat({
      env: { RMD_SCRATCH_ROOT: scratch },
      dfStub: dfStub(scratch, { kb: "500000", dev: ROOT_DEV }, { kb: "10000000", dev: STATE_DEV }, { kb: "90000000", dev: SCRATCH_DEV }),
    });
    assert.equal(field(beat.published, "scratch_fs_free_kb"), "90000000");
    assert.equal(field(beat.published, "disk_min_free_kb"), "500000");
  });
});

test("W1-T5549: a scratch path on an already-counted device is published but folded ONCE — the device's own reading stands", () => {
  withScratch((scratch) => {
    // Scratch shares the STATE device. Its reading is deliberately different so a second fold would
    // be visible: a min that counted the shared device twice would publish 100.
    const shared = runBeat({
      env: { RMD_SCRATCH_ROOT: scratch },
      dfStub: dfStub(scratch, { kb: "20000000", dev: ROOT_DEV }, { kb: "10000000", dev: STATE_DEV }, { kb: "100", dev: STATE_DEV }),
    });
    assert.equal(field(shared.published, "scratch_fs_device"), STATE_DEV);
    assert.equal(field(shared.published, "scratch_fs_free_kb"), "100", "the reading is still published");
    assert.equal(field(shared.published, "disk_min_free_kb"), "10000000", "but the state device is counted once");

    // And the same for a scratch path that lives on `/`.
    const onRoot = runBeat({
      env: { RMD_SCRATCH_ROOT: scratch },
      dfStub: dfStub(scratch, { kb: "20000000", dev: ROOT_DEV }, { kb: "10000000", dev: STATE_DEV }, { kb: "100", dev: ROOT_DEV }),
    });
    assert.equal(field(onRoot.published, "scratch_fs_device"), ROOT_DEV);
    assert.equal(field(onRoot.published, "disk_min_free_kb"), "10000000");
  });
});

test("W1-T5549: an UNREADABLE scratch filesystem reads unknown and leaves a readable minimum unchanged", () => {
  withScratch((scratch) => {
    const beat = runBeat({
      env: { RMD_SCRATCH_ROOT: scratch },
      dfStub: dfStub(scratch, { kb: "20000000", dev: ROOT_DEV }, { kb: "10000000", dev: STATE_DEV }, { kb: "fail", dev: SCRATCH_DEV }),
    });
    assert.equal(beat.status, 0, beat.stderr);
    assert.equal(field(beat.published, "scratch_fs_free_kb"), "unknown", "unreadable is never reported as full or free");
    assert.equal(field(beat.published, "scratch_fs_device"), "unknown");
    assert.equal(field(beat.published, "disk_min_free_kb"), "10000000", "never dragged to unknown, never to 0");
  });
});

test("W1-T5549: a JUNK scratch reading is a failed read — unknown, and not folded", () => {
  withScratch((scratch) => {
    const beat = runBeat({
      env: { RMD_SCRATCH_ROOT: scratch },
      dfStub: dfStub(scratch, { kb: "20000000", dev: ROOT_DEV }, { kb: "10000000", dev: STATE_DEV }, { kb: "-", dev: SCRATCH_DEV }),
    });
    assert.equal(field(beat.published, "scratch_fs_free_kb"), "unknown");
    assert.equal(field(beat.published, "scratch_fs_device"), SCRATCH_DEV);
    assert.equal(field(beat.published, "disk_min_free_kb"), "10000000");
  });
});

test("W1-T5549: a host with NO scratch root publishes `absent` — a known state, distinct from an unreadable one", () => {
  const missing = join(tmpdir(), `${RMD_TMP_PREFIX}beat-scratch-never-created-${process.pid}`);
  const beat = runBeat({
    env: { RMD_SCRATCH_ROOT: missing },
    dfStub: dfStub(missing, { kb: "20000000", dev: ROOT_DEV }, { kb: "10000000", dev: STATE_DEV }, { kb: "100", dev: SCRATCH_DEV }),
  });
  assert.equal(beat.status, 0, beat.stderr);
  assert.equal(field(beat.published, "scratch_fs_free_kb"), "absent");
  assert.equal(field(beat.published, "scratch_fs_device"), "absent");
  assert.equal(field(beat.published, "disk_min_free_kb"), "10000000", "an absent path is never measured or folded");
});

test("W1-T5549: when scratch is the ONLY readable device, it alone is the minimum", () => {
  withScratch((scratch) => {
    const beat = runBeat({
      env: { RMD_SCRATCH_ROOT: scratch },
      dfStub: dfStub(scratch, { kb: "fail", dev: ROOT_DEV }, { kb: "fail", dev: STATE_DEV }, { kb: "300000", dev: SCRATCH_DEV }),
    });
    assert.equal(field(beat.published, "root_fs_free_kb"), "unknown");
    assert.equal(field(beat.published, "disk_free_kb"), "unknown");
    assert.equal(field(beat.published, "disk_min_free_kb"), "300000");
  });
});

test("W1-T5549: a numeric reading behind an UNKNOWN device is still folded — an unknown device matches nothing", () => {
  withScratch((scratch) => {
    // `df_field` reads free KB first and the device second. This stub answers the first scratch
    // query and fails the second, so the reading is numeric while the device is unknown. The two
    // other devices are ALSO unknown — a dedupe that compared `unknown` to `unknown` would skip it.
    const marker = join(scratch, ".answered");
    const stub = [
      "#!/usr/bin/env bash",
      'target="${@: -1}"',
      `[ "$target" = ${JSON.stringify(scratch)} ] || exit 1`,
      `[ -e ${JSON.stringify(marker)} ] && exit 1`,
      `: > ${JSON.stringify(marker)}`,
      row(SCRATCH_DEV, "300000", "/mnt/scratch"),
      "",
    ].join("\n");
    const beat = runBeat({ env: { RMD_SCRATCH_ROOT: scratch }, dfStub: stub });
    assert.equal(field(beat.published, "scratch_fs_device"), "unknown");
    assert.equal(field(beat.published, "root_fs_device"), "unknown");
    assert.equal(field(beat.published, "scratch_fs_free_kb"), "300000");
    assert.equal(field(beat.published, "disk_min_free_kb"), "300000");
  });
});

test("W1-T5549: the REAL df leaf measures a real scratch path and names its device", () => {
  withScratch((scratch) => {
    // NO dfStub — the default implementation executes. The scratch dir and the harness's RMD_ROOT
    // both sit under tmpdir(), so the real answer is one shared device: published, deduped.
    const beat = runBeat({ env: { RMD_SCRATCH_ROOT: scratch } });
    assert.equal(beat.status, 0, beat.stderr);
    const kb = field(beat.published, "scratch_fs_free_kb");
    assert.match(String(kb), /^[0-9]+$/, `real df must yield a numeric block count, got ${kb}`);
    assert.ok(Number(kb) > 0);
    const dev = field(beat.published, "scratch_fs_device");
    assert.ok(dev !== undefined && dev !== "unknown" && dev !== "absent", `real df must name a device, got ${dev}`);
    assert.equal(dev, field(beat.published, "state_fs_device"), "two paths under one tmpdir are one device");
    assert.ok(Number(field(beat.published, "disk_min_free_kb")) <= Number(field(beat.published, "root_fs_free_kb")));
  });
});

test("W1-T5549 falsifier: leaving the scratch reading out of the minimum reports the larger state-disk number", () => {
  withScratch((scratch) => {
    const beat = runBeat({
      env: { RMD_SCRATCH_ROOT: scratch },
      dfStub: dfStub(scratch, { kb: "20000000", dev: ROOT_DEV }, { kb: "10000000", dev: STATE_DEV }, { kb: "300000", dev: SCRATCH_DEV }),
      mutate: ['if [ "$SCRATCH_FS_SHARED" = "no" ]; then', "if false; then"],
    });
    assert.equal(field(beat.published, "scratch_fs_free_kb"), "300000", "the row is still published");
    assert.equal(field(beat.published, "disk_min_free_kb"), "10000000", "the mutant reports the roomier state disk");
  });
});

test("W1-T5549 mutant: dropping the device dedupe folds a shared device twice and is caught", () => {
  withScratch((scratch) => {
    const beat = runBeat({
      env: { RMD_SCRATCH_ROOT: scratch },
      dfStub: dfStub(scratch, { kb: "20000000", dev: ROOT_DEV }, { kb: "10000000", dev: STATE_DEV }, { kb: "100", dev: STATE_DEV }),
      mutate: ['  SCRATCH_FS_SHARED="yes"\n', '  SCRATCH_FS_SHARED="no"\n'],
    });
    assert.equal(field(beat.published, "disk_min_free_kb"), "100", "without the dedupe the shared device is counted again");
  });
});
