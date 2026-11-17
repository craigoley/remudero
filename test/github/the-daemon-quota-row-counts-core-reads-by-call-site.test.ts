import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { runInThisContext } from "node:vm";
import { systemClock } from "#src/lib/clock.js";
import { runDaemon } from "#src/lib/daemon.js";
import { requestStop, stopDetail } from "#src/lib/fleet-control.js";
import { applyGhReadCadence, ghReadCadenceStampPath, takeGhReadCadenceTally, type GhReadCadenceDeps } from "#src/lib/github-transport.js";
import { loadPlan } from "#src/lib/plan.js";

// W1-T13182 — the console daemon spent about 1,100 core GitHub reads an hour on 2026-11-16, and its
// `daemon.quota` rows named a consumer for about 125 of them. These tests drive the REAL transport's
// stamped read path (advisory mode, the daemon's own) on in-memory stamp files and a virtual clock,
// and read the counts back off the row `runDaemon` writes.

const THIS_FILE = "test/github/the-daemon-quota-row-counts-core-reads-by-call-site.test.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-read-call-site-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const realNow = systemClock.now;
  let now = 1_800_000_000_000;
  systemClock.now = () => now;
  t.after(() => { systemClock.now = realNow; });
  const files = new Map<string, { ms: number; text: string }>();
  const deps: GhReadCadenceDeps = {
    nowMs: () => now,
    readStampMs: (p) => (p === undefined ? undefined : files.get(p)?.ms),
    readStampText: (p) => (p === undefined ? undefined : files.get(p)?.text),
    stamp: (p, text = "", atMs = now) => { if (p !== undefined) files.set(p, { ms: atMs, text }); },
    stampGated: (p, text = "", atMs = now) => { if (p !== undefined) files.set(p, { ms: atMs, text }); },
    pidAlive: () => true,
    warn: () => {},
    env: { RMD_GH_CACHE_HOME: dir, RMD_GH_TRANSPORT_FLOOR: "advisory" },
    pid: 7_001,
    actor: () => "daemon",
    sleepSync: (ms) => { now += ms; },
  };
  assert.ok(ghReadCadenceStampPath(deps.env!), "the fixture's reads are stamped");
  // The clock moves between reads; the read itself is made on the caller's own line, its call site.
  const tick = () => { now += 340; };
  return { dir, deps, tick };
}

/** The repository-relative `file:line` of the frame that created `e`. */
function siteOf(e: Error): string {
  const frame = /\((?:file:\/\/)?(\/[^\s()]+):(\d+):\d+\)/.exec(e.stack?.split("\n")[1] ?? "");
  assert.ok(frame, `a frame in ${e.stack}`);
  return `${frame[1].slice(REPO_ROOT.length + 1)}:${frame[2]}`;
}

// Each helper reads on the line that names its own site, so the expected key is measured, not typed.
const ARGS = ["api", "repos/o/r/pulls"];
function readAtA(deps: GhReadCadenceDeps): string { const site = siteOf(new Error()); applyGhReadCadence(ARGS, deps); return site; }
function readAtB(deps: GhReadCadenceDeps): string { const site = siteOf(new Error()); applyGhReadCadence(ARGS, deps); return site; }
function readAtC(deps: GhReadCadenceDeps): void { applyGhReadCadence(ARGS, deps); }

async function oneDaemonPoll(t: TestContext): Promise<Record<string, unknown>> {
  const planDir = mkdtempSync(join(tmpdir(), "rmd-read-call-site-plan-"));
  t.after(() => rmSync(planDir, { recursive: true, force: true }));
  writeFileSync(join(planDir, "tasks.yaml"), "- id: M\n  title: merged\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDaemon(loadPlan(join(planDir, "tasks.yaml")), {
    refreshMerged: () => (id) => id === "M",
    runOne: async (id) => { throw new Error(`FALSIFIER: ${id} dispatched`); },
    readGhQuota: () => ({
      core: { remaining: 4600, resetsAt: "2026-11-16T14:00:00.000Z" },
      graphql: { remaining: 4900, resetsAt: "2026-11-16T14:00:00.000Z" },
    }),
    takeGhReadCadence: () => takeGhReadCadenceTally({}),
    log: (step, extra) => lines.push({ step, extra: extra ?? {} }),
    checkStop: () => stopDetail(planDir),
    sleep: async () => { requestStop(planDir, "test done polling"); },
  });
  const core = lines.find((l) => l.step === "daemon.quota" && l.extra.bucket === "core");
  assert.ok(core, "a core daemon.quota row");
  const graphql = lines.find((l) => l.step === "daemon.quota" && l.extra.bucket === "graphql");
  assert.equal(graphql?.extra.reads_by_call_site, undefined, "the counts ride one row per poll");
  return core.extra;
}

const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

/** 16 reads at site A then 8 at site B, then one daemon poll: its core row and the two sites. */
async function twoSitesOnTheDaemonRow(t: TestContext) {
  const f = fixture(t);
  takeGhReadCadenceTally({}); // the previous poll
  let siteA = "";
  let siteB = "";
  for (let i = 0; i < 16; i++) { f.tick(); siteA = readAtA(f.deps); }
  for (let i = 0; i < 8; i++) { f.tick(); siteB = readAtB(f.deps); }
  const row = await oneDaemonPoll(t);
  return { row, counts: row.reads_by_call_site as Record<string, number>, stamped: row.reads_stamped as Record<string, number>, siteA, siteB };
}

/** Twenty call sites, each its own file under the repository; site i makes (i + 1) * 8 reads. */
function twentySites(t: TestContext) {
  const f = fixture(t);
  takeGhReadCadenceTally({});
  const sites = Array.from({ length: 20 }, (_, i) => ({
    key: `src/lib/call-site-${i}.ts:1`,
    call: runInThisContext("(read, args, deps) => read(args, deps)", { filename: join(REPO_ROOT, "src", "lib", `call-site-${i}.ts`) }) as
      (read: typeof applyGhReadCadence, args: string[], deps: GhReadCadenceDeps) => void,
    reads: (i + 1) * 8,
  }));
  for (const site of sites) for (let n = 0; n < site.reads; n++) { f.tick(); site.call(applyGhReadCadence, ARGS, f.deps); }
  return { sites, tally: takeGhReadCadenceTally({}) };
}

test("W1-T13182 criterion 1: each stamped read counts under its call site, the top 15 named and the rest as other", async (t) => {
  await t.test("the core daemon.quota row counts the reads since the previous row by call site", async (st) => {
    const { counts, siteA, siteB } = await twoSitesOnTheDaemonRow(st);
    assert.deepEqual(counts, { [siteA]: 16, [siteB]: 8 });
    assert.deepEqual(Object.keys(counts), [siteA, siteB], "largest first");
    assert.deepEqual(takeGhReadCadenceTally({}).reads_by_call_site, {}, "the next poll starts from nothing");
  });
  await t.test("twenty sites: the 15 largest are named, largest first, and the 5 smallest sum as other", (st) => {
    const { sites, tally } = twentySites(st);
    const largest = [...sites].reverse().slice(0, 15);
    const expected: Record<string, number> = Object.fromEntries(largest.map((site) => [site.key, site.reads]));
    expected.other = sites.slice(0, 5).reduce((a, s) => a + s.reads, 0);
    assert.deepEqual(tally.reads_by_call_site, expected);
    assert.deepEqual(Object.keys(tally.reads_by_call_site).slice(0, 15), largest.map((s) => s.key));
  });
});

test("W1-T13182 criterion 2: the sum of reads_by_call_site, with other, equals the sum of reads_stamped", async (t) => {
  await t.test("on the core daemon.quota row", async (st) => {
    const { counts, stamped } = await twoSitesOnTheDaemonRow(st);
    assert.equal(sum(stamped), 24);
    assert.equal(sum(counts), sum(stamped));
  });
  await t.test("with other, over twenty sites", (st) => {
    const { sites, tally } = twentySites(st);
    assert.ok((tally.reads_by_call_site.other ?? 0) > 0, "the tally has an other count");
    assert.equal(sum(tally.reads_stamped), sites.reduce((a, s) => a + s.reads, 0));
    assert.equal(sum(tally.reads_by_call_site), sum(tally.reads_stamped));
  });
});

test("W1-T13182 criterion 4: a call site is a repository-relative file and line, as github.pace.loop_wait rows write it", async (t) => {
  const { counts } = await twoSitesOnTheDaemonRow(t);
  assert.equal(Object.keys(counts).length, 2);
  for (const site of Object.keys(counts)) {
    assert.match(site, /^test\/github\/the-daemon-quota-row-counts-core-reads-by-call-site\.test\.ts:\d+$/);
    assert.equal(isAbsolute(site), false);
    assert.ok(site.startsWith(`${THIS_FILE}:`));
  }
});

test("W1-T13182 criterion 3: counting builds one capped stack for 8 reads, however deep the caller", (t) => {
  const f = fixture(t);
  takeGhReadCadenceTally({});
  const READS = 800;
  // invariant:counting-costs-no-stack-per-read — every stack trace built while the reads run is counted,
  // with the frames it holds. No wall-clock bound: a loaded host would make one flaky.
  const original = Error.prepareStackTrace;
  let stacks = 0;
  let maxFrames = 0;
  Error.prepareStackTrace = (error, frames) => {
    stacks += 1;
    maxFrames = Math.max(maxFrames, frames.length);
    return original ? original(error, frames) : `${String(error)}\n${frames.map((s) => `    at ${String(s)}`).join("\n")}`;
  };
  const deep = (depth: number, fn: () => void): void => (depth === 0 ? fn() : deep(depth - 1, fn));
  let deepStacks = 0;
  let deepFrames = 0;
  try {
    for (let i = 0; i < READS; i++) { f.tick(); readAtC(f.deps); }
    assert.ok(stacks <= READS / 8 + 1, `${stacks} stack traces for ${READS} reads`);
    assert.equal(sum(takeGhReadCadenceTally({}).reads_by_call_site), READS, "every read is still counted");
    // The cost of a stack trace grows with the frames it holds. A caller 400 frames deep: its 8 reads
    // build one trace, and that trace holds no more frames than the cap, so the cost per read is bounded.
    stacks = 0;
    maxFrames = 0;
    deep(400, () => { for (let i = 0; i < 8; i++) { f.tick(); readAtC(f.deps); } });
    deepStacks = stacks;
    deepFrames = maxFrames;
  } finally {
    Error.prepareStackTrace = original;
  }
  assert.equal(deepStacks, 1, "8 reads from a deep caller build one stack trace");
  assert.ok(deepFrames > 0 && deepFrames <= 32, `the deep caller's trace holds ${deepFrames} frames`);
  assert.equal(sum(takeGhReadCadenceTally({}).reads_by_call_site), 8);
});
