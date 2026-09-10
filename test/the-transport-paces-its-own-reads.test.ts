import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

import {
  DEFAULT_GH_READ_CADENCE_S,
  GH_RATE_LIMIT_BUCKET_UNKNOWN,
  GH_SEARCH_BUCKET,
  classifyGhLimitFailure,
  ghArgvBucketHint,
  ghArgvIsCadenceExempt,
  ghArgvIsWrite,
  ghRateLimitRefusalFromReading,
  ghReadCadenceDecision,
  ghReadCadenceStampPath,
  GhReadCadenceRefusal,
  applyGhReadCadence,
  ghExec,
  ghJson,
  ghSecondaryLimitRefusal,
  resetGhCadenceAdvisoryForTest,
  readGhReadCadenceStampMs,
  resolveGhTransportFloorMode,
  stampGhRead,
} from "../src/lib/github-transport.js";

// ── W1-T3297 — THE TRANSPORT WATCHED THE LIMIT THAT DOES NOT FIRE ────────────────────────────
//
// Every 403 measured on 2026-09-09 arrived with the primary budget reading 5000/5000, so the
// module's only rate-limit awareness (`remaining === 0`) could not see any of them. These tests
// pin the secondary case as a DISTINCT outcome, the read/write split, the advisory default, and
// fail-open — and, for the ratified widening, the separate `search` limiter.

// ── (1) A 403 WITH FULL PRIMARY BUDGET IS A SECONDARY LIMIT, NAMED DISTINCTLY ────────────────

test("a 403 carrying no remaining:0 classifies as the secondary limit, not the primary budget", () => {
  const err = { status: 403, stderr: "API rate limit exceeded for user ID 4397075. (HTTP 403)" };
  assert.equal(classifyGhLimitFailure(err, { remaining: 5000, limit: 5000 }), "secondary");
  // AND THE REFUSAL SAYS SO. Reporting this as the primary limit sends the reader to a reset an
  // hour away for a condition that clears in a minute.
  const refusal = ghSecondaryLimitRefusal("search/issues");
  assert.equal(refusal.kind, "secondary");
  assert.equal(refusal.operation, "search/issues");
  assert.match(refusal.remedy, /backoff/i);
  assert.doesNotMatch(refusal.remedy, /reset/i);
});

test("the secondary classification survives a reading with no primary numbers at all", () => {
  // The measured shape: gh surfaces the 403 body and no X-Ratelimit-Remaining header reaches us.
  assert.equal(classifyGhLimitFailure({ status: 403, stderr: "rate limit exceeded" }, {}), "secondary");
  assert.equal(classifyGhLimitFailure({ status: 429, stderr: "Too Many Requests" }, undefined), "secondary");
});

test("a failure that is not rate-limited at all classifies as neither limit", () => {
  // THE FALSE-POSITIVE CONTROL. Without this, any error would be read as a secondary limit and
  // every genuine failure would be retried as though it were pacing.
  assert.equal(classifyGhLimitFailure({ status: 404, stderr: "Not Found" }, { remaining: 4999 }), undefined);
  assert.equal(classifyGhLimitFailure({ status: 422, stderr: "Validation Failed" }, {}), undefined);
  assert.equal(classifyGhLimitFailure(undefined, {}), undefined);
});

// ── (2) THE PRIMARY REFUSAL IS UNCHANGED ────────────────────────────────────────────────────

test("the existing primary refusal still fires at remaining === 0 and stays silent above it", () => {
  const refusal = ghRateLimitRefusalFromReading({ remaining: 0, reset: 1_760_000_000, resource: "core" }, "pulls");
  assert.equal(refusal?.bucket, "core");
  assert.equal(refusal?.operation, "pulls");
  assert.equal(refusal?.resetsAt, new Date(1_760_000_000 * 1000).toISOString());
  assert.equal(ghRateLimitRefusalFromReading({ remaining: 1 }, "pulls"), undefined);
  assert.equal(ghRateLimitRefusalFromReading({ remaining: 0 }, "pulls")?.bucket, GH_RATE_LIMIT_BUCKET_UNKNOWN);
});

test("an exhausted primary budget classifies as primary even though the error also reads rate-limited", () => {
  // ORDER MATTERS: remaining === 0 is the primary limit and must not be relabelled secondary.
  const err = { status: 403, stderr: "API rate limit exceeded" };
  assert.equal(classifyGhLimitFailure(err, { remaining: 0, limit: 5000 }), "primary");
});

// ── (3) READS ARE PACED; WRITES ARE NEVER DELAYED ───────────────────────────────────────────

test("argv classification splits reads from writes and exempts the budget probe", () => {
  for (const w of [
    ["api", "--method", "POST", "repos/o/r/pulls"],
    ["api", "-X", "PATCH", "repos/o/r/pulls/1"],
    ["pr", "create", "--title", "x"],
    ["pr", "merge", "--auto", "1"],
    ["pr", "comment", "1"],
    ["pr", "review", "1"],
  ]) {
    assert.equal(ghArgvIsWrite(w), true, `expected write: ${w.join(" ")}`);
  }
  for (const r of [["api", "repos/o/r/pulls/1"], ["pr", "view", "1"], ["pr", "list"], ["api", "search/issues?q=x"]]) {
    assert.equal(ghArgvIsWrite(r), false, `expected read: ${r.join(" ")}`);
  }
  assert.equal(ghArgvIsCadenceExempt(["api", "rate_limit"]), true);
  assert.equal(ghArgvIsCadenceExempt(["auth", "status"]), true);
  assert.equal(ghArgvIsCadenceExempt(["api", "repos/o/r"]), false);
});

test("a read inside the window is paced and a write is never delayed however close together", () => {
  const nowMs = 1_000_000_000_000;
  const lastReadMs = nowMs - 10_000; // 10s ago — well inside the 180s floor
  const read = ghReadCadenceDecision({ isWrite: false, isExempt: false, nowMs, lastReadMs, mode: "enforce" });
  assert.equal(read.allow, false);
  assert.equal(read.ageS, 10);
  assert.equal(read.windowS, DEFAULT_GH_READ_CADENCE_S);
  const write = ghReadCadenceDecision({ isWrite: true, isExempt: false, nowMs, lastReadMs, mode: "enforce" });
  assert.equal(write.allow, true);
  assert.equal(write.paced, false);
  // AND A READ PAST THE WINDOW IS ALLOWED — without this the refusal above proves only "refuses".
  const old = ghReadCadenceDecision({ isWrite: false, isExempt: false, nowMs, lastReadMs: nowMs - 181_000, mode: "enforce" });
  assert.equal(old.allow, true);
});

// ── THE RATIFIED WIDENING: `search` IS A SEPARATE LIMITER, SO IT GETS A SEPARATE STAMP ──────

test("a search call is accounted against its own bucket, not the shared read stamp", () => {
  assert.equal(ghArgvBucketHint(["api", "search/issues?q=repo:o/r"]), GH_SEARCH_BUCKET);
  assert.equal(ghArgvBucketHint(["search", "prs", "--repo", "o/r"]), GH_SEARCH_BUCKET);
  assert.equal(ghArgvBucketHint(["api", "repos/o/r/pulls/1"]), undefined);
  // ONE STAMP PER LIMITER: the general read stamp is SHARED with hooks/deny-floor.sh (two windows
  // against one limiter would halve it); search is a different limiter, so it gets its own.
  const env = { XDG_CACHE_HOME: "/c" } as NodeJS.ProcessEnv;
  assert.equal(ghReadCadenceStampPath(env), "/c/remudero/gh-last-read");
  assert.equal(ghReadCadenceStampPath(env, GH_SEARCH_BUCKET), "/c/remudero/gh-last-read-search");
  assert.notEqual(ghReadCadenceStampPath(env), ghReadCadenceStampPath(env, GH_SEARCH_BUCKET));
});

test("the stamp path matches the hook's own resolution, including the HOME fallback", () => {
  // If these diverge the transport and the hook keep separate windows against ONE limiter.
  assert.equal(ghReadCadenceStampPath({ HOME: "/h" } as NodeJS.ProcessEnv), "/h/.cache/remudero/gh-last-read");
  assert.equal(ghReadCadenceStampPath({} as NodeJS.ProcessEnv), undefined);
});

// ── (4) ADVISORY BY DEFAULT ─────────────────────────────────────────────────────────────────

test("the floor is advisory by default and refuses only when explicitly enforced", () => {
  assert.equal(resolveGhTransportFloorMode({} as NodeJS.ProcessEnv), "advisory");
  assert.equal(resolveGhTransportFloorMode({ RMD_GH_TRANSPORT_FLOOR: "enforce" } as NodeJS.ProcessEnv), "enforce");
  assert.equal(resolveGhTransportFloorMode({ RMD_GH_TRANSPORT_FLOOR: "advisory" } as NodeJS.ProcessEnv), "advisory");
  // ANY OTHER VALUE IS ADVISORY. A typo must not silently start refusing daemon reads.
  assert.equal(resolveGhTransportFloorMode({ RMD_GH_TRANSPORT_FLOOR: "yes" } as NodeJS.ProcessEnv), "advisory");
  const nowMs = 2_000;
  const inWindow = { isWrite: false, isExempt: false, nowMs, lastReadMs: nowMs - 1_000 };
  // SAME INPUTS, OPPOSITE POLARITY — the only difference is the mode.
  assert.equal(ghReadCadenceDecision({ ...inWindow, mode: "advisory" }).allow, true);
  assert.equal(ghReadCadenceDecision({ ...inWindow, mode: "advisory" }).paced, true);
  assert.equal(ghReadCadenceDecision({ ...inWindow, mode: "enforce" }).allow, false);
});

// ── (5) FAIL OPEN ON EVERY INTERNAL ERROR ───────────────────────────────────────────────────

test("a missing, unreadable or garbage stamp allows the call", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-cadence-`));
  try {
    // ABSENT — drives the DEFAULT fs read, not an injected fake.
    assert.equal(readGhReadCadenceStampMs(join(dir, "nope")), undefined);
    // A DIRECTORY where a file belongs: the read throws EISDIR and must be swallowed.
    assert.equal(readGhReadCadenceStampMs(dir), undefined);
    // An undefined path (no HOME, no XDG_CACHE_HOME) is not an error either.
    assert.equal(readGhReadCadenceStampMs(undefined), undefined);
    // A real stamp IS read through the default io — otherwise the zeros above prove nothing.
    const stamp = join(dir, "gh-last-read");
    writeFileSync(stamp, "");
    const when = 1_700_000_000;
    utimesSync(stamp, when, when);
    assert.equal(readGhReadCadenceStampMs(stamp), when * 1000);
    // AND A PATH THAT CANNOT BE STATTED FALLS OPEN rather than throwing — driven through the
    // DEFAULT io by a child under a FILE (ENOTDIR), which throws for every uid. A `chmod 0o000`
    // here would be uid-DEPENDENT: root reads it anyway, so the assertion could only be hedged,
    // and test/host-capability-fixtures.test.ts refuses that fixture by name for exactly that.
    assert.equal(readGhReadCadenceStampMs(join(stamp, "child")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an undecidable stamp reads as no stamp, so the decision allows", () => {
  const d = ghReadCadenceDecision({ isWrite: false, isExempt: false, nowMs: 5_000, lastReadMs: undefined, mode: "enforce" });
  assert.equal(d.allow, true);
  assert.equal(d.paced, false);
  // A STAMP IN THE FUTURE SPLITS TWO WAYS. Ordinary sub-second jitter (an mtime rounding just past
  // `now()`) is NOT skew and must still pace — allowing it let a real `gh` spawn through mid-window.
  const jitter = ghReadCadenceDecision({ isWrite: false, isExempt: false, nowMs: 5_000, lastReadMs: 9_000, mode: "enforce" });
  assert.equal(jitter.allow, false, "a small future offset is jitter: pace it, never fall open");
  assert.equal(jitter.ageS, 0);
  // Beyond the whole window it cannot be a read that already happened, so it is undecidable and
  // falls open rather than blocking every read for as long as the skew lasts.
  const skewed = ghReadCadenceDecision({ isWrite: false, isExempt: false, nowMs: 5_000, lastReadMs: 5_000 + 181_000, mode: "enforce" });
  assert.equal(skewed.allow, true);
  assert.equal(skewed.paced, false);
});

test("an unwritable stamp root never throws, so the floor cannot block work by failing", () => {
  // Drives the DEFAULT write path: a directory that does not exist and cannot be created.
  assert.doesNotThrow(() => stampGhRead("/proc/definitely-not-writable/gh-last-read"));
  assert.doesNotThrow(() => stampGhRead(undefined));
  // And the real path DOES write, or the two no-throws above would be vacuous.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-stamp-`));
  try {
    const p = join(dir, "nested", "gh-last-read");
    stampGhRead(p);
    assert.notEqual(readGhReadCadenceStampMs(p), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── THE WIRING. Without these the module above is a complete, tested instrument that nothing
// invokes — the shape this repo has now filed twice (W1-T2732, W1-T2735). ─────────────────────

test("applyGhReadCadence stamps an allowed read and leaves a write and the budget probe unstamped", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-wire-`));
  try {
    const env = { XDG_CACHE_HOME: dir } as NodeJS.ProcessEnv;
    const stamp = ghReadCadenceStampPath(env) as string;
    // A WRITE spends nothing from the read budget, so it must not stamp it.
    applyGhReadCadence(["pr", "create", "--title", "x"], { env, warn: () => {} });
    assert.equal(readGhReadCadenceStampMs(stamp), undefined, "a write must not stamp the read window");
    applyGhReadCadence(["api", "rate_limit"], { env, warn: () => {} });
    assert.equal(readGhReadCadenceStampMs(stamp), undefined, "the budget probe must not stamp");
    // AN ALLOWED READ DOES — through the DEFAULT stamp io, not a fake.
    applyGhReadCadence(["api", "repos/o/r/pulls/1"], { env, warn: () => {} });
    assert.notEqual(readGhReadCadenceStampMs(stamp), undefined, "an allowed read must stamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a search read stamps its own limiter, leaving the shared read window untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-wire-search-`));
  try {
    const env = { XDG_CACHE_HOME: dir } as NodeJS.ProcessEnv;
    applyGhReadCadence(["api", "search/issues?q=x"], { env, warn: () => {} });
    assert.notEqual(readGhReadCadenceStampMs(ghReadCadenceStampPath(env, GH_SEARCH_BUCKET)), undefined);
    assert.equal(
      readGhReadCadenceStampMs(ghReadCadenceStampPath(env)),
      undefined,
      "a search call must not consume the general read window",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("advisory warns at most once per process; enforce throws instead of warning", () => {
  const lines: string[] = [];
  const base = { env: {} as NodeJS.ProcessEnv, nowMs: () => 10_000, readStampMs: () => 9_000, stamp: () => {} };
  resetGhCadenceAdvisoryForTest();
  applyGhReadCadence(["api", "repos/o/r"], { ...base, warn: (l) => lines.push(l) });
  applyGhReadCadence(["api", "repos/o/r"], { ...base, warn: (l) => lines.push(l) });
  assert.equal(lines.length, 1, "an advisory that prints on every paced read is noise");
  assert.match(lines[0] as string, /advisory/);
  assert.match(lines[0] as string, /RMD_GH_TRANSPORT_FLOOR=enforce/);
  // ENFORCE: the same inputs throw, and the error is NOT a rate-limit refusal — nothing was spent.
  const enforced = { ...base, env: { RMD_GH_TRANSPORT_FLOOR: "enforce" } as NodeJS.ProcessEnv };
  assert.throws(
    () => applyGhReadCadence(["api", "repos/o/r"], enforced),
    (e: unknown) => e instanceof GhReadCadenceRefusal && e.ageS === 1 && e.windowS === DEFAULT_GH_READ_CADENCE_S,
  );
  resetGhCadenceAdvisoryForTest();
});

test("the default warn sink reaches stderr, so the advisory is not silently dropped", () => {
  // Drives the DEFAULT emitter — every other case injects `warn`, which would leave it unreachable.
  const written: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string) => {
    written.push(String(chunk));
    return true;
  };
  try {
    resetGhCadenceAdvisoryForTest();
    applyGhReadCadence(["api", "repos/o/r"], {
      env: {} as NodeJS.ProcessEnv,
      nowMs: () => 10_000,
      readStampMs: () => 9_500,
      stamp: () => {},
    });
  } finally {
    (process.stderr as { write: unknown }).write = real;
    resetGhCadenceAdvisoryForTest();
  }
  assert.equal(written.length, 1);
  assert.match(written[0] as string, /gh read cadence \(advisory, W1-T3297\)/);
});

test("ghExec is paced BEFORE it spawns, and an injected exec in ghJson is paced by nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-wire-exec-`));
  const saved = { xdg: process.env.XDG_CACHE_HOME, floor: process.env.RMD_GH_TRANSPORT_FLOOR };
  try {
    process.env.XDG_CACHE_HOME = dir;
    process.env.RMD_GH_TRANSPORT_FLOOR = "enforce";
    const stamp = ghReadCadenceStampPath(process.env) as string;
    stampGhRead(stamp);
    // DETERMINISTICALLY 5s OLD. Left at "just now", `mtimeMs` can round past `now()` and the decision
    // would fall open — which spawned a real `gh` and reached GitHub. No test may depend on that race.
    utimesSync(stamp, Date.now() / 1000 - 5, Date.now() / 1000 - 5);
    // WIRED: this throws instead of spawning `gh`, which is the only way this assertion can pass
    // without network access — proof the floor runs ahead of the spawn.
    assert.throws(() => ghExec(["api", "repos/o/r/pulls/1"], { encoding: "utf8" }), GhReadCadenceRefusal);
    // AND THE GUARD: an injected exec reaches no network, so it is not paced even inside the window.
    const out = ghJson(["api", "repos/o/r/pulls/1"], undefined, () => '{"ok":true}');
    assert.deepEqual(out, { ok: true });
  } finally {
    if (saved.xdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved.xdg;
    if (saved.floor === undefined) delete process.env.RMD_GH_TRANSPORT_FLOOR;
    else process.env.RMD_GH_TRANSPORT_FLOOR = saved.floor;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a REFUSED read does not extend its own window — the stamp is untouched", () => {
  // N7: without this, `stamp()` could run on the refusal path and every blocked read would push the
  // window out another 180s, so a caller in a loop would never get through. The source comment
  // claimed this property; nothing measured it, which is a claim satisfiable by prose alone.
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-refuse-`));
  try {
    const env = { XDG_CACHE_HOME: dir, RMD_GH_TRANSPORT_FLOOR: "enforce" } as NodeJS.ProcessEnv;
    const stamp = ghReadCadenceStampPath(env) as string;
    stampGhRead(stamp);
    const when = Math.floor(Date.now() / 1000) - 5;
    utimesSync(stamp, when, when);
    const before = readGhReadCadenceStampMs(stamp);
    assert.throws(() => applyGhReadCadence(["api", "repos/o/r"], { env }), GhReadCadenceRefusal);
    assert.equal(readGhReadCadenceStampMs(stamp), before, "a refusal must not re-stamp the window");
    // AND THE CONTROL: an ALLOWED read on the same path DOES move it, or the equality above would
    // hold simply because nothing ever writes.
    const past = Math.floor(Date.now() / 1000) - 5_000;
    utimesSync(stamp, past, past);
    applyGhReadCadence(["api", "repos/o/r"], { env, warn: () => {} });
    assert.notEqual(readGhReadCadenceStampMs(stamp), past * 1000, "an allowed read must move the window");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
