#!/usr/bin/env node
// scripts/coverage-floor.mjs — W1-T5892: THE LIVE COVERAGE FLIP REQUIRES A FRESH, VERIFIED FLOOR.
//
// A narrowed pull request cannot certify the absolute coverage floor from its own partial lcov, so
// the aggregator reads a full-suite lcov another run measured. Before this helper, ci.yml took the
// newest COMPLETED coverage-nightly or merge-group run: a red nightly uploads its measurement before
// its test-exit gate (coverage-nightly.yml), so completed is not success, and each consumer chose
// its own "newest" independently. This helper is the single owner of that choice:
//
//   provenance  a producer (coverage-nightly, or ci.yml's merge_group aggregator) records who
//               measured the lcov, on which head, with which runtime and policy, and that every
//               shard's suite exited 0, beside the lcov it uploads.
//   select      each coverage shard, before any narrow test, pins the newest candidate that
//               verifies AS OF the triggering event, or decides `full` with a named reason. The
//               as-of time is fixed by the event, so all eight shards (and a re-run) weigh the same
//               candidates. BACKSTOP: a floor older than MAX_AGE_HOURS, or none, never narrows.
//   agree       the aggregator requires every narrowed shard's pin to name one floor, downloads it
//               and checks its digest. It never re-selects: a missing, split or altered pin
//               refuses, and a partial current-head lcov is never relabelled as the absolute floor.
//
// Dependency-free (node built-ins, the `gh` CLI). `gh run list --json` fields verified against
// gh 2.89.0: attempt, conclusion, createdAt, databaseId, event, headBranch, headSha, updatedAt.

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
/** A producer clock ahead of the consumer by more than this is refused as future-dated. */
export const CLOCK_SKEW_MS = 5 * 60_000;
export const SHARD_COUNT = 8;
/** Candidates listed per producer (created at or before the as-of time), and downloaded per producer. */
const LIST_LIMIT = 20;
const DOWNLOAD_LIMIT = 2;
const GH_TIMEOUT_MS = 20_000;
/** The runtime, dependency/loader and lcov-generation inputs a floor must share with its consumer. */
export const COVERAGE_POLICY_FILES = [".nvmrc", "package-lock.json", "scripts/coverage-merge-ratchet.mjs"];

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

/** Source files recorded in an lcov, or 0 when it is not a complete lcov (no closing record). */
export function lcovSourceCount(text) {
  if (!/end_of_record\s*$/.test(text)) return 0;
  return (text.match(/^SF:/gm) ?? []).length;
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
  if (p.event !== candidate.event || !producer.ref(String(p.ref))) return `measured on ${p.event} ${p.ref}, not a trusted ref`;
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
  if (Date.parse(candidate.createdAt) > measured) return "measured before its own run was created";
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
export function selectFloor({ pinDir, consumer, now = new Date(), run = spawnSync, log = console.log }) {
  const asOf = now.toISOString();
  mkdirSync(pinDir, { recursive: true });
  // Candidates download beside the pin and are removed before it is published.
  const work = join(pinDir, ".candidates");
  const refused = [];
  const candidates = [];
  try {
    for (const producer of PRODUCERS) {
      const listed = gh(["run", "list", "--workflow", producer.workflow, ...producer.list, "--status", "success",
        "--created", `<=${asOf}`, "--limit", String(LIST_LIMIT),
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
      // A run that finished after the as-of time is invisible to every shard alike.
      const settled = rows.filter((row) => Date.parse(row?.updatedAt) <= now.getTime());
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
export function verifyPin(pinDir) {
  const pin = readJson(join(pinDir, "pin.json"));
  if (pin === undefined) throw new Error(`no pinned floor at ${pinDir}/pin.json`);
  if (pin === null || pin.schema !== PIN_SCHEMA) throw new Error("the pinned floor record is malformed");
  if (pin.decision !== "narrow") throw new Error(`the pin decided ${pin.decision}, so no shard may have narrowed`);
  const lcovPath = join(pinDir, "lcov.info");
  if (!existsSync(lcovPath)) throw new Error("the pinned floor's lcov is missing");
  if (sha256(readFileSync(lcovPath)) !== pin.floor?.lcov_sha256) throw new Error("the pinned floor's lcov differs from its pinned digest");
  return lcovPath;
}

/**
 * The one floor every narrowed shard under `shardsDir` pinned, downloaded into `outDir` and checked
 * against its digest; returns the lcov path. Throws naming the shard when a pin is missing or split.
 */
export function agreeOnFloor({ shardsDir, outDir, run = spawnSync }) {
  let agreed = null;
  for (let n = 1; n <= SHARD_COUNT; n++) {
    const dir = join(shardsDir, `coverage-shard-${n}`);
    const selection = existsSync(join(dir, "selection")) ? readFileSync(join(dir, "selection"), "utf8").trim() : "";
    if (selection !== "narrow") continue;
    const pin = readJson(join(dir, "floor-pin.json"));
    if (!pin || pin.schema !== PIN_SCHEMA || pin.decision !== "narrow" || !pin.floor) {
      throw new Error(`shard ${n} narrowed without a narrow floor pin`);
    }
    const key = (p) => [p.floor.artifact, p.floor.run_id, p.floor.run_attempt, p.floor.lcov_sha256].join(" ");
    if (agreed === null) agreed = pin;
    else if (key(agreed) !== key(pin)) throw new Error(`shard ${n} pinned ${key(pin)}, another shard pinned ${key(agreed)}`);
  }
  if (agreed === null) throw new Error("no shard narrowed, so there is no pinned floor to read");
  const { artifact, run_id: runId, lcov_sha256: digest } = agreed.floor;
  const download = join(outDir, "download");
  rmSync(download, { recursive: true, force: true });
  const dl = gh(["run", "download", String(runId), "-n", artifact, "-D", download], run);
  if (!dl.ok) throw new Error(`cannot download the pinned ${artifact} run ${runId}: ${dl.stderr.trim().slice(0, 200)}`);
  const source = join(download, "lcov.info");
  if (!existsSync(source) || sha256(readFileSync(source)) !== digest) throw new Error("the pinned floor's lcov differs from its pinned digest");
  mkdirSync(outDir, { recursive: true });
  copyFileSync(source, join(outDir, "lcov.info"));
  rmSync(download, { recursive: true, force: true });
  writeFileSync(join(outDir, "pin.json"), JSON.stringify(agreed, null, 2) + "\n");
  return verifyPin(outDir);
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
    const now = asOf ? new Date(asOf) : new Date();
    if (!Number.isFinite(now.getTime())) throw new Error(`--as-of ${asOf} is not a time`);
    const pin = selectFloor({ pinDir: target, consumer, now });
    const out = flag(argv, "--decision-file");
    if (out) writeFileSync(out, `${pin.decision}\n`);
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
