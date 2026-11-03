import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { derivePrCheckCandidates, loadCiGateLists, type WorkflowDoc } from "#src/lib/ci-control-plane.js";

// W1-T5102 — the clock sweep runs as a matrix of shards and one merge job classifies their union.
// `scripts/**` is outside tsconfig's `include`, so the modules load through dynamic specifiers
// (the same reason test/clock-sweep.test.ts does).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptUrl = (name: string) => pathToFileURL(join(REPO_ROOT, "scripts", name)).href;

type RunResult = { failed: boolean; output?: string };
type SweepOpts = {
  argv?: string[];
  run?: (suite: string, days: number) => RunResult;
  derive?: () => string[];
  touchedAt?: () => Map<string, number>;
  now?: () => number;
  ceiling?: number;
  recorded?: string[];
  readSuite?: (suite: string) => string;
  writeJson?: (path: string, value: unknown) => void;
  log?: (m: string) => void;
  write?: (m: string) => void;
};
type ShardFile = {
  version: number; shard: number; of: number; candidates: number; runnable: number; order: string; elapsedMs: number;
  ran: string[]; unreached: string[]; results: Array<{ suite: string; failed: boolean }>;
  drift: Array<{ suite: string; fuse: number | null; titles: string[]; detail: string }>;
};
const sweep = (await import(scriptUrl("clock-sweep.mjs"))) as {
  SWEEP_BUDGET_MS: number;
  parseShard: (spec: unknown) => { i: number; n: number } | null;
  shardSlice: (suites: string[], i: number, n: number) => string[];
  browserSuites: (suites: string[], read?: (suite: string) => string) => string[];
  deriveCandidates: () => string[];
  runnableCandidates: (candidates: string[]) => string[];
  main: (opts?: SweepOpts) => number;
};
const aggregate = (await import(scriptUrl("clock-sweep-aggregate.mjs"))) as {
  SHARD_NEAR_CAP_MS: number;
  shardFile: (dir: string, i: number) => string;
  main: (opts?: {
    argv?: string[];
    readFile?: (path: string) => string;
    derive?: () => string[];
    readSuite?: (suite: string) => string;
    ceiling?: number;
    recorded?: string[];
    log?: (m: string) => void;
  }) => number;
};
const deliver = (await import(scriptUrl("clock-sweep-deliver.mjs"))) as {
  parseNewDrift: (text: string) => Array<{ suite: string; fuse: number | null; detail: string }>;
};

const MIN = 60_000;
// Built at run time so this file itself is neither a sweep candidate nor a browser-launching file
// to the censuses that grep test/ (scripts/clock-sweep.mjs's AGE_SURFACE_RE, serve-browser-teardown).
const AGE_TOKEN = ["stale", "Days"].join("");
const LAUNCH_CALL = ["chromium", "launch("].join(".");
const SUITES = ["alpha", "bravo", "charlie", "delta", "echo"];
/** bravo and delta pass today and fail from +7 days: the drift shape, with a fuse to bisect. */
const drifting = new Set(["bravo", "delta"]);
const fakeRun = (suite: string, days: number): RunResult =>
  drifting.has(suite) && days >= 7 ? { failed: true, output: `not ok 1 - ${suite} expiry\n  ---\n  error: stale at +${days}\n  ...\n` } : { failed: false, output: "" };
const noHistory = () => {
  throw new Error("not a git repository");
};

/** One in-process shard run over SUITES; its results file lands in `files`. */
function runShard(i: number, n: number, files: Map<string, string>, opts: Partial<SweepOpts> = {}) {
  const lines: string[] = [];
  const order: string[] = [];
  let t = 0;
  const { run: inner = fakeRun, ...rest } = opts;
  const code = sweep.main({
    argv: ["--shard", `${i}/${n}`, "--results-out", aggregate.shardFile("d", i)],
    derive: () => SUITES,
    // Every suite run costs one fake minute, whatever `opts.run` decides about its verdict.
    run: (suite, days) => {
      if (days === 400) order.push(suite);
      t += MIN;
      return inner(suite, days);
    },
    touchedAt: noHistory,
    now: () => t,
    writeJson: (path, value) => void files.set(path, JSON.stringify(value)),
    log: (m) => lines.push(m),
    write: (m) => lines.push(m),
    ...rest,
  });
  return { code, lines, order };
}

function readFrom(files: Map<string, string>) {
  return (path: string): string => {
    const text = files.get(path);
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return text;
  };
}

function merge(files: Map<string, string>, n: number, opts: { derive?: () => string[]; readSuite?: (s: string) => string } = {}) {
  const lines: string[] = [];
  const code = aggregate.main({
    argv: ["--dir", "d", "--shards", String(n)],
    readFile: readFrom(files),
    derive: opts.derive ?? (() => SUITES),
    readSuite: opts.readSuite ?? (() => ""),
    ceiling: 11,
    recorded: [],
    log: (m) => lines.push(m),
  });
  return { code, lines, text: lines.join("\n") };
}

test("W1-T5102: every runnable suite lands in exactly one shard", () => {
  const population = Array.from({ length: 23 }, (_, k) => `suite-${String(k).padStart(2, "0")}`).reverse();
  for (const n of [1, 2, 6, 10, 23, 40]) {
    const slices = Array.from({ length: n }, (_, k) => sweep.shardSlice(population, k + 1, n));
    const all = slices.flat();
    assert.equal(all.length, population.length, `n=${n}: every suite is in some shard`);
    assert.equal(new Set(all).size, population.length, `n=${n}: no suite is in two shards`);
    assert.deepEqual([...all].sort(), [...population].sort());
    // Round-robin over the NAME order: the first shard holds the first name, never an empty last shard while others overflow.
    assert.equal(slices[0]![0], "suite-00");
    assert.ok(Math.max(...slices.map((s) => s.length)) - Math.min(...slices.map((s) => s.length)) <= 1, `n=${n}: shards differ by at most one suite`);
  }
});

test("W1-T5102: the slice is the same with and without readable git history", () => {
  const history = () => new Map(SUITES.map((s, k) => [s, 1000 - k * 7] as [string, number]).reverse());
  for (const i of [1, 2]) {
    const withHistory = runShard(i, 2, new Map(), { touchedAt: history });
    const without = runShard(i, 2, new Map(), { touchedAt: noHistory });
    assert.deepEqual([...withHistory.order].sort(), [...without.order].sort(), `shard ${i}/2 holds the same suites either way`);
    assert.deepEqual([...without.order].sort(), sweep.shardSlice(SUITES, i, 2));
    assert.match(without.lines.join("\n"), /order: name \(git history unreadable\)/);
    assert.match(withHistory.lines.join("\n"), /order: newest-touched first/);
  }
});

test("W1-T5102: a one-shard sweep prints and exits exactly as the unsharded sweep", () => {
  const drive = (argv: string[]) => {
    const lines: string[] = [];
    let t = 0;
    const code = sweep.main({
      argv, derive: () => SUITES, touchedAt: noHistory, now: () => t, ceiling: 11, recorded: ["bravo"], readSuite: () => "",
      run: (suite, days) => ((t += MIN), fakeRun(suite, days)),
      log: (m) => lines.push(m), write: (m) => lines.push(m),
    });
    return { code, text: lines.join("\n") };
  };
  const plain = drive([]);
  const oneShard = drive(["--shard", "1/1"]);
  assert.equal(oneShard.text, plain.text);
  assert.equal(oneShard.code, plain.code);
  // Control: delta is NEW drift, so both fail the same way and name it.
  assert.equal(plain.code, 1);
  assert.match(plain.text, /NEW DRIFT — 1 suite\(s\)/);
  assert.ok(!/shard 1\/1/.test(plain.text), "a single sweep prints no shard line");
});

test("W1-T5102: a malformed shard spec or a sharded run with no results file is refused", () => {
  for (const argv of [["--shard", "0/3"], ["--shard", "4/3"], ["--shard", "1/65"], ["--shard", "a/b"], ["--shard"]]) {
    const lines: string[] = [];
    let ran = 0;
    const code = sweep.main({ argv, derive: () => SUITES, run: () => ((ran += 1), { failed: false }), log: (m) => lines.push(m), write: () => {} });
    assert.equal(code, 2, `${argv.join(" ")} is refused`);
    assert.match(lines.join("\n"), /--shard wants i\/n/);
    assert.equal(ran, 0, "nothing runs before the refusal");
  }
  for (const argv of [["--shard", "2/3"], ["--results-out"]]) {
    const lines: string[] = [];
    const code = sweep.main({ argv, derive: () => SUITES, run: () => assert.fail("a refused sweep runs nothing"), log: (m) => lines.push(m), write: () => {} });
    assert.equal(code, 2);
    assert.match(lines.join("\n"), /needs --results-out <path>/);
  }
  // The listing a shard job prints needs no results file.
  const listed: string[] = [];
  assert.equal(sweep.main({ argv: ["--list", "--shard", "2/2"], derive: () => SUITES, log: (m) => listed.push(m) }), 0);
  assert.match(listed.join("\n"), /shard 2\/2 {10}: 2 suites/);
  assert.ok(listed.some((l) => l.endsWith("  bravo")) && !listed.some((l) => l.endsWith("  alpha")), "the list is the slice, not the population");
});

test("W1-T5102: a shard writes its results file and classifies nothing itself", () => {
  const files = new Map<string, string>();
  const history = () => new Map([["delta", 900], ["bravo", 100]]);
  const r = runShard(2, 2, files, { touchedAt: history });
  assert.equal(r.code, 0, "a shard with drift but nothing unreached exits 0: the merge judges drift");
  assert.deepEqual(r.order, ["delta", "bravo"], "the shard's own slice runs newest-touched first");
  const shard = JSON.parse(files.get(aggregate.shardFile("d", 2))!) as ShardFile;
  assert.equal(shard.version, 1);
  assert.deepEqual([shard.shard, shard.of, shard.candidates, shard.runnable], [2, 2, 5, 5]);
  assert.deepEqual(shard.ran, ["delta", "bravo"]);
  assert.deepEqual(shard.unreached, []);
  assert.equal(shard.order, "newest-touched first");
  assert.equal(shard.elapsedMs > 0, true);
  assert.deepEqual(shard.drift.map((d) => [d.suite, d.fuse, d.titles]), [["delta", 7, ["delta expiry"]], ["bravo", 7, ["bravo expiry"]]]);
  assert.match(shard.drift[0]!.detail, /stale at \+400/);
  const text = r.lines.join("\n");
  assert.ok(!/WALL-CLOCK DRIFT|NEW DRIFT|CEILING|PASS —/.test(text), "a shard prints no verdict of its own");
  assert.match(text, /shard 2\/2 wrote d\/clock-sweep-shard-2\.json: 2 run, 2 failing/);

  // A shard cut off by its budget still writes what it ran, names the rest, and exits 1.
  const cut = new Map<string, string>();
  let t = 0;
  const code = sweep.main({
    argv: ["--shard", "1/1", "--results-out", "cut.json"], derive: () => SUITES, touchedAt: noHistory, now: () => t,
    run: () => ((t += 10 * MIN), { failed: false }), writeJson: (p, v) => void cut.set(p, JSON.stringify(v)), log: () => {}, write: () => {},
  });
  assert.equal(code, 1);
  const partial = JSON.parse(cut.get("cut.json")!) as ShardFile;
  assert.deepEqual(partial.ran, ["alpha", "bravo", "charlie"]);
  assert.deepEqual(partial.unreached, ["delta", "echo"]);
});

test("W1-T5102: the merged report equals the unsharded report over the same results", () => {
  const files = new Map<string, string>();
  runShard(1, 2, files);
  runShard(2, 2, files);
  const merged = merge(files, 2);
  const lines: string[] = [];
  let t = 0;
  const plainCode = sweep.main({
    argv: [], derive: () => SUITES, touchedAt: noHistory, now: () => t, ceiling: 11, recorded: [], readSuite: () => "",
    run: (suite, days) => ((t += MIN), fakeRun(suite, days)), log: (m) => lines.push(m), write: () => {},
  });
  const report = (all: string[]) => all.slice(all.indexOf(""));
  assert.deepEqual(report(merged.lines), report(lines));
  assert.equal(merged.code, plainCode);
  assert.equal(merged.code, 1, "two NEW drifting suites fail both");
  assert.match(merged.text, /shards {13}: 2\/2 present/);
  assert.match(merged.text, /WALL-CLOCK DRIFT — 2 suite\(s\)/);
  // The positive control: the same merge with no drift passes.
  const clean = new Map<string, string>();
  runShard(1, 2, clean, { run: () => ({ failed: false }) });
  runShard(2, 2, clean, { run: () => ({ failed: false }) });
  const passed = merge(clean, 2);
  assert.equal(passed.code, 0);
  assert.match(passed.text, /PASS — 5 suite\(s\) immune at \+400d\./);
});

test("W1-T5102: the merged report is read by the new-drift delivery parser", () => {
  const files = new Map<string, string>();
  runShard(1, 2, files);
  runShard(2, 2, files);
  const entries = deliver.parseNewDrift(merge(files, 2).text);
  assert.deepEqual(entries.map((e) => [e.suite, e.fuse]), [["bravo", 7], ["delta", 7]]);
  assert.match(entries[0]!.detail, /failing test {2}: bravo expiry/);
});

test("W1-T5102: a missing shard is named with its suites and the merge fails", () => {
  const files = new Map<string, string>();
  runShard(1, 2, files, { run: () => ({ failed: false }) });
  const r = merge(files, 2);
  assert.equal(r.code, 1);
  assert.match(r.text, /shards {13}: 1\/2 present/);
  assert.match(r.text, /MISSING SHARD 2\/2 — no results file; its 2 suite\(s\) were never reported: bravo, delta/);
  assert.ok(!/PASS —/.test(r.text), "a partial sweep never reports PASS");
  // A present-but-unusable file is named by its own reason, not as an absent one.
  files.set(aggregate.shardFile("d", 2), "{not json");
  assert.match(merge(files, 2).text, /MISSING SHARD 2\/2 — not valid JSON/);
  files.set(aggregate.shardFile("d", 2), JSON.stringify({ version: 2 }));
  assert.match(merge(files, 2).text, /MISSING SHARD 2\/2 — not a version 1 results file/);
  const unreadable = aggregate.main({
    argv: ["--dir", "d", "--shards", "1"], derive: () => SUITES, readSuite: () => "", log: () => {},
    readFile: () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
  });
  assert.equal(unreadable, 1);
});

test("W1-T5102: shards that disagree on the population fail the merge", () => {
  const files = new Map<string, string>();
  runShard(1, 2, files, { run: () => ({ failed: false }) });
  runShard(2, 2, files, { run: () => ({ failed: false }) });
  assert.equal(merge(files, 2).code, 0, "the control: agreeing shards pass");

  const grown = merge(files, 2, { derive: () => [...SUITES, "foxtrot"] });
  assert.equal(grown.code, 1);
  assert.match(grown.text, /SHARDS DISAGREE/);
  assert.match(grown.text, /shard 1 derived 5 candidates, this checkout derives 6/);
  assert.match(grown.text, /1 suite\(s\) in no shard: foxtrot/);

  const wrongCount = merge(files, 3);
  assert.equal(wrongCount.code, 1);
  assert.match(wrongCount.text, /shard 1 recorded 1\/2, but --shards is 3/);

  const swapped = new Map(files);
  swapped.set(aggregate.shardFile("d", 2), files.get(aggregate.shardFile("d", 1))!);
  const overlap = merge(swapped, 2);
  assert.equal(overlap.code, 1);
  assert.match(overlap.text, /shard file 2 recorded itself as shard 1\/2/);
  assert.match(overlap.text, /alpha is in shard 1 and shard 2/);

  const foreign = new Map(files);
  const one = JSON.parse(files.get(aggregate.shardFile("d", 1))!) as ShardFile;
  foreign.set(aggregate.shardFile("d", 1), JSON.stringify({ ...one, ran: [...one.ran, "zulu"] }));
  assert.match(merge(foreign, 2).text, /1 suite\(s\) not in this checkout's population: zulu/);

  for (const argv of [["--dir", "d"], ["--shards", "2"], ["--dir", "d", "--shards", "0"], ["--dir", "d", "--shards", "65"]]) {
    const lines: string[] = [];
    assert.equal(aggregate.main({ argv, readFile: () => assert.fail("nothing is read"), derive: () => SUITES, log: (m) => lines.push(m) }), 2);
    assert.match(lines.join("\n"), /wants --dir <dir> --shards <n>/);
  }
});

test("W1-T5102: a shard near its cap is a warning and a normal shard prints none", () => {
  const files = new Map<string, string>();
  runShard(1, 2, files, { run: () => ({ failed: false }) });
  runShard(2, 2, files, { run: () => ({ failed: false }) });
  const normal = merge(files, 2);
  assert.equal(normal.code, 0);
  assert.match(normal.text, /shard 1\/2 {2}3 suites {2}3\.0 min of a 30-minute cap/);
  assert.ok(!/SHARD NEAR CAP/.test(normal.text), "a normal shard prints no warning");

  const slow = JSON.parse(files.get(aggregate.shardFile("d", 2))!) as ShardFile;
  files.set(aggregate.shardFile("d", 2), JSON.stringify({ ...slow, elapsedMs: aggregate.SHARD_NEAR_CAP_MS }));
  const near = merge(files, 2);
  assert.equal(near.code, 0, "a warning never fails the merge");
  assert.match(near.text, /SHARD NEAR CAP — shard 2\/2 took 20\.0 min of its 30-minute cap/);
  assert.match(near.text, /extend the matrix list in \.github\/workflows\/clock-sweep\.yml/);
});

test("W1-T5102: the real population holds no browser-launching suite", () => {
  const population = sweep.runnableCandidates(sweep.deriveCandidates());
  assert.ok(population.length > 100, `the population is the real one (${population.length} suites)`);
  // Positive control on the same reader: a real browser-launching file IS detected.
  assert.deepEqual(sweep.browserSuites(["serve-browser-teardown", "no-such-suite-anywhere"]), ["serve-browser-teardown"]);
  assert.deepEqual(sweep.browserSuites(population), [], "no sweep job installs Chromium, so none may need it");
});

test("W1-T5102: a browser-launching suite in the population fails the report", () => {
  const files = new Map<string, string>();
  runShard(1, 2, files, { run: () => ({ failed: false }) });
  runShard(2, 2, files, { run: () => ({ failed: false }) });
  const r = merge(files, 2, { readSuite: (s) => (s === "charlie" ? `const browser = await ${LAUNCH_CALL});` : "") });
  assert.equal(r.code, 1);
  assert.match(r.text, /BROWSER SUITES IN THE POPULATION — 1 suite\(s\) launch a browser/);
  assert.match(r.text, /test\/charlie\.test\.ts/);
  assert.match(r.text, /npx playwright install chromium/);
  assert.ok(!/PASS —/.test(r.text));
});

test("W1-T5102: the real CLIs shard a throwaway checkout and merge its results", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-clock-sweep-shards-"));
  try {
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    mkdirSync(join(root, "test", "setup"), { recursive: true });
    // runSuite imports the suite preload (W1-T9587); the throwaway checkout carries an inert stand-in.
    writeFileSync(join(root, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
    for (const f of ["clock-sweep.mjs", "clock-sweep-aggregate.mjs", "clock-sweep-baseline.json", "clock-shift.mjs", "lib/argv.mjs", "lib/repo-root.mjs"]) {
      copyFileSync(join(REPO_ROOT, "scripts", f), join(root, "scripts", f));
    }
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), '{ "type": "module" }\n');
    for (const s of SUITES) {
      writeFileSync(join(root, "test", `${s}.test.ts`), `import { test } from "node:test";\n// ${AGE_TOKEN} guard over a ${["2026", "01", "01"].join("-")} fixture\ntest("${s}", () => {});\n`);
    }
    // The child is a nested `node --test` parent: blank the coverage session and the runner marker (W1-T2292).
    const env = { ...process.env, NODE_V8_COVERAGE: "", NODE_TEST_CONTEXT: undefined };
    const cli = (script: string, args: string[]) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [join("scripts", script), ...args], { cwd: root, env, encoding: "utf8" }) };
      } catch (e) {
        const err = e as { status: number; stdout: string };
        return { code: err.status, out: err.stdout };
      }
    };
    mkdirSync(join(root, "shards"));
    for (const i of [1, 2]) {
      const r = cli("clock-sweep.mjs", ["--shard", `${i}/2`, "--results-out", join("shards", `clock-sweep-shard-${i}.json`)]);
      assert.equal(r.code, 0, r.out);
      assert.ok(existsSync(join(root, "shards", `clock-sweep-shard-${i}.json`)), `shard ${i} wrote its file`);
    }
    const ran = [1, 2].map((i) => (JSON.parse(readFileSync(join(root, "shards", `clock-sweep-shard-${i}.json`), "utf8")) as ShardFile).ran.sort());
    assert.deepEqual(ran, [["alpha", "charlie", "echo"], ["bravo", "delta"]], "the two slices partition the five suites");
    const merged = cli("clock-sweep-aggregate.mjs", ["--dir", "shards", "--shards", "2"]);
    assert.equal(merged.code, 0, merged.out);
    assert.match(merged.out, /PASS — 5 suite\(s\) immune at \+400d\./);
    rmSync(join(root, "shards", "clock-sweep-shard-2.json"));
    const missing = cli("clock-sweep-aggregate.mjs", ["--dir", "shards", "--shards", "2"]);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /MISSING SHARD 2\/2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the workflow and the registry ──────────────────────────────────────────────────────────────

const WORKFLOW_TEXT = readFileSync(join(REPO_ROOT, ".github", "workflows", "clock-sweep.yml"), "utf8");
type Step = { name?: string; id?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { name?: string; needs?: string; if?: string; "timeout-minutes"?: number; strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } }; permissions?: Record<string, string>; steps: Step[] };
const WORKFLOW = parseYaml(WORKFLOW_TEXT) as { jobs: Record<string, Job> };
const SHARD_JOB = WORKFLOW.jobs["clock-sweep"]!;
const REPORT_JOB = WORKFLOW.jobs["clock-sweep-report"]!;
const N = SHARD_JOB.strategy?.matrix?.shard?.length ?? 0;
const step = (job: Job, name: string) => {
  const hit = job.steps.find((s) => s.name === name);
  assert.ok(hit, `step "${name}" must exist`);
  return hit;
};

test("W1-T5102: the workflow runs the shard matrix and merges every shard", () => {
  assert.ok(N >= 2, `the matrix shards the sweep (got ${N})`);
  assert.deepEqual(SHARD_JOB.strategy?.matrix?.shard, Array.from({ length: N }, (_, k) => k + 1));
  assert.equal(SHARD_JOB.strategy?.["fail-fast"], false, "one cancelled shard must not cancel its siblings");
  assert.equal(SHARD_JOB.name, `clock-sweep shard (\${{ matrix.shard }}/${N})`);
  assert.equal(SHARD_JOB["timeout-minutes"], 30);
  assert.deepEqual(SHARD_JOB.permissions, { contents: "read" }, "a shard writes no issue");
  assert.match(step(SHARD_JOB, "What this sweep will run (and what it will never run)").run!, new RegExp(`--list --shard "\\$\\{SHARD\\}/${N}"`));
  const sweepRun = step(SHARD_JOB, "Sweep this shard at +400d").run!;
  assert.match(sweepRun, /set -o pipefail/);
  assert.match(sweepRun, new RegExp(`--shard "\\$\\{SHARD\\}/${N}" --results-out "clock-sweep-shard-\\$\\{SHARD\\}\\.json"`));
  const upload = step(SHARD_JOB, "Upload this shard's results");
  assert.equal(upload.if, "always()");
  assert.equal(upload.with?.name, "clock-sweep-shard-${{ matrix.shard }}", "each shard uploads its own artifact name");
  assert.equal(REPORT_JOB.needs, "clock-sweep");
  assert.equal(REPORT_JOB.if, "always()");
  assert.equal(step(REPORT_JOB, "Download every shard's results").with?.pattern, "clock-sweep-shard-*");
  const mergeStep = step(REPORT_JOB, "Merge the shard reports and classify");
  assert.equal(mergeStep.id, "sweep");
  assert.match(mergeStep.run!, new RegExp(`node scripts/clock-sweep-aggregate\\.mjs --dir shards --shards ${N} \\| tee sweep-report\\.txt`));
  assert.match(mergeStep.run!, /set -o pipefail/);
});

test("W1-T5102: the merge job delivers and resolves under the same guards as before", () => {
  const raise = step(REPORT_JOB, "Open or update a needs-human issue on drift");
  assert.equal(raise.if, "(failure() || cancelled()) && github.event_name != 'pull_request'");
  assert.equal(raise.env?.SWEEP_OUTCOME, "${{ steps.sweep.outcome }}");
  assert.equal(raise.env?.SHARDS_RESULT, "${{ needs.clock-sweep.result }}");
  assert.equal(step(REPORT_JOB, "Open one needs-human issue per NEW drifting suite").if, "failure() && github.event_name != 'pull_request'");
  const resolve = step(REPORT_JOB, "Close this job's needs-human issue once it recovers");
  assert.equal(resolve.if, "success() && github.event_name != 'pull_request'");
  // The resolver requires the shards to have succeeded THROUGH the merge step it follows: that step
  // exits 0 only when every shard uploaded a complete results file that agrees with the others
  // (the missing-shard and disagreement cases above), so success() here cannot outrun a failed shard.
  const at = (name: string) => REPORT_JOB.steps.findIndex((s) => s.name === name);
  assert.ok(at("Merge the shard reports and classify") < at("Close this job's needs-human issue once it recovers"));
  assert.equal(REPORT_JOB.steps.filter((s) => s.uses?.startsWith("actions/download-artifact@")).length, 1);
  assert.equal(step(REPORT_JOB, "Upload the sweep report").if, "always()");
  assert.equal(REPORT_JOB.permissions?.issues, "write");
  for (const s of SHARD_JOB.steps) assert.ok(!/needs-human-issue|clock-sweep-deliver/.test(s.run ?? ""), `shard step "${s.name}" delivers nothing`);
});

test("W1-T5102: every shard and the merge job is registered in the ci-gate advisory list", () => {
  const candidates = derivePrCheckCandidates(".github/workflows/clock-sweep.yml", WORKFLOW as unknown as WorkflowDoc);
  const expected = [...Array.from({ length: N }, (_, k) => `clock-sweep shard (${k + 1}/${N})`), "clock-sweep-report (merge the shards, classify, deliver)"];
  assert.deepEqual(candidates, expected, "the names the control plane expands from the matrix");
  const { advisory, required } = loadCiGateLists(REPO_ROOT);
  for (const name of expected) {
    assert.ok(advisory.has(name), `${name} is ADVISORY`);
    assert.ok(!required.has(name), `${name} never holds a merge`);
  }
  assert.ok(![...advisory].some((name) => name.startsWith("clock-sweep (")), "the retired single-job name is gone");
});
