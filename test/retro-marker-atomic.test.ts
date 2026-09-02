import assert from "node:assert/strict";
// The DEFAULT export -- a plain, mutable object -- so `t.mock.method` can actually
// intercept the calls `saveMarker`/`loadMarker` make: named bindings off `node:fs` are
// non-configurable and mock.method/defineProperty against them throws "Cannot redefine
// property" instead of installing a spy. See the identical import comment atop
// src/lib/status.ts (W1-T207) and src/lib/retro.ts's own marker section -- this file
// intercepts the REAL fs.writeFileSync/fs.renameSync calls saveMarker makes, never a
// reimplementation.
import fsDefault from "node:fs";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
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
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { offlineGithub } from "./setup/offline-github.js";
import type { RunRetroPrepublishPreflightOptions, RetroPrepublishResult } from "../src/lib/retro-preflight.js";

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
  writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");

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
  writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");

  const logSpy = t.mock.method(console, "log", () => {});
  try {
    const exitCode = await withLiveWritesAllowed(() => retroCommand(["--dry-run"], { github: offlineGh }));
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
  writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");

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
    const exitCode = await withLiveWritesAllowed(() => retroCommand(["--dry-run"], { github: offlineGh }));
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
  writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");

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
    const exitCode = await withLiveWritesAllowed(() => retroCommand(["--dry-run"], { github: offlineGh }));
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

// ── W1-T242 round 2: retroCommand's SUCCESS path reaches the atomic marker-advance ──
//
// The corrupt-marker test above proves the fail-closed branch. The tests below prove the
// OTHER half stays correct: a clean retro run still reaches `saveMarker` at the tail of the
// real success path -- the exact call site round 1 made atomic -- and actually lands a real,
// valid marker on disk. Every git/gh boundary is a REAL local git repo or a PATH-shimmed `gh`
// script (never a reimplementation of retroCommand's own logic); only the Architect spawn
// itself is injected (retroCommand's `opts.spawn`, mirroring runTask's existing
// `opts.spawn` DI). `setupFakeRetroFixture` is the shared scaffolding three variant tests
// below drive through DIFFERENT branches of the same success path (a valid PRE-EXISTING
// marker; an ownership mismatch; a diff that touches code) without re-authoring the whole
// fixture per branch.
interface FakeRetroFixture {
  root: string;
  branch: string;
  fakeSpawn: (args?: SpawnWorkerArgs) => Promise<WorkerResult>;
  spawnArgs: SpawnWorkerArgs[];
  prepublishPreflight: (opts: RunRetroPrepublishPreflightOptions) => Promise<RetroPrepublishResult>;
  /** Swaps HOME/PATH/Date.now in, runs `body`, and ALWAYS restores them after -- even on throw. */
  run<T>(body: () => Promise<T>): Promise<T>;
}

function setupFakeRetroFixture(
  t: TestContext,
  opts: {
    /** Seed a valid marker BEFORE the run (exercises the "ok" marker-resolution branch). */
    seedMarker?: RetroMarker;
    /** `gh pr view --json headRefName` response -- default is this run's OWN branch. */
    headRefName?: (branch: string) => string;
    /** `gh pr diff` response -- default is an empty (plan-only) diff. */
    diff?: string;
    /** `gh pr diff` EXITS NON-ZERO instead of returning a diff -- a transient `gh` failure
     *  partway through the success path, exercising retroCommand's outer catch. */
    diffFails?: boolean;
    /** `gh pr view --json body` response -- default already carries the trailer AND a
     *  valid Acceptance block so neither repair path fires. */
    body?: string;
    /** The Architect's fabricated REPORT carries NO `PR_URL:` line -- forces the REST
     *  create fallback path (`gh api --method POST repos/.../pulls`, W1-T1202; our fake
     *  `gh` answers it with a fresh `html_url`). */
    noPrUrl?: boolean;
    /** The worker omitted PR_URL even though this exact run branch already has an open PR.
     *  The harness must recover and reuse it, never create a replacement. */
    existingPrWithoutReport?: boolean;
    /** `gh pr view --json headRefName` returns no `headRefName` at all (an UNRESOLVED
     *  head ref, distinct from a resolved-but-wrong one) -- checkPrOwnership's `?? null`
     *  fallback. */
    unresolvedHeadRef?: boolean;
    /** Omit MASTER-PLAN.md from the fixture repo -- regenerateOrientation throws (ENOENT),
     *  exercising its best-effort catch. */
    missingMasterPlan?: boolean;
    /** Copy the REAL scripts/generate-plan-index.mjs into the fixture repo and let
     *  regeneratePlanIndexAndCommit actually run it. Default false (absent): every
     *  invocation spawns a REAL node subprocess whose OWN coverage gets tallied under
     *  a fresh, unmerged random-tmp-path SF: record each time (a coverage-ratchet
     *  measurement artifact, not a real regression) -- only the variants that
     *  specifically need to prove the real regen path opt in. */
    includeGeneratorScript?: boolean;
    /** Seed a malformed plan/tasks.yaml -- loadPlan throws inside the best-effort
     *  "next runnable task" lookup, exercising ITS catch. */
    badPlan?: boolean;
    /** `gh pr view --json body` returns NO `body` field at all (as opposed to an empty
     *  string) -- the `view.body ?? ""` fallback, both in ensureTaskTrailer and the
     *  acceptance-repair pass. */
    omitBody?: boolean;
    /** repoDir is NOT pre-cloned -- retroCommand's own `gh repo clone` fires (our fake
     *  `gh` performs a REAL local clone of the same origin, never a stub). */
    missingRepoDir?: boolean;
    /** `gh pr edit` (the acceptance-repair pass's own repair write-back) fails -- its
     *  OWN best-effort catch, distinct from the outer catch `diffFails` exercises. */
    repairEditFails?: boolean;
    /** Pre-register a REAL, lockless `run-*` git worktree well past pruneStaleRuns'
     *  grace window -- exercises its force-remove branch (`pruned.worktrees.length`). */
    staleWorktree?: boolean;
    /** Terminal prepublish result used to prove marker/review/arm atomicity. Default passes. */
    preflightResult?: RetroPrepublishResult;
    /** Drive the production repair callback once before returning a passing second attempt. */
    preflightExercisesRepair?: boolean;
  } = {},
): FakeRetroFixture {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-success-home-"));
  // realpathSync: macOS's tmpdir() is a symlink (/var -> /private/var); `git worktree
  // list --porcelain` reports the RESOLVED path, so a prefix check against the
  // unresolved one (pruneStaleRuns' `curPath.startsWith(worktreesRoot)`) would never
  // match and silently skip every worktree under it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-retro-success-root-")));
  // `staleWorktree` mocks Date.now WELL INTO THE FUTURE relative to the real wall clock
  // (rather than a fixed 2026-07-14-ish constant) so pruneStaleRuns' `now() - mtimeMs`
  // age check -- which reads the SAME mocked Date.now -- sees the worktree this fixture
  // creates at REAL "now" (below) as comfortably past DEFAULT_PRUNE_GRACE_MS (120s).
  const FIXED_TS = opts.staleWorktree
    ? Date.now() + 10 * 60_000
    : 1784000000000 + Math.floor(Math.random() * 1_000_000); // distinct per fixture instance
  const branch = `run-RETRO-${FIXED_TS}`;

  if (opts.seedMarker) {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "last-retro.json"), JSON.stringify(opts.seedMarker, null, 2) + "\n");
  }

  // ── a real local "origin" (bare) + a pre-cloned repoDir (skips `gh repo clone`) ──
  const originGit = mkdtempSync(join(tmpdir(), "rmd-retro-success-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "rmd-retro-success-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "retro-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "retro-test"]);
  if (!opts.missingMasterPlan) writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n\n## 1. Intro\n\nfixture.\n");
  mkdirSync(join(seed, "plan"), { recursive: true });
  // zero tasks -> the best-effort "next runnable task" lookup makes NO gh calls; a
  // deliberately-malformed plan instead makes loadPlan throw, exercising its own catch.
  writeFileSync(join(seed, "plan", "tasks.yaml"), opts.badPlan ? "not_a_task_list: true\n" : "[]\n");
  writeFileSync(join(seed, "plan", "plan-index.json"), "{}\n");
  if (opts.includeGeneratorScript) {
    mkdirSync(join(seed, "scripts"), { recursive: true });
    // The REAL generator script (self-contained: no src/ imports) -- never a reimplementation.
    copyFileSync(join(process.cwd(), "scripts", "generate-plan-index.mjs"), join(seed, "scripts", "generate-plan-index.mjs"));
  }
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "chore: fixture seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  if (!opts.missingRepoDir) {
    execFileSync("git", ["clone", "-q", originGit, repoDir]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "retro-test@example.invalid"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "retro-test"]);
  }
  if (opts.staleWorktree) {
    // A REAL, registered `git worktree` (pruneStaleRuns reads `git worktree list
    // --porcelain`, not just directory names) on a `run-*` branch, with no run.lock --
    // exactly the "crashed before cleanup" shape pruneStaleRuns exists to reap.
    mkdirSync(join(root, "worktrees"), { recursive: true });
    execFileSync("git", [
      "-C", repoDir, "worktree", "add", "-b", "run-STALE-leftover",
      join(root, "worktrees", "run-STALE-leftover"), "main",
    ]);
  }

  // ── a fake `gh` on PATH: only the handful of subcommands this success path invokes ──
  const fakeGhBody = opts.body ?? "Remudero-Task: RETRO\n\n## Acceptance\n- fixture claim | fixture proof\n";
  const headRefNameOut = opts.unresolvedHeadRef ? undefined : (opts.headRefName ?? ((b: string) => b))(branch);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "rmd-retro-success-bin-"));
  // The diff body rides in its OWN file (never inlined into the script's shell text) --
  // real newlines matter here (codeFilesInDiff needs a literal `+++ b/...` LINE), and a
  // shell-quoted/`printf`-escaped inline string would mangle them.
  const diffPath = join(fakeBinDir, "diff-body.txt");
  writeFileSync(diffPath, opts.diff ?? "");
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      // Matched on POSITIONAL args ($1 subcommand, $2 verb, $5 the --json field name),
      // NEVER a substring of the whole "$*" -- a `--body <repaired text>` value can
      // itself legitimately contain words like "diff" (ensureJudgeableBody's own proof
      // text does), which a whole-string substring match would misfire on.
      // repo clone <slug> <dest>  (repoDir absent) -- a REAL local clone, never a stub.
      `if [[ "$1" == 'repo' && "$2" == 'clone' ]]; then git clone -q ${JSON.stringify(originGit)} "$4"; git -C "$4" config user.email retro-test@example.invalid; git -C "$4" config user.name retro-test; exit 0; fi`,
      // pr view <url> --json <field>
      `if [[ "$1" == 'pr' && "$2" == 'view' ]]; then`,
      // --json body  (ensureTaskTrailer + the acceptance-repair check) -- or a response
      // with NO `body` field at all (`view.body ?? ""`'s fallback side).
      opts.omitBody
        ? `  if [[ "$5" == 'body' ]]; then echo '{}'; exit 0; fi`
        : `  if [[ "$5" == 'body' ]]; then echo '{"body":${JSON.stringify(fakeGhBody)}}'; exit 0; fi`,
      // --json headRefName  (checkPrOwnership) -- or NO headRefName field at all, an
      // UNRESOLVED head ref (distinct from a resolved-but-wrong one).
      headRefNameOut === undefined
        ? `  if [[ "$5" == 'headRefName' ]]; then echo '{}'; exit 0; fi`
        : `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${headRefNameOut}"}'; exit 0; fi`,
      `fi`,
      // W1-T2268: `waitForCiGreen` now reads REST (`gh api …`), never `gh pr view --json
      // statusCheckRollup`. RED on the first poll (via the composed check-run), so
      // retroCommand exits right after the marker-advance line with no further gh calls.
      `if [[ "$1" == 'api' ]]; then`,
      `  case "$2" in`,
      opts.existingPrWithoutReport
        ? `    */pulls?head=*) echo '[{"html_url":"https://github.com/craigoley/remudero/pull/434343","number":434343}]'; exit 0 ;;`
        : `    */pulls?head=*) echo '[]'; exit 0 ;;`,
      `    */pulls/*) echo '{"number":999999,"state":"open","merged":false,"merged_at":null,"head":{"sha":"deadbeef"}}'; exit 0 ;;`,
      `    */check-runs*) echo '{"check_runs":[{"name":"ci","status":"completed","conclusion":"failure"}]}'; exit 0 ;;`,
      `    */status) echo '{"statuses":[]}'; exit 0 ;;`,
      `  esac`,
      `fi`,
      // the REST create (the no-PR_URL-in-report fallback, W1-T1202)
      `if [[ "$1" == 'api' && "$2" == '--method' && "$3" == 'POST' ]]; then echo '{"html_url":"https://github.com/craigoley/remudero/pull/424242","number":424242}'; exit 0; fi`,
      // pr diff <url>  (the plan-only guard, codeFilesInDiff) -- or a transient `gh`
      // FAILURE, to exercise retroCommand's outer catch (W1-T242 round 2 sweep).
      opts.diffFails
        ? `if [[ "$1" == 'pr' && "$2" == 'diff' ]]; then echo 'fixture: gh pr diff transient failure' >&2; exit 1; fi`
        : `if [[ "$1" == 'pr' && "$2" == 'diff' ]]; then cat ${JSON.stringify(diffPath)}; exit 0; fi`,
      // pr edit <url> --body <text>  (ensureTaskTrailer / the acceptance-repair path) --
      // or a transient failure, to exercise the acceptance-repair pass's OWN best-effort
      // catch (distinct from the outer catch `diffFails` exercises).
      opts.repairEditFails
        ? `if [[ "$1" == 'pr' && "$2" == 'edit' ]]; then echo 'fixture: gh pr edit transient failure' >&2; exit 1; fi`
        : `if [[ "$1" == 'pr' && "$2" == 'edit' ]]; then exit 0; fi`,
      // Anything else (api rate_limit / pr list ...) this path might probe: fail
      // closed -- every one of those callers already tolerates a `gh` failure.
      'exit 1',
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);

  const spawnArgs: SpawnWorkerArgs[] = [];
  const fakeSpawn = async (args?: SpawnWorkerArgs): Promise<WorkerResult> => {
    if (args) spawnArgs.push(args);
    const result: WorkerResult = {
    provider: "claude",
    sessionId: "s-retro-fixture",
    costUsd: 0.01,
    numTurns: 1,
    text: opts.noPrUrl ? "REPORT\n(no PR_URL -- the harness must open the PR itself)\n" : `REPORT\nPR_URL: https://github.com/craigoley/remudero/pull/999999\n`,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "opus",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    };
    return result;
  };

  const prepublishPreflight = async (preflight: RunRetroPrepublishPreflightOptions): Promise<RetroPrepublishResult> => {
    if (opts.preflightExercisesRepair) {
      preflight.log("retro.preflight_failed", {
        attempt: 1, outcome: "failed", suite_count: 2, elapsed_ms: 1,
        remote_pr_existed: preflight.remotePrExisted,
        provider: preflight.provenance.provider, model: preflight.provenance.model,
        effort: preflight.provenance.effort, session_id: preflight.provenance.sessionId,
      });
      await preflight.repair("bounded fenced fixture evidence");
      await preflight.regenerateHarnessArtifacts();
      preflight.log("retro.preflight_passed", {
        attempt: 2, outcome: "passed", suite_count: 2, elapsed_ms: 1,
        remote_pr_existed: preflight.remotePrExisted,
        provider: preflight.provenance.provider, model: preflight.provenance.model,
        effort: preflight.provenance.effort, session_id: preflight.provenance.sessionId,
      });
      return { ok: true, attempts: 2, suiteCount: 2, repaired: true };
    }
    const result = opts.preflightResult ?? { ok: true, attempts: 1, suiteCount: 2, repaired: false };
    for (let attempt = 1; attempt <= result.attempts; attempt += 1) {
      preflight.log(result.ok && attempt === result.attempts ? "retro.preflight_passed" : "retro.preflight_failed", {
        attempt,
        outcome: result.ok && attempt === result.attempts ? "passed" : "failed",
        suite_count: result.suiteCount,
        elapsed_ms: 1,
        remote_pr_existed: preflight.remotePrExisted,
        provider: preflight.provenance.provider,
        model: preflight.provenance.model,
        effort: preflight.provenance.effort,
        session_id: preflight.provenance.sessionId,
      });
    }
    return result;
  };

  async function run<T>(body: () => Promise<T>): Promise<T> {
    const savedHome = process.env.HOME;
    const savedPath = process.env.PATH;
    const errorSpy = t.mock.method(console, "error", () => {});
    const logSpy = t.mock.method(console, "log", () => {});
    const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);
    process.env.HOME = fakeHome;
    process.env.PATH = `${fakeBinDir}:${savedPath}`;
    const cfgPath = configPath();
    mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");
    try {
      return await body();
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      process.env.PATH = savedPath;
      dateNowSpy.mock.restore?.();
      void errorSpy;
      void logSpy;
    }
  }

  return { root, branch, fakeSpawn, spawnArgs, prepublishPreflight, run };
}

test("retroCommand: a clean run reaches the REAL saveMarker call at the end of the success path and lands a valid marker", async (t) => {
  // The ONE variant that opts into the REAL scripts/generate-plan-index.mjs subprocess
  // (every other variant below defaults to skipping it -- see includeGeneratorScript's
  // doc) so the "regen actually committed" branches stay covered exactly once, not
  // once per variant.
  const fx = setupFakeRetroFixture(t, { includeGeneratorScript: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    // ci went "red" on the first poll (fake gh above) -> retroCommand returns 1 right
    // after the marker-advance line, without ever reaching reviewCommand/armAutoMerge.
    assert.equal(exitCode, 1, "a red ci gate leaves the PR open (exit 1) -- but ONLY after the marker already advanced");

    const markerRaw = readFileSync(join(fx.root, "state", "last-retro.json"), "utf8");
    const marker = JSON.parse(markerRaw) as RetroMarker;
    assert.ok(marker.ts, "the REAL saveMarker call (run-task.ts's success-path call site) must have landed a valid marker");
    assert.equal(marker.runs_seen, 0, "an empty ledger's gather sees zero runs -- this run itself is not ledger-recorded");

    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(
      ledgerLines.some((l) => l.step === "retro.marker.advanced"),
      "retro.marker.advanced must be ledgered once the marker is actually saved",
    );
    assert.ok(
      ledgerLines.some((l) => l.step === "plan_index.regenerated"),
      "the real generator script must have actually run and committed a change",
    );
    const preflightIndex = ledgerLines.findIndex((l) => l.step === "retro.preflight_passed");
    const openedIndex = ledgerLines.findIndex((l) => l.step === "pr.opened");
    const markerIndex = ledgerLines.findIndex((l) => l.step === "retro.marker.advanced");
    assert.ok(preflightIndex >= 0, "the production retro path must call the prepublish preflight");
    assert.ok(preflightIndex < openedIndex, "preflight must pass before pr.opened is emitted");
    assert.ok(preflightIndex < markerIndex, "preflight must pass before the retro marker advances");
  });
});

test("retroCommand: a clean run with a PRE-EXISTING valid marker still resolves it 'ok' and scopes the gather to it", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    seedMarker: { ts: "2026-01-01T00:00:00.000Z", learnings_count: 2, runs_seen: 3 },
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(new Date(marker.ts).getTime() > new Date("2026-01-01T00:00:00.000Z").getTime(), "the marker really advanced past the seeded one");
  });
});

test("retroCommand: the one repair resumes the producing session on its original provider and reruns harness generators", async (t) => {
  const fx = setupFakeRetroFixture(t, { preflightExercisesRepair: true, includeGeneratorScript: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      spawn: fx.fakeSpawn,
      github: offlineGh,
      prepublishPreflight: fx.prepublishPreflight,
    }));
    assert.equal(exitCode, 1, "the fixture's public CI is red only after the repaired prepublish passes");
    const repairSpawns = fx.spawnArgs.filter((args) => args.resumeSessionId !== undefined);
    assert.equal(repairSpawns.length, 1, "promotion judges are fresh; exactly one spawn resumes a session");
    assert.equal(repairSpawns[0].resumeSessionId, "s-retro-fixture", "the repair resumes the producing session");
    assert.deepEqual(
      repairSpawns[0].config?.workerProviders?.enabled,
      ["claude"],
      "the per-call config pins the resume to the producing backend without mutating host config",
    );
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      ledgerLines.filter((l) => l.step === "retro.preflight_failed" || l.step === "retro.preflight_passed").map((l) => l.step),
      ["retro.preflight_failed", "retro.preflight_passed"],
    );
    const repair = ledgerLines.find((l) => l.step === "retro.preflight_repair");
    assert.equal(repair?.provider, "claude");
    assert.equal(repair?.resumed_session_id, "s-retro-fixture");
  });
});

// ── W1-T160: the INTEGRITY GATE — a HARD precondition INSIDE the automated
// (daemon-triggered) path only. `opts.automated` claims the TRIGGER observed real
// merge activity since the marker; this fixture's ledger/gh evidence is empty, so
// buildGather's real `shippedSince` naturally credits ZERO -- exactly the R8-class
// mismatch (trigger saw merges, the real gather found none) the gate exists to catch.

test(
  "retroCommand: the INTEGRITY GATE aborts an AUTOMATED run when the trigger saw real merges but the " +
    "real gather credits ZERO -- no PR, no marker advance, no follow-up harvest, Architect never spawned",
  async (t) => {
    const fx = setupFakeRetroFixture(t, {
      seedMarker: { ts: "2026-01-01T00:00:00.000Z", learnings_count: 0, runs_seen: 0 },
    });
    await fx.run(async () => {
      let spawnCalls = 0;
      const spawn = async () => {
        spawnCalls++;
        return fx.fakeSpawn();
      };
      const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      github: offlineGh,
        spawn,
        automated: { reason: "merges", mergesSinceMarker: 5, daysSinceMarker: 1 },
      }));
      assert.equal(exitCode, 1);
      assert.equal(spawnCalls, 0, "the integrity gate must abort BEFORE the Architect is ever spawned");

      const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
      assert.equal(marker.ts, "2026-01-01T00:00:00.000Z", "the marker must NOT advance past the seeded one");

      const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const abortLine = ledgerLines.find((l) => l.step === "retro_aborted_integrity");
      assert.ok(abortLine, "a loud retro_aborted_integrity ledger line must be written");
      assert.equal(abortLine.merges_since_marker, 5);
      assert.equal(abortLine.gather_shipped, 0);
      assert.equal(abortLine.trigger_reason, "merges");
      assert.equal(ledgerLines.some((l) => l.step === "pr.opened"), false, "no PR may open on an integrity-gate abort");
      assert.equal(
        ledgerLines.some((l) => l.step === "retro.marker.advanced"),
        false,
        "the marker must never advance on an integrity-gate abort",
      );
    });
  },
);

test("retroCommand: an OPERATOR-run retro (opts.automated absent) is NOT integrity-gated -- a zero-credit gather still proceeds exactly as before", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    seedMarker: { ts: "2026-01-01T00:00:00.000Z", learnings_count: 0, runs_seen: 0 },
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight })); // no `automated` -- same shape as every other test in this file
    assert.equal(exitCode, 1, "same red-ci exit as the ordinary success path -- unaffected by the integrity gate");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(
      new Date(marker.ts).getTime() > new Date("2026-01-01T00:00:00.000Z").getTime(),
      "an operator-run retro still advances the marker even though the gather credited zero -- a human is watching",
    );
  });
});

test("retroCommand: an automated run whose gather DOES credit merges passes the integrity gate and proceeds", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    seedMarker: { ts: "2026-01-01T00:00:00.000Z", learnings_count: 0, runs_seen: 0 },
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      github: offlineGh,
      spawn: fx.fakeSpawn,
      automated: { reason: "days", mergesSinceMarker: 0, daysSinceMarker: 8 },
      prepublishPreflight: fx.prepublishPreflight,
    }));
    // mergesSinceMarker: 0 -> checkRetroIntegrity's `priorMergesSinceMarker > 0` guard
    // never trips, regardless of what the real gather credits -- same red-ci exit 1 as
    // every other success-path variant, but reached THROUGH the gate, not around it.
    assert.equal(exitCode, 1);
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(new Date(marker.ts).getTime() > new Date("2026-01-01T00:00:00.000Z").getTime(), "the marker advanced -- the gate passed");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(ledgerLines.some((l) => l.step === "retro_aborted_integrity"), false);
  });
});

/** A trivial empty plan for `runDaemon` — nothing is ever runnable, so the retro-trigger
 *  branch (checked BEFORE task dispatch, W1-T160) owns every tick in the test below,
 *  never racing a real task dispatch. */
function minimalDaemonPlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "w1-t160-daemon-plan-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "[]\n");
  return loadPlan(f);
}

// ── W1-T160 FULL INTEGRATION: the daemon's own scheduling contract driving the REAL
// retroCommand (W1-T136's mergeable-PR path), not a stand-in. The two halves of
// criterion 3 — "runs end to end ... and advances the marker" AND "a second poll does
// not re-fire" — are proven TOGETHER, in ONE pass, against the SAME on-disk marker:
// `runDaemon`'s `checkRetroTrigger`/`runRetroTrigger` hooks are wired to the real
// `evaluateRetroTrigger` (over the real marker file) and the real `retroCommand`
// (over `setupFakeRetroFixture`'s real git/gh fixture) respectively — exactly the
// wiring run-task.ts's `daemonCommand`/`retroTriggerCheck` use in production, not a
// fake `runRetroTrigger` standing in for it.

test(
  "W1-T160 INTEGRATION: runDaemon fires the retro trigger, runs the REAL retroCommand (W1-T136's " +
    "mergeable-PR path) through to a real pr.opened + marker advance, and does NOT re-fire on the very next poll",
  async (t) => {
    const fx = setupFakeRetroFixture(t); // fresh fixture, NO seeded marker -- absent marker fires via reason=days (Infinity)
    await fx.run(async () => {
      const markerPath = join(fx.root, "state", "last-retro.json");
      const plan = minimalDaemonPlan();
      // merges effectively disabled (this fixture's ledger/gh evidence is empty anyway);
      // ANY elapsed time fires via "days" -- the absent-marker case is Infinity days.
      const policy = { mergesThreshold: 999999, daysThreshold: 1 };

      const checkRetroTrigger = (): RetroTriggerDecision => {
        const resolution = resolveMarkerForGather(markerPath);
        const marker = resolution.kind === "ok" ? resolution.marker : undefined;
        return evaluateRetroTrigger(0, marker?.ts, new Date(), policy);
      };

      let retroRuns = 0;
      const runRetroTrigger = async (decision: Extract<RetroTriggerDecision, { fire: true }>) => {
        retroRuns++;
        // THE REAL retroCommand -- W1-T136's mergeable-PR path (Architect spawn -> push
        // -> gh pr create -> ownership assert -> pr.opened -> marker save), gated by
        // opts.automated exactly as the real daemon wiring (run-task.ts's daemonCommand
        // / retroTriggerCheck) invokes it in production. Never a stand-in.
        await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, automated: decision, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
      };

      const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
      let stopChecks = 0;
      const summary = await runDaemon(plan, {
        refreshMerged: () => () => true, // nothing to dispatch -- the retro-trigger branch owns every tick
        runOne: async (id) => {
          throw new Error(`runOne must never be called in this fixture (task ${id})`);
        },
        checkStop: () => {
          stopChecks++;
          return stopChecks > 2 ? "test bound reached" : undefined;
        },
        sleep: async () => {},
        checkRetroTrigger,
        runRetroTrigger,
        log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      });

      assert.equal(summary.stopReason, "stopped");
      assert.equal(retroRuns, 1, "the REAL retroCommand ran exactly once across the two evaluated ticks");

      const fired = lines.filter((l) => l.step === "retro_triggered");
      assert.equal(fired.length, 1, "retro_triggered ledgered exactly once, naming the fire");
      assert.equal(fired[0].extra.reason, "days");

      // W1-T136's mergeable-PR path: a REAL PR opened (never a stub), plan-only-asserted.
      const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(
        ledgerLines.some((l) => l.step === "pr.opened" && l.plan_only === true),
        "the retro reached a real, plan-only, opened PR -- W1-T136's mergeable-PR path",
      );
      assert.ok(
        ledgerLines.some((l) => l.step === "retro.marker.advanced"),
        "the marker advance is the retro's own real saveMarker call, not asserted-away",
      );
      assert.equal(
        ledgerLines.some((l) => l.step === "retro_aborted_integrity"),
        false,
        "the integrity gate passed -- an integrity-passing gather never aborts",
      );

      const markerAfter = JSON.parse(readFileSync(markerPath, "utf8")) as RetroMarker;
      assert.ok(markerAfter.ts, "state/last-retro.json now holds a real, valid, advanced marker");

      // The SECOND poll: re-derived FRESH off the marker THIS run just wrote to disk --
      // not a mock returning a canned "don't fire" answer.
      const secondDecision = checkRetroTrigger();
      assert.equal(secondDecision.fire, false, "the advanced marker's own re-derived state does not cross either threshold again");
    });
  },
);

test("retroCommand: an ownership mismatch (claimed PR head branch != this run's own branch) fails CLOSED before the marker ever advances", async (t) => {
  const fx = setupFakeRetroFixture(t, { headRefName: () => "some-other-branch-entirely" });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "pr_attribution_failed is a fail-closed exit 1, same as any other refused retro");
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "an ownership mismatch must NEVER advance the marker");
  });
});

test("retroCommand: a terminal second prepublish failure preserves the diagnostic branch and posts no PR, marker, review, or merge arm", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    preflightResult: { ok: false, attempts: 2, suiteCount: 158, repaired: true },
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      spawn: fx.fakeSpawn,
      github: offlineGh,
      prepublishPreflight: fx.prepublishPreflight,
    }));
    assert.equal(exitCode, 1);
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "a second failure must leave the marker unchanged");
    assert.ok(fsDefault.existsSync(join(fx.root, "worktrees", fx.branch)), "the committed diagnostic worktree/branch stays available");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(ledgerLines.filter((l) => l.step === "retro.preflight_failed").length, 2);
    for (const forbidden of ["pr.opened", "review.posted", "automerge.armed", "retro.marker.advanced"]) {
      assert.equal(ledgerLines.some((l) => l.step === forbidden), false, `${forbidden} must not occur after terminal preflight failure`);
    }
  });
});

test("retroCommand: a diff that touches src/ fails the plan-only guard before the marker ever advances", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    diff: "diff --git a/src/lib/retro.ts b/src/lib/retro.ts\n--- a/src/lib/retro.ts\n+++ b/src/lib/retro.ts\n+// not plan-only\n",
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "a code-touching retro PR is left OPEN for inspection -- exit 1");
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "a plan-only violation must NEVER advance the marker");
  });
});

test("retroCommand: a PR body missing an Acceptance block gets the harness-side repair pass (W1-T136)", async (t) => {
  // No `## Acceptance` block -- only the trailer -- so ensureTaskTrailer's own check is
  // still satisfied but the acceptance-repair pass's `parseAcceptanceBlock(...).length === 0`
  // branch fires and `gh pr edit` is invoked to fix it up (our fake `gh` accepts any `edit`).
  const fx = setupFakeRetroFixture(t, { body: "Remudero-Task: RETRO\n" });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants -- the repair itself never blocks the retro");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "the repair pass is best-effort -- it must never prevent the marker from advancing");
  });
});

test("retroCommand: a transient `gh pr diff` failure is caught by the outer catch, logged, and rethrown -- the marker never advances", async (t) => {
  const fx = setupFakeRetroFixture(t, { diffFails: true });
  await fx.run(async () => {
    await assert.rejects(
      () => withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight })),
      /transient failure/,
      "the outer catch re-throws (never swallows) an unexpected mid-flight gh failure",
    );
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "a mid-flight failure must NEVER leave a half-advanced marker");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "retro.error"), "the outer catch must ledger retro.error before rethrowing");
  });
});

test("retroCommand: no PR_URL in the Architect's report falls back to `gh pr create --fill` and still reaches the marker advance", async (t) => {
  const fx = setupFakeRetroFixture(t, { noPrUrl: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "the gh-pr-create-fill fallback must still reach the real saveMarker call");
  });
});

test("retroCommand: an exact-head PR omitted from the report is recovered and reused before preflight", async (t) => {
  const fx = setupFakeRetroFixture(t, { noPrUrl: true, existingPrWithoutReport: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      spawn: fx.fakeSpawn,
      github: offlineGh,
      prepublishPreflight: fx.prepublishPreflight,
    }));
    assert.equal(exitCode, 1, "the fixture reaches its intentional red public-CI gate");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const recovered = ledgerLines.find((l) => l.step === "retro.pr.recovered");
    assert.equal(recovered?.pr_url, "https://github.com/craigoley/remudero/pull/434343");
    assert.equal(recovered?.head_branch, fx.branch);
    assert.equal(
      ledgerLines.find((l) => l.step === "retro.preflight_passed")?.remote_pr_existed,
      true,
      "preflight telemetry records that publication had already happened",
    );
    assert.equal(
      ledgerLines.find((l) => l.step === "pr.opened")?.pr_url,
      "https://github.com/craigoley/remudero/pull/434343",
      "the same exact-head PR survives validation and publication; no replacement is created",
    );
  });
});

test("retroCommand: an UNRESOLVED head ref (gh cannot say what branch the PR is on) fails CLOSED, distinctly from a resolved-but-wrong one", async (t) => {
  const fx = setupFakeRetroFixture(t, { unresolvedHeadRef: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "an unresolved head ref is treated as NOT owned -- fail closed, same as a resolved mismatch");
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "an unresolved head ref must NEVER advance the marker");
  });
});

test("retroCommand: a missing plan-index generator script degrades plan-index.json regeneration gracefully (best-effort) and still reaches the marker advance", async (t) => {
  const fx = setupFakeRetroFixture(t); // includeGeneratorScript defaults to false (absent)
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "a best-effort plan-index.json failure must never prevent the marker from advancing");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "plan_index.regen.error"), "the missing generator script must be ledgered, not silently swallowed");
  });
});

test("retroCommand: a malformed plan/tasks.yaml degrades the best-effort 'next runnable task' lookup gracefully and still reaches the marker advance", async (t) => {
  const fx = setupFakeRetroFixture(t, { badPlan: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "a best-effort next-task lookup failure must never prevent the marker from advancing");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "orientation.next_task.error"), "the malformed plan must be ledgered, not silently swallowed");
  });
});

test("retroCommand: a PR body with NO body field at all (not merely empty) still gets trailer-stamped and repaired", async (t) => {
  const fx = setupFakeRetroFixture(t, { omitBody: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "a missing body field is best-effort (ensureTaskTrailer/the repair pass) -- never blocks the marker advance");
  });
});

test("retroCommand: repoDir absent triggers a REAL `gh repo clone` and still reaches the marker advance", async (t) => {
  const fx = setupFakeRetroFixture(t, { missingRepoDir: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "the gh-repo-clone fallback must still reach the real saveMarker call");
    assert.ok(fsDefault.existsSync(join(fx.root, "repos", "remudero", ".git")), "gh repo clone must have actually materialized repoDir");
  });
});

test("retroCommand: a transient `gh pr edit` failure during the acceptance-repair pass is caught by ITS OWN best-effort catch, not the outer one", async (t) => {
  // No Acceptance block (forces the repair attempt) AND the repair's own `gh pr edit`
  // fails -- distinct from `diffFails` (which fails a DIFFERENT gh call, caught by the
  // outer catch and rethrown instead).
  const fx = setupFakeRetroFixture(t, { body: "Remudero-Task: RETRO\n", repairEditFails: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "the repair failure is best-effort -- it must NOT propagate as an uncaught rejection");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "a failed repair attempt must never prevent the marker from advancing");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "acceptance.repair.error"), "the repair failure must be ledgered by its OWN catch");
  });
});

test("retroCommand: the Architect commits NOTHING (no PR_URL, ORIENTATION.md/plan-index.json both degrade) -- the no-op guard exits before any PR, marker untouched", async (t) => {
  const fx = setupFakeRetroFixture(t, { noPrUrl: true, missingMasterPlan: true }); // includeGeneratorScript defaults to false
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "0 commits ahead of origin/main means nothing to PR -- retro.no_op, exit 1");
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "a no-op retro (nothing committed) must NEVER advance the marker");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "retro.no_op"), "the no-op path must be ledgered");
  });
});

test("retroCommand: a stale lockless leftover worktree is force-removed by pruneStaleRuns before this run's own worktree is added", async (t) => {
  const fx = setupFakeRetroFixture(t, { staleWorktree: true });
  const stalePath = join(fx.root, "worktrees", "run-STALE-leftover");
  assert.ok(fsDefault.existsSync(stalePath), "sanity: the stale worktree must exist BEFORE retroCommand runs");
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "pruning a stale sibling worktree must never prevent THIS run's own marker advance");
    assert.ok(!fsDefault.existsSync(stalePath), "the stale worktree must actually be gone -- pruneStaleRuns really ran, not just logged");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "worktree.prune"), "the prune must be ledgered");
  });
});

// THE FAKE MUST BE REACHED. A dep injected into a path that ignores it looks exactly like one that
// works — both go green — so this is the assertion that discriminates them.
//
// SELF-CONTAINED ON PURPOSE. An earlier revision asserted on the SHARED `offlineGh`'s accumulated
// calls, which passed in a full-file run and FAILED under `--test-name-pattern` — the reviewer's own
// proof executor runs exactly that way, so the guard would have been red at review while green
// locally. It now drives its own retroCommand with its own fake and depends on no sibling test.
test("the injected offline gateway is consulted by retroCommand, so no real one is opened", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-ghdep-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-ghdep-root-"));
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");
  t.mock.method(console, "log", () => {});
  const github = offlineGithub();
  try {
    const exitCode = await withLiveWritesAllowed(() => retroCommand(["--dry-run"], { github }));
    assert.equal(exitCode, 0, "--dry-run never fails a genuinely-first-ever retro");
    assert.ok(
      github.calls.length > 0,
      `the production path must consult the injected gateway; recorded ${github.calls.length} calls`,
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
