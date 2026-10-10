import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { systemClock, type Clock } from "./clock.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import { gardenLedgerBucket, runGardenAsync, type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec } from "./gardener.js";
import { ghJsonAsync, ghTextAsync } from "./github-transport.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";

/**
 * lib/test-gardener.ts (W1-T4112) — the test suite tends itself.
 *
 * scripts/test-tier-manifest.json holds hundreds of never-measured `0` placeholders, CI's own
 * `--propose` output lives seven days as an artifact nobody adopts, and `test-with-retry.mjs`'s
 * FLAKE-RETRY evidence used to live on stdout only (fixed alongside this file — see that script's
 * own W1-T4112 note). Each pass proposes ONE class of change as ONE pull request, every value read
 * from scripts/test-tier-manifest.mjs's OWN functions or the fleet's OWN ledger, never a guess:
 *
 *   - ADOPT-DURATIONS: rows a rolling median of CI runs settles outside the measured noise band
 *     ({@link settleDurationRows}), landed when they move a shard or give a first value, and at
 *     most about once a day — judged by SHARD SKEW.
 *   - RETIER-FLAKER: a file the ledger's `test.flake_retry` rows show retried at least
 *     {@link RETIER_THRESHOLD} times, forced to the slow tier — judged by RETRY COUNT.
 *   - SHRINK-BASELINE: the same settled rows, read only when NOT material, for a row measured
 *     lower than committed — a one-way baseline shrunk downward — judged by BASELINE SIZE.
 *
 * All three are `review` classes (gardener.ts): judged by whether their PR merges, never a
 * synthetic pass/fail this module invents.
 */

export type TestGardenClass = "adopt-durations" | "retier-flaker" | "shrink-baseline";
export const TEST_GARDEN_CLASSES: readonly TestGardenClass[] = ["adopt-durations", "retier-flaker", "shrink-baseline"];

/** PRIMARY CONTROL — the count RETIER-FLAKER itself acts on, not a guard against some other
 *  mechanism's failure. A repeat flaker: recorded at least this many `test.flake_retry` rows for
 *  the same file. One is a fluke a healthy retry already absorbed; three is a pattern worth moving
 *  off the fast lane's shard balance, chosen well below the handful of retries a genuinely unstable
 *  file accrues over even a single day of PRs and well above the one-off a passing retry already
 *  resolves. */
export const RETIER_THRESHOLD = 3;

export type ManifestEdit = { kind: "row"; key: string; to: number };

export interface TestGardenAction extends GardenAction<TestGardenClass> {
  /** The duration ledger this action edits. */
  file: string;
  edit: ManifestEdit;
}

export interface TestGardenInventory {
  candidates: TestGardenAction[];
}

interface TestManifest {
  thresholdMs: number;
  files: Record<string, number>;
}

/** The ratchet's own measurement and evaluation functions. It is an ES module under scripts/, so
 *  it loads once, asynchronously, before the (synchronous) gardener runs — same convention as
 *  {@link import("./gate-gardener.js").loadGateProbes}. */
export interface TestManifestProbe {
  DEFAULT_MANIFEST_RELATIVE_PATH: string;
  DEFAULT_CI_SHARD_COUNT: number;
  loadManifest: (path: string) => TestManifest;
  writeManifest: (path: string, manifest: TestManifest) => void;
  listTestFiles: (root: string) => string[];
  proposalIsMaterial: (committed: TestManifest, proposed: TestManifest, shardCount?: number) => boolean;
  balanceFilesByDuration: (files: string[], manifest: TestManifest, shardCount: number) => string[][];
  tierFiles: (files: string[], manifest: TestManifest) => { fast: string[]; slow: string[] };
  summarizeShardBalance: (
    files: string[],
    manifest: TestManifest,
    shardCount: number,
    balanced: string[][],
  ) => { shardSpreadMs: number; selectedMeanDurationMs: number; slowestShardDurationMs: number };
}

export async function loadTestManifestProbe(root: string): Promise<TestManifestProbe> {
  return (await import(pathToFileURL(join(root, "scripts/test-tier-manifest.mjs")).href)) as TestManifestProbe;
}

/** Where CI's `--propose` output would need to land for this gardener to see it as an adoption
 *  candidate — the artifact-download half of the gap this task's title names ("CI's `--propose`
 *  output lives 7 days as an artifact and is never adopted") is left for a follow-up (see this
 *  task's PR body); this is the ONE path both halves agree on. */
export function testManifestProposalPath(stateDir: string, prefix = TEST_MANIFEST_PROPOSAL_ARTIFACT): string {
  return join(stateDir, `${prefix}.json`);
}

interface DurationLedger {
  manifestPath: string;
  artifact: string;
  proposalFile: string;
  statePrefix: string;
}

function durationLedgers(fastManifestPath = "scripts/test-tier-manifest.json"): DurationLedger[] {
  return [
    { manifestPath: fastManifestPath, artifact: TEST_MANIFEST_PROPOSAL_ARTIFACT,
      proposalFile: "test-tier-manifest.next.json", statePrefix: TEST_MANIFEST_PROPOSAL_ARTIFACT },
    { manifestPath: "scripts/test-tier-coverage-manifest.json", artifact: "test-tier-coverage-manifest-proposal",
      proposalFile: "test-tier-coverage-manifest.next.json", statePrefix: "test-tier-coverage-manifest-proposal" },
  ];
}

const rowTarget = (probe: TestManifestProbe, file: string): string => `${probe.DEFAULT_MANIFEST_RELATIVE_PATH}#${file}`;

/** How many CI proposals the rolling median reads. Odd, so the median is a real observation; about
 *  half a day of main pushes (15 on 2026-09-29); and the chance a correct committed row sits outside
 *  all seven observations by run-to-run noise alone is 2 x 0.5^7, under 2%. */
export const DURATION_WINDOW_RUNS = 7;

/** Roughly one duration adoption a day: a manifest commit younger than this holds the next one back
 *  unless it is urgent. On 2026-09-29 five adopt-durations PRs merged in three hours, each
 *  rewriting about 2,100 rows of run-to-run noise on a known conflict hotspot. */
export const DURATION_ADOPTION_CADENCE_MS = 24 * 3_600_000;

export type SettledRowKind = "first" | "tier" | "drift";
export interface SettledRow { file: string; from: number | undefined; to: number; kind: SettledRowKind }

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Two significant figures: a stored duration claims no more precision than its noise allows. */
export function roundDurationMs(ms: number): number {
  if (!(ms > 0)) return 0;
  const step = 10 ** Math.max(0, Math.floor(Math.log10(ms)) - 1);
  return Math.round(ms / step) * step;
}

/**
 * The rows a window of CI proposals says really moved, and the fleet-wide noise band they were
 * judged against. The band is the median, over every file observed at least three times, of that
 * file's robust spread (1.4826 x MAD of log duration), so it is measured, never chosen. A row moves:
 *   - FIRST: a placeholder (absent or 0) takes the median of its observations;
 *   - otherwise only once the window is full, EVERY observation lies on one side of the committed
 *     value (its own envelope) and the median sits outside the band — hysteresis, so a row adopted
 *     at its median stays put until the evidence moves as a whole;
 *   - a TIER move additionally needs the whole envelope past the slow threshold, so a file near
 *     the boundary never flips back and forth. A row pinned at exactly the threshold is
 *     retier-flaker's lever and is left alone.
 */
export function settleDurationRows(
  committed: TestManifest,
  observations: Array<Record<string, number>>,
  knownFiles: ReadonlySet<string>,
): { rows: SettledRow[]; bandLog: number; full: boolean } {
  const full = observations.length >= DURATION_WINDOW_RUNS;
  const byFile = new Map<string, number[]>();
  for (const run of observations) {
    for (const [file, ms] of Object.entries(run)) {
      if (!knownFiles.has(file) || !(ms > 0)) continue;
      byFile.set(file, [...(byFile.get(file) ?? []), ms]);
    }
  }
  const spreads: number[] = [];
  for (const obs of byFile.values()) {
    if (obs.length < 3) continue;
    const logs = obs.map(Math.log);
    const m = median(logs);
    spreads.push(1.4826 * median(logs.map((l) => Math.abs(l - m))));
  }
  const bandLog = spreads.length > 0 ? median(spreads) : 0;
  const threshold = committed.thresholdMs;
  const rows: SettledRow[] = [];
  for (const [file, obs] of byFile) {
    const from = committed.files[file];
    const to = roundDurationMs(median(obs));
    if (!(typeof from === "number" && from > 0)) {
      rows.push({ file, from, to, kind: "first" });
      continue;
    }
    if (!full || from === threshold) continue;
    const lo = Math.min(...obs);
    const hi = Math.max(...obs);
    if (from >= lo && from <= hi) continue;
    if (Math.abs(Math.log(to / from)) <= bandLog) continue;
    const slowBefore = from >= threshold;
    const slowAfter = to >= threshold;
    if (slowBefore !== slowAfter && (slowAfter ? lo < threshold : hi >= threshold)) continue;
    rows.push({ file, from, to, kind: slowBefore !== slowAfter ? "tier" : "drift" });
  }
  return { rows: rows.sort((a, b) => a.file.localeCompare(b.file)), bandLog, full };
}

/** The fast lane's slowest shard — the wall time a pull request waits on — when `assign` picks the
 *  tiers and shards and `weigh` says what each file really costs. */
function fastLaneSlowestMs(probe: TestManifestProbe, assign: TestManifest, weigh: TestManifest, testFiles: string[]): number {
  const { fast } = probe.tierFiles(testFiles, assign);
  const shards = Math.max(1, Math.min(probe.DEFAULT_CI_SHARD_COUNT, fast.length || 1));
  return probe.summarizeShardBalance(fast, weigh, shards, probe.balanceFilesByDuration(fast, assign, shards)).slowestShardDurationMs;
}

/**
 * ADOPT-DURATIONS and SHRINK-BASELINE, both from {@link settleDurationRows}, never from one run's
 * numbers. The settled rows are ADOPTED when they change a shard assignment or give a file its first
 * real value (`proposalIsMaterial`); otherwise their downward half SHRINKS the baseline. Either is
 * held while `recent` (a manifest commit inside {@link DURATION_ADOPTION_CADENCE_MS}) unless it is
 * URGENT: judged by the settled durations, landing it shortens the fast lane's slowest shard by more
 * than the measured noise band.
 */
export function durationCandidates(
  probe: TestManifestProbe,
  committed: TestManifest,
  observations: Array<Record<string, number>>,
  testFiles: string[],
  shardCount: number,
  recent: boolean,
): TestGardenAction[] {
  const { rows, bandLog, full } = settleDurationRows(committed, observations, new Set(testFiles));
  if (rows.length === 0) return [];
  const settled: TestManifest = { thresholdMs: committed.thresholdMs, files: { ...committed.files } };
  for (const r of rows) settled.files[r.file] = r.to;
  if (recent) {
    const saved = Math.log(fastLaneSlowestMs(probe, committed, settled, testFiles) / fastLaneSlowestMs(probe, settled, settled, testFiles));
    if (!(full && saved > bandLog)) return [];
  }
  const runs = `the median of ${observations.length} CI run(s)`;
  if (probe.proposalIsMaterial(committed, settled, shardCount)) {
    const before = probe.summarizeShardBalance(testFiles, committed, shardCount, probe.balanceFilesByDuration(testFiles, committed, shardCount));
    const after = probe.summarizeShardBalance(testFiles, settled, shardCount, probe.balanceFilesByDuration(testFiles, settled, shardCount));
    return rows.map(({ file, from, to, kind }) => ({
      class: "adopt-durations",
      target: rowTarget(probe, file),
      file: probe.DEFAULT_MANIFEST_RELATIVE_PATH,
      edit: { kind: "row", key: file, to },
      reason: `Adopting narrows the slowest shard's skew from ${before.shardSpreadMs}ms to ${after.shardSpreadMs}ms (${kind}: was ${from ?? 0}ms, ${runs} ${to}ms).`,
    }));
  }
  const totalBefore = Object.values(committed.files ?? {}).reduce((sum, ms) => sum + ms, 0);
  return rows
    .filter(({ from, to }) => typeof from === "number" && to < from)
    .map(({ file, from, to }) => ({
      class: "shrink-baseline",
      target: rowTarget(probe, file),
      file: probe.DEFAULT_MANIFEST_RELATIVE_PATH,
      edit: { kind: "row", key: file, to },
      reason: `Recorded ${from}ms; ${runs} measured ${to}ms — shrinking the manifest's total baseline size from ${totalBefore}ms.`,
    }));
}

/** RETIER-FLAKER: a file the ledger shows retried at least {@link RETIER_THRESHOLD} times and not
 *  already in the slow tier, forced there by recording its duration at the manifest's own
 *  threshold — the one lever `tierForDuration` already reads, so no second "force slow" field is
 *  needed anywhere else in this repo. Read through `readLedgerUnionRecordsSync` (the resolver), so
 *  a rotated or gzipped ledger file is counted exactly like the live one, never a glob over one
 *  rotation form. */
export function retierFlakerCandidates(stateDir: string, probe: TestManifestProbe, committed: TestManifest, testFiles: string[]): TestGardenAction[] {
  const known = new Set(testFiles);
  const { rows } = readLedgerUnionRecordsSync(stateDir, { step: "test.flake_retry" });
  const counts = new Map<string, number>();
  for (const row of rows) {
    const file = row.file;
    if (typeof file === "string" && known.has(file)) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  const out: TestGardenAction[] = [];
  for (const [file, count] of counts) {
    if (count < RETIER_THRESHOLD) continue;
    const currentMs = committed.files[file] ?? 0;
    if (currentMs >= committed.thresholdMs) continue;
    out.push({
      class: "retier-flaker",
      target: rowTarget(probe, file),
      file: probe.DEFAULT_MANIFEST_RELATIVE_PATH,
      edit: { kind: "row", key: file, to: committed.thresholdMs },
      reason: `Retried ${count} time(s) so far — moving it to the slow tier so its flakes stop skewing the fast lane's shards.`,
    });
  }
  return out.sort((a, b) => a.target.localeCompare(b.target));
}

/** The CI proposals the gardener has collected, oldest first, capped at {@link DURATION_WINDOW_RUNS};
 *  `absent` names the runs known to have published none, so neither is downloaded twice. */
export interface TestProposalHistory {
  runs: Array<{ runId: number; files: Record<string, number> }>;
  absent: number[];
}

export function testManifestProposalHistoryPath(stateDir: string, prefix = TEST_MANIFEST_PROPOSAL_ARTIFACT): string {
  return join(stateDir, `${prefix}.history.json`);
}

export function readTestProposalHistory(stateDir: string, prefix = TEST_MANIFEST_PROPOSAL_ARTIFACT): TestProposalHistory {
  const text = readFileIfExists(testManifestProposalHistoryPath(stateDir, prefix));
  if (text === undefined) return { runs: [], absent: [] };
  const parsed = JSON.parse(text) as Partial<TestProposalHistory>;
  return { runs: parsed.runs ?? [], absent: parsed.absent ?? [] };
}

/** When the manifest last changed on the checkout's own history — an adoption, a retier or a
 *  person's edit alike, so the conflict hotspot gets a quiet day whoever moved it. */
export function manifestLastCommitMs(repoRoot: string, relPath: string): number | undefined {
  const out = execFileSync("git", ["-C", repoRoot, "log", "-1", "--format=%ct", "--", relPath], { encoding: "utf8" }).trim();
  return out === "" ? undefined : Number(out) * 1000;
}

export function testGardenInventory(
  repoRoot: string,
  stateDir: string,
  probe: TestManifestProbe,
  opts: { clock?: Clock; manifestChangedAtMs?: (path: string) => number | undefined } = {},
): TestGardenInventory {
  const testFiles = probe.listTestFiles(repoRoot);
  // Clamped exactly like `proposalIsMaterial`'s own internal `effectiveShardCount` (test-tier-
  // manifest.mjs): a fixture or an early-life suite with fewer test files than the real CI
  // matrix must not hand `balanceFilesByDuration`/`summarizeShardBalance` more shards than there
  // are files to fill them, which those two functions do not clamp for themselves.
  const shardCount = Math.max(1, Math.min(probe.DEFAULT_CI_SHARD_COUNT, testFiles.length || 1));
  const candidates: TestGardenAction[] = [];
  for (const ledger of durationLedgers(probe.DEFAULT_MANIFEST_RELATIVE_PATH)) {
    const committed = probe.loadManifest(join(repoRoot, ledger.manifestPath));
    const proposalPath = testManifestProposalPath(stateDir, ledger.statePrefix);
    const history = readTestProposalHistory(stateDir, ledger.statePrefix).runs.map((r) => r.files);
    const observations = history.length > 0 ? history : existsSync(proposalPath) ? [probe.loadManifest(proposalPath).files] : [];
    const changedAt = observations.length > 0
      ? opts.manifestChangedAtMs ? opts.manifestChangedAtMs(ledger.manifestPath) : manifestLastCommitMs(repoRoot, ledger.manifestPath)
      : undefined;
    const recent = changedAt !== undefined && (opts.clock ?? systemClock).now() - changedAt < DURATION_ADOPTION_CADENCE_MS;
    const ledgerProbe = { ...probe, DEFAULT_MANIFEST_RELATIVE_PATH: ledger.manifestPath };
    candidates.push(...durationCandidates(ledgerProbe, committed, observations, testFiles, shardCount, recent));
    if (ledger.artifact === TEST_MANIFEST_PROPOSAL_ARTIFACT) {
      candidates.push(...retierFlakerCandidates(stateDir, probe, committed, testFiles));
    }
  }
  return { candidates };
}

/** Modification times of the manifest and proposal, and the ledger's hour bucket, so an unchanged pass costs a
 *  few stats — mirrors {@link import("./plan-gardener.js").planCheapFingerprint}. */
export function testGardenCheapFingerprint(repoRoot: string, stateDir: string, probe: TestManifestProbe, clock: Clock = systemClock): string {
  const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  return [
    ...durationLedgers(probe.DEFAULT_MANIFEST_RELATIVE_PATH).flatMap((ledger) => [
      mtime(join(repoRoot, ledger.manifestPath)),
      mtime(testManifestProposalPath(stateDir, ledger.statePrefix)),
    ]),
    gardenLedgerBucket(clock),
  ].join(",");
}

/** Every action's row, folded into one write per manifest — the manifest is the record; no separate
 *  log file duplicates it. */
export function applyTestGardenActions(root: string, probe: TestManifestProbe, actions: TestGardenAction[]): string[] {
  if (actions.length === 0) return [];
  const paths = [...new Set(actions.map((a) => a.file))];
  for (const path of paths) {
    const manifestPath = join(root, path);
    const manifest = probe.loadManifest(manifestPath);
    const files = { ...manifest.files };
    for (const a of actions) if (a.file === path) files[a.edit.key] = a.edit.to;
    probe.writeManifest(manifestPath, { thresholdMs: manifest.thresholdMs, files });
  }
  return paths;
}

function prBody(actions: TestGardenAction[]): string {
  // A first adoption moves every measured row at once (2,094 on 2026-09-29): one bullet and one
  // proof per row would overrun GitHub's 65,536-character body limit, so the body names the
  // largest rows and the manifest diff stays the complete record.
  const largest = [...actions].sort((a, b) => b.edit.to - a.edit.to || a.target.localeCompare(b.target));
  const listed = largest.slice(0, TEST_GARDEN_BODY_ROWS);
  const proofs = largest.slice(0, TEST_GARDEN_PROOF_ROWS)
    .flatMap((a) => [`- claim: ${a.target} records ${a.edit.to}`, `  proof: grep: "${a.edit.key}": ${a.edit.to} in ${a.file}`]);
  return [
    `The test-suite gardener (W1-T4112) tends ${[...new Set(actions.map((a) => a.file))].join(", ")} from its own measurements and the fleet's flake ledger.`,
    "",
    ...listed.map((a) => `- **${a.class}** \`${a.target}\`: ${a.reason}`),
    ...(actions.length > listed.length ? [`- …and ${actions.length - listed.length} more row(s); the manifest diff is the complete record.`] : []),
    "",
    "## Acceptance",
    ...proofs,
  ].join("\n");
}

/** How many rows a garden PR body lists, and how many it proves, largest recorded duration first. */
export const TEST_GARDEN_BODY_ROWS = 25;
export const TEST_GARDEN_PROOF_ROWS = 5;

/** Where the last adopted CI proposal came from, so an unchanged main run is never downloaded twice. */
export function testManifestProposalSourcePath(stateDir: string, prefix = TEST_MANIFEST_PROPOSAL_ARTIFACT): string {
  return join(stateDir, `${prefix}.source.json`);
}

type LedgerProposalFeed =
  | { status: "fresh" | "unchanged"; runId: number }
  | { status: "absent"; reason: string; runId?: number };

export type TestProposalFeed = LedgerProposalFeed & { coverage?: LedgerProposalFeed };

/**
 * The adoption half W1-T4112 left for a follow-up: CI's flake-retry-aggregate job builds
 * `test-tier-manifest-proposal` on every main push and keeps it seven days, and nothing ever
 * fetched it, so ADOPT-DURATIONS and SHRINK-BASELINE had no input and the gardener never acted.
 * This copies the newest successful main run's proposal into {@link testManifestProposalPath}, and
 * keeps every successful run inside the rolling window in {@link testManifestProposalHistoryPath}.
 * `gh run download` unpacks the artifact itself, so no zip is parsed here.
 */
export async function refreshTestManifestProposalAsync(
  owner: string,
  repo: string,
  stateDir: string,
  io: { readJson?: (args: string[]) => Promise<unknown>; download?: (args: string[]) => Promise<string> } = {},
): Promise<TestProposalFeed & { coverage: LedgerProposalFeed }> {
  const readJson = io.readJson ?? ghJsonAsync;
  const download = io.download ?? ((args: string[]) => ghTextAsync(args));
  const runs = await readJson(["api", `repos/${owner}/${repo}/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=10`,
    "--jq", "[.workflow_runs[] | {id, status, conclusion}]"]);
  if (!Array.isArray(runs)) throw new Error("test gardener: GitHub returned no main-run list");
  const successful = (runs as Array<{ id?: unknown; status?: unknown; conclusion?: unknown }>)
    .filter((r) => r.status === "completed" && r.conclusion === "success" && typeof r.id === "number")
    .map((r) => r.id as number);
  const [fast, coverage] = durationLedgers();
  const feed = await refreshLedgerProposalAsync(owner, repo, stateDir, successful, fast!, download);
  return { ...feed, coverage: await refreshLedgerProposalAsync(owner, repo, stateDir, successful, coverage!, download) };
}

async function refreshLedgerProposalAsync(
  owner: string,
  repo: string,
  stateDir: string,
  successful: number[],
  ledger: DurationLedger,
  download: (args: string[]) => Promise<string>,
): Promise<LedgerProposalFeed> {
  if (successful.length === 0) return { status: "absent", reason: "no successful main run among the newest ten" };
  const history = readTestProposalHistory(stateDir, ledger.statePrefix);
  const remember = (runId: number, proposal: { files: Record<string, number> } | undefined) => {
    if (!proposal) history.absent = [...history.absent.filter((id) => successful.includes(id)), runId];
    else history.runs = [...history.runs, { runId, files: proposal.files }].sort((a, b) => a.runId - b.runId).slice(-DURATION_WINDOW_RUNS);
    writeAtomic(testManifestProposalHistoryPath(stateDir, ledger.statePrefix), JSON.stringify(history) + "\n");
  };
  const runId = successful[0]!;
  const sourcePath = testManifestProposalSourcePath(stateDir, ledger.statePrefix);
  const source = readFileIfExists(sourcePath);
  let feed: LedgerProposalFeed;
  if (source !== undefined && (JSON.parse(source) as { runId?: number }).runId === runId) {
    feed = existsSync(testManifestProposalPath(stateDir, ledger.statePrefix)) ? { status: "unchanged", runId } : { status: "absent", reason: `run ${runId} published no proposal`, runId };
  } else {
    const fetched = await fetchRunProposalAsync(owner, repo, stateDir, runId, download, ledger);
    remember(runId, fetched?.proposal);
    if (!fetched) {
      writeAtomic(sourcePath, JSON.stringify({ runId, artifact: "absent" }) + "\n");
      feed = { status: "absent", reason: `run ${runId} published no proposal`, runId };
    } else {
      writeAtomic(testManifestProposalPath(stateDir, ledger.statePrefix), fetched.text);
      writeAtomic(sourcePath, JSON.stringify({ runId }) + "\n");
      feed = { status: "fresh", runId };
    }
  }
  // The rolling median needs a window, not the newest run: backfill every successful run inside it.
  for (const older of successful) {
    if (history.runs.some((r) => r.runId === older) || history.absent.includes(older)) continue;
    if (history.runs.length >= DURATION_WINDOW_RUNS && older < history.runs[0]!.runId) break;
    remember(older, (await fetchRunProposalAsync(owner, repo, stateDir, older, download, ledger))?.proposal);
  }
  return feed;
}

/** One run's proposal, or undefined when that run uploaded none (ci.yml `if-no-files-found: ignore`).
 *  The download step unpacks the artifact itself, so no zip is parsed here. */
async function fetchRunProposalAsync(
  owner: string,
  repo: string,
  stateDir: string,
  runId: number,
  download: (args: string[]) => Promise<string>,
  ledger: DurationLedger,
): Promise<{ text: string; proposal: { thresholdMs: number; files: Record<string, number> } } | undefined> {
  const dir = join(stateDir, `${ledger.statePrefix}.download`);
  rmSync(dir, { recursive: true, force: true });
  try {
    await download(["run", "download", String(runId), "--repo", `${owner}/${repo}`, "--name", ledger.artifact, "--dir", dir]);
  } catch (error) {
    const detail = `${String((error as Error).message)} ${String((error as { stderr?: string }).stderr ?? "")}`;
    // A run with no duration evidence uploads no proposal; the caller records it so it is not asked
    // again. Every other failure is the caller's to log.
    if (!/no valid artifacts found|no artifact matches/i.test(detail)) throw error;
    return undefined;
  }
  const text = readFileSync(join(dir, ledger.proposalFile), "utf8");
  const proposal = JSON.parse(text) as { thresholdMs?: unknown; files?: unknown };
  if (typeof proposal.thresholdMs !== "number" || !proposal.files || typeof proposal.files !== "object" ||
      Object.values(proposal.files).some((ms) => typeof ms !== "number")) {
    throw new Error(`test gardener: run ${runId}'s manifest proposal is not a {thresholdMs, files} manifest`);
  }
  rmSync(dir, { recursive: true, force: true });
  return { text, proposal: proposal as { thresholdMs: number; files: Record<string, number> } };
}

export const TEST_MANIFEST_PROPOSAL_ARTIFACT = "test-tier-manifest-proposal";

/**
 * Run the test garden on the daemon interval, one pass at a time. Once an hour (the ledger bucket
 * its cheap fingerprint already uses) it first refreshes the CI proposal, then writes one
 * `test.pass` row whatever the pass did, so a gardener with nothing to act on says why instead of
 * going silent (it wrote one scorecard on 2026-09-25 and nothing after).
 */
export function startTestGarden(
  spec: GardenSpec<TestGardenClass, TestGardenInventory, TestGardenAction, GardenCheckout>,
  deps: GardenerDeps,
  refresh: () => Promise<TestProposalFeed>,
  intervalMs: number,
): { stop: () => void } {
  const clock = deps.clock ?? systemClock;
  let running = false;
  let reportedBucket: number | undefined;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const bucket = gardenLedgerBucket(clock);
      const hourly = bucket !== reportedBucket;
      let feed: TestProposalFeed | { status: "failed"; error: string } | undefined;
      if (hourly) {
        try {
          feed = await refresh();
        } catch (e) {
          feed = { status: "failed", error: String((e as Error)?.message ?? e) };
          deps.log("test.evidence_failed", { error: feed.error });
        }
      }
      const pass = await runGardenAsync(spec, deps);
      if (hourly) {
        reportedBucket = bucket;
        deps.log("test.pass", {
          ran: pass.ran, feed, pr_url: pass.prUrl ?? null,
          proposal_present: existsSync(testManifestProposalPath(deps.stateDir)),
        });
      }
    } catch (e) {
      deps.log("test.gardener_failed", { error: String((e as Error)?.message ?? e) });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** The test suite as a gardener spec, over a probe loaded by {@link loadTestManifestProbe}. */
export function testGardenSpec(deps: GardenerDeps, probe: TestManifestProbe): GardenSpec<TestGardenClass, TestGardenInventory, TestGardenAction, GardenCheckout> {
  return {
    name: "test",
    classes: TEST_GARDEN_CLASSES,
    review: {
      "adopt-durations": "adopting a fresh measurement over the committed one is judged by shard skew — a judgement call on which run's evidence to trust.",
      "retier-flaker": "moving a file to the slow tier is judged by retry count — a judgement call on whether it is truly flaky.",
      "shrink-baseline": "shrinking a committed duration downward is judged by the manifest's total baseline size — a judgement call on trusting a rolling median.",
    },
    cheapFingerprint: () => testGardenCheapFingerprint(deps.repoRoot, deps.stateDir, probe, deps.clock),
    inventory: () => testGardenInventory(deps.repoRoot, deps.stateDir, probe, { clock: deps.clock }),
    fingerprint: (inv) => inv.candidates.map((a) => a.target).join(","),
    candidates: (inv) => inv.candidates,
    scorecard: (inv, plan) => ({ candidates: inv.candidates.length, proposed: plan.actions.length }),
    apply: (ws, plan) => {
      const paths = applyTestGardenActions(ws.root, probe, plan.actions);
      if (paths.length === 0) return undefined;
      return {
        paths,
        title: `chore(test): the test gardener proposes to ${plan.acting[0]} ${plan.actions.length} manifest row(s)`,
        body: prBody(plan.actions),
      };
    },
  };
}
