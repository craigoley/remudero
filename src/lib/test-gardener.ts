import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { systemClock, type Clock } from "./clock.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import { gardenLedgerBucket, runGarden, type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec } from "./gardener.js";
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
 *   - ADOPT-DURATIONS: a material proposal (`proposalIsMaterial`) that moves a file to a
 *     different shard — every changed row lands together, judged by SHARD SKEW.
 *   - RETIER-FLAKER: a file the ledger's `test.flake_retry` rows show retried at least
 *     {@link RETIER_THRESHOLD} times, forced to the slow tier — judged by RETRY COUNT.
 *   - SHRINK-BASELINE: the same proposal, read only when NOT material, for a row measured lower
 *     than committed — a one-way baseline shrunk downward — judged by BASELINE SIZE.
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
  /** Always the manifest — the one file every class edits. */
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
  summarizeShardBalance: (
    files: string[],
    manifest: TestManifest,
    shardCount: number,
    balanced: string[][],
  ) => { shardSpreadMs: number; selectedMeanDurationMs: number };
}

export async function loadTestManifestProbe(root: string): Promise<TestManifestProbe> {
  return (await import(pathToFileURL(join(root, "scripts/test-tier-manifest.mjs")).href)) as TestManifestProbe;
}

/** Where CI's `--propose` output would need to land for this gardener to see it as an adoption
 *  candidate — the artifact-download half of the gap this task's title names ("CI's `--propose`
 *  output lives 7 days as an artifact and is never adopted") is left for a follow-up (see this
 *  task's PR body); this is the ONE path both halves agree on. */
export function testManifestProposalPath(stateDir: string): string {
  return join(stateDir, "test-tier-manifest-proposal.json");
}

const rowTarget = (probe: TestManifestProbe, file: string): string => `${probe.DEFAULT_MANIFEST_RELATIVE_PATH}#${file}`;

/** Every row in `proposed` that names a file on disk and differs from `committed` — the file's
 *  prior value paired with its proposed one, sorted for a deterministic pass. */
function changedRows(committed: TestManifest, proposed: TestManifest, knownFiles: ReadonlySet<string>): Array<{ file: string; from: number | undefined; to: number }> {
  const out: Array<{ file: string; from: number | undefined; to: number }> = [];
  for (const file of Object.keys(proposed.files ?? {})) {
    if (!knownFiles.has(file)) continue;
    const to = proposed.files[file];
    const from = committed.files[file];
    if (typeof to === "number" && to !== from) out.push({ file, from, to });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** ADOPT-DURATIONS: every changed row, bundled as one PR, only when the whole proposal is
 *  material — {@link import("../../scripts/test-tier-manifest.mjs").proposalIsMaterial}'s own
 *  definition, so this gardener never opens a PR over sub-shard-boundary noise. */
export function adoptDurationsCandidates(
  probe: TestManifestProbe,
  committed: TestManifest,
  proposed: TestManifest,
  testFiles: string[],
  shardCount: number,
): TestGardenAction[] {
  if (!probe.proposalIsMaterial(committed, proposed, shardCount)) return [];
  const before = probe.summarizeShardBalance(testFiles, committed, shardCount, probe.balanceFilesByDuration(testFiles, committed, shardCount));
  const after = probe.summarizeShardBalance(testFiles, proposed, shardCount, probe.balanceFilesByDuration(testFiles, proposed, shardCount));
  return changedRows(committed, proposed, new Set(testFiles)).map(({ file, from, to }) => ({
    class: "adopt-durations",
    target: rowTarget(probe, file),
    file: probe.DEFAULT_MANIFEST_RELATIVE_PATH,
    edit: { kind: "row", key: file, to },
    reason: `Adopting narrows the slowest shard's skew from ${before.shardSpreadMs}ms to ${after.shardSpreadMs}ms (was ${from ?? 0}ms, measured ${to}ms).`,
  }));
}

/** SHRINK-BASELINE: a downward-only correction to a row the proposal measures lower than
 *  committed, read only on a pass where ADOPT-DURATIONS does not already claim every changed row —
 *  a one-way baseline that would otherwise sit stale-high forever, since nothing else in this repo
 *  re-captures it downward once it clears the shard-materiality bar. */
export function shrinkBaselineCandidates(
  probe: TestManifestProbe,
  committed: TestManifest,
  proposed: TestManifest,
  testFiles: string[],
  shardCount: number,
): TestGardenAction[] {
  if (probe.proposalIsMaterial(committed, proposed, shardCount)) return [];
  const totalBefore = Object.values(committed.files ?? {}).reduce((sum, ms) => sum + ms, 0);
  return changedRows(committed, proposed, new Set(testFiles))
    .filter(({ from, to }) => typeof from === "number" && from > 0 && to < from)
    .map(({ file, from, to }) => ({
      class: "shrink-baseline",
      target: rowTarget(probe, file),
      file: probe.DEFAULT_MANIFEST_RELATIVE_PATH,
      edit: { kind: "row", key: file, to },
      reason: `Recorded ${from}ms; freshly measured ${to}ms — shrinking the manifest's total baseline size from ${totalBefore}ms.`,
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

export function testGardenInventory(repoRoot: string, stateDir: string, probe: TestManifestProbe): TestGardenInventory {
  const manifestPath = join(repoRoot, probe.DEFAULT_MANIFEST_RELATIVE_PATH);
  const committed = probe.loadManifest(manifestPath);
  const testFiles = probe.listTestFiles(repoRoot);
  const proposalPath = testManifestProposalPath(stateDir);
  // Clamped exactly like `proposalIsMaterial`'s own internal `effectiveShardCount` (test-tier-
  // manifest.mjs): a fixture or an early-life suite with fewer test files than the real CI
  // matrix must not hand `balanceFilesByDuration`/`summarizeShardBalance` more shards than there
  // are files to fill them, which those two functions do not clamp for themselves.
  const shardCount = Math.max(1, Math.min(probe.DEFAULT_CI_SHARD_COUNT, testFiles.length || 1));
  const durationCandidates = existsSync(proposalPath)
    ? (() => {
        const proposed = probe.loadManifest(proposalPath);
        return [
          ...adoptDurationsCandidates(probe, committed, proposed, testFiles, shardCount),
          ...shrinkBaselineCandidates(probe, committed, proposed, testFiles, shardCount),
        ];
      })()
    : [];
  return { candidates: [...durationCandidates, ...retierFlakerCandidates(stateDir, probe, committed, testFiles)] };
}

/** Modification times of the manifest and proposal, and the ledger's hour bucket, so an unchanged pass costs a
 *  few stats — mirrors {@link import("./plan-gardener.js").planCheapFingerprint}. */
export function testGardenCheapFingerprint(repoRoot: string, stateDir: string, probe: TestManifestProbe, clock: Clock = systemClock): string {
  const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  return [
    mtime(join(repoRoot, probe.DEFAULT_MANIFEST_RELATIVE_PATH)),
    mtime(testManifestProposalPath(stateDir)),
    gardenLedgerBucket(clock),
  ].join(",");
}

/** Every action's row, folded into ONE manifest write — the manifest is the record; no separate
 *  log file duplicates it. */
export function applyTestGardenActions(root: string, probe: TestManifestProbe, actions: TestGardenAction[]): string[] {
  if (actions.length === 0) return [];
  const manifestPath = join(root, probe.DEFAULT_MANIFEST_RELATIVE_PATH);
  const manifest = probe.loadManifest(manifestPath);
  const files = { ...manifest.files };
  for (const a of actions) files[a.edit.key] = a.edit.to;
  probe.writeManifest(manifestPath, { thresholdMs: manifest.thresholdMs, files });
  return [probe.DEFAULT_MANIFEST_RELATIVE_PATH];
}

function prBody(actions: TestGardenAction[], probe: TestManifestProbe): string {
  // A first adoption moves every measured row at once (2,094 on 2026-09-29): one bullet and one
  // proof per row would overrun GitHub's 65,536-character body limit, so the body names the
  // largest rows and the manifest diff stays the complete record.
  const largest = [...actions].sort((a, b) => b.edit.to - a.edit.to || a.target.localeCompare(b.target));
  const listed = largest.slice(0, TEST_GARDEN_BODY_ROWS);
  const proofs = largest.slice(0, TEST_GARDEN_PROOF_ROWS)
    .flatMap((a) => [`- claim: ${a.target} records ${a.edit.to}`, `  proof: grep: "${a.edit.key}": ${a.edit.to} in ${a.file}`]);
  return [
    `The test-suite gardener (W1-T4112) tends ${probe.DEFAULT_MANIFEST_RELATIVE_PATH} from its own measurements and the fleet's flake ledger.`,
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
export function testManifestProposalSourcePath(stateDir: string): string {
  return join(stateDir, "test-tier-manifest-proposal.source.json");
}

export type TestProposalFeed =
  | { status: "fresh" | "unchanged"; runId: number }
  | { status: "absent"; reason: string; runId?: number };

/**
 * The adoption half W1-T4112 left for a follow-up: CI's flake-retry-aggregate job builds
 * `test-tier-manifest-proposal` on every main push and keeps it seven days, and nothing ever
 * fetched it, so ADOPT-DURATIONS and SHRINK-BASELINE had no input and the gardener never acted.
 * This copies the newest successful main run's proposal into {@link testManifestProposalPath}.
 * `gh run download` unpacks the artifact itself, so no zip is parsed here.
 */
export async function refreshTestManifestProposalAsync(
  owner: string,
  repo: string,
  stateDir: string,
  io: { readJson?: (args: string[]) => Promise<unknown>; download?: (args: string[]) => Promise<string> } = {},
): Promise<TestProposalFeed> {
  const readJson = io.readJson ?? ghJsonAsync;
  const download = io.download ?? ((args: string[]) => ghTextAsync(args));
  const runs = await readJson(["api", `repos/${owner}/${repo}/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=10`,
    "--jq", "[.workflow_runs[] | {id, status, conclusion}]"]);
  if (!Array.isArray(runs)) throw new Error("test gardener: GitHub returned no main-run list");
  const run = (runs as Array<{ id?: unknown; status?: unknown; conclusion?: unknown }>)
    .find((r) => r.status === "completed" && r.conclusion === "success" && typeof r.id === "number");
  if (!run) return { status: "absent", reason: "no successful main run among the newest ten" };
  const runId = run.id as number;
  const sourcePath = testManifestProposalSourcePath(stateDir);
  const source = readFileIfExists(sourcePath);
  if (source !== undefined && (JSON.parse(source) as { runId?: number }).runId === runId) {
    return existsSync(testManifestProposalPath(stateDir)) ? { status: "unchanged", runId } : { status: "absent", reason: `run ${runId} published no proposal`, runId };
  }
  const dir = join(stateDir, "test-tier-manifest-proposal.download");
  rmSync(dir, { recursive: true, force: true });
  try {
    await download(["run", "download", String(runId), "--repo", `${owner}/${repo}`, "--name", TEST_MANIFEST_PROPOSAL_ARTIFACT, "--dir", dir]);
  } catch (error) {
    const detail = `${String((error as Error).message)} ${String((error as { stderr?: string }).stderr ?? "")}`;
    // A main run with no duration evidence uploads no proposal (ci.yml `if-no-files-found: ignore`).
    // That run is recorded so it is not asked again; every other failure is the caller's to log.
    if (!/no valid artifacts found|no artifact matches/i.test(detail)) throw error;
    writeAtomic(sourcePath, JSON.stringify({ runId, artifact: "absent" }) + "\n");
    return { status: "absent", reason: `run ${runId} published no proposal`, runId };
  }
  const text = readFileSync(join(dir, "test-tier-manifest.next.json"), "utf8");
  const proposal = JSON.parse(text) as { thresholdMs?: unknown; files?: unknown };
  if (typeof proposal.thresholdMs !== "number" || !proposal.files || typeof proposal.files !== "object" ||
      Object.values(proposal.files).some((ms) => typeof ms !== "number")) {
    throw new Error(`test gardener: run ${runId}'s manifest proposal is not a {thresholdMs, files} manifest`);
  }
  writeAtomic(testManifestProposalPath(stateDir), text);
  writeAtomic(sourcePath, JSON.stringify({ runId }) + "\n");
  rmSync(dir, { recursive: true, force: true });
  return { status: "fresh", runId };
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
      const pass = runGarden(spec, deps);
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
      "shrink-baseline": "shrinking a committed duration downward is judged by the manifest's total baseline size — a judgement call on trusting one fresh measurement.",
    },
    cheapFingerprint: () => testGardenCheapFingerprint(deps.repoRoot, deps.stateDir, probe, deps.clock),
    inventory: () => testGardenInventory(deps.repoRoot, deps.stateDir, probe),
    fingerprint: (inv) => inv.candidates.map((a) => a.target).join(","),
    candidates: (inv) => inv.candidates,
    scorecard: (inv, plan) => ({ candidates: inv.candidates.length, proposed: plan.actions.length }),
    apply: (ws, plan) => {
      const paths = applyTestGardenActions(ws.root, probe, plan.actions);
      if (paths.length === 0) return undefined;
      return {
        paths,
        title: `chore(test): the test gardener proposes to ${plan.acting[0]} ${plan.actions.length} manifest row(s)`,
        body: prBody(plan.actions, probe),
      };
    },
  };
}
