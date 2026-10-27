/**
 * W1-T9106 — THE DAEMON'S HEAP CEILING IS LEARNED AND APPLIED AT BOOT ONCE A RESTART COSTS ONLY A BOOT.
 *
 * The daemon started under the inherited `--max-old-space-size=8192` against a live set near 0.9 GiB, and the W1-T8883
 * shadow only reported the ceiling it learned. Now the shadow writes `<state>/daemon-heap-ceiling.json`, bin/rmd starts
 * the daemon verb (only) under it when it is applied and current for this instance, a heap-limit exit raises the next
 * ceiling, and it stays report-only (`mode: shadow`) while builds run in-process.
 *
 * The launcher cases run the REAL bin/rmd, copied into a fixture whose entry resolver names a stub main that reports
 * the NODE_OPTIONS and V8 heap limit it started under.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDaemonMemoryPolicy, createHeapShadow, DEFAULT_DAEMON_MEMORY_POLICY, defaultHeapCeilingLocation, HEAP_CEILING_CURRENT_MS,
  HEAP_LIMIT_EXIT_FRACTION, HEAP_SAMPLE_RETAIN_MS, heapCeilingPath, heapCeilingSource, heapSamplePath, launchHeapCeiling,
  nextLearnedHeapCeiling, parseLearnedHeapCeiling, priorBootAtLimit, proposeHeapCeiling, runChildrenAdoptedGate,
  type HeapCeilingGate, type HeapSampleIo, type LearnedHeapCeiling, type SlackSnapshot,
} from "#src/lib/daemon-memory-policy.js";
import { fixedClock } from "#src/lib/clock.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const INHERITED = "--max-old-space-size=8192 --no-deprecation";
const ON: HeapCeilingGate = { applies: true, reason: "sweep.runChild.mode on: runs are adopted children" };

interface Fixture { dir: string; home: string; stateDir: string; out: string }

/** A copy of the real bin/rmd beside a resolver that names a stub main, and a HOME whose config root is the fixture's. */
function launcherFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t9106-`));
  mkdirSync(join(dir, "pkg", "bin"), { recursive: true });
  mkdirSync(join(dir, "pkg", "scripts"));
  mkdirSync(join(dir, "pkg", "node_modules", ".bin"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "bin", "rmd"), join(dir, "pkg", "bin", "rmd"));
  chmodSync(join(dir, "pkg", "bin", "rmd"), 0o755);
  writeFileSync(join(dir, "pkg", "scripts", "build-child-entries.mjs"),
    `process.stdout.write("bundle\\tfixture\\t" + process.argv[process.argv.indexOf("--root") + 1] + "/main.mjs");\n`);
  writeFileSync(join(dir, "pkg", "main.mjs"), [
    `import { writeFileSync } from "node:fs";`,
    `import { getHeapStatistics } from "node:v8";`,
    `writeFileSync(process.env.FIXTURE_OUT, JSON.stringify({ entry: "daemon-main", node_options: process.env.NODE_OPTIONS ?? null, heap_size_limit: getHeapStatistics().heap_size_limit }));`,
  ].join("\n"));
  const tsx = join(dir, "pkg", "node_modules", ".bin", "tsx");
  writeFileSync(tsx, `#!/usr/bin/env bash\nprintf '{"entry":"tsx","node_options":"%s"}' "\${NODE_OPTIONS-}" > "$FIXTURE_OUT"\n`);
  chmodSync(tsx, 0o755);
  const home = join(dir, "home");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  const root = join(dir, "root");
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  return { dir, home, stateDir, out: join(dir, "out.json") };
}

/** Run the copied bin/rmd with `verb` under `nodeOptions`; what the started entry saw. */
function launch(f: Fixture, verb: string, nodeOptions: string): { entry: string; node_options: string | null; heap_size_limit?: number } {
  rmSync(f.out, { force: true });
  const r = spawnSync("bash", [join(f.dir, "pkg", "bin", "rmd"), verb], {
    encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: f.home, NODE_OPTIONS: nodeOptions, FIXTURE_OUT: f.out },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(f.out, "utf8"));
}

/** A shadow over `stateDir` that has seen `lives` post-collection live sets (MiB), one a minute from `startMs`. */
function learnedShadow(stateDir: string, o: {
  lives: number[]; startMs: number; pid?: number; gate?: HeapCeilingGate; budget?: number; io?: HeapSampleIo; limit?: number; used?: () => number;
}) {
  let nowMs = o.startMs;
  const shadow = createHeapShadow({
    path: heapSamplePath(stateDir), pid: o.pid ?? 101, clock: { now: () => nowMs, iso: () => new Date(nowMs).toISOString() } as never,
    ...(o.io ? { io: o.io, ceilingIo: o.io } : {}),
    snapshot: (): SlackSnapshot => ({ rss_bytes: 1, heap_used_bytes: o.used?.() ?? 0, heap_physical_bytes: 0, external_bytes: 0, heap_size_limit_bytes: o.limit ?? 8 * GIB }),
    ceilingGate: () => o.gate ?? ON, budgetBytes: () => o.budget ?? 8 * GIB,
  });
  for (const live of o.lives) {
    nowMs += 60_000;
    shadow.observe({ used_bytes: live * MIB, size_bytes: live * MIB, after_gc: true });
  }
  return { shadow, advance: (ms: number) => { nowMs += ms; }, now: () => nowMs };
}

function memoryIo(): HeapSampleIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (path) => { const t = files.get(path); if (t === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" }); return t; },
    writeFile: (path, content) => { files.set(path, content); },
  };
}

const ceilingIn = (io: { files: Map<string, string> }, stateDir: string): LearnedHeapCeiling =>
  JSON.parse(io.files.get(heapCeilingPath(stateDir)) as string) as LearnedHeapCeiling;

test("W1-T9106: the launcher applies the learned ceiling to the daemon verb only", () => {
  const f = launcherFixture();
  try {
    const { shadow } = learnedShadow(f.stateDir, { lives: [400, 380, 420, 400], startMs: Date.now() - 10 * 60_000 });
    const proposal = shadow.propose();
    assert.equal(proposal.learned_ceiling_mode, "applied", "the proposal row names what the file now says");
    const text = readFileSync(heapCeilingPath(f.stateDir), "utf8");
    const file = JSON.parse(text) as LearnedHeapCeiling;
    assert.equal(file.mode, "applied");
    assert.equal(file.state_dir, f.stateDir);
    assert.equal(file.ceiling_mib, 840, "max(p99.9 420 MiB x 1.5, 2 x 420 MiB) = 840 MiB");
    assert.equal(file.ceiling_mib, proposal.learned_ceiling_mib);
    assert.deepEqual([file.basis.samples, file.basis.after_gc_samples, file.basis.live_max_bytes], [4, 4, 420 * MIB], "the basis travels with it");
    assert.equal(file.window_ms, HEAP_SAMPLE_RETAIN_MS);

    const daemon = launch(f, "daemon", INHERITED);
    assert.equal(daemon.entry, "daemon-main");
    assert.equal(daemon.node_options, "--no-deprecation --max-old-space-size=840", "the inherited ceiling is replaced, every other word kept");
    assert.ok((daemon.heap_size_limit as number) < 2 * GIB, `the daemon's V8 limit follows the learned ceiling (${daemon.heap_size_limit})`);
    assert.ok((daemon.heap_size_limit as number) >= 840 * MIB, `and is not below it (${daemon.heap_size_limit})`);
    const rule = launchHeapCeiling(text, INHERITED, f.stateDir, Date.now());
    assert.equal(rule.ceiling_source === "learned" && rule.node_options, daemon.node_options, "bin/rmd and launchHeapCeiling give one answer");

    const other = launch(f, "status", INHERITED);
    assert.equal(other.entry, "tsx");
    assert.equal(other.node_options, INHERITED, "every other verb keeps the inherited NODE_OPTIONS");

    const started = applyDaemonMemoryPolicy(DEFAULT_DAEMON_MEMORY_POLICY,
      { setFlags: () => {}, env: { NODE_OPTIONS: daemon.node_options as string }, heapCeiling: { stateDir: f.stateDir } });
    assert.equal(started.ceiling_source, "learned", "daemon.memory_policy names the learned source");
    assert.equal(started.learned_ceiling_mib, 840);
    assert.equal(started.node_options_children, "--no-deprecation", "children still inherit no ceiling");
    const bypassed = heapCeilingSource(INHERITED, { stateDir: f.stateDir });
    assert.deepEqual(bypassed, { ceiling_source: "inherited", ceiling_unapplied: "the launcher did not apply it", learned_ceiling_mib: 840 });

    // Current for THIS instance only: the same file under another config root, or past valid_until, is not applied.
    assert.deepEqual(launchHeapCeiling(text, INHERITED, join(f.dir, "elsewhere", "state"), Date.now()), { ceiling_source: "inherited", reason: "written for another instance" });
    assert.deepEqual(launchHeapCeiling(text, INHERITED, f.stateDir, file.valid_until), { ceiling_source: "inherited", reason: "stale" });
    assert.equal(file.valid_until - file.written_at, HEAP_CEILING_CURRENT_MS);
    writeFileSync(heapCeilingPath(f.stateDir), JSON.stringify({ ...file, valid_until: Date.now() - 1 }));
    assert.equal(launch(f, "daemon", INHERITED).node_options, INHERITED, "a stale file keeps the inherited ceiling");
    writeFileSync(heapCeilingPath(f.stateDir), JSON.stringify({ ...file, ceiling_mib: 12 }));
    assert.equal(launch(f, "daemon", INHERITED).node_options, INHERITED, "a damaged ceiling keeps the inherited one");
    assert.deepEqual(launchHeapCeiling(JSON.stringify({ ...file, ceiling_mib: 12 }), INHERITED, f.stateDir, Date.now()), { ceiling_source: "inherited", reason: "unreadable ceiling_mib" });
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("W1-T9106: a heap-limit exit raises the next ceiling", () => {
  const io = memoryIo();
  const stateDir = "/fixture/state";
  const t0 = 1_800_000_000_000;
  let used = 0;
  const boot1 = learnedShadow(stateDir, { lives: [400, 380, 420, 400], startMs: t0, io, limit: 840 * MIB, used: () => used });
  boot1.shadow.propose();
  const first = ceilingIn(io, stateDir);
  assert.deepEqual([first.mode, first.ceiling_mib, first.cap_bytes], ["applied", 840, 4 * GIB]);

  // The heartbeat sees the heap at the v8_limit exit fraction: the file is raised before the daemon leaves.
  used = Math.ceil(HEAP_LIMIT_EXIT_FRACTION * 840 * MIB) + 10 * MIB;
  boot1.advance(120_000);
  boot1.shadow.sampleNow();
  const raised = ceilingIn(io, stateDir);
  assert.equal(raised.raised_by?.basis, "v8_limit");
  assert.equal(raised.raised_by?.used_bytes, used);
  assert.ok((raised.ceiling_bytes as number) > 840 * MIB, `the next ceiling is higher (${raised.ceiling_mib} MiB)`);
  assert.equal(raised.raised_by?.raised_to_bytes, Math.ceil((used + 64 * MIB) / HEAP_LIMIT_EXIT_FRACTION), "the live set at exit plus its spread, under the exit fraction");
  assert.ok((raised.ceiling_bytes as number) >= (raised.raised_by?.raised_to_bytes as number));
  assert.equal(raised.mode, "applied");
  assert.ok((raised.ceiling_bytes as number) <= (raised.cap_bytes as number), "never above restartShare of the budget");
  boot1.advance(60_000);
  boot1.shadow.sampleNow();
  assert.equal(ceilingIn(io, stateDir).ceiling_bytes, raised.ceiling_bytes, "one raise per boot, never a ratchet per heartbeat");

  // The next boot learns a smaller live set: inside the window the ceiling is never lowered.
  const boot2 = learnedShadow(stateDir, { lives: [200, 210], startMs: t0 + 60 * 60_000, io, pid: 102 });
  boot2.shadow.propose();
  const held = ceilingIn(io, stateDir);
  assert.equal(held.ceiling_bytes, raised.ceiling_bytes);
  assert.equal(held.learned_since, first.learned_since);
  assert.equal(held.raised_by?.basis, "v8_limit", "the raise's evidence is kept for the window");
  // Past the window it is learned afresh, and may come down.
  const fresh = nextLearnedHeapCeiling({
    stateDir, nowMs: held.learned_since + HEAP_SAMPLE_RETAIN_MS, restartShare: 0.5, budgetBytes: 8 * GIB, gate: ON, prior: held,
    proposal: proposeHeapCeiling([{ at: 1, used_bytes: 200 * MIB, size_bytes: 0, after_gc: true, pid: 1 }], 50, 8 * GIB),
  });
  assert.deepEqual([fresh.ceiling_mib, fresh.learned_since, fresh.raised_by], [400, held.learned_since + HEAP_SAMPLE_RETAIN_MS, undefined]);

  // A heap out-of-memory exit leaves no row: the next boot reads it from the previous boot's last sample at the limit.
  const oomIo = memoryIo();
  const boot3 = learnedShadow(stateDir, { lives: [400, 420], startMs: t0, io: oomIo, pid: 103 });
  boot3.shadow.propose();
  boot3.shadow.observe({ used_bytes: 800 * MIB, size_bytes: 800 * MIB, after_gc: false });
  boot3.shadow.flush();
  const boot4 = learnedShadow(stateDir, { lives: [], startMs: t0 + 10 * 60_000, io: oomIo, pid: 104 });
  boot4.shadow.propose();
  const afterOom = ceilingIn(oomIo, stateDir);
  assert.equal(afterOom.raised_by?.basis, "heap_oom");
  assert.ok((afterOom.ceiling_bytes as number) > 840 * MIB);
  assert.equal(priorBootAtLimit(boot4.shadow.samples(), afterOom, 104), undefined, "a raise is taken from one sample once");

  // Capped by restartShare: a raise that cannot clear the limit that exited stays report-only.
  const capped = nextLearnedHeapCeiling({
    stateDir, nowMs: t0, restartShare: 0.5, budgetBytes: 1.5 * GIB, gate: ON, prior: first, proposal: proposeHeapCeiling([], 50, 8 * GIB),
    exit: { basis: "v8_limit", at: t0, used_bytes: 700 * MIB, heap_size_limit_bytes: 840 * MIB },
  });
  assert.deepEqual([capped.ceiling_bytes, capped.capped, capped.mode, capped.mode_reason],
    [0.75 * GIB, true, "shadow", "a raise capped by restartShare would repeat the exit"]);
  const unlearned = nextLearnedHeapCeiling({ stateDir, nowMs: t0, restartShare: 0.5, budgetBytes: 8 * GIB, gate: ON,
    proposal: { ...proposeHeapCeiling([], 50, 8 * GIB), proposed_unlearned: undefined } });
  assert.deepEqual([unlearned.mode, unlearned.mode_reason, unlearned.ceiling_mib], ["shadow", "no ceiling learned yet: no proposal", undefined]);
  const inWindow = first.learned_since;
  const noBudget = nextLearnedHeapCeiling({ stateDir, nowMs: inWindow, restartShare: 0.5, gate: ON, prior: first, proposal: proposeHeapCeiling([], 50, 8 * GIB) });
  assert.deepEqual([noBudget.mode, noBudget.mode_reason], ["shadow", "no memory budget to bound the ceiling by restartShare"]);
  const tiny = nextLearnedHeapCeiling({ stateDir, nowMs: inWindow, restartShare: 0.5, budgetBytes: 100 * MIB, gate: ON, prior: first, proposal: proposeHeapCeiling([], 50, 8 * GIB) });
  assert.deepEqual([tiny.mode, tiny.mode_reason], ["shadow", "below the 256 MiB floor"]);

  // An absent file keeps the inherited value, and the daemon.memory_policy row says why.
  assert.deepEqual(launchHeapCeiling(undefined, INHERITED, stateDir, t0), { ceiling_source: "inherited", reason: "absent" });
  assert.deepEqual(heapCeilingSource(INHERITED, { stateDir, read: io.readFile, clock: fixedClock(t0 + 1) }), { ceiling_source: "inherited", ceiling_unapplied: "the launcher did not apply it", learned_ceiling_mib: held.ceiling_mib });
  assert.deepEqual(heapCeilingSource(INHERITED, { stateDir: "/nowhere", read: io.readFile }), { ceiling_source: "inherited", ceiling_unapplied: "absent" });
  const denied = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  assert.deepEqual(heapCeilingSource(INHERITED, { stateDir, read: denied }), { ceiling_source: "inherited", ceiling_unapplied: "unreadable: EACCES" });
  assert.deepEqual(launchHeapCeiling("{torn", INHERITED, stateDir, t0), { ceiling_source: "inherited", reason: "unreadable" });
  assert.deepEqual(launchHeapCeiling("null", INHERITED, stateDir, t0), { ceiling_source: "inherited", reason: "unreadable" });
  const f = launcherFixture();
  try {
    assert.equal(existsSync(heapCeilingPath(f.stateDir)), false);
    assert.equal(launch(f, "daemon", INHERITED).node_options, INHERITED, "no file: the daemon starts under the inherited ceiling");
    writeFileSync(heapCeilingPath(f.stateDir), "{torn");
    assert.equal(launch(f, "daemon", INHERITED).node_options, INHERITED, "a torn file: the inherited ceiling");
    // A launch with no config at all finds the default root, as loadConfig does.
    rmSync(join(f.home, ".config"), { recursive: true });
    assert.equal(launch(f, "daemon", INHERITED).node_options, INHERITED);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("W1-T9106: the ceiling is not applied while runs are in-process", () => {
  const f = launcherFixture();
  try {
    for (const mode of ["off", "shadow"] as const) {
      const gate = runChildrenAdoptedGate(f.stateDir, () => mode);
      assert.deepEqual(gate, { applies: false, reason: `sweep.runChild.mode ${mode}: runs are in-process` });
      learnedShadow(f.stateDir, { lives: [400, 420], startMs: Date.now() - 60 * 60_000, gate }).shadow.propose();
      const file = JSON.parse(readFileSync(heapCeilingPath(f.stateDir), "utf8")) as LearnedHeapCeiling;
      assert.equal(file.mode, "shadow", "with runs in-process the ceiling is report-only");
      assert.equal(file.mode_reason, gate.reason);
      assert.equal(file.ceiling_mib, 840, "it is still learned and reported");
      assert.equal(launch(f, "daemon", INHERITED).node_options, INHERITED, "and the daemon starts under the inherited ceiling");
      assert.deepEqual(heapCeilingSource(INHERITED, { stateDir: f.stateDir }),
        { ceiling_source: "inherited", ceiling_unapplied: `shadow: sweep.runChild.mode ${mode}: runs are in-process` });
    }
    // `auto` applies only once its own evidence decides `on`; held, or its evidence unreadable, it stays in-process.
    const auto = () => "auto" as const;
    assert.equal(runChildrenAdoptedGate(f.stateDir, auto, () => ({ rows: [], unread: [] })).applies, false);
    assert.deepEqual(runChildrenAdoptedGate(f.stateDir, auto, () => ({ rows: [], unread: ["ledger.1.ndjson.gz"] })),
      { applies: false, reason: "auto's evidence is unreadable (ledger.1.ndjson.gz)" });
    const promoted = [{ step: "run_child.mode_decision", ts: "2026-10-27T00:00:00.000Z", from: "shadow", to: "on" }];
    assert.deepEqual(runChildrenAdoptedGate(f.stateDir, auto, () => ({ rows: promoted, unread: [] })),
      { applies: true, reason: "sweep.runChild.mode auto decided on: runs are adopted children" });
    assert.deepEqual(runChildrenAdoptedGate(f.stateDir, () => "on"), ON);
    const unreadable = runChildrenAdoptedGate(f.stateDir, () => { throw new Error("policy.yaml is not valid YAML"); });
    assert.deepEqual(unreadable, { applies: false, reason: "run-child mode unreadable: policy.yaml is not valid YAML" });
    // The real defaults read this installation's policy: whatever it says, the gate answers without throwing.
    assert.equal(typeof runChildrenAdoptedGate(f.stateDir).applies, "boolean");

    // The same learned ceiling, gated on: applied. Removing the gate is the falsifier this test holds.
    learnedShadow(f.stateDir, { lives: [400, 420], startMs: Date.now() - 60 * 60_000, gate: ON }).shadow.propose();
    assert.equal(launch(f, "daemon", INHERITED).node_options, "--no-deprecation --max-old-space-size=840");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("W1-T9106: the file and the instance's state directory are read defensively", () => {
  assert.deepEqual(parseLearnedHeapCeiling("{torn"), { unread: "unparseable" });
  assert.deepEqual(parseLearnedHeapCeiling("{\"version\":2}"), { unread: "not a version 1 record" });
  assert.deepEqual(parseLearnedHeapCeiling("{\"version\":1}"), { unread: "missing fields" });
  const base = { version: 1, state_dir: "/s", mode: "applied", written_at: 1, valid_until: 2, learned_since: 1 };
  assert.deepEqual(parseLearnedHeapCeiling(JSON.stringify({ ...base, ceiling_bytes: -1 })), { unread: "bad ceiling_bytes" });
  assert.equal((parseLearnedHeapCeiling(JSON.stringify(base)) as LearnedHeapCeiling).state_dir, "/s");

  assert.deepEqual(defaultHeapCeilingLocation(() => JSON.stringify({ root: "/srv/rmd" })), { stateDir: "/srv/rmd/state" });
  assert.match(defaultHeapCeilingLocation(() => { throw new Error("no config"); }).stateDir, /\/Remudero\/state$/);
  assert.match(defaultHeapCeilingLocation().stateDir, /\/state$/, "the real config read answers a state directory");

  // A shadow with an injected sample store and no ceiling store writes no ceiling; a failing store is reported.
  const io = memoryIo();
  const quiet = createHeapShadow({ path: "/q/daemon-heap-samples.json", io, snapshot: () => ({ rss_bytes: 1, heap_used_bytes: 0, heap_physical_bytes: 0, external_bytes: 0, heap_size_limit_bytes: GIB }) });
  assert.equal(quiet.propose().learned_ceiling_mode, undefined);
  assert.equal(io.files.has("/q/daemon-heap-ceiling.json"), false);
  const reasons: string[] = [];
  const failing = createHeapShadow({
    path: "/q/daemon-heap-samples.json", io, ceilingIo: { readFile: io.readFile, writeFile: () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); } },
    snapshot: () => ({ rss_bytes: 1, heap_used_bytes: 0, heap_physical_bytes: 0, external_bytes: 0, heap_size_limit_bytes: GIB }),
    ceilingGate: () => ON, budgetBytes: () => 8 * GIB, onPersistError: (reason) => reasons.push(reason),
  });
  assert.equal(failing.propose().learned_ceiling_mode, undefined, "a failed write never costs the proposal");
  assert.deepEqual(reasons, ["heap ceiling: ENOSPC"]);
  // A torn prior is learned afresh, with the default gate and budget readers.
  io.files.set("/q/daemon-heap-ceiling.json", "{torn");
  const defaults = createHeapShadow({ path: "/q/daemon-heap-samples.json", io, ceilingIo: io, snapshot: () => ({ rss_bytes: 1, heap_used_bytes: 0, heap_physical_bytes: 0, external_bytes: 0, heap_size_limit_bytes: GIB }) });
  assert.equal(defaults.propose().learned_ceiling_mode, "shadow", "no sample yet: report-only, whatever the gate says");
});
