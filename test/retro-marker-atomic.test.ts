import assert from "node:assert/strict";
// The DEFAULT export -- a plain, mutable object -- so `t.mock.method` can actually
// intercept the calls `saveMarker`/`loadMarker` make: named bindings off `node:fs` are
// non-configurable and mock.method/defineProperty against them throws "Cannot redefine
// property" instead of installing a spy. See the identical import comment atop
// src/lib/status.ts (W1-T207) and src/lib/retro.ts's own marker section -- this file
// intercepts the REAL fs.writeFileSync/fs.renameSync calls saveMarker makes, never a
// reimplementation.
import fsDefault from "node:fs";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildGather, loadMarker, MarkerCorruptError, resolveMarkerForGather, saveMarker, type RetroMarker } from "../src/lib/retro.js";
import { configPath } from "../src/lib/config.js";
import { retroCommand } from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";

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
    const exitCode = await retroCommand([]);
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

// ── W1-T242 round 2: retroCommand's SUCCESS path reaches the atomic marker-advance ──
//
// The corrupt-marker test above proves the fail-closed branch. This one proves the OTHER
// half stays correct: a clean retro run (empty ledger ⇒ genuinely first-ever, an
// ABSENT marker) still reaches `saveMarker` at the tail of the real success path -- the
// exact call site round 1 made atomic -- and it actually lands a real, valid marker on
// disk. Every git/gh boundary is a REAL local git repo or a PATH-shimmed `gh` script (never
// a reimplementation of retroCommand's own logic); only the Architect spawn itself is
// injected (retroCommand's `opts.spawn`, mirroring runTask's existing `opts.spawn` DI).
test("retroCommand: a clean run reaches the REAL saveMarker call at the end of the success path and lands a valid marker", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-success-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-success-root-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  const FIXED_TS = 1784000000000;
  const branch = `run-RETRO-${FIXED_TS}`;

  // ── a real local "origin" (bare) + a pre-cloned repoDir (skips `gh repo clone`) ──
  const originGit = mkdtempSync(join(tmpdir(), "rmd-retro-success-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "rmd-retro-success-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "retro-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "retro-test"]);
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n\n## 1. Intro\n\nfixture.\n");
  mkdirSync(join(seed, "plan"), { recursive: true });
  writeFileSync(join(seed, "plan", "tasks.yaml"), "[]\n"); // zero tasks -> nextTask lookup makes NO gh calls
  writeFileSync(join(seed, "plan", "plan-index.json"), "{}\n");
  mkdirSync(join(seed, "scripts"), { recursive: true });
  // The REAL generator script (self-contained: no src/ imports) -- never a reimplementation.
  copyFileSync(join(process.cwd(), "scripts", "generate-plan-index.mjs"), join(seed, "scripts", "generate-plan-index.mjs"));
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "chore: fixture seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "retro-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "retro-test"]);

  // ── a fake `gh` on PATH: only the handful of subcommands this success path invokes ──
  const fakeGhBody = "Remudero-Task: RETRO\n\n## Acceptance\n- fixture claim | fixture proof\n";
  const fakeBinDir = mkdtempSync(join(tmpdir(), "rmd-retro-success-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      'args="$*"',
      // pr view --json body  (ensureTaskTrailer + the acceptance-repair check)
      `if [[ "$args" == *'--json body'* ]]; then echo '{"body":${JSON.stringify(fakeGhBody)}}'; exit 0; fi`,
      // pr view --json headRefName  (checkPrOwnership)
      `if [[ "$args" == *'--json headRefName'* ]]; then echo '{"headRefName":"${branch}"}'; exit 0; fi`,
      // pr view --json statusCheckRollup  (waitForCiGreen) -- RED on the first poll, so
      // retroCommand exits right after the marker-advance line with no further gh calls.
      `if [[ "$args" == *'--json statusCheckRollup'* ]]; then echo '{"statusCheckRollup":[{"name":"ci","conclusion":"FAILURE"}]}'; exit 0; fi`,
      // pr diff  (the plan-only guard, codeFilesInDiff) -- an empty diff, no code files.
      `if [[ "$args" == *'diff'* ]]; then echo ''; exit 0; fi`,
      // Anything else (repo clone / api rate_limit / pr list ...) this path might probe:
      // fail closed -- every one of those callers already tolerates a `gh` failure.
      'exit 1',
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);

  const errorSpy = t.mock.method(console, "error", () => {});
  const logSpy = t.mock.method(console, "log", () => {});
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);
  process.env.HOME = fakeHome;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  const cfgPath = configPath();
  mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root }, null, 2) + "\n");

  const fakeSpawn = async (): Promise<WorkerResult> => ({
    sessionId: "s-retro-fixture",
    costUsd: 0.01,
    numTurns: 1,
    text: `REPORT\nPR_URL: https://github.com/craigoley/remudero/pull/999999\n`,
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
  });

  try {
    const exitCode = await retroCommand([], { spawn: fakeSpawn });
    // ci went "red" on the first poll (fake gh above) -> retroCommand returns 1 right
    // after the marker-advance line, without ever reaching reviewCommand/armAutoMerge.
    assert.equal(exitCode, 1, "a red ci gate leaves the PR open (exit 1) -- but ONLY after the marker already advanced");

    const markerRaw = readFileSync(join(root, "state", "last-retro.json"), "utf8");
    const marker = JSON.parse(markerRaw) as RetroMarker;
    assert.ok(marker.ts, "the REAL saveMarker call (run-task.ts's success-path call site) must have landed a valid marker");
    assert.equal(marker.runs_seen, 0, "an empty ledger's gather sees zero runs -- this run itself is not ledger-recorded");

    const ledgerLines = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(
      ledgerLines.some((l) => l.step === "retro.marker.advanced"),
      "retro.marker.advanced must be ledgered once the marker is actually saved",
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    dateNowSpy.mock.restore?.();
    void errorSpy;
    void logSpy;
  }
});
