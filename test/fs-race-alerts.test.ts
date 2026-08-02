import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readFileIfExists } from "../src/lib/fs-race-safe.js";
import { configPath, loadConfig, type Config } from "../src/lib/config.js";
import { resolveServiceTokens, serviceTokensPath } from "../src/lib/serve.js";

// ── W1-T286: closes CodeQL js/file-system-race alerts #60 (src/lib/config.ts:402) and #61
// (src/lib/serve.ts:3940). Both alerts were, per the code-scanning API, already `state:
// dismissed` / `dismissed_reason: false positive` at the commit this task started from —
// the SAME exclusive-create ("wx") + EEXIST-fallback-read-by-descriptor idiom this repo has
// shipped three times before (W1-T67, alert #24, alert #71) was already in place at both
// flagged lines; a human dismissed CodeQL's re-flag as a false positive with exactly that
// rationale. loadConfig/resolveServiceTokens below pin that shape stays byte-identical to
// what was reviewed and dismissed (see fs-race-safe.ts's header comment for why a shared
// helper for THIS particular shape backfired: relocating it produced a brand-new,
// un-dismissed CodeQL alert instead of reusing the existing dismissal). Only the
// catch-ENOENT optional-read shape — never itself flagged — moved to the shared
// `readFileIfExists` helper.

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── readFileIfExists: the shared catch-ENOENT optional-read helper ─────────────────────────

test("readFileIfExists: an existing file returns its contents", () => {
  const dir = tmpDir("rmd-fsrace-read-");
  const p = join(dir, "maybe.json");
  writeFileSync(p, "{}");
  assert.equal(readFileIfExists(p), "{}");
});

test("readFileIfExists: a missing file (ENOENT) reports absence instead of throwing", () => {
  const dir = tmpDir("rmd-fsrace-read-");
  const p = join(dir, "does-not-exist.json");
  assert.equal(readFileIfExists(p), undefined);
});

test("readFileIfExists: a non-ENOENT read failure (EISDIR) is rethrown, never mistaken for absence", () => {
  const dir = tmpDir("rmd-fsrace-read-eisdir-");
  const p = join(dir, "a-directory");
  mkdirSync(p);
  assert.throws(() => readFileIfExists(p), /EISDIR/);
});

// ── alert #60 (src/lib/config.ts:402) — dismissed false positive; shape stays as reviewed ──

test("alert #60 (config.ts loadConfig): EEXIST fallback still reads the existing config, byte-identical to the dismissed shape", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-fsrace-cfg-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const p = configPath();
    const existing: Config = { claudeBin: "/opt/homebrew/bin/claude", root: "/SENTINEL/root" };
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(existing, null, 2) + "\n");

    const loaded = loadConfig();

    assert.equal(loaded.root, "/SENTINEL/root", "must READ the existing config, not clobber it");
    assert.equal(loaded.claudeBin, "/opt/homebrew/bin/claude");
    assert.equal(readFileSync(p, "utf8"), JSON.stringify(existing, null, 2) + "\n", "on-disk bytes unchanged");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

// ── alert #61 (src/lib/serve.ts:3940) — dismissed false positive; shape stays as reviewed ──

test("alert #61 (serve.ts resolveServiceTokens): generates once, persists, and the EEXIST fallback returns the SAME tokens across calls", () => {
  const dir = tmpDir("rmd-fsrace-svc-");
  const root = join(dir, "root");
  const first = resolveServiceTokens(root);
  assert.ok(first.read.length > 0);
  assert.ok(first.write.length > 0);
  assert.notEqual(first.read, first.write);

  const second = resolveServiceTokens(root); // wx -> EEXIST -> descriptor read path
  assert.deepEqual(second, first, "the EEXIST fallback must read back the SAME tokens, never regenerate");
  assert.equal(
    readFileSync(serviceTokensPath(root), "utf8"),
    JSON.stringify(first, null, 2) + "\n",
    "on-disk bytes unchanged across the second call",
  );
});

test("alert #61 (serve.ts resolveServiceTokens): a non-EEXIST open failure (EISDIR) is rethrown, never swallowed as if raced", () => {
  const dir = tmpDir("rmd-fsrace-svc-eisdir-");
  const root = join(dir, "root");
  const p = serviceTokensPath(root);
  mkdirSync(p, { recursive: true }); // a DIRECTORY at the tokens path -> EISDIR, not EEXIST
  assert.throws(() => resolveServiceTokens(root), /EISDIR/);
});
