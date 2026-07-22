import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REAPABLE_TEST_PREFIX, reapableTmpPrefix } from "./setup/reapable-prefix.js";
import { DEFAULT_TEMP_SWEEP_MAX_AGE_MS, sweepStaleTempDirs } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HYGIENE_IMPORT = join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts");

// ── the pure prefix normalizer ─────────────────────────────────────────────────

test("reapableTmpPrefix: a BARE fixture prefix under the temp root gains the reapable rmd-test- marker", () => {
  assert.equal(reapableTmpPrefix("/tmp/drain-", "/tmp"), "/tmp/rmd-test-drain-");
  assert.equal(reapableTmpPrefix("/tmp/learnings-index-roundtrip-", "/tmp"), "/tmp/rmd-test-learnings-index-roundtrip-");
  assert.equal(reapableTmpPrefix("/tmp/daemon-headroom-", "/tmp"), "/tmp/rmd-test-daemon-headroom-");
  // the original token survives as a substring, so a path-grepping test still matches.
  assert.ok(reapableTmpPrefix("/tmp/drain-", "/tmp").includes("drain-"));
  assert.ok(reapableTmpPrefix("/tmp/drain-", "/tmp").startsWith("/tmp/" + REAPABLE_TEST_PREFIX));
});

test("reapableTmpPrefix: an already-rmd- prefix is left untouched (already boot-reapable)", () => {
  assert.equal(reapableTmpPrefix("/tmp/rmd-inbox-", "/tmp"), "/tmp/rmd-inbox-");
  assert.equal(reapableTmpPrefix("/tmp/rmd-test-x-", "/tmp"), "/tmp/rmd-test-x-"); // no double-prefix
});

test("reapableTmpPrefix: a prefix NOT directly under the temp root is left untouched", () => {
  assert.equal(reapableTmpPrefix("/some/other/place/drain-", "/tmp"), "/some/other/place/drain-");
  assert.equal(reapableTmpPrefix("/tmp/sub/dir/drain-", "/tmp"), "/tmp/sub/dir/drain-"); // a grandchild, not scanned
});

// ── the boot sweep reaps the normalized prefix (killed-mid-test orphan) ─────────

test("sweepStaleTempDirs reaps a STALE rmd-test- orphan (the SIGKILL'd fixture) but keeps a fresh one", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-reapsweep-root-"));
  try {
    const seed = (name: string, ageMs: number) => {
      const d = join(root, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "leaked.bin"), "x".repeat(4096));
      const past = new Date(Date.now() - ageMs);
      utimesSync(d, past, past);
      return d;
    };
    const staleOrphan = seed("rmd-test-learnings-index-roundtrip-AbCdEf", DEFAULT_TEMP_SWEEP_MAX_AGE_MS + 60_000);
    const freshLive = seed("rmd-test-drain-XyZ123", 1_000);
    const before = readdirSync(root).length;

    const summary = sweepStaleTempDirs({ root });

    assert.deepEqual(summary.removed, ["rmd-test-learnings-index-roundtrip-AbCdEf"], `before=${before}`);
    assert.ok(!existsSync(staleOrphan), "the stale killed-mid-test orphan is reaped");
    assert.ok(existsSync(freshLive), "a fresh (still-running) fixture dir is preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── end-to-end: the hygiene interceptor normalizes a REAL bare-prefix fixture ────

test("interceptor: a fixture's bare mkdtempSync prefix is created as rmd-test- under the real hygiene --import", () => {
  const scratch = mkdtempSync(join(tmpdir(), "rmd-reapproof-scratch-"));
  try {
    const fixture = join(scratch, "fixture-bare.test.ts");
    const outFile = join(scratch, "created-basename.txt");
    writeFileSync(
      fixture,
      [
        'import { mkdtempSync, writeFileSync } from "node:fs";',
        'import { tmpdir } from "node:os";',
        'import { basename, join } from "node:path";',
        'import { test } from "node:test";',
        'test("bare-prefix fixture", () => {',
        '  const d = mkdtempSync(join(tmpdir(), "reapproof-bare-nonrmd-"));',
        `  writeFileSync(${JSON.stringify(outFile)}, basename(d));`,
        "});",
        "",
      ].join("\n"),
    );
    // Run EXACTLY as the `test` npm script does: tsx + the hygiene setup import.
    // Strip NODE_TEST_CONTEXT (this test itself runs under `node --test`) so the
    // NESTED runner starts clean and actually executes the fixture's test body.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_OPTIONS;
    execFileSync("node", ["--test", "--import", "tsx", "--import", HYGIENE_IMPORT, fixture], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: childEnv,
    });
    assert.ok(existsSync(outFile), "the fixture recorded its created dir basename");
    const base = readFileSync(outFile, "utf8").trim();
    assert.ok(
      base.startsWith(REAPABLE_TEST_PREFIX + "reapproof-bare-nonrmd-"),
      `a bare-prefix fixture dir must be created as ${REAPABLE_TEST_PREFIX}… — got '${base}'`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
