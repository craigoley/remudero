import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  claudeScratchRoot,
  DEFAULT_SCRATCH_SWEEP_MAX_AGE_MS,
  DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS,
  isReapableScratchTarget,
  reapWorkerScratch,
  SCRATCH_FRESHNESS_DEPTH,
  scratchSlugForCwd,
  scratchTreeIsFresh,
  sweepStaleWorkerScratch,
} from "../src/lib/worker-scratch.js";

const UID = 4242;

// ── STEP 0 derivation (root / uid / slug) ──────────────────────────────────────

test("claudeScratchRoot: base = CLAUDE_CODE_TMPDIR || (darwin '/tmp'), then /claude-<uid>", () => {
  const base = mkdtempSync(join(tmpdir(), "rmd-scratch-root-"));
  try {
    mkdirSync(join(base, `claude-${UID}`), { recursive: true });
    assert.equal(
      claudeScratchRoot({ env: { CLAUDE_CODE_TMPDIR: base }, uid: UID, platform: "linux" }),
      realpathSync(join(base, `claude-${UID}`)),
    );
    // darwin with no override → /tmp/claude-<uid> (macOS symlinks /tmp → /private/tmp).
    const darwin = claudeScratchRoot({ env: {}, uid: UID, platform: "darwin" });
    assert.ok(darwin && /\/claude-4242$/.test(darwin), darwin ?? "null");
    assert.ok(darwin && (darwin.startsWith("/tmp/") || darwin.startsWith("/private/tmp/")), darwin ?? "null");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("scratchSlugForCwd normalizes punctuation in a dotted realpath", () => {
  const d = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rmd.slug-`));
  try {
    const realPath = realpathSync(d);
    assert.ok(realPath.includes("."), "positive control: the realpath contains punctuation to normalize");
    const slashOnlySlug = realPath.replace(/\//g, "-");
    const expectedSlugFromRealPath = realPath.replace(/[^A-Za-z0-9_-]/g, "-");
    assert.notEqual(expectedSlugFromRealPath, slashOnlySlug, "positive control: punctuation changes the expected slug");
    assert.equal(scratchSlugForCwd(d), expectedSlugFromRealPath);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ── The GUARD (STEP 1 requirement: structurally incapable of escaping the root) ──

test("isReapableScratchTarget: ONLY a single segment strictly below the root is reapable", () => {
  const root = "/private/tmp/claude-4242";
  assert.equal(isReapableScratchTarget(root, "/private/tmp/claude-4242/-Users-x"), true);
  assert.equal(isReapableScratchTarget(root, root), false); // the root itself
  assert.equal(isReapableScratchTarget(root, "/private/tmp/claude-4242/a/b"), false); // a grandchild
  assert.equal(isReapableScratchTarget(root, "/private/tmp"), false); // the parent
  assert.equal(isReapableScratchTarget(root, "/Users/foo"), false); // wholly outside
  assert.equal(isReapableScratchTarget(root, "/"), false); // filesystem root
});

test("reapWorkerScratch: a root-like cwd ('/') is refused as empty-slug — rmSync is NEVER called", () => {
  let rmCalls = 0;
  const fsImpl = {
    realpathSync: (p: string) => p,
    existsSync: () => true,
    rmSync: () => {
      rmCalls++;
    },
    readdirSync: () => [] as string[],
    statSync: () => ({ isDirectory: () => true, mtimeMs: 0 }),
  } as never;
  const r = reapWorkerScratch("/", { env: { CLAUDE_CODE_TMPDIR: "/x" }, uid: UID, platform: "linux", fsImpl });
  assert.equal(r.reaped, false);
  assert.equal(r.reason, "empty-slug");
  assert.equal(rmCalls, 0, "a root-like cwd must never reach rmSync");
});

test("reapWorkerScratch: a real worker cwd resolves to a correct in-root path; absent ⇒ no-op (no delete)", () => {
  let rmCalls = 0;
  const fsImpl = {
    realpathSync: (p: string) => p,
    existsSync: () => false, // the derived scratch dir does not exist
    rmSync: () => {
      rmCalls++;
    },
    readdirSync: () => [] as string[],
    statSync: () => ({ isDirectory: () => true, mtimeMs: 0 }),
  } as never;
  const r = reapWorkerScratch("/Users/foo/bar", { env: { CLAUDE_CODE_TMPDIR: "/x" }, uid: UID, platform: "linux", fsImpl });
  assert.equal(r.reaped, false);
  assert.equal(r.reason, "absent");
  assert.ok(r.target?.endsWith("/claude-4242/-Users-foo-bar"), r.target ?? "no target");
  assert.equal(rmCalls, 0, "a mis-derived/absent target must never delete anything");
});

test("reapWorkerScratch: a present, correctly-derived scratch dir IS reaped (positive path)", () => {
  const deleted: string[] = [];
  const fsImpl = {
    realpathSync: (p: string) => p,
    existsSync: () => true,
    rmSync: (p: string) => {
      deleted.push(p);
    },
    readdirSync: () => [] as string[],
    statSync: () => ({ isDirectory: () => true, mtimeMs: 0 }),
  } as never;
  const r = reapWorkerScratch("/Users/foo/bar", { env: { CLAUDE_CODE_TMPDIR: "/x" }, uid: UID, platform: "linux", fsImpl });
  assert.equal(r.reaped, true);
  assert.deepEqual(deleted, ["/x/claude-4242/-Users-foo-bar"]);
});

// ── BOUNDEDNESS: N teardowns (incl a non-graceful populated orphan) → 0 orphans ──

test("boundedness: 3 task teardowns each reap their populated scratch — 0 orphaned entries remain", () => {
  const base = mkdtempSync(join(tmpdir(), "rmd-bound-"));
  const opts = { env: { CLAUDE_CODE_TMPDIR: base }, uid: UID, platform: "linux" as const };
  try {
    mkdirSync(join(base, `claude-${UID}`), { recursive: true });
    const root = claudeScratchRoot(opts)!;
    const cwds: string[] = [];
    // Each worker leaves a POPULATED scratchpad (simulating a non-graceful kill:
    // the CLI does not clean up, so bytes remain — this is the real 17G source).
    for (let i = 0; i < 3; i++) {
      const cwd = mkdtempSync(join(base, `worker-${i}-`));
      const scratch = join(root, scratchSlugForCwd(cwd, opts), "session-uuid");
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, "big.bin"), "x".repeat(4096));
      cwds.push(cwd);
    }
    const before = readdirSync(root).length;
    assert.equal(before, 3, "3 populated scratchpads exist before teardown");

    // The orchestrator survives each killed worker and reaps at teardown.
    for (const cwd of cwds) {
      const r = reapWorkerScratch(cwd, opts);
      assert.equal(r.reaped, true, `reaped scratch for ${cwd}`);
      rmSync(cwd, { recursive: true, force: true }); // then the worktree/cwd is removed
    }
    const after = readdirSync(root).length;
    assert.equal(after, 0, `0 orphaned scratch entries after teardown (before=${before}, after=${after})`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("boundedness backstop: the boot sweep reaps a STALE orphan but preserves a LIVE session", () => {
  const base = mkdtempSync(join(tmpdir(), "rmd-bound2-"));
  const opts = { env: { CLAUDE_CODE_TMPDIR: base }, uid: UID, platform: "linux" as const };
  try {
    mkdirSync(join(base, `claude-${UID}`), { recursive: true });
    const root = claudeScratchRoot(opts)!;
    const live = join(root, "-Users-live");
    const orphan = join(root, "-Users-orphan");
    mkdirSync(live, { recursive: true }); // fresh mtime = now (a running session)
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "big.bin"), "x".repeat(4096));
    const past = Date.now() / 1000 - 48 * 3600; // 48h ago — a crashed-orchestrator orphan
    utimesSync(join(orphan, "big.bin"), past, past); // an orphan's contents are as old as the dir
    utimesSync(orphan, past, past);

    const before = readdirSync(root).length;
    const summary = sweepStaleWorkerScratch(opts); // default 24h ceiling, real clock
    assert.deepEqual(summary.removed, ["-Users-orphan"], "only the stale orphan is reaped");
    assert.ok(existsSync(live), "the live session's scratch is preserved (recent mtime)");
    assert.ok(!existsSync(orphan), "the stale orphan is gone");
    assert.equal(readdirSync(root).length, before - 1, `before=${before}, after=${readdirSync(root).length}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── per-teardown accumulation sweep (the killed-fixture-orphan fix) ─────────────

test("DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS: above the longest task (92.3min) yet under the 24h boot ceiling", () => {
  const maxTaskMs = 92.3 * 60 * 1000; // longest observed task wall-time (rmd ledger, 512 runs)
  assert.ok(
    DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS > maxTaskMs,
    "must exceed the longest observed task so a concurrent live fixture is never reaped mid-run",
  );
  assert.ok(
    DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS < DEFAULT_SCRATCH_SWEEP_MAX_AGE_MS,
    "must be shorter than the 24h boot ceiling to curb between-boot accumulation",
  );
});

test("worktreeRemove wires the teardown sweep alongside the per-slug reap", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "worker.ts"), "utf8");
  const start = src.indexOf("export function worktreeRemove(");
  const body = src.slice(start, src.indexOf("\n}", start));
  assert.ok(body.includes("reapWorkerScratch(worktreePath)"), "keeps the #559 per-slug reap");
  assert.ok(body.includes("sweepStaleWorkerScratch({"), "adds the teardown accumulation sweep");
  assert.ok(body.includes("DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS"), "uses the distinct teardown ceiling, not the 24h boot one");
});

test("teardown sweep: a fixture YOUNGER than the teardown ceiling survives; one OLDER is reaped", () => {
  const base = mkdtempSync(join(tmpdir(), "rmd-teardown-age-"));
  const opts = { env: { CLAUDE_CODE_TMPDIR: base }, uid: UID, platform: "linux" as const };
  try {
    mkdirSync(join(base, `claude-${UID}`), { recursive: true });
    const root = claudeScratchRoot(opts)!;
    const ceil = DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS;
    const seed = (name: string, ageMs: number) => {
      const d = join(root, name);
      mkdirSync(d, { recursive: true });
      const past = new Date(Date.now() - ageMs);
      utimesSync(d, past, past);
      return d;
    };
    const live = seed("rmd-w219-grep-Live", ceil - 60 * 60 * 1000); // 1h under the ceiling — a recent/live fixture
    const orphan = seed("rmd-fixrung-Orphan", ceil + 60 * 60 * 1000); // 1h over — a killed orphan
    const summary = sweepStaleWorkerScratch({ ...opts, maxAgeMs: ceil });
    assert.deepEqual(summary.removed, ["rmd-fixrung-Orphan"]);
    assert.ok(existsSync(live), "a fixture younger than the ceiling (possibly live) survives");
    assert.ok(!existsSync(orphan), "a fixture older than the ceiling (a killed orphan) is reaped");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("teardown sweep: a SIGKILLed test's rmd-* fixture orphan is reaped within the cycle (before/after)", () => {
  const base = mkdtempSync(join(tmpdir(), "rmd-teardown-orphan-"));
  const opts = { env: { CLAUDE_CODE_TMPDIR: base }, uid: UID, platform: "linux" as const };
  try {
    mkdirSync(join(base, `claude-${UID}`), { recursive: true });
    const root = claudeScratchRoot(opts)!;
    // A killed `npm test`: a populated rmd-* fixture left behind, stale (> the teardown ceiling).
    const orphan = join(root, "rmd-drain-gw-root-Killed");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "leaked.bin"), "x".repeat(4096));
    const stale = new Date(Date.now() - (DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS + 60_000));
    utimesSync(join(orphan, "leaked.bin"), stale, stale); // an orphan's contents are as old as the dir
    utimesSync(orphan, stale, stale);
    const before = readdirSync(root).length;
    sweepStaleWorkerScratch({ ...opts, maxAgeMs: DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS });
    const after = readdirSync(root).length;
    assert.ok(!existsSync(orphan), "the killed-test orphan is reaped at teardown, not left for the 24h boot sweep");
    assert.equal(after, before - 1, `before=${before}, after=${after}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("teardown sweep: a task's OWN fresh SDK <slug> scratchpad AND a fresh fixture both survive (non-interference)", () => {
  const base = mkdtempSync(join(tmpdir(), "rmd-teardown-noninterf-"));
  const opts = { env: { CLAUDE_CODE_TMPDIR: base }, uid: UID, platform: "linux" as const };
  try {
    mkdirSync(join(base, `claude-${UID}`), { recursive: true });
    const root = claudeScratchRoot(opts)!;
    const slugDir = join(root, "-Users-live-worktrees-run-W1-T999-1"); // a live worker's OWN SDK scratchpad (fresh mtime)
    mkdirSync(slugDir, { recursive: true });
    const liveFixture = join(root, "rmd-w227-Fresh"); // a fresh fixture from a still-running test
    mkdirSync(liveFixture, { recursive: true });
    const summary = sweepStaleWorkerScratch({ ...opts, maxAgeMs: DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS });
    assert.deepEqual(summary.removed, [], "nothing fresh is reaped");
    assert.ok(existsSync(slugDir), "the live worker's own SDK <slug> scratchpad survives (fresh, < ceiling)");
    assert.ok(existsSync(liveFixture), "a fresh (live) fixture survives (< ceiling)");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── a live session is judged by what it writes, not by its slug dir's own mtime ─────

/** Backdate each of `paths`. utimes never touches a parent's mtime, so callers list children first. */
function backdate(paths: string[], ageMs: number): void {
  const past = new Date(Date.now() - ageMs);
  for (const p of paths) utimesSync(p, past, past);
}

test("a live session's aged slug dir survives both sweeps while it still writes deep inside", () => {
  const base = mkdtempSync(join(tmpdir(), "rmd-scratch-live-session-"));
  const opts = { env: { CLAUDE_CODE_TMPDIR: base }, uid: UID, platform: "linux" as const };
  try {
    mkdirSync(join(base, `claude-${UID}`), { recursive: true });
    const root = claudeScratchRoot(opts)!;
    // Claude Code's own shape: <slug>/<session>/scratchpad/<file>. The slug and session dirs
    // were created days ago; only the file the session just wrote is recent.
    const slug = join(root, "-home-user-remudero");
    const session = join(slug, "c8a25d1a-session");
    const scratchpad = join(session, "scratchpad");
    mkdirSync(scratchpad, { recursive: true });
    writeFileSync(join(scratchpad, "notes.md"), "written a minute ago");
    backdate([scratchpad, session, slug], 13 * 24 * 3600 * 1000);
    // A real orphan of the same shape, everything in it old.
    const orphan = join(root, "-home-user-gone");
    const orphanPad = join(orphan, "dead-session", "scratchpad");
    mkdirSync(orphanPad, { recursive: true });
    writeFileSync(join(orphanPad, "old.md"), "abandoned");
    backdate([join(orphanPad, "old.md"), orphanPad, join(orphan, "dead-session"), orphan], 13 * 24 * 3600 * 1000);

    const teardown = sweepStaleWorkerScratch({ ...opts, maxAgeMs: DEFAULT_TEARDOWN_SCRATCH_SWEEP_MAX_AGE_MS });
    assert.deepEqual(teardown.removed, ["-home-user-gone"], "the teardown sweep reaps only the orphan");
    assert.deepEqual(teardown.unproved, []);
    assert.ok(existsSync(join(scratchpad, "notes.md")), "the live session's scratch survives the 4h teardown sweep");
    const boot = sweepStaleWorkerScratch(opts);
    assert.deepEqual(boot.removed, [], "the 24h boot sweep leaves the live session too");
    assert.ok(existsSync(join(scratchpad, "notes.md")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the freshness walk reads SCRATCH_FRESHNESS_DEPTH levels and no deeper", () => {
  const base = mkdtempSync(join(tmpdir(), "rmd-scratch-depth-"));
  try {
    const dir = join(base, "slug");
    const levels = [dir];
    for (let i = 0; i < SCRATCH_FRESHNESS_DEPTH; i++) levels.push(join(levels[levels.length - 1]!, `l${i + 1}`));
    mkdirSync(levels[levels.length - 1]!, { recursive: true });
    const deepest = levels[levels.length - 1]!;
    const freshAfter = Date.now() - 60_000;
    writeFileSync(join(deepest, "beyond.txt"), "one level past the walk");
    backdate([...levels].reverse(), 48 * 3600 * 1000);
    assert.equal(scratchTreeIsFresh(dir, freshAfter), false, "a fresh file one level past the bound is not read");
    writeFileSync(join(levels[levels.length - 2]!, "within.txt"), "at the bound");
    backdate([levels[levels.length - 2]!, ...levels.slice(0, -2).reverse()], 48 * 3600 * 1000);
    assert.equal(scratchTreeIsFresh(dir, freshAfter), true, "a fresh file at the bound is read");
    assert.equal(scratchTreeIsFresh(join(base, "missing"), freshAfter), false, "a vanished dir has nothing fresh in it");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a broken symlink inside an aged orphan has no mtime and does not keep it", () => {
  const base = mkdtempSync(join(tmpdir(), "rmd-scratch-broken-link-"));
  const opts = { env: { CLAUDE_CODE_TMPDIR: base }, uid: UID, platform: "linux" as const };
  try {
    mkdirSync(join(base, `claude-${UID}`), { recursive: true });
    const root = claudeScratchRoot(opts)!;
    const orphan = join(root, "-tmp-worker-gone");
    mkdirSync(orphan, { recursive: true });
    symlinkSync(join(base, "never-existed"), join(orphan, "dangling"));
    backdate([orphan], 48 * 3600 * 1000);
    const summary = sweepStaleWorkerScratch(opts);
    assert.deepEqual(summary.removed, ["-tmp-worker-gone"]);
    assert.deepEqual(summary.unproved, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an unreadable entry leaves staleness unproved: the dir is kept, named, and never deleted", () => {
  const old = Date.now() - 48 * 3600 * 1000;
  const dirStat = { isDirectory: () => true, mtimeMs: old };
  const removed: string[] = [];
  const fsImpl = {
    realpathSync: (p: string) => p,
    existsSync: () => true,
    statSync: () => dirStat,
    readdirSync: (p: string, o?: { withFileTypes?: boolean }) => {
      if (!o?.withFileTypes) return ["-home-user-locked"];
      if (p.endsWith("-home-user-locked")) return [{ name: "session", isDirectory: () => true }];
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${p}'`), { code: "EACCES" });
    },
    rmSync: (p: string) => void removed.push(p),
  } as never;
  const summary = sweepStaleWorkerScratch({ env: { CLAUDE_CODE_TMPDIR: "/x" }, uid: UID, platform: "linux", fsImpl });
  assert.deepEqual(summary.unproved, ["-home-user-locked"]);
  assert.ok(summary.kept.includes("-home-user-locked"));
  assert.deepEqual(summary.removed, []);
  assert.deepEqual(removed, [], "rmSync is never called on a dir whose freshness could not be read");
});
