// W1-T14145: a warm fleet typecheck waits for memory headroom against the recorded warm peak, as a cold one does.
// OBSERVED 2026-11-21 on the fleet host: four concurrent warm sweep typechecks held 11.1 GiB RSS between them while
// memory PSI full sat near 60%. Every memory reading here is injected, and every slot dir and ledger is a fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { typecheckStep } from "#src/lib/commit-message.js";
import type { Config } from "#src/lib/config.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { mergedHeadTypechecks } from "#src/lib/merge-probe.js";
import { acquireTestSlot, admitStaticWork, admitStaticWorkAsync } from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  installedTypescriptVersion, learnedTypecheckWarmPeakBytes, TYPECHECK_BUILDINFO_NAME, TYPECHECK_COLD_PEAK_BYTES,
  TYPECHECK_WARM_PEAK_MIN_ROWS,
} from "#src/lib/typecheck-buildinfo.js";
import { NPM_TYPECHECK_SLOT_LABEL, runTypecheck } from "#src/lib/typecheck-run.js";
import { readRelayedTypecheckPeaks, spawnOpenWeightWorker } from "#src/lib/worker-provider.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const ROOMY = () => 64 * GiB;

/** `n` measured warm typecheck.peak rows of `bytes` each. */
const warmRows = (n: number, bytes: number | ((i: number) => number)): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({ step: "typecheck.peak", entry: "merge-probe", warm: true,
    peak_rss_bytes: typeof bytes === "number" ? bytes : bytes(i) }));

/** This test's own slot dir, named in the env with `slots` slots, so no run here waits on the host's. */
function slotDir(t: TestContext, root: string, slots = 2): string {
  const dir = join(root, "slots");
  mkdirSync(dir);
  const keys = ["RMD_TEST_SLOT_DIR", "RMD_TEST_SLOTS", "RMD_TEST_SLOT_PARENT"];
  const saved = keys.map((key) => process.env[key]);
  process.env.RMD_TEST_SLOT_DIR = dir;
  process.env.RMD_TEST_SLOTS = String(slots);
  delete process.env.RMD_TEST_SLOT_PARENT;
  t.after(() => keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }));
  return dir;
}

/** A checkout with a plain `.git` dir, this repo's install linked in and a usable buildinfo, so its check runs warm; its
 *  ledger (the one a test-context check reads and writes) holds `rows`. */
function warmTree(t: TestContext, rows: Array<Record<string, unknown>>, slots = 2): { root: string; slots: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t14145-warm-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, ".git", TYPECHECK_BUILDINFO_NAME), JSON.stringify({
    version: installedTypescriptVersion(root), fileNames: ["a.ts"], fileInfos: ["hash"],
  }));
  writeLedger(rows, { dir: join(root, "state"), scope: t });
  return { root, slots: slotDir(t, root, slots) };
}

const held = (dir: string): Array<{ name: string; label: string; memoryBytes?: number }> =>
  readdirSync(dir).filter((name) => /^(slot|static)-.*\.json$/.test(name)).sort()
    .map((name) => ({ name, ...JSON.parse(readFileSync(join(dir, name), "utf8")) }));

/** The typecheck.peak rows the checks wrote: the seeded rows carry no run id. */
const peakRows = (root: string): Array<Record<string, unknown>> =>
  readFileSync(ledgerPathFor({ root }), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.step === "typecheck.peak" && row.run_id !== undefined);

const steps = (lines: string[]): string[] => lines.flatMap((line) => {
  try { return [String((JSON.parse(line) as { step?: unknown }).step)]; } catch { return []; }
});

/** A repo whose lane is behind main with a clean merge, and a canonical buildinfo, so each probe check starts warm. */
function warmProbeLane(t: TestContext, rows: Array<Record<string, unknown>>): { repo: string; lane: string } {
  const repo = gitRepo({ kind: "t14145-warm-probe", scope: t });
  writeFileSync(join(repo.dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: [], noEmit: true }, include: ["*.ts"] }));
  writeFileSync(join(repo.dir, "a.ts"), "export const a = 1;\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base");
  const lane = repo.addWorktree(join(repo.dir, "..", `${RMD_TMP_PREFIX}t14145-lane-${process.pid}-${Date.now()}`), "lane", "main");
  t.after(() => rmSync(lane.dir, { recursive: true, force: true }));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(lane.dir, "node_modules"));
  writeFileSync(join(lane.dir, "b.ts"), "export const b = 1;\n");
  lane.git("add", "b.ts");
  lane.git("commit", "-qm", "lane");
  writeFileSync(join(repo.dir, "c.ts"), "export const c = 1;\n");
  repo.git("add", "c.ts");
  repo.git("commit", "-qm", "main");
  writeFileSync(join(repo.dir, ".git", TYPECHECK_BUILDINFO_NAME), JSON.stringify({
    version: installedTypescriptVersion(REPO_ROOT), fileNames: ["./a.ts"], fileInfos: ["hash"],
  }));
  writeLedger(rows, { dir: join(repo.dir, "state"), scope: t });
  return { repo: repo.dir, lane: lane.dir };
}

test("W1-T14145 criterion 1: a warm npm run typecheck waits on memory headroom at the learned warm peak and starts only once admitted", (t) => {
  const fx = warmTree(t, warmRows(60, GiB));
  const peer = admitStaticWork("peer", { dir: fx.slots, memoryBytes: GiB, memoryHeadroom: ROOMY, log: () => {} });
  let peerGone = false;
  const during: Array<{ peerGone: boolean; records: ReturnType<typeof held> }> = [];
  const lines: string[] = [];
  const code = runTypecheck(fx.root, [], {
    spawn: () => { during.push({ peerGone, records: held(fx.slots) }); return { status: 0 }; },
    testSlot: { dir: fx.slots, memoryHeadroom: () => 1.5 * GiB, pollMs: 1, waitBoundMs: 60_000, log: (line) => lines.push(line),
      sleep: () => { peer.release(); peerGone = true; } },
    log: (line) => lines.push(line),
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(steps(lines).includes("test_slot.static_waiting"), "the headroom held one 1 GiB peak, not two: it waited");
  assert.equal(during.length, 1);
  assert.equal(during[0]!.peerGone, true, "tsc started only after the peer left and the admission let it in");
  assert.deepEqual(during[0]!.records.map((r) => [r.name.startsWith("static-"), r.label, r.memoryBytes]), [[true, NPM_TYPECHECK_SLOT_LABEL, GiB]],
    "a headroom admission at the learned warm peak, never a slot");
  assert.equal(held(fx.slots).length, 0, "the admission was released");
});

test("W1-T14145 criterion 1: a warm check is never behind a suite slot count, at npm and at the author preflight", (t) => {
  const fx = warmTree(t, warmRows(60, GiB), 1);
  const suite = acquireTestSlot("suite", { dir: fx.slots, slots: 1, log: () => {} });
  t.after(() => suite.release());
  assert.equal(suite.outcome, "acquired");
  const testSlot = { dir: fx.slots, slots: 1, memoryHeadroom: ROOMY, waitBoundMs: 60_000, log: () => {} };
  const seen: Array<Array<[string, number | undefined]>> = [];
  const look = () => seen.push(held(fx.slots).map((r) => [r.label, r.memoryBytes]));
  assert.equal(runTypecheck(fx.root, [], { spawn: () => { look(); return { status: 0 }; }, testSlot, log: () => {} }), 0);
  const step = typecheckStep(fx.root, () => { look(); return { status: 0, stdout: "", stderr: "" }; }, testSlot);
  assert.equal(step.ok, true, step.detail);
  assert.deepEqual(seen, [
    [["suite", undefined], [NPM_TYPECHECK_SLOT_LABEL, GiB]],
    [["suite", undefined], ["typecheck:preflight", GiB]],
  ], "both ran beside the suite holding the only slot");
});

test("W1-T14145 criterion 1: the author preflight's warm typecheck waits on headroom at the learned warm peak", (t) => {
  const fx = warmTree(t, warmRows(60, GiB));
  const peer = admitStaticWork("peer", { dir: fx.slots, memoryBytes: GiB, memoryHeadroom: ROOMY, log: () => {} });
  let peerGone = false;
  const lines: string[] = [];
  const during: Array<{ peerGone: boolean; records: ReturnType<typeof held> }> = [];
  const step = typecheckStep(fx.root, () => { during.push({ peerGone, records: held(fx.slots) }); return { status: 0, stdout: "", stderr: "" }; }, {
    dir: fx.slots, memoryHeadroom: () => 1.5 * GiB, pollMs: 1, waitBoundMs: 60_000, log: (line) => lines.push(line),
    sleep: () => { peer.release(); peerGone = true; },
  });
  assert.equal(step.ok, true, step.detail);
  assert.ok(steps(lines).includes("test_slot.static_waiting"));
  assert.equal(during[0]?.peerGone, true);
  assert.deepEqual(during[0]?.records.map((r) => [r.label, r.memoryBytes]), [["typecheck:preflight", GiB]]);
});

test("W1-T14145 criterion 1: four warm merge-probe checks under a headroom that holds one run one at a time", async (t) => {
  const fx = warmProbeLane(t, warmRows(60, GiB));
  const slots = slotDir(t, fx.repo);
  let inFlight = 0, most = 0;
  const records: Array<ReturnType<typeof held>> = [];
  const testSlot = { dir: slots, memoryHeadroom: () => 1.5 * GiB, pollMs: 10, waitBoundMs: 120_000, log: () => {} };
  const results = await Promise.all(Array.from({ length: 4 }, () => mergedHeadTypechecks(fx.lane, {
    mainRef: "main", testSlot,
    spawn: (_file, _args, options) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      records.push(held(slots));
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60)"], options);
      child.on("close", () => { inFlight -= 1; });
      return child;
    },
  })));
  assert.deepEqual(results.map((r) => r.outcome), ["passes", "passes", "passes", "passes"], JSON.stringify(results));
  assert.equal(most, 1, "no two warm checks ran at once under a headroom that holds one");
  for (const own of records) {
    const admitted = own.filter((r) => r.label === "typecheck:merge-probe" && r.name.startsWith("static-"));
    assert.ok(admitted.length >= 1 && admitted.every((r) => r.memoryBytes === GiB), JSON.stringify(own));
  }
  assert.ok(peakRows(fx.repo).some((row) => row.warm === true && typeof row.waited_ms === "number" && row.waited_ms > 0),
    "a probe that waited says so on its typecheck.peak row");
});

test("W1-T14145 criterion 1: bwrap's warm typecheck takes a headroom admission at the learned warm peak beside a full slot pool", async (t) => {
  const fx = warmTree(t, warmRows(60, MiB), 1);
  const workerHome = join(fx.root, "home");
  mkdirSync(workerHome);
  writeFileSync(join(workerHome, TYPECHECK_BUILDINFO_NAME), JSON.stringify({
    version: installedTypescriptVersion(fx.root), fileNames: ["a.ts"], fileInfos: ["hash"],
  }));
  const suite = acquireTestSlot("suite", { dir: fx.slots, slots: 1, log: () => {} });
  t.after(() => suite.release());
  const seen: Array<Array<[string, number | undefined]>> = [];
  let turn = 0;
  await spawnOpenWeightWorker({
    cwd: fx.root, workerHome, prompt: "typecheck", tools: ["RunCheck"], maxTurns: 3,
    env: { RMD_OPENWEIGHT_API_KEY: "fixture" },
    runCheck: async () => { seen.push(held(fx.slots).map((r) => [r.label, r.memoryBytes])); return ""; },
    fetchImpl: async () => {
      turn += 1;
      const message = turn === 1
        ? { tool_calls: [{ id: "c1", type: "function", function: { name: "run_check", arguments: '{"check":"typecheck"}' } }] }
        : { content: "done" };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    },
  }, { root: fx.root, dailyCapUsd: 1, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } } as Config,
  { model: "gpt-oss-120b", effort: "low" });
  assert.deepEqual(seen, [[["suite", undefined], ["typecheck:bwrap", MiB]]], "a static admission naming the 1 MiB learned peak");
  const row = peakRows(fx.root).find((r) => r.entry === "bwrap");
  assert.equal(row?.warm, true);
  assert.equal(typeof row?.waited_ms, "number");
});

test("W1-T14145 criterion 2: the warm peak is the p95 of the recent measured warm rows, from 50 rows, else the cold peak", (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t14145-peak-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = (name: string, rows: Array<Record<string, unknown>>, tail = ""): string => {
    const at = join(dir, name);
    const fixture = writeLedger(rows, { dir: at, scope: t });
    if (tail) writeFileSync(fixture.path, readFileSync(fixture.path, "utf8") + tail);
    return fixture.path;
  };
  assert.equal(TYPECHECK_WARM_PEAK_MIN_ROWS, 50);
  assert.equal(learnedTypecheckWarmPeakBytes(join(dir, "absent", "ledger.ndjson")), TYPECHECK_COLD_PEAK_BYTES, "no ledger: the cold peak");
  const noise = [
    ...warmRows(30, MiB).map((row) => ({ ...row, peak_rss_bytes: "unknown" })),
    ...warmRows(30, 9 * GiB).map((row) => ({ ...row, warm: false })),
    { step: "other", warm: true, peak_rss_bytes: 9 * GiB },
  ];
  assert.equal(learnedTypecheckWarmPeakBytes(ledger("few", [...noise, ...warmRows(49, MiB)])), TYPECHECK_COLD_PEAK_BYTES,
    "49 measured warm rows are too few; unknown, cold and other rows never count");
  assert.equal(learnedTypecheckWarmPeakBytes(ledger("fifty", [...noise, ...warmRows(50, (i) => (i + 1) * MiB)], "{torn\n")), 48 * MiB,
    "the p95 of 1..50 MiB");
  assert.equal(learnedTypecheckWarmPeakBytes(ledger("window", [...warmRows(100, 9 * GiB), ...warmRows(200, (i) => (i + 1) * MiB)])), 190 * MiB,
    "only the most recent 200 measured rows count");
});

test("W1-T14145 criterion 3: a warm admission keeps the bounded wait and then runs, and writes the wait on the typecheck.peak row", async (t) => {
  const fx = warmTree(t, warmRows(60, GiB));
  const peer = admitStaticWork("peer", { dir: fx.slots, memoryBytes: GiB, memoryHeadroom: ROOMY, log: () => {} });
  t.after(() => peer.release());
  const tight = { dir: fx.slots, memoryHeadroom: () => 1.5 * GiB, pollMs: 5, waitBoundMs: 40, log: () => {} };
  const lines: string[] = [];
  let ran = 0;
  assert.equal(runTypecheck(fx.root, [], { spawn: () => { ran += 1; return { status: 0 }; }, testSlot: tight, log: (line) => lines.push(line) }), 0);
  assert.match(lines.join("\n"), /"slot":"wait_bound_exceeded"/, lines.join("\n"));
  const step = typecheckStep(fx.root, () => { ran += 1; return { status: 0, stdout: "", stderr: "" }; }, tight);
  assert.equal(step.ok, true, step.detail);
  assert.equal(runTypecheck(fx.root, [], { spawn: () => { ran += 1; return { status: 0 }; }, testSlot: { ...tight, memoryHeadroom: () => undefined }, log: () => {} }), 0,
    "no memory reading: it runs");
  assert.equal(ran, 3, "never refused");
  const rows = peakRows(fx.root);
  assert.deepEqual(rows.map((row) => [row.entry, row.warm]), [["npm", true], ["preflight", true], ["npm", true]]);
  assert.ok(Number(rows[0]!.waited_ms) >= 40 && Number(rows[1]!.waited_ms) >= 40, JSON.stringify(rows));
  assert.equal(typeof rows[2]!.waited_ms, "number");

  const async = await admitStaticWorkAsync("typecheck:merge-probe", { ...tight, memoryBytes: GiB });
  async.release();
  assert.equal(async.outcome, "wait_bound_exceeded");
  assert.equal(async.executionAllowed, true, "the async admission runs at the bound too");
  assert.ok(async.waitedMs >= 40);

  const relayed = readRelayedTypecheckPeaks('rmd-typecheck-peak:{"step":"typecheck.peak","entry":"npm","warm":true,"peak_rss_bytes":7,"waited_ms":1234}\n');
  assert.deepEqual(relayed, [{ step: "typecheck.peak", entry: "npm", warm: true, peak_rss_bytes: 7, waited_ms: 1234 }],
    "a sandboxed check's relayed row keeps its wait");
});
