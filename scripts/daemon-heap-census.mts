#!/usr/bin/env node
// scripts/daemon-heap-census.mts — W1-T9647: THE OFFLINE CENSUS OF WHAT HOLDS THE DAEMON'S HEAP.
//
// NEVER run by the daemon, and never pointed at a live process. It builds each holder the daemon keeps, at
// production scale, in THIS private process, and measures what the holder RETAINS: collect twice and read the heap,
// drop the holder, collect twice and read again (src/lib/daemon-memory-census.ts measureHeapHolders). A module graph
// and Node's source-map cache cannot be dropped in-process, so each is measured in a fresh child process of its own.
// Heap snapshots and forced collections are allowed HERE only (operator rule, 2026-10-15).
//
//   node --expose-gc --import tsx scripts/daemon-heap-census.mts --out <dir> (--synthetic <work dir> | --state <private copy root>)
//        [--plan plan/tasks.yaml] [--live-set-bytes N] [--rotations N] [--rows-per-rotation N] [--closed-prs N]
//        [--body-chars N] [--issues N] [--owner o --repo r] [--write-calibration] [--snapshot] [--skip <name,...>]
//
// --synthetic writes a production-scale corpus into <work dir>/state: N gzipped rotations of the daemon-read steps
// at their observed shares plus padding rows, a live file, and a board snapshot cache of closed PRs and issues.
// Defaults are the shape OBSERVED on the fleet host (sources inline below). --state reads a PRIVATE COPY (never the
// live state dir: the census writes rotation digests under <root>/state/cache).
//
// Output: <out>/census.json (the ranking, each proposed_task stub and the calibration) and <out>/census.md (the
// ranked table). THE RULE: every holder marked **file** becomes its own filed task, citing its census line and its
// daemon.memory holder series (see src/lib/daemon-memory-census.ts's module doc).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeHeapSnapshot } from "node:v8";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const num = (name: string, fallback: number): number => Number(flag(name) ?? fallback);
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  console.error("daemon-heap-census: run with node --expose-gc --import tsx (it measures retained heap by collecting)");
  process.exit(2);
}
const out = flag("--out");
const synthetic = flag("--synthetic");
const stateCopy = flag("--state");
if (!out || (!synthetic && !stateCopy)) {
  console.error("usage: node --expose-gc --import tsx scripts/daemon-heap-census.mts --out <dir> (--synthetic <work dir> | --state <private copy root>)");
  process.exit(2);
}
const skip = new Set((flag("--skip") ?? "").split(",").filter(Boolean));
const owner = flag("--owner") ?? "craigoley";
const repo = flag("--repo") ?? "remudero";
const census = await import("../src/lib/daemon-memory-census.ts");
const { createIncrementalLedgerUnion, createLedgerRotationMemo, ledgerRotationEntries } = await import("../src/lib/ledger-union.ts");
const { loadPlan } = await import("../src/lib/plan.ts");
const { createBoardSnapshotCache } = await import("../src/lib/board-snapshot-cache.ts");
const { createEscalationTriageHistoryReader, ESCALATION_TRIAGE_EVIDENCE_SLICE, ESCALATION_TRIAGE_HISTORY_SLICE, ESCALATION_REJUDGED_STEP } =
  await import("../src/lib/sweep.ts");
const { isMergeCreditLine } = await import("../src/lib/status.ts");
const { DISPATCH_VALUE_LEDGER_STEPS } = await import("../src/lib/dispatch-value.ts");
const { projectDispatchLedgerRow } = await import("../src/run-task.ts");

const DISPATCH_STEPS = [...DISPATCH_VALUE_LEDGER_STEPS, "dispatch.cost_of_delay.fallback", "dispatch.cost_of_delay.ready", "dispatch.refused_already_merged"];
const log = (line: string): void => console.error(`[census] ${line}`);

// ── the corpus ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The synthetic shape. OBSERVED: 369 rotations in the core state dir (listing, 2026-10-15 19:25Z); 3.97 M lines over
 * 446 rotations, 1.78 GB decompressed, 61,803 dispatch-selection rows kept (createIncrementalLedgerUnion's doc,
 * 2026-10-10) → ~8,900 rows a rotation, ~450 bytes a row, dispatch steps 1.56% of rows; the board snapshot file is
 * 37 MB, and PR numbers pass 12,100 (→ ~12,000 closed rows of ~2.6 KB body); the label-scoped issue set measured ~524
 * rows (open-prs-rest.ts, 2026-08-24). INFERRED (no read of the live corpus was made): the shares of the escalation
 * and fix steps and the merged share of verdicts.
 */
const shape = {
  rotations: num("--rotations", 369),
  rowsPerRotation: num("--rows-per-rotation", 8_900),
  liveRows: num("--live-rows", 18_000),
  closedPrs: num("--closed-prs", 12_000),
  bodyChars: num("--body-chars", 2_600),
  issues: num("--issues", 600),
  shares: {
    "run.start": 0.006, verdict: 0.008, "verdict.merged": 0.0015, "dispatch.cost_of_delay.fallback": 0.0001, "dispatch.cost_of_delay.ready": 0.0001,
    "dispatch.refused_already_merged": 0.0001, "escalation.issue_opened": 0.0008, "escalation.demoted": 0.0004, "escalation.auto_resolve_started": 0.0004,
    [ESCALATION_REJUDGED_STEP]: 0.0008, "fix.dispatch": 0.003, "escalation.auto_resolve_attempted": 0.0004, "panel.escalation_marked_handled": 0.0002,
  } as Record<string, number>,
};

let counter = 0;
const word = (n: number): string => {
  counter = (counter * 1103515245 + 12345) & 0x7fffffff;
  const base = counter.toString(36).padEnd(8, "q");
  return base.repeat(Math.ceil(n / base.length)).slice(0, n);
};

function syntheticRow(step: string, ts: string, i: number): Record<string, unknown> {
  const task = `W1-T${1000 + (i % 8_700)}`;
  const head = { ts, host: "db7831712bc4", actor: "daemon", actor_pid: 4960, run_id: `${task}-${word(10)}`, task_id: task, step };
  switch (step) {
    case "run.start": return { ...head, task_class: "implement", stage: "start", key: word(16), reason: word(60) };
    case "verdict": return { ...head, verdict: i % 3 === 0 ? "merged" : "failed", cost_usd: (i % 97) / 7, stage: "review", reason: word(140), pr_number: i % 12_000 };
    case "verdict.merged": return { ...head, verdict: "merged", cost_usd: (i % 89) / 5, pr_number: i % 12_000, sha: word(40) };
    case "fix.dispatch": return { ...head, pr_number: i % 12_000, fix_class: "ci", reason: word(220), issue_url: `https://github.com/${owner}/${repo}/issues/${i % 9000}` };
    default:
      if (step.startsWith("escalation.") || step.startsWith("panel.")) {
        return { ...head, issue_url: `https://github.com/${owner}/${repo}/issues/${i % 9000}`, triage_subject: word(90), state_key: word(24), reason: word(200) };
      }
      if (step.startsWith("dispatch.")) return { ...head, key: word(64), reasons: [word(40), word(40)], plan_tree_sha: word(40) };
      return { ...head, step: `sweep.noise_${i % 37}`, detail: word(300), n: i };
  }
}

function syntheticLines(rows: number, startMs: number): string {
  const steps = Object.entries(shape.shares);
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    const ts = new Date(startMs + i * 40).toISOString();
    let pick = ((i * 2654435761) >>> 0) / 2 ** 32;
    let step = "noise";
    for (const [name, share] of steps) {
      if (pick < share) { step = name; break; }
      pick -= share;
    }
    lines.push(JSON.stringify(syntheticRow(step, ts, i)));
  }
  return `${lines.join("\n")}\n`;
}

function writeSyntheticCorpus(root: string): void {
  const stateDir = join(root, "state");
  if (existsSync(join(stateDir, "ledger.ndjson"))) {
    log(`reusing the synthetic corpus at ${stateDir}`);
    return;
  }
  mkdirSync(stateDir, { recursive: true });
  let ms = Date.parse("2026-09-01T00:00:00.000Z");
  for (let r = 0; r < shape.rotations; r++) {
    const body = syntheticLines(shape.rowsPerRotation, ms);
    ms += shape.rowsPerRotation * 40 + 1000;
    writeFileSync(join(stateDir, `ledger.${new Date(ms).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`), gzipSync(body, { level: 1 }));
  }
  writeFileSync(join(stateDir, "ledger.ndjson"), syntheticLines(shape.liveRows, ms + 10_000));
  // The board snapshot cache, written through the cache's own commit so its on-disk format is the real one.
  const cache = createBoardSnapshotCache(root, owner, repo);
  const pr = (n: number) => ({ number: n, url: `https://github.com/${owner}/${repo}/pull/${n}`, state: n % 5 === 0 ? "CLOSED" : "MERGED",
    headRefName: `run-W1-T${n}-${1760000000000 + n}`, headRefOid: word(40), body: word(shape.bodyChars), autoMergeRequest: null,
    title: `feat(x): ${word(70)}`, updatedAt: new Date(ms - n * 1000).toISOString(), mergedAt: new Date(ms - n * 1000).toISOString(),
    createdAt: new Date(ms - n * 2000).toISOString() });
  cache.commitClosed(Array.from({ length: shape.closedPrs }, (_, i) => pr(i + 1)));
  cache.commitIssues(Array.from({ length: shape.issues }, (_, i) => ({ number: 20_000 + i, url: `https://github.com/${owner}/${repo}/issues/${20_000 + i}`,
    state: "closed", title: word(80), updatedAt: new Date(ms - i * 1000).toISOString() })));
  log(`wrote ${shape.rotations} rotations x ${shape.rowsPerRotation} rows, ${shape.liveRows} live rows, ${shape.closedPrs} closed PRs, ${shape.issues} issues`);
}

const corpusRoot = resolve(synthetic ?? stateCopy!);
if (synthetic) writeSyntheticCorpus(corpusRoot);
const stateDir = join(corpusRoot, "state");
if (!existsSync(join(stateDir, "ledger.ndjson"))) {
  console.error(`daemon-heap-census: no ledger at ${stateDir}`);
  process.exit(2);
}
const rotationEntries = ledgerRotationEntries(readdirSync(stateDir), stateDir);

// ── the live set the shares are taken of ──────────────────────────────────────────────────────────────────────────

/** OBSERVED 2026-10-15: daemon.slack_reclaim heap_used_after_bytes p50 867 MiB (n=282), the W1-T9647 filing. */
const liveSetBytes = num("--live-set-bytes", 867 * 1024 * 1024);

// ── the holders ──────────────────────────────────────────────────────────────────────────────────────────────────

const planPath = resolve(flag("--plan") ?? join(ROOT, "plan", "tasks.yaml"));
let heldPlan: { tasks: unknown[] } | undefined;
const planFiles = ["src/lib/plan.ts", "src/lib/daemon.ts", "src/run-task.ts", "src/lib/read-plane.ts"];

/** A fresh child process importing the daemon's entry: what the module graph and its source maps retain. */
function moduleChild(): { modules: number; graph_bytes: number; maps_parsed: number; maps_bytes: number; bytecode_bytes: number; script_source_bytes: number } {
  const code = `
    import { registerHooks, findSourceMap } from "node:module";
    import { getHeapCodeStatistics } from "node:v8";
    const loaded = new Set();
    registerHooks({ load(url, context, next) { if (url.startsWith("file:")) loaded.add(url); return next(url, context); } });
    const settle = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
    const before = settle();
    await import(${JSON.stringify(pathToFileURL(join(ROOT, "src", "run-task.ts")).href)});
    const afterImport = settle();
    const code = getHeapCodeStatistics();
    let parsed = 0;
    for (const url of loaded) if (findSourceMap(url)) parsed += 1;
    const afterMaps = settle();
    console.log(JSON.stringify({ modules: loaded.size, graph_bytes: afterImport - before, maps_parsed: parsed, maps_bytes: afterMaps - afterImport,
      bytecode_bytes: code.bytecode_and_metadata_size, script_source_bytes: code.external_script_source_size, source_maps_enabled: process.sourceMapsEnabled }));
    process.exit(0);`;
  const run = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", code], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const line = run.stdout.trim().split("\n").at(-1) ?? "";
  if (run.status !== 0 || !line.startsWith("{")) throw new Error(`module child failed (${run.status}): ${run.stderr.slice(-400)}`);
  return JSON.parse(line);
}
let moduleReading: ReturnType<typeof moduleChild> | undefined;
const moduleRead = (): ReturnType<typeof moduleChild> => (moduleReading ??= moduleChild());

let creditMemoKeep: unknown;
const specs: import("../src/lib/daemon-memory-census.ts").CensusHolderSpec[] = [
  {
    name: "plan parse (loadPlan)", holder: "plan-copies", calibrationKey: "plan.task", files: planFiles,
    build: () => {
      const plan = loadPlan(planPath) as unknown as { tasks: unknown[] };
      return { value: plan, entries: plan.tasks.length };
    },
  },
  {
    name: "tick-read plan clone (structuredClone)", holder: "plan-copies", files: ["src/lib/read-plane.ts", "src/run-task.ts"],
    build: () => {
      heldPlan ??= loadPlan(planPath) as unknown as { tasks: unknown[] };
      gc();
      return { value: structuredClone({ plan: heldPlan }), entries: heldPlan.tasks.length };
    },
  },
  {
    name: "dispatch-selection union (dispatch-value)", holder: "incremental-union:dispatch-value", files: ["src/run-task.ts", "src/lib/ledger-union.ts"],
    build: () => {
      const union = createIncrementalLedgerUnion({ holder: "census-dispatch-value", reducerVersion: "2", project: projectDispatchLedgerRow });
      const read = union(stateDir, { step: DISPATCH_STEPS, refuseIncomplete: true });
      return { value: union, entries: read.rows.length };
    },
  },
  {
    name: "escalation-triage history reader", holder: "incremental-union:sweep.escalation-triage-history", files: ["src/lib/sweep.ts"],
    build: async () => {
      const reader = createEscalationTriageHistoryReader({ slice: { ...ESCALATION_TRIAGE_HISTORY_SLICE, holder: "census-escalation-triage-history" } });
      const read = await reader(stateDir);
      return { value: reader, entries: read.rows.length };
    },
  },
  {
    name: "escalation-triage evidence reader", holder: "incremental-union:run-task.escalation-triage-evidence", files: ["src/lib/sweep.ts", "src/run-task.ts"],
    build: async () => {
      const reader = createEscalationTriageHistoryReader({ slice: { ...ESCALATION_TRIAGE_EVIDENCE_SLICE, holder: "census-escalation-triage-evidence" } });
      const read = await reader(stateDir);
      return { value: reader, entries: read.rows.length };
    },
  },
  {
    name: "merge-credit rotation memo (status.ts creditScanMemo, one of two)", holder: "rotation-memo:status.ts", files: ["src/lib/status.ts"],
    build: async () => {
      const memo = createLedgerRotationMemo((rows) => rows.filter(isMergeCreditLine), { pattern: /verdict/ });
      await memo.load(rotationEntries);
      creditMemoKeep = memo;
      return { value: memo, entries: memo.retention().rows };
    },
    drop: () => { creditMemoKeep = undefined; },
  },
  {
    name: "board snapshot cache, closed PR rows with bodies (rows().closed)", holder: "board-snapshot.closed", calibrationKey: "board.closed-pr",
    files: ["src/lib/board-snapshot-cache.ts", "src/lib/open-prs-rest.ts", "src/lib/status.ts"],
    build: () => {
      const closed = createBoardSnapshotCache(corpusRoot, owner, repo).rows!().closed;
      return { value: closed, entries: closed?.size ?? 0 };
    },
  },
  {
    // NOT calibrated: with the daemon's module graph loaded, this reading swings between ~1 and ~37 MiB from run to run
    // (a deferred release of the snapshot just loaded, mechanism not traced), so the live row walks the ~600 rows.
    name: "board snapshot cache, issue rows (rows().issues)", holder: "board-snapshot.issues",
    files: ["src/lib/board-snapshot-cache.ts", "src/lib/open-prs-rest.ts"],
    build: () => {
      const issues = createBoardSnapshotCache(corpusRoot, owner, repo).rows!().issues;
      return { value: issues, entries: issues?.size ?? 0 };
    },
  },
  {
    name: "gateway closed-PR seed (closedSeed() copy held by buildBatchedGithub's knownBoardPrs)", holder: "gateway.known-board-prs (not on the row)",
    files: ["src/lib/status.ts", "src/lib/board-snapshot-cache.ts"],
    build: () => {
      const seed = createBoardSnapshotCache(corpusRoot, owner, repo).closedSeed();
      return { value: seed, entries: seed?.size ?? 0 };
    },
  },
  {
    name: "module graph imported under tsx (src/run-task.ts)", holder: "unattributed (code and module state)", files: ["bin/rmd", "src/run-task.ts"],
    measure: async () => {
      const read = moduleRead();
      return { entries: read.modules, retained_bytes: read.graph_bytes, grown_bytes: read.graph_bytes };
    },
  },
  {
    name: "source-map cache, every loaded module's map parsed", holder: "source-map-cache", calibrationKey: "source-maps.module",
    files: ["src/lib/read-plane.ts", "src/lib/worker-heaps.ts", "bin/rmd"],
    measure: async () => {
      const read = moduleRead();
      return { entries: read.maps_parsed, retained_bytes: read.maps_bytes, grown_bytes: read.maps_bytes };
    },
  },
].filter((spec) => !skip.has(spec.holder) && !skip.has(spec.name));

// EACH IN-PROCESS HOLDER IS MEASURED IN A FRESH CHILD (`--only <name>`): measured one after another in one process,
// a holder's figure moved with the holders measured before it (issue rows read 0 MiB alone and 37 MiB after the
// closed rows), so no holder's reading may depend on another's.
const only = flag("--only");
if (only !== undefined) {
  const spec = specs.find((candidate) => candidate.name === only);
  if (!spec) throw new Error(`no census holder named ${only}`);
  const [reading] = await census.measureHeapHolders([spec], { collect: () => gc(), heapUsed: () => process.memoryUsage().heapUsed, log });
  process.stdout.write(`CENSUS-READING ${JSON.stringify(reading)}\n`);
  process.exit(0);
}
const childArgs = (name: string): string[] => [...process.execArgv, fileURLToPath(import.meta.url), ...args.filter((arg) => arg !== "--write-calibration" && arg !== "--snapshot"), "--only", name];
for (const spec of specs) {
  if (spec.measure) continue;
  const name = spec.name;
  spec.measure = async () => {
    const run = spawnSync(process.execPath, childArgs(name), { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const line = run.stdout.split("\n").find((candidate) => candidate.startsWith("CENSUS-READING "));
    if (run.status !== 0 || !line) throw new Error(`census child for ${name} failed (${run.status}): ${run.stderr.slice(-400)}`);
    const reading = JSON.parse(line.slice("CENSUS-READING ".length)) as { entries: number; retained_bytes: number; grown_bytes: number; error?: string };
    if (reading.error) throw new Error(reading.error);
    log(`${name}: entries=${reading.entries} retained=${Math.round(reading.retained_bytes / 1048576)} MiB (own process)`);
    return { entries: reading.entries, retained_bytes: reading.retained_bytes, grown_bytes: reading.grown_bytes };
  };
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const started = Date.now();
const measured = await census.measureHeapHolders(specs, { collect: () => gc(), heapUsed: () => process.memoryUsage().heapUsed, log });
const sha = (spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout ?? "").trim() || "unknown";
const date = new Date().toISOString().slice(0, 10);
const ranking = census.rankHeapCensus(measured, { liveSetBytes, censusSha: sha, censusDate: date,
  corpus: synthetic ? `synthetic corpus ${shape.rotations}x${shape.rowsPerRotation} rows, ${shape.closedPrs} closed PRs` : `private state copy ${stateCopy}` });
const calibration = census.calibrationFrom(ranking);
const extra = moduleReading ? { module_child: moduleReading } : {};
if (args.includes("--snapshot")) {
  // Optional, in THIS process only: what the holders left behind, by constructor.
  const path = writeHeapSnapshot(join(resolve(out), "census.heapsnapshot"));
  log(`heap snapshot written: ${path}`);
}
mkdirSync(resolve(out), { recursive: true });
writeFileSync(join(resolve(out), "census.json"), `${JSON.stringify({ ...ranking, calibration, shape: synthetic ? shape : undefined, plan: planPath,
  elapsed_ms: Date.now() - started, ...extra }, null, 2)}\n`);
writeFileSync(join(resolve(out), "census.md"), census.renderHeapCensus(ranking));
process.stdout.write(census.renderHeapCensus(ranking));
if (args.includes("--write-calibration")) {
  const file = join(ROOT, "src", "lib", "daemon-memory-census.ts");
  const text = readFileSync(file, "utf8");
  const begin = "// census-calibration:begin\n";
  const end = "// census-calibration:end\n";
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  if (from < 0 || to < from) throw new Error("calibration markers not found");
  const body = `export const DAEMON_MEMORY_CALIBRATION: Readonly<Record<string, CensusCalibration>> = ${JSON.stringify(calibration, null, 2).replace(/"([a-z_]+)":/g, "$1:")};\n`;
  writeFileSync(file, text.slice(0, from + begin.length) + body + text.slice(to));
  log(`calibration written to ${file}`);
}
