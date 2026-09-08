#!/usr/bin/env node
// scripts/test-tier-manifest.mjs — per-test-file duration ledger and fast/slow tiering (W1-T2904).
//
// WHY: ci.yml's `ci` matrix shards `test/**/*.test.ts` by FILE COUNT, which cannot balance a
// suite where one file (test/run-task.test.ts, ~58s) sits wherever its hash lands while most
// finish in well under a second. The human-readable Node reporters are not a stable API, so CI
// pairs TAP with scripts/test-duration-reporter.mjs, which consumes the test runner's structured
// `test:complete` events and records their file and duration_ms fields.
//
// THIS FILE is the manifest side: a recorded `durationMs` per test-file path
// (scripts/test-tier-manifest.json), `tierForDuration`, and a `--check` mode that refuses a test
// file the manifest has never heard of — "a new test file must be tiered" (this task's own
// acceptance). A file recorded at 0 is NOT missing: 0 is "seeded, unmeasured, defaults to fast"
// (see `--seed`), distinct from no entry at all, which `--check` refuses.
//
// `--seed` only ADDS placeholders. CI writes per-shard evidence outside the checkout and
// `--record-evidence` merges that evidence into a separate proposal artifact. Applying that
// proposal remains a reviewed baseline change; a running job never dirties its checkout.
//
// Why: recon-2026-09-05 R-40 — plan/tasks.d/W1-T2904-*.yaml.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MANIFEST_RELATIVE_PATH = "scripts/test-tier-manifest.json";

/** A test file at or above this duration (ms) is SLOW. Chosen well below
 *  `test/run-task.test.ts`'s measured ~58s and `test/serve.live-state.test.ts`'s measured ~40s
 *  (both recorded in the shipped manifest) and well above the sub-second common case, so an
 *  ordinary file stays fast and only genuinely long-running files move tiers. */
export const DEFAULT_SLOW_THRESHOLD_MS = 5000;

/** Every `test/**\/*.test.ts` file, found by a plain recursive `readdirSync` walk — no
 *  subprocess, no glob dependency — returned as `root`-relative POSIX paths, sorted for a
 *  deterministic report. Mirrors scripts/source-size-ratchet.mjs's `listSourceFiles` shape. A
 *  `root` with no `test/` directory yields an empty list rather than throwing. */
export function listTestFiles(root) {
  const testDir = join(root, "test");
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e && e.code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  walk(testDir);
  return out.sort();
}

/** Loads the manifest at `path`, or an empty one (default threshold, no files) when the path does
 *  not exist yet — a fresh checkout with no manifest is "nothing recorded," never a crash. Any
 *  other read/parse failure propagates: an unreadable or corrupt manifest must not silently read
 *  as empty. */
export function loadManifest(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { thresholdMs: DEFAULT_SLOW_THRESHOLD_MS, files: {} };
    throw e;
  }
  const parsed = JSON.parse(raw);
  return {
    thresholdMs: typeof parsed.thresholdMs === "number" ? parsed.thresholdMs : DEFAULT_SLOW_THRESHOLD_MS,
    files: parsed.files ?? {},
  };
}

/** Pure classifier: a duration at or above `thresholdMs` is "slow", everything else "fast". */
export function tierForDuration(durationMs, thresholdMs) {
  return durationMs >= thresholdMs ? "slow" : "fast";
}

/** Test files present on disk (`testFiles`) that `manifest` records NO ENTRY for at all — order
 *  preserved from `testFiles`. This is the refusal W1-T2904's acceptance names: "a test file
 *  absent from the tier manifest is refused." A file recorded at duration 0 (§ file header) is
 *  present, not missing, and never appears here. */
export function findUntieredFiles(testFiles, manifest) {
  return testFiles.filter((f) => !(f in manifest.files));
}

/** Buckets every file in `testFiles` into `{ fast, slow }` using `manifest`'s recorded duration
 *  (missing entries default to 0ms, i.e. fast — callers that must refuse an untiered file check
 *  {@link findUntieredFiles} first). */
export function tierFiles(testFiles, manifest) {
  const fast = [];
  const slow = [];
  for (const f of testFiles) {
    const durationMs = manifest.files[f] ?? 0;
    (tierForDuration(durationMs, manifest.thresholdMs) === "slow" ? slow : fast).push(f);
  }
  return { fast, slow };
}

/** Longest-processing-time scheduling over recorded durations. It minimizes the largest shard's
 * predicted wall time without requiring a service or a hash convention. Ties use file count and
 * shard index, so zero-duration placeholders still spread evenly. */
export function balanceFilesByDuration(testFiles, manifest, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new RangeError("shardCount must be a positive integer");
  const shards = Array.from({ length: shardCount }, () => ({ files: [], durationMs: 0 }));
  const ordered = [...testFiles].sort(
    (a, b) => (manifest.files[b] ?? 0) - (manifest.files[a] ?? 0) || a.localeCompare(b),
  );
  for (const file of ordered) {
    const target = shards.reduce((best, shard) => {
      if (shard.durationMs !== best.durationMs) return shard.durationMs < best.durationMs ? shard : best;
      return shard.files.length < best.files.length ? shard : best;
    });
    target.files.push(file);
    target.durationMs += manifest.files[file] ?? 0;
  }
  return shards.map((shard) => shard.files);
}

/** Validate one newline-delimited conservative candidate set and select a duration-balanced
 * shard. The caller may execute only this returned subset. Any ambiguity throws so workflow
 * callers can take the complete source-CI fallback instead of manufacturing an empty green. */
export function selectPlanReadingShard(candidateText, testFiles, manifest, shard) {
  if (!shard || !Number.isInteger(shard.index) || !Number.isInteger(shard.count) ||
      shard.count < 1 || shard.index < 1 || shard.index > shard.count) {
    throw new Error("plan-reading candidates require a valid shard index/count");
  }
  if (typeof candidateText !== "string") throw new Error("plan-reading candidate input is unreadable");
  const lines = candidateText.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error("plan-reading candidate set is empty or contains a blank entry");
  }

  const known = new Set(testFiles);
  const seen = new Set();
  for (const file of lines) {
    if (
      file !== file.trim() ||
      file.includes("\\") ||
      isAbsolute(file) ||
      win32.isAbsolute(file) ||
      file !== posix.normalize(file) ||
      !file.startsWith("test/") ||
      !file.endsWith(".test.ts")
    ) {
      throw new Error(`unsafe or non-normalized plan-reading candidate: ${JSON.stringify(file)}`);
    }
    if (seen.has(file)) throw new Error(`duplicate plan-reading candidate: ${file}`);
    if (!known.has(file)) throw new Error(`unknown plan-reading candidate: ${file}`);
    if (!(file in manifest.files)) throw new Error(`plan-reading candidate is absent from the duration manifest: ${file}`);
    seen.add(file);
  }

  const candidates = [...seen].sort();
  if (candidates.length < shard.count) {
    throw new Error(
      `plan-reading candidate set has ${candidates.length} file(s), fewer than ${shard.count} shards; ` +
        "a zero-work shard is not an established matrix",
    );
  }
  const balanced = balanceFilesByDuration(candidates, manifest, shard.count);
  const files = balanced[shard.index - 1];
  return {
    candidates,
    files,
    predictedDurationMs: files.reduce((sum, file) => sum + manifest.files[file], 0),
  };
}

/** Separates a moving base's untiered files from files this branch introduced. An explicit base
 * is required for inheritance; without one the author-time check remains fail-closed. */
export function inheritedUntieredFiles(missing, baseRef, root, spawn = spawnSync) {
  if (!baseRef) return { inherited: [], blocking: [...missing] };
  const result = spawn("git", ["-C", root, "ls-tree", "-r", "--name-only", baseRef, "--", "test"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return { inherited: [], blocking: [...missing] };
  const baseFiles = new Set((result.stdout ?? "").split(/\r?\n/).filter(Boolean));
  return {
    inherited: missing.filter((file) => baseFiles.has(file)),
    blocking: missing.filter((file) => !baseFiles.has(file)),
  };
}

/** Pure merge: every path in `measured` overwrites (or adds) that entry in a NEW manifest object;
 *  every other recorded file is left byte-for-byte untouched. Never mutates `manifest`. */
export function mergeDurations(manifest, measured) {
  return { thresholdMs: manifest.thresholdMs, files: { ...manifest.files, ...measured } };
}

/** Merge trusted, versioned reporter documents. Repeated observations keep the slowest value so
 * a fast retry cannot erase a slower first attempt; unknown paths and invalid numbers stay out. */
export function readDurationEvidence(paths, knownTestFiles) {
  const known = new Set(knownTestFiles);
  const measured = {};
  const warnings = [];
  for (const path of paths) {
    let document;
    try {
      document = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      warnings.push(`${path}: unreadable duration evidence (${error.message})`);
      continue;
    }
    if (document?.version !== 1 || !document.files || typeof document.files !== "object") {
      warnings.push(`${path}: unsupported duration evidence schema`);
      continue;
    }
    for (const [file, duration] of Object.entries(document.files)) {
      if (!known.has(file)) {
        warnings.push(`${path}: ignored unknown test path ${file}`);
      } else if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
        warnings.push(`${path}: ignored invalid duration for ${file}`);
      } else {
        measured[file] = Math.max(measured[file] ?? 0, Math.ceil(duration));
      }
    }
  }
  return { measured, warnings };
}

/** Writes `manifest` to `path` as stable, sorted-key JSON — a deterministic diff on every
 *  recording pass, never a hash-order-dependent one. */
export function writeManifest(path, manifest) {
  const sortedFiles = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify({ thresholdMs: manifest.thresholdMs, files: sortedFiles }, null, 2)}\n`);
}

function getFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  return idx === -1 ? undefined : argv[idx + 1];
}

function getFlagValues(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return [];
  const values = [];
  for (let i = idx + 1; i < argv.length && !argv[i].startsWith("--"); i += 1) values.push(argv[i]);
  return values;
}

function parseShard(raw) {
  if (raw === undefined) return undefined;
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  if (!match) return null;
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || index < 1 || index > count) return null;
  return { index, count };
}

export function main(argv, { spawn = spawnSync, env = process.env } = {}) {
  const root = resolve(getFlagValue(argv, "--root") ?? ".");
  const manifestPath = resolve(root, getFlagValue(argv, "--manifest") ?? DEFAULT_MANIFEST_RELATIVE_PATH);
  const manifest = loadManifest(manifestPath);
  const testFiles = listTestFiles(root);
  const baseRef = getFlagValue(argv, "--base");

  const spawnTestFiles = (files) => {
    const testArgs = ["--test", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts"];
    const durationOutputRaw = env.RMD_TEST_DURATION_OUTPUT;
    if (durationOutputRaw) {
      const durationOutput = resolve(root, durationOutputRaw);
      mkdirSync(dirname(durationOutput), { recursive: true });
      testArgs.push(
        "--test-reporter=tap",
        `--test-reporter=${resolve(root, "scripts/test-duration-reporter.mjs")}`,
        "--test-reporter-destination=stdout",
        `--test-reporter-destination=${durationOutput}`,
      );
    }
    const result = spawn(process.execPath, [...testArgs, ...files], { cwd: root, stdio: "inherit" });
    return result.status ?? (result.signal ? 1 : 0);
  };

  if (argv.includes("--record-evidence")) {
    const evidencePaths = getFlagValues(argv, "--record-evidence").map((path) => resolve(root, path));
    const output = getFlagValue(argv, "--output");
    if (evidencePaths.length === 0 || !output) {
      console.error("test-tier-manifest: --record-evidence requires one or more files and --output <path>");
      return 2;
    }
    const { measured, warnings } = readDurationEvidence(evidencePaths, testFiles);
    for (const warning of warnings) console.error(`test-tier-manifest: warning: ${warning}`);
    writeManifest(resolve(root, output), mergeDurations(manifest, measured));
    console.log(
      `test-tier-manifest: wrote ${Object.keys(measured).length} measured file(s) to ${output}; ` +
        "the tracked manifest was not modified.",
    );
    return 0;
  }

  const classifyMissing = () => {
    const missing = findUntieredFiles(testFiles, manifest);
    const result = inheritedUntieredFiles(missing, baseRef, root, spawn);
    if (result.inherited.length > 0) {
      console.error(
        `test-tier-manifest: ${result.inherited.length} untiered file(s) came from ${baseRef}; ` +
          "defaulting them to the fast tier without charging this branch for base movement.",
      );
    }
    return result.blocking;
  };

  if (argv.includes("--check")) {
    const missing = classifyMissing();
    if (missing.length > 0) {
      console.error(
        `test-tier-manifest: ${missing.length} test file(s) are not recorded in ` +
          `${DEFAULT_MANIFEST_RELATIVE_PATH} — a new test file must be tiered before the fast/slow ` +
          "split can trust it:",
      );
      for (const f of missing) console.error(`  ${f}`);
      console.error("Record it with: node scripts/test-tier-manifest.mjs --seed");
      return 1;
    }
    console.log(`test-tier-manifest: OK — all ${testFiles.length} test file(s) are tiered.`);
    return 0;
  }

  if (argv.includes("--seed")) {
    const missing = findUntieredFiles(testFiles, manifest);
    if (missing.length === 0) {
      console.log("test-tier-manifest: nothing to seed — every test file already has a recorded duration.");
      return 0;
    }
    const measured = Object.fromEntries(missing.map((f) => [f, 0]));
    writeManifest(manifestPath, mergeDurations(manifest, measured));
    console.log(
      `test-tier-manifest: seeded ${missing.length} new file(s) at duration 0 (unmeasured, defaults to the ` +
        "fast tier) — a real number replaces the placeholder on the next --record-evidence pass.",
    );
    return 0;
  }

  const candidateMode = argv.includes("--select-candidates")
    ? "select"
    : argv.includes("--run-candidates")
      ? "run"
      : undefined;
  if (candidateMode) {
    const flag = candidateMode === "select" ? "--select-candidates" : "--run-candidates";
    const candidatePath = getFlagValue(argv, flag);
    const shard = parseShard(getFlagValue(argv, "--shard"));
    if (!candidatePath || shard === undefined || shard === null) {
      console.error(`test-tier-manifest: ${flag} requires <candidate-file> and --shard <index>/<count>`);
      return 2;
    }
    try {
      const selection = selectPlanReadingShard(
        readFileSync(resolve(root, candidatePath), "utf8"),
        testFiles,
        manifest,
        shard,
      );
      console.error(
        "test-tier-manifest: plan-reading shard summary " +
          `candidate_count=${selection.candidates.length} assigned_count=${selection.files.length} ` +
          `predicted_duration_ms=${selection.predictedDurationMs} fallback=none shard=${shard.index}/${shard.count}`,
      );
      if (candidateMode === "select") {
        console.log(selection.files.join("\n"));
        return 0;
      }
      return spawnTestFiles(selection.files);
    } catch (error) {
      console.error(
        `test-tier-manifest: plan-reading candidate selection refused — ${error && error.message ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  const runTier = getFlagValue(argv, "--run");
  if (runTier !== undefined) {
    if (runTier !== "fast" && runTier !== "slow") {
      console.error(`test-tier-manifest: --run requires "fast" or "slow", got ${JSON.stringify(runTier)}`);
      return 2;
    }
    const shard = parseShard(getFlagValue(argv, "--shard"));
    if (shard === null) {
      console.error('test-tier-manifest: --shard requires "<index>/<count>" with 1 <= index <= count');
      return 2;
    }
    const missing = classifyMissing();
    if (missing.length > 0) {
      console.error(
        `test-tier-manifest: refusing to run — ${missing.length} test file(s) are untiered (see --check).`,
      );
      return 1;
    }
    const { fast, slow } = tierFiles(testFiles, manifest);
    const tier = runTier === "fast" ? fast : slow;
    const files = shard ? balanceFilesByDuration(tier, manifest, shard.count)[shard.index - 1] : tier;
    if (files.length === 0) {
      console.log(`test-tier-manifest: no ${runTier}-tier test files recorded yet — nothing to run.`);
      return 0;
    }
    return spawnTestFiles(files);
  }

  const { fast, slow } = tierFiles(testFiles, manifest);
  console.log(
    `test-tier-manifest: ${testFiles.length} test file(s) — ${fast.length} fast, ${slow.length} slow ` +
      `(threshold ${manifest.thresholdMs}ms).`,
  );
  return 0;
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
