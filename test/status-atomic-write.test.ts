import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
// The DEFAULT export -- a plain, mutable object -- so `t.mock.method` can actually
// intercept the calls `projectPlan` makes: named bindings off `node:fs` are
// non-configurable and `mock.method`/`defineProperty` against them throws "Cannot
// redefine property" instead of installing a spy. See the identical import comment
// atop src/lib/status.ts (the module under test here calls `fs.writeFileSync`/
// `fs.renameSync` as live property lookups at call time for exactly this reason).
import fsDefault from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { buildBatchedGithub, projectPlan, type GitHub, type PrRef } from "../src/lib/status.js";

// ── W1-T207: WRITE-SIDE ATOMICITY for state/status.json ─────────────────────────────
//
// `projectPlan`'s `cachePath` write is the ONE writer function all four run-task.ts
// call sites (and any future fifth) share. Before this task it was a plain
// `mkdirSync` + `writeFileSync(cachePath, ...)` -- a truncate-then-fill that a
// concurrent reader can observe mid-flight. The fix stages the new content to a
// sibling temp file and `renameSync`s it onto `cachePath`; rename(2) within one
// filesystem is atomic, so a reader only ever sees the whole old file or the whole
// new one.
//
// These tests intercept the REAL `fs.writeFileSync`/`fs.renameSync` calls the real,
// exported `projectPlan` makes (never a reimplementation) and interleave a reader at
// the exact instant a torn write would be visible. The interleave is keyed on the
// WRITE TARGET, not a timer/sleep, so it is deterministic and -- critically --
// content-addressed: it fires whenever something is about to write `cachePath`
// directly (the pre-fix shape) OR swap a temp file onto it (the fixed shape), so
// reverting the fix in src/lib/status.ts makes these tests fail without touching a
// single line here. That is the falsifier the task's design note requires: "a test
// that only asserts the file is written correctly proves nothing about atomicity."

/** A minimal task; fields not under test get sensible defaults. */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued", // decorative -- deriveStatus must NOT trust this
    attempts: 0,
    ...over,
  };
}

/** A fake GitHub gateway driven by fixture maps -- mirrors test/status.test.ts's helper. */
function fakeGitHub(opts: {
  byTrailer?: Record<string, PrRef>;
  headRefByUrl?: Record<string, string>;
  bodyByUrl?: Record<string, string>;
}): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: (taskId) => opts.byTrailer?.[taskId] ?? null,
    headRefName: (prUrl) => opts.headRefByUrl?.[prUrl],
    prBody: (prUrl) => opts.bodyByUrl?.[prUrl],
  };
}

/** A well-formed own-branch head ref + exactly-anchored body for `taskId`/`runId`. */
function ownedTrailerFixture(taskId: string, runId: string) {
  return {
    headRefName: `run-${runId}`,
    body: `Implements ${taskId}.\n\nRemudero-Task: ${taskId}\n`,
  };
}

function ledgerFile(lines: Array<Record<string, unknown>> = []): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-status-atomic-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  return p;
}

/** A GitHub gateway that has gone dark -- every underlying `gh` call fails ENOBUFS. */
function darkGithub(): GitHub {
  const enobufsError = Object.assign(new Error("spawnSync gh ENOBUFS"), { code: "ENOBUFS", status: null, stderr: "" });
  return buildBatchedGithub("o", "r", {
    exec: () => {
      throw enobufsError;
    },
  });
}

test(
  "W1-T207: a reader interleaved with the writer never observes a partial/zero-length " +
    "status.json, and a merged task's cache fallback survives the interleave " +
    "(claims 1 + 2) -- FALSIFIER: reverting src/lib/status.ts's atomic write makes this fail",
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "rmd-status-atomic-cache-"));
    const cachePath = join(dir, "status.json");
    const ledgerPath = ledgerFile([]);
    const t1 = task({ id: "W1-T1" });
    const plan: Plan = { tasks: [t1], byId: new Map([[t1.id, t1]]) };

    // Cycle 1: GitHub is reachable and credits the task as merged. Real fs calls,
    // nothing mocked yet -- this just seeds a known-good on-disk snapshot (CONTENT_1).
    const url = "https://github.com/craigoley/remudero/pull/9001";
    const fixture = ownedTrailerFixture("W1-T1", "W1-T1-1784460723173");
    const healthyGithub = fakeGitHub({
      byTrailer: { "W1-T1": { number: 9001, url, state: "MERGED" } },
      headRefByUrl: { [url]: fixture.headRefName },
      bodyByUrl: { [url]: fixture.body },
    });
    const first = projectPlan(plan, { ledgerPath, github: healthyGithub }, cachePath);
    assert.equal(first.get("W1-T1")?.status, "merged", "cycle 1 seeds a merged, cached projection");
    const content1 = fsDefault.readFileSync(cachePath, "utf8");
    assert.ok(content1.length > 0, "sanity: cycle 1 actually produced a non-empty cache file");
    JSON.parse(content1); // sanity: valid JSON

    // Cycle 2: GitHub has since gone dark. Nothing in the ledger or a fresh GitHub read
    // can re-derive "merged" -- the ONLY way this task stays "merged" (rather than
    // regressing to "queued"/orphaned, per W1-T179's monotonic-under-darkness doctrine)
    // is by successfully reading the intact cycle-1 cache back off disk.
    //
    // Intercept the real fs.writeFileSync/renameSync calls this cycle's `projectPlan`
    // makes. The probe fires on whichever write op is about to make `cachePath` itself
    // visible to a reader:
    //  - a DIRECT `writeFileSync(cachePath, ...)` (the pre-fix shape) -- truncate the
    //    real file first to reproduce the exact zero-length window a real truncating
    //    write exposes, THEN fire the probe, THEN fill it. This is what makes the test
    //    fail against a reverted (pre-fix) implementation.
    //  - a `renameSync(tmp, cachePath)` (the fixed shape) -- fire the probe BEFORE the
    //    atomic swap, while cachePath still holds cycle 1's complete, untouched bytes.
    const realWriteFileSync = fsDefault.writeFileSync.bind(fsDefault);
    const realRenameSync = fsDefault.renameSync.bind(fsDefault);
    const realReadFileSync = fsDefault.readFileSync.bind(fsDefault);
    const realExistsSync = fsDefault.existsSync.bind(fsDefault);

    const observations: Array<{ label: string; content: string | undefined }> = [];
    let readerObservedStatus: string | undefined;
    let readerObservedIndeterminate: boolean | undefined;
    let probeFired = false;
    let probeArmed = true; // guards against the nested reader call's own write re-firing this

    function probe(label: string) {
      if (!probeArmed) return;
      probeArmed = false;
      probeFired = true;
      const content = realExistsSync(cachePath) ? realReadFileSync(cachePath, "utf8") : undefined;
      observations.push({ label, content });

      // The "concurrent reader": a genuinely SEPARATE call into the same exported
      // `projectPlan`, simulating a different process (another run-task.ts, or the
      // console's poller) racing this write on the SAME cachePath. GitHub is dark for
      // it too, so it has nothing but the on-disk cache to fall back on.
      const reader = projectPlan(plan, { ledgerPath, github: darkGithub() }, cachePath);
      const proj = reader.get("W1-T1");
      readerObservedStatus = proj?.status;
      readerObservedIndeterminate = proj?.indeterminate;

      probeArmed = true;
    }

    t.mock.method(fsDefault, "writeFileSync", (target: unknown, content: unknown, ...rest: unknown[]) => {
      if (target === cachePath) {
        // Reproduce a plain truncating writeFileSync's observable two-phase window:
        // the file is emptied before the payload lands.
        realWriteFileSync(cachePath, "");
        probe("direct writeFileSync(cachePath) -- post-truncate, pre-fill");
        return realWriteFileSync(target as string, content as string, ...(rest as []));
      }
      return realWriteFileSync(target as string, content as string, ...(rest as []));
    });
    t.mock.method(fsDefault, "renameSync", (from: unknown, to: unknown) => {
      if (to === cachePath) {
        probe("renameSync(tmp, cachePath) -- pre-swap");
      }
      return realRenameSync(from as string, to as string);
    });

    const second = projectPlan(plan, { ledgerPath, github: darkGithub() }, cachePath);
    assert.equal(second.get("W1-T1")?.status, "merged", "cycle 2 itself must also stay merged under darkness");

    assert.ok(probeFired, "sanity: the interleave probe must actually have fired at least once");

    // Claim 1: never partial/zero-length.
    for (const obs of observations) {
      assert.ok(obs.content !== undefined, `${obs.label}: cachePath must already exist by cycle 2`);
      assert.ok(obs.content!.length > 0, `${obs.label}: reader observed a ZERO-LENGTH status.json`);
      assert.doesNotThrow(() => JSON.parse(obs.content!), `${obs.label}: reader observed unparseable (torn) JSON`);
      assert.equal(obs.content, content1, `${obs.label}: reader observed something other than the complete, untouched cycle-1 file`);
    }

    // Claim 2: the interleaved reader's own cache fallback must not have regressed.
    assert.equal(
      readerObservedStatus,
      "merged",
      "a reader landing mid-write must still resolve the credited merge via the cache fallback, not regress to queued",
    );
    assert.equal(readerObservedIndeterminate, true, "the reader is honestly marked indeterminate (GitHub is dark for it too)");
  },
);

test("W1-T207 claim 3: a brand-new projectPlan caller inherits the atomic write for free -- no special wiring at the call site", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-status-atomic-newcaller-"));
  const cachePath = join(dir, "status.json");
  const ledgerPath = ledgerFile([]);
  const t1 = task({ id: "W1-T2" });
  const plan: Plan = { tasks: [t1], byId: new Map([[t1.id, t1]]) };

  const writeSpy = t.mock.method(fsDefault, "writeFileSync");
  const renameSpy = t.mock.method(fsDefault, "renameSync");

  // A "new caller" is nothing more than invoking the SAME `projectPlan(plan, deps,
  // cachePath)` signature every existing call site already uses -- no temp-file or
  // rename bookkeeping of its own. If the atomicity guarantee required per-call-site
  // wiring, this plain call would write cachePath directly; it must not.
  projectPlan(plan, { ledgerPath, github: fakeGitHub({}) }, cachePath);

  assert.equal(writeSpy.mock.calls.length, 1, "exactly one writeFileSync call for a single-cycle write");
  const writtenTarget = writeSpy.mock.calls[0]!.arguments[0] as string;
  assert.notEqual(writtenTarget, cachePath, "the writer never targets the live cache path directly -- it stages to a sibling temp file first");
  assert.ok(
    writtenTarget.startsWith(cachePath) && writtenTarget !== cachePath,
    "the temp file lives in the SAME directory as cachePath, required for rename(2) atomicity on one filesystem",
  );

  assert.equal(renameSpy.mock.calls.length, 1, "exactly one renameSync call finalizes the write");
  assert.deepEqual(
    renameSpy.mock.calls[0]!.arguments,
    [writtenTarget, cachePath],
    "the rename swaps the exact staged temp file onto the real cache path",
  );

  const onDisk = JSON.parse(fsDefault.readFileSync(cachePath, "utf8")) as { tasks?: Record<string, { status?: string }> };
  assert.equal(onDisk.tasks?.["W1-T2"]?.status, "queued", "the end state is exactly what an un-mocked write would have produced");
});
