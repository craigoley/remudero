/**
 * test/no-test-reaches-the-real-github.test.ts — proof for W1-T4119.
 *
 * `test/policy.test.ts` made a real `gh api repos/craigoley/remudero/pulls/6698/files` call — a
 * live PR number — and hung until it was killed; `test/review-command-plan-filing-provenance.test.ts`
 * (W1-T3115) was red on clean main for the same reason. The fix lives in
 * test/setup/tmp-hygiene.ts (`--import`ed by every `node --test` invocation — see its own module
 * comment): it prepends a per-process directory holding a `gh` stub onto PATH, ahead of the real
 * `gh` binary, so a test that shells out without its own stub is refused instead of reaching the
 * network.
 *
 * These tests observe the effect from OUTSIDE the setup module — actually shelling out to `gh`,
 * exactly like a production call site would — not the module's own internals. Every `node --test`
 * file this suite runs is itself started with the real `--import ./test/setup/tmp-hygiene.ts`
 * flag (see package.json's `test`/`test:ci` scripts), so by the time this file's tests run, the
 * shared stub is already on PATH — no separate child process needed to observe it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("W1-T4119 claim 1: a test that shells out to gh without its own stub is refused by the shared setup", () => {
  assert.throws(
    () => execFileSync("gh", ["api", "repos/craigoley/remudero/pulls/6698/files"], { stdio: "pipe" }),
    /./,
    "the shared setup's gh stub must exit non-zero instead of letting the call reach the real gh",
  );
});

test("W1-T4119 claim 2: a test's own gh stub still takes precedence over the shared one", () => {
  // Same convention every existing PATH-shim call site already uses (see test/helpers/gh-shim.ts):
  // build a own `gh` script, prepend its dir onto the CURRENT PATH (which already carries the
  // shared refusal stub, installed at import time, earlier in this same process), and confirm the
  // test's own dir — being first — answers instead of the shared refusal.
  const dir = mkdtempSync(join(tmpdir(), "rmd-test-gh-own-stub-"));
  const ghPath = join(dir, "gh");
  writeFileSync(ghPath, ["#!/bin/sh", 'echo "OWN-STUB-ANSWERED: $*"', "exit 0", ""].join("\n"), { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
  try {
    const out = execFileSync("gh", ["api", "repos/craigoley/remudero/pulls/6698/files"], { encoding: "utf8" });
    assert.match(out, /OWN-STUB-ANSWERED/, "the test's own stub, prepended last, must be found first on PATH");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("W1-T4119 claim 3: the shared gh refusal names the argv it refused", () => {
  assert.throws(
    () => execFileSync("gh", ["api", "repos/craigoley/remudero/pulls/6698/files"], { stdio: "pipe" }),
    (err: unknown) => {
      const stderr = String((err as { stderr?: Buffer | string }).stderr ?? "");
      assert.match(stderr, /REFUSED/, "names that this is a refusal, not an ordinary failure");
      assert.match(
        stderr,
        /argv: gh api repos\/craigoley\/remudero\/pulls\/6698\/files/,
        "names the exact argv it refused, so the accidental call names itself",
      );
      return true;
    },
  );
});
