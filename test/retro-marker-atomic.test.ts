import assert from "node:assert/strict";
// The DEFAULT export -- a plain, mutable object -- so `t.mock.method` can actually
// intercept the calls `saveMarker`/`loadMarker` make: named bindings off `node:fs` are
// non-configurable and mock.method/defineProperty against them throws "Cannot redefine
// property" instead of installing a spy. See the identical import comment atop
// src/lib/status.ts (W1-T207) and src/lib/retro.ts's own marker section -- this file
// intercepts the REAL fs.writeFileSync/fs.renameSync calls saveMarker makes, never a
// reimplementation.
import fsDefault from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildGather, loadMarker, MarkerCorruptError, resolveMarkerForGather, saveMarker, type RetroMarker } from "../src/lib/retro.js";

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
