/**
 * scripts/clock-sweep-aggregate.mjs — merge the clock-sweep shards into the ONE report (W1-T5102).
 *
 * Each `clock-sweep shard (i/n)` job runs a name-ordered slice and writes raw results; it never
 * classifies, because `classifySweep` judges drift against a GLOBAL ceiling and recorded set. This
 * reads every shard file, cross-checks that the slices partition the population derived from this
 * checkout, and classifies the union once, so `scripts/clock-sweep-deliver.mjs` reads the same report.
 * A shard that produced no file is named with the suites it would have run: never a quiet partial.
 *
 * Usage: node scripts/clock-sweep-aggregate.mjs --dir <dir> --shards <n>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./lib/argv.mjs";
import {
  CLOCK_ARTIFACTS, DRIFT_BASELINE, DRIFT_CEILING,
  browserSuites, classifySweep, deriveCandidates, headerLines, parseShard, renderReport, runnableCandidates, shardSlice,
} from "./clock-sweep.mjs";

/** A shard this close to the job's 30-minute `timeout-minutes` is warned about, never failed. */
export const SHARD_NEAR_CAP_MS = 20 * 60 * 1000;
export const SHARD_CAP_MINUTES = 30;

export function shardFile(dir, i) {
  return join(dir, `clock-sweep-shard-${i}.json`);
}

/** One shard file, or the reason it cannot be used: absent, unparseable and wrong-version read differently. */
export function readShard(path, readFile) {
  let text;
  try {
    text = readFile(path);
  } catch (e) {
    return { ok: false, reason: e && e.code === "ENOENT" ? "no results file" : `unreadable (${String(e && e.message)})` };
  }
  try {
    const value = JSON.parse(text);
    return value && value.version === 1 ? { ok: true, value } : { ok: false, reason: `not a version 1 results file` };
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
}

function firstTen(list) {
  return `${list.slice(0, 10).join(", ")}${list.length > 10 ? ` + ${list.length - 10} more` : ""}`;
}

/** Every way the present shards disagree with each other or with the population derived here. */
export function shardDisagreements({ shards, missing, n, candidates, population }) {
  const problems = [];
  const owner = new Map();
  for (const s of shards) {
    if (s.of !== n) problems.push(`shard ${s.slot} recorded ${s.shard}/${s.of}, but --shards is ${n}`);
    else if (s.shard !== s.slot) problems.push(`shard file ${s.slot} recorded itself as shard ${s.shard}/${s.of}`);
    if (s.candidates !== candidates) problems.push(`shard ${s.slot} derived ${s.candidates} candidates, this checkout derives ${candidates}`);
  }
  const slices = [...shards.map((s) => ({ slot: s.slot, suites: [...(s.ran ?? []), ...(s.unreached ?? [])] })), ...missing.map((m) => ({ slot: m.slot, suites: m.suites }))];
  for (const { slot, suites } of slices) {
    for (const suite of suites) {
      if (owner.has(suite)) problems.push(`${suite} is in shard ${owner.get(suite)} and shard ${slot}`);
      else owner.set(suite, slot);
    }
  }
  const known = new Set(population);
  const uncovered = population.filter((s) => !owner.has(s));
  const strangers = [...owner.keys()].filter((s) => !known.has(s));
  if (uncovered.length) problems.push(`${uncovered.length} suite(s) in no shard: ${firstTen(uncovered)}`);
  if (strangers.length) problems.push(`${strangers.length} suite(s) not in this checkout's population: ${firstTen(strangers)}`);
  return problems;
}

/** The shard timing table and the near-cap warnings; a warning never changes the exit code. */
export function shardTiming(shards, n) {
  const out = ["  shard timing:"];
  const near = [];
  for (const s of shards) {
    const count = (s.ran ?? []).length + (s.unreached ?? []).length;
    out.push(`    shard ${s.slot}/${n}  ${count} suites  ${(s.elapsedMs / 60000).toFixed(1)} min of a ${SHARD_CAP_MINUTES}-minute cap`);
    if (s.elapsedMs >= SHARD_NEAR_CAP_MS) near.push(s);
  }
  for (const s of near) {
    out.push(`SHARD NEAR CAP — shard ${s.slot}/${n} took ${(s.elapsedMs / 60000).toFixed(1)} min of its ${SHARD_CAP_MINUTES}-minute cap. Add shards: extend the matrix list in .github/workflows/clock-sweep.yml and its --shard denominators together.`);
  }
  return out;
}

export function main({
  argv = process.argv.slice(2),
  readFile = (p) => readFileSync(p, "utf8"),
  derive = deriveCandidates,
  readSuite,
  ceiling = DRIFT_CEILING,
  recorded = DRIFT_BASELINE.driftingSuitesAtCapture ?? [],
  log = console.log,
} = {}) {
  const dirIdx = argv.indexOf("--dir");
  const dir = dirIdx === -1 ? undefined : argv[dirIdx + 1];
  const nIdx = argv.indexOf("--shards");
  const spec = nIdx === -1 ? undefined : parseShard(`1/${argv[nIdx + 1]}`);
  if (!dir || !spec) {
    log(`clock-sweep-aggregate: wants --dir <dir> --shards <n> with 1 <= n <= 64 (got --dir ${JSON.stringify(dir ?? "")} --shards ${JSON.stringify(argv[nIdx + 1] ?? "")})`);
    return 2;
  }
  const n = spec.n;
  const candidates = derive();
  const population = [...runnableCandidates(candidates)].sort();
  const shards = [];
  const missing = [];
  for (let slot = 1; slot <= n; slot++) {
    const r = readShard(shardFile(dir, slot), readFile);
    if (r.ok) shards.push({ ...r.value, slot });
    else missing.push({ slot, reason: r.reason, suites: shardSlice(population, slot, n) });
  }
  const problems = shardDisagreements({ shards, missing, n, candidates: candidates.length, population });

  // Rebuilt in NAME order, so the merged report does not depend on which shard finished first.
  const byName = new Map();
  for (const s of shards) for (const r of s.results ?? []) byName.set(r.suite, { failed: r.failed === true, output: "" });
  const results = new Map(population.filter((s) => byName.has(s)).map((s) => [s, byName.get(s)]));
  const rows = new Map(shards.flatMap((s) => (s.drift ?? []).map((d) => [d.suite, d])));
  const { drifted, newDrift, staleExclusions, ok: classified } = classifySweep(results, CLOCK_ARTIFACTS, ceiling, recorded);
  const drift = drifted.map((d) => rows.get(d.suite) ?? { suite: d.suite, fuse: null, titles: [], detail: "" });
  const unreached = shards.flatMap((s) => s.unreached ?? []);
  const browsers = browserSuites(population, readSuite); // undefined selects the real reader
  const ok = classified && unreached.length === 0 && missing.length === 0 && problems.length === 0 && browsers.length === 0;

  for (const line of headerLines(candidates, population)) log(line);
  log(`  shards             : ${shards.length}/${n} present`);
  for (const line of shardTiming(shards, n)) log(line);
  for (const m of missing) {
    log(`\nMISSING SHARD ${m.slot}/${n} — ${m.reason}; its ${m.suites.length} suite(s) were never reported: ${firstTen(m.suites)}`);
  }
  if (problems.length) {
    log(`\nSHARDS DISAGREE — the slices do not partition this checkout's population, so no verdict is trusted:`);
    for (const p of problems) log(`  ${p}`);
  }
  for (const line of renderReport({ drift, newDrift, staleExclusions, unreached, browsers, ceiling, ok, runnable: population })) log(line);
  return ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) process.exit(main());
