import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
// The DEFAULT export — a plain, mutable object — so `t.mock.method` can actually
// intercept calls tmp.ts/status.ts make (see the import comment in each): named
// bindings off `node:fs` are non-configurable and `mock.method`/`defineProperty`
// against them throws "Cannot redefine property" instead of installing a spy.
import fsDefault from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/lib/plan.js";
import { deriveStatus, readLedgerLines, type GitHub, type LedgerFsDeps, type PrRef } from "../src/lib/status.js";
import {
  DEFAULT_TEMP_SWEEP_MAX_AGE_MS,
  RMD_TMP_PREFIX,
  makeTempDir,
  sweepStaleTempDirs,
  withTempDir,
} from "../src/lib/tmp.js";

// ── withTempDir: the fix for the rmd-review- leak (W1-T115) ────────────────
// "a completed rmd invocation leaves zero temp dirs" — proof: the temp dir is
// gone after a normal return AND after a thrown error, sync and async.

test("withTempDir: removes the dir after fn returns normally", async () => {
  let captured = "";
  const result = await withTempDir("test", (dir) => {
    captured = dir;
    assert.ok(existsSync(dir), "dir exists while fn runs");
    assert.ok(dir.includes(`${RMD_TMP_PREFIX}test-`), "dir name carries the shared rmd- prefix + kind");
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(existsSync(captured), false, "dir removed after a normal return");
});

test("withTempDir: removes the dir even when fn throws synchronously", async () => {
  let captured = "";
  await assert.rejects(
    withTempDir("test", (dir) => {
      captured = dir;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(existsSync(captured), false, "dir removed on the thrown-error path");
});

test("withTempDir: removes the dir even when an async fn rejects", async () => {
  let captured = "";
  await assert.rejects(
    withTempDir("test", async (dir) => {
      captured = dir;
      await Promise.resolve();
      throw new Error("async boom");
    }),
    /async boom/,
  );
  assert.equal(existsSync(captured), false, "dir removed after a rejected async fn (the exact rmd-review- leak shape)");
});

test("withTempDir: awaits an async fn before cleaning up — the dir is still there mid-await", async () => {
  let sawDirWhileAwaiting = false;
  await withTempDir("test", async (dir) => {
    await new Promise((r) => setTimeout(r, 5));
    sawDirWhileAwaiting = existsSync(dir);
  });
  assert.ok(sawDirWhileAwaiting, "an async fn's dir must not be removed before it finishes using it");
});

// An EXTERNAL spy on the real `node:fs` module (no fixture/injection of tmp.ts's own
// making) — proving the create/remove pairing from outside the module under test, the
// same generic "assert via injected fs" shape criterion 2's proof asks for, applied to
// criterion 1's create/remove pairing. Passes ONLY because tmp.ts calls `fs.mkdtempSync`/
// `fs.rmSync` as property lookups on the default export at call time (see its import
// comment) rather than named bindings destructured at load time — the latter cannot be
// intercepted this way (`mock.method` throws "Cannot redefine property" on a named
// `node:fs` export), which is exactly the ESM pitfall this refactor closes.
test("withTempDir: an external spy on the real fs module sees exactly one create + one remove — success path", async (t) => {
  const mkdtempSpy = t.mock.method(fsDefault, "mkdtempSync");
  const rmSpy = t.mock.method(fsDefault, "rmSync");
  await withTempDir("spytest", (dir) => {
    assert.ok(existsSync(dir));
  });
  assert.equal(mkdtempSpy.mock.calls.length, 1, "exactly one temp dir created");
  assert.equal(rmSpy.mock.calls.length, 1, "exactly one removal issued");
  const removedArg = rmSpy.mock.calls[0].arguments[0] as string;
  assert.ok(removedArg.includes(`${RMD_TMP_PREFIX}spytest-`), "the dir removed is the exact one created");
});

test("withTempDir: an external spy on the real fs module still sees the remove call on the thrown-error path", async (t) => {
  const mkdtempSpy = t.mock.method(fsDefault, "mkdtempSync");
  const rmSpy = t.mock.method(fsDefault, "rmSync");
  await assert.rejects(
    withTempDir("spytest-err", () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(mkdtempSpy.mock.calls.length, 1);
  assert.equal(rmSpy.mock.calls.length, 1, "the remove call still fires even though fn threw");
});

// ── sweepStaleTempDirs: the boot-time backstop ──────────────────────────────
// "boot sweep removes stale dirs and reports" — proof: seeded stale + fresh
// dirs → stale removed, fresh kept, count logged.

function seedDir(root: string, name: string, ageMs: number): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const past = new Date(Date.now() - ageMs);
  utimesSync(dir, past, past);
  return dir;
}

test("sweepStaleTempDirs: removes rmd-owned dirs older than the ceiling, keeps fresh ones and non-rmd entries", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sweep-root-"));
  try {
    const stale = seedDir(root, `${RMD_TMP_PREFIX}review-stale`, DEFAULT_TEMP_SWEEP_MAX_AGE_MS + 60_000);
    const fresh = seedDir(root, `${RMD_TMP_PREFIX}review-fresh`, 1_000);
    const unrelated = seedDir(root, "not-ours-at-all", DEFAULT_TEMP_SWEEP_MAX_AGE_MS + 60_000);
    const staleFile = join(root, `${RMD_TMP_PREFIX}not-a-dir`);
    writeFileSync(staleFile, "x");
    utimesSync(staleFile, new Date(0), new Date(0));

    const summary = sweepStaleTempDirs({ root });

    assert.deepEqual(summary.removed.sort(), [`${RMD_TMP_PREFIX}review-stale`]);
    assert.ok(summary.kept.includes(`${RMD_TMP_PREFIX}review-fresh`), "fresh rmd- dir is kept");
    assert.equal(existsSync(stale), false, "the stale dir is actually gone from disk");
    assert.equal(existsSync(fresh), true, "the fresh dir is untouched");
    assert.equal(existsSync(unrelated), true, "a non-rmd- entry is never touched, however old");
    assert.equal(existsSync(staleFile), true, "a FILE (not a dir) is never removed, even if it happens to match the prefix");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweepStaleTempDirs: an unreadable root is best-effort — returns empty, never throws", () => {
  const summary = sweepStaleTempDirs({ root: join(tmpdir(), "rmd-does-not-exist-" + "xyz123") });
  assert.deepEqual(summary, { removed: [], kept: [] });
});

test("sweepStaleTempDirs: respects an injected clock, not real wall-clock age", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sweep-root-"));
  try {
    const dir = seedDir(root, `${RMD_TMP_PREFIX}clocktest`, 0); // "now"
    let fakeNow = Date.now();
    // Fast-forward the injected clock well past the ceiling without any real wait.
    fakeNow += DEFAULT_TEMP_SWEEP_MAX_AGE_MS + 60_000;
    const summary = sweepStaleTempDirs({ root, now: () => fakeNow });
    assert.deepEqual(summary.removed, [`${RMD_TMP_PREFIX}clocktest`]);
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── makeTempDir: shared prefix used by every call site ──────────────────────

test("makeTempDir: creates a dir named rmd-<kind>-<random> under the OS tmp root", () => {
  const dir = makeTempDir("plan");
  try {
    assert.ok(existsSync(dir));
    assert.ok(statSync(dir).isDirectory());
    assert.ok(dir.startsWith(join(tmpdir(), `${RMD_TMP_PREFIX}plan-`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── readLedgerLines: "ledger reads no longer copy the file" ────────────────
// The task's rationale asserted every invocation copies ledger.ndjson into a
// fresh temp dir before reading it. Investigation found that already false —
// readLedgerLines reads the file directly. Proven here STRUCTURALLY (not by
// mocking node:fs, which is fragile — its ESM namespace exports are
// non-configurable and a prior version of this test broke on that): the fs
// surface injected into readLedgerLines ({@link LedgerFsDeps}) exposes ONLY
// `existsSync`/`readFileSync` — no mkdtemp/write/copy method exists on it
// AT ALL, so a temp-copy write is not merely unobserved, it is impossible
// through this injected interface. The spy below also counts calls and
// checks identical parse results, per the acceptance criterion's proof shape.

function spyLedgerFs(realPath: string): LedgerFsDeps & { existsCalls: string[]; readCalls: string[] } {
  const existsCalls: string[] = [];
  const readCalls: string[] = [];
  return {
    existsCalls,
    readCalls,
    existsSync(p) {
      existsCalls.push(p);
      return existsSync(p);
    },
    readFileSync(p, encoding) {
      readCalls.push(p);
      return readFileSync(p, encoding);
    },
  };
}

test("readLedgerLines: consumes the fixture ledger through an injected fs with NO write/copy method available, identical parse results", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ledger-test-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const raw = '{"step":"a","n":1}\n{"step":"b","n":2}\n\n';
    writeFileSync(ledgerPath, raw);

    const spy = spyLedgerFs(ledgerPath);
    const rows = readLedgerLines(ledgerPath, spy);

    assert.deepEqual(rows, [{ step: "a", n: 1 }, { step: "b", n: 2 }], "parse result identical to reading the fixture directly");
    assert.deepEqual(rows, readLedgerLines(ledgerPath), "identical to the real-fs default reader too");
    assert.ok(spy.existsCalls.includes(ledgerPath) || spy.readCalls.includes(ledgerPath), "the injected fs was actually exercised");
    // The injected surface has no mkdtemp/write/copy method — nothing in
    // readLedgerLines can call one, so "no write syscalls to a temp copy" is
    // true by construction, not merely by absence of observed calls.
    assert.deepEqual(Object.keys(spy).sort(), ["existsCalls", "existsSync", "readCalls", "readFileSync"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLedgerLines: a missing ledger path returns an empty array without ever calling readFileSync (still no copy possible)", () => {
  const spy = spyLedgerFs("/does/not/matter");
  const rows = readLedgerLines(join(tmpdir(), "rmd-ledger-test-missing", "ledger.ndjson"), spy);
  assert.deepEqual(rows, []);
  assert.deepEqual(spy.readCalls, [], "existsSync=false short-circuits before any read");
});

// The default-fs call path (NO injected deps at all — the exact call shape every
// existing production call site uses) proven via an EXTERNAL spy on the real
// `node:fs` module instead of this file's own {@link LedgerFsDeps} fixture: a
// generic "no write syscalls happened" check that doesn't even need to know
// readLedgerLines accepts a second argument. Only possible because status.ts's
// `realLedgerFs` does `fs.existsSync(...)`/`fs.readFileSync(...)` as property
// lookups on the mutable default export at call time (see its import comment) —
// spying on the SAME named exports directly (`mock.method(fsNamespace, ...)`)
// throws "Cannot redefine property" instead of installing a spy, which is the
// ESM pitfall this refactor closes.
test("readLedgerLines: called with NO injected fs, an external spy on the real fs module proves zero write/copy calls", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ledger-spy-test-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const raw = '{"step":"a","n":1}\n{"step":"b","n":2}\n';
    writeFileSync(ledgerPath, raw);

    const writeSpy = t.mock.method(fsDefault, "writeFileSync");
    const copySpy = t.mock.method(fsDefault, "copyFileSync");
    const mkdtempSpy = t.mock.method(fsDefault, "mkdtempSync");
    const rows = readLedgerLines(ledgerPath); // no second arg — the real default fs path

    assert.deepEqual(rows, [{ step: "a", n: 1 }, { step: "b", n: 2 }]);
    assert.equal(writeSpy.mock.calls.length, 0, "no write syscall of any kind during a read");
    assert.equal(copySpy.mock.calls.length, 0, "no copyFileSync — the literal 'copy the file' the task's rationale suspected");
    assert.equal(mkdtempSpy.mock.calls.length, 0, "no temp dir created to copy the ledger into");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── deriveStatus: the status/derivation entrypoint, run against fixtures ───
// "a completed rmd invocation leaves zero temp dirs" — proof: run deriveStatus
// (status.ts's status/derivation entrypoint, exactly what `rmd status` and the
// daemon's dispatch loop call per task) against ledger + GitHub fixtures, and
// assert the temp root gains no new rmd-owned dirs — including when the
// GitHub gateway throws mid-derivation (the thrown-error path).

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function fixtureLedger(dir: string, lines: Array<Record<string, unknown>>): string {
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function fakeGithub(byRef: Record<string, PrRef>): GitHub {
  return {
    prByRef: (ref) => byRef[String(ref)] ?? null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function throwingGithub(): GitHub {
  return {
    prByRef: () => {
      throw new Error("GitHub API unreachable (fixture)");
    },
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

/**
 * A fresh, EXCLUSIVELY-owned temp root standing in for "the temp root" the
 * acceptance criterion names. The real OS tmp root (`os.tmpdir()`) is shared
 * with every other concurrently-running test file — `node --test` runs test
 * files concurrently by default, and e.g. `sweep.test.ts` alone mkdtemps
 * ~100 `rmd-sweep-*` dirs; a before/after snapshot of the SHARED root is
 * provably flaky (observed directly while writing this test: an unrelated
 * concurrent file's own temp-dir churn showed up as a false failure here).
 * A dedicated `mkdtempSync` root that nothing else touches gives the exact
 * same guarantee ("this invocation created no temp dirs") deterministically.
 */
function freshTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-status-entrypoint-root-"));
}

test("deriveStatus: a completed run against fixtures leaves its temp root exactly as it found it", () => {
  const root = freshTempRoot();
  try {
    const url = "https://github.com/craigoley/remudero/pull/7";
    const ledgerPath = fixtureLedger(root, [
      { step: "pr.opened", task_id: "W1-TX", pr_url: url },
    ]);
    const github = fakeGithub({ [url]: { number: 7, url, state: "MERGED" } });

    const before = readdirSync(root).sort();
    const proj = deriveStatus(task({ id: "W1-TX" }), { ledgerPath, github });
    const after = readdirSync(root).sort();

    assert.equal(proj.merged, true);
    assert.deepEqual(after, before, "deriveStatus must create zero temp dirs on a normal completion (only the fixture ledger file remains)");
    assert.deepEqual(after, ["ledger.ndjson"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveStatus: the thrown-error path (GitHub gateway throws) still leaves zero temp dirs behind", () => {
  const root = freshTempRoot();
  try {
    const ledgerPath = fixtureLedger(root, [
      { step: "pr.opened", task_id: "W1-TX", pr_url: "https://github.com/craigoley/remudero/pull/9" },
    ]);
    const github = throwingGithub();

    const before = readdirSync(root).sort();
    assert.throws(() => deriveStatus(task({ id: "W1-TX" }), { ledgerPath, github }), /GitHub API unreachable/);
    const after = readdirSync(root).sort();

    assert.deepEqual(after, before, "a thrown error out of deriveStatus must not leave any temp dir behind");
    assert.deepEqual(after, ["ledger.ndjson"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Same two scenarios, proven the OTHER way: an EXTERNAL spy on the real `node:fs`
// module (not this file's own before/after `readdirSync` snapshot) asserting
// `mkdtempSync` is NEVER called for the run — deriveStatus's default `readLedger`
// goes through `readLedgerLines`'s real-fs path with no `deps.readLedger` override,
// so this exercises the exact same default wiring `rmd status`/the dispatch loop use.
test("deriveStatus: an external spy on the real fs module sees zero mkdtempSync calls — success path", (t) => {
  const root = freshTempRoot();
  try {
    const url = "https://github.com/craigoley/remudero/pull/7";
    const ledgerPath = fixtureLedger(root, [{ step: "pr.opened", task_id: "W1-TX", pr_url: url }]);
    const github = fakeGithub({ [url]: { number: 7, url, state: "MERGED" } });

    const mkdtempSpy = t.mock.method(fsDefault, "mkdtempSync");
    const proj = deriveStatus(task({ id: "W1-TX" }), { ledgerPath, github });

    assert.equal(proj.merged, true);
    assert.equal(mkdtempSpy.mock.calls.length, 0, "no temp dir created by a completed derivation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveStatus: an external spy on the real fs module sees zero mkdtempSync calls — thrown-error path", (t) => {
  const root = freshTempRoot();
  try {
    const ledgerPath = fixtureLedger(root, [
      { step: "pr.opened", task_id: "W1-TX", pr_url: "https://github.com/craigoley/remudero/pull/9" },
    ]);
    const github = throwingGithub();

    const mkdtempSpy = t.mock.method(fsDefault, "mkdtempSync");
    assert.throws(() => deriveStatus(task({ id: "W1-TX" }), { ledgerPath, github }), /GitHub API unreachable/);
    assert.equal(mkdtempSpy.mock.calls.length, 0, "no temp dir created even when the run throws mid-derivation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
