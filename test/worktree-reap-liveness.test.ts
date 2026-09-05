/**
 * THE CADENCE REAPER'S ACTIVITY GATE (W1-T378) — it used to measure a clock that never ticks.
 *
 * THE DEFECT. `reapStaleWorktrees` age-gated on `statSync(worktreeRoot).mtimeMs`. A DIRECTORY's
 * mtime advances only when an entry is added to or removed from THAT directory — never when a file
 * nested inside it is modified. A worker editing `src/lib/feedback.ts` touches `src/lib/`'s mtime,
 * not the root's; `git commit` in a linked worktree writes to `<parent>/.git/worktrees/<name>/index`,
 * outside the tree entirely. So the root's mtime was frozen at checkout and the age gate — with
 * `pruneGraceMs` at 120000, TWO MINUTES — degraded to "reap unconditionally" the moment the live-pid
 * guard stopped holding.
 *
 * THE MEASURED INCIDENT (2026-08-05, task W1-T350): run 1785957031821's worktree was destroyed at
 * 20:01:40, 40m41s after `worktree.add`. The run was alive and productive — it committed at
 * 20:03:37, opened PR #1377 at 20:08:02, and was still adding test coverage at 20:52:35, 51 minutes
 * after being declared terminal. Its sibling run-W1-T349, which STARTED EARLIER, was kept in the
 * same pass, so the decision was not age-ordered and this was not a sweep of old debris.
 *
 * WHAT THESE TESTS DRIVE, stated rather than implied: `reapStaleWorktrees` and `newestActivityMs`
 * are the real production functions, and the headline tests build REAL directory trees on disk and
 * drive the REAL walk — `opts.newestActivity` is NOT injected in them, so the production probe's
 * own recursion, skip-list, symlink refusal and root-mtime floor are what execute. The injectable
 * seam is used only where a fixture cannot force the state (the entry cap, and one unreadable-tree
 * case that also has a real-chmod twin). `runWorktreeReapRung` is driven for real against a real
 * ledger file.
 * LEFT UNPROVEN, and named: `pruneStaleRuns` carries the SAME root-mtime gate (worker.ts, the
 * `lockRead.kind !== "live" && graceMs > 0` branch) and is deliberately NOT changed here — see this
 * task's PR body for why keeping more there is not free. Nothing else in this diff is unproven.
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts.
 */
import assert from "node:assert/strict";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ACTIVITY_WALK_ENTRY_CAP,
  DEFAULT_PRUNE_GRACE_MS,
  DEFAULT_WORKTREE_REAP_GRACE_MS,
  newestActivityMs,
  reapStaleWorktrees,
  runLockPath,
  runWorktreeReapRung,
  writeRunLock,
} from "../src/lib/worker.js";
import { DEFAULT_LIVENESS_BOUND_MS } from "../src/lib/status.js";
import type { Config } from "../src/lib/config.js";

const MIN = 60_000;
const ago = (mins: number) => new Date(Date.now() - mins * MIN);
// `newestActivityMs`/`reapStaleWorktrees` age-gate on REAL FILESYSTEM MTIMES, which
// `scripts/clock-shift.mjs` cannot shift (it monkeypatches only this process's `Date`) — the
// exact mechanism `CLOCK_ARTIFACTS`' `prune-liveness` entry (scripts/clock-sweep.mjs) already
// names for this suite's own sibling. A file/dir created via `writeFileSync`/`mkdirSync` gets its
// mtime from the REAL OS clock, so under clock-sweep's future shift a fixture meant to read as
// "just written" instead reads as `Date.now() - mtimeMs` days old. Every fixture below that needs
// a path to read as FRESH re-stamps it explicitly from the injected clock — the same "stamp from
// the injected clock" remedy #2250 established for ledger `ts` fields — rather than trusting the
// OS's own real-time write stamp.
const touchNow = (p: string) => utimesSync(p, ago(0), ago(0));

/** A worktrees root holding one entry, with a real nested tree inside it. */
function fixture(entryName = "run-W1-T350-1785957031821") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-activity-")));
  const entry = join(root, entryName);
  mkdirSync(join(entry, "src", "lib"), { recursive: true });
  return { root, entry, entryName, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Backdate the entry's ROOT dir and every intermediate dir, leaving ONE deep FILE fresh — the exact
 * shape of a worker that has been editing nested sources for a while. Backdating the intermediate
 * dirs too is what makes this test sharp: only the FILE's mtime is recent, so a gate that stats
 * directories alone still reads the tree as ancient.
 */
function backdateAllButDeepFile(entry: string, mins: number): string {
  const deep = join(entry, "src", "lib", "feedback.ts");
  writeFileSync(deep, "export const x = 1;\n"); // fresh, now
  touchNow(deep); // writeFileSync's own mtime is real-clock; re-stamp from the injected clock
  const past = ago(mins);
  utimesSync(join(entry, "src", "lib"), past, past);
  utimesSync(join(entry, "src"), past, past);
  utimesSync(entry, past, past);
  return deep;
}

// ── THE INCIDENT, REPLAYED AGAINST A REAL TREE ────────────────────────────────────────────────

test("a worktree whose ROOT mtime is ancient but whose NESTED file was just written is KEPT", () => {
  const f = fixture();
  try {
    const deep = backdateAllButDeepFile(f.entry, 90);
    // No lock at all and no live branch — so the activity gate is the ONLY thing standing between
    // this live worker and a force-remove, exactly as at 20:01:40 on 2026-08-05.
    // THE PREMISE, MEASURED rather than assumed: the root reads ancient, the tree reads fresh.
    const rootAgeMin = (Date.now() - statSync(f.entry).mtimeMs) / MIN;
    assert.ok(rootAgeMin > 60, `root dir mtime must be ancient, was ${rootAgeMin.toFixed(1)} min old`);
    const probe = newestActivityMs(f.entry);
    assert.equal(probe.complete, true);
    assertWallClockBound((Date.now() - probe.mtimeMs) / MIN, 1, "the real walk finds the fresh nested file");
    assert.equal(statSync(deep).mtimeMs, probe.mtimeMs, "and it is that FILE the walk found");

    // The REAL probe — opts.newestActivity deliberately not injected.
    const s = reapStaleWorktrees(f.root, { branchIsLiveUpstream: () => false });

    assert.deepEqual(s.reaped, [], "live work must NOT be destroyed");
    assert.deepEqual(s.kept, [f.entryName]);
    assert.deepEqual(s.keptReasons, [{ name: f.entryName, reason: "recent-activity" }], "and the reason is recorded");
  } finally {
    f.cleanup();
  }
});

test("FALSIFIER: the OLD predicate (root mtime only) reaps that very tree", () => {
  // The pre-W1-T378 gate, reconstructed exactly: `now() - statSync(entry).mtimeMs >= maxAgeMs`,
  // with the OLD ceiling. Asserting it here proves the change has an effect rather than assuming it,
  // and pins WHY: 90 minutes of frozen root mtime against a 2-minute grace.
  const f = fixture();
  try {
    backdateAllButDeepFile(f.entry, 90);
    const oldPredicateWouldReap = Date.now() - statSync(f.entry).mtimeMs >= DEFAULT_PRUNE_GRACE_MS;
    assert.equal(oldPredicateWouldReap, true, "the old root-mtime gate destroys this live worktree");

    const s = reapStaleWorktrees(f.root, { branchIsLiveUpstream: () => false });
    assert.deepEqual(s.reaped, [], "the new gate does not");
  } finally {
    f.cleanup();
  }
});

// ── DEBRIS IS STILL REAPED — W1-T175's ENOSPC GUARANTEE MUST SURVIVE ──────────────────────────
//
// This matters more than the fix. A reaper that keeps everything is the 909M/ENOSPC incident
// W1-T175 was filed against, and it would satisfy every "it was kept" assertion above.

test("REGRESSION LOCK: genuine debris — nothing recent anywhere in the tree — is still reaped", () => {
  const f = fixture("run-W1-T156-1784574954974");
  try {
    // A real nested tree, but EVERY entry backdated: no live pid, no live branch, no activity.
    const deep = join(f.entry, "src", "lib", "old.ts");
    writeFileSync(deep, "stale\n");
    const past = ago(120);
    for (const p of [deep, join(f.entry, "src", "lib"), join(f.entry, "src"), f.entry]) utimesSync(p, past, past);
    writeRunLock(f.entry, { pid: 999_999, run_id: "W1-T156", startedAt: "2026-07-20T19:17:23.863Z" });

    const s = reapStaleWorktrees(f.root, { isPidAlive: () => false, branchIsLiveUpstream: () => false });

    assert.deepEqual(s.reaped, [f.entryName], "aged debris is still reclaimed");
    assert.deepEqual(s.kept, [], "and nothing was spuriously kept");
  } finally {
    f.cleanup();
  }
});

test("REGRESSION LOCK: a live pid still outranks everything, and a live branch still keeps", () => {
  const f = fixture("run-W1-T900-live");
  try {
    const past = ago(120);
    utimesSync(f.entry, past, past);
    writeRunLock(f.entry, { pid: process.pid, run_id: "W1-T900", startedAt: "2026-07-20T00:00:00Z" });
    const s = reapStaleWorktrees(f.root, { branchIsLiveUpstream: () => false });
    assert.deepEqual(s.keptReasons, [{ name: f.entryName, reason: "live-pid" }], "live pid wins, and says so");
  } finally {
    f.cleanup();
  }
});

// ── W1-T381: A DEAD PID OUTRANKS RECENT ACTIVITY ──────────────────────────────────────────────
//
// THE INCIDENT (2026-08-06): run W1-T357-1785973739363's pid (17925) exited at 23:54:34. At
// 00:26:42 something UNRELATED wrote `plan/questions.ndjson` inside that already-dead run's
// worktree, and `recent-activity` read that write as work in progress and rescued the tree — and
// with it the widowed `.lock`, which held the deploy gate open. An mtime records THAT a write
// happened, never WHO made it, so it cannot outrank the lock's own, stronger claim that the run
// is over. Three directions, and one without the others is not evidence (isPidAlive is FORCED by
// injection throughout, never left to a real process happening to be free or busy).

test("W1-T381 BITES: a lock naming a DEAD pid is not rescued by fresh nested activity — reaped, sibling lock removed too", () => {
  const f = fixture("run-W1-T357-1785973739363");
  try {
    writeRunLock(f.entry, { pid: 17925, run_id: "W1-T357", startedAt: "2026-08-05T23:40:00Z" });
    // Same shape as the incident: ancient root, ONE nested file written seconds ago — exactly what
    // `recent-activity` used to rescue.
    backdateAllButDeepFile(f.entry, 90);
    assert.equal(existsSync(runLockPath(f.entry)), true, "the lock exists before the pass");

    const s = reapStaleWorktrees(f.root, { isPidAlive: () => false, branchIsLiveUpstream: () => false });

    assert.deepEqual(s.reaped, [f.entryName], "the dead pid's own lock outranks the fresh nested write");
    assert.deepEqual(s.kept, [], "recent-activity must not fire for a confirmed-dead lock");
    assert.equal(existsSync(runLockPath(f.entry)), false, "the sibling lock goes with the tree, not left widowed");
  } finally {
    f.cleanup();
  }
});

test("W1-T381 HOLDS (1): a lock naming a LIVE pid is still kept despite an old mtime — the live-pid guard is untouched", () => {
  const f = fixture("run-W1-T358-live");
  try {
    writeRunLock(f.entry, { pid: 4242, run_id: "W1-T358", startedAt: "2026-08-06T00:00:00Z" });
    backdateAllButDeepFile(f.entry, 90); // same ancient-root/fresh-file shape — activity is irrelevant here either way

    const s = reapStaleWorktrees(f.root, { isPidAlive: () => true, branchIsLiveUpstream: () => false });

    assert.deepEqual(s.reaped, [], "a live pid must never be reaped");
    assert.deepEqual(s.keptReasons, [{ name: f.entryName, reason: "live-pid" }], "and the live-pid guard, not recent-activity, is why");
  } finally {
    f.cleanup();
  }
});

test("W1-T381 HOLDS (2): a worktree with NO lock at all is still rescued by recent activity — W1-T378 is not undone", () => {
  const f = fixture("run-W1-T359-nolock");
  try {
    backdateAllButDeepFile(f.entry, 90); // no writeRunLock call — lockRead.kind is "absent"

    const s = reapStaleWorktrees(f.root, { isPidAlive: () => false, branchIsLiveUpstream: () => false });

    assert.deepEqual(s.reaped, [], "an absent lock is not a dead pid — recent activity still rescues");
    assert.deepEqual(s.keptReasons, [{ name: f.entryName, reason: "recent-activity" }]);
  } finally {
    f.cleanup();
  }
});

// ── AN AMBIGUOUS SIGNAL KEEPS, AND THE PASS SAYS SO ───────────────────────────────────────────

test("an UNREADABLE tree is kept as activity-unknown — the fail direction is flipped", () => {
  const f = fixture("run-W1-T901-unreadable");
  try {
    const past = ago(120);
    utimesSync(f.entry, past, past);
    chmodSync(f.entry, 0o000); // a real EACCES, not an injected one
    const s = reapStaleWorktrees(f.root, { isPidAlive: () => false, branchIsLiveUpstream: () => false });
    assert.deepEqual(s.reaped, [], "an entry we cannot inspect is never destroyed");
    assert.deepEqual(s.keptReasons, [{ name: f.entryName, reason: "activity-unknown" }]);
  } finally {
    try {
      chmodSync(f.entry, 0o755);
    } catch {
      /* best effort */
    }
    f.cleanup();
  }
});

test("the reap rung LEDGERS an undecidable keep — the row that bounds disk growth", () => {
  // Criterion 3's "and why" half, driven through the REAL rung against a REAL ledger file. Logged
  // even though NOTHING was reaped, because the ordinary `worktree.reaped` row stays silent then.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-rung-")));
  try {
    const worktreesRoot = join(root, "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    const entry = join(worktreesRoot, "run-W1-T902-blind");
    mkdirSync(entry, { recursive: true });
    const past = ago(120);
    utimesSync(entry, past, past);
    chmodSync(entry, 0o000);

    const ledgerPath = join(root, "ledger.ndjson");
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const summary = runWorktreeReapRung({ root, claudeBin: "/bin/true" } as Config, (step, extra) => {
      rows.push({ step, extra });
      writeFileSync(ledgerPath, `${JSON.stringify({ step, ...extra })}\n`, { flag: "a" });
    });

    assert.deepEqual(summary.reaped, [], "nothing reaped");
    const row = rows.find((r) => r.step === "worktree.reap.undecidable");
    assert.ok(row, "the undecidable keep is ledgered on its own step");
    assert.deepEqual(row?.extra?.kept, ["run-W1-T902-blind"], "naming the entry an operator must look at");
    assert.match(readFileSync(ledgerPath, "utf8"), /worktree\.reap\.undecidable/, "and it really reached the file");
  } finally {
    try {
      chmodSync(join(root, "worktrees", "run-W1-T902-blind"), 0o755);
    } catch {
      /* best effort */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("REGRESSION LOCK: the rung does NOT ledger an undecidable row for ordinary keeps", () => {
  // A row on every healthy pass would be noise, and noise is how the W1-T181 outage stayed
  // invisible for hours. Only the keeps that bound disk get a line.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-rung-quiet-")));
  try {
    const worktreesRoot = join(root, "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    const entry = join(worktreesRoot, "run-W1-T903-fresh");
    mkdirSync(join(entry, "src"), { recursive: true });
    writeFileSync(join(entry, "src", "a.ts"), "fresh\n");
    touchNow(join(entry, "src", "a.ts"));
    const rows: string[] = [];
    runWorktreeReapRung({ root, claudeBin: "/bin/true" } as Config, (s) => rows.push(s));
    assert.equal(rows.includes("worktree.reap.undecidable"), false, "a recent-activity keep is silent");
    assert.equal(rows.includes("worktree.reaped"), false, "and nothing was reaped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── newestActivityMs ITSELF ───────────────────────────────────────────────────────────────────

test("the ROOT's own mtime is the FLOOR — an empty, freshly-created dir is not maximally ancient", () => {
  // The create-before-lock race: `git worktree add` caught mid-flight, or a lockless sweep-* dir
  // whose lock is a SIBLING outside it. A zero floor here reaps exactly that. Measured while
  // writing this: it broke prune-liveness's own "PROTECTS ... within the age gate" test.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-activity-empty-")));
  touchNow(root);
  try {
    const probe = newestActivityMs(root);
    assert.equal(probe.complete, true);
    assertWallClockBound((Date.now() - probe.mtimeMs) / MIN, 1, "an empty new dir reports its OWN mtime, not 0");
    assert.equal(probe.mtimeMs, statSync(root).mtimeMs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`.git` and `node_modules` are never descended into — their churn is not the worker's", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-activity-skip-")));
  try {
    const past = ago(120);
    for (const d of [".git", "node_modules"]) {
      mkdirSync(join(root, d, "deep"), { recursive: true });
      writeFileSync(join(root, d, "deep", "fresh.txt"), "now\n"); // FRESH, and must be ignored
      touchNow(join(root, d, "deep", "fresh.txt"));
    }
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "old.ts"), "stale\n");
    for (const p of [join(root, "src", "old.ts"), join(root, "src"), join(root, ".git"), join(root, "node_modules"), root]) {
      utimesSync(p, past, past);
    }

    const probe = newestActivityMs(root);
    assert.equal(probe.complete, true);
    assert.ok((Date.now() - probe.mtimeMs) / MIN > 60, "the fresh files inside the skipped dirs did not count");

    // PAIRED POSITIVE CONTROL: the same tree with an EMPTY skip set does see them. Without this,
    // the assertion above passes on a walk that finds nothing at all.
    const unskipped = newestActivityMs(root, { skipDirs: new Set() });
    assertWallClockBound((Date.now() - unskipped.mtimeMs) / MIN, 1, "so the skip list is what excluded them");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symlinks are never followed — node_modules alone would walk out of the worktree", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-activity-symlink-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "rmd-activity-outside-")));
  try {
    writeFileSync(join(outside, "fresh.txt"), "now\n"); // fresh, outside the tree
    const past = ago(120);
    symlinkSync(outside, join(root, "node_modules_link"));
    utimesSync(root, past, past);

    const probe = newestActivityMs(root);
    assert.equal(probe.complete, true);
    assert.ok((Date.now() - probe.mtimeMs) / MIN > 60, "a symlink's target never counts as activity here");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("hitting the entry cap reports complete:false — a PARTIAL max must never read as 'old enough'", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-activity-cap-")));
  try {
    for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.txt`), "x\n");
    const probe = newestActivityMs(root, { entryCap: 2 });
    assert.equal(probe.complete, false, "a truncated walk is UNKNOWN, not an answer");
    // And the reaper turns that into a keep rather than a reap.
    assert.ok(ACTIVITY_WALK_ENTRY_CAP > 2, "the shipped cap is far above this fixture's");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a single unstatable ENTRY is skipped without failing the whole walk — the per-entry catch arm", () => {
  // FORCED DETERMINISTICALLY, not raced: a directory with read but NOT execute permission (0o600)
  // lists fine and every stat of its children fails EACCES — verified on this platform before
  // writing the test. That is the shape the per-entry catch exists for (in the wild: an entry
  // removed between the readdir and the stat), and without this the arm never runs.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-activity-entrycatch-")));
  const blind = join(root, "blind");
  try {
    mkdirSync(blind, { recursive: true });
    writeFileSync(join(blind, "f.txt"), "x\n");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "x\n"); // statable, and RECENT
    touchNow(join(root, "src", "a.ts"));
    chmodSync(blind, 0o600);

    const probe = newestActivityMs(root);
    // The walk COMPLETED — one unstatable entry is not an unreadable tree — and still found the
    // activity in the statable half.
    assert.equal(probe.complete, true, "a single unstatable entry must not poison the whole probe");
    assertWallClockBound((Date.now() - probe.mtimeMs) / MIN, 1, "and the readable half's fresh file still counted");
  } finally {
    try {
      chmodSync(blind, 0o755);
    } catch {
      /* best effort */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a VANISHED directory is complete:true at age 0 — gone is not unreadable, so it stays reapable", () => {
  // Distinguishing ENOENT from EACCES is load-bearing: without it, a dir removed mid-pass by its
  // own registration lookup becomes permanently "undecidable" and the reaper can never finish with
  // it. Measured while writing this — it broke prune-liveness's mid-pass-vanish test.
  const probe = newestActivityMs(join(tmpdir(), "rmd-does-not-exist-9e7f3a1c"));
  assert.deepEqual(probe, { mtimeMs: 0, complete: true });
});

// ── THE CEILING IS THE REAPER'S OWN, AND IT IS THE MEASURED ONE ───────────────────────────────

test("the reaper's default ceiling is its OWN dial, 30 min, and agrees with the console's liveness bound", () => {
  assert.equal(DEFAULT_WORKTREE_REAP_GRACE_MS, 30 * MIN, "measured at p99 of intra-run ledger gaps (29.7 min)");
  assert.notEqual(
    DEFAULT_WORKTREE_REAP_GRACE_MS,
    DEFAULT_PRUNE_GRACE_MS,
    "and it is NOT pruneGraceMs — six run-start pruneStaleRuns call sites still consume that one",
  );
  assert.equal(
    DEFAULT_WORKTREE_REAP_GRACE_MS,
    DEFAULT_LIVENESS_BOUND_MS,
    "the reaper and deriveStatus must not hold private opinions about when a quiet run stops being live",
  );
});

test("an entry inside the ceiling is kept even with no lock and a dead branch", () => {
  const f = fixture("run-W1-T904-young");
  try {
    const past = ago(5); // well inside 30 min, well outside the old 2
    const deep = join(f.entry, "src", "lib", "a.ts");
    writeFileSync(deep, "x\n");
    for (const p of [deep, join(f.entry, "src", "lib"), join(f.entry, "src"), f.entry]) utimesSync(p, past, past);
    const s = reapStaleWorktrees(f.root, { isPidAlive: () => false, branchIsLiveUpstream: () => false });
    assert.deepEqual(s.reaped, []);
    assert.deepEqual(s.keptReasons, [{ name: f.entryName, reason: "recent-activity" }]);
  } finally {
    f.cleanup();
  }
});

test("REGRESSION LOCK: an unreadable worktrees ROOT still returns an empty summary rather than throwing", () => {
  // The `readdirSync(root)` catch — an early return this diff now has to carry `keptReasons` on.
  // Its contract is unchanged: best-effort, never throws, nothing claimed either way.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-blindroot-")));
  try {
    chmodSync(root, 0o000);
    const s = reapStaleWorktrees(root);
    assert.deepEqual(s, { reaped: [], reapedLocks: [], kept: [], keptReasons: [] });
  } finally {
    try {
      chmodSync(root, 0o755);
    } catch {
      /* best effort */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("keptReasons always pairs 1:1 with kept, across a mixed pass", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-reap-mixed-")));
  try {
    const mk = (name: string, mins: number) => {
      const p = join(root, name);
      mkdirSync(join(p, "src"), { recursive: true });
      const f = join(p, "src", "a.ts");
      writeFileSync(f, "x\n");
      const past = ago(mins);
      for (const q of [f, join(p, "src"), p]) utimesSync(q, past, past);
      return p;
    };
    mk("run-A-1", 5); // kept: recent activity
    mk("run-B-2", 120); // reaped: debris
    const live = mk("run-C-3", 120);
    writeRunLock(live, { pid: process.pid, run_id: "C", startedAt: "2026-07-20T00:00:00Z" }); // kept: live pid

    const s = reapStaleWorktrees(root, { branchIsLiveUpstream: () => false });

    assert.deepEqual(s.reaped, ["run-B-2"]);
    assert.deepEqual(s.kept.sort(), ["run-A-1", "run-C-3"]);
    assert.equal(s.keptReasons?.length, s.kept.length, "one reason per kept entry, never a mismatched pair");
    assert.deepEqual(
      (s.keptReasons ?? []).map((k) => [k.name, k.reason]).sort(),
      [["run-A-1", "recent-activity"], ["run-C-3", "live-pid"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
