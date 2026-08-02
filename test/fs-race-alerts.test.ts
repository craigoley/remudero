import assert from "node:assert/strict";
import fsMod from "node:fs";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createOrReadExclusive, readFileIfExists } from "../src/lib/fs-race-safe.js";
import { configPath, loadConfig, type Config } from "../src/lib/config.js";
import { resolveServiceTokens, serviceTokensPath } from "../src/lib/serve.js";

// ── W1-T286: closes CodeQL js/file-system-race alerts #60 (src/lib/config.ts:402) and #61
// (src/lib/serve.ts:3940). Both alerts were, per the code-scanning API, already `state:
// dismissed` / `dismissed_reason: false positive` at the commit this task started from —
// the SAME exclusive-create ("wx") + EEXIST-fallback-read-by-descriptor idiom this repo has
// shipped three times before (W1-T67, alert #24, alert #71) was already in place at both
// flagged lines; a human dismissed CodeQL's re-flag as a false positive with exactly that
// rationale. This test pins the shared helper (fs-race-safe.ts) both flagged sites now route
// through, so a fifth round reuses tested code instead of a fourth open-coded copy.

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── createOrReadExclusive: the shared "wx" create-or-read helper ───────────────────────────

test("createOrReadExclusive: the file is ABSENT — reports created:true with a writable fd, no read", () => {
  const dir = tmpDir("rmd-fsrace-create-");
  const p = join(dir, "state.json");
  const result = createOrReadExclusive(p, 0o600);
  assert.equal(result.created, true);
  if (!result.created) throw new Error("unreachable");
  try {
    writeSync(result.fd, "hello");
  } finally {
    closeSync(result.fd);
  }
  assert.equal(readFileSync(p, "utf8"), "hello");
});

test("createOrReadExclusive: the EEXIST branch READS the existing file through a descriptor, never clobbering it (no exists-then-write TOCTOU)", () => {
  const dir = tmpDir("rmd-fsrace-eexist-");
  const p = join(dir, "state.json");
  writeFileSync(p, "SENTINEL-CONTENTS");

  const result = createOrReadExclusive(p, 0o600);
  assert.equal(result.created, false);
  if (result.created) throw new Error("unreachable");
  assert.equal(result.raw, "SENTINEL-CONTENTS");
  // The file on disk is untouched — the EEXIST path wrote nothing.
  assert.equal(readFileSync(p, "utf8"), "SENTINEL-CONTENTS");
});

test("createOrReadExclusive: a non-EEXIST open failure (EISDIR) is rethrown, never swallowed as if raced", () => {
  const dir = tmpDir("rmd-fsrace-eisdir-");
  const p = join(dir, "state.json");
  mkdirSync(p); // a DIRECTORY sitting at the path -> `wx` fails EISDIR, not EEXIST
  assert.throws(() => createOrReadExclusive(p, 0o600), /EISDIR/);
});

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

// ── alert #60 (src/lib/config.ts:402) — loadConfig now routes through the shared helper ────

test("alert #60 (config.ts loadConfig): EEXIST fallback still reads the existing config, byte-identical to before the shared-helper refactor", () => {
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

// ── alert #61 (src/lib/serve.ts:3940) — resolveServiceTokens now routes through the shared helper ──

test("alert #61 (serve.ts resolveServiceTokens): generates once, persists, and the EEXIST fallback returns the SAME tokens across calls", () => {
  const dir = tmpDir("rmd-fsrace-svc-");
  const root = join(dir, "root");
  const first = resolveServiceTokens(root);
  assert.ok(first.read.length > 0);
  assert.ok(first.write.length > 0);
  assert.notEqual(first.read, first.write);

  const second = resolveServiceTokens(root); // wx -> EEXIST -> shared-helper read path
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

// ── the check-then-act WINDOW itself (added while getting PR #1106 green) ──────────────────
// CodeQL alert #84 flagged the fallback read inside `createOrReadExclusive`: the file may have
// changed since the `wx` attempt proved it existed. That flag was correct about the mechanism —
// a peer unlinking in that window made the helper throw ENOENT out of the very function whose
// job is to make the sequence safe. These two pin the retry that closes it.

test("createOrReadExclusive: a peer that UNLINKS between the wx attempt and the fallback read is retried, not crashed on", () => {
  const dir = tmpDir("rmd-fsrace-window-");
  const p = join(dir, "state.json");
  writeFileSync(p, "written-by-the-peer");

  // Stand in for the peer: the first fallback read finds the file gone (we unlink it exactly
  // once, in the window), so the helper must loop and become the creator itself.
  // Inject the syscalls so the window is deterministic: the FIRST fallback read finds the file
  // gone (the peer unlinked it), so the helper must loop and become the creator itself.
  let unlinked = false;
  const fsImpl = {
    openSync: ((p2: string, flags: string, m?: number) => {
      if (flags === "r" && !unlinked) {
        unlinked = true;
        rmSync(p2, { force: true });
      }
      return fsMod.openSync(p2, flags as never, m as never);
    }) as typeof fsMod.openSync,
    readFileSync: fsMod.readFileSync,
    closeSync: fsMod.closeSync,
  };
  const result = createOrReadExclusive(p, 0o600, fsImpl);
  assert.equal(result.created, true, "after the peer's unlink the helper must become the creator");
  if (!result.created) throw new Error("unreachable");
  closeSync(result.fd);
  assert.equal(unlinked, true, "the fixture must actually have exercised the window");
});

test("createOrReadExclusive: a non-ENOENT read failure still propagates, never retried away", () => {
  const dir = tmpDir("rmd-fsrace-eisdir-");
  const p = join(dir, "state.json");
  mkdirSync(p); // a DIRECTORY at the path: `wx` gives EEXIST, the read gives EISDIR
  assert.throws(() => createOrReadExclusive(p, 0o600), (e: NodeJS.ErrnoException) => e.code === "EISDIR");
});
// ── consolidated proof: both branches asserted for each site this PR touched ───────────────
// Every site this PR touched (config.ts's loadConfig, serve.ts's resolveServiceTokens,
// fs-race-safe.ts's readFileIfExists) gets BOTH its branches exercised in one place: the
// exclusive-create ("wx") sites assert their EEXIST fallback reads the existing file rather
// than clobbering it, and the shared optional-read helper asserts its ENOENT branch reports
// absence (`undefined`) rather than throwing. (The per-site tests below also cover each of
// these individually, plus their non-EEXIST/non-ENOENT error-rethrow edges.)
test("W1-T286: both branches asserted for each site this PR touched (EEXIST-read, ENOENT-absence)", () => {
  // site 1: config.ts loadConfig — EEXIST branch reads the existing config, does not clobber it
  const home = mkdtempSync(join(tmpdir(), "rmd-fsrace-both-cfg-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const p = configPath();
    const existing: Config = { claudeBin: "/opt/homebrew/bin/claude", root: "/SENTINEL/both-branches" };
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(existing, null, 2) + "\n");
    const loaded = loadConfig(); // wx -> EEXIST -> read-by-descriptor fallback
    assert.equal(loaded.root, "/SENTINEL/both-branches", "config.ts EEXIST branch must READ, not clobber");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }

  // site 2: serve.ts resolveServiceTokens — EEXIST branch reads the existing tokens, does not clobber them
  const dir = tmpDir("rmd-fsrace-both-svc-");
  const root = join(dir, "root");
  const firstTokens = resolveServiceTokens(root);
  const secondTokens = resolveServiceTokens(root); // wx -> EEXIST -> read-by-descriptor fallback
  assert.deepEqual(secondTokens, firstTokens, "serve.ts EEXIST branch must READ, not clobber");

  // site 3: fs-race-safe.ts readFileIfExists — ENOENT branch reports absence, never throws
  assert.equal(
    readFileIfExists(join(dir, "does-not-exist-either.json")),
    undefined,
    "readFileIfExists ENOENT branch must report absence, not throw",
  );
});

