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
// (scripts/test-tier-manifest.json), `tierForDuration`, and (until W1-T4430) a `--check` mode
// that refused a test file the manifest had never heard of.
//
// W1-T4430 — AN ABSENT FILE IS THE FAST TIER, PERIOD, SO A NEW TEST NEVER TOUCHES THE MANIFEST.
// MEASURED: this JSON file was the single most-conflicted file in the repo (changed by 46 of the
// 150 most recent merged PRs) precisely because the retired `--check` demanded a seeded row for
// every new test file, and `hooks/pre-commit` supplied it — two independent PRs adding tests
// collided on the same JSON keys every time. `--check` now refuses the OPPOSITE condition: a row
// that NAMES A FILE THAT DOES NOT EXIST (see {@link findGhostRows}), which is the one thing left
// that can go wrong once nothing routinely writes a placeholder. `hooks/pre-commit` no longer
// seeds; the manifest's only writer is now `flake-retry-aggregate`'s reviewed `--adopt` (design
// iii below), so an entry only ever exists once someone has actually reviewed a measurement of it.
//
// `--seed` still exists for that reviewed writer to use, but nothing in this repo's own hooks or
// CI calls it anymore. `--select-all` and `--run` likewise stopped refusing an untiered file —
// {@link tierFiles} already defaults a missing entry to duration 0 (fast), so refusing execution
// on that same absence was blocking the exact case this task makes normal.
//
// CI writes per-shard evidence outside the checkout and `--record-evidence` merges that evidence
// into a separate proposal artifact. Applying that proposal remains a reviewed baseline change; a
// running job never dirties its checkout.
//
// W1-T3699: the proposal artifact had zero consumers, so 300 of 1,566 files stayed at duration 0
// forever and the SHARD ALLOCATOR (not `tierForDuration`) treated each as free. Three additions,
// scoped to this file: (a) `weightedDurationMs`/`medianMeasuredDurationMs` make the allocator
// weigh an unmeasured file at the ledger's measured median rather than zero; (b) `unmeasuredSummary`
// and the default summary line make the blind spot readable instead of hand-derived; (c)
// `proposalIsMaterial` (wired to `--propose`) decides whether a proposal actually differs enough
// from what is committed to be worth a pull request — the gating a future "open the PR" rung needs.
// That rung itself (downloading CI's proposal artifact and calling it) is not part of this change.
//
// Why: recon-2026-09-05 R-40 — plan/tasks.d/W1-T2904-*.yaml; plan/tasks.d/W1-T3699-*.yaml.

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

/** A materially different observation is worth naming before it is applied to the next proposal.
 * Two is intentionally a factor, not an absolute-ms tolerance: the ledger ranges from sub-ms
 * fixtures to multi-minute browser suites, and the same absolute delta would be noise in one
 * direction and a planning defect in the other. */
export const DURATION_STALENESS_FACTOR = 2;

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

/** The median across every RECORDED, MEASURED (> 0) duration in `manifest` — the seed placeholder
 *  and any absent entry are excluded, so one unmeasured file cannot drag its own stand-in down.
 *  Zero when nothing has been measured yet, which only matters before the very first evidence pass. */
export function medianMeasuredDurationMs(manifest) {
  const measured = Object.values(manifest.files ?? {})
    .filter((d) => typeof d === "number" && d > 0)
    .sort((a, b) => a - b);
  if (measured.length === 0) return 0;
  const mid = Math.floor(measured.length / 2);
  return measured.length % 2 === 0 ? (measured[mid - 1] + measured[mid]) / 2 : measured[mid];
}

/** The duration the SHARD ALLOCATOR weighs `file` at: its own recorded duration when that is a
 *  real measurement, or the ledger-wide measured median when the file is unmeasured (no entry, or
 *  the explicit 0 seed placeholder — see the file header) — never zero. A recorded zero is not a
 *  claim that a file is free; weighting it as such is exactly the blind spot W1-T3699 measured (300
 *  of 1,566 files distributed as though weightless). The median is strictly better than zero on
 *  every distribution without inventing a per-file estimate. */
export function weightedDurationMs(file, manifest, medianMs = medianMeasuredDurationMs(manifest)) {
  const recorded = manifest.files[file];
  return typeof recorded === "number" && recorded > 0 ? recorded : medianMs;
}

/** How many of `testFiles` carry NO real measurement (absent, or the explicit 0 seed placeholder)
 *  and what share of the suite that is — the number recon-2026-09-16 could only get by hand-deriving
 *  it from the manifest JSON. `share` is 0 when `testFiles` is empty rather than NaN. */
export function unmeasuredSummary(testFiles, manifest) {
  const unmeasuredCount = testFiles.filter((f) => !(manifest.files[f] > 0)).length;
  const total = testFiles.length;
  return { unmeasuredCount, total, share: total === 0 ? 0 : unmeasuredCount / total };
}

/** Rows in `manifest` that name a file NOT present in `testFiles` — a GHOST row: the file was
 *  deleted, renamed, or never existed, so the row can no longer be trusted as a measurement of
 *  anything on disk. This is the ONLY condition W1-T4430's `--check` refuses: an absent file is
 *  never an error (§ file header — it defaults to the fast tier at duration 0), only a row that
 *  outlived the file it named is. Sorted for a deterministic report. */
export function findGhostRows(testFiles, manifest) {
  const known = new Set(testFiles);
  return Object.keys(manifest.files ?? {})
    .filter((f) => !known.has(f))
    .sort();
}

/** Buckets every file in `testFiles` into `{ fast, slow }` using `manifest`'s recorded duration
 *  (missing entries default to 0ms, i.e. fast — W1-T4430: this is not a degrade, it is the whole
 *  point, so no caller needs to refuse an untiered file before calling this). */
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
  const medianMs = medianMeasuredDurationMs(manifest);
  const weight = (file) => weightedDurationMs(file, manifest, medianMs);
  const shards = Array.from({ length: shardCount }, () => ({ files: [], durationMs: 0 }));
  const ordered = [...testFiles].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const file of ordered) {
    const target = shards.reduce((best, shard) => {
      if (shard.durationMs !== best.durationMs) return shard.durationMs < best.durationMs ? shard : best;
      return shard.files.length < best.files.length ? shard : best;
    });
    target.files.push(file);
    target.durationMs += weight(file);
  }
  return shards.map((shard) => shard.files);
}

function splitFilesByCount(testFiles, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new RangeError("shardCount must be a positive integer");
  const ordered = [...testFiles].sort();
  return Array.from({ length: shardCount }, (_unused, index) => {
    const start = Math.floor((index * ordered.length) / shardCount);
    const end = Math.floor(((index + 1) * ordered.length) / shardCount);
    return ordered.slice(start, end);
  });
}

function shardDurationMs(files, manifest, medianMs) {
  return files.reduce((sum, file) => sum + weightedDurationMs(file, manifest, medianMs), 0);
}

function maxDurationFile(files, manifest, medianMs) {
  return files.reduce((best, file) => {
    const durationMs = weightedDurationMs(file, manifest, medianMs);
    if (durationMs !== best.durationMs) return durationMs > best.durationMs ? { file, durationMs } : best;
    return file < best.file ? { file, durationMs } : best;
  }, { file: "", durationMs: 0 });
}

export function summarizeShardBalance(testFiles, manifest, shardCount, balancedShards) {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new RangeError("shardCount must be a positive integer");
  const medianMs = medianMeasuredDurationMs(manifest);
  const selectedDurationMs = testFiles.reduce((sum, file) => sum + weightedDurationMs(file, manifest, medianMs), 0);
  const selectedMeanDurationMs = selectedDurationMs / shardCount;
  const balancedDurations = balancedShards.map((files) => shardDurationMs(files, manifest, medianMs));
  const countSplitDurations = splitFilesByCount(testFiles, shardCount).map((files) => shardDurationMs(files, manifest, medianMs));
  const slowestShardDurationMs = Math.max(...balancedDurations, 0);
  const fastestShardDurationMs = balancedDurations.length === 0 ? 0 : Math.min(...balancedDurations);
  const countSplitSlowestDurationMs = Math.max(...countSplitDurations, 0);
  const longestFile = maxDurationFile(testFiles, manifest, medianMs);
  const bindingFloor = longestFile.durationMs > selectedMeanDurationMs
    ? {
        file: longestFile.file,
        durationMs: longestFile.durationMs,
        excessOverMeanMs: longestFile.durationMs - selectedMeanDurationMs,
      }
    : null;
  return {
    selectedDurationMs,
    selectedMeanDurationMs,
    slowestShardDurationMs,
    fastestShardDurationMs,
    shardSpreadMs: slowestShardDurationMs - fastestShardDurationMs,
    slowestShardExcessMs: slowestShardDurationMs - selectedMeanDurationMs,
    countSplitSlowestDurationMs,
    countSplitSlowestExcessMs: countSplitSlowestDurationMs - selectedMeanDurationMs,
    bindingFloor,
  };
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
  const balance = summarizeShardBalance(candidates, manifest, shard.count, balanced);
  return {
    candidates,
    files,
    predictedDurationMs: files.reduce((sum, file) => sum + weightedDurationMs(file, manifest), 0),
    balance,
  };
}

/** Pure merge: every path in `measured` overwrites (or adds) that entry in a NEW manifest object;
 *  every other recorded file is left byte-for-byte untouched. Never mutates `manifest`. */
export function mergeDurations(manifest, measured) {
  // W1-T3724 — A REAL MEASUREMENT IS NEVER REPLACED BY THE PLACEHOLDER.
  //
  // `--seed` writes `0` for a new test file so its PR is not born red (W1-T3205), and
  // `readDurationEvidence` accepts a `0` reading (it rejects only `< 0`). A plain spread therefore
  // lets a run that failed to time a file reset a number an earlier run measured -- and a file back
  // at `0` packs as FREE, which is how 338 of 1,604 files came to shard as costless.
  //
  // NOT A RATCHET. A duration may legitimately FALL -- a suite genuinely got faster -- so any real
  // number replaces any other real number, in either direction. Only `0` is refused, and only
  // against an existing real value: a file with no measurement yet still takes the placeholder.
  const files = { ...manifest.files };
  for (const [file, duration] of Object.entries(measured)) {
    const existing = files[file];
    if (duration === 0 && typeof existing === "number" && existing > 0) continue;
    files[file] = duration;
  }
  return { thresholdMs: manifest.thresholdMs, files };
}

/** W1-T3724 — how many files still carry the `0` placeholder, and of how many. THE MEASURE OF
 *  SUCCESS for adopting duration evidence at all: if this number does not fall, nothing landed. */
export function placeholderPopulation(manifest) {
  const files = Object.values(manifest.files ?? {});
  return { zero: files.filter((d) => d === 0).length, total: files.length };
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

/**
 * Report measured evidence that materially disagrees with the recorded planning cost.
 *
 * A recorded zero is W1-T2904's explicit unmeasured placeholder, not a claim that the file is
 * free, so it is UNKNOWN and deliberately has no ratio. An absent observation is likewise
 * unknown: only a file that actually arrived in `measured` is compared or merged. The proposal
 * writer consequently preserves its old entry rather than manufacturing a zero-cost estimate.
 * @param {{ files: Record<string, number> }} manifest
 * @param {Record<string, number>} measured
 * @param {number} factor
 */
export function durationStalenessWarnings(manifest, measured, factor = DURATION_STALENESS_FACTOR) {
  if (!Number.isFinite(factor) || factor <= 1) throw new RangeError("duration staleness factor must be greater than 1");
  const warnings = [];
  for (const file of Object.keys(measured).sort()) {
    const recorded = manifest.files[file];
    const observed = measured[file];
    if (!Number.isFinite(recorded) || recorded <= 0 || !Number.isFinite(observed) || observed < 0) continue;
    const low = Math.min(recorded, observed);
    const ratio = low === 0 ? Infinity : Math.max(recorded, observed) / low;
    if (ratio <= factor) continue;
    const ratioText = Number.isFinite(ratio) ? `${ratio.toFixed(2)}x` : "infinity";
    warnings.push(
      `stale duration for ${file}: recorded ${recorded}ms, observed ${observed}ms (${ratioText}; threshold ${factor}x)`,
    );
  }
  return warnings;
}

/**
 * Whether adopting `proposed` in place of `committed` is worth a pull request (W1-T3699 design
 * ii): MATERIAL when a previously-unmeasured file (absent, or the explicit 0 seed placeholder —
 * file header) gains its first real measurement, OR when a measured entry moves enough to change
 * which shard `balanceFilesByDuration` assigns it to at `shardCount`. An unchanged manifest, or a
 * measured value nudged by millisecond noise that lands every file on the same shard as before,
 * is NOT material — no fixed cadence, no fixed byte threshold; the balancer's own assignment is
 * the only test. `shardCount` should match the real coverage matrix; this function does not guess it.
 */
export function proposalIsMaterial(committed, proposed, shardCount = 4) {
  const files = [...new Set([...Object.keys(committed.files ?? {}), ...Object.keys(proposed.files ?? {})])].sort();
  if (files.length === 0) return false;

  const firstRealMeasurement = files.some((file) => {
    const before = committed.files?.[file];
    const after = proposed.files?.[file];
    return !(typeof before === "number" && before > 0) && typeof after === "number" && after > 0;
  });
  if (firstRealMeasurement) return true;

  const effectiveShardCount = Math.max(1, Math.min(shardCount, files.length));
  const shardOf = (shards) => {
    const map = new Map();
    shards.forEach((shardFiles, index) => shardFiles.forEach((file) => map.set(file, index)));
    return map;
  };
  const before = shardOf(balanceFilesByDuration(files, committed, effectiveShardCount));
  const after = shardOf(balanceFilesByDuration(files, proposed, effectiveShardCount));
  return files.some((file) => before.get(file) !== after.get(file));
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
    for (const warning of durationStalenessWarnings(manifest, measured)) {
      console.error(`test-tier-manifest: warning: ${warning}`);
    }
    writeManifest(resolve(root, output), mergeDurations(manifest, measured));
    console.log(
      `test-tier-manifest: wrote ${Object.keys(measured).length} measured file(s) to ${output}; ` +
        "the tracked manifest was not modified.",
    );
    return 0;
  }

  if (argv.includes("--adopt")) {
    // W1-T3724 — THE CONSUMER THE PROPOSAL NEVER HAD. `--record-evidence` has built a corrected
    // manifest on every run since W1-T2904 and uploaded it as a 7-day artifact nothing reads, so
    // the durations that would balance the shards expire instead of landing.
    const proposalPath = getFlagValue(argv, "--adopt");
    if (!proposalPath) {
      console.error("test-tier-manifest: --adopt requires <proposal path>");
      return 2;
    }
    const proposal = loadManifest(resolve(root, proposalPath));
    const before = placeholderPopulation(manifest);
    // PARTIAL EVIDENCE IS PARTIAL, NOT WRONG (design iv): a run where one shard died produces
    // evidence for three, and those three still land. Refusing the whole update is what keeps a
    // fifth of the corpus at zero.
    const adopted = mergeDurations(manifest, proposal.files ?? {});
    const after = placeholderPopulation(adopted);
    writeManifest(manifestPath, adopted);
    console.log(
      `test-tier-manifest: adopted ${Object.keys(proposal.files ?? {}).length} measured file(s); ` +
        `placeholder population ${before.zero} -> ${after.zero} of ${after.total}.`,
    );
    return 0;
  }

  if (argv.includes("--propose")) {
    const proposedPath = getFlagValue(argv, "--proposed");
    if (!proposedPath) {
      console.error("test-tier-manifest: --propose requires --proposed <path> (--committed defaults to --manifest)");
      return 2;
    }
    const committedPath = getFlagValue(argv, "--committed") ?? manifestPath;
    const shardCountRaw = getFlagValue(argv, "--shard-count");
    const shardCount = shardCountRaw ? Number(shardCountRaw) : 4;
    const committed = loadManifest(resolve(root, committedPath));
    const proposed = loadManifest(resolve(root, proposedPath));
    if (proposalIsMaterial(committed, proposed, shardCount)) {
      console.log("test-tier-manifest: proposal is material — open a pull request adopting it.");
      return 0;
    }
    console.log("test-tier-manifest: proposal is not material — no pull request needed.");
    return 1;
  }

  if (argv.includes("--check")) {
    // W1-T4430 — THE REFUSAL FLIPPED. An absent file is never wrong (§ file header); the only row
    // this gate can no longer trust is one that names a file that isn't there to measure. `--base`
    // is still accepted (CI and hooks/pre-push both pass one) but is no longer read here — a ghost
    // row is exactly as stale whichever commit introduced it.
    const ghosts = findGhostRows(testFiles, manifest);
    if (ghosts.length > 0) {
      console.error(
        `test-tier-manifest: ${ghosts.length} row(s) in ${DEFAULT_MANIFEST_RELATIVE_PATH} name a ` +
          "test file that does not exist on disk — a new test file never needs a row (it defaults " +
          "to the fast tier), so a stale row is the one thing left this gate refuses:",
      );
      for (const f of ghosts) console.error(`  ${f}`);
      console.error("Remove the row(s) above, or restore the file they name.");
      return 1;
    }
    console.log(
      `test-tier-manifest: OK — every row in ${DEFAULT_MANIFEST_RELATIVE_PATH} names an existing ` +
        `test file (${testFiles.length} test file(s) on disk).`,
    );
    return 0;
  }

  if (argv.includes("--seed")) {
    // `--seed` is no longer called by hooks/pre-commit (W1-T4430 design ii) — it survives for
    // `flake-retry-aggregate`'s reviewed --adopt writer to place a first placeholder ahead of a
    // real measurement, never for an author's own commit to carry one.
    const missing = testFiles.filter((f) => !(f in manifest.files));
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
          `predicted_duration_ms=${selection.predictedDurationMs} ` +
          `selected_total_duration_ms=${selection.balance.selectedDurationMs} ` +
          `selected_mean_duration_ms=${selection.balance.selectedMeanDurationMs} ` +
          `slowest_shard_excess_ms=${selection.balance.slowestShardExcessMs} ` +
          `count_split_slowest_excess_ms=${selection.balance.countSplitSlowestExcessMs} ` +
          `binding_floor_file=${selection.balance.bindingFloor?.file ?? "none"} ` +
          `binding_floor_duration_ms=${selection.balance.bindingFloor?.durationMs ?? 0} ` +
          `binding_floor_excess_ms=${selection.balance.bindingFloor?.excessOverMeanMs ?? 0} ` +
          `fallback=none shard=${shard.index}/${shard.count}`,
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

  if (argv.includes("--select-all")) {
    const shard = parseShard(getFlagValue(argv, "--shard"));
    if (shard === undefined || shard === null) {
      console.error('test-tier-manifest: --select-all requires --shard "<index>/<count>" with 1 <= index <= count');
      return 2;
    }
    // W1-T4430: an untiered file is no longer refused here — it defaults into the fast tier at
    // duration 0, same as `tierFiles` everywhere else. `--check` is the only gate left that cares
    // whether a manifest row is trustworthy (a GHOST row, never an absent one).
    if (testFiles.length < shard.count) {
      console.error(
        `test-tier-manifest: refusing to select coverage tests — ${testFiles.length} test file(s) cannot fill ${shard.count} shards.`,
      );
      return 1;
    }
    const balanced = balanceFilesByDuration(testFiles, manifest, shard.count);
    const files = balanced[shard.index - 1];
    const balance = summarizeShardBalance(testFiles, manifest, shard.count, balanced);
    console.error(
      "test-tier-manifest: coverage shard summary " +
        `assigned_count=${files.length} predicted_duration_ms=${files.reduce((sum, file) => sum + weightedDurationMs(file, manifest), 0)} ` +
        `selected_total_duration_ms=${balance.selectedDurationMs} selected_mean_duration_ms=${balance.selectedMeanDurationMs} ` +
        `slowest_shard_excess_ms=${balance.slowestShardExcessMs} binding_floor_file=${balance.bindingFloor?.file ?? "none"} ` +
        `binding_floor_duration_ms=${balance.bindingFloor?.durationMs ?? 0} shard=${shard.index}/${shard.count}`,
    );
    console.log(files.join("\n"));
    return 0;
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
    // W1-T4430: an untiered file runs in the fast tier rather than blocking the run — see the
    // `--select-all` comment just above.
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
  const unmeasured = unmeasuredSummary(testFiles, manifest);
  console.log(
    `test-tier-manifest: ${testFiles.length} test file(s) — ${fast.length} fast, ${slow.length} slow ` +
      `(threshold ${manifest.thresholdMs}ms); ${unmeasured.unmeasuredCount} unmeasured ` +
      `(${(unmeasured.share * 100).toFixed(1)}% of the suite).`,
  );
  return 0;
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
