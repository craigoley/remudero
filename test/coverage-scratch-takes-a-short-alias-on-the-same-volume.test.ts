import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import { coverageScratchDir } from "../src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/** A TMPDIR as long as macOS's per-user /private/var/folders/<..>/T, built under /tmp so the
 *  fixture is identical on Linux CI and on a Mac. */
function longTmp(): { holder: string; long: string } {
  const holder = mkdtempSync(join("/tmp", `${RMD_TMP_PREFIX}long-`));
  const long = join(holder, "var-folders-sq-rbw6p38n5dqcm3zstncgsmzc0000gp", "T");
  mkdirSync(long, { recursive: true });
  return { holder, long };
}

function withTmp<T>(tmp: string, run: () => T): T {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

test("a TMPDIR too long for shard sockets moves coverage scratch to the short /tmp alias of the same volume", () => {
  const { holder, long } = longTmp();
  const workdir = mkdtempSync(join("/tmp", `${RMD_TMP_PREFIX}w-`));
  try {
    assert.ok(join(realpathSync(long), "rmd-c-000000000000").length > 60, "control: the TMPDIR-derived scratch would exceed the guard");
    const scratch = withTmp(long, () => coverageScratchDir(workdir));
    assert.equal(dirname(scratch), realpathSync("/tmp"), "the scratch moves to the short root");
    assert.match(basename(scratch), /^rmd-c-[0-9a-f]{12}$/);
    assert.ok(scratch.length <= 60, `the scratch path fits the guard: ${scratch}`);
  } finally {
    rmSync(holder, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a too-long TMPDIR on another volume keeps its own base, so the length guard still refuses it", () => {
  const { holder, long } = longTmp();
  const workdir = mkdtempSync(join("/tmp", `${RMD_TMP_PREFIX}w-`));
  try {
    const scratch = withTmp(long, () => coverageScratchDir(workdir, () => false));
    assert.equal(dirname(scratch), realpathSync(long), "a different volume is never swapped for /tmp");
    assert.ok(scratch.length > 60, "the long path is left for the guard to refuse");
  } finally {
    rmSync(holder, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a short TMPDIR keeps its own base", () => {
  const workdir = mkdtempSync(join("/tmp", `${RMD_TMP_PREFIX}w-`));
  const shortTmp = mkdtempSync(join("/tmp", "rt-"));
  try {
    const scratch = withTmp(shortTmp, () => coverageScratchDir(workdir, () => true));
    assert.equal(dirname(scratch), realpathSync(shortTmp), "a TMPDIR that already fits is used as-is");
  } finally {
    rmSync(shortTmp, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
