import assert from "node:assert/strict";
// The DEFAULT export -- a plain, mutable object -- so `t.mock.method` can actually
// intercept the calls `saveMarker`/`loadMarker` make: named bindings off `node:fs` are
// non-configurable and mock.method/defineProperty against them throws "Cannot redefine
// property" instead of installing a spy. See the identical import comment atop
// src/lib/status.ts (W1-T207) and src/lib/retro.ts's own marker section -- this file
// intercepts the REAL fs.writeFileSync/fs.renameSync calls saveMarker makes, never a
// reimplementation.
import fsDefault from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildGather,
  evaluateRetroTrigger,
  loadMarker,
  MarkerCorruptError,
  resolveMarkerForGather,
  saveMarker,
  type RetroMarker,
  type RetroTriggerDecision,
} from "../src/lib/retro.js";
import { configPath } from "../src/lib/config.js";
import { resolveRepoRoot, retroCommand } from "../src/run-task.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { offlineGithub } from "./setup/offline-github.js";
import { withHealthyRetroProbeGh } from "./helpers/w4226-g1-retro-probe-gh.js";

/**
 * ONE offline gateway for every `retroCommand` call in this file — 24 of them, each of which used
 * to run `projectPlan` TWICE over 439 task records with the per-task `ghGateway`, one
 * `gh pr list --search` per task. Nothing in this file asserts merge state: every assertion here is
 * about marker atomicity, the integrity gate, the plan-only guard, or a degradation path. Shared
 * rather than per-test so `calls` accumulates across the file and one assertion can prove the
 * production path consulted it — see the `offlineGh was consulted` test at the end.
 */
const offlineGh = offlineGithub();

// run-task.ts's own module-level `repoRoot` is `resolveRepoRoot(process.argv.slice(2),
// process.cwd())` (W1-T120: CWD-ascent via a REAL `git rev-parse --show-toplevel`, not
// `process.cwd()` itself and not the install path -- see test/repo-root-identity.test.ts).
// Under a plain `node --test` invocation from the repo root those two happen to be equal,
// but they DIVERGE inside Stryker's mutation-testing sandbox (`.stryker-tmp/sandbox-*` has
// no `.git` of its own, so git's ascent walks UP to the REAL checkout's toplevel, not the
// sandbox copy) -- so any fixture below that assumed `process.cwd() === repoRoot` silently
// mocked a path retroCommand never actually reads there, self-defeating the whole test.
// Resolving it the SAME way production does keeps the fixture correct in both places.
const REPO_ROOT_FOR_FIXTURES = resolveRepoRoot(process.argv.slice(2), process.cwd());

// ── W1-T242: state/last-retro.json ATOMICITY + corrupt-vs-absent marker handling ──
//
// Pre-fix: saveMarker used a plain `writeFileSync(markerPath, ...)` (a truncate-then-fill
// a concurrent reader could observe mid-flight), AND loadMarker collapsed EVERY parse
// failure -- including a torn read of that truncated file -- to `undefined`, the exact
// same value it returns for a genuinely absent marker. A torn read was therefore
// indistinguishable from "no marker has ever been written", so the retro gather widened
// `sinceTs` to `undefined` and reprocessed the ENTIRE already-consumed run window,
// double-counting SHIPPED/learnings.
//
// The fix (src/lib/retro.ts):
//   - saveMarker stages to a same-directory temp file and `renameSync`s it into place
//     (atomic on any POSIX filesystem) -- a reader only ever sees the whole old file or
//     the whole new one, never a torn write.
//   - loadMarker now throws MarkerCorruptError for a present-but-unparseable file,
//     reserving a plain `undefined` return EXCLUSIVELY for the genuinely-absent (ENOENT)
//     case.
//   - resolveMarkerForGather turns that into a discriminated union ("absent" | "corrupt"
//     | "ok") a caller cannot silently collapse back into "no marker" without an
//     explicit, separate branch.
//
// These three tests mirror test/ledger-atomic.test.ts and test/status-atomic-write.test.ts's
// precedent: one dedicated file per atomic-write surface, with a FALSIFIER a reverted fix
// cannot pass (not just an assertion that the happy path works).

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-retro-marker-atomic-"));
}

test(
  "claim 1: a reader interleaved with the marker writer never observes a partial " +
    "last-retro.json -- FALSIFIER: reverting saveMarker to a plain writeFileSync makes this fail",
  (t) => {
    const dir = tmpDir();
    const markerPath = join(dir, "last-retro.json");

    const before: RetroMarker = { ts: "2026-07-18T00:00:00.000Z", learnings_count: 1, runs_seen: 2 };
    const after: RetroMarker = { ts: "2026-07-19T00:00:00.000Z", learnings_count: 3, runs_seen: 4 };

    // Seed a known-good on-disk marker with a real, un-mocked write.
    saveMarker(markerPath, before);
    const beforeRaw = fsDefault.readFileSync(markerPath, "utf8");
    assert.deepEqual(JSON.parse(beforeRaw), before);

    const realWriteFileSync = fsDefault.writeFileSync.bind(fsDefault);
    const realRenameSync = fsDefault.renameSync.bind(fsDefault);
    const realReadFileSync = fsDefault.readFileSync.bind(fsDefault);
    const realExistsSync = fsDefault.existsSync.bind(fsDefault);

    const observations: Array<{ label: string; raw: string | undefined; loaded: RetroMarker | undefined }> = [];
    let probeArmed = true; // guards against the probe's own (nested) fs calls re-firing itself

    // Fires at the EXACT instant a torn write would be visible to a concurrent reader:
    // right when something is about to write markerPath directly (the pre-fix shape) OR
    // right before the atomic rename swap (the fixed shape). Content-addressed on the
    // WRITE TARGET, not a timer/sleep, so it is deterministic. Both the raw bytes AND the
    // "concurrent reader" (a real loadMarker call) are captured RIGHT HERE, at fire time —
    // not deferred to after the write completes, which would observe the finished state.
    function probe(label: string) {
      if (!probeArmed) return;
      probeArmed = false;
      const raw = realExistsSync(markerPath) ? realReadFileSync(markerPath, "utf8") : undefined;
      const loaded = loadMarker(markerPath);
      observations.push({ label, raw, loaded });
      probeArmed = true;
    }

    t.mock.method(fsDefault, "writeFileSync", (target: unknown, content: unknown, ...rest: unknown[]) => {
      if (target === markerPath) {
        // Reproduce a plain truncating writeFileSync's observable two-phase window (the
        // pre-fix shape): the file is emptied before the payload lands.
        realWriteFileSync(markerPath, "");
        probe("direct writeFileSync(markerPath) -- post-truncate, pre-fill");
        return realWriteFileSync(target as string, content as string, ...(rest as []));
      }
      return realWriteFileSync(target as string, content as string, ...(rest as []));
    });
    t.mock.method(fsDefault, "renameSync", (from: unknown, to: unknown) => {
      if (to === markerPath) {
        probe("renameSync(tmp, markerPath) -- pre-swap, old marker still intact");
      }
      return realRenameSync(from as string, to as string);
    });

    saveMarker(markerPath, after);

    assert.ok(observations.length > 0, "sanity: the interleave probe must actually have fired at least once");

    for (const obs of observations) {
      assert.ok(obs.raw !== undefined, `${obs.label}: markerPath must already exist (seeded above)`);
      assert.ok(obs.raw!.length > 0, `${obs.label}: reader observed a ZERO-LENGTH last-retro.json`);
      assert.doesNotThrow(() => JSON.parse(obs.raw!), `${obs.label}: reader observed unparseable (torn) JSON`);
      assert.equal(
        obs.raw,
        beforeRaw,
        `${obs.label}: reader observed something other than the complete, untouched OLD marker`,
      );
      // loadMarker itself must never throw or misreport for what a concurrent reader saw,
      // captured live at probe time (see the probe() doc above).
      assert.deepEqual(obs.loaded, before, `${obs.label}: loadMarker misread the interleaved state`);
    }

    // The write itself still lands correctly once the swap completes.
    assert.deepEqual(loadMarker(markerPath), after);
  },
);

test(
  "claim 2: an unparseable marker is reported DISTINCTLY from an absent one, and never " +
    "resolves to the 'first-ever-retro' state that would reprocess an already-consumed window",
  () => {
    const dir = tmpDir();
    const corruptPath = join(dir, "corrupt-last-retro.json");
    const absentPath = join(dir, "does-not-exist-last-retro.json");

    // A torn write: truncated mid-object, exactly what a pre-fix crash/race could leave.
    fsDefault.writeFileSync(corruptPath, '{ "ts": "2026-07-18T00:00:00.000Z", "learnings_count": 12, "run');

    // loadMarker: corrupt throws a NAMED, distinct error -- never silently `undefined`
    // (the pre-fix bug: `catch { return undefined; }` made this indistinguishable from
    // "no marker").
    assert.throws(() => loadMarker(corruptPath), (e: unknown) => e instanceof MarkerCorruptError);
    // loadMarker: genuinely absent is the ONLY case that still returns `undefined`.
    assert.equal(loadMarker(absentPath), undefined);

    // resolveMarkerForGather: the two states are structurally DISTINCT kinds -- a caller
    // cannot accidentally treat "corrupt" as "absent" without an explicit, separate branch
    // (unlike the pre-fix `marker?.ts` pattern, where both states silently produced the
    // same `undefined` and therefore the same full-history sinceTs).
    const corruptResolution = resolveMarkerForGather(corruptPath);
    const absentResolution = resolveMarkerForGather(absentPath);
    assert.equal(corruptResolution.kind, "corrupt");
    assert.equal(absentResolution.kind, "absent");
    assert.notEqual(corruptResolution.kind, absentResolution.kind);

    if (corruptResolution.kind === "corrupt") {
      assert.ok(corruptResolution.error instanceof MarkerCorruptError);
      assert.match(corruptResolution.error.message, /not parseable JSON/);
      // The message itself names the exact hazard this task fixes -- a human reading
      // `rmd retro`'s failure output (or the ledger's retro.marker.corrupt line) is told
      // WHY it refused to proceed, not left to guess.
      assert.match(corruptResolution.error.message, /refusing to treat a corrupt marker as first-ever-retro/);
      assert.match(corruptResolution.error.message, /double-count SHIPPED\/learnings/);
    }

    // The "ok" kind is reachable too, and carries the real marker through untouched --
    // sanity that the discriminated union isn't just a two-state stub.
    const okPath = join(dir, "ok-last-retro.json");
    const okMarker: RetroMarker = { ts: "2026-07-20T00:00:00.000Z", learnings_count: 5, runs_seen: 9 };
    saveMarker(okPath, okMarker);
    const okResolution = resolveMarkerForGather(okPath);
    assert.equal(okResolution.kind, "ok");
    if (okResolution.kind === "ok") assert.deepEqual(okResolution.marker, okMarker);
  },
);

test("resolveMarkerForGather: a NON-MarkerCorruptError failure (e.g. a permissions error, not a parse failure) is rethrown, never silently reclassified", (t) => {
  const dir = tmpDir();
  const markerPath = join(dir, "last-retro.json");
  const realReadFileSync = fsDefault.readFileSync.bind(fsDefault);
  const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  t.mock.method(fsDefault, "readFileSync", (target: unknown, ...rest: unknown[]) => {
    if (target === markerPath) throw eacces;
    return realReadFileSync(target as string, ...(rest as []));
  });
  assert.throws(() => resolveMarkerForGather(markerPath), (e: unknown) => e === eacces);
});

test("MarkerCorruptError: a non-Error cause (never actually thrown by JSON.parse, but the constructor must not assume one) still produces a readable message", () => {
  // loadMarker's real catch always hands MarkerCorruptError a genuine SyntaxError (which
  // has a .message), so this constructor's `(cause as Error)?.message ?? cause` fallback
  // is unreachable through loadMarker itself -- exercised directly here instead.
  const err = new MarkerCorruptError("/fixture/path/last-retro.json", "a raw string cause, not an Error instance");
  assert.match(err.message, /a raw string cause, not an Error instance/);
  assert.match(err.message, /\/fixture\/path\/last-retro\.json/);
  assert.equal(err.markerPath, "/fixture/path/last-retro.json");
});

test(
  "claim 3: the genuine first-ever-retro path (marker truly absent) is unchanged -- " +
    "resolves to 'absent' with no error payload, and buildGather still scopes to the FULL run history",
  () => {
    const dir = tmpDir();
    const neverWrittenPath = join(dir, "last-retro.json"); // never created in this dir

    assert.equal(loadMarker(neverWrittenPath), undefined, "no MarkerCorruptError for a plain ENOENT");
    const resolution = resolveMarkerForGather(neverWrittenPath);
    assert.deepEqual(resolution, { kind: "absent" }, "absent carries no extra payload -- exactly the pre-fix shape callers already expect");

    // End-to-end: this is what retroCommand actually derives sinceTs from. An "absent"
    // marker must still widen the gather to the whole ledger (the real, LEGITIMATE
    // first-ever-retro case this task must not break while fixing the corrupt-marker one).
    const marker = resolution.kind === "ok" ? resolution.marker : undefined;
    const ledgerNdjson = [
      JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", run_id: "R1", task_id: "W1-T1", step: "run.start" }),
      JSON.stringify({ ts: "2020-01-01T00:05:00.000Z", run_id: "R1", task_id: "W1-T1", step: "run.end", verdict: "merged" }),
    ].join("\n");
    const gather = buildGather({ ledgerNdjson, learningsMd: "# L\n", sinceTs: marker?.ts, learningsAtMarker: marker?.learnings_count });
    assert.equal(gather.sinceTs, undefined, "no scoping -- the ancient run from 2020 is still in scope");
    assert.equal(gather.totalRuns, 1, "the pre-marker run is included, exactly like the pre-fix 'no marker' behavior");
  },
);

test(
  "claim 4: saveMarker refuses a short write staging the temp file -- FALSIFIER: a writeSync that " +
    "returns fewer bytes than the payload must throw rather than renameSync a truncated temp file into place",
  (t) => {
    const dir = tmpDir();
    const markerPath = join(dir, "last-retro.json");
    const marker: RetroMarker = { ts: "2026-07-22T00:00:00.000Z", learnings_count: 7, runs_seen: 8 };

    const realWriteSync = fsDefault.writeSync.bind(fsDefault);
    t.mock.method(fsDefault, "writeSync", (fd: number, buf: Uint8Array, offset: number, length: number, ...rest: unknown[]) => {
      // Report one byte short of what was actually asked for -- the exact short-write
      // shape saveMarker's own guard exists to catch (a real fs.writeSync CAN legally
      // write fewer bytes than requested; saveMarker must not treat that as success).
      return realWriteSync(fd, buf, offset, length - 1, ...(rest as []));
    });

    assert.throws(
      () => saveMarker(markerPath, marker),
      /short write staging/,
      "a short writeSync must throw, not silently rename a truncated temp file into place",
    );
    assert.ok(!fsDefault.existsSync(markerPath), "the truncated temp file must never be renamed into the real marker path");
  },
);

// ── W1-T242 round 2: retroCommand ITSELF fails closed on a corrupt marker ──────────
//
// The tests above exercise resolveMarkerForGather/saveMarker in isolation. This one drives
// the REAL `retroCommand` (src/run-task.ts) end to end for the corrupt-marker branch: it is
// the earliest possible return in the function (before resolveOwnerRepo/any git or gh call),
// so it is reachable with nothing but a redirected HOME (for loadConfig's
// ~/.config/remudero/config.json) and a corrupt state/last-retro.json -- no worker spawn, no
// network, no real repo needed. Mirrors test/config.test.ts's HOME-override precedent for
// exercising loadConfig's EEXIST/read path without a `which claude` shell-out (a
// pre-populated claudeBin skips resolveClaudeBin entirely).
test("retroCommand: a corrupt state/last-retro.json fails CLOSED (exit 1, ledgered), never silently replays as first-ever-retro", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-command-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-command-root-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "last-retro.json"), '{ "ts": "2026-07-21T00:00:00.000Z", "learnings_count": 4, "run');
  // A pre-existing ledger (retroCommand reads it BEFORE the marker check, regardless of
  // outcome) -- exercises the `existsSync(ledgerPath) ? readFileSync(...) : ""` ternary's
  // true side too, not just the "no ledger yet" default every other retroCommand test hits.
  writeFileSync(
    join(root, "state", "ledger.ndjson"),
    JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", run_id: "R0", task_id: "W1-T0", step: "run.start" }) + "\n",
  );

  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome; // configPath()/loadConfig() are HOME-relative
  const cfgPath = configPath();
  mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
  // claudeBin PRE-POPULATED so loadConfig's read path never calls resolveClaudeBin
  // (which shells `which claude` -- absent/wrong in CI, see LEARNINGS.md).
  writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT_FOR_FIXTURES }, null, 2) + "\n");

  const errorSpy = t.mock.method(console, "error", () => {});
  const logSpy = t.mock.method(console, "log", () => {});
  try {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { github: offlineGh }));
    assert.equal(exitCode, 1, "a corrupt marker must fail retroCommand CLOSED, not proceed to gather/spawn");
    assert.ok(
      errorSpy.mock.calls.some((c) => String(c.arguments[0]).includes("refusing to treat a corrupt marker as first-ever-retro")),
      "the operator-facing error must name the exact hazard this task fixes",
    );
    const ledgerLines = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const corruptEntry = ledgerLines.find((l) => l.step === "retro.marker.corrupt");
    assert.ok(corruptEntry, "retro.marker.corrupt must be ledgered so a human/daemon sees WHY the retro refused");
    assert.equal(corruptEntry.task_id, "RETRO");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    void logSpy;
  }
});

// A cheap, standalone `--dry-run` pass: builds the SAME gather the success-path test below
// drives all the way through a real PR, but exits right after printing the report -- no
// worktree, no gh, no spawn. Kept here (not folded into the corrupt-marker test above)
// because it needs an ABSENT marker (genuine first-ever-retro), the opposite precondition
// from the corrupt-marker test.
test("retroCommand: --dry-run builds the gather and returns 0 without ever touching a worker", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-dryrun-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-dryrun-root-"));

  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const cfgPath = configPath();
  mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT_FOR_FIXTURES }, null, 2) + "\n");

  const logSpy = t.mock.method(console, "log", () => {});
  try {
    // W1-T4226: the gather's throttle probe reads a scripted, healthy `gh`, never the refused real one.
    const exitCode = await withHealthyRetroProbeGh(() => withLiveWritesAllowed(() => retroCommand(["--dry-run"], { github: offlineGh })));
    assert.equal(exitCode, 0, "--dry-run never fails a genuinely-first-ever retro");
    assert.ok(
      logSpy.mock.calls.some((c) => String(c.arguments[0]).includes("Retro gather")),
      "--dry-run must print the deterministic gather report",
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

// ── W1-T105: the follow-up harvest's dedup source (openTaskTitles/openProposalLines,
// retroCommand, design (iv)) degrades BEST-EFFORT on a read hiccup — via
// `tryReadFollowupTitles`'s own catch — rather than aborting the whole retro. Driven
// through the REAL `retroCommand`'s `--dry-run` path (cheap: no worktree/gh/spawn, exits
// right after building the gather) with `fsDefault.readFileSync` mocked ONLY for the two
// exact repoRoot-relative paths this dedup read touches — every other read (ledger,
// LEARNINGS.md, mast-mapping.yaml, ...) falls through to the real fs, unmocked.
//
// run-task.ts reads via a PLAIN named `import { readFileSync } from "node:fs"` (unlike
// lib/retro.ts's own `fsMarker.*` indirection, adopted specifically so tests CAN mock
// it) — Node bakes a core module's named ESM exports in at FIRST IMPORT TIME, so
// reassigning `fsDefault.readFileSync` alone is invisible to that already-bound
// binding (see test/setup/tmp-hygiene.ts's identical finding for `mkdtempSync`).
// `syncBuiltinESMExports()` — Node's own documented fix — re-propagates the mock (and,
// in the `finally`, the restored original) to every such binding.

test("retroCommand: a follow-up dedup 'tasks' read that THROWS degrades to an empty dedup source and is NAMED in the console error — the retro itself still succeeds", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-followup-tasks-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-followup-tasks-root-"));
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const cfgPath = configPath();
  mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT_FOR_FIXTURES }, null, 2) + "\n");

  // repoRoot's real plan/tasks.yaml exists (existsSync is untouched, real) — only ITS
  // OWN readFileSync (loadPlan's own read) is forced to throw; every other target path
  // (ledger/LEARNINGS/mast-mapping/MASTER-PLAN.md) passes through to the real fs.
  const tasksYamlPath = join(REPO_ROOT_FOR_FIXTURES, "plan", "tasks.yaml");
  const realReadFileSync = fsDefault.readFileSync.bind(fsDefault);
  const forcedError = new Error("fixture: forced plan/tasks.yaml read failure");
  const readSpy = t.mock.method(fsDefault, "readFileSync", (target: unknown, ...rest: unknown[]) => {
    if (target === tasksYamlPath) throw forcedError;
    return realReadFileSync(target as string, ...(rest as []));
  });
  syncBuiltinESMExports();
  const errSpy = t.mock.method(console, "error", () => {});
  const logSpy = t.mock.method(console, "log", () => {});

  try {
    // W1-T4226: the gather's throttle probe reads a scripted, healthy `gh`, never the refused real one.
    const exitCode = await withHealthyRetroProbeGh(() => withLiveWritesAllowed(() => retroCommand(["--dry-run"], { github: offlineGh })));
    assert.equal(exitCode, 0, "a dedup-source read hiccup must never abort the retro (best-effort, W1-T105 design)");
    assert.ok(
      errSpy.mock.calls.some(
        (c) => String(c.arguments[0]).includes("followups.open_titles.tasks") && String(c.arguments[0]).includes(forcedError.message),
      ),
      "the throw is NAMED (which source, and why) in the console error, never a silent swallow",
    );
    void logSpy;
  } finally {
    readSpy.mock.restore();
    syncBuiltinESMExports(); // propagate the restored REAL readFileSync back to run-task.ts's baked-in binding
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("retroCommand: a non-trivial MASTER-PLAN.md yielding ZERO proposal-bullet matches DEGRADES LOUDLY (format-drift signal) rather than silently reporting 'no open proposals'", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-followup-proposals-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-followup-proposals-root-"));
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const cfgPath = configPath();
  mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT_FOR_FIXTURES }, null, 2) + "\n");

  const masterPlanPath = join(REPO_ROOT_FOR_FIXTURES, "MASTER-PLAN.md");
  const realReadFileSync = fsDefault.readFileSync.bind(fsDefault);
  // Non-trivial (> 500 chars, the guard's own threshold) but carries NO line matching
  // the proposal-bullet regex (`^- P\d+...`) — the format-drift shape, not a genuinely
  // proposal-free plan.
  const noProposalBulletsMd = `# MASTER-PLAN\n\n${"prose with no bullet-list proposals whatsoever. ".repeat(20)}\n`;
  const readSpy = t.mock.method(fsDefault, "readFileSync", (target: unknown, ...rest: unknown[]) => {
    if (target === masterPlanPath) return noProposalBulletsMd;
    return realReadFileSync(target as string, ...(rest as []));
  });
  syncBuiltinESMExports();
  const errSpy = t.mock.method(console, "error", () => {});
  const logSpy = t.mock.method(console, "log", () => {});

  try {
    assert.ok(noProposalBulletsMd.length > 500, "sanity: the fixture must clear the guard's own non-trivial threshold");
    // W1-T4226: the gather's throttle probe reads a scripted, healthy `gh`, never the refused real one.
    const exitCode = await withHealthyRetroProbeGh(() => withLiveWritesAllowed(() => retroCommand(["--dry-run"], { github: offlineGh })));
    assert.equal(exitCode, 0, "a format-drift dedup source must never abort the retro");
    assert.ok(
      errSpy.mock.calls.some((c) => String(c.arguments[0]).includes("followups.open_titles.proposals") && String(c.arguments[0]).includes("format drift")),
      "zero proposal-bullet matches against a non-trivial MASTER-PLAN.md must be NAMED, never silently read as 'no open proposals'",
    );
    void logSpy;
  } finally {
    readSpy.mock.restore();
    syncBuiltinESMExports(); // propagate the restored REAL readFileSync back to run-task.ts's baked-in binding
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

