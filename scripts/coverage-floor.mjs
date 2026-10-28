#!/usr/bin/env node
// scripts/coverage-floor.mjs — W1-T5892: THE LIVE COVERAGE FLIP REQUIRES A FRESH, VERIFIED FLOOR.
//
// One workflow admission pins a successful full-suite measurement before any shard narrows.
// BACKSTOP: freshness uses the execution clock, independently of the candidate snapshot cutoff.
// Shards and the aggregate read the same published pin; unreadable pins refuse, never re-select.
// Dependency-free apart from the existing bounded gh transport.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./lib/argv.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

export const PROVENANCE_SCHEMA = 1;
export const PIN_SCHEMA = 1;
/** BACKSTOP: the oldest measurement that may authorize narrowing. Nightly runs daily. */
export const MAX_AGE_HOURS = 24;
/** Future-dated measurements cannot authorize narrowing. */
export const CLOCK_SKEW_MS = 0;
export const SHARD_COUNT = 8;
/** Candidates listed per producer (created at or before the as-of time), and downloaded per producer. */
const LIST_LIMIT = 20;
const DOWNLOAD_LIMIT = 2;
const GH_TIMEOUT_MS = 4_000;
/** The runtime, dependency/loader and lcov-generation inputs a floor must share with its consumer. */
export const COVERAGE_POLICY_FILES = [".nvmrc", "package-lock.json", "scripts/coverage-merge-ratchet.mjs",
  "scripts/coverage-floor.mjs", "test/setup/tmp-hygiene.ts", "package.json",
  "scripts/lib/lcov.mjs", "scripts/lib/coverage-chunk-codec.mjs"];

/** The trusted producers: which workflow, artifact and event may measure main's floor. */
export const PRODUCERS = [
  { artifact: "coverage-nightly", workflow: "coverage-nightly.yml", list: ["--branch", "main"],
    events: ["schedule", "workflow_dispatch"], ref: (r) => r === "refs/heads/main" },
  { artifact: "coverage-merged", workflow: "ci.yml", list: ["--event", "merge_group"],
    events: ["merge_group"], ref: (r) => r.startsWith("refs/heads/gh-readonly-queue/main/") },
];

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 over each policy file's path and bytes, in order; a missing file is part of the identity. */
export function policyDigest(root = REPO_ROOT) {
  const h = createHash("sha256");
  for (const file of COVERAGE_POLICY_FILES) {
    const path = join(root, file);
    h.update(`${file}\0`).update(existsSync(path) ? readFileSync(path) : "<absent>").update("\0");
  }
  return h.digest("hex");
}

export function nodeMajor(version = process.versions.node) {
  return Number(String(version).replace(/^v/, "").split(".")[0]);
}

/** Validate complete records and their measured totals; a source-only shell is not coverage. */
export function lcovSourceCount(text) {
  let record = null, sources = 0, measured = 0;
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("TN:")) continue;
    if (line.startsWith("SF:")) {
      const source = line.slice(3);
      if (record || !source || source.startsWith("/") || source.includes("\\") ||
          source.split("/").some((part) => !part || part === "." || part === "..") || seen.has(source)) return 0;
      seen.add(source);
      record = { lines: new Map(), branches: new Map(), totals: {} };
    } else if (line === "end_of_record") {
      if (!record) return 0;
      const { lines, branches, totals } = record;
      if (totals.LF !== lines.size || totals.LH !== [...lines.values()].filter((v) => v > 0).length) return 0;
      if (branches.size || totals.BRF !== undefined || totals.BRH !== undefined) {
        if (totals.BRF !== branches.size || totals.BRH !== [...branches.values()].filter((v) => v > 0).length) return 0;
      }
      measured += lines.size;
      sources++;
      record = null;
    } else {
      if (!record) return 0;
      let match;
      if ((match = /^DA:([1-9][0-9]*),([0-9]+)(?:,[a-zA-Z0-9]+)?$/.exec(line))) {
        const n = Number(match[1]), hits = Number(match[2]);
        if (!Number.isSafeInteger(n) || !Number.isSafeInteger(hits) || record.lines.has(n)) return 0;
        record.lines.set(n, hits);
      } else if ((match = /^BRDA:([1-9][0-9]*),([0-9]+),([0-9]+),(-|[0-9]+)$/.exec(line))) {
        const key = match.slice(1, 4).join(","), hits = match[4] === "-" ? 0 : Number(match[4]);
        if (!Number.isSafeInteger(hits) || record.branches.has(key)) return 0;
        record.branches.set(key, hits);
      } else if ((match = /^(LF|LH|BRF|BRH|FNF|FNH):([0-9]+)$/.exec(line))) {
        const value = Number(match[2]);
        if (!Number.isSafeInteger(value) || record.totals[match[1]] !== undefined) return 0;
        record.totals[match[1]] = value;
      } else if (!/^FN:[1-9][0-9]*,.+$/.test(line) && !/^FNDA:[0-9]+,.+$/.test(line)) return 0;
    }
  }
  return !record && measured > 0 ? sources : 0;
}

/** What a producer writes beside its lcov. `shardExits` maps shard number to its suite's exit code. */
export function buildProvenance({ producer, lcov, shardExits, env = process.env, root = REPO_ROOT, now = new Date() }) {
  return {
    schema: PROVENANCE_SCHEMA,
    producer,
    repository: env.GITHUB_REPOSITORY ?? "",
    run_id: Number(env.GITHUB_RUN_ID),
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT ?? 1),
    event: env.GITHUB_EVENT_NAME ?? "",
    ref: env.GITHUB_REF ?? "",
    head_sha: env.GITHUB_SHA ?? "",
    node_major: nodeMajor(),
    policy_digest: policyDigest(root),
    shard_test_exits: shardExits,
    lcov_sha256: sha256(lcov),
    lcov_sources: lcovSourceCount(lcov.toString("utf8")),
    created_at: now.toISOString(),
  };
}

/**
 * Why `candidate` (a `gh run list` row of `producer`) cannot authorize narrowing for this consumer,
 * or `null` when it can. `lcov` is the downloaded bytes, `provenance` its parsed record.
 */
export function refusal({ producer, candidate, provenance: p, lcov, consumer, now }) {
  if (candidate.conclusion !== "success") return `run concluded ${candidate.conclusion ?? "unknown"}, not success`;
  if (!producer.events.includes(candidate.event)) return `event ${candidate.event} is not a trusted ${producer.artifact} producer`;
  if (p === undefined) return "artifact carries no provenance (legacy or unverifiable)";
  if (p === null || typeof p !== "object") return "provenance is malformed";
  if (p.schema !== PROVENANCE_SCHEMA) return `provenance schema ${p.schema} is not ${PROVENANCE_SCHEMA}`;
  if (p.producer !== producer.artifact) return `provenance names producer ${p.producer}`;
  if (p.repository !== consumer.repository) return `measured in ${p.repository}, not ${consumer.repository}`;
  if (p.run_id !== candidate.databaseId) return `provenance run ${p.run_id} is not run ${candidate.databaseId}`;
  if (p.run_attempt !== candidate.attempt) return `provenance attempt ${p.run_attempt} is not attempt ${candidate.attempt}`;
  if (p.event !== candidate.event || p.ref !== `refs/heads/${candidate.headBranch}` || !producer.ref(String(p.ref))) return `measured on ${p.event} ${p.ref}, not a trusted ref`;
  if (p.head_sha !== candidate.headSha) return `provenance head ${p.head_sha} is not the run's head ${candidate.headSha}`;
  const exits = p.shard_test_exits;
  const shards = exits && typeof exits === "object" ? Object.keys(exits).sort((a, b) => Number(a) - Number(b)) : [];
  if (shards.join(",") !== Array.from({ length: SHARD_COUNT }, (_, i) => String(i + 1)).join(",")) {
    return `records ${shards.length} of ${SHARD_COUNT} shard exits (partial)`;
  }
  const red = shards.filter((s) => exits[s] !== 0);
  if (red.length > 0) return `shard(s) ${red.join(",")} exited non-zero`;
  if (p.node_major !== consumer.nodeMajor) return `measured on Node ${p.node_major}, consumer runs Node ${consumer.nodeMajor}`;
  if (p.policy_digest !== consumer.policyDigest) return "coverage policy (runtime, lockfile or merge) differs from this checkout";
  if (lcov === undefined || lcov.length === 0) return "lcov is missing or empty";
  if (sha256(lcov) !== p.lcov_sha256) return "lcov digest differs from its provenance";
  const sources = lcovSourceCount(lcov.toString("utf8"));
  if (sources === 0 || sources !== p.lcov_sources) return "lcov is incomplete";
  const measured = Date.parse(p.created_at);
  if (!Number.isFinite(measured)) return "provenance carries no measurement time";
  if (measured > now.getTime() + CLOCK_SKEW_MS) return `measured at ${p.created_at}, in the future`;
  if (!Number.isFinite(Date.parse(candidate.createdAt)) || Date.parse(candidate.createdAt) > measured) return "measured before its own run was created";
  if (now.getTime() - measured > MAX_AGE_HOURS * 3_600_000) return `measured at ${p.created_at}, older than ${MAX_AGE_HOURS}h`;
  return null;
}

function gh(args, run = spawnSync) {
  const r = run("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") || (r.error ? String(r.error.message) : "") };
}

function readJson(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Pin one floor into `pinDir`: `pin.json`, and on `narrow` the verified `lcov.info`. Returns the pin.
 * Every candidate weighed and refused is named in `refused`, so a `full` decision leaves evidence.
 */
export function selectFloor({ pinDir, consumer, now = new Date(), asOf = now, run = spawnSync, log = console.log }) {
  const cutoff = asOf.toISOString();
  mkdirSync(pinDir, { recursive: true });
  rmSync(join(pinDir, "lcov.info"), { force: true });
  // Candidates download beside the pin and are removed before it is published.
  const work = join(pinDir, ".candidates");
  const refused = [];
  const candidates = [];
  try {
    for (const producer of PRODUCERS) {
      const listed = gh(["run", "list", "--workflow", producer.workflow, ...producer.list, "--status", "success",
        "--created", `<=${cutoff}`, "--limit", String(LIST_LIMIT),
        "--json", "attempt,conclusion,createdAt,databaseId,event,headBranch,headSha,updatedAt"], run);
      if (!listed.ok) {
        refused.push({ artifact: producer.artifact, reason: `cannot list runs: ${listed.stderr.trim().slice(0, 200)}` });
        continue;
      }
      let rows;
      try {
        rows = JSON.parse(listed.stdout || "[]");
      } catch {
        rows = null;
      }
      if (!Array.isArray(rows)) {
        refused.push({ artifact: producer.artifact, reason: "run listing is not a JSON array" });
        continue;
      }
      // The snapshot bounds discovery only. Freshness below always uses the execution clock.
      const settled = rows.slice(0, LIST_LIMIT).filter((row) => row &&
        Date.parse(row.createdAt) <= asOf.getTime() && Date.parse(row.updatedAt) <= asOf.getTime());
      for (const row of settled.slice(0, DOWNLOAD_LIMIT)) candidates.push({ producer, row });
    }
    candidates.sort((a, b) => Date.parse(b.row.createdAt) - Date.parse(a.row.createdAt));
    for (const { producer, row } of candidates) {
      const dir = join(work, `${producer.artifact}-${row.databaseId}`);
      const dl = gh(["run", "download", String(row.databaseId), "-n", producer.artifact, "-D", dir], run);
      const lcovPath = join(dir, "lcov.info");
      const lcov = dl.ok && existsSync(lcovPath) ? readFileSync(lcovPath) : undefined;
      const provenance = dl.ok ? readJson(join(dir, "provenance.json")) : undefined;
      const reason = dl.ok
        ? refusal({ producer, candidate: row, provenance, lcov, consumer, now })
        : `cannot download ${producer.artifact}: ${dl.stderr.trim().slice(0, 200)}`;
      if (reason !== null) {
        refused.push({ artifact: producer.artifact, run_id: row.databaseId, reason });
        continue;
      }
      copyFileSync(lcovPath, join(pinDir, "lcov.info"));
      const pin = { schema: PIN_SCHEMA, decision: "narrow", reason: `${producer.artifact} run ${row.databaseId} verified`,
        floor: { artifact: producer.artifact, run_id: row.databaseId, run_attempt: row.attempt, head_sha: row.headSha,
          measured_at: provenance.created_at, lcov_sha256: provenance.lcov_sha256 }, refused };
      writeFileSync(join(pinDir, "pin.json"), JSON.stringify(pin, null, 2) + "\n");
      log(`coverage-floor: narrow — pinned ${producer.artifact} run ${row.databaseId} (measured ${provenance.created_at}).`);
      return pin;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const reason = refused.length === 0
    ? `no successful coverage-nightly or merge-group run is listed`
    : `no fresh verified floor: ${refused.map((r) => `${r.artifact}${r.run_id ? ` ${r.run_id}` : ""} (${r.reason})`).join("; ")}`;
  const pin = { schema: PIN_SCHEMA, decision: "full", reason, refused };
  writeFileSync(join(pinDir, "pin.json"), JSON.stringify(pin, null, 2) + "\n");
  log(`coverage-floor: full — ${reason}.`);
  return pin;
}

/** The pinned lcov path when `pinDir` holds an intact `narrow` pin; throws naming what is wrong. */
export function verifyPin(pinDir, now = new Date()) {
  const pin = readJson(join(pinDir, "pin.json"));
  if (pin === undefined) throw new Error(`no pinned floor at ${pinDir}/pin.json`);
  if (pin === null || pin.schema !== PIN_SCHEMA) throw new Error("the pinned floor record is malformed");
  if (pin.decision !== "narrow") throw new Error(`the pin decided ${pin.decision}, so no shard may have narrowed`);
  const measured = Date.parse(pin.floor?.measured_at);
  if (!Number.isFinite(measured) || measured > now.getTime() + CLOCK_SKEW_MS ||
      now.getTime() - measured > MAX_AGE_HOURS * 3_600_000) throw new Error("the pinned floor is no longer within the 24h freshness bound");
  const lcovPath = join(pinDir, "lcov.info");
  if (!existsSync(lcovPath)) throw new Error("the pinned floor's lcov is missing");
  const lcov = readFileSync(lcovPath);
  if (sha256(lcov) !== pin.floor?.lcov_sha256) throw new Error("the pinned floor's lcov differs from its pinned digest");
  if (!lcovSourceCount(lcov.toString("utf8"))) throw new Error("the pinned floor's lcov is incomplete");
  return lcovPath;
}

/** Read the admission's immutable, attempt-specific artifact; no consumer lists producer runs. */
export function consumeFloor({ pinDir, runId, artifact, digest, run = spawnSync }) {
  if (!/^[1-9][0-9]*$/.test(String(runId)) || !/^coverage-floor-pin-[1-9][0-9]*$/.test(artifact ?? "") ||
      !/^[a-f0-9]{64}$/.test(digest ?? "")) throw new Error("the workflow supplied no valid admission identity");
  rmSync(pinDir, { recursive: true, force: true });
  const dl = gh(["run", "download", String(runId), "-n", artifact, "-D", pinDir], run);
  if (!dl.ok) throw new Error(`cannot download the pinned admission: ${dl.stderr.trim().slice(0, 200)}`);
  const path = join(pinDir, "pin.json");
  if (!existsSync(path) || sha256(readFileSync(path)) !== digest) throw new Error("the admission pin differs from the workflow's digest");
  return verifyPin(pinDir);
}

/** Require every narrowed shard to have consumed the workflow admission's exact pin. */
export function agreeOnFloor({ shardsDir, outDir }) {
  const lcovPath = verifyPin(outDir);
  const admitted = readFileSync(join(outDir, "pin.json"));
  let narrowed = false;
  for (let n = 1; n <= SHARD_COUNT; n++) {
    const dir = join(shardsDir, `coverage-shard-${n}`);
    const selection = existsSync(join(dir, "selection")) ? readFileSync(join(dir, "selection"), "utf8").trim() : "";
    if (selection !== "narrow") continue;
    narrowed = true;
    const path = join(dir, "floor-pin.json");
    if (!existsSync(path) || !readFileSync(path).equals(admitted)) {
      throw new Error(`shard ${n} did not consume the workflow admission's pin`);
    }
  }
  if (!narrowed) throw new Error("no shard narrowed, so there is no pinned floor to read");
  return lcovPath;
}

/** Shard exits recorded under `<dir>/coverage-shard-N/test-exit`, N = 1..SHARD_COUNT; an absent one is left out. */
export function readShardExits(dir) {
  const exits = {};
  for (let n = 1; n <= SHARD_COUNT; n++) {
    const file = join(dir, `coverage-shard-${n}`, "test-exit");
    if (existsSync(file)) exits[n] = Number(readFileSync(file, "utf8").trim());
  }
  return exits;
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const [command, target] = argv;
  if (command === "provenance") {
    const lcovPath = flag(argv, "--lcov"), out = flag(argv, "--out"), producer = flag(argv, "--producer");
    const trusted = PRODUCERS.find((p) => p.artifact === producer);
    if (!lcovPath || !out || !trusted) {
      throw new Error("usage: coverage-floor.mjs provenance --producer <coverage-nightly|coverage-merged> --lcov <f> --out <f> " +
        "(--shards-dir <d> | --matrix-result <result> | --all-shards-succeeded)");
    }
    // Only a trusted event's complete, green measurement is stamped; anything else stays unprovenanced.
    const matrix = flag(argv, "--matrix-result");
    const skip = !trusted.events.includes(env.GITHUB_EVENT_NAME ?? "") ? `a ${env.GITHUB_EVENT_NAME ?? "unknown"} run is not a ${producer} producer`
      : matrix !== undefined && matrix !== "success" ? `the coverage shards concluded ${matrix || "unknown"}`
        : !existsSync(lcovPath) ? "no lcov was staged" : null;
    if (skip !== null) {
      console.log(`coverage-floor: no provenance for ${producer}: ${skip}.`);
      return 0;
    }
    const shardExits = matrix !== undefined || argv.includes("--all-shards-succeeded")
      ? Object.fromEntries(Array.from({ length: SHARD_COUNT }, (_, i) => [i + 1, 0]))
      : readShardExits(flag(argv, "--shards-dir") ?? "");
    const record = buildProvenance({ producer, lcov: readFileSync(lcovPath), shardExits, env });
    writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
    console.log(`coverage-floor: provenance for ${producer} run ${record.run_id} written to ${out}.`);
    return 0;
  }
  if (command === "select" && target) {
    const consumer = { repository: env.GITHUB_REPOSITORY ?? "", nodeMajor: nodeMajor(), policyDigest: policyDigest() };
    const asOf = flag(argv, "--as-of");
    const now = new Date();
    const cutoff = asOf ? new Date(asOf) : now;
    if (!Number.isFinite(cutoff.getTime())) throw new Error(`--as-of ${asOf} is not a time`);
    const pin = selectFloor({ pinDir: target, consumer, now, asOf: cutoff });
    const out = flag(argv, "--decision-file");
    if (out) writeFileSync(out, `${pin.decision}\n`);
    const githubOutput = flag(argv, "--github-output");
    if (githubOutput) writeFileSync(githubOutput, `decision=${pin.decision}\nreason=${pin.reason.replace(/[\r\n]/g, " ")}\npin_digest=${sha256(readFileSync(join(target, "pin.json")))}\n`);
    return 0;
  }
  if (command === "consume" && target) {
    console.log(consumeFloor({ pinDir: target, runId: flag(argv, "--run-id"), artifact: flag(argv, "--artifact"), digest: flag(argv, "--pin-digest") }));
    return 0;
  }
  if (command === "agree" && target && argv[2]) {
    console.log(agreeOnFloor({ shardsDir: target, outDir: argv[2] }));
    return 0;
  }
  if (command === "verify" && target) {
    console.log(verifyPin(target));
    return 0;
  }
  throw new Error("usage: coverage-floor.mjs provenance|select <pin-dir>|agree <shards-dir> <out-dir>|verify <pin-dir>");
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`::error::coverage-floor: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
