import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { GardenAction, GardenCheckout, GardenerDeps, GardenSpec } from "./gardener.js";
import { ledgerLivePath, readLedgerUnionRecordsSync } from "./ledger-union.js";

/**
 * lib/test-gardener.ts (W1-T4112) — the test suite tends itself.
 *
 * scripts/test-tier-manifest.json holds hundreds of never-measured `0` placeholders, its last
 * bulk refresh predates the coverage lane it now schedules, CI's own `--propose` output lives
 * seven days as an artifact nobody adopts, and `test-with-retry.mjs`'s FLAKE-RETRY evidence used
 * to live on stdout only (fixed alongside this file — see that script's own W1-T4112 note). Each
 * pass proposes ONE class of change as ONE pull request, every value read from
 * scripts/test-tier-manifest.mjs's OWN functions or the fleet's OWN ledger, never a guess:
 *
 *   - ADOPT-DURATIONS: a proposal at {@link testManifestProposalPath} that
 *     `proposalIsMaterial` says would move a file to a different shard — every row that changed
 *     lands together, judged by SHARD SKEW (`summarizeShardBalance`'s `shardSpreadMs`, before vs
 *     after adopting).
 *   - RETIER-FLAKER: a test file the ledger's `test.flake_retry` rows (design note i,
 *     test-with-retry.mjs) show retried at least {@link RETIER_THRESHOLD} times, forced into the
 *     slow tier by recording its duration at the manifest's own threshold — judged by RETRY COUNT.
 *   - SHRINK-BASELINE: the SAME proposal file, read only when it is NOT material (ADOPT-DURATIONS
 *     already claims every changed row on a material pass), for a row the proposal measures LOWER
 *     than committed — a one-way baseline that only ever grows unless something corrects it down —
 *     judged by the manifest's own total BASELINE SIZE.
 *
 * All three are `review` classes (gardener.ts): each edits a number a person can be wrong to trust
 * from one run, so each is judged by whether its PR merges, never by a synthetic pass/fail this
 * module invents. The PR opens ready for review — never a draft — and flows through the fleet's
 * review and auto-merge like every other PR; closing it is how a person declines it.
 */

export type TestGardenClass = "adopt-durations" | "retier-flaker" | "shrink-baseline";
export const TEST_GARDEN_CLASSES: readonly TestGardenClass[] = ["adopt-durations", "retier-flaker", "shrink-baseline"];

/** A repeat flaker: recorded at least this many `test.flake_retry` rows for the same file. One is
 *  a fluke a healthy retry already absorbed; three is a pattern worth moving off the fast lane's
 *  shard balance, chosen well below the handful of retries a genuinely unstable file accrues over
 *  even a single day of PRs and well above the one-off a passing retry already resolves. */
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

/** Modification times of everything a pass reads, so an unchanged manifest/proposal/ledger costs a
 *  few stats — mirrors {@link import("./plan-gardener.js").planCheapFingerprint}. */
export function testGardenCheapFingerprint(repoRoot: string, stateDir: string, probe: TestManifestProbe): string {
  const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  return [
    mtime(join(repoRoot, probe.DEFAULT_MANIFEST_RELATIVE_PATH)),
    mtime(testManifestProposalPath(stateDir)),
    mtime(ledgerLivePath(stateDir)),
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
  const proofs = actions.flatMap((a) => [`- claim: ${a.target} records ${a.edit.to}`, `  proof: grep: "${a.edit.key}": ${a.edit.to} in ${a.file}`]);
  return [
    `The test-suite gardener (W1-T4112) tends ${probe.DEFAULT_MANIFEST_RELATIVE_PATH} from its own measurements and the fleet's flake ledger.`,
    "",
    ...actions.map((a) => `- **${a.class}** \`${a.target}\`: ${a.reason}`),
    "",
    "## Acceptance",
    ...proofs,
  ].join("\n");
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
    cheapFingerprint: () => testGardenCheapFingerprint(deps.repoRoot, deps.stateDir, probe),
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
